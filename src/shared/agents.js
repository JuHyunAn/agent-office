// AI 종류 정의 — 메인(require)·화면(import)이 함께 쓴다.
// 규칙: 순수 데이터와 작은 함수만 둔다. import 금지, DOM·Node API 금지, 최상위 await·import.meta 금지 (메인이 require(esm) 로 읽는다).
// 표시 이름은 Gemini, CLI 는 Antigravity CLI(agy), 내부 id 는 antigravity (hook 주소·펫 폴더·설정 키는 id 그대로).
// 새 AI 는 여기 항목과 main/agentCli.cjs 의 ADAPTERS(CLI 찾기·버전·로그인 상태·로그인/탭 인자 — 공식 문서 + 로컬 실측)를 함께 추가한다.
// 사무실 hook(모든 AI 열림, D-061): Claude·Codex·Muse 는 세션 단위 주입(Muse 는 museCli.cjs 의 -c hooks.<이벤트>), 세션 주입이 안 되는 Grok·Antigravity 는 앱이 공식 위치를 자동 관리(grokHooks.cjs 전용 파일 · agyHooks.cjs 공용 hooks.json 의 이름 항목).
// 아직 Claude·Codex 두 값으로 닫혀 있는 곳 (계획 .omc/plans/multi-agent-plan.md):
//   app.js 의 Codex 탭 세션 교체(tab.kind === 'codex')·이어받기/「다른 세션 보기」의 'claude' 직접 비교,
//   협업 Moderator.canSteer(claude·codex 고정 — 새 AI 는 그 단계에서 caps 로).
// 사용량 칸은 모든 AI 에 열려 있다: petRules.sanitizeUsage·usage.cjs 가 AGENT_IDS 기준이라 새 AI 는 자기 칸의 출처만 usage.cjs 에 더하면 된다.
// 펫·사무실 그림(0D)은 열려 있다: 펫 종류 = AGENT_IDS, 사무실 색은 themes/pixel-office/agent-looks.js (없으면 color 에서 만든다).
// 협업(0C)에서 새 AI 추가 시 채울 곳: main.cjs COLLAB_CHATS(협업 실행기 표) · collabRules.cjs AGENT_RULES·JOIN(AI 별 추가 규칙) ·
//   main.cjs collabModels(모델 목록 조회, 결과 모양 {claude, codex, grok, antigravity, errors} — Muse 는 조회 없이 moderator.js 의 고정 선택지) · moderator.js AUTO_MODELS(자동 모델 표)·MODEL_OPTIONS(기본 선택지). caps.collab 과 COLLAB_CHATS 는 함께 추가한다.
// color: 목록 점·칸 색 · install: 설치(cmd = Windows 공식 PowerShell 설치 명령 — 진입 화면 「설치」 버튼이 그대로 실행, url = 공식 설치 문서) · caps.externalSessions: 다른 곳(VS Code·터미널) 세션을 전역 hook 으로 받아 이어받을 수 있는지 ·
// collabLabel: 협업 규칙 문장에 쓰는 참여자 표기 · caps.collab: 협업 실행기(main.cjs COLLAB_CHATS)가 있는지.
export const AGENTS = Object.freeze([
  Object.freeze({
    id: 'claude', name: 'Claude', product: 'Claude Code', tabPrefix: '', color: '#d97757', collabLabel: 'Claude(Claude Code)',
    install: Object.freeze({ cmd: 'irm https://claude.ai/install.ps1 | iex', url: 'https://code.claude.com/docs/en/setup' }),
    caps: Object.freeze({ externalSessions: true, collab: true }),
  }),
  Object.freeze({
    id: 'codex', name: 'Codex', product: 'Codex', tabPrefix: 'Codex · ', color: '#6fa3c9', collabLabel: 'Codex(OpenAI Codex)',
    install: Object.freeze({ cmd: 'irm https://chatgpt.com/codex/install.ps1 | iex', url: 'https://developers.openai.com/codex/cli' }),
    caps: Object.freeze({ externalSessions: false, collab: true }),
  }),
  Object.freeze({
    id: 'grok', name: 'Grok', product: 'Grok Build', tabPrefix: 'Grok · ', color: '#7d8794', collabLabel: 'Grok(xAI Grok Build)',
    install: Object.freeze({ cmd: 'irm https://x.ai/cli/install.ps1 | iex', url: 'https://docs.x.ai/build' }),
    caps: Object.freeze({ externalSessions: false, collab: true }),
  }),
  Object.freeze({
    id: 'muse', name: 'Muse', product: 'Muse Code', tabPrefix: 'Muse · ', color: '#8a6bd8', collabLabel: 'Muse(Meta Muse Code)',
    install: Object.freeze({ cmd: 'irm https://dev.meta.ai/install.ps1 | iex', url: 'https://dev.meta.ai/docs/muse-code' }),
    caps: Object.freeze({ externalSessions: false, collab: true }),
  }),
  Object.freeze({
    id: 'antigravity', name: 'Gemini', product: 'Gemini (Antigravity CLI)', tabPrefix: 'Gemini · ', color: '#3f9f78', collabLabel: 'Gemini(Google Antigravity CLI)',
    install: Object.freeze({ cmd: 'irm https://antigravity.google/cli/install.ps1 | iex', url: 'https://antigravity.google/docs/getting-started?tab=cli' }),
    caps: Object.freeze({ externalSessions: false, collab: true }),
  }),
]);
export const DEFAULT_AGENT = 'claude'; // 알 수 없는 값은 지금처럼 Claude 로 본다
export function makeRegistry(list = AGENTS) {
  const byId = new Map(list.map((a) => [a.id, a]));
  if (!byId.has(DEFAULT_AGENT)) throw new Error(`AI 종류 목록에 기본값(${DEFAULT_AGENT})이 없습니다`); // norm·name 이 기본값으로 돌아갈 곳이 있어야 한다
  return Object.freeze({
    list,
    ids: Object.freeze(list.map((a) => a.id)),
    get: (id) => byId.get(id) || null,
    has: (id) => byId.has(id),
    norm: (id) => (byId.has(id) ? id : DEFAULT_AGENT), // hook·세션의 cli 값 정규화
    name: (id) => (byId.get(id) || byId.get(DEFAULT_AGENT)).name,
  });
}
export const registry = makeRegistry();
export const AGENT_IDS = registry.ids;
export const normAgent = registry.norm;
export const agentName = registry.name;
export const agentById = registry.get;
