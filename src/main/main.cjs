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
const claudeCli = require('./claudeCli.cjs');
const codexCli = require('./codexCli.cjs');
const { ClaudeChat, CodexChat, claudeModels } = require('./collabAgents.cjs');
const { PtyManager } = require('./ptyManager.cjs');
const { cleanEnv } = require('./env.cjs');
const { createWeatherService } = require('./weather.cjs');
const { createPetController } = require('./pet.cjs');
const { PET_KINDS, PET_ID_RE } = require('./petRules.cjs');
const petImport = require('./petImport.cjs');
const { createMainGuard } = require('./ipcGuard.cjs');
const { createUsageService } = require('./usage.cjs');
const getWeather = createWeatherService();
// 점검 실행은 사용자 데이터(최근 폴더·설정)를 건드리지 않도록 별도 폴더를 쓸 수 있다.
if (process.env.AGENT_OFFICE_USER_DATA) app.setPath('userData', process.env.AGENT_OFFICE_USER_DATA);

const ROOT = path.resolve(__dirname, '..', '..');
const ICON = path.join(ROOT, 'icon', 'app.ico');
const DEFAULT_PORT = 47821;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAB_RE = /^[a-z0-9-]{1,40}$/;

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
let claude = null;
let codex = null;
let sessionSettingsPath = null;
const rooms = new Map(); // 협업 대화 탭 → { cwd, claude: ClaudeChat, codex: CodexChat }

// 협업 대화 규칙. cmd.exe 경유 실행에서도 깨지지 않도록 따옴표·% 기호·줄바꿈을 쓰지 않는다.
const COLLAB_RULES = [
  '당신은 Agent Office 의 협업 대화에 참여하고 있습니다. 참여자는 사용자, Claude(Claude Code), Codex(OpenAI Codex) 셋이며 같은 작업 폴더를 함께 씁니다.',
  '상대 AI 와 사용자의 발언은 [Claude] [Codex] [사용자] 표시와 함께 전달되고, 당신의 답변은 상대 AI 와 사용자 모두에게 보입니다.',
  '메시지 첫 줄의 구현 담당 지시를 따릅니다. 구현 담당이 아니면 파일을 수정하지 말고 설계·검토·의견만 냅니다.',
  '방향·범위·되돌리기 어려운 변경처럼 중요한 선택이 필요하면 진행을 멈추고, 답변 끝에 [질문] 으로 시작하는 줄을 두어 질문과 선택지를 적습니다. 사용자가 답할 때까지 대화가 멈춥니다.',
  '더 논의할 것이 없고 사용자 확인만 남았으면 마지막 줄에 [완료] 만 적습니다.',
  '상대의 말을 되풀이하지 말고 새 정보·반론·결정만 한국어로 간결하게 답합니다.',
];
const CLAUDE_RULES = [...COLLAB_RULES,
  '하위 에이전트를 적극 활용합니다. 어려운 추론·설계 검토는 model fable, 설계가 끝난 단순 코딩·주석·문법 수정은 model sonnet 에게 맡기고, 노력 단계는 high 또는 xhigh 만 씁니다.'].join(' ');
const CODEX_RULES = [...COLLAB_RULES,
  '하위 에이전트를 쓸 때 어려운 추론은 gpt-6-astra, 그 외는 gpt-6.1-sol 을 쓰고, 추론 단계는 high 또는 xhigh 만 씁니다.'].join('\n');

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const ptys = new PtyManager({
  onData: (tabId, data) => send('pty:data', { tabId, data }),
  onExit: (tabId, exitCode) => send('pty:exit', { tabId, exitCode }),
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
  claude = await claudeCli.locate();
  const version = claude ? await claudeCli.version(claude) : null;
  const auth = claude ? await claudeCli.authStatus(claude) : { loggedIn: false };
  codex = await codexCli.locate();
  const codexVersion = codex ? await codexCli.version(codex) : null;
  if (auth.loggedIn || codex) collabModels(); // 협업 탭을 열기 전에 미리 받아 둔다 (Claude 쪽은 5초 안팎 걸림)
  pet?.refresh(); // Codex 를 찾았는지에 따라 Codex 펫 표시가 달라진다
  return {
    claude: claude ? { path: claude.display, version } : null,
    codex: codex ? { path: codex.display, version: codexVersion } : null,
    auth,
    hook: { port: hook.port, global: hookSettings.readGlobalStatus(hook.port, config.token) },
    pet: { mode: pet ? pet.mode() : 'always' },
  };
}

function checkFolder(cwd) {
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`폴더가 없습니다: ${cwd}`);
}

async function needCodex() {
  // Codex 앱이 업데이트되면 CLI 폴더가 바뀐다 — 기억한 경로가 사라졌으면 다시 찾는다.
  if (!codex || (!codex.cmdShim && !fs.existsSync(codex.file))) codex = await codexCli.locate();
  if (!codex) throw new Error('Codex 를 찾지 못했습니다 (Codex 앱 또는 npm install -g @openai/codex)');
  return codex;
}

// Codex 탭: 공식 codex 화면을 그대로 띄우고, 사무실 표시용 hook 만 실행 인자로 넣는다.
async function createCodexPty({ tabId, cwd, cols, rows }) {
  await needCodex();
  checkFolder(cwd);
  const args = codexCli.tabArgs({ hooks: codexCli.hookArgs({ port: hook.port, token: config.token, tab: tabId }) });
  const cmd = claudeCli.commandFor(codex, args);
  ptys.create({ tabId, cwd, cols, rows, file: cmd.file, args: cmd.args, env: cleanEnv() });
  return { sessionId: null };
}

async function collabSend({ roomId, agent, cwd, text, model, effort, turn }) {
  if (!TAB_RE.test(String(roomId))) throw new Error('잘못된 탭 ID');
  if (agent !== 'claude' && agent !== 'codex') throw new Error('잘못된 참여자');
  let room = rooms.get(roomId);
  if (!room) { checkFolder(cwd); room = { cwd, gen: 0 }; rooms.set(roomId, room); }
  const gen = room.gen;
  if (!room[agent]) {
    const onEvent = (ev) => send('collab:event', { roomId, agent, ...ev });
    if (agent === 'claude') {
      if (!claude) claude = await claudeCli.locate();
      if (!claude) throw new Error('Claude Code 를 찾지 못했습니다');
    } else {
      await needCodex();
    }
    // CLI 를 찾는 동안 중단·탭 닫기가 들어왔으면 실행하지 않는다 (아무도 보지 않는 Bypass 프로세스를 남기지 않게).
    if (rooms.get(roomId) !== room || room.gen !== gen) throw new Error('중단됨');
    room[agent] ||= agent === 'claude'
      ? new ClaudeChat({ loc: claude, cwd: room.cwd, settingsPath: sessionSettingsPath, systemPrompt: CLAUDE_RULES, env: cleanEnv({ AGENT_OFFICE_TAB: roomId }), onEvent })
      : new CodexChat({ loc: codex, cwd: room.cwd, systemPrompt: CODEX_RULES, hooks: codexCli.hookArgs({ port: hook.port, token: config.token, tab: roomId }), env: cleanEnv(), onEvent });
  }
  room[agent].send(String(text), { model, effort }, Number.isInteger(turn) ? turn : null);
}

// 협업 대화의 모델·단계 선택지: 각 CLI 에서 직접 받아 앱 실행 중 한 번만 조회한다 (못 받은 쪽은 다음 탭에서 다시 시도).
let modelCatalog = null;
function collabModels() {
  modelCatalog ||= (async () => {
    const errors = {};
    let c = null; let x = null;
    try {
      if (!claude) claude = await claudeCli.locate();
      const cx = await needCodex().catch(() => null);
      const dir = app.getPath('userData');
      const noHooks = path.join(dir, 'model-list-settings.json'); // hook 을 꺼서 목록 조회가 사무실에 세션으로 잡히지 않게
      fs.writeFileSync(noHooks, JSON.stringify({ disableAllHooks: true }));
      [c, x] = await Promise.all([
        claude ? claudeModels({ loc: claude, settingsPath: noHooks, cwd: dir, env: cleanEnv(), onError: (r) => { errors.claude = r; } }) : null,
        cx ? codexCli.models(cx) : null,
      ]);
      if (!claude) errors.claude = 'Claude Code 를 찾지 못했습니다';
      if (!cx) errors.codex = 'Codex 를 찾지 못했습니다';
      else if (!x?.length) errors.codex = 'codex debug models 응답을 읽지 못했습니다';
    } catch (e) {
      errors.claude ||= e.message; errors.codex ||= e.message;
    }
    const result = { claude: c?.length ? c : null, codex: x?.length ? x : null, errors };
    if (!result.claude || !result.codex) { modelCatalog = null; console.warn('[collab] 모델 목록 조회 실패', errors); }
    return result;
  })();
  return modelCatalog;
}

function collabStop({ roomId, agent }) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.gen++;
  for (const a of agent ? [agent] : ['claude', 'codex']) room[a]?.stop();
}

function collabClose({ roomId }) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.gen++;
  rooms.delete(roomId);
  room.claude?.close(); room.codex?.close();
}

// 화면을 새로 고치거나 화면 프로세스가 죽으면 탭과의 연결이 끊긴다 — 남은 세션을 모두 정리한다.
function dropSessions() {
  ptys.killAll();
  for (const roomId of [...rooms.keys()]) collabClose({ roomId });
  hook?.releaseAll(); // 붙잡아 둔 권한 요청은 원래 터미널 승인으로 넘긴다
  pet?.clearState(); // 연결이 끊긴 탭의 「확인 필요」가 펫에 유령으로 남지 않게
  usage?.setFocus(null); // 사라진 탭을 가리키는 세션 줄도 비운다 (새 화면이 첫 포커스를 다시 알린다)
}

function collabRunning() {
  let n = 0;
  for (const room of rooms.values()) n += (room.claude?.busy ? 1 : 0) + (room.codex?.proc ? 1 : 0);
  return n;
}

async function createTabPty({ tabId, cwd, mode, resumeId, label, cols, rows, cli }) {
  if (!TAB_RE.test(String(tabId))) throw new Error('잘못된 탭 ID');
  if (cli === 'codex') return createCodexPty({ tabId, cwd, cols, rows });
  if (!claude) claude = await claudeCli.locate();
  if (!claude) throw new Error('Claude Code 를 찾지 못했습니다');
  if (mode === 'login' && !cwd) cwd = os.homedir();
  checkFolder(cwd);

  let args;
  let sessionId = null;
  if (mode === 'login') {
    args = ['auth', 'login'];
  } else {
    if (mode === 'resume') {
      if (!UUID_RE.test(String(resumeId))) throw new Error('잘못된 세션 ID');
    } else {
      sessionId = crypto.randomUUID();
    }
    args = claudeCli.tabArgs({ settingsPath: sessionSettingsPath, mode, resumeId, sessionId, label });
  }
  const cmd = claudeCli.commandFor(claude, args);
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
  const out = { codexFound: await js('!!document.querySelector("input[name=tab-kind][value=codex]:not(:disabled)")') };
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
    const t=p.querySelector('textarea');t.value='연결 점검입니다. 도구를 쓰지 말고 「확인」 한 단어로만 답하세요.';p.querySelector('.collab-compose .btn').click();})()`);
  out.finished = await wait(`(()=>{const p=document.querySelector('.pane:not([hidden]) .collab');return p.querySelectorAll('.msg.from-claude:not(.streaming),.msg.from-codex:not(.streaming)').length>=2&&!p.querySelector('.msg.streaming');})()`, 240000);
  out.messages = await js(`[...document.querySelectorAll('.pane:not([hidden]) .collab .msg')].map(m=>m.querySelector('.msg-head').innerText.replace(/\\s+/g,' ')+' | '+m.querySelector('.msg-body').innerText.slice(0,80))`);
  out.status = await js(`document.querySelector('.pane:not([hidden]) .collab-status').textContent`);
  await new Promise((r) => setTimeout(r, 1500));
  // 답변 도중 중단 → 다시 보내기: 끝낸 프로세스의 늦은 출력이 새 턴에 섞이지 않고 같은 세션으로 이어 가는지.
  const say = (text, to) => js(`(()=>{const p=document.querySelector('.pane:not([hidden]) .collab');const s=p.querySelector('.collab-compose select');s.value='${to}';
    p.querySelector('textarea').value=${JSON.stringify(text)};p.querySelector('.collab-compose .btn').click();})()`);
  const claudeCount = `document.querySelectorAll('.pane:not([hidden]) .collab .msg.from-claude').length`;
  await say('도구 없이 「한국의 사계절」을 주제로 아주 긴 수필(2000단어 이상)을 써 주세요.', 'claude');
  out.streamingBeforeStop = await wait(`!!document.querySelector('.pane:not([hidden]) .collab .msg.from-claude.streaming .msg-body')?.innerText.length`, 60000);
  await js(`document.querySelector('.pane:not([hidden]) .collab-stop').click()`);
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
      locateClaude: () => claude, locateCodex: () => codex, userDataDir: app.getPath('userData'), appVersion: app.getVersion(),
      onChange: (s) => pet?.setUsage(s), smoke: !!process.env.AGENT_OFFICE_SMOKE,
    });
    hook = await startHookServer({
      port: config.port, token: config.token,
      onEvent: (ev, meta) => { send('hook:event', ev); usage?.onHookEvent(ev, meta); },
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

    // 메인 창 전용 채널은 보낸 쪽이 메인 창일 때만 처리한다 (펫 창 등 다른 화면의 요청은 무시·거부).
    const { handleMain, onMain } = createMainGuard(ipcMain, () => win);

    handleMain('app:status', () => status());
    // 활성 탭이 바뀔 때 메인 화면이 알린다 — 사용량 패널의 세션 줄이 이 탭을 기준으로 한다.
    onMain('pet:focus', (f) => {
      if (!f || typeof f !== 'object') return;
      usage?.setFocus({
        tabId: typeof f.tabId === 'string' && TAB_RE.test(f.tabId) ? f.tabId : null,
        kind: ['claude', 'codex', 'collab'].includes(f.kind) ? f.kind : null,
        label: typeof f.label === 'string' ? f.label.slice(0, 60) : '',
      });
    });
    handleMain('weather:current', () => getWeather());
    handleMain('dialog:pickFolder', async () => {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '작업 폴더 선택' });
      return r.canceled ? null : r.filePaths[0];
    });
    handleMain('pty:create', (opts) => createTabPty(opts || {}));
    onMain('pty:write', ({ tabId, data }) => ptys.write(tabId, data));
    onMain('pty:resize', ({ tabId, cols, rows }) => ptys.resize(tabId, cols, rows));
    handleMain('pty:kill', ({ tabId }) => ptys.kill(tabId));
    handleMain('hooks:global:set', ({ enabled }) => setGlobalHooks(!!enabled));
    handleMain('collab:send', (opts) => collabSend(opts || {}));
    handleMain('collab:stop', (opts) => collabStop(opts || {}));
    handleMain('collab:close', (opts) => collabClose(opts || {}));
    handleMain('collab:models', () => collabModels());
    handleMain('shell:open', (url) => { if (/^https?:\/\//.test(String(url))) shell.openExternal(url); });

    // 펫 그림 선택·가져오기·삭제 (메인 창 전용). 오류는 정해진 문구만 화면에 돌려주고 원문은 메인 로그에만 남긴다.
    const userPetsDir = () => path.join(app.getPath('userData'), 'pets');
    const emptyPets = { pets: [], selected: { claude: null, codex: null }, resolved: { claude: 'none', codex: 'none' } };
    let petImporting = false;
    handleMain('pets:list', () => pet?.listPets() ?? emptyPets);
    handleMain('pets:preview', (key) => {
      const r = pet?.readPetByKey(key);
      return r ? { type: r.type, bytes: r.bytes } : null;
    });
    handleMain('pets:import', async (kind) => {
      if (!pet || (kind !== 'zip' && kind !== 'folder')) return { error: petImport.ERR.generic };
      if (petImporting) return { error: '이미 가져오는 중입니다' };
      petImporting = true;
      try {
        const r = await dialog.showOpenDialog(win, kind === 'zip'
          ? { title: '펫 zip 선택', properties: ['openFile'], filters: [{ name: '펫 zip', extensions: ['zip'] }] }
          : { title: '펫 폴더 선택', properties: ['openDirectory'] });
        if (r.canceled || !r.filePaths[0]) return { cancelled: true };
        const src = r.filePaths[0];
        let prepared;
        if (kind === 'zip') {
          if (fs.statSync(src).size > petImport.MAX_ZIP_BYTES) return { error: petImport.ERR.zipBig };
          prepared = petImport.importZip(fs.readFileSync(src), path.basename(src, path.extname(src)));
        } else {
          prepared = petImport.importFolder(src);
        }
        if (prepared.error) {
          if (prepared.detail) console.error('[pets] 가져오기 검사 실패', prepared.detail);
          return { error: prepared.error };
        }
        const done = await petImport.installPet(prepared, userPetsDir());
        if (done.error) {
          if (done.detail) console.error('[pets] 설치 실패', done.detail);
          return { error: done.error };
        }
        pet.refreshUserPets();
        return { ok: true, key: `user:${done.id}`, displayName: prepared.displayName };
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
      isCodexAvailable: () => !!codex, userDataDir: app.getPath('userData'),
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
