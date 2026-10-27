'use strict';

// IDE 안에서 실행하면 ELECTRON_RUN_AS_NODE=1 이 따라와 Electron 이 Node 로 뜬다 (scripts/start.mjs 도 지운다).
delete process.env.ELECTRON_RUN_AS_NODE;

const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, Tray, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { startHookServer } = require('./hookServer.cjs');
const hookSettings = require('./hookSettings.cjs');
const claudeCli = require('./claudeCli.cjs');
const { PtyManager } = require('./ptyManager.cjs');
const { cleanEnv } = require('./env.cjs');
const { createWeatherService } = require('./weather.cjs');
const getWeather = createWeatherService();

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
let quitting = false; // 트레이 「종료」·app.quit() 때만 창을 실제로 닫는다
let hook = null;
let config = null;
let claude = null;
let sessionSettingsPath = null;

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

function writeSessionSettings() {
  sessionSettingsPath = path.join(app.getPath('userData'), 'session-hooks.json');
  fs.writeFileSync(sessionSettingsPath, JSON.stringify(hookSettings.sessionSettings(hook.port, config.token), null, 2));
}

async function status() {
  claude = await claudeCli.locate();
  const version = claude ? await claudeCli.version(claude) : null;
  const auth = claude ? await claudeCli.authStatus(claude) : { loggedIn: false };
  return {
    claude: claude ? { path: claude.display, version } : null,
    auth,
    hook: { port: hook.port, global: hookSettings.readGlobalStatus(hook.port, config.token) },
  };
}

async function createTabPty({ tabId, cwd, mode, resumeId, label, cols, rows }) {
  if (!TAB_RE.test(String(tabId))) throw new Error('잘못된 탭 ID');
  if (!claude) claude = await claudeCli.locate();
  if (!claude) throw new Error('Claude Code 를 찾지 못했습니다');
  if (mode === 'login' && !cwd) cwd = os.homedir();
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`폴더가 없습니다: ${cwd}`);

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
  // 실수로 창을 닫아도 Claude 세션·사무실은 계속 돈다 — 창만 숨기고, 종료는 트레이 메뉴에서 한다.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  win.on('session-end', () => { quitting = true; }); // Windows 로그오프·종료는 막지 않는다
  win.on('closed', () => { win = null; });
  if (process.env.AGENT_OFFICE_SMOKE) runSmoke();
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function quitFromTray() {
  const running = ptys.count();
  if (running) {
    const opts = {
      type: 'question',
      buttons: ['종료', '취소'],
      defaultId: 1,
      cancelId: 1,
      title: 'Agent Office 종료',
      message: `실행 중인 Claude Code 세션 ${running}개가 함께 종료됩니다. 종료할까요?`,
    };
    const r = win && win.isVisible() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    if (r.response !== 0) return;
  }
  app.quit();
}

function createTray() {
  tray = new Tray(ICON);
  tray.setToolTip('Agent Office');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Agent Office 열기', click: showWindow },
    { type: 'separator' },
    { label: '종료', click: () => { quitFromTray(); } },
  ]));
  tray.on('click', showWindow);
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
    hook = await startHookServer({ port: config.port, token: config.token, onEvent: (ev) => send('hook:event', ev) });
    if (hook.port !== config.port) {
      // 대체 포트로 떴으면 그 포트를 기억한다 — 다음 실행과 사용자 설정 hook 이 같은 포트를 보게.
      config.port = hook.port;
      saveConfig(config);
    }
    writeSessionSettings();

    ipcMain.handle('app:status', () => status());
    ipcMain.handle('weather:current', () => getWeather());
    ipcMain.handle('dialog:pickFolder', async () => {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '작업 폴더 선택' });
      return r.canceled ? null : r.filePaths[0];
    });
    ipcMain.handle('pty:create', (_e, opts) => createTabPty(opts || {}));
    ipcMain.on('pty:write', (_e, { tabId, data }) => ptys.write(tabId, data));
    ipcMain.on('pty:resize', (_e, { tabId, cols, rows }) => ptys.resize(tabId, cols, rows));
    ipcMain.handle('pty:kill', (_e, { tabId }) => ptys.kill(tabId));
    ipcMain.handle('hooks:global:set', (_e, { enabled }) => setGlobalHooks(!!enabled));
    ipcMain.handle('shell:open', (_e, url) => { if (/^https?:\/\//.test(String(url))) shell.openExternal(url); });

    createTray();
    createWindow();
  }).catch((err) => {
    dialog.showErrorBox('Agent Office 시작 실패', String(err && err.stack || err));
    app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    ptys.killAll();
    if (hook) hook.server.close();
  });
  app.on('window-all-closed', () => app.quit());
}
