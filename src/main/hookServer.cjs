'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const MAX_BODY = 1024 * 1024;

// 앱이 띄운 세션은 --settings hook 과 사용자 전역 hook 이 둘 다 걸려 같은 이벤트가 두 번 온다.
// 두 hook 은 같은 입력 JSON 을 받으므로 본문 해시로 짧은 시간 안의 중복을 버린다.
function createDeduper(windowMs = 5000) {
  const seen = new Map();
  return (key, now = Date.now()) => {
    for (const [k, t] of seen) if (now - t > windowMs) seen.delete(k);
    if (seen.has(key)) return true;
    seen.set(key, now);
    return false;
  };
}

function clip(v, n) {
  return typeof v === 'string' && v.length > n ? v.slice(0, n) + '…' : v;
}

// 엔진·화면이 쓰는 tool_input 필드 (파일 본문 등 큰 값은 보내지 않는다).
const TOOL_INPUT_KEYS = ['file_path', 'notebook_path', 'pattern', 'path', 'description', 'command', 'query', 'url',
  'subagent_type', 'skill', 'to', 'summary'];

function pickToolInput(input) {
  if (!input || typeof input !== 'object') return undefined;
  const out = {};
  for (const k of TOOL_INPUT_KEYS) if (input[k] !== undefined) out[k] = clip(typeof input[k] === 'string' ? input[k] : String(input[k]), 300);
  return out;
}

// 화면에 필요한 만큼만 남긴다 (프롬프트·최종 답변 전문은 렌더러로 보내지 않는다).
function toEvent(payload, headers, src, now = Date.now()) {
  const tab = headers['x-office-tab'];
  const ev = { ...payload };
  ev.tool_input = pickToolInput(ev.tool_input);
  delete ev.tool_response;
  ev.prompt = clip(ev.prompt, 300);
  ev.last_assistant_message = clip(ev.last_assistant_message, 400);
  ev.message = clip(ev.message, 300);
  delete ev.transcript_path;
  delete ev.agent_transcript_path;
  ev._tab = tab && !String(tab).startsWith('$') ? String(tab) : null;
  ev._src = src || null;
  ev._at = now;
  return ev;
}

function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener('listening', onListening); reject(err); };
    const onListening = () => { server.removeListener('error', onError); resolve(server.address().port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function startHookServer({ port, token, onEvent, host = '127.0.0.1', tries = 10 }) {
  const isDup = createDeduper();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'POST' || url.pathname !== '/hook' || url.searchParams.get('k') !== token) {
      res.writeHead(404).end();
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      // hook 에는 「결정 없음」으로 즉시 응답한다 — Claude 작업을 늦추지 않는 것이 최우선.
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      const body = Buffer.concat(chunks).toString('utf8');
      const key = crypto.createHash('sha1').update(body).digest('hex');
      if (isDup(key)) return;
      let payload;
      try { payload = JSON.parse(body); } catch { return; }
      if (!payload || typeof payload !== 'object' || !payload.hook_event_name) return;
      try { onEvent(toEvent(payload, req.headers, url.searchParams.get('src'))); } catch { /* 화면 쪽 오류는 무시 */ }
    });
  });

  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const actual = await listenOnce(server, port + i, host);
      return { server, port: actual };
    } catch (err) {
      lastErr = err;
      if (err.code !== 'EADDRINUSE') break;
    }
  }
  throw lastErr;
}

module.exports = { startHookServer, createDeduper, toEvent };
