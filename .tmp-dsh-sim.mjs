// 用 DSH 内置的 openai SDK 模拟一次真实接入：流式请求 + 人工回复
import { createRequire } from 'node:module';
import fs from 'node:fs';

const DSH_NM = 'C:/Users/huai/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/';
const require = createRequire(DSH_NM);
const OpenAI = require('openai');
const cfg = JSON.parse(fs.readFileSync('data/config.json', 'utf8'));
const APP = 'http://127.0.0.1:8787';

async function adminLogin() {
  const r = await fetch(APP + '/admin/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: cfg.adminPassword }),
  });
  const c = r.headers.getSetCookie ? r.headers.getSetCookie()[0] : r.headers.get('set-cookie');
  return c.split(';')[0];
}

async function findPending(cookie, predicate) {
  const r = await fetch(APP + '/admin/api/state', { headers: { Cookie: cookie } });
  const s = await r.json();
  return s.pending.find(predicate);
}

async function answer(cookie, id, content) {
  const body = {
    id, status: 200, contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({
      id: 'chatcmpl-test', object: 'chat.completion', created: Math.floor(Date.now() / 1000),
      model: 'reply-1',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }),
  };
  const r = await fetch(APP + '/admin/api/answer', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
  return r.status;
}

const cookie = await adminLogin();
console.log('openai SDK 版本:', JSON.parse(fs.readFileSync(DSH_NM + 'openai/package.json', 'utf8')).version);

// ---- 1) baseURL 带 /v1，流式（DSH 的实际用法） ----
{
  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: APP + '/v1', maxRetries: 0 });
  const pending = client.chat.completions.create({
    model: 'reply-1',
    stream: true,
    messages: [{ role: 'user', content: 'DSH 流式接入测试' }],
  });

  await new Promise((r) => setTimeout(r, 1500));
  const rec = await findPending(cookie, (p) => p.path === '/v1/chat/completions' && p.body.includes('DSH 流式接入测试'));
  console.log('队列拿到请求:', rec && rec.id, 'stream=', rec && rec.stream, 'model=', rec && rec.model);
  if (!rec) { console.log('没找到请求，退出'); process.exit(1); }
  console.log('人工回复 ->', await answer(cookie, rec.id, '你好，这是猫娘手写的流式回复。'));

  let text = '';
  let chunks = 0;
  const stream = await pending;
  for await (const part of stream) {
    chunks++;
    text += part.choices?.[0]?.delta?.content ?? '';
  }
  console.log('流式收到片段:', chunks, '内容:', JSON.stringify(text));
  if (!text.includes('猫娘手写的流式回复')) { console.log('❌ 流式内容不对'); process.exit(1); }
}

// ---- 2) baseURL 不带 /v1，非流式 ----
{
  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: APP, maxRetries: 0 });
  const pending = client.chat.completions.create({
    model: 'human-pro',
    messages: [{ role: 'user', content: 'DSH 无 v1 测试' }],
  });
  await new Promise((r) => setTimeout(r, 1500));
  const rec = await findPending(cookie, (p) => p.path === '/chat/completions' && p.body.includes('DSH 无 v1 测试'));
  console.log('队列拿到请求(无 v1):', rec && rec.id);
  if (!rec) process.exit(1);
  await answer(cookie, rec.id, '不带 /v1 也通了。');
  const res = await pending;
  console.log('非流式内容:', JSON.stringify(res.choices[0].message.content), 'model=', res.model);
  if (!res.choices[0].message.content.includes('不带 /v1 也通了')) process.exit(1);
}

// ---- 3) 模拟 DSH 的模型发现（读 data 数组） ----
for (const base of [APP, APP + '/v1']) {
  const r = await fetch(base + '/models');
  const j = await r.json();
  console.log(`发现 ${base}/models ->`, r.status, j.data.map((m) => m.id).join(','));
}

console.log('全部通过 ✅');
process.exit(0);
