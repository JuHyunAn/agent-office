'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn, spawnSync } = require('node:child_process');
const claudeCli = require('./claudeCli.cjs');
const { cleanEnv } = require('./env.cjs');

// Codex hook 은 명령 실행만 지원한다 (HTTP 없음). Windows 기본 curl.exe 로 앱 서버에 본문을 넘긴다.
// Windows 에서는 PowerShell 이 명령을 실행하므로 @- 같은 특수 기호는 모두 따옴표로 감싼다 (0.163 실측).
const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse',
  'SubagentStart', 'SubagentStop', 'PermissionRequest', 'Stop'];
const SAFE = /^[A-Za-z0-9._:-]{1,80}$/;
const EFFORT_RE = /^[a-z]{2,12}$/; // 단계 이름은 Codex 가 알려 준 목록(low … ultra)에서 온다

// maxSec: curl 이 응답을 기다리는 최대 시간. 권한 요청은 카드 승인을 기다리므로 길게 쓴다 (hookArgs 참고).
function hookCommand({ port, token, tab, maxSec = 2 }) {
  const url = `http://127.0.0.1:${Number(port)}/hook?k=${token}&src=session&cli=codex&tab=${tab}`;
  return `curl.exe -sS --noproxy "*" -m ${Math.trunc(Number(maxSec))} -X POST -H "Content-Type: application/json" --data-binary "@-" "${url}"`;
}

// 실행할 때마다 -c 로 넣는다 — 사용자 ~/.codex 설정은 건드리지 않는다.
// PermissionRequest 만 응답을 오래 기다린다 (앱이 590초에 먼저 풀고, curl 595초 · hook 600초는 그보다 늦게 끊는다. 0.163 실측: 130초 보류 뒤 allow 정상).
function hookArgs({ port, token, tab }) {
  if (!SAFE.test(String(token)) || !SAFE.test(String(tab))) throw new Error('잘못된 hook 값');
  return HOOK_EVENTS.flatMap((ev) => {
    const slow = ev === 'PermissionRequest';
    const command = JSON.stringify(hookCommand({ port, token, tab, maxSec: slow ? 595 : 2 })); // JSON 문자열은 TOML 기본 문자열과 호환
    return ['-c', `hooks.${ev}=[{hooks=[{type="command",command=${command},timeout=${slow ? 600 : 3}}]}]`];
  });
}

// 앱 탭: 기본 승인 모드로 시작한다. 주입한 hook 은 탭마다 주소가 달라 신뢰 기록이 맞지 않으므로 이 실행에서만 검토를 건너뛴다.
function tabArgs({ hooks }) {
  return [...hooks, '--dangerously-bypass-hook-trust'];
}

// 협업 대화: 화면 없이 한 턴씩 실행한다. 프롬프트는 표준 입력('-')으로 넘긴다.
function execArgs({ resumeId, model, effort, hooks = [] }) {
  if (!SAFE.test(String(model))) throw new Error('잘못된 모델');
  if (effort != null && !EFFORT_RE.test(String(effort))) throw new Error('잘못된 추론 단계');
  if (resumeId != null && !SAFE.test(String(resumeId))) throw new Error('잘못된 세션 ID');
  return ['exec', ...(resumeId ? ['resume', resumeId] : []), '--json', '-m', model, ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
    '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', ...hooks, '--dangerously-bypass-hook-trust', '-'];
}

// codex debug models: 계정에서 쓸 수 있는 모델 목록과 모델별 추론 단계 (0.163 실측). 숨김 모델은 뺀다.
function parseModels(json) {
  return (Array.isArray(json?.models) ? json.models : [])
    .filter((m) => m && m.visibility === 'list' && SAFE.test(String(m.slug)))
    .map((m) => ({
      value: m.slug, label: String(m.display_name || m.slug), description: String(m.description || ''),
      efforts: (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : []).map((l) => String(l?.effort)).filter((e) => EFFORT_RE.test(e)),
    }));
}

// 출력이 600KB 를 넘어 기본 출력 한도(1MB)에 가깝다 — 넉넉히 잡는다.
function models(loc) {
  return new Promise((resolve) => {
    execFile(loc.file, [...loc.prefixArgs, 'debug', 'models'], { env: cleanEnv(), windowsHide: true, timeout: 20000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => { try { resolve(err ? null : parseModels(JSON.parse(stdout))); } catch { resolve(null); } });
  });
}

// Codex 데스크톱 앱은 %LOCALAPPDATA%\OpenAI\Codex\bin\<버전 해시>\codex.exe 에 CLI 를 함께 둔다. 업데이트마다 폴더가 바뀌므로 최신 것을 고른다.
function bundledCodex(localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')) {
  const bin = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  let best = null;
  try {
    for (const d of fs.readdirSync(bin)) {
      const exe = path.join(bin, d, 'codex.exe');
      try { const t = fs.statSync(exe).mtimeMs; if (!best || t > best.t) best = { exe, t }; } catch { /* 다른 폴더 */ }
    }
  } catch { return null; }
  return best && best.exe;
}

// npm 설치본(codex.cmd)은 node 스크립트를 거쳐 패키지 안의 실제 codex.exe 를 부른다 (vendor\<플랫폼>\codex\codex.exe).
// cmd.exe 를 거치면 hook 인자의 따옴표가 지워지므로 그 exe 를 직접 찾는다.
function npmVendorExe(cmdPath) {
  const root = path.join(path.dirname(cmdPath), 'node_modules', '@openai', 'codex');
  const walk = (dir, depth) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) if (e.isFile() && e.name.toLowerCase() === 'codex.exe') return path.join(dir, e.name);
    if (depth <= 0) return null;
    for (const e of entries) if (e.isDirectory() && e.name !== 'bin' && e.name !== '.bin') { const f = walk(path.join(dir, e.name), depth - 1); if (f) return f; }
    return null;
  };
  return walk(root, 7);
}

function pickCodex(candidates, localAppData) {
  const exe = (file) => ({ file, prefixArgs: [], display: file });
  for (const c of candidates) if (/\.exe$/i.test(c) && fs.existsSync(c)) return exe(c);
  for (const c of candidates) if (/\.cmd$/i.test(c) && fs.existsSync(c)) { const v = npmVendorExe(c); if (v) return exe(v); }
  const bundled = bundledCodex(localAppData);
  return bundled ? exe(bundled) : null;
}

async function locate() {
  if (process.platform !== 'win32') {
    const r = await claudeCli.run('which', ['codex']);
    const p = r.stdout.trim().split('\n')[0];
    return p && fs.existsSync(p) ? { file: p, prefixArgs: [], display: p } : null;
  }
  const r = await claudeCli.run('where', ['codex']);
  return pickCodex(r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
}

async function version(loc) {
  const r = await claudeCli.runClaude(loc, ['--version']);
  const m = r.stdout.match(/\d+\.\d+\.\d+[\w.-]*/);
  return m ? m[0] : null;
}

// 사용량 창 이름: 300분 → 세션, 10080분(7일) → 주간, 그 밖은 시간 단위.
function windowLabel(mins) {
  if (mins === 300) return '세션';
  if (mins === 10080) return '주간';
  return `${Math.round(Number(mins) / 60)}시간`;
}

// app-server(usedPercent·windowDurationMins·resetsAt)와 롤아웃(used_percent·window_minutes·resets_at)의 한도 객체 → Row[]. resetsAt 은 초 단위.
// 세션·주간이 아닌 창은 계약의 id 모양에 맞게 model:<라벨> 로 둔다.
function limitRows(rl, observedAt) {
  const rows = [];
  for (const w of [rl?.primary, rl?.secondary]) {
    if (!w || typeof w !== 'object') continue;
    const pct = Number(w.usedPercent ?? w.used_percent);
    const mins = Number(w.windowDurationMins ?? w.window_minutes);
    const resets = Number(w.resetsAt ?? w.resets_at);
    if (!Number.isFinite(pct) || !Number.isFinite(mins)) continue;
    const label = windowLabel(mins);
    rows.push({
      id: mins === 300 ? 'session' : mins === 10080 ? 'week' : `model:${label}`, label,
      percent: Math.max(0, Math.min(100, Math.round(pct))), resetsAt: Number.isFinite(resets) ? resets * 1000 : null, resetsText: null, observedAt,
    });
  }
  return rows;
}

// 롤아웃(세션 기록) 줄들에서 가장 최근 token_count 의 한도와 컨텍스트 사용률을 읽는다. 둘 다 못 찾으면 null.
// 한도 값이 없는 token_count 가 최근에 있어도 그 앞의 한도 값을 쓰도록 각각 따로 찾는다.
function parseRollout(lines, now = Date.now()) {
  let rows = null;
  let contextPercent = null;
  for (let i = lines.length - 1; i >= 0 && (rows === null || contextPercent === null); i--) {
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    if (!o || o.type !== 'event_msg' || o.payload?.type !== 'token_count') continue;
    const p = o.payload;
    if (rows === null && p.rate_limits) {
      const at = Date.parse(o.timestamp);
      rows = limitRows(p.rate_limits, Number.isFinite(at) ? at : now);
    }
    const used = Number(p.info?.last_token_usage?.total_tokens);
    const size = Number(p.info?.model_context_window);
    if (contextPercent === null && used >= 0 && size > 0) contextPercent = Math.max(0, Math.min(100, Math.round(used / size * 100)));
  }
  return rows === null && contextPercent === null ? null : { rows: rows || [], contextPercent };
}

function killTree(pid) {
  if (process.platform !== 'win32' || !pid) return;
  try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }); } catch { /* 이미 종료 */ }
}

// codex app-server(줄 단위 JSON-RPC)에 대화 없이 요청 하나를 보낸다 (한도 0.163 실측: 약 1초). 반환: { result } 또는 { error }.
// signal(AbortSignal)이 중단되면 (앱 종료) 바로 자식을 정리하고 { error } 로 끝낸다.
// fallbackError: 오류 응답에 message 가 없을 때 쓸 문구 (요청마다 기존 문구를 유지하려고).
function appServerRequest(loc, method, params, { timeoutMs = 10000, appVersion = '0.1.0', signal, fallbackError = '요청 실패' } = {}) {
  return new Promise((resolve) => {
    if (!loc || loc.cmdShim) { resolve({ error: 'Codex 를 실행할 수 없습니다' }); return; }
    if (signal?.aborted) { resolve({ error: '중단됨' }); return; }
    let child;
    try {
      child = spawn(loc.file, [...loc.prefixArgs, 'app-server'], { env: cleanEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) { resolve({ error: `Codex 를 실행하지 못했습니다: ${String(e && e.message || e).slice(0, 80)}` }); return; }
    let done = false;
    let exited = false; // 이미 끝난 자식의 pid 는 다른 프로세스가 물려받았을 수 있으므로 killTree 하지 않는다
    let buf = '';
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch { /* 이미 닫힘 */ } };
    const onAbort = () => { finish({ error: '중단됨' }); if (!exited) killTree(child.pid); };
    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { child.stdin.end(); } catch { /* 이미 닫힘 */ }
      setTimeout(() => { if (!exited) killTree(child.pid); }, 300).unref?.();
      resolve(res);
    };
    const timer = setTimeout(() => finish({ error: 'Codex 응답 시간 초과' }), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdin.on('error', () => {});
    child.on('error', (e) => finish({ error: `Codex 를 실행하지 못했습니다: ${String(e.message).slice(0, 80)}` }));
    child.on('exit', () => { exited = true; finish({ error: 'Codex 가 응답 없이 끝났습니다' }); });
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (!j || typeof j !== 'object' || 'method' in j) continue; // 서버가 보낸 요청·알림은 응답이 아니다 (id 가 같아도)
        if (j.id === 1) {
          send({ method: 'initialized' });
          send({ method, id: 2, ...(params === undefined ? {} : { params }) });
        } else if (j.id === 2) {
          if (j.error) finish({ error: String(j.error.message || fallbackError).slice(0, 100) });
          else finish({ result: j.result });
        }
      }
    });
    send({ method: 'initialize', id: 1, params: { clientInfo: { name: 'agent-office', title: 'Agent Office', version: String(appVersion) } } });
  });
}

// 계정 한도. 반환: { rows, at } 또는 { error }.
async function rateLimits(loc, opts) {
  const r = await appServerRequest(loc, 'account/rateLimits/read', undefined, { fallbackError: '한도 정보가 없습니다', ...opts });
  if (r.error) return { error: r.error };
  const rl = r.result?.rateLimits;
  if (!rl) return { error: '한도 정보가 없습니다' };
  return { rows: limitRows(rl, Date.now()), at: Date.now() };
}

// `codex login status` 출력 → 로그인 여부. 종료 0 이고 「Logged in using …」 줄이 있을 때만 로그인으로 본다 (미로그인 출력은 실측 못 함).
// API 키 방식은 뒤에 ` - sk-…` 가 붙을 수 있어 잘라 낸다.
function parseLoginStatus(code, text) {
  const m = code === 0 && String(text || '').match(/^\s*Logged in using (.+?)\s*$/m);
  if (m) return { loggedIn: true, method: m[1].replace(/\s+-\s+.*$/, '') };
  if (/Not logged in/i.test(String(text || ''))) return { loggedIn: false };
  const first = String(text || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return { loggedIn: false, error: (first || '').slice(0, 200) || '로그인 상태를 읽지 못했습니다' };
}

function methodLabel(method) {
  const s = String(method || '');
  if (/^ChatGPT/i.test(s)) return 'ChatGPT';
  if (/^an? API key/i.test(s)) return 'API 키';
  if (/^personal access token/i.test(s)) return '개인 액세스 토큰';
  if (/access token/i.test(s)) return '액세스 토큰';
  if (/Bedrock/i.test(s)) return 'Amazon Bedrock';
  return s.slice(0, 60);
}

// 로그인 판정은 CLI login status(빠르고 안정), 이메일·플랜은 app-server account/read 로 덧붙인다 (실패해도 판정 유지).
async function authStatus(loc, { appVersion, timeoutMs = 3000 } = {}) {
  // 실측 0.3초 — 멈추면 진입 화면이 함께 기다리므로 짧게 끊는다 (Codex 는 cmd shim 이 아니라 exe 를 바로 실행).
  const r = loc.cmdShim ? await claudeCli.runClaude(loc, ['login', 'status']) : await claudeCli.run(loc.file, [...loc.prefixArgs, 'login', 'status'], 5000);
  const s = parseLoginStatus(r.code, `${r.stdout}\n${r.stderr}`);
  if (!s.loggedIn) return s;
  const a = await appServerRequest(loc, 'account/read', { refreshToken: false }, { timeoutMs, appVersion });
  const acc = a.result?.account;
  return { ...s, methodLabel: methodLabel(s.method), email: acc?.email || null, plan: acc?.planType || null };
}

module.exports = {
  HOOK_EVENTS, hookCommand, hookArgs, tabArgs, execArgs, parseModels, models, bundledCodex, npmVendorExe, pickCodex, locate, version,
  windowLabel, limitRows, parseRollout, rateLimits, appServerRequest, parseLoginStatus, methodLabel, authStatus,
};
