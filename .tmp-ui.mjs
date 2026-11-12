import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = 'http://127.0.0.1:8787';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
if (!CHROME) { console.log('no chrome'); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync('data/config.json', 'utf8'));

// 一条“DSH 风格”的大请求：巨大 system prompt + 工具定义 + 多轮消息
const bigSystem = '你是一个测试助手。'.repeat(1500); // ~24KB
const tools = Array.from({ length: 18 }, (_, i) => ({ type: 'function', function: { name: 'tool_' + i, description: '测试工具 ' + i + ' '.repeat(100), parameters: { type: 'object', properties: { q: { type: 'string' } } } } }));
const messages = [
  { role: 'system', content: bigSystem },
  { role: 'user', content: '先帮我看看这个仓库的结构' },
  { role: 'assistant', content: '好的，我先列一下目录。' },
  { role: 'user', content: '我刚刚说：把上一个回答压缩成三句话，然后告诉我 DSH 里怎么配置这个假 API 的 baseURL？' },
];
const payload = JSON.stringify({ model: 'reply-1', stream: true, messages, tools });
const r = await fetch(APP + '/v1/chat/completions?nowait=1', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey }, body: payload,
});
console.log('seed request:', r.status, (await r.json()).id, 'body bytes', payload.length);

const port = 9333;
const profile = path.join(os.tmpdir(), 'replyapi-ui-' + Date.now());
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--no-first-run', '--disable-gpu', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });

async function waitJson(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const res = await fetch(url); if (res.ok) return await res.json(); } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('chrome not up');
}
const list = await waitJson('http://127.0.0.1:' + port + '/json/list');
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pendingCalls = new Map();
const errors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pendingCalls.has(msg.id)) { pendingCalls.get(msg.id)(msg); pendingCalls.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
};
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve) => { pendingCalls.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
}
async function evalJs(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
  return res.result?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP + '/admin' });
await sleep(1200);
// 登录（same-origin fetch 会写入 HttpOnly cookie），然后刷新
await evalJs(`fetch('/admin/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(cfg.adminPassword)}})}).then(r=>r.status)`);
await send('Page.reload');
await sleep(1600);
const info0 = await evalJs(`({items: document.querySelectorAll('.item').length, autoSel: !!document.querySelector('.item.sel')})`);
console.log('登录后:', info0);
await evalJs(`(()=>{const it=document.querySelector('.item'); if(it) it.click(); return 1;})()`);
await sleep(500);

const measure = `(()=>{
  const ta=document.querySelector('#respBody');
  const sum=document.querySelector('.sum');
  const items=document.querySelectorAll('.item').length;
  const rect = ta ? ta.getBoundingClientRect() : null;
  return { items, hasTa: !!ta, hasSum: !!sum,
    sumText: sum ? (document.querySelector('#sumText')?.textContent||'').slice(0,80) : null,
    taTop: rect ? Math.round(rect.top) : null, taVisible: rect ? (rect.top >= 0 && rect.top < innerHeight - 80) : null,
    docH: document.documentElement.scrollHeight, vw: innerWidth, vh: innerHeight,
    order: getComputedStyle(document.querySelector('.dwrap')).flexDirection };
})()`;
const wide = await evalJs(measure);
console.log('1440px:', wide);
await send('Page.captureScreenshot', { format: 'png' }).then((res) => fs.writeFileSync('preview/admin-summary-wide.png', Buffer.from(res.result.data, 'base64')));

await send('Emulation.setDeviceMetricsOverride', { width: 980, height: 820, deviceScaleFactor: 1, mobile: false });
await sleep(400);
const narrow = await evalJs(measure);
console.log('980px:', narrow);
await send('Page.captureScreenshot', { format: 'png' }).then((res) => fs.writeFileSync('preview/admin-summary-narrow.png', Buffer.from(res.result.data, 'base64')));

console.log('控制台错误:', errors.length ? errors : '（无）');
chrome.kill();
process.exit(0);
