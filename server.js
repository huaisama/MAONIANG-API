#!/usr/bin/env node
'use strict';

/*
 * ReplyAPI —— 人工回复的假 API 服务
 * 任何 /v1 /api /mock 前缀的请求都会挂起，等待管理员在 /admin 控制台手动回复。
 * 零依赖，node server.js 即可运行。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const MAX_BODY = 2 * 1024 * 1024;
const MAX_HISTORY = 300;
const DEFAULT_WAIT_S = 180;
const MAX_WAIT_S = 900;

/* ------------------------------------------------------------------ config */

function loadConfig() {
  const base = {
    port: Number(process.env.FAKEAPI_PORT || process.env.PORT) || 8787,
    host: process.env.FAKEAPI_HOST || '0.0.0.0',
    apiKey: null,
    adminPassword: null,
    waitSeconds: DEFAULT_WAIT_S,
    publicKey: true,
    autoReply: {
      enabled: false,
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: '{\n  "ok": true,\n  "note": "自动回复：管理员暂时不在线"\n}',
    },
  };
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* first run */ }
  const cfg = {
    ...base,
    ...saved,
    autoReply: { ...base.autoReply, ...(saved.autoReply || {}) },
  };
  let dirty = false;
  if (!cfg.apiKey) { cfg.apiKey = 'sk-reply-' + crypto.randomBytes(12).toString('hex'); dirty = true; }
  if (!cfg.adminPassword) { cfg.adminPassword = crypto.randomBytes(4).toString('hex'); dirty = true; }
  if (dirty || !fs.existsSync(CONFIG_PATH)) {
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch {}
  }
  return cfg;
}

let config = loadConfig();
function saveConfig() {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch (e) { log('保存配置失败: ' + e.message); }
}

/* ------------------------------------------------------------------- state */

const pending = new Map();   // id -> record（等待回复）
const completed = new Map(); // id -> record（已结束，有上限）
const sessions = new Set();
const sseClients = new Set();

const stats = {
  total: 0,
  answered: 0,
  timedOut: 0,
  cancelled: 0,
  waitMsSum: 0,
  startedAt: Date.now(),
};

function addCompleted(rec) {
  completed.set(rec.id, rec);
  while (completed.size > MAX_HISTORY) {
    completed.delete(completed.keys().next().value);
  }
}

function log(...args) {
  console.log('[replyapi]', ...args);
}

/* ------------------------------------------------------------------ utils */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key, X-Wait, X-Wait-Seconds, Accept, User-Agent');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj, null, 2);
  cors(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体超过 2MB 限制')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAdmin(req) {
  const tok = parseCookies(req).replyapi_admin;
  return Boolean(tok && sessions.has(tok));
}

function checkApiKey(req, url) {
  if (String(process.env.FAKEAPI_NO_AUTH || '') === '1') return true;
  const auth = req.headers.authorization || '';
  const bearer = auth.replace(/^Bearer\s+/i, '').trim();
  const key = bearer || req.headers['x-api-key'] || url.searchParams.get('key') || '';
  return key === config.apiKey;
}

function randomId(prefix) {
  return prefix + crypto.randomBytes(6).toString('hex');
}

function remoteIp(req) {
  return (req.socket && req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

/** 控制台列表里每请求最多带多少字节正文，避免一条超大 prompt 把状态接口撑爆 */
const ADMIN_BODY_LIMIT = 64 * 1024;

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      if (part && (part.type === 'image_url' || part.type === 'image')) return '[图片]';
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content && typeof content.text === 'string') return content.text;
  return '';
}

/** 从请求体里提炼“这条请求到底在问什么”，列表和详情都用它，避免直接展示几十 KB 的 JSON */
function summarizeRequest(rec) {
  const bytes = Buffer.byteLength(rec.body || '', 'utf8');
  const out = { bytes, messageCount: 0, tools: 0, lastUser: '', role: '' };
  const b = rec.bodyJson;
  if (!b || typeof b !== 'object') {
    out.lastUser = String(rec.body || '').slice(0, 400);
    return out;
  }
  if (Array.isArray(b.messages)) {
    out.messageCount = b.messages.length;
    for (let i = b.messages.length - 1; i >= 0; i--) {
      const m = b.messages[i];
      if (m && m.role === 'user') {
        out.role = 'user';
        out.lastUser = contentText(m.content);
        break;
      }
    }
    if (!out.lastUser) {
      const last = b.messages[b.messages.length - 1];
      if (last) { out.role = String(last.role || ''); out.lastUser = contentText(last.content); }
    }
  }
  if (Array.isArray(b.tools)) out.tools = b.tools.length;
  if (!out.lastUser && typeof b.input === 'string') out.lastUser = b.input;
  if (!out.lastUser && typeof b.prompt === 'string') out.lastUser = b.prompt;
  return out;
}

function publicRequest(rec) {
  const summary = summarizeRequest(rec);
  let body = rec.body || '';
  let bodyTruncated = false;
  if (Buffer.byteLength(body, 'utf8') > ADMIN_BODY_LIMIT) {
    body = body.slice(0, ADMIN_BODY_LIMIT);
    bodyTruncated = true;
  }
  return {
    id: rec.id,
    method: rec.method,
    path: rec.path,
    query: rec.query,
    headers: rec.headers,
    body,
    bodyTruncated,
    summary,
    remote: rec.remote,
    receivedAt: rec.receivedAt,
    stream: rec.stream,
    model: rec.model,
    status: rec.status,
    waitSeconds: rec.waitSeconds,
  };
}

/* ------------------------------------------------------------------- SSE */

function broadcast(event) {
  const payload = 'event: ' + event.type + '\ndata: ' + JSON.stringify(event.data) + '\n\n';
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

/* --------------------------------------------------------- pending requests */

/**
 * 挂起一个请求，等待管理员回复。
 * resolve 收到的对象：{ status, body, contentType, headers } 或 null（取消）
 */
function armTimeout(rec) {
  if (rec.waitSeconds <= 0) return;
  rec.timer = setTimeout(() => {
    if (pending.get(rec.id) !== rec) return;
    rec.timer = null;
    rec.status = 'timeout';
    rec.finishedAt = Date.now();
    rec.answer = null;
    pending.delete(rec.id);
    addCompleted(rec);
    stats.timedOut++;
    broadcast({ type: 'timeout', data: { id: rec.id } });
    if (rec.resolve) rec.resolve(null);
  }, rec.waitSeconds * 1000);
}

function awaitAnswer(rec) {
  return new Promise((resolve) => {
    rec.resolve = (answer) => {
      if (rec.timer) clearTimeout(rec.timer);
      rec.timer = null;
      rec.resolve = null;
      resolve(answer);
    };
    armTimeout(rec);
  });
}

/* --------------------------------------------------------- answer delivery */

function buildAnswerFromRecord(rec) {
  const answer = rec.answer || {};
  return {
    status: answer.status || 200,
    body: answer.body == null ? '' : answer.body,
    contentType: answer.contentType || 'application/json; charset=utf-8',
    headers: answer.headers || {},
  };
}

function sendMockResponse(res, rec, answer) {
  const headers = { ...(answer.headers || {}) };
  const status = Number.isInteger(answer.status) && answer.status >= 100 && answer.status <= 599 ? answer.status : 200;
  const ct = answer.contentType || 'application/json; charset=utf-8';
  const bodyText = String(answer.body ?? '');

  cors(res);
  res.setHeader('X-Reply-Id', rec.id);
  res.setHeader('X-Reply-Answered-At', String(rec.finishedAt || Date.now()));
  res.setHeader('X-Reply-Wait-Ms', String(Math.max(0, (rec.finishedAt || Date.now()) - rec.receivedAt)));
  res.setHeader('X-Human-Reply', '1');

  if (rec.stream && status === 200 && /chat\/completions/.test(rec.path)) {
    return sendStreamAnswer(res, rec, bodyText, headers);
  }

  for (const [k, v] of Object.entries(headers)) {
    try { res.setHeader(k, v); } catch { /* ignore invalid header */ }
  }
  if (!headers['Content-Type'] && !headers['content-type']) res.setHeader('Content-Type', ct);
  res.statusCode = status;
  res.end(bodyText);
}

function extractText(bodyText) {
  try {
    const j = JSON.parse(bodyText);
    const c = j?.choices?.[0]?.message?.content ?? j?.choices?.[0]?.text;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('');
  } catch { /* not json */ }
  return String(bodyText);
}

function sendStreamAnswer(res, rec, bodyText, headers) {
  const text = extractText(bodyText);
  const chunks = text.match(/[\s\S]{1,24}/g) || [''];
  const id = 'chatcmpl-' + rec.id.slice(-12);
  const created = Math.floor(Date.now() / 1000);
  const model = rec.model || 'reply-1';

  res.writeHead(200, {
    ...headers,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const frame = (delta, finish) => JSON.stringify({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  });

  res.write('data: ' + frame({ role: 'assistant', content: '' }) + '\n\n');
  let i = 0;
  const tick = () => {
    if (i >= chunks.length) {
      res.write('data: ' + frame({}, 'stop') + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.write('data: ' + frame({ content: chunks[i++] }) + '\n\n');
    setTimeout(tick, 25);
  };
  setTimeout(tick, 20);
}

/* --------------------------------------------------------------- handlers */

/**
 * 模型清单。同时挂在 /models 和 /v1/models 上：不同的客户端对 baseURL 是否带 /v1 有不同的习惯，
 * 两个都认，接入时就不用纠结地址写法。
 */
const MODEL_PATHS = new Set(['/models', '/v1/models', '/api/models', '/mock/models']);

function modelsPayload() {
  return {
    object: 'list',
    data: [
      {
        id: 'reply-1', object: 'model', created: 1735689600, owned_by: 'human',
        name: 'Reply-1（真人值班）', contextWindow: 128000, maxTokens: 8192,
        context_length: 128000, max_output_tokens: 8192,
      },
      {
        id: 'human-pro', object: 'model', created: 1735689600, owned_by: 'human',
        name: 'Human Pro（真人值班）', contextWindow: 200000, maxTokens: 8192,
        context_length: 200000, max_output_tokens: 8192,
      },
    ],
  };
}

async function handleMock(req, res, url) {
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    return res.end();
  }

  // 模型清单是公开的：客户端探测时可能不带 key，也不该因此被拦住
  const isModelList = MODEL_PATHS.has(url.pathname) && (req.method === 'GET' || req.method === 'HEAD');
  if (isModelList) return sendJson(res, 200, modelsPayload());

  if (!checkApiKey(req, url)) {
    return sendJson(res, 401, {
      error: {
        message: '缺少或错误的 API Key。请在控制台复制 key，或用 Authorization: Bearer <key> 携带。',
        type: 'invalid_api_key',
        code: 401,
      },
    });
  }

  let raw;
  try { raw = await readBody(req); } catch (e) {
    return sendJson(res, 413, { error: { message: e.message, type: 'payload_too_large' } });
  }

  const bodyText = raw.toString('utf8');
  let bodyJson = null;
  try { bodyJson = bodyText ? JSON.parse(bodyText) : null; } catch { /* 非 JSON 也可以 */ }

  const nowait = url.searchParams.get('nowait') === '1'
    || url.searchParams.get('nowait') === 'true'
    || req.headers['x-wait'] === '0';
  let wait = Number(url.searchParams.get('wait') || req.headers['x-wait-seconds']);
  if (!Number.isFinite(wait) || wait <= 0) wait = nowait ? 0 : config.waitSeconds;
  wait = Math.min(Math.max(wait, 0), MAX_WAIT_S);

  // 请求在队列里最多存活多久（nowait 模式也要有过期时间）
  const expiry = wait > 0 ? wait : config.waitSeconds;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (/^(authorization|x-api-key|cookie)$/i.test(k)) continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }

  const rec = {
    id: randomId('req_'),
    method: req.method,
    path: url.pathname,
    query: url.search.replace(/^\?/, ''),
    headers,
    body: bodyText,
    bodyJson,
    remote: remoteIp(req),
    receivedAt: Date.now(),
    finishedAt: null,
    waitSeconds: expiry,
    stream: Boolean(bodyJson && bodyJson.stream === true),
    model: bodyJson && typeof bodyJson.model === 'string' ? bodyJson.model : 'reply-1',
    status: 'pending',
    answer: null,
    timer: null,
    resolve: null,
  };

  stats.total++;

  if (config.autoReply.enabled) {
    rec.status = 'answered';
    rec.answer = {
      status: config.autoReply.status,
      body: config.autoReply.body,
      contentType: config.autoReply.contentType,
    };
    rec.finishedAt = Date.now();
    rec.answeredBy = 'auto';
    addCompleted(rec);
    stats.answered++;
    stats.waitMsSum += rec.finishedAt - rec.receivedAt;
    return sendMockResponse(res, rec, buildAnswerFromRecord(rec));
  }

  pending.set(rec.id, rec);
  broadcast({ type: 'new', data: publicRequest(rec) });

  if (wait === 0) {
    rec.accepted = true;
    armTimeout(rec);
    return sendJson(res, 202, {
      id: rec.id,
      status: 'pending',
      poll_url: '/public/requests/' + rec.id,
      wait_seconds: expiry,
      hint: '已进入人工队列，管理员回复后可通过 poll_url 获取结果',
    });
  }

  res.on('close', () => {
    if (res.writableEnded) return; // 正常结束，不是断开
    if (!pending.has(rec.id)) return;
    // 调用方断开连接 -> 取消
    pending.delete(rec.id);
    if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
    rec.status = 'cancelled';
    rec.finishedAt = Date.now();
    addCompleted(rec);
    stats.cancelled++;
    broadcast({ type: 'cancel', data: { id: rec.id } });
  });

  const answer = await awaitAnswer(rec);
  if (!answer) {
    if (rec.status === 'timeout') {
      return sendJson(res, 504, {
        error: {
          message: '等待人工回复超时，请求已进入历史记录。',
          type: 'human_timeout',
          code: 504,
          request_id: rec.id,
        },
      }, { 'X-Reply-Id': rec.id });
    }
    // 调用方已断开，无需响应
    return;
  }

  if (res.writableEnded || res.destroyed) return;
  sendMockResponse(res, rec, answer);
}

async function handleAdminApi(req, res, url) {
  const p = url.pathname;

  if (p === '/admin/api/login' && req.method === 'POST') {
    let payload;
    try { payload = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { payload = {}; }
    if (payload.password !== config.adminPassword) {
      return sendJson(res, 401, { error: '密码不正确' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    sessions.add(token);
    res.setHeader('Set-Cookie', `replyapi_admin=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/admin/api/logout' && req.method === 'POST') {
    const tok = parseCookies(req).replyapi_admin;
    if (tok) sessions.delete(tok);
    res.setHeader('Set-Cookie', 'replyapi_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return sendJson(res, 200, { ok: true });
  }

  if (!isAdmin(req)) return sendJson(res, 401, { error: '未登录' });

  if (p === '/admin/api/state' && req.method === 'GET') {
    return sendJson(res, 200, {
      pending: [...pending.values()].map(publicRequest),
      history: [...completed.values()]
        .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))
        .map((rec) => ({
          ...publicRequest(rec),
          finishedAt: rec.finishedAt,
          answeredBy: rec.answeredBy || null,
          answer: rec.answer
            ? {
                status: rec.answer.status,
                contentType: rec.answer.contentType,
                headers: rec.answer.headers || {},
                body: rec.answer.body,
              }
            : null,
        })),
      stats: {
        ...stats,
        uptimeSeconds: Math.floor((Date.now() - stats.startedAt) / 1000),
        avgReplySeconds: stats.answered ? +(stats.waitMsSum / stats.answered / 1000).toFixed(1) : 0,
      },
      config: {
        waitSeconds: config.waitSeconds,
        autoReply: config.autoReply,
        apiKey: config.apiKey,
        publicKey: config.publicKey,
      },
      now: Date.now(),
    });
  }

  const mreq = p.match(/^\/admin\/api\/request\/([a-z0-9_]+)$/i);
  if (mreq && req.method === 'GET') {
    const rec = pending.get(mreq[1]) || completed.get(mreq[1]);
    if (!rec) return sendJson(res, 404, { error: '请求不存在或已被清理' });
    return sendJson(res, 200, {
      id: rec.id,
      method: rec.method,
      path: rec.path,
      query: rec.query,
      headers: rec.headers,
      body: rec.body,
      bytes: Buffer.byteLength(rec.body || '', 'utf8'),
      summary: summarizeRequest(rec),
    });
  }

  if (p === '/admin/api/events' && req.method === 'GET') {
    cors(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* closed */ }
    }, 20000);
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
    return;
  }

  if (p === '/admin/api/answer' && req.method === 'POST') {
    let payload;
    try { payload = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { payload = {}; }
    const rec = pending.get(payload.id);
    if (!rec) {
      return sendJson(res, 404, { error: '该请求不存在或已结束' });
    }
    const status = Number(payload.status) || 200;
    if (status < 100 || status > 599) return sendJson(res, 400, { error: 'status 需在 100-599 之间' });
    let headers = {};
    if (payload.headers && typeof payload.headers === 'object') {
      for (const [k, v] of Object.entries(payload.headers)) {
        if (!k || typeof v !== 'string') continue;
        if (/^(content-length|transfer-encoding|connection)$/i.test(k)) continue;
        headers[k] = v;
      }
    }
    if (payload.contentType) headers['Content-Type'] = payload.contentType;
    if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
    rec.status = 'answered';
    rec.finishedAt = Date.now();
    rec.answeredBy = 'admin';
    rec.answer = {
      status,
      body: payload.body == null ? '' : String(payload.body),
      contentType: payload.contentType || 'application/json; charset=utf-8',
      headers,
    };
    pending.delete(rec.id);
    addCompleted(rec);
    stats.answered++;
    stats.waitMsSum += rec.finishedAt - rec.receivedAt;
    broadcast({ type: 'answered', data: { id: rec.id } });
    if (rec.resolve) rec.resolve(buildAnswerFromRecord(rec));
    return sendJson(res, 200, { ok: true, id: rec.id });
  }

  if (p === '/admin/api/cancel' && req.method === 'POST') {
    let payload;
    try { payload = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { payload = {}; }
    const rec = pending.get(payload.id);
    if (!rec) return sendJson(res, 404, { error: '该请求不存在或已结束' });
    pending.delete(rec.id);
    if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
    rec.status = 'cancelled';
    rec.finishedAt = Date.now();
    addCompleted(rec);
    stats.cancelled++;
    broadcast({ type: 'cancel', data: { id: rec.id } });
    if (rec.resolve) rec.resolve(null);
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/admin/api/settings' && req.method === 'POST') {
    let payload;
    try { payload = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { payload = {}; }
    if (typeof payload.waitSeconds === 'number') {
      config.waitSeconds = Math.min(Math.max(Math.round(payload.waitSeconds), 5), MAX_WAIT_S);
    }
    if (typeof payload.publicKey === 'boolean') config.publicKey = payload.publicKey;
    if (payload.autoReply && typeof payload.autoReply === 'object') {
      const a = payload.autoReply;
      if (typeof a.enabled === 'boolean') config.autoReply.enabled = a.enabled;
      if (typeof a.body === 'string') config.autoReply.body = a.body;
      if (Number(a.status) >= 100 && Number(a.status) <= 599) config.autoReply.status = Number(a.status);
      if (typeof a.contentType === 'string' && a.contentType) config.autoReply.contentType = a.contentType;
    }
    if (typeof payload.apiKey === 'string' && payload.apiKey.trim().length >= 8) {
      config.apiKey = payload.apiKey.trim();
    }
    if (typeof payload.adminPassword === 'string' && payload.adminPassword.length >= 4) {
      config.adminPassword = payload.adminPassword;
      sessions.clear(); // 所有会话失效
      saveConfig();
      res.setHeader('Set-Cookie', 'replyapi_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
      return sendJson(res, 200, { ok: true, relogin: true });
    }
    saveConfig();
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/admin/api/history/clear' && req.method === 'POST') {
    const keep = [...pending.values()];
    completed.clear();
    return sendJson(res, 200, { ok: true, pending: keep.length });
  }

  if (p === '/admin/api/test' && req.method === 'POST') {
    // 从控制台发起一条模拟调用，方便调试
    let payload;
    try { payload = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { payload = {}; }
    const port = server.address().port;
    const target = 'http://127.0.0.1:' + port + (payload.path || '/v1/chat/completions') + '?nowait=1';
    try {
      const r = await fetch(target, {
        method: payload.method || 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
        body: payload.body || JSON.stringify({ model: 'reply-1', messages: [{ role: 'user', content: '测试' }] }),
      });
      const text = await r.text();
      return sendJson(res, 200, { ok: true, status: r.status, body: text });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  return sendJson(res, 404, { error: '未知的管理接口' });
}

async function handlePublicApi(req, res, url) {
  if (url.pathname === '/public/config' && req.method === 'GET') {
    return sendJson(res, 200, {
      apiKey: config.publicKey ? config.apiKey : null,
      waitSeconds: config.waitSeconds,
      models: ['reply-1', 'human-pro'],
      autoReply: config.autoReply.enabled,
    });
  }

  if (url.pathname === '/public/stats' && req.method === 'GET') {
    return sendJson(res, 200, {
      requests: stats.total,
      answered: stats.answered,
      timedOut: stats.timedOut,
      pending: pending.size,
      avgReplySeconds: stats.answered ? +(stats.waitMsSum / stats.answered / 1000).toFixed(1) : 0,
      uptimeSeconds: Math.floor((Date.now() - stats.startedAt) / 1000),
    });
  }

  const m = url.pathname.match(/^\/public\/requests\/([a-z0-9_]+)$/i);
  if (m && req.method === 'GET') {
    const rec = pending.get(m[1]) || completed.get(m[1]);
    if (!rec) return sendJson(res, 404, { error: '未知请求 id' });
    const base = {
      id: rec.id,
      status: rec.status,
      received_at: new Date(rec.receivedAt).toISOString(),
      wait_seconds: rec.waitSeconds,
      answered_by: rec.answeredBy || null,
    };
    if (rec.status === 'answered' && rec.answer) {
      return sendJson(res, 200, {
        ...base,
        wait_ms: rec.finishedAt - rec.receivedAt,
        answer: {
          status: rec.answer.status,
          contentType: rec.answer.contentType,
          headers: rec.answer.headers,
          body: rec.answer.body,
        },
      });
    }
    return sendJson(res, 200, base);
  }

  return sendJson(res, 404, { error: '未知接口' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      if (rel === '/index.html') { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('public/index.html 缺失'); }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 not found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ server */

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch {
    res.writeHead(400); return res.end('bad url');
  }

  const p = url.pathname;

  try {
    if (p === '/health') return sendJson(res, 200, { ok: true, pending: pending.size, uptimeSeconds: Math.floor((Date.now() - stats.startedAt) / 1000) });

    if (p === '/favicon.ico') {
      res.writeHead(204); return res.end();
    }

    if (p.startsWith('/admin/api/')) return await handleAdminApi(req, res, url);
    if (p === '/admin' || p === '/admin/') return serveStatic(req, res, url);
    if (p.startsWith('/public/')) return await handlePublicApi(req, res, url);

    if (p.startsWith('/v1/') || p.startsWith('/api/') || p.startsWith('/mock/')
      || p.startsWith('/chat/') || p.startsWith('/openai/')
      || p === '/models' || p === '/completions' || p === '/responses' || p === '/embeddings' || p === '/messages') {
      return await handleMock(req, res, url);
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (p === '/' || p.endsWith('.html') || p.endsWith('.css') || p.endsWith('.js') || p.endsWith('.svg') || p.endsWith('.png')) {
        return serveStatic(req, res, url);
      }
      return sendJson(res, 404, {
        error: 'not_found',
        hint: '可调用的接口：/models、/v1/*、/api/*、/mock/*、/chat/*；文档见 /',
      });
    }

    // 非 GET 的其它路径：当作 mock 接口处理
    return await handleMock(req, res, url);
  } catch (e) {
    log('处理请求出错:', e && e.stack || e);
    if (!res.headersSent) sendJson(res, 500, { error: { message: String(e && e.message || e), type: 'internal_error' } });
    else try { res.end(); } catch {}
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log('端口 ' + config.port + ' 已被占用，尝试下一个端口...');
    config.port = config.port + 1;
    server.listen(config.port, config.host);
  } else {
    log('服务启动失败:', e.message);
    process.exit(1);
  }
});

server.listen(config.port, config.host, () => {
  const addr = server.address();
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);

  console.log('');
  console.log('  ReplyAPI · 人工回复的假 API');
  console.log('  ------------------------------------------------');
  console.log('  站点      http://127.0.0.1:' + addr.port + '/');
  console.log('  控制台    http://127.0.0.1:' + addr.port + '/admin');
  console.log('  局域网    ' + (lan.length ? lan.map((ip) => 'http://' + ip + ':' + addr.port + '/').join('  ') : '(无)'));
  console.log('  API Key   ' + config.apiKey);
  console.log('  控制台密码 ' + config.adminPassword + '   (可在控制台设置中修改)');
  console.log('  数据目录  ' + DATA_DIR);
  console.log('');

  // 生成初始密码时提示一次
});

process.on('SIGINT', () => {
  log('正在退出...');
  for (const rec of pending.values()) {
    if (rec.timer) clearTimeout(rec.timer);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
});
