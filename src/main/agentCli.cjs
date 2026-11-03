'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claudeCli = require('./claudeCli.cjs');
const museCli = require('./museCli.cjs');
const { agentById } = require('../shared/agents.js');

// Claude·Codex 외의 AI(Grok·Muse·Antigravity)의 CLI 찾기·버전·로그인 상태·로그인/탭 인자 (공식 문서 + 2026-11-02 로컬 실측).
// 새 AI 는 src/shared/agents.js 항목과 여기 ADAPTERS 를 함께 추가한다.
//   bin: PATH 에서 찾을 이름 · paths: 공식 설치기가 두는 고정 위치(설치 직후 앱 PATH 가 옛 값이어도 찾도록 먼저 본다)
//   loginArgs: 로그인 명령 인자(전용 명령이 없으면 빈 배열 = CLI 를 그냥 실행해 첫 화면에서 로그인) · tabArgs: 일반 탭 실행 인자
//   authArgs: 모델 호출 없이 로그인 여부를 보는 명령 · loggedOut: 그 출력에서 「미로그인」을 알리는 문구
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

const ADAPTERS = {
  // `grok models`: 미로그인이면 exit 0 + 「You are not authenticated.」 (1.0.70 실측) — 종료 코드로는 못 가른다.
  grok: {
    bin: 'grok',
    paths: () => [path.join(os.homedir(), '.grok', 'bin', 'grok.exe')],
    loginArgs: ['login'],
    tabArgs: [],
    authArgs: ['models'],
    loggedOut: /not authenticated|not signed in/i,
  },
  // `muse usage` 는 모델 턴이 없다(공식). 미로그인이면 exit 1 + 「muse usage: not logged in: run `muse login` first」 (1.4.14 실측, 0.6초).
  // 로그인은 `muse login`(브라우저에서 코드 승인 — 1.4.14 실측 도움말). 위치: 런처 shim(muse.cmd)은 JSON 인자가 cmd.exe 인용에 깨져서, 설치 폴더의 실행 파일(muse-bin-*.exe)을 직접 쓴다 (locate 참고).
  muse: {
    bin: 'muse',
    paths: () => [path.join(LOCALAPPDATA, 'Programs', 'muse', 'muse.cmd')],
    loginArgs: ['login'],
    tabArgs: [],
    authArgs: ['usage'],
    loggedOut: /not logged in/i,
  },
  // `agy models`: 미로그인이면 exit 1 + 「Please sign in to view available models.」 (1.4.12 실측). `agy -p` 는 로그인을 60초 기다리므로 쓰지 않는다.
  antigravity: {
    bin: 'agy',
    paths: () => [path.join(LOCALAPPDATA, 'agy', 'bin', 'agy.exe')],
    loginArgs: [],
    tabArgs: [],
    authArgs: ['models'],
    loggedOut: /please sign in|authentication required/i,
  },
};

// 설치 명령에 덧붙일 환경 변수 (Codex 공식 설치기는 이 값이 있으면 프롬프트 없이 기본값으로 끝낸다).
const INSTALL_ENV = { codex: { CODEX_NON_INTERACTIVE: '1' } };

function has(id) {
  return Object.hasOwn(ADAPTERS, id);
}

// 경로 → CLI 위치. .cmd 는 직접 실행하면 cmd.exe 인용 문제가 있어 claudeCli.locate 처럼 cmd.exe 경유(cmdShim)로 표시한다 (실행은 commandFor 가 맡는다).
function asLoc(file) {
  if (/\.cmd$/i.test(file)) return { file: 'cmd.exe', prefixArgs: [], cmdShim: file, display: file };
  return { file, prefixArgs: [], display: file };
}

// 반환: { file, prefixArgs, display[, cmdShim] } 또는 null. 고정 설치 위치 → PATH(where/which) 순.
async function locate(id, {
  exists = fs.existsSync,
  where = (bin) => claudeCli.run(process.platform === 'win32' ? 'where' : 'which', [bin]),
  platform = process.platform,
  museExe = () => museCli.museExe(),
} = {}) {
  if (!has(id)) return null;
  const a = ADAPTERS[id];
  if (id === 'muse' && platform === 'win32') {
    // 탭·협업·hook 에 JSON 인자를 넘기려면 실행 파일을 직접 쓴다. shim 은 version 이 런처의 자동 업데이트를 돌리는 데만 쓴다.
    const exe = museExe();
    if (exe) {
      const shim = a.paths().find((p) => /\.cmd$/i.test(p) && exists(p));
      return { file: exe, prefixArgs: [], display: exe, ...(shim ? { shim } : {}) };
    }
  }
  if (platform === 'win32') {
    const fixed = a.paths().find((p) => exists(p));
    if (fixed) return asLoc(fixed);
  }
  let lines = [];
  try { lines = (await where(a.bin)).stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean); } catch { /* where 실패 — 못 찾음 */ }
  if (platform !== 'win32') {
    const p = lines[0];
    return p && exists(p) ? asLoc(p) : null;
  }
  const found = lines.find((c) => /\.(?:exe|cmd)$/i.test(c) && exists(c));
  return found ? asLoc(found) : null;
}

// Muse: 런처 shim 으로 부르면 런처가 새 버전을 확인·설치한다 (앱이 실행 파일만 직접 부르면 Muse 가 옛 버전에 머물 수 있다 — 최신 지원).
// 출력 「Muse Code 1.4.14 (…)」→ 1.4.14. 업데이트 확인은 한 시간에 한 번이라 대개 바로 끝난다. 런처가 오래 걸려도 진입 화면이 묶이지 않게 shim 호출만 AUTH_TIMEOUT_MS 에서 끊는다 (넘기면 버전 없음).
async function version(loc, { runner = (l, a, ms) => claudeCli.runClaude(l, a, ms) } = {}) {
  const r = loc.shim ? await runner(asLoc(loc.shim), ['--version'], AUTH_TIMEOUT_MS) : await runner(loc, ['--version']);
  const m = String(r.stdout || '').match(/\d+\.\d+\.\d+[\w.-]*/);
  return m ? m[0] : null;
}

// 로그인 여부. runner 는 { code, stdout, stderr } 를 돌려준다 (runClaude 모양 — 시간 제한 AUTH_TIMEOUT_MS, 넘기면 code 가 0 이 아니고 출력이 빈다).
// 실측 소요: grok models 1.4초 · agy models 1.6초 · muse usage 0.6초 — 진입 화면이 한 AI 때문에 오래 묶이지 않게 10초에서 끊는다.
// 미로그인 문구가 보이면 종료 코드와 무관하게 false (Grok 은 미로그인도 exit 0).
// timeoutMs: 방을 만들 때처럼 더 기다려야 하는 호출자가 시간 제한을 늘린다. 출력 없이 실패하면(시간 초과) 「로그인 필요」 와 구분되게 timedOut 을 단다.
const AUTH_TIMEOUT_MS = 10000;
async function authStatus(id, loc, { timeoutMs = AUTH_TIMEOUT_MS, runner = (l, a) => claudeCli.runClaude(l, a, timeoutMs) } = {}) {
  const a = ADAPTERS[id];
  const r = await runner(loc, a.authArgs, timeoutMs);
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (a.loggedOut.test(out)) return { loggedIn: false };
  if (r.code === 0) return { loggedIn: true };
  const first = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return { loggedIn: false, error: '로그인 상태를 확인하지 못했습니다: ' + (first || '응답이 없습니다').slice(0, 120), ...(first ? {} : { timedOut: true }) };
}

function loginArgs(id) {
  return ADAPTERS[id].loginArgs;
}

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Grok 만 새 세션 ID 를 미리 정한다(-s) — hook 파일은 탭 ID 를 실을 수 없어, 앱이 hook 의 session_id 로 탭을 찾는다.
// Muse 는 세션 단위 hook 을 실행 인자(-c hooks.<이벤트>=…)로 넣는다 — 설정 파일은 고치지 않고, 주소의 tab 으로 탭을 찾는다.
// hook({ port, token, tab }) 이 있고 loc 이 cmd.exe 경유(cmdShim)가 아닐 때만 — shim 은 JSON 인자를 깨뜨리므로 hook 없이 탭만 연다.
function tabArgs(id, { sessionId, hook, cmdShim } = {}) {
  if (id === 'grok' && SESSION_ID_RE.test(String(sessionId))) return [...ADAPTERS[id].tabArgs, '-s', sessionId];
  if (id === 'muse' && hook && !cmdShim) return [...ADAPTERS[id].tabArgs, ...museCli.hookArgs(hook)];
  return ADAPTERS[id].tabArgs;
}

// `grok models` 출력 (1.0.70 실측): 「Default model: grok-4.7」 · 「Available models:」 · 「  * grok-4.7 (default)」 — 「  - <id>」 형식도 문서 예시에 있다.
// 들여쓴 * 또는 - 로 시작하는 모델 줄만 읽고, 이름은 협업 인자로 쓰이므로 안전한 글자만 허용한다. 추론 단계는 공식 문서의 low·medium·high·xhigh.
const GROK_MODEL_LINE = /^\s+[*-]\s+([A-Za-z0-9][A-Za-z0-9._:-]{0,79})(?:\s+\((.*)\))?\s*$/;
function parseGrokModels(text) {
  const out = []; const seen = new Set();
  for (const line of String(text ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/)) {
    const m = line.match(GROK_MODEL_LINE);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ value: m[1], label: m[1], description: /default/i.test(m[2] || '') ? '기본' : '', efforts: ['low', 'medium', 'high', 'xhigh'] });
  }
  return out;
}

// `agy models` 출력 (1.4.12 실측): 첫 줄 「Fetching available models...」(탭 없음) 다음에 「<모델 ID>	<표시 이름>」 (탭으로 구분) 줄이 이어진다 —
// 예: gemini-3.8-flash-high	Gemini 3.8 Flash (High) · claude-sonnet-4-6	Claude Sonnet 4.6 (Thinking). 이름은 협업 인자로 쓰이므로 안전한 글자만 허용한다.
// Gemini 모델만 남긴다(이름이 gemini- 로 시작). 단계는 모델 이름에 포함(High·Medium·Low) — 따로 고르지 않는다(efforts 빈 배열).
const AGY_MODEL_LINE = /^([A-Za-z0-9][A-Za-z0-9._:-]{0,79})\t(.+)$/;
function parseAgyModels(text) {
  const out = []; const seen = new Set();
  for (const line of String(text ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/)) {
    const m = line.match(AGY_MODEL_LINE);
    if (!m || !/^gemini[-_]/i.test(m[1]) || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ value: m[1], label: m[2].trim(), description: '', efforts: [] });
  }
  return out;
}

// 진입 화면 「설치」 버튼이 앱 안 터미널에서 실행할 공식 설치 명령 (Windows PowerShell). 명령은 레지스트리에서만 읽는다 — 화면이 보낸 문자열은 실행하지 않는다.
// -EncodedCommand 라 따옴표·| 를 셸이 다시 해석하지 않고, ExecutionPolicy 는 이 프로세스에만 적용된다 (사용자 설정은 그대로).
function installCommand(id, { platform = process.platform, systemRoot = process.env.SystemRoot || 'C:\\Windows' } = {}) {
  if (platform !== 'win32') return null;
  const cmd = agentById(id)?.install?.cmd;
  if (!cmd) return null;
  return {
    file: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(cmd, 'utf16le').toString('base64')],
  };
}

module.exports = { ADAPTERS, INSTALL_ENV, has, locate, version, authStatus, loginArgs, tabArgs, parseGrokModels, parseAgyModels, installCommand };
