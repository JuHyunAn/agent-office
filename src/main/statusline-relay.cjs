'use strict';

// Agent Office 상태 표시줄 중계 (앱이 시작할 때 userData 로 복사해 쓴다 — 의존성 없이 node 로 단독 실행).
// Claude 가 상태 표시줄 명령에 넘기는 입력 JSON(사용량 rate_limits·컨텍스트 context_window 포함)을
//   1) 앱 서버(/status)로 알리고,
//   2) 사용자가 원래 쓰던 statusLine(~/.claude/settings.json)에 그대로 넘겨 그 출력을 되돌려 준다 (OMC HUD 같은 표시가 그대로 보이게).
// 앱 서버 접속 정보는 같은 폴더의 relay.json { port, token, bashPath? }. 어느 단계가 실패해도 사용자 표시줄은 계속 돌린다.
// 주의: Claude 가 중계를 강제 종료하면(Windows TerminateProcess) HUD 자식이 남을 수 있다 — HUD 는 보통 곧 끝난다.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const CHILD_LIMIT_MS = 10000;
// PATH 에 같은 이름의 가짜 실행 파일이 있어도 쓰이지 않게 시스템 도구는 절대 경로로 부른다.
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const TASKKILL = path.join(SYSTEM32, 'taskkill.exe');
const POWERSHELL = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

function readRelayConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'relay.json'), 'utf8'));
    return Number.isInteger(j.port) && typeof j.token === 'string' ? j : null;
  } catch { return null; }
}

async function notifyApp(body) {
  const cfg = readRelayConfig();
  if (!cfg) return;
  try {
    const url = `http://127.0.0.1:${cfg.port}/status?k=${encodeURIComponent(cfg.token)}&tab=${encodeURIComponent(process.env.AGENT_OFFICE_TAB || '')}`;
    await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(200) });
  } catch { /* 앱이 꺼져 있거나 느리면 건너뛴다 */ }
}

// 사용자의 statusLine 객체. Claude 의 우선순위대로 <작업 폴더>/.claude/settings.local.json → <작업 폴더>/.claude/settings.json → 사용자 설정 순으로
// 처음 찾은 command 형식을 쓴다. 이 중계 자신(statusline-relay 포함)이거나 command 형식이 아닌 항목은 건너뛰고, 끝내 없으면 null.
function userStatusLine() {
  const userDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const files = [
    path.join(process.cwd(), '.claude', 'settings.local.json'),
    path.join(process.cwd(), '.claude', 'settings.json'),
    path.join(userDir, 'settings.json'),
  ];
  for (const f of files) {
    try {
      const u = JSON.parse(fs.readFileSync(f, 'utf8')).statusLine;
      if (u && u.type === 'command' && typeof u.command === 'string' && !u.command.includes('statusline-relay')) return u;
    } catch { /* 없거나 읽을 수 없으면 다음 설정 */ }
  }
  return null;
}

// Claude 2.1.312 의 statusLine 은 command 한 줄(셸 실행)뿐이다. args·shell 은 이후 버전이 지원할 때를 위해 같은 방식으로 받아 둔다.
// Windows 의 Git Bash 경로는 앱이 시작할 때 한 번 찾아 relay.json 의 bashPath 로 넣어 준다 (없으면 PowerShell).
function launchSpec(u, cfg) {
  if (Array.isArray(u.args)) return { file: u.command, args: u.args.map(String) };
  const powershell = { file: POWERSHELL, args: ['-NoProfile', '-NonInteractive', '-Command', u.command] };
  if (u.shell === 'powershell') return powershell;
  const bash = process.platform === 'win32' ? (cfg && typeof cfg.bashPath === 'string' && fs.existsSync(cfg.bashPath) ? cfg.bashPath : null) : 'sh';
  return bash ? { file: bash, args: ['-c', u.command] } : powershell;
}

let child = null;
function killChild() {
  if (!child || child.exitCode !== null || !child.pid) return;
  try { spawnSync(TASKKILL, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }); } catch { /* 이미 종료 */ }
}

function runUser(u, input, cfg) {
  return new Promise((resolve) => {
    let spec;
    try { spec = launchSpec(u, cfg); } catch { resolve(); return; }
    try {
      child = spawn(spec.file, spec.args, { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { resolve(); return; }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killChild(); process.exitCode = 1; resolve(); }, CHILD_LIMIT_MS);
    child.on('error', () => { clearTimeout(timer); resolve(); });
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.on('close', (code) => { clearTimeout(timer); if (!timedOut) process.exitCode = code ?? 0; resolve(); });
    child.stdin.on('error', () => { /* 자식이 입력을 다 읽기 전에 끝난 경우 */ });
    child.stdin.end(input);
  });
}

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { killChild(); process.exit(1); });
process.on('exit', killChild);

(async () => {
  const input = await readStdin();
  const u = userStatusLine();
  await Promise.all([notifyApp(input), u ? runUser(u, input, readRelayConfig()) : null]);
})();
