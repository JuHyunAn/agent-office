'use strict';

const path = require('node:path');
const { t } = require('../shared/i18n.js');

// 코드 화면 하단 터미널이 띄우는 셸. 종류는 'powershell'|'bash' 만 받고, 렌더러 문자열은 셸 인자에 넣지 않는다.
const UTF8_PIPE = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8';

// PowerShell 은 System32 의 절대 경로로 띄운다 — 작업 폴더에 가짜 powershell.exe 가 있어도 잡히지 않게.
// -Command 는 파이프 출력(git log | Out-String 등)의 한글이 깨지지 않게 인코딩만 맞춘다. -NoProfile 은 쓰지 않는다(사용자 셸 그대로).
function shellCommand(kind, { platform = process.platform, systemRoot, bashPath } = {}) {
  if (kind !== 'powershell' && kind !== 'bash') throw new Error(t('main.shell.unsupportedShell'));
  if (platform !== 'win32') throw new Error(t('main.shell.unsupportedOs'));
  if (kind === 'bash') {
    if (!bashPath) throw new Error(t('main.shell.noGitBash'));
    return { file: bashPath, args: ['--login', '-i'] };
  }
  return {
    file: path.win32.join(systemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoExit', '-Command', UTF8_PIPE],
  };
}

// pty:create 의 mode:'shell' 검사 + 실행 명령. 코드 화면에 등록된 폴더(roots)만, 그 폴더가 있어야 하고, 셸 종류는 고정 두 값만 받는다.
// Git Bash 위치는 Windows 에서 bash 를 고른 때만 찾는다 (findBash).
async function shellLaunch({ shell, cwd, roots, checkFolder, findBash, platform = process.platform, systemRoot = process.env.SystemRoot }) {
  if (!roots.has(cwd)) throw new Error(t('main.shell.unregisteredFolder'));
  checkFolder(cwd);
  const bashPath = shell === 'bash' && platform === 'win32' ? await findBash() : null;
  return shellCommand(shell, { platform, systemRoot, bashPath });
}

// 검사(shellLaunch)를 통과하면 터미널용 pty 를 만든다 (kind:'shell' — 종료 확인 창의 세션 수에 들지 않는다). 거부되면 pty 를 만들지 않는다.
// env 는 호출한 쪽이 정한다 (AGENT_OFFICE_TAB 이 없어 그 안에서 띄운 claude 는 외부 세션으로 처리된다).
async function startShellPty({ ptys, env, tabId, cwd, cols, rows, ...launch }) {
  const cmd = await shellLaunch({ cwd, ...launch });
  return ptys.create({ tabId, cwd, cols, rows, file: cmd.file, args: cmd.args, env, kind: 'shell' });
}

module.exports = { shellCommand, shellLaunch, startShellPty };
