// ko 사전 — main 영역. 키는 'main.' 로 시작한다. 같은 키가 반대 언어 파일에도 있어야 한다(test/i18n.test.js).
export default {
  // 공통 오류·대화상자
  'main.ipc.denied': '허용되지 않는 요청입니다',
  'main.dialog.cancel': '취소',
  'main.error.noFolder': '폴더가 없습니다: {cwd}',
  'main.error.badTabId': '잘못된 탭 ID',
  'main.error.badSessionId': '잘못된 세션 ID',
  'main.error.badRoster': '잘못된 협업 참여자',
  'main.error.badParticipant': '잘못된 참여자',
  'main.error.stopped': '중단됨',
  'main.error.unknownAgent': '알 수 없는 AI 입니다',
  'main.error.installUnsupported': '이 운영체제에서는 앱 안 설치를 지원하지 않습니다 — 설치 안내를 따라 주세요',
  'main.error.loginUnknown': '로그인 명령을 알 수 없는 AI 입니다',
  'main.dialog.pickFolder': '작업 폴더 선택',
  'main.startFailed': 'Agent Office 시작 실패',

  // 상태 확인
  'main.status.codexFailed': 'Codex 상태를 확인하지 못했습니다: {detail}',
  'main.status.agentFailed': '{name} 상태를 확인하지 못했습니다: {detail}',
  'main.agent.authFailed': '로그인 상태를 확인하지 못했습니다: {detail}',
  'main.agent.noResponse': '응답이 없습니다',
  'main.agent.modelDefault': '기본',
  'main.claude.authUnreadable': '로그인 상태를 읽지 못했습니다',

  // CLI 를 찾지 못함
  'main.notFound.claude': 'Claude Code 를 찾지 못했습니다',
  'main.notFound.codex': 'Codex 를 찾지 못했습니다',
  'main.notFound.codexInstall': 'Codex 를 찾지 못했습니다 (Codex 앱 또는 npm install -g @openai/codex)',
  'main.notFound.muse': 'Muse Code 를 찾지 못했습니다',
  'main.notFound.grok': 'Grok Build 를 찾지 못했습니다',
  'main.notFound.antigravity': 'Antigravity CLI 를 찾지 못했습니다',
  'main.notFound.agent': '{name} 을(를) 찾지 못했습니다',

  // 로그인·모델 목록
  'main.agy.authTimeout': 'Gemini 로그인 상태를 확인하지 못했습니다 (시간 초과)',
  'main.agy.loginEnter': 'Gemini 로그인이 필요합니다 (진입 화면에서 로그인)',
  'main.agy.loginRequired': 'Gemini 로그인이 필요합니다',
  'main.grok.loginRequired': 'Grok 로그인이 필요합니다',
  'main.models.codexUnreadable': 'codex debug models 응답을 읽지 못했습니다',
  'main.models.grokUnreadable': 'grok models 응답을 읽지 못했습니다',
  'main.models.geminiUnreadable': 'Gemini 모델 목록을 받지 못했습니다',

  // hook 파일
  'main.hooks.readFailed': '설정 파일을 읽지 못했습니다: {detail}',
  'main.grok.fileConflict': '같은 이름의 다른 파일이 있습니다: {file}',
  'main.agy.hooksUnreadable': 'hooks.json 을 읽을 수 없어 건드리지 않습니다: {file}',
  'main.agy.hooksKeyConflict': 'hooks.json 의 "{name}" 키가 다른 용도로 쓰여 건드리지 않습니다: {file}',
  'main.agy.hooksUnsafe': 'curl.exe 경로나 hook 값이 안전하지 않아 Gemini(Antigravity CLI) hook 을 만들지 않습니다',
  'main.muse.badHookPort': '잘못된 hook 포트',
  'main.muse.badHookValue': '잘못된 hook 값',

  // 하단 터미널 셸
  'main.shell.unsupportedShell': '지원하지 않는 셸입니다',
  'main.shell.unsupportedOs': '이 운영체제에서는 지원하지 않습니다',
  'main.shell.noGitBash': 'Git Bash 를 찾지 못했습니다',
  'main.shell.unregisteredFolder': '코드 화면에 등록되지 않은 폴더입니다',

  // 다른 곳의 Claude Code 세션 보기 확인 창
  'main.hooks.title': '다른 곳의 Claude Code 세션 보기',
  'main.hooks.addButton': '추가',
  'main.hooks.removeButton': '제거',
  'main.hooks.addMessage': '사용자 설정에 hook 을 추가할까요?',
  'main.hooks.removeMessage': '사용자 설정에서 hook 을 제거할까요?',
  'main.hooks.addDetail': '{file} 에 이 앱의 hook {count}개를 추가합니다.\n\n• 기존 설정은 같은 폴더에 백업한 뒤 수정합니다.\n• VS Code·터미널 등 다른 곳에서 실행 중인 Claude Code 도 이 앱으로 이벤트를 보냅니다.\n• 앱이 꺼져 있으면 이벤트는 무시되고 Claude 작업에는 영향이 없습니다.\n• 이미 실행 중인 세션은 다시 시작해야 반영될 수 있습니다.',
  'main.hooks.removeDetail': '{file} 에서 이 앱이 추가한 hook 만 제거합니다. 다른 설정은 그대로 둡니다.',

  // 종료·트레이
  'main.quit.button': '종료',
  'main.quit.title': 'Agent Office 종료',
  'main.quit.message': '실행 중인 Claude Code·Codex 세션 {running}개가 함께 종료됩니다. 종료할까요?',
  'main.tray.open': 'Agent Office 열기',
  'main.tray.quit': '종료',

  // 펫 가져오기
  'main.pets.busy': '이미 가져오는 중입니다',
  'main.pets.zipTitle': '펫 zip 선택 (여러 개 가능)',
  'main.pets.zipFilter': '펫 zip',
  'main.pets.folderTitle': '펫 폴더 선택 (여러 개 가능)',
  'main.pets.tooMany': '한 번에 {max}개까지 가져올 수 있습니다',
};
