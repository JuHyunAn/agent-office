'use strict';
// 코드 화면 점검: 격리된 저장 공간·합성 IPC 로 실제 UI 를 띄워, (1) 코드 화면 동안 사무실이 그리기만 쉬고 계산은 계속하는지,
// (2) 실제 code:* IPC 와 모나코로 트리·건드린 파일·보기·비교가 동작하는지 확인한다.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const { cleanEnv } = require('../src/main/env.cjs');
  const child = spawn(require('electron'), [__filename], { env: cleanEnv(), stdio: 'inherit', windowsHide: true });
  child.on('error', e => { console.error(e); process.exitCode = 1; }); child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, protocol, net, ipcMain } = require('electron');
  const { pathToFileURL } = require('node:url');
  const assert = require('node:assert/strict');
  const OUT = path.join(ROOT, 'output', 'design'), errors = [];
  // 코드 화면 확인은 실제 저장소 대신 임시 픽스처 저장소로 한다 (저장소 루트에 아무 파일도 만들지 않는다). 실패해도 반드시 지운다.
  const FIXBASE = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-code-fx-')));
  const FIX = path.join(FIXBASE, 'repo'), OTHER = path.join(FIXBASE, 'other');
  // 깃 객체 파일은 읽기 전용이라 (이 Electron 의 rmSync 는 읽기 전용 파일을 못 지운다) 속성을 풀고 지운다.
  // 윈도우의 검색·백신이 방금 만든 폴더를 잠깐 붙잡을 수 있어 몇 번 더 시도한다.
  const cleanup = async () => {
    for (let i = 0; ; i++) {
      try {
        for (const f of fs.readdirSync(FIXBASE, { recursive: true })) { try { fs.chmodSync(path.join(FIXBASE, f), 0o666); } catch { /* 이미 없음 */ } }
        fs.rmSync(FIXBASE, { recursive: true, force: true }); return;
      } catch (e) {
        if (e.code === 'ENOENT') return;
        if (i >= 15) { console.error(`임시 폴더를 지우지 못했습니다: ${FIXBASE} (${e.code})`); return; }
        await pause(300);
      }
    }
  };
  let win, tabId;
  app.disableHardwareAcceleration(); app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'ao-code-')));
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  const fail = async message => { await cleanup(); console.error(message); console.error(errors); app.exit(1); };
  const timeout = setTimeout(() => fail('코드 화면 점검 시간 초과'), 240000);

  // 사용자·시스템 git 설정이 결과를 흔들지 않게 격리한다 (앱이 띄우는 git 도 이 값을 물려받는다).
  fs.writeFileSync(path.join(FIXBASE, 'gitconfig'), '');
  process.env.GIT_CONFIG_GLOBAL = path.join(FIXBASE, 'gitconfig'); process.env.GIT_CONFIG_NOSYSTEM = '1';
  const gitIn = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd: FIX, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const put = (rel, text) => { const f = path.join(FIX, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  // 픽스처: README.md · src/a.js · docs/×표.md(모호 문자 ×) 커밋 → 병합 충돌 파일 → src/a.js 수정(변경 비교용)
  const makeFixture = () => {
    fs.mkdirSync(FIX); fs.mkdirSync(OTHER);
    gitIn('init', '-q', '-b', 'main');
    put('README.md', '# 픽스처 문서\n\n두 번째 줄\n');
    put('src/a.js', 'export const a = 1;\n');
    put('docs/×표.md', '# 표\n\n크기는 192×192 입니다\n');
    put('merge.txt', 'base\n');
    gitIn('add', '-A'); gitIn('commit', '-q', '-m', 'init');
    gitIn('checkout', '-q', '-b', 'side'); put('merge.txt', 'side\n'); gitIn('commit', '-q', '-am', 'side');
    gitIn('checkout', '-q', 'main'); put('merge.txt', 'main\n'); gitIn('commit', '-q', '-am', 'main');
    try { gitIn('merge', '--no-edit', 'side'); } catch { /* 같은 줄을 다르게 고쳐 충돌로 멈춘다 */ }
    put('src/a.js', 'export const a = 2;\nexport const b = 3;\n');
  };
  makeFixture();
  // code:poll 호출 수·마지막 요청 경로, 그리고 시험용 실패 주입 (읽기·트리)
  const calls = { poll: 0, lastPollRel: undefined, failRead: null, failTreeFor: null };
  let pickTarget = FIX;
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const js = code => win.webContents.executeJavaScript(code);
  // 조건이 참이 될 때까지 250ms 간격으로 확인한다 (시간 초과 시 실패).
  const waitFor = async (fnSource, timeoutMs = 5000) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      let value = false;
      try { value = await js(fnSource); } catch { /* 아직 준비되지 않음 */ }
      if (value) return value;
      if (Date.now() > end) throw new Error(`조건 시간 초과: ${fnSource}`);
      await pause(250);
    }
  };
  const event = (name, extra = {}) => win.webContents.send('hook:event', { session_id: 'preview-main', cwd: ROOT, hook_event_name: name, _tab: tabId, ...extra });
  const capture = async name => { await pause(150); fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG()); };
  const counts = () => js(`({ draw: window.__drawCount, update: window.__updateCount, notify: window.__notifyCount })`);

  app.whenReady().then(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    protocol.handle('app', req => { const target = path.normalize(path.join(ROOT, decodeURIComponent(new URL(req.url).pathname))); return target.startsWith(ROOT + path.sep) ? net.fetch(pathToFileURL(target).toString()) : new Response('forbidden', { status: 403 }); });
    ipcMain.handle('app:status', () => ({ claude: { version: '코드 화면 검증' }, auth: { loggedIn: true }, hook: { global: { installed: false } } }));
    ipcMain.handle('weather:current', () => ({ available: true, stale: false, location: '서울', observedAt: Date.now(), temperature: 16, condition: 'clear' }));
    ipcMain.handle('dialog:pickFolder', () => ROOT);
    // code:* 는 대역 대신 실제 등록 함수를 연결한다 (허용 폴더·경로 검사·깃 조회까지 그대로).
    const { createCodeRoots, createCodeService, registerCodeIpc } = require(path.join(ROOT, 'src/main/codeRepo.cjs'));
    const roots = createCodeRoots();
    // 호출을 감싸 센다 (대역은 아니다 — 안쪽은 실제 처리 그대로).
    const wrap = (ch, fn) => ipcMain.handle(ch, (_e, ...a) => {
      const v = a[0] || {};
      if (ch === 'code:poll') { calls.poll++; calls.lastPollRel = v.rel ?? null; }
      if (ch === 'code:read' && calls.failRead && v.rel === calls.failRead) throw new Error('읽기 실패 시험');
      if (ch === 'code:tree' && calls.failTreeFor && v.root === calls.failTreeFor) throw new Error('트리 실패 시험');
      return fn(...a);
    });
    registerCodeIpc(wrap, { roots, service: createCodeService({ roots }), pickFolder: async () => pickTarget, checkFolder: (d) => { if (!fs.existsSync(d)) throw new Error('폴더가 없습니다'); } });
    ipcMain.handle('pty:create', (_e, options) => { tabId = options.tabId; return { sessionId: 'preview-main' }; });
    ipcMain.handle('pty:kill', () => {});
    ipcMain.on('pty:write', () => {});
    ipcMain.on('pty:resize', () => {});
    win = new BrowserWindow({ width: 1600, height: 1000, show: false, webPreferences: { preload: path.join(ROOT, 'src/main/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true } });
    win.webContents.on('console-message', e => { if (e.level === 'error' || e.level === 3) errors.push(e.message); });
    win.webContents.on('did-fail-load', (_e, code, detail) => errors.push(`${code}: ${detail}`));
    win.webContents.on('render-process-gone', (_e, details) => errors.push(`render-process-gone: ${details.reason}`));
    await win.loadURL('app://office/src/renderer/index.html'); await pause(200);

    // 입장 → 새 탭 대화상자의 폴더 선택으로 탭을 연다.
    await js(`document.querySelector('#gate-body button').click()`); await pause(300);
    await js(`document.querySelector('#pick-folder').click()`); await pause(300);
    // 그리기·계산·상태 알림 횟수를 센다 (프로토타입 감싸기).
    await js(`(async () => {
      const { OfficeEngine } = await import('./office/engine.js');
      const { OfficeView } = await import('./office/view.js');
      window.__drawCount = 0; window.__updateCount = 0; window.__notifyCount = 0;
      const draw = OfficeView.prototype.draw;
      OfficeView.prototype.draw = function (t) { window.__view = this; window.__drawCount++; return draw.call(this, t); };
      const notify = OfficeView.prototype.notify;
      OfficeView.prototype.notify = function (...args) { window.__notifyCount++; return notify.apply(this, args); };
      const update = OfficeEngine.prototype.update;
      OfficeEngine.prototype.update = function (dt) { window.__engine = this; window.__updateCount++; return update.call(this, dt); };
    })()`);
    await waitFor(`!!(window.__engine && window.__view) && document.querySelector('.xterm') !== null`, 10000);
    assert.ok(tabId, '탭이 열리지 않았습니다');
    event('SessionStart');
    await waitFor(`window.__engine.agents.has('preview-main:lead')`);

    // 모나코 로더(AMD define)는 첫 코드 화면 전까지 전역에 없어야 한다 (xterm UMD 가 AMD 로 등록되지 않게).
    assert.equal(await js(`typeof define`), 'undefined');
    // 시작 상태: 사무실 화면.
    assert.equal(await js(`document.querySelector('#mode-office').getAttribute('aria-pressed')`), 'true');
    assert.equal(await js(`document.querySelector('#mode-code').getAttribute('aria-pressed')`), 'false');
    assert.equal(await js(`document.querySelector('#code-pane').hidden`), true);
    assert.equal(await js(`document.body.classList.contains('code-mode')`), false);

    // 「코드」 전환: 덮개가 보이고, 사무실은 그리기만 쉰다.
    await js(`document.querySelector('#mode-code').click()`); await pause(100);
    assert.equal(await js(`document.querySelector('#code-pane').hidden`), false);
    assert.equal(await js(`document.body.classList.contains('code-mode')`), true);
    assert.equal(await js(`document.querySelector('#mode-code').getAttribute('aria-pressed')`), 'true');
    assert.equal(await js(`document.querySelector('#mode-office').getAttribute('aria-pressed')`), 'false');
    // 덮여 보이지 않는 사무실 쪽은 키보드 초점도 받지 않는다 (inert)
    assert.equal(await js(`['.office-stage', '.life-bar', '.feed-panel'].every(s => document.querySelector(s).hasAttribute('inert'))`), true, '코드 화면 중 사무실 쪽이 inert 가 아님');
    assert.equal(await js(`document.querySelector('.office-controls').matches('.office-controls') && getComputedStyle(document.querySelector('.office-controls')).visibility`), 'hidden');
    assert.equal(await js(`window.__view.hidden`), true);
    const geometry = await js(`(() => {
      const q = s => document.querySelector(s).getBoundingClientRect();
      const p = q('#code-pane'), t = q('.office-toolbar'), o = q('.office-pane'), r = q('#cli-resizer');
      const hit = document.elementFromPoint(r.x + 1.5, r.y + r.height / 2); // 손잡이와 코드 화면이 겹치는 자리
      return { top: p.top - t.bottom, left: p.left - o.left, bottom: o.bottom - p.bottom, rightGap: o.right - p.right, height: p.height, resizerOnTop: hit?.id === 'cli-resizer', toolbarH: getComputedStyle(document.documentElement).getPropertyValue('--office-toolbar-h') };
    })()`);
    assert.ok(Math.abs(geometry.top) < 1.5 && Math.abs(geometry.left) < 1.5 && Math.abs(geometry.bottom) < 1.5 && geometry.rightGap >= 0 && geometry.rightGap < 3 && geometry.height > 200, JSON.stringify(geometry));
    assert.equal(geometry.resizerOnTop, true, JSON.stringify(geometry));
    assert.match(geometry.toolbarH, /^\d+px$/, JSON.stringify(geometry));
    await pause(200);
    const before = await counts(); await pause(1000); const after = await counts();
    assert.equal(after.draw - before.draw, 0, `코드 화면 중 사무실이 그려짐: ${JSON.stringify({ before, after })}`);
    assert.ok(after.update - before.update > 0, `코드 화면 중 계산이 멈춤: ${JSON.stringify({ before, after })}`);
    assert.ok(after.notify - before.notify > 0, `코드 화면 중 상태 알림이 멈춤: ${JSON.stringify({ before, after })}`);

    // 코드 화면을 보는 동안 에이전트가 출근해 걸어간다 → 돌아왔을 때 이미 입구를 떠나 있어야 한다.
    event('SubagentStart', { agent_id: 'cv1', agent_type: 'executor' });
    await waitFor(`window.__engine.agents.has('preview-main:cv1')`);
    await pause(4000);
    assert.equal(await js(`window.__drawCount - ${after.draw}`), 0, '코드 화면 중 사무실이 그려짐 (출근 중)');
    await capture('code-view-toggle');
    await js(`document.querySelector('#mode-office').click()`); await pause(100);
    assert.equal(await js(`document.querySelector('#code-pane').hidden`), true);
    assert.equal(await js(`document.body.classList.contains('code-mode')`), false);
    assert.equal(await js(`document.querySelector('#mode-office').getAttribute('aria-pressed')`), 'true');
    assert.equal(await js(`getComputedStyle(document.querySelector('.office-controls')).visibility`), 'visible');
    assert.equal(await js(`['.office-stage', '.life-bar', '.feed-panel'].some(s => document.querySelector(s).hasAttribute('inert'))`), false, '사무실로 돌아왔는데 inert 가 남음');
    assert.equal(await js(`window.__view.hidden`), false);
    const walker = await js(`(() => {
      const a = window.__engine.agents.get('preview-main:cv1'), e = window.__view.theme.layout.entrance;
      return { dist: Math.hypot(a.x - e.x, a.y - e.y), path: a.path.length, status: a.status };
    })()`);
    // 입구에서 가만히 서 있었다면(update 가 멈췄다면) 거리가 0 이다.
    assert.ok(walker.dist >= 300 || (walker.path === 0 && walker.dist > 0), JSON.stringify(walker));
    const resumed = await counts();
    await waitFor(`window.__drawCount > ${resumed.draw}`, 3000);
    // 확대 상태에서 전환을 왕복해도 카메라가 깨지지 않는다 (감추기 방식이면 NaN).
    await js(`window.__view.zoomBy(1.8)`);
    const zoomed = await js(`window.__view.camera.zoom`);
    assert.ok(zoomed > 1.5, `확대되지 않음: ${zoomed}`);
    await js(`document.querySelector('#mode-code').click()`); await pause(300);
    await js(`document.querySelector('#mode-office').click()`); await pause(300);
    const camera = await js(`({ ox: window.__view.camera.ox, oy: window.__view.camera.oy, zoom: window.__view.camera.zoom, scale: window.__view.camera.scale })`);
    assert.ok(Number.isFinite(camera.ox) && Number.isFinite(camera.oy) && camera.zoom > 1.5, JSON.stringify(camera));
    await js(`window.__view.fit()`);

    // 사무실 편집 중인 테마에서는 코드 화면을 열 수 없고, 코드 화면 중 편집 테마로 바꾸면 사무실로 돌아온다.
    await js(`document.querySelector('#mode-code').click()`); await pause(100);
    assert.equal(await js(`document.querySelector('#code-pane').hidden`), false);
    await js(`(() => { const s = document.querySelector('#theme-select'); s.value = 'custom-office'; s.dispatchEvent(new Event('change')); })()`);
    await waitFor(`window.__view.theme.id === 'custom-office'`, 5000);
    assert.equal(await js(`window.__view.theme.editor?.editing`), true);
    await pause(200);
    assert.equal(await js(`document.querySelector('#code-pane').hidden`), true, '편집 테마로 바꿨는데 코드 화면이 남음');
    assert.equal(await js(`document.body.classList.contains('code-mode')`), false);
    await js(`document.querySelector('#mode-code').click()`); await pause(150);
    assert.equal(await js(`document.querySelector('#code-pane').hidden`), true, '편집 중인데 코드 화면이 열림');
    assert.match(await js(`document.querySelector('#feed li').textContent`), /사무실 편집을 마친 뒤 코드 화면을 열 수 있습니다/);
    assert.equal(await js(`document.querySelector('#mode-office').getAttribute('aria-pressed')`), 'true');
    await js(`(() => { const s = document.querySelector('#theme-select'); s.value = 'pixel-office'; s.dispatchEvent(new Event('change')); })()`);
    await waitFor(`window.__view.theme.id === 'pixel-office'`, 5000);

    // 좁은 창에서도 도구줄이 넘치지 않고, 도구줄 높이가 바뀌어도 코드 화면이 그 아래에 맞는다.
    win.setSize(1100, 800); await pause(400);
    await js(`document.querySelector('#mode-code').click()`); await pause(200);
    const narrow = await js(`(() => {
      const t = document.querySelector('.office-toolbar'), p = document.querySelector('#code-pane').getBoundingClientRect();
      return { fits: t.scrollWidth <= t.clientWidth, toolbarBottom: t.getBoundingClientRect().bottom, paneTop: p.top, noPageScroll: document.documentElement.scrollWidth <= innerWidth };
    })()`);
    assert.ok(narrow.fits && narrow.noPageScroll && Math.abs(narrow.toolbarBottom - narrow.paneTop) < 1.5, JSON.stringify(narrow));
    await js(`document.querySelector('#mode-office').click()`);

    // ───────── 모나코 코드 화면: 트리·건드린 파일·보기·비교 (임시 픽스처 저장소 기준) ─────────
    win.setSize(1600, 1000); await pause(500);
    const sel = JSON.stringify;
    const pane = s => `document.querySelector('#code-pane ${s}')`;
    const node = rel => pane(`.code-node[data-path=${sel(rel)}]`);
    const touch = rel => pane(`.code-touch[data-path=${sel(rel)}]`);
    // 부모 폴더를 차례로 펼친 뒤 파일 단추를 누른다.
    const openPath = rel => js(`(() => {
      const parts = ${sel(rel)}.split('/');
      for (let i = 1; i < parts.length; i++) {
        const b = document.querySelector('#code-pane .code-node[data-path=' + JSON.stringify(parts.slice(0, i).join('/')) + ']');
        if (b && b.getAttribute('aria-expanded') !== 'true') b.click();
      }
      document.querySelector('#code-pane .code-node[data-path=' + JSON.stringify(${sel(rel)}) + ']').click();
    })()`);
    const visible = s => `(() => { const e = ${pane(s)}; return !!e && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; })()`;
    const viewText = s => `(${pane(`${s} .view-lines`)}?.textContent || '').replace(/\\u00a0/g, ' ')`;
    const touchPaths = () => js(`[...document.querySelectorAll('#code-pane .code-touch')].map(b => b.dataset.path)`);
    // 메인 쪽 호출 수는 이 프로세스에서 센다.
    const waitCalls = async (cond, ms = 10000) => {
      const end = Date.now() + ms;
      while (!cond()) { if (Date.now() > end) throw new Error('호출 시간 초과'); await pause(100); }
    };
    const firstLine = fs.readFileSync(path.join(FIX, 'README.md'), 'utf8').split(/\r?\n/).find(l => l.trim()).replace(/^#+\s*/, '').trim();

    try {
      await js(`document.querySelector('#mode-code').click()`);
      // 열린 탭의 폴더(ROOT)가 기본으로 골라지고 트리에 src·package.json 이 보인다 (모나코는 아직 불러오지 않음).
      await waitFor(`${pane('.code-folder')}?.value === ${sel(ROOT)}`, 10000);
      await waitFor(`!!${node('src')} && !!${node('package.json')}`, 10000);
      assert.equal(await js(`${node('src')}.getAttribute('aria-expanded')`), 'false');
      assert.match(await js(`${pane('.code-status')}.textContent`), /\d\d:\d\d:\d\d 갱신/);
      assert.equal(await js(`typeof define`), 'undefined', '파일을 열기 전에 모나코 로더가 주입됨');

      // 「폴더 열기…」로 임시 픽스처 저장소를 연다. 이후 확인은 모두 이 저장소 기준이다.
      pickTarget = FIX;
      await js(`${pane('.code-pick')}.click()`);
      await waitFor(`${pane('.code-folder')}?.value === ${sel(FIX)}`, 10000);
      await waitFor(`!!${node('src')} && !!${node('README.md')} && !${node('package.json')}`, 10000);

      // 파일을 고르기 전: 안내 글 대신 회색 로고만 가운데에 보인다.
      await waitFor(`!!${pane('.code-idle')} && !${pane('.code-idle')}.hidden`, 10000);
      assert.equal(await js(`${pane('.code-message')}.hidden`), true);
      const idleLogo = await js(`(() => { const b = ${pane('.code-idle .brand-mark')}, r = b.getBoundingClientRect(), v = ${pane('.code-view')}.getBoundingClientRect(); return { color: getComputedStyle(b).backgroundColor, width: r.width, dx: Math.abs((r.left + r.right) / 2 - (v.left + v.right) / 2) }; })()`);
      const [lr, lg, lb] = idleLogo.color.match(/\d+/g).map(Number);
      assert.ok(lr === lg && lg === lb, `로고가 회색이 아님: ${idleLogo.color}`);
      assert.ok(Math.abs(idleLogo.width - 72) < 1, `로고 크기가 다름: ${idleLogo.width}`);
      assert.ok(idleLogo.dx < 2, `로고가 가운데가 아님: ${idleLogo.dx}`);
      await capture('code-view-idle');

      // 변경 표시: 병합 충돌은 ! (제목 「병합 충돌」), 변경이 든 폴더에는 점, 변경 없는 파일에는 표시 없음.
      await waitFor(`${node('merge.txt')}?.querySelector('.code-badge')?.textContent === '!'`, 10000);
      assert.equal(await js(`${node('merge.txt')}.querySelector('.code-badge').title`), '병합 충돌');
      assert.equal(await js(`${node('README.md')}.querySelector('.code-badge')`), null);
      assert.equal(await js(`!!${node('src')}.querySelector('.code-dot')`), true);

      // 폴더를 펼치면 자식이 생기고(src/a.js 에 M) 접으면 사라진다.
      await js(`${node('src')}.click()`);
      assert.equal(await js(`${node('src')}.getAttribute('aria-expanded')`), 'true');
      await waitFor(`${node('src/a.js')}?.querySelector('.code-badge')?.textContent === 'M'`, 10000);
      await js(`${node('src')}.click()`);
      assert.equal(await js(`!!${node('src/a.js')}`), false);

      // 변경이 없는 문서(README.md)를 열면 모나코 일반 편집기에 첫 줄이 보이고, 읽기 전용이다.
      await js(`${node('README.md')}.click()`);
      await waitFor(`${viewText('.code-editor')}.includes(${sel(firstLine)})`, 20000);
      assert.equal(await js(visible('.code-editor')), true);
      assert.equal(await js(`!!${pane('.code-diff')} && getComputedStyle(${pane('.code-diff')}).display`), 'none');
      assert.equal(await js(`${pane('.code-path')}.textContent`), 'README.md');
      assert.equal(await js(`${pane('.code-editor textarea')}?.readOnly`), true, '편집기가 읽기 전용이 아님');

      // 모호한 유니코드 문자(×)에 상자 장식을 두르지 않는다 (강조 계산이 끝날 시간을 준다).
      await openPath('docs/×표.md');
      await waitFor(`${viewText('.code-editor')}.includes('192×192')`, 10000);
      await pause(1500);
      assert.equal(await js(`document.querySelectorAll('#code-pane .code-editor .unicode-highlight').length`), 0, '모호 문자 상자 장식이 남아 있음');

      // 변경된 추적 파일: 비교 보기(삽입 장식)가 뜨고, 토글로 일반 보기와 오간다.
      await openPath('src/a.js');
      await waitFor(`${visible('.code-diff')} && !!${pane('.code-diff .monaco-diff-editor')}`, 20000);
      await waitFor(`!!document.querySelector('#code-pane .code-diff .line-insert, #code-pane .code-diff .char-insert')`, 20000);
      assert.equal(await js(`${pane('.code-diff-toggle')}.getAttribute('aria-pressed')`), 'true');
      assert.equal(await js(visible('.code-editor')), false);
      await capture('code-view-diff');
      await js(`${pane('.code-diff-toggle')}.click()`);
      await waitFor(`${visible('.code-editor')} && !${visible('.code-diff')}`, 10000);
      assert.equal(await js(`${pane('.code-diff-toggle')}.getAttribute('aria-pressed')`), 'false');
      await js(`${pane('.code-diff-toggle')}.click()`);
      await waitFor(visible('.code-diff'), 10000);

      // 에이전트가 대소문자만 다른 경로(SRC\A.JS)로 파일을 수정하려는 이벤트 → 「건드린 파일」에 1개, 누르면 트리 표기(src/a.js)로 열린다.
      await openPath('README.md');
      await waitFor(`${pane('.code-path')}.textContent === 'README.md' && ${viewText('.code-editor')}.includes(${sel(firstLine)})`, 10000);
      event('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: path.join(FIX, 'SRC', 'A.JS') } });
      await waitFor(`document.querySelectorAll('#code-pane .code-touch').length === 1`, 5000);
      assert.deepEqual(await touchPaths(), ['SRC/A.JS']);
      await waitFor(`${touch('SRC/A.JS')}.textContent.includes('●')`, 5000);
      await js(`${touch('SRC/A.JS')}.click()`);
      await waitFor(`${pane('.code-path')}.textContent === 'src/a.js'`, 10000);
      await waitFor(visible('.code-diff'), 20000); // 변경 표시를 대소문자와 무관하게 찾아 비교 보기가 열린다
      assert.equal(await js(`${touch('SRC/A.JS')}.getAttribute('aria-current')`), 'true');
      assert.equal(await js(`${node('src/a.js')}?.getAttribute('aria-current')`), 'true');

      // 깃 내부 파일(.git/config)을 읽는 이벤트는 「건드린 파일」에 오르지 않는다.
      event('PreToolUse', { tool_name: 'Read', tool_input: { file_path: path.join(FIX, '.git', 'config') } });
      event('PreToolUse', { tool_name: 'Read', tool_input: { file_path: path.join(FIX, '.GIT', 'HEAD') } });
      await pause(500);
      assert.deepEqual(await touchPaths(), ['SRC/A.JS']);

      // 앞당김: 새 파일을 쓰고 바로 수정 이벤트를 보내면 (10초 주기를 기다리지 않고) 6초 안에 트리에 U 로 나타난다. ⟳ 는 누르지 않는다.
      await openPath('README.md');
      await waitFor(`${pane('.code-path')}.textContent === 'README.md' && ${viewText('.code-editor')}.includes(${sel(firstLine)})`, 10000);
      fs.writeFileSync(path.join(FIX, 'new.txt'), 'new 한글 line\n');
      event('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: path.join(FIX, 'new.txt') } });
      await waitFor(`${node('new.txt')}?.querySelector('.code-badge')?.textContent === 'U'`, 6000);
      await capture('code-view');

      // 미추적 파일: 일반 보기로 열리고 비교 단추는 꺼진다.
      await js(`${node('new.txt')}.click()`);
      await waitFor(`${viewText('.code-editor')}.includes('new')`, 10000);
      assert.equal(await js(`${pane('.code-diff-toggle')}.disabled`), true);
      assert.equal(await js(visible('.code-diff')), false);

      // 열어 둔 파일이 지워지면 오류 없이 안내하고, ⟳ 로 트리에서도 사라진다.
      fs.rmSync(path.join(FIX, 'new.txt'));
      await js(`${pane('.code-refresh')}.click()`);
      await waitFor(`${pane('.code-message')}?.textContent.includes('파일이 없습니다') && getComputedStyle(${pane('.code-message')}).display !== 'none'`, 10000);
      await waitFor(`!${node('new.txt')}`, 10000);

      // 열기에 실패한 파일: 오류를 안내하고, 조회에 그 경로를 싣지 않으며, 다시 누르면 다시 연다.
      calls.failRead = 'README.md';
      await js(`${node('README.md')}.click()`);
      await waitFor(`${pane('.code-message')}?.textContent.includes('읽기 실패 시험') && getComputedStyle(${pane('.code-message')}).display !== 'none'`, 10000);
      assert.equal(await js(`${pane('.code-message')}.textContent.includes('Error invoking')`), false);
      assert.equal(await js(`${pane('.code-path')}.textContent`), 'README.md');
      const polls = calls.poll;
      await js(`${pane('.code-refresh')}.click()`);
      await waitCalls(() => calls.poll > polls);
      assert.equal(calls.lastPollRel, null, '열기에 실패한 파일의 경로를 조회에 실음');
      calls.failRead = null;
      await js(`${node('README.md')}.click()`);
      await waitFor(`${viewText('.code-editor')}.includes(${sel(firstLine)}) && ${visible('.code-editor')}`, 10000);

      // 트리를 받지 못한 폴더: 「불러오는 중…」에 머물지 않고 오류를 안내한다.
      calls.failTreeFor = OTHER; pickTarget = OTHER;
      await js(`${pane('.code-pick')}.click()`);
      await waitFor(`${pane('.code-folder')}?.value === ${sel(OTHER)}`, 10000);
      await waitFor(`${pane('.code-message')}?.textContent.includes('트리 실패 시험')`, 10000);
      calls.failTreeFor = null; pickTarget = FIX;
      await js(`${pane('.code-pick')}.click()`);
      await waitFor(`${pane('.code-folder')}?.value === ${sel(FIX)} && !!${node('README.md')}`, 10000);

      // 모나코(AMD 로더)를 불러온 뒤에도 새 탭의 터미널이 정상으로 뜬다.
      assert.equal(await js(`typeof define`), 'function', '모나코 로더가 주입되지 않음');
      const xterms = await js(`document.querySelectorAll('.xterm').length`);
      await js(`document.querySelector('#pick-folder').click()`);
      await waitFor(`document.querySelectorAll('.xterm').length > ${xterms} && !!document.querySelector('.pane:not([hidden]) .xterm .xterm-screen')`, 10000);

      // 탭을 모두 닫아도 그 탭의 작업 폴더는 폴더 목록에 남는다 (앱을 끌 때까지 고를 수 있다).
      await js(`(window.confirm = () => true, 0)`); // 탭 닫기 확인 대화상자를 자동으로 승인
      await js(`for (const c of document.querySelectorAll('#tabs .tab .close')) c.click()`);
      await waitFor(`document.querySelectorAll('#tabs .tab').length === 0`, 10000);
      const folderValues = await js(`[...document.querySelectorAll('#code-pane .code-folder option')].map(o => o.value)`);
      assert.ok(folderValues.some(v => v.toLowerCase() === ROOT.toLowerCase()), `탭을 닫자 폴더가 목록에서 사라짐: ${JSON.stringify(folderValues)}`);
      assert.ok(folderValues.includes(FIX), JSON.stringify(folderValues));

      // 사무실로 돌아와도 정상. 코드 화면이 숨겨진 동안에는 깃 조회를 하지 않는다.
      assert.ok(calls.poll > 0, 'code:poll 호출이 세어지지 않음');
      await js(`document.querySelector('#mode-office').click()`); await pause(500);
      assert.equal(await js(`document.querySelector('#code-pane').hidden`), true);
      const pollsAtHide = calls.poll;
      await pause(12000);
      assert.equal(calls.poll - pollsAtHide, 0, `숨긴 뒤에도 code:poll 이 불림: ${calls.poll - pollsAtHide}회`);
    } finally {
      await cleanup();
    }

    await pause(300);
    assert.deepEqual(errors, []);
    console.log('코드 화면 점검 통과');
    console.log(JSON.stringify({ hiddenSecond: { draw: after.draw - before.draw, update: after.update - before.update, notify: after.notify - before.notify }, walker, camera, geometry, fixture: ['README.md', 'src/a.js', 'docs/×표.md', 'merge.txt'], polls: calls.poll, output: [path.join(OUT, 'code-view-toggle.png'), path.join(OUT, 'code-view.png'), path.join(OUT, 'code-view-diff.png')] }, null, 2));
    clearTimeout(timeout); app.exit(0);
  }).catch(async e => {
    clearTimeout(timeout);
    // 실패 원인을 볼 수 있게 코드 화면의 현재 모습을 함께 남긴다.
    try { console.error(await js(`JSON.stringify({ status: document.querySelector('#code-pane .code-status')?.textContent, message: document.querySelector('#code-pane .code-message')?.textContent, path: document.querySelector('#code-pane .code-path')?.textContent, hidden: ['.code-editor', '.code-diff', '.code-message'].map(s => document.querySelector('#code-pane ' + s)?.hidden), monaco: typeof window.monaco, text: (document.querySelector('#code-pane .view-lines')?.textContent || '').slice(0, 80) })`)); } catch { /* 화면 상태를 못 읽음 */ }
    fail(e.stack || e);
  });
}
