'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanEnv } = require('./env.cjs');

function run(file, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile(file, args, { env: cleanEnv(), windowsHide: true, timeout: timeoutMs, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '' }));
  });
}

// npm 설치본의 claude.cmd 는 `"%dp0%\node_modules\...\claude.exe" %*` 한 줄로 실제 exe 를 부른다.
// pty 로 .cmd 를 직접 띄우면 cmd.exe 인용 규칙에 걸리므로 exe 경로를 찾아 바로 실행한다.
function exeFromCmdShim(cmdPath) {
  try {
    const text = fs.readFileSync(cmdPath, 'utf8');
    const m = text.match(/"%dp0%\\([^"]+?\.exe)"/i);
    if (!m) return null;
    const exe = path.join(path.dirname(cmdPath), m[1]);
    return fs.existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

async function locate() {
  const candidates = [];
  if (process.platform === 'win32') {
    const r = await run('where', ['claude']);
    candidates.push(...r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    candidates.push(path.join(os.homedir(), '.local', 'bin', 'claude.exe'));
    for (const c of candidates) {
      if (/\.exe$/i.test(c) && fs.existsSync(c)) return { file: c, prefixArgs: [], display: c };
      if (/\.cmd$/i.test(c)) {
        const exe = exeFromCmdShim(c);
        if (exe) return { file: exe, prefixArgs: [], display: exe };
      }
    }
    // 마지막 수단: cmd.exe 를 거쳐 .cmd 실행 (pnpm·yarn 등 다른 형식의 셔임) — 인용은 commandFor() 가 맡는다.
    const cmd = candidates.find((c) => /\.cmd$/i.test(c));
    if (cmd) return { file: 'cmd.exe', prefixArgs: [], cmdShim: cmd, display: cmd };
    return null;
  }
  const r = await run('which', ['claude']);
  const p = r.stdout.trim().split('\n')[0];
  if (p && fs.existsSync(p)) return { file: p, prefixArgs: [], display: p };
  const local = path.join(os.homedir(), '.local', 'bin', 'claude');
  return fs.existsSync(local) ? { file: local, prefixArgs: [], display: local } : null;
}

// cmd.exe 경유일 때: /s 가 바깥 따옴표 한 쌍을 벗기므로 전체를 한 번 더 감싸고, 인자는 모두 따옴표로 묶는다.
// 따옴표 안에서도 남는 cmd 특수문자(" %)는 안전하게 넘길 방법이 없어 지운다 (라벨·경로에만 쓰이는 값).
function cmdQuote(s) {
  return `"${String(s).replace(/["%]/g, '')}"`;
}

// 반환: { file, args } — args 는 .exe 면 배열, cmd 경유면 명령줄 문자열(node-pty 는 그대로 붙인다).
function commandFor(loc, args) {
  if (!loc.cmdShim) return { file: loc.file, args: [...loc.prefixArgs, ...args] };
  return { file: 'cmd.exe', args: `/d /s /c "${[loc.cmdShim, ...args].map(cmdQuote).join(' ')}"` };
}

// 앱 탭에서 띄우는 claude 인자. 기본 모드로 시작하고 Bypass Permissions 는 Shift+Tab 선택지로만 열어 둔다.
function tabArgs({ settingsPath, mode, resumeId, sessionId, label }) {
  const args = ['--settings', settingsPath, '--allow-dangerously-skip-permissions'];
  // 같은 세션을 두 곳에서 이어 쓰면 기록이 섞이므로 항상 복제(fork)해서 이어받는다.
  if (mode === 'resume') args.push('--resume', resumeId, '--fork-session');
  else args.push('--session-id', sessionId);
  if (label) args.push('-n', String(label).slice(0, 60));
  return args;
}

function runClaude(loc, args) {
  const c = commandFor(loc, args);
  if (typeof c.args !== 'string') return run(c.file, c.args);
  return new Promise((resolve) => {
    execFile(c.file, [c.args], { env: cleanEnv(), windowsHide: true, timeout: 20000, encoding: 'utf8', windowsVerbatimArguments: true },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '' }));
  });
}

async function version(loc) {
  const r = await runClaude(loc, ['--version']);
  const m = r.stdout.match(/\d+\.\d+\.\d+/);
  return m ? m[0] : null;
}

// `claude auth status` 는 JSON({loggedIn, authMethod, email, subscriptionType ...})을 출력한다 (2.1.241 실측).
async function authStatus(loc) {
  const r = await runClaude(loc, ['auth', 'status']);
  try {
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    return {
      loggedIn: !!j.loggedIn,
      authMethod: j.authMethod || null,
      email: j.email || null,
      subscriptionType: j.subscriptionType || null,
    };
  } catch {
    return { loggedIn: false, error: (r.stderr || r.stdout).trim().slice(0, 300) || '로그인 상태를 읽지 못했습니다' };
  }
}

module.exports = { locate, version, authStatus, exeFromCmdShim, commandFor, tabArgs };
