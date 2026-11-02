'use strict';

const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Muse Code(muse 1.4.14, 2026-11-02 실측) 실행 파일 위치·사무실 hook 인자·협업 exec 인자·exec JSONL 해석.
// 실측: 런처 shim(muse.cmd)은 PowerShell 런처라 JSON 인자가 cmd.exe 인용에 깨진다 → 탭·협업·hook 은 실행 파일(muse-bin-<버전>.exe)을 직접 쓴다.
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const MUSE_DIR = path.join(LOCALAPPDATA, 'Programs', 'muse');
const SAFE = /^[A-Za-z0-9._:-]{1,80}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EFFORT_RE = /^(minimal|low|medium|high|xhigh|max|ultra)$/;
// 미로그인 문구 (실측): exec(meta) 「missing meta credential in …\auth.json: run `muse login` or set META_API_KEY」 · usage 「not logged in」
const LOGIN_HINT_RE = /missing meta credential|not logged in/i;
// 세션 단위 hook 이벤트 (이름은 PascalCase — 잘못되면 stderr 「Hooks: 0 runnable」). 도구·권한 요청 이벤트는 echo 로 발화를 못 봐 공식 문서 기준.
// PermissionRequest 는 뺀다: hookServer 가 앱 탭의 PermissionRequest 를 붙잡아 펫 카드를 띄우는데, Muse hook 은 async + curl -m 3 이라 결정을 전달할 수 없다.
// StopFailure 도 뺀다 (실측·공식 근거 없음 — 경고만 낸다). SubagentStart/Stop 은 내부 reminder 에이전트로 자주 와서 걸지 않는다.
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionEnd'];
const TOOL_KEYS = ['file_path', 'notebook_path', 'pattern', 'path', 'description', 'command', 'query', 'url', 'subagent_type', 'skill'];

// 설치 폴더에서 수정 시각이 가장 늦은 muse-bin-*.exe (런처가 업데이트하며 옛 버전을 지운다). 없으면 null.
function museExe(dir = MUSE_DIR, { fs = nodeFs } = {}) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  let best = null;
  for (const name of names) {
    if (!/^muse-bin-.+\.exe$/i.test(name)) continue;
    const file = path.join(dir, name);
    let t;
    try { t = fs.statSync(file).mtimeMs; } catch { continue; }
    if (!best || t > best.t) best = { file, t };
  }
  return best && best.file;
}

// curl 절대 경로. Muse 는 hook 을 `%COMSPEC% /C` 로 돌리고 cmd 는 현재 폴더를 PATH 보다 먼저 찾는다 — 이름만 쓰면 남의 저장소에 심은 curl.exe 가 실행될 수 있다
// (작업 폴더 신뢰 없이도 hook 이 돈다는 실측과 결합). 경로에 공백·cmd 특수문자가 있으면 안전하게 쓸 수 없으니 null (호출하는 쪽이 hook 을 넣지 않는다).
const CURL_PATH_RE = /^[A-Za-z]:\\[A-Za-z0-9._\\-]+$/;
function curlPath(systemRoot = process.env.SystemRoot || 'C:\\Windows') {
  const file = path.win32.join(String(systemRoot), 'System32', 'curl.exe');
  return CURL_PATH_RE.test(file) ? file : null;
}

// hook 명령: Muse 는 명령 안의 큰따옴표를 지운다(실측: -H "Content-Type: application/json" 이 쪼개짐) → 따옴표·공백 든 인자·& 를 쓰지 않는다 (동기·비동기 모두 4/4 수신).
// curl.exe 는 절대 경로 (curlPath) — 안전한 경로가 아니면 null. --url-query 때문에 curl 7.87 이상이 필요하다 (Windows 기본 curl 8.x — 실측 8.19).
function hookCommand({ port, token, tab }, { systemRoot } = {}) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('잘못된 hook 포트');
  if (!SAFE.test(String(token)) || !SAFE.test(String(tab))) throw new Error('잘못된 hook 값');
  const curl = curlPath(systemRoot);
  if (!curl) return null;
  return `${curl} -sS --noproxy 127.0.0.1 -m 3 -H Content-Type:application/json --data-binary @- --url-query k=${token} --url-query src=session --url-query cli=muse --url-query tab=${tab} http://127.0.0.1:${p}/hook`;
}

// 실행할 때마다 -c 로 넣는다 — 사용자 ~/.config/muse 설정은 건드리지 않는다. 관찰용이라 async (에이전트를 막지 않음).
// curl 경로가 안전하지 않으면 [] — hook 없이 실행한다 (탭·협업은 그대로, 사무실 표시만 없음).
function hookArgs({ port, token, tab }, opts) {
  const command = hookCommand({ port, token, tab }, opts);
  if (!command) return [];
  const entry = JSON.stringify([{ hooks: [{ type: 'command', command, timeout: 5, async: true }] }]);
  return HOOK_EVENTS.flatMap((ev) => ['-c', `hooks.${ev}=${entry}`]);
}

// 협업 대화: 화면 없이 한 턴씩 실행한다. 같은 --session-id 로 다시 실행하면 대화가 이어진다 (실측). 프롬프트는 파일로 넘긴다 (한글·따옴표·%·개행 안전).
function execArgs({ promptFile, sessionId, model, effort, hooks = [] }) {
  if (!UUID_RE.test(String(sessionId))) throw new Error('잘못된 세션 ID');
  return ['exec', '--json', '--prompt-file', promptFile, '--session-id', sessionId, '--approval-mode', 'never',
    ...(model && model !== 'auto' && SAFE.test(String(model)) ? ['--model', model] : []),
    ...(effort && EFFORT_RE.test(String(effort)) ? ['--reasoning-effort', effort] : []),
    ...hooks];
}

function pickInput(input) {
  let obj = input;
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return {}; } }
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of TOOL_KEYS) if (typeof obj[k] === 'string') out[k] = obj[k].slice(0, 300);
  return out;
}

// exec JSONL 줄: { schema_version, stream:{kind:'session', id}, payload_type, payload }.
// 실측: run.output.delta(payload.text = 응답 조각) · run.terminal.completed(payload.terminal:'completed', payload.text = 최종 응답, payload.reason). 그 밖(task.*·run.usage 등)은 null.
// 도구·오류 기록 모양은 미확인 — tool 은 방어적으로만 읽는다 (payload_type 에 tool 이 들고 이름이 문자열일 때).
// sessionId 를 주면 stream 이 다른 세션(kind:'session', id 가 다름 — 하위 에이전트 등)인 줄은 무시한다. stream 이 없거나 세션 stream 이 아니면(예: exec.usage) 그대로 해석한다.
// seen(Set)을 주면 같은 도구 호출(tool_use_id 또는 id)이 여러 줄로 와도 한 번만 낸다.
function parseMuseLine(j, sessionId = null, seen = null) {
  if (!j || typeof j !== 'object') return null;
  const type = j.payload_type;
  const pl = j.payload;
  if (typeof type !== 'string' || !pl || typeof pl !== 'object') return null;
  const st = j.stream;
  if (sessionId && st && typeof st === 'object' && st.kind === 'session' && st.id && st.id !== sessionId) return null;
  if (type === 'run.output.delta') return typeof pl.text === 'string' ? { type: 'text', text: pl.text } : null;
  if (/^run\.terminal\./.test(type)) {
    return { type: 'end', ok: pl.terminal === 'completed', text: typeof pl.text === 'string' ? pl.text : '', reason: pl.reason == null ? '' : String(pl.reason) };
  }
  if (/tool/i.test(type)) {
    const name = pl.tool_name || pl.name;
    if (typeof name === 'string' && name) {
      const id = pl.tool_use_id || pl.id;
      if (seen && (typeof id === 'string' || typeof id === 'number')) {
        if (seen.has(id)) return null;
        seen.add(id);
      }
      return { type: 'tool', name: name.slice(0, 80), input: pickInput(pl.tool_input || pl.input || pl.arguments) };
    }
  }
  return null;
}

module.exports = { MUSE_DIR, curlPath, SAFE, HOOK_EVENTS, LOGIN_HINT_RE, museExe, hookCommand, hookArgs, execArgs, parseMuseLine };
