// en 사전 — main 영역. 키는 'main.' 로 시작한다. 같은 키가 반대 언어 파일에도 있어야 한다(test/i18n.test.js).
export default {
  // 공통 오류·대화상자
  'main.ipc.denied': 'Request not allowed',
  'main.dialog.cancel': 'Cancel',
  'main.error.noFolder': 'Folder not found: {cwd}',
  'main.error.badTabId': 'Invalid tab ID',
  'main.error.badSessionId': 'Invalid session ID',
  'main.error.badRoster': 'Invalid collaboration participants',
  'main.error.badParticipant': 'Invalid participant',
  'main.error.stopped': 'Stopped',
  'main.error.unknownAgent': 'Unknown AI',
  'main.error.installUnsupported': 'In-app install is not supported on this operating system — please follow the install guide',
  'main.error.loginUnknown': 'This AI has no known login command',
  'main.dialog.pickFolder': 'Choose a working folder',
  'main.startFailed': 'Agent Office failed to start',

  // 상태 확인
  'main.status.codexFailed': 'Could not check Codex status: {detail}',
  'main.status.agentFailed': 'Could not check {name} status: {detail}',
  'main.agent.authFailed': 'Could not check sign-in status: {detail}',
  'main.agent.noResponse': 'No response',
  'main.agent.modelDefault': 'Default',
  'main.claude.authUnreadable': 'Could not read sign-in status',

  // CLI 를 찾지 못함
  'main.notFound.claude': 'Claude Code was not found',
  'main.notFound.codex': 'Codex was not found',
  'main.notFound.codexInstall': 'Codex was not found (install the Codex app or run npm install -g @openai/codex)',
  'main.notFound.muse': 'Muse Code was not found',
  'main.notFound.grok': 'Grok Build was not found',
  'main.notFound.antigravity': 'Antigravity CLI was not found',
  'main.notFound.agent': '{name} was not found',

  // 로그인·모델 목록
  'main.agy.authTimeout': 'Could not check Gemini sign-in status (timed out)',
  'main.agy.loginEnter': 'Gemini sign-in is required (sign in from the entry screen)',
  'main.agy.loginRequired': 'Gemini sign-in is required',
  'main.grok.loginRequired': 'Grok sign-in is required',
  'main.models.codexUnreadable': 'Could not read the codex debug models response',
  'main.models.grokUnreadable': 'Could not read the grok models response',
  'main.models.geminiUnreadable': 'Could not get the Gemini model list',

  // hook 파일
  'main.hooks.readFailed': 'Could not read the settings file: {detail}',
  'main.grok.fileConflict': 'A different file with the same name exists: {file}',
  'main.agy.hooksUnreadable': 'Cannot read hooks.json, so it was left untouched: {file}',
  'main.agy.hooksKeyConflict': 'The "{name}" key in hooks.json is used for something else, so it was left untouched: {file}',
  'main.agy.hooksUnsafe': 'The curl.exe path or hook values are unsafe, so the Gemini (Antigravity CLI) hook was not created',
  'main.muse.badHookPort': 'Invalid hook port',
  'main.muse.badHookValue': 'Invalid hook value',

  // 하단 터미널 셸
  'main.shell.unsupportedShell': 'Unsupported shell',
  'main.shell.unsupportedOs': 'Not supported on this operating system',
  'main.shell.noGitBash': 'Git Bash was not found',
  'main.shell.unregisteredFolder': 'This folder is not registered in the Code view',

  // 다른 곳의 Claude Code 세션 보기 확인 창
  'main.hooks.title': 'View Claude Code sessions from elsewhere',
  'main.hooks.addButton': 'Add',
  'main.hooks.removeButton': 'Remove',
  'main.hooks.addMessage': 'Add the hooks to your user settings?',
  'main.hooks.removeMessage': 'Remove the hooks from your user settings?',
  'main.hooks.addDetail': 'This adds {count} hooks for this app to {file}.\n\n• Your existing settings are backed up in the same folder before being changed.\n• Claude Code running elsewhere (VS Code, a terminal, etc.) will also send events to this app.\n• When the app is closed, events are ignored and Claude work is not affected.\n• Sessions that are already running may need to be restarted to pick this up.',
  'main.hooks.removeDetail': 'This removes only the hooks this app added from {file}. Your other settings stay as they are.',

  // 종료·트레이
  'main.quit.button': 'Quit',
  'main.quit.title': 'Quit Agent Office',
  'main.quit.message': (a) => `${a.running} running Claude Code/Codex session${a.running === 1 ? '' : 's'} will be closed too. Quit?`,
  'main.tray.open': 'Open Agent Office',
  'main.tray.quit': 'Quit',

  // 펫 가져오기
  'main.pets.busy': 'An import is already in progress',
  'main.pets.zipTitle': 'Choose pet zip files (multiple allowed)',
  'main.pets.zipFilter': 'Pet zip',
  'main.pets.folderTitle': 'Choose pet folders (multiple allowed)',
  'main.pets.tooMany': 'You can import up to {max} at a time',
};
