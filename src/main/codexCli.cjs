'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const claudeCli = require('./claudeCli.cjs');
const { cleanEnv } = require('./env.cjs');

// Codex hook 은 명령 실행만 지원한다 (HTTP 없음). Windows 기본 curl.exe 로 앱 서버에 본문을 넘긴다.
// Windows 에서는 PowerShell 이 명령을 실행하므로 @- 같은 특수 기호는 모두 따옴표로 감싼다 (0.163 실측).
const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse',
  'SubagentStart', 'SubagentStop', 'PermissionRequest', 'Stop'];
const SAFE = /^[A-Za-z0-9._:-]{1,80}$/;
const EFFORT_RE = /^[a-z]{2,12}$/; // 단계 이름은 Codex 가 알려 준 목록(low … ultra)에서 온다

function hookCommand({ port, token, tab }) {
  const url = `http://127.0.0.1:${Number(port)}/hook?k=${token}&src=session&cli=codex&tab=${tab}`;
  return `curl.exe -sS --noproxy "*" -m 2 -X POST -H "Content-Type: application/json" --data-binary "@-" "${url}"`;
}

// 실행할 때마다 -c 로 넣는다 — 사용자 ~/.codex 설정은 건드리지 않는다.
function hookArgs({ port, token, tab }) {
  if (!SAFE.test(String(token)) || !SAFE.test(String(tab))) throw new Error('잘못된 hook 값');
  const command = JSON.stringify(hookCommand({ port, token, tab })); // JSON 문자열은 TOML 기본 문자열과 호환
  return HOOK_EVENTS.flatMap((ev) => ['-c', `hooks.${ev}=[{hooks=[{type="command",command=${command},timeout=3}]}]`]);
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

module.exports = { HOOK_EVENTS, hookCommand, hookArgs, tabArgs, execArgs, parseModels, models, bundledCodex, npmVendorExe, pickCodex, locate, version };
