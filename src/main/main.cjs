'use strict';

// IDE 안에서 실행하면 ELECTRON_RUN_AS_NODE=1 이 따라와 Electron 이 Node 로 뜬다 (scripts/start.mjs 도 지운다).
delete process.env.ELECTRON_RUN_AS_NODE;

const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, Tray, Menu, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { startHookServer } = require('./hookServer.cjs');
const hookSettings = require('./hookSettings.cjs');
const grokHooks = require('./grokHooks.cjs');
const agyHooks = require('./agyHooks.cjs');
const claudeCli = require('./claudeCli.cjs');
const codexCli = require('./codexCli.cjs');
const agentCli = require('./agentCli.cjs');
const museCli = require('./museCli.cjs');
const { ClaudeChat, CodexChat, GrokChat, MuseChat, AgyChat, claudeModels, killTree, cleanStalePromptFiles } = require('./collabAgents.cjs');
const { trackGrokSession, trackGrokTab, attachGrokRoom, dropGrokRoom } = require('./grokTools.cjs');
const { PtyManager } = require('./ptyManager.cjs');
const { cleanEnv } = require('./env.cjs');
const { createWeatherService } = require('./weather.cjs');
const { createPetController } = require('./pet.cjs');
const { PET_KINDS, PET_ID_RE } = require('./petRules.cjs');
const petImport = require('./petImport.cjs');
const { createMainGuard } = require('./ipcGuard.cjs');
const { createUsageService, createUsageLocator } = require('./usage.cjs');
const { createCodeRoots, createCodeService, registerCodeIpc } = require('./codeRepo.cjs');
const { createCodeAnalyzer, registerAnalysisIpc, DENY_SETTINGS: ANALYSIS_SETTINGS } = require('./codeAnalysis.cjs');
const { statusSnapshot } = require('./statusShape.cjs');
const { createModelCatalog } = require('./modelCatalog.cjs');
const { normAgent, agentById, agentName, AGENT_IDS } = require('../shared/agents.js');
const { collabRules } = require('./collabRules.cjs');
const getWeather = createWeatherService();
// 점검 실행은 사용자 데이터(최근 폴더·설정)를 건드리지 않도록 별도 폴더를 쓸 수 있다.
if (process.env.AGENT_OFFICE_USER_DATA) app.setPath('userData', process.env.AGENT_OFFICE_USER_DATA);

const ROOT = path.resolve(__dirname, '..', '..');
const ICON = path.join(ROOT, 'icon', 'app.ico');
const DEFAULT_PORT = 47821;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAB_RE = /^[a-z0-9-]{1,40}$/;
// 로그인 탭이 실행하는 공식 로그인 명령 (Claude·Codex 만 — 그 밖의 AI 는 agentCli.cjs 의 ADAPTERS.loginArgs, 전용 명령이 없으면 CLI 를 그냥 실행한다).
const LOGIN_ARGS = { claude: ['auth', 'login'], codex: ['login'] };

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let win = null;
let tray = null;
let pet = null; // 바탕화면 펫 (whenReady 에서 만든다)
let usage = null; // 사용량 서비스 (whenReady 에서 만든다)
let rendererReady = false; // 메인 화면이 다 불러와져 hook 이벤트·펫 상태를 받을 수 있는지 (권한 요청을 붙잡아도 되는 조건)
let quitting = false; // 트레이 「종료」·app.quit() 때만 창을 실제로 닫는다
let hook = null;
let config = null;
const locs = new Map(); // AI 종류 → CLI 위치 (src/shared/agents.js 의 id)
const loc = (id) => locs.get(id) || null;
// CLI 위치를 기억한다. 위치가 없다가 새로 찾아지면(예: 앱 안 설치 직후) 「미설치」로 굳은 모델 목록 조회를 다시 하도록 그 AI 캐시를 지운다.
// reset: false 는 모델 목록 조회 자신이 위치를 찾을 때 — 진행 중인 자기 조회 결과를 버리지 않게.
function setLoc(id, value, { reset = true } = {}) {
  const had = !!loc(id);
  locs.set(id, value);
  if (reset && !had && value) collabModels.reset(id);
}
let sessionSettingsPath = null;
let codeAnalyzer = null; // 코드 분석 실행기 (whenReady 에서 만든다)
const grokRooms = new Map(); // Grok 세션 ID → 협업 방 ID 또는 앱 탭 ID (Grok hook 은 탭 ID 를 실을 수 없어 session_id 로만 찾는다)
const rooms = new Map(); // 협업 대화 탭 → { cwd, gen, roster: 참여 AI id 배열, [AI id]: ClaudeChat | CodexChat }
// 협업 대화 규칙 문장은 collabRules.cjs 가 참여자(roster)로 만든다 (cmd.exe 경유 실행에서도 깨지지 않도록 따옴표·% 기호·줄바꿈을 쓰지 않는다).
const DEFAULT_ROSTER = ['claude', 'codex'];

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const ptys = new PtyManager({
  onData: (tabId, data) => send('pty:data', { tabId, data }),
  onExit: (tabId, exitCode) => { dropGrokRoom(grokRooms, tabId); send('pty:exit', { tabId, exitCode }); },
});

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { /* 첫 실행 */ }
  if (!cfg.token) cfg.token = crypto.randomBytes(16).toString('hex');
  if (!cfg.port) cfg.port = DEFAULT_PORT;
  saveConfig(cfg);
  return cfg;
}

// node 가 PATH 에 있는지. 상태 표시줄 중계는 node 로 실행하므로 없으면 쓰지 않는다 (사용자 표시줄 보존이 우선).
// Claude 는 앱이 넘긴 환경(= 이 PATH)에서 상태 표시줄 명령을 셸로 실행하므로, 여기서 찾아지면 명령의 「node」 도 찾아진다.
async function hasNode() {
  const r = await claudeCli.run(process.platform === 'win32' ? 'where' : 'which', ['node']);
  return r.stdout.split(/\r?\n/).some((p) => p.trim() && /(^|[\\/])node(\.exe)?$/i.test(p.trim()) && fs.existsSync(p.trim()));
}

// 사용자 상태 표시줄의 padding·refreshInterval 만 이어받는다 (읽기만 한다 — 사용자 설정 파일은 고치지 않는다).
function userStatusLineLayout() {
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const u = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).statusLine || {};
    const out = {};
    for (const k of ['padding', 'refreshInterval']) if (typeof u[k] === 'number') out[k] = u[k];
    return out;
  } catch { return {}; }
}

// 앱 탭에서만 쓰는 상태 표시줄 중계: Claude 가 상태 표시줄에 넘기는 사용량을 앱이 받고, 사용자 표시줄(OMC HUD 등)은 중계가 대신 실행해 그대로 보여 준다.
// 복사 위치(userData)는 어떤 셸에서도 따옴표 안에서 그대로 읽히는 글자만 있을 때 쓴다. 반환: 명령줄 (슬래시 경로).
// bashPath: 중계가 사용자 표시줄을 실행할 Git Bash (시작 때 한 번 찾아 relay.json 에 넣는다 — 중계가 매번 찾지 않게). 없으면 중계가 PowerShell 로 실행한다.
function relayStatusLine(bashPath) {
  const dir = app.getPath('userData');
  const relay = path.join(dir, 'statusline-relay.cjs').replace(/\\/g, '/');
  if (/["'`$!%^&|<>]/.test(relay)) throw new Error(`경로에 셸 특수문자가 있습니다: ${relay}`);
  fs.writeFileSync(relay, fs.readFileSync(path.join(__dirname, 'statusline-relay.cjs')));
  fs.writeFileSync(path.join(dir, 'relay.json'), JSON.stringify({ port: hook.port, token: config.token, ...(bashPath ? { bashPath } : {}) }));
  return `node "${relay}"`;
}

async function writeSessionSettings() {
  sessionSettingsPath = path.join(app.getPath('userData'), 'session-hooks.json');
  let extra;
  try {
    // Claude 의 statusLine 설정은 command 한 줄(+ padding·refreshInterval)뿐이라 인자는 명령줄에 함께 적는다 (2.1.312 실측 — args 키는 무시된다).
    if (await hasNode()) {
      const bashPath = process.platform === 'win32' ? await claudeCli.findGitBash() : null;
      extra = { statusLine: { type: 'command', command: relayStatusLine(bashPath), ...userStatusLineLayout() } };
    }
  } catch (e) {
    console.warn('[usage] 상태 표시줄 중계를 준비하지 못했습니다 (사용자 표시줄 그대로 둡니다)', e.message);
  }
  fs.writeFileSync(sessionSettingsPath, JSON.stringify(hookSettings.sessionSettings(hook.port, config.token, extra), null, 2));
}

async function status() {
  // Claude·Codex·그 밖의 AI 를 병렬로 확인한다 — 한 쪽 실패가 전체를 막지 않는다.
  const others = AGENT_IDS.filter((id) => agentCli.has(id));
  const [cl, cx, ...rest] = await Promise.all([
    (async () => {
      setLoc('claude', await claudeCli.locate());
      const version = loc('claude') ? await claudeCli.version(loc('claude')) : null;
      const auth = loc('claude') ? await claudeCli.authStatus(loc('claude')) : { loggedIn: false };
      return { version, auth };
    })(),
    (async () => {
      setLoc('codex', await codexCli.locate());
      if (!loc('codex')) return {};
      const [version, auth] = await Promise.all([codexCli.version(loc('codex')), codexCli.authStatus(loc('codex'), { appVersion: app.getVersion() })]);
      return { version, auth };
    })().catch((e) => ({ auth: { loggedIn: false, error: `Codex 상태를 확인하지 못했습니다: ${String(e?.message || e).slice(0, 120)}` } })),
    ...others.map((id) => (async () => {
      setLoc(id, await agentCli.locate(id)); // 새로 찾으면(예: 앱 안 설치 직후) 「미설치」로 굳은 모델 목록 조회를 다시 한다
      if (!loc(id)) return {};
      const [version, auth] = await Promise.all([agentCli.version(loc(id)), agentCli.authStatus(id, loc(id))]);
      return { version, auth };
    })().catch((e) => ({ auth: { loggedIn: false, error: `${agentName(id)} 상태를 확인하지 못했습니다: ${String(e?.message || e).slice(0, 120)}` } }))),
  ]);
  const { version, auth } = cl;
  if (auth.loggedIn || loc('codex')) collabModels(); // 협업 탭을 열기 전에 미리 받아 둔다 (Claude 쪽은 5초 안팎 걸림)
  pet?.refresh(); // Codex 를 찾았는지에 따라 Codex 펫 표시가 달라진다
  return {
    // 옛 키(claude·codex·auth·codexAuth)와 agents 는 같은 값에서 만든다 (statusShape.cjs). 옛 키는 다른 점검 스크립트가 agents 로 옮겨 간 뒤 정리한다.
    ...statusSnapshot({
      claude: { loc: loc('claude'), version, auth },
      codex: { loc: loc('codex'), version: cx.version, auth: cx.auth },
      ...Object.fromEntries(others.map((id, i) => [id, { loc: loc(id), version: rest[i].version, auth: rest[i].auth }])),
    }),
    hook: { port: hook.port, global: hookSettings.readGlobalStatus(hook.port, config.token) },
    hooks: { grok: grokHooks.status(hook.port, config.token), ...(agyHookError ? { agy: { error: agyHookError } } : {}) },
    pet: { mode: pet ? pet.mode() : 'always' },
  };
}

function checkFolder(cwd) {
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`폴더가 없습니다: ${cwd}`);
}

// 작업 폴더 선택 대화상자 — 탭 열기(dialog:pickFolder)와 코드 화면(code:pick)이 함께 쓴다. 취소하면 null.
async function pickFolder() {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '작업 폴더 선택' });
  return r.canceled ? null : r.filePaths[0];
}

// 코드 화면이 볼 수 있는 폴더 (렌더러가 탭을 열 때 code:allow, 「폴더 열기…」로 고르면 code:pick 이 등록)
const codeRoots = createCodeRoots();

async function needCodex(opts) {
  // Codex 앱이 업데이트되면 CLI 폴더가 바뀐다 — 기억한 경로가 사라졌으면 다시 찾는다.
  if (!loc('codex') || (!loc('codex').cmdShim && !fs.existsSync(loc('codex').file))) setLoc('codex', await codexCli.locate(), opts);
  if (!loc('codex')) throw new Error('Codex 를 찾지 못했습니다 (Codex 앱 또는 npm install -g @openai/codex)');
  return loc('codex');
}

// Muse 런처는 업데이트하며 옛 muse-bin-*.exe 를 지운다 — 기억한 경로가 사라졌으면 다시 찾는다. shim(cmd 경유)만 기억한 경우도 다시 찾는다 (그 뒤 실행 파일이 생겼을 수 있다).
// 탭·협업을 만드는 중에는 런처(version)를 부르지 않는다 (status() 에서만).
async function needMuse() {
  const l = loc('muse');
  if (!l || l.cmdShim || !fs.existsSync(l.file)) setLoc('muse', await agentCli.locate('muse'));
  if (!loc('muse')) throw new Error('Muse Code 를 찾지 못했습니다');
  return loc('muse');
}

// Codex 탭: 공식 codex 화면을 그대로 띄우고, 사무실 표시용 hook 만 실행 인자로 넣는다.
async function createCodexPty({ tabId, cwd, cols, rows }) {
  await needCodex();
  checkFolder(cwd);
  const args = codexCli.tabArgs({ hooks: codexCli.hookArgs({ port: hook.port, token: config.token, tab: tabId }) });
  const cmd = claudeCli.commandFor(loc('codex'), args);
  ptys.create({ tabId, cwd, cols, rows, file: cmd.file, args: cmd.args, env: cleanEnv() });
  return { sessionId: null };
}

// 협업 실행기 표: AI id → 실행기를 찾아 만드는 함수. caps.collab 과 COLLAB_CHATS 는 함께 추가한다.
// 생성자는 프로세스를 띄우지 않아야 한다 (첫 send 에서 실행 — 만들다 실패해도 정리할 것이 없게).
const COLLAB_CHATS = {
  claude: async ({ room, roomId, onEvent }) => {
    if (!loc('claude')) setLoc('claude', await claudeCli.locate());
    if (!loc('claude')) throw new Error('Claude Code 를 찾지 못했습니다');
    return new ClaudeChat({ loc: loc('claude'), cwd: room.cwd, settingsPath: sessionSettingsPath, systemPrompt: collabRules(room.roster, 'claude'), env: cleanEnv({ AGENT_OFFICE_TAB: roomId }), onEvent });
  },
  codex: async ({ room, roomId, onEvent }) => {
    await needCodex();
    return new CodexChat({ loc: loc('codex'), cwd: room.cwd, systemPrompt: collabRules(room.roster, 'codex'), hooks: codexCli.hookArgs({ port: hook.port, token: config.token, tab: roomId }), env: cleanEnv(), onEvent });
  },
  grok: async ({ room, roomId, onEvent }) => {
    if (!loc('grok')) setLoc('grok', await agentCli.locate('grok'));
    if (!loc('grok')) throw new Error('Grok Build 를 찾지 못했습니다');
    ensureGrokHooks();
    return new GrokChat({ loc: loc('grok'), cwd: room.cwd, systemPrompt: collabRules(room.roster, 'grok'), env: cleanEnv(), onEvent: (ev) => { trackGrokSession(grokRooms, roomId, ev); onEvent(ev); } });
  },
  // Muse 는 hook 주소의 tab 이 방 ID 라 Grok 처럼 세션 → 방 매핑 표가 필요 없다 (museCli.hookArgs).
  muse: async ({ room, roomId, onEvent }) => {
    await needMuse();
    return new MuseChat({ loc: loc('muse'), cwd: room.cwd, systemPrompt: collabRules(room.roster, 'muse'), env: cleanEnv(), hooks: museCli.hookArgs({ port: hook.port, token: config.token, tab: roomId }), onEvent });
  },
  // Antigravity: 공용 hook 명령의 %AGENT_OFFICE_TAB% 가 방 ID 로 치환되어 사무실 캐릭터가 방에 붙는다 (Grok 같은 매핑 표 불필요).
  // 로그인 전에는 agy -p 가 로그인을 60초 기다리므로, 실행기를 만들 때(방마다 한 번) 로그인 여부부터 확인한다.
  antigravity: async ({ room, roomId, onEvent }) => {
    if (!loc('antigravity')) setLoc('antigravity', await agentCli.locate('antigravity'));
    if (!loc('antigravity')) throw new Error('Antigravity CLI 를 찾지 못했습니다');
    const auth = await agentCli.authStatus('antigravity', loc('antigravity'), { timeoutMs: 15000 });
    if (auth.timedOut) throw new Error('Gemini 로그인 상태를 확인하지 못했습니다 (시간 초과)'); // 로그인 필요와는 다른 문제 — 잠시 뒤 다시 시도하면 된다
    if (!auth.loggedIn) throw new Error(auth.error || 'Gemini 로그인이 필요합니다 (진입 화면에서 로그인)');
    ensureAgyHooks();
    return new AgyChat({ loc: loc('antigravity'), cwd: room.cwd, systemPrompt: collabRules(room.roster, 'antigravity'), env: cleanEnv({ AGENT_OFFICE_TAB: roomId }), onEvent, onUsage: (u) => usage?.addTurnUsage('antigravity', u) });
  },
};

// 사용량 서비스가 쓰는 CLI 위치: 기억한 실행 파일이 있으면 그대로, 없거나 지워졌으면 다시 찾는다 (미설치 결과는 5분 기억 — usage.cjs).
const locateForUsage = createUsageLocator({ get: loc, set: (id, value) => setLoc(id, value), locate: (id) => agentCli.locate(id), exists: (file) => fs.existsSync(file) });

// 새 방의 참여자: 없으면 기본(Claude·Codex), 있으면 2명 이상·중복 없음·협업 실행기가 있는 AI 만 허용한다 (잘못된 값은 오류).
function validRoster(roster) {
  if (roster == null) return [...DEFAULT_ROSTER];
  const ok = Array.isArray(roster) && roster.length >= 2 && new Set(roster).size === roster.length
    && roster.every((id) => typeof id === 'string' && agentById(id)?.caps?.collab === true && Object.hasOwn(COLLAB_CHATS, id));
  if (!ok) throw new Error('잘못된 협업 참여자');
  return [...roster];
}

async function collabSend({ roomId, agent, cwd, text, model, effort, turn, roster }) {
  if (!TAB_RE.test(String(roomId))) throw new Error('잘못된 탭 ID');
  if (!Object.hasOwn(COLLAB_CHATS, agent)) throw new Error('잘못된 참여자');
  let room = rooms.get(roomId);
  if (!room) {
    const members = validRoster(roster); // 이미 있는 방은 처음 정한 참여자를 유지한다
    if (!members.includes(agent)) throw new Error('잘못된 참여자');
    checkFolder(cwd); room = { cwd, gen: 0, roster: members }; rooms.set(roomId, room);
  }
  if (!room.roster.includes(agent)) throw new Error('잘못된 참여자');
  const gen = room.gen;
  if (!room[agent]) {
    const onEvent = (ev) => send('collab:event', { roomId, agent, ...ev });
    const chat = await COLLAB_CHATS[agent]({ room, roomId, onEvent });
    // CLI 를 찾는 동안 중단·탭 닫기가 들어왔으면 실행하지 않는다 (아무도 보지 않는 Bypass 프로세스를 남기지 않게).
    if (rooms.get(roomId) !== room || room.gen !== gen) throw new Error('중단됨');
    room[agent] ||= chat;
  }
  room[agent].send(String(text), { model, effort }, Number.isInteger(turn) ? turn : null);
}

// 협업 대화의 모델·단계 선택지: 각 CLI 에서 직접 받아 AI 별로 앱 실행 중 한 번만 조회한다 (못 받은 AI 만 다음 호출에서 다시 시도 — modelCatalog.cjs).
const collabModels = createModelCatalog({
  claude: async () => {
    if (!loc('claude')) setLoc('claude', await claudeCli.locate(), { reset: false }); // 모델 목록 조회 자신이 찾는 경우 — 자기 조회를 버리지 않는다
    if (!loc('claude')) return { error: 'Claude Code 를 찾지 못했습니다' };
    const dir = app.getPath('userData');
    const noHooks = path.join(dir, 'model-list-settings.json'); // hook 을 꺼서 목록 조회가 사무실에 세션으로 잡히지 않게
    fs.writeFileSync(noHooks, JSON.stringify({ disableAllHooks: true }));
    let error = '';
    const list = await claudeModels({ loc: loc('claude'), settingsPath: noHooks, cwd: dir, env: cleanEnv(), onError: (r) => { error = r; } });
    return { list, error };
  },
  codex: async () => {
    const cx = await needCodex({ reset: false }).catch(() => null);
    if (!cx) return { error: 'Codex 를 찾지 못했습니다' };
    const list = await codexCli.models(cx);
    return { list, error: list?.length ? '' : 'codex debug models 응답을 읽지 못했습니다' };
  },
  // Muse 는 모델 목록 조회가 없다 — 키를 넣지 않으면 화면이 moderator.js 의 고정 선택지를 경고 없이 쓴다 (키가 있고 null 이면 「목록을 받지 못함」 경고가 뜬다).
  // `grok models` 출력에서 읽는다. 설치되지 않았으면 다시 조회하지 않는다 (선택 상자를 열 때마다 되풀이하지 않게).
  grok: async () => {
    if (!loc('grok')) setLoc('grok', await agentCli.locate('grok'), { reset: false });
    if (!loc('grok')) return { error: 'Grok Build 를 찾지 못했습니다', final: true };
    const r = await claudeCli.runClaude(loc('grok'), ['models'], 15000);
    const text = `${r.stdout || ''}\n${r.stderr || ''}`;
    if (/not authenticated/i.test(text)) return { error: 'Grok 로그인이 필요합니다' };
    const list = agentCli.parseGrokModels(r.stdout);
    return { list, error: list.length ? '' : 'grok models 응답을 읽지 못했습니다' };
  },
  // `agy models` 출력에서 읽는다 (미로그인이면 exit 1 + 「Please sign in」). 설치되지 않았으면 다시 조회하지 않는다.
  antigravity: async () => {
    if (!loc('antigravity')) setLoc('antigravity', await agentCli.locate('antigravity'), { reset: false });
    if (!loc('antigravity')) return { error: 'Antigravity CLI 를 찾지 못했습니다', final: true };
    const r = await claudeCli.runClaude(loc('antigravity'), ['models'], 15000);
    if (/please sign in/i.test(`${r.stdout || ''}\n${r.stderr || ''}`)) return { error: 'Gemini 로그인이 필요합니다' };
    const list = agentCli.parseAgyModels(r.stdout);
    return { list, error: list.length ? '' : 'Gemini 모델 목록을 받지 못했습니다' }; // 출력 해석 실패와 Gemini 없음을 한 문구로
  },
}, { onFail: (id, error) => console.warn(`[collab] ${id} 모델 목록 조회 실패`, error) });

function collabStop({ roomId, agent }) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.gen++;
  // agent 는 방 객체의 다른 키(cwd·gen·roster)와 섞이지 않게 실행기 표에 있는 값만 받는다.
  for (const a of agent ? (Object.hasOwn(COLLAB_CHATS, agent) ? [agent] : []) : AGENT_IDS) room[a]?.stop();
}

// 답변 중인 협업 AI 에 메시지를 넣는다 (Codex 는 안전 지점에서 끊고 이어 답함). 잘못된 입력은 throw 하지 않고 false — 화면이 다음 차례 전달로 대체한다.
function collabSteer({ roomId, agent, text, turn }) {
  if (!TAB_RE.test(String(roomId)) || !Object.hasOwn(COLLAB_CHATS, agent)) return false;
  const c = rooms.get(roomId)?.[agent];
  return !!c && c.steer(String(text || ''), Number.isInteger(turn) ? turn : null);
}

function collabClose({ roomId }) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.gen++;
  rooms.delete(roomId);
  dropGrokRoom(grokRooms, roomId);
  for (const a of AGENT_IDS) room[a]?.close();
}

// 화면을 새로 고치거나 화면 프로세스가 죽으면 탭과의 연결이 끊긴다 — 남은 세션을 모두 정리한다.
function dropSessions() {
  ptys.killAll();
  codeAnalyzer?.stopAll(); // 진행 중인 코드 분석(숨긴 claude)도 끝낸다
  for (const roomId of [...rooms.keys()]) collabClose({ roomId });
  grokRooms.clear(); // 남은 것은 닫힌 앱 탭의 연결
  hook?.releaseAll(); // 붙잡아 둔 권한 요청은 원래 터미널 승인으로 넘긴다
  pet?.clearState(); // 연결이 끊긴 탭의 「확인 필요」가 펫에 유령으로 남지 않게
  usage?.setFocus(null); // 사라진 탭을 가리키는 세션 줄도 비운다 (새 화면이 첫 포커스를 다시 알린다)
}

function collabRunning() {
  let n = 0;
  for (const room of rooms.values()) for (const a of AGENT_IDS) n += room[a]?.busy ? 1 : 0;
  return n;
}

async function createTabPty({ tabId, cwd, mode, resumeId, label, cols, rows, cli }) {
  if (!TAB_RE.test(String(tabId))) throw new Error('잘못된 탭 ID');
  if (mode === 'install') {
    // 설치: 레지스트리에 적힌 공식 설치 명령(PowerShell)을 홈 폴더에서 띄운다 — 화면이 보낸 문자열은 실행하지 않고 AI id 만 받는다. normAgent 는 모르는 값을 Claude 로 바꾸므로 쓰지 않는다.
    if (typeof cli !== 'string' || !AGENT_IDS.includes(cli)) throw new Error('알 수 없는 AI 입니다');
    const cmd = agentCli.installCommand(cli);
    if (!cmd) throw new Error('이 운영체제에서는 앱 안 설치를 지원하지 않습니다 — 설치 안내를 따라 주세요');
    ptys.create({ tabId, cwd: os.homedir(), cols, rows, file: cmd.file, args: cmd.args, env: cleanEnv(agentCli.INSTALL_ENV[cli] || {}) });
    return { sessionId: null };
  }
  if (mode === 'login') {
    // 로그인: 공식 로그인 명령(브라우저 로그인)을 홈 폴더에서 띄운다 — 세션이 아니므로 hook 설정 없이. 진입 화면('login')과 입장 뒤 로그인 탭이 같은 경로다.
    const id = normAgent(cli);
    if (id === 'codex') {
      await needCodex();
    } else if (id === 'claude') {
      if (!loc('claude')) setLoc('claude', await claudeCli.locate());
      if (!loc('claude')) throw new Error('Claude Code 를 찾지 못했습니다');
    } else if (id === 'muse') {
      await needMuse();
    } else if (agentCli.has(id)) {
      if (!loc(id)) setLoc(id, await agentCli.locate(id));
      if (!loc(id)) throw new Error(`${agentName(id)} 을(를) 찾지 못했습니다`);
    }
    const args = id === 'claude' || id === 'codex' ? LOGIN_ARGS[id] : agentCli.has(id) ? agentCli.loginArgs(id) : null;
    if (!args) throw new Error('로그인 명령을 알 수 없는 AI 입니다');
    const cmd = claudeCli.commandFor(loc(id), args);
    ptys.create({ tabId, cwd: os.homedir(), cols, rows, file: cmd.file, args: cmd.args, env: id === 'claude' || id === 'antigravity' ? cleanEnv({ AGENT_OFFICE_TAB: tabId }) : cleanEnv() }); // 로그인 화면의 agy 세션 hook 도 로그인 탭으로 걸러지게 탭 ID 를 싣는다
    return { sessionId: null };
  }
  if (agentCli.has(cli)) {
    // 새 AI 탭: 공식 CLI 화면을 그대로 띄운다. Grok 만 새 세션 ID 를 미리 정해 넘긴다 — 사무실 hook(앱 전용 파일)의 session_id 로 탭을 찾는다.
    // Muse 는 세션 단위 hook 을 실행 인자로 넣는다 (주소의 tab 이 탭 ID — 설정 파일 무변경). cmd 경유 위치면 tabArgs 가 hook 을 빼고 탭만 연다.
    if (cli === 'muse') {
      await needMuse();
    } else {
      if (!loc(cli)) setLoc(cli, await agentCli.locate(cli));
      if (!loc(cli)) throw new Error(`${agentName(cli)} 을(를) 찾지 못했습니다`);
    }
    checkFolder(cwd);
    // 세션 단위로 hook 을 넣을 수 없는 Grok·Antigravity 는 공식 위치의 앱 전용 hook 을 자동으로 맞춘다 (확인 창 없음).
    if (cli === 'grok') ensureGrokHooks();
    if (cli === 'antigravity') ensureAgyHooks();
    const sessionId = cli === 'grok' ? crypto.randomUUID() : null;
    const tabOpts = cli === 'muse' ? { hook: { port: hook.port, token: config.token, tab: tabId }, cmdShim: !!loc('muse').cmdShim } : { sessionId };
    const cmd = claudeCli.commandFor(loc(cli), agentCli.tabArgs(cli, tabOpts));
    ptys.create({ tabId, cwd, cols, rows, file: cmd.file, args: cmd.args, env: cleanEnv({ AGENT_OFFICE_TAB: tabId }) });
    trackGrokTab(grokRooms, tabId, sessionId); // Grok 탭의 hook 이벤트에 탭 ID 를 붙이려고 (sessionId 가 없는 AI 는 무시)
    return { sessionId };
  }
  if (cli === 'codex') return createCodexPty({ tabId, cwd, cols, rows });
  if (!loc('claude')) setLoc('claude', await claudeCli.locate());
  if (!loc('claude')) throw new Error('Claude Code 를 찾지 못했습니다');
  checkFolder(cwd);

  let sessionId = null;
  if (mode === 'resume') {
    if (!UUID_RE.test(String(resumeId))) throw new Error('잘못된 세션 ID');
  } else {
    sessionId = crypto.randomUUID();
  }
  const args = claudeCli.tabArgs({ settingsPath: sessionSettingsPath, mode, resumeId, sessionId, label });
  const cmd = claudeCli.commandFor(loc('claude'), args);
  ptys.create({ tabId, cwd, cols, rows, file: cmd.file, args: cmd.args, env: cleanEnv({ AGENT_OFFICE_TAB: tabId }) });
  return { sessionId };
}

async function setGlobalHooks(enabled) {
  const file = hookSettings.globalSettingsPath();
  const detail = enabled
    ? `${file} 에 이 앱의 hook ${hookSettings.EVENTS.length}개를 추가합니다.\n\n`
      + '• 기존 설정은 같은 폴더에 백업한 뒤 수정합니다.\n'
      + '• VS Code·터미널 등 다른 곳에서 실행 중인 Claude Code 도 이 앱으로 이벤트를 보냅니다.\n'
      + '• 앱이 꺼져 있으면 이벤트는 무시되고 Claude 작업에는 영향이 없습니다.\n'
      + '• 이미 실행 중인 세션은 다시 시작해야 반영될 수 있습니다.'
    : `${file} 에서 이 앱이 추가한 hook 만 제거합니다. 다른 설정은 그대로 둡니다.`;
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: [enabled ? '추가' : '제거', '취소'],
    defaultId: 1,
    cancelId: 1,
    title: '다른 곳의 Claude Code 세션 보기',
    message: enabled ? '사용자 설정에 hook 을 추가할까요?' : '사용자 설정에서 hook 을 제거할까요?',
    detail,
  });
  if (r.response !== 0) return { cancelled: true, global: hookSettings.readGlobalStatus(hook.port, config.token) };
  const backup = enabled ? hookSettings.installGlobal(hook.port, config.token) : hookSettings.uninstallGlobal();
  return { cancelled: false, backup, global: hookSettings.readGlobalStatus(hook.port, config.token) };
}

// Grok·Antigravity 는 세션 단위로 hook 을 넣을 수 없어 공식 위치에 앱 전용 hook 을 둔다. 탭·협업을 만들 때 자동으로 맞춘다 (확인 창·켜기/끄기 없음).
// Grok: ~/.grok/hooks/agent-office.json 한 파일. 같은 이름의 남의 파일은 건드리지 않고 로그만 남긴다.
function ensureGrokHooks() {
  try {
    const s = grokHooks.status(hook.port, config.token);
    if (!s.installed || (s.ours && !s.current)) grokHooks.enable(hook.port, config.token);
    else if (!s.ours) console.warn('[grok] 같은 이름의 다른 hook 파일이 있어 건드리지 않습니다', grokHooks.filePath());
  } catch (e) {
    console.warn('[grok] hook 파일을 맞추지 못했습니다', e.message);
  }
}

// Antigravity: 공용 ~/.gemini/config/hooks.json 의 이름 항목 하나만 넣거나 바꾼다 (다른 키는 그대로, 처음 넣을 때 백업, 깨진 파일은 건드리지 않음 — agyHooks.enable).
// 맞추지 못하면(깨진 파일·남의 값 등) 오류를 기억해 status().hooks.agy 로 화면에 알린다.
let agyHookError = null;
function ensureAgyHooks() {
  try {
    const s = agyHooks.status(hook.port, config.token);
    if (!s.ours || !s.current) agyHooks.enable(hook.port, config.token);
    agyHookError = null;
  } catch (e) {
    agyHookError = String(e?.message || e).slice(0, 200);
    console.warn('[antigravity] hook 을 맞추지 못했습니다', e.message);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#17171c',
    title: 'Agent Office',
    icon: ICON, // 제목 표시줄·작업 표시줄 (개발 실행에도 같은 아이콘)
    autoHideMenuBar: true,
    show: !process.env.AGENT_OFFICE_SMOKE,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL('app://office/src/renderer/index.html');
  let loaded = false;
  rendererReady = false;
  win.webContents.on('did-finish-load', () => { loaded = true; rendererReady = true; });
  win.webContents.on('did-start-loading', () => { rendererReady = false; if (loaded) dropSessions(); });
  win.webContents.on('render-process-gone', () => { rendererReady = false; dropSessions(); });
  // 실수로 창을 닫아도 Claude 세션·사무실은 계속 돈다 — 창만 숨기고, 종료는 트레이 메뉴에서 한다.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  win.on('session-end', () => { quitting = true; }); // Windows 로그오프·종료는 막지 않는다
  win.on('closed', () => { win = null; pet?.shutdown(); });
  if (process.env.AGENT_OFFICE_SMOKE) runSmoke();
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function quitFromTray() {
  const running = ptys.count() + collabRunning();
  if (running) {
    const opts = {
      type: 'question',
      buttons: ['종료', '취소'],
      defaultId: 1,
      cancelId: 1,
      title: 'Agent Office 종료',
      message: `실행 중인 Claude Code·Codex 세션 ${running}개가 함께 종료됩니다. 종료할까요?`,
    };
    const r = win && win.isVisible() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    if (r.response !== 0) return;
  }
  app.quit();
}

function createTray() {
  tray = new Tray(ICON);
  tray.setToolTip('Agent Office');
  tray.setContextMenu(trayMenu());
  tray.on('click', showWindow);
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Agent Office 열기', click: showWindow },
    { type: 'separator' },
    ...(pet ? [...pet.menuItems(), { type: 'separator' }] : []),
    { label: '종료', click: () => { quitFromTray(); } },
  ]);
}

// 창을 띄우지 않고 실제 경로를 한 번 점검한다: 화면 로드 → 터미널에서 claude 실행 → hook 수신.
function runSmoke() {
  const report = { consoleErrors: [], loadError: null };
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 3) report.consoleErrors.push(e.message);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => { report.loadError = `${code} ${desc}`; });
  win.webContents.once('did-finish-load', async () => {
    try {
      await new Promise((r) => setTimeout(r, 4000));
      report.gate = await win.webContents.executeJavaScript("document.querySelector('#gate-body').innerText");
      report.xterm = await win.webContents.executeJavaScript('typeof window.Terminal + "/" + typeof window.FitAddon?.FitAddon');
      report.pty = await win.webContents.executeJavaScript(`new Promise(async (resolve) => {
        let out = '';
        const off = window.office.onPtyData(({ tabId, data }) => { if (tabId === 'smoke1') out += data; });
        try {
          const r = await window.office.createPty({ tabId: 'smoke1', cwd: ${JSON.stringify(os.tmpdir())}, mode: 'new', label: 'smoke', cols: 100, rows: 30 });
          setTimeout(async () => { off(); await window.office.killPty('smoke1'); resolve({ sessionId: r.sessionId, bytes: out.length, sample: out.replace(/\\x1b\\[[0-9;?]*[ -\\/]*[@-~]/g, '').replace(/\\s+/g, ' ').slice(0, 300) }); }, 8000);
        } catch (e) { resolve({ error: String(e.message || e) }); }
      })`);
      const body = JSON.stringify({ session_id: 'smoke-session', cwd: 'C:\\\\smoke', hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' });
      await fetch(`http://127.0.0.1:${hook.port}/hook?k=${config.token}&src=session`, { method: 'POST', body });
      await new Promise((r) => setTimeout(r, 500));
      report.headcount = await win.webContents.executeJavaScript("document.querySelector('#headcount').textContent");
      if (process.env.AGENT_OFFICE_SMOKE === 'collab') report.collab = await smokeCollab();
      // 창을 닫아도 앱·세션은 계속 돈다 (실제 종료는 트레이 메뉴).
      win.close();
      await new Promise((r) => setTimeout(r, 300));
      report.closeKeepsRunning = !!win && !win.isDestroyed();
      report.tray = !!tray && !tray.isDestroyed();
    } catch (e) {
      report.error = String(e && e.stack || e);
    }
    process.stdout.write(`SMOKE ${JSON.stringify(report)}\n`);
    app.quit();
  });
}

// AGENT_OFFICE_SMOKE=collab: 실제 화면에서 협업 대화(Claude·Codex 실제 호출)와 Codex 탭을 한 번 돌려 본다 (사용량 소량).
async function smokeCollab() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-collab-'));
  const js = (code) => win.webContents.executeJavaScript(code);
  const wait = async (code, ms) => { for (let t = 0; t < ms; t += 1000) { if (await js(code)) return true; await new Promise((r) => setTimeout(r, 1000)); } return false; };
  await js(`window.__hooks=[];window.office.onHookEvent(e=>window.__hooks.push({cli:e._cli,tab:e._tab,name:e.hook_event_name}));
    document.querySelector('#gate-body .btn.primary')?.click();localStorage.setItem('ao.recent',JSON.stringify([${JSON.stringify(dir)}]));`);
  await new Promise((r) => setTimeout(r, 1500));
  const open = (kind) => js(`(()=>{const d=document.querySelector('#newtab');if(!d.open)document.querySelector('#new-tab').click();
    document.querySelector('input[name=tab-kind][value=${kind}]').click();document.querySelector('#recent button').click();return document.querySelectorAll('.tab').length;})()`);
  // codexConnected: 새 탭에서 Codex 를 고를 수 있다 (설치되어 있고 로그인까지 확인됨)
  const out = { codexConnected: await js('!!document.querySelector("input[name=tab-kind][value=codex]:not(:disabled)")') };
  await open('collab');
  // 모델·단계 선택지를 각 CLI 에서 받아 왔는지 — 받아 온 새 단계(Low)로 실제 대화도 해 본다.
  const sels = `document.querySelectorAll('.pane:not([hidden]) .collab .collab-agent select')`;
  out.catalogLoaded = await wait(`(()=>{const s=${sels};return s[0].options.length>4&&s[2].options.length>3;})()`, 40000);
  out.catalog = await js(`[...${sels}].map(s=>[...s.options].map(o=>o.textContent).join(', '))`);
  out.catalogNote = await js(`document.querySelector('.pane:not([hidden]) .collab-catalog').textContent`);
  // 모델 선택 줄은 한 줄 · 오른쪽 영역은 손잡이로 넓히고(기본보다 좁게는 안 됨), 두 번 클릭하면 기본 너비.
  const rowLines = `(()=>{const r=document.querySelector('.pane:not([hidden]) .collab-models');const s=r.querySelector('select');return Math.round(r.getBoundingClientRect().height/s.getBoundingClientRect().height);})()`;
  const cliW = `Math.round(document.querySelector('.cli-pane').getBoundingClientRect().width)`;
  out.modelRowLines = await js(rowLines);
  const grip = await js(`(()=>{const r=document.querySelector('#cli-resizer').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
  const drag = async (dx) => {
    const ev = (type, x) => win.webContents.sendInputEvent({ type, x, y: grip.y, button: 'left', clickCount: 1 });
    ev('mouseDown', grip.x); for (let i = 1; i <= 5; i++) { ev('mouseMove', grip.x + Math.round(dx * i / 5)); await new Promise((r) => setTimeout(r, 30)); } ev('mouseUp', grip.x + dx);
    await new Promise((r) => setTimeout(r, 300));
  };
  out.cliWidthDefault = await js(cliW);
  await drag(250); out.cliWidthNarrower = await js(cliW);
  await drag(-400); out.cliWidthWider = await js(cliW); out.modelRowLinesWide = await js(rowLines);
  const wide = await win.webContents.capturePage();
  if (!wide.isEmpty()) { fs.mkdirSync(path.join(ROOT, 'output', 'design'), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'output', 'design', 'collab-wide.png'), wide.toPNG()); }
  const g2 = await js(`(()=>{const r=document.querySelector('#cli-resizer').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: g2.x, y: g2.y, button: 'left', clickCount: 2 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: g2.x, y: g2.y, button: 'left', clickCount: 2 });
  await new Promise((r) => setTimeout(r, 300));
  out.cliWidthReset = await js(cliW);
  await js(`(()=>{const p=document.querySelector('.pane:not([hidden]) .collab');
    p.querySelector('input[type=checkbox]').click();const sels=p.querySelectorAll('.collab-agent select');
    const pick=(s,v)=>{s.value=v;s.dispatchEvent(new Event('change'));};pick(sels[0],'sonnet');pick(sels[1],'low');pick(sels[3],'low');
    const t=p.querySelector('textarea');t.value='연결 점검입니다. 도구를 쓰지 말고 「확인」 한 단어로만 답하세요.';t.dispatchEvent(new Event('input',{bubbles:true}));p.querySelector('.collab-compose .collab-send').click();})()`);
  out.finished = await wait(`(()=>{const p=document.querySelector('.pane:not([hidden]) .collab');return p.querySelectorAll('.msg.from-claude:not(.streaming),.msg.from-codex:not(.streaming)').length>=2&&!p.querySelector('.msg.streaming');})()`, 240000);
  out.messages = await js(`[...document.querySelectorAll('.pane:not([hidden]) .collab .msg')].map(m=>m.querySelector('.msg-head').innerText.replace(/\\s+/g,' ')+' | '+m.querySelector('.msg-body').innerText.slice(0,80))`);
  out.status = await js(`document.querySelector('.pane:not([hidden]) .collab-status').textContent`);
  await new Promise((r) => setTimeout(r, 1500));
  // 답변 도중 중단 → 다시 보내기: 끝낸 프로세스의 늦은 출력이 새 턴에 섞이지 않고 같은 세션으로 이어 가는지.
  const say = (text, to) => js(`(()=>{const p=document.querySelector('.pane:not([hidden]) .collab');const s=p.querySelector('.collab-compose select');s.value='${to}';
    const t=p.querySelector('textarea');t.value=${JSON.stringify(text)};t.dispatchEvent(new Event('input',{bubbles:true}));p.querySelector('.collab-compose .collab-send').click();})()`);
  const claudeCount = `document.querySelectorAll('.pane:not([hidden]) .collab .msg.from-claude').length`;
  await say('도구 없이 「한국의 사계절」을 주제로 아주 긴 수필(2000단어 이상)을 써 주세요.', 'claude');
  out.streamingBeforeStop = await wait(`!!document.querySelector('.pane:not([hidden]) .collab .msg.from-claude.streaming .msg-body')?.innerText.length`, 60000);
  await js(`(()=>{const p=document.querySelector('.pane:not([hidden]) .collab');const t=p.querySelector('textarea');t.value='';t.dispatchEvent(new Event('input',{bubbles:true}));p.querySelector('.collab-compose .collab-send').click();})()`); // 진행 중·빈 입력 = 중단 버튼
  await wait(`document.querySelector('.pane:not([hidden]) .collab-status').classList.contains('stopped')`, 5000); // 화면 갱신은 프레임 단위
  out.stoppedStatus = await js(`document.querySelector('.pane:not([hidden]) .collab-status').textContent`);
  const before = await js(claudeCount);
  await say('방금 중단했습니다. 도구 없이 「재개」 한 단어로만 답하세요.', 'claude');
  out.resumed = await wait(`(()=>{const ms=[...document.querySelectorAll('.pane:not([hidden]) .collab .msg.from-claude')];const m=ms.at(-1);return ms.length===${before}+1&&!m.classList.contains('streaming');})()`, 180000);
  out.lastClaude = await js(`[...document.querySelectorAll('.pane:not([hidden]) .collab .msg.from-claude')].pop().querySelector('.msg-body').innerText.slice(0,80)`);
  out.feedLeaksRules = await js(`document.querySelector('#feed').innerText.includes('당신은 Agent Office')`);
  out.hooks = await js('window.__hooks.reduce((a,h)=>{const k=h.cli+":"+h.name;a[k]=(a[k]||0)+1;return a;},{})');
  out.headcount = await js("document.querySelector('#headcount').textContent");
  const img = await win.webContents.capturePage();
  if (!img.isEmpty()) { fs.mkdirSync(path.join(ROOT, 'output', 'design'), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'output', 'design', 'collab-chat.png'), img.toPNG()); }
  await open('codex');
  await new Promise((r) => setTimeout(r, 12000));
  out.codexTab = await js(`(document.querySelector('.pane:not([hidden]) .xterm-rows')?.innerText||'').replace(/\\s+/g,' ').slice(0,300)`);
  return out;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow); // 다시 실행하면 숨겨 둔 창을 연다

  app.whenReady().then(async () => {
    protocol.handle('app', (req) => {
      const { pathname } = new URL(req.url);
      const target = path.normalize(path.join(ROOT, decodeURIComponent(pathname)));
      if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return new Response('forbidden', { status: 403 });
      return net.fetch(pathToFileURL(target).toString());
    });

    config = loadConfig();
    usage = createUsageService({
      locateClaude: () => loc('claude'), locateCodex: () => loc('codex'), userDataDir: app.getPath('userData'), appVersion: app.getVersion(),
      // 그 밖의 AI: 아직 못 찾았거나 지워진 실행 파일이면 다시 찾는다 (Muse 런처는 업데이트하며 옛 실행 파일을 지운다). 설치되지 않았으면 null → 칸을 숨긴다.
      locateGrok: () => locateForUsage('grok'), locateMuse: () => locateForUsage('muse'), locateAntigravity: () => locateForUsage('antigravity'),
      runCli: (l, args, ms) => claudeCli.runClaude(l, args, ms),
      onChange: (s) => pet?.setUsage(s), smoke: !!process.env.AGENT_OFFICE_SMOKE,
    });
    hook = await startHookServer({
      port: config.port, token: config.token,
      onEvent: (ev, meta) => { attachGrokRoom(grokRooms, ev); send('hook:event', ev); usage?.onHookEvent(ev, meta); },
      onStatus: (payload, tab) => usage?.onStatus(payload, tab),
      // 펫 카드로 답할 수 있을 때만 앱 탭의 권한 요청을 붙잡는다 (pet 은 hook 서버보다 나중에 만들어진다).
      canHold: () => rendererReady && !!pet?.canAnswer(),
      onHeld: () => pet?.watchPermissions(),
      onClosed: (permId, how) => send('perm:closed', { permId, how }),
    });
    if (hook.port !== config.port) {
      // 대체 포트로 떴으면 그 포트를 기억한다 — 다음 실행과 사용자 설정 hook 이 같은 포트를 보게.
      config.port = hook.port;
      saveConfig(config);
    }
    await writeSessionSettings();
    cleanStalePromptFiles(); // 앱이 비정상 종료해 남은 협업 Grok·Muse 프롬프트 파일(1시간 넘은 것)을 지운다
    // 포트·토큰이 바뀌었으면 이미 있는 우리 Grok·Antigravity hook 만 조용히 다시 쓴다 (새로 만드는 것은 해당 AI 탭을 열 때).
    try {
      const g = grokHooks.status(hook.port, config.token);
      if (g.ours && !g.current) grokHooks.enable(hook.port, config.token);
    } catch (e) {
      console.warn('[grok] hook 파일을 다시 쓰지 못했습니다', e.message);
    }
    try {
      const a = agyHooks.status(hook.port, config.token);
      if (a.ours && !a.current) agyHooks.enable(hook.port, config.token);
    } catch (e) {
      agyHookError = String(e?.message || e).slice(0, 200);
      console.warn('[antigravity] hook 을 다시 쓰지 못했습니다', e.message);
    }

    // 메인 창 전용 채널은 보낸 쪽이 메인 창일 때만 처리한다 (펫 창 등 다른 화면의 요청은 무시·거부).
    const { handleMain, onMain } = createMainGuard(ipcMain, () => win);

    handleMain('app:status', () => status());
    // 활성 탭이 바뀔 때 메인 화면이 알린다 — 사용량 패널의 세션 줄이 이 탭을 기준으로 한다.
    onMain('pet:focus', (f) => {
      if (!f || typeof f !== 'object') return;
      usage?.setFocus({
        tabId: typeof f.tabId === 'string' && TAB_RE.test(f.tabId) ? f.tabId : null,
        kind: [...AGENT_IDS, 'collab'].includes(f.kind) ? f.kind : null,
        label: typeof f.label === 'string' ? f.label.slice(0, 60) : '',
      });
    });
    handleMain('weather:current', () => getWeather());
    handleMain('dialog:pickFolder', () => pickFolder());
    registerCodeIpc(handleMain, { roots: codeRoots, service: createCodeService({ roots: codeRoots }), pickFolder, checkFolder });
    // 코드 분석: 분석 대상 폴더의 설정이 아니라 이 설정 파일(hook 끄기·비밀 파일 읽기 거부)만 쓴다
    const analysisSettingsPath = path.join(app.getPath('userData'), 'analysis-settings.json');
    fs.writeFileSync(analysisSettingsPath, JSON.stringify(ANALYSIS_SETTINGS, null, 2));
    codeAnalyzer = createCodeAnalyzer({
      roots: codeRoots,
      locate: async () => { if (!loc('claude')) setLoc('claude', await claudeCli.locate()); return loc('claude'); },
      settingsPath: analysisSettingsPath,
      env: cleanEnv({ CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1', DISABLE_AUTOUPDATER: '1' }),
      spawn: require('node:child_process').spawn,
      kill: killTree,
    });
    registerAnalysisIpc(handleMain, { analyzer: codeAnalyzer });
    handleMain('pty:create', (opts) => createTabPty(opts || {}));
    onMain('pty:write', ({ tabId, data }) => ptys.write(tabId, data));
    onMain('pty:resize', ({ tabId, cols, rows }) => ptys.resize(tabId, cols, rows));
    handleMain('pty:kill', ({ tabId }) => { dropGrokRoom(grokRooms, tabId); return ptys.kill(tabId); });
    handleMain('hooks:global:set', ({ enabled }) => setGlobalHooks(!!enabled));
    handleMain('collab:send', (opts) => collabSend(opts || {}));
    handleMain('collab:stop', (opts) => collabStop(opts || {}));
    handleMain('collab:steer', (opts) => collabSteer(opts || {}));
    handleMain('collab:close', (opts) => collabClose(opts || {}));
    handleMain('collab:models', () => collabModels());
    handleMain('shell:open', (url) => { if (/^https?:\/\//.test(String(url))) shell.openExternal(url); });

    // 펫 그림 선택·가져오기·삭제 (메인 창 전용). 오류는 정해진 문구만 화면에 돌려주고 원문은 메인 로그에만 남긴다.
    const userPetsDir = () => path.join(app.getPath('userData'), 'pets');
    const emptyPets = { pets: [], selected: Object.fromEntries(AGENT_IDS.map((k) => [k, null])), resolved: Object.fromEntries(AGENT_IDS.map((k) => [k, 'none'])) };
    let petImporting = false;
    handleMain('pets:list', () => pet?.listPets() ?? emptyPets);
    handleMain('pets:preview', (key) => {
      const r = pet?.readPetByKey(key);
      return r ? { type: r.type, bytes: r.bytes } : null;
    });
    // zip·폴더 하나를 검사해 설치한다 — 실패해도 던지지 않고 이유를 돌려준다 (여러 개를 고르면 나머지는 계속).
    const importOnePet = async (kind, src) => {
      try {
        let prepared;
        if (kind === 'zip') {
          if (fs.statSync(src).size > petImport.MAX_ZIP_BYTES) return { error: petImport.ERR.zipBig };
          prepared = petImport.importZip(fs.readFileSync(src), path.basename(src, path.extname(src)));
        } else {
          prepared = petImport.importFolder(src);
        }
        if (prepared.error) {
          if (prepared.detail) console.error('[pets] 가져오기 검사 실패', src, prepared.detail);
          return { error: prepared.error };
        }
        const done = await petImport.installPet(prepared, userPetsDir());
        if (done.error) {
          if (done.detail) console.error('[pets] 설치 실패', src, done.detail);
          return { error: done.error };
        }
        return { ok: true, key: `user:${done.id}`, displayName: prepared.displayName };
      } catch (e) {
        console.error('[pets] 가져오기 실패', src, e);
        return { error: petImport.ERR.generic };
      }
    };
    const PET_IMPORT_MAX = 50; // 한 번에 고를 수 있는 개수 (지나치게 많이 골라 오래 멈추지 않게)
    handleMain('pets:import', async (kind) => {
      if (!pet || (kind !== 'zip' && kind !== 'folder')) return { error: petImport.ERR.generic };
      if (petImporting) return { error: '이미 가져오는 중입니다' };
      petImporting = true;
      try {
        const r = await dialog.showOpenDialog(win, kind === 'zip'
          ? { title: '펫 zip 선택 (여러 개 가능)', properties: ['openFile', 'multiSelections'], filters: [{ name: '펫 zip', extensions: ['zip'] }] }
          : { title: '펫 폴더 선택 (여러 개 가능)', properties: ['openDirectory', 'multiSelections'] });
        if (r.canceled || !r.filePaths.length) return { cancelled: true };
        if (r.filePaths.length > PET_IMPORT_MAX) return { error: `한 번에 ${PET_IMPORT_MAX}개까지 가져올 수 있습니다` };
        const results = [];
        for (const src of r.filePaths) results.push({ name: path.basename(src), ...(await importOnePet(kind, src)) }); // 차례로 — 같은 이름 -2 판정이 겹치지 않게
        if (results.some((x) => x.ok)) pet.refreshUserPets();
        return { results };
      } catch (e) {
        console.error('[pets] 가져오기 실패', e);
        return { error: petImport.ERR.generic };
      } finally {
        petImporting = false;
      }
    });
    handleMain('pets:remove', (key) => {
      const id = typeof key === 'string' && key.startsWith('user:') ? key.slice(5) : null;
      if (!pet || !id || !PET_ID_RE.test(id)) return { ok: false };
      const ok = petImport.removePet(userPetsDir(), id);
      pet.refreshUserPets();
      // 결과와 무관하게 목록에 없는 가져온 펫을 고른 종류는 기본으로 되돌린다
      const listed = new Set(pet.listPets().pets.map((p) => p.key));
      for (const kind of PET_KINDS) {
        const v = config.pet.sprites[kind];
        if (typeof v === 'string' && v.startsWith('user:') && !listed.has(v)) pet.selectPet(kind, null);
      }
      send('pets:changed', {});
      return { ok };
    });
    handleMain('pets:select', (p) => {
      const r = pet && p && typeof p === 'object' ? pet.selectPet(p.kind, p.value) : { ok: false };
      if (r.ok) send('pets:changed', {});
      return { ok: r.ok };
    });

    createTray();
    createWindow();
    pet = createPetController({
      ipcMain, screen, BrowserWindow, getMainWindow: () => win, showMainWindow: showWindow, sendMain: send, config, saveConfig,
      isCodexAvailable: () => !!loc('codex'), userDataDir: app.getPath('userData'),
      builtinPetsDir: path.join(ROOT, 'src', 'renderer', 'assets', 'pets'),
      onModeChanged: (mode) => { tray?.setContextMenu(trayMenu()); send('pet:mode', { mode }); },
      permissions: { pending: () => hook?.pending() ?? [], resolve: (id, d) => !!hook?.resolve(id, d), releaseAll: () => hook?.releaseAll() },
      onUsageRefresh: () => usage?.refresh({ manual: true }),
    });
    tray.setContextMenu(trayMenu());
    pet.refresh();
    pet.setUsage(usage.snapshot());
  }).catch((err) => {
    dialog.showErrorBox('Agent Office 시작 실패', String(err && err.stack || err));
    app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    usage?.dispose(); // 진행 중인 /usage 읽기(숨긴 claude)와 타이머를 정리한다
    dropSessions();
    pet?.shutdown(); // dropSessions 가 펫 상태를 지우는 뒤에 닫고, 이후 창을 다시 만들지 않는다
    hook?.releaseAll(); // 보류 중인 응답이 서버 종료를 막지 않게 먼저 {} 로 푼다
    hook?.server.closeAllConnections?.();
    if (hook) hook.server.close();
  });
  app.on('window-all-closed', () => app.quit());
}
