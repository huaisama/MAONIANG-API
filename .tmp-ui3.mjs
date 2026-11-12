import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const APP = 'http://127.0.0.1:8787';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const cfg = JSON.parse(fs.readFileSync('data/config.json', 'utf8'));
// 造两条待回复请求：一条 DSH 风格大报文，一条普通小请求
const bigSystem = '你是一个测试助手。'.repeat(1500);
const tools = Array.from({ length: 18 }, (_, i) => ({ type: 'function', function: { name: 'tool_' + i, description: '测试工具 ' + i, parameters: { type: 'object', properties: { q: { type: 'string' } } } } }));
for (const payload of [
  { model: 'reply-1', stream: true, messages: [
    { role: 'system', content: bigSystem },
    { role: 'user', content: '先帮我看看这个仓库的结构' },
    { role: 'assistant', content: '好的，我先列一下目录。' },
    { role: 'user', content: '我刚刚说：把上一个回答压缩成三句话，然后告诉我 DSH 里怎么配置这个假 API 的 baseURL？' },
  ], tools },
  { model: 'reply-1', stream: false, messages: [{ role: 'user', content: '你好，随便回我一句' }] },
]) {
  const r = await fetch(APP + '/v1/chat/completions?nowait=1', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey }, body: JSON.stringify(payload) });
  console.log('seed', r.status);
}
const port = 9335;
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + path.join(os.tmpdir(), 'replyapi-ui3-' + Date.now()), '--no-first-run', '--disable-gpu', '--window-size=1280,860', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} });
async function waitJson(url) { for (let i = 0; i < 60; i++) { try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {} await new Promise((x) => setTimeout(x, 250)); } throw new Error('no chrome'); }
const list = await waitJson('http://127.0.0.1:' + port + '/json/list');
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pend = new Map(); const errors = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
const send = (method, params = {}) => { const id = ++seq; return new Promise((r) => { pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); }); };
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: APP + '/admin' }); await sleep(1000);
await ev(`fetch('/admin/api/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(cfg.adminPassword)}})}).then(r=>r.status)`);
await send('Page.reload'); await sleep(1500);
await ev(`(()=>{const its=[...document.querySelectorAll('.item')]; (its[its.length-1]||its[0])?.click(); return 1})()`); await sleep(400);
console.log('QUEUE ITEMS:', await ev(`[...document.querySelectorAll('.item')].map(el=>el.innerText.replace(/\\s+/g,' ').slice(0,120))`));
console.log('SUMMARY:', await ev(`document.querySelector('.sum')?.innerText.replace(/\\s+/g,' ')`));
console.log('BTN:', await ev(`({send: (()=>{const b=document.querySelector('#sendBtn'); const r=b?.getBoundingClientRect(); return r?[Math.round(r.top),Math.round(r.bottom)]:null})(), ta: (()=>{const t=document.querySelector('#respBody'); const r=t?.getBoundingClientRect(); return r?[Math.round(r.top),Math.round(r.height)]:null})(), vh: innerHeight, overflowX: document.documentElement.scrollWidth - innerWidth})`));
console.log('BODY PRE collapsed height:', await ev(`(()=>{const p=document.querySelector('#reqBodyPre'); return p?Math.round(p.getBoundingClientRect().height):null})()`));
await ev(`document.querySelector('#toggleBody')?.click()`); await sleep(250);
console.log('BODY PRE after expand:', await ev(`(()=>{const p=document.querySelector('#reqBodyPre'); return p?Math.round(p.getBoundingClientRect().height):null})()`));
// 搜索过滤
await ev(`(()=>{const s=document.querySelector('#qSearch'); s.value='baseURL'; s.dispatchEvent(new Event('input')); return 1})()`); await sleep(250);
console.log('搜索 baseURL 命中:', await ev(`document.querySelectorAll('.item').length`));
await ev(`(()=>{const s=document.querySelector('#qSearch'); s.value='zzzz'; s.dispatchEvent(new Event('input')); return 1})()`); await sleep(250);
console.log('搜索 zzzz 命中:', await ev(`document.querySelectorAll('.item').length`), '空态:', await ev(`document.querySelector('.qempty')?.innerText.replace(/\\s+/g,' ')`));
await ev(`(()=>{const s=document.querySelector('#qSearch'); s.value=''; s.dispatchEvent(new Event('input')); return 1})()`); await sleep(200);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('preview/admin-summary-wide.png', Buffer.from(shot.result.data, 'base64'));
console.log('errors:', errors);
chrome.kill(); process.exit(0);
