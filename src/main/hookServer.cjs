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
// Claude 는 X-Office-Tab 헤더로, Codex(명령 hook)는 주소의 tab·cli 로 어느 탭인지 알린다.
function toEvent(payload, headers, src, now = Date.now(), query = {}) {
  const raw = headers['x-office-tab'] || query.tab;
  const tab = raw && /^[a-z0-9-]{1,40}$/i.test(String(raw)) ? raw : null;
  const ev = { ...payload };
  ev.tool_input = pickToolInput(ev.tool_input);
  delete ev.tool_response;
  ev.prompt = clip(ev.prompt, 300);
  ev.last_assistant_message = clip(ev.last_assistant_message, 400);
  ev.message = clip(ev.message, 300);
  delete ev.transcript_path;
  delete ev.agent_transcript_path;
  ev._tab = tab ? String(tab) : null;
  ev._src = src || null;
  ev._cli = query.cli === 'codex' ? 'codex' : 'claude';
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

// 붙잡아 둔 권한 요청에 돌려줄 본문. null 은 「결정 없음」(Claude·Codex 가 원래 터미널 승인으로 넘어간다).
// updatedInput·updatedPermissions·interrupt 는 넣지 않는다 (Codex 는 이 필드가 있으면 실패로 처리한다).
const DENY_MESSAGE = '사용자가 Agent Office 에서 거부했습니다. 다른 방법으로 우회하지 말고 사용자의 다음 지시를 기다리세요.';
function permissionBody(decision) {
  if (decision === 'allow') return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  if (decision === 'deny') return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: DENY_MESSAGE } } });
  return '{}';
}

// canHold(): 지금 카드로 답할 수 있는지. holdMs: 붙잡는 최대 시간 (hook 대기 시간 600초보다 짧게).
// onStatus(payload, tab): 상태 표시줄 중계(/status)가 보낸 입력 JSON. 렌더러로는 보내지 않고 메인 안에서만 쓴다.
async function startHookServer({ port, token, onEvent, onStatus = () => {}, host = '127.0.0.1', tries = 10, canHold = () => false, holdMs = 590000, onHeld = () => {}, onClosed = () => {} }) {
  const isDup = createDeduper();
  const held = new Map(); // permId → { res, at, timer } — 응답을 붙잡고 있는 권한 요청

  // 붙잡은 요청에 응답하고 보류를 푼다. 이미 풀렸으면 false.
  function finish(id, decision, how) {
    const h = held.get(id);
    if (!h) return false;
    held.delete(id);
    clearTimeout(h.timer);
    if (!h.res.writableEnded) {
      try { h.res.writeHead(200, { 'content-type': 'application/json' }).end(permissionBody(decision)); } catch { /* 연결이 이미 끊김 */ }
    }
    try { onClosed(id, how); } catch { /* 화면 쪽 오류는 무시 */ }
    return true;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const isStatus = url.pathname === '/status';
    if (req.method !== 'POST' || (url.pathname !== '/hook' && !isStatus) || url.searchParams.get('k') !== token) {
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
      const body = Buffer.concat(chunks).toString('utf8');
      if (isStatus) {
        // 상태 표시줄은 Claude 가 응답을 기다리므로 받자마자 비운 채로 답한다. 보류·중복 제거와 무관.
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        let sp = null;
        try { sp = JSON.parse(body); } catch { return; }
        if (!sp || typeof sp !== 'object') return;
        const rawTab = url.searchParams.get('tab');
        try { onStatus(sp, rawTab && /^[a-z0-9-]{1,40}$/i.test(rawTab) ? rawTab : null); } catch { /* 사용량 쪽 오류는 무시 */ }
        return;
      }
      const key = crypto.createHash('sha1').update(body).digest('hex');
      let payload = null;
      try { payload = JSON.parse(body); } catch { /* 파싱 실패는 아래에서 버린다 */ }
      const valid = !!payload && typeof payload === 'object' && !!payload.hook_event_name;
      // 렌더러로 가는 ev 에서는 지우는 transcript_path 를 메인(사용량)에만 따로 알린다.
      const meta = { transcriptPath: valid && typeof payload.transcript_path === 'string' ? payload.transcript_path : null };
      const src = url.searchParams.get('src');
      const query = { tab: url.searchParams.get('tab'), cli: url.searchParams.get('cli') };
      const ev = valid ? toEvent(payload, req.headers, src, Date.now(), query) : null;
      // 붙잡는 대상: 앱이 띄운 탭의 세션 hook 이 보낸 PermissionRequest 이고 지금 카드로 답할 수 있을 때뿐이다.
      let hold = false;
      if (ev && ev.hook_event_name === 'PermissionRequest' && src === 'session' && ev._tab) {
        try { hold = !!canHold(); } catch { hold = false; }
      }
      if (!hold) {
        // 그 밖의 hook 에는 「결정 없음」으로 즉시 응답한다 — Claude 작업을 늦추지 않는 것이 최우선.
        res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        if (isDup(key)) return;
        if (!ev) return;
        try { onEvent(ev, meta); } catch { /* 화면 쪽 오류는 무시 */ }
        return;
      }
      // 붙잡는 요청은 전역 hook 과 중복돼도 이벤트를 내보낸다 (카드가 이 요청을 가리켜야 하므로). 본문 기록은 남겨 뒤에 오는 전역 사본을 막는다.
      const dup = isDup(key);
      const permId = crypto.randomUUID();
      // 보류 시점의 도구·입력 원본도 함께 둔다 (메인이 카드의 미리보기와 대조한다).
      held.set(permId, { res, at: Date.now(), tool: payload.tool_name, input: payload.tool_input, timer: setTimeout(() => finish(permId, null, 'timeout'), holdMs) });
      res.on('close', () => { if (!res.writableEnded) finish(permId, null, 'close'); });
      ev._permId = permId;
      if (dup) ev._dupHold = true;
      try {
        onEvent(ev, meta);
        onHeld(permId);
      } catch {
        finish(permId, null, 'released'); // 화면에 알리지 못했으면 붙잡지 않고 바로 푼다
      }
    });
  });

  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const actual = await listenOnce(server, port + i, host);
      return {
        server,
        port: actual,
        // 카드의 결정을 붙잡은 요청에 전달한다. 'allow'·'deny' 가 아니면 「결정 없음」으로 푼다.
        resolve: (id, decision) => finish(id, decision === 'allow' || decision === 'deny' ? decision : null, decision ? 'decided' : 'released'),
        releaseAll: () => { for (const id of [...held.keys()]) finish(id, null, 'released'); },
        pending: () => [...held].map(([id, h]) => ({ id, at: h.at, tool: h.tool, input: h.input })),
      };
    } catch (err) {
      lastErr = err;
      if (err.code !== 'EADDRINUSE') break;
    }
  }
  throw lastErr;
}

module.exports = { startHookServer, createDeduper, toEvent };
