'use strict';
// 코드 화면 점검: 격리된 저장 공간·합성 IPC 로 실제 UI 를 띄워, (1) 코드 화면 동안 사무실이 그리기만 쉬고 계산은 계속하는지,
// (2) 실제 code:* IPC 와 모나코로 트리·건드린 파일·보기·비교가 동작하는지 확인한다.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { Writable, PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
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
  const FIX = path.join(FIXBASE, 'repo'), OTHER = path.join(FIXBASE, 'other'), BIG = path.join(FIXBASE, 'big');
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
  const timeout = setTimeout(() => fail('코드 화면 점검 시간 초과'), 600000);

  // 사용자·시스템 git 설정이 결과를 흔들지 않게 격리한다 (앱이 띄우는 git 도 이 값을 물려받는다).
  fs.writeFileSync(path.join(FIXBASE, 'gitconfig'), '');
  process.env.GIT_CONFIG_GLOBAL = path.join(FIXBASE, 'gitconfig'); process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GCM_INTERACTIVE = 'never'; // 안전장치: 혹시 GCM 이 불려도 사용자 화면에 로그인 창을 띄우지 않는다
  const gitAt = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const gitIn = (...args) => gitAt(FIX, ...args);
  const put = (rel, text) => { const f = path.join(FIX, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  // 픽스처: README.md · src/a.js · docs/×표.md(모호 문자 ×) 커밋 → 병합 충돌 파일 → src/a.js 수정(변경 비교용)
  // 긴 파일(150줄): 점프로 첫 줄이 화면에서 사라지는지 본다. 줄마다 서로 다른 함수 이름이라 한 줄을 정확히 가리킬 수 있다.
  const longLines = (p, n = 150) => Array.from({ length: n }, (_, i) => (i === 0 ? `// ${p.toUpperCase()}START 긴 파일` : `export function ${p}_${i + 1}(x) { return x + ${i + 1}; }`));
  const makeFixture = () => {
    fs.mkdirSync(FIX); fs.mkdirSync(OTHER); fs.mkdirSync(BIG);
    gitIn('init', '-q', '-b', 'main');
    put('README.md', '# 픽스처 문서\n\n두 번째 줄\n');
    put('src/a.js', 'export const a = 1;\n');
    put('docs/×표.md', '# 표\n\n크기는 192×192 입니다\n');
    put('merge.txt', 'base\n');
    put('src/long.js', longLines('lng').join('\n') + '\n');
    put('src/diff-long.js', longLines('dif').join('\n') + '\n');
    gitIn('add', '-A'); gitIn('commit', '-q', '-m', 'init');
    gitIn('checkout', '-q', '-b', 'side'); put('merge.txt', 'side\n'); gitIn('commit', '-q', '-am', 'side');
    gitIn('checkout', '-q', 'main'); put('merge.txt', 'main\n'); gitIn('commit', '-q', '-am', 'main');
    try { gitIn('merge', '--no-edit', 'side'); } catch { /* 같은 줄을 다르게 고쳐 충돌로 멈춘다 */ }
    put('src/a.js', 'export const a = 2;\nexport const b = 3;\n');
    // 큰 변경 확인용: 미추적 파일 21개 (확인 기준 20개 초과)
    gitAt(BIG, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(BIG, 'base.txt'), 'base\n');
    gitAt(BIG, 'add', '-A'); gitAt(BIG, 'commit', '-q', '-m', 'init');
    for (let i = 1; i <= 21; i++) fs.writeFileSync(path.join(BIG, `f${String(i).padStart(2, '0')}.txt`), `file ${i}\n`);
  };
  makeFixture();
  // code:poll·code:git:state 호출 수, 마지막 요청 경로, 그리고 시험용 실패 주입 (읽기·트리)
  const calls = { poll: 0, gitState: 0, gitLog: 0, failGit: null, delayGit: 0, lastPollRel: undefined, failRead: null, failTreeFor: null };
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
    let editorWorkerLoads = 0; // 모델을 모두 버려도 워커를 새로 띄우지 않는지 센다
    protocol.handle('app', req => { if (req.url.includes('assets/editor.worker')) editorWorkerLoads++; const target = path.normalize(path.join(ROOT, decodeURIComponent(new URL(req.url).pathname))); return target.startsWith(ROOT + path.sep) ? net.fetch(pathToFileURL(target).toString()) : new Response('forbidden', { status: 403 }); });
    ipcMain.handle('app:status', () => ({ claude: { version: '코드 화면 검증' }, auth: { loggedIn: true }, hook: { global: { installed: false } } }));
    ipcMain.handle('weather:current', () => ({ available: true, stale: false, location: '서울', observedAt: Date.now(), temperature: 16, condition: 'clear' }));
    ipcMain.handle('dialog:pickFolder', () => ROOT);
    // code:* 는 대역 대신 실제 등록 함수를 연결한다 (허용 폴더·경로 검사·깃 조회까지 그대로).
    const { createCodeRoots, createCodeService, registerCodeIpc } = require(path.join(ROOT, 'src/main/codeRepo.cjs'));
    const roots = createCodeRoots();
    // 호출을 감싸 센다 (대역은 아니다 — 안쪽은 실제 처리 그대로).
    const wrap = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => {
      const v = a[0] || {};
      if (ch === 'code:poll') { calls.poll++; calls.lastPollRel = v.rel ?? null; }
      if (ch === 'code:git:state') calls.gitState++;
      if (ch === 'code:git:log') calls.gitLog++;
      if (calls.failGit && ch === calls.failGit.ch) throw new Error(calls.failGit.text); // 시험용 거부 (IPC 거부가 콘솔 오류로 새지 않는지)
      if (calls.delayGit && ch === 'code:git:commit') await pause(calls.delayGit); // 시험용 지연 (작업 중 표시·진행 중 입력)
      if (ch === 'code:read' && calls.failRead && v.rel === calls.failRead) throw new Error('읽기 실패 시험');
      if (ch === 'code:tree' && calls.failTreeFor && v.root === calls.failTreeFor) throw new Error('트리 실패 시험');
      return fn(...a);
    });
    registerCodeIpc(wrap, { roots, service: createCodeService({ roots }), pickFolder: async () => pickTarget, checkFolder: (d) => { if (!fs.existsSync(d)) throw new Error('폴더가 없습니다'); } });
    // 코드 분석: 실제 실행기·IPC 를 가짜 spawn 으로 연결한다 (claude 를 실제로 부르지 않는다).
    const fake = { spawns: [], scenario: null };
    const deferred = () => { let open; const promise = new Promise(r => { open = r; }); return { promise, open }; };
    const fakeSpawn = (file, args, opts) => {
      const sc = fake.scenario, proc = new EventEmitter();
      const rec = { file, args, cwd: opts.cwd, prompt: '', closed: false, killed: false, proc };
      proc.stdin = new Writable({ write(chunk, _enc, cb) { rec.prompt += chunk.toString(); cb(); } });
      proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.pid = 0; proc.exitCode = null;
      proc.stdin.on('finish', async () => {
        if (sc.gate) await sc.gate.promise;
        if (rec.killed) return;
        proc.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: sc.model }) + '\n');
        proc.stdout.write(JSON.stringify(sc.isError
          ? { type: 'result', subtype: 'success', is_error: true, result: sc.errorText, total_cost_usd: 0 }
          : { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.04, structured_output: sc.structured, result: sc.resultText }) + '\n');
        proc.stdout.end();
        setTimeout(() => { rec.closed = true; proc.emit('exit', 0); proc.emit('close', 0); }, 30);
      });
      fake.spawns.push(rec);
      return proc;
    };
    const fakeKill = p => {
      const rec = fake.spawns.find(r => r.proc === p);
      if (!rec) return;
      rec.killed = true;
      setTimeout(() => { rec.closed = true; p.emit('exit', null); p.emit('close', null); }, 30);
    };
    const analysisSettings = path.join(FIXBASE, 'analysis-settings.json');
    const codeAnalysis = require(path.join(ROOT, 'src/main/codeAnalysis.cjs'));
    fs.writeFileSync(analysisSettings, JSON.stringify(codeAnalysis.DENY_SETTINGS));
    const analyzer = codeAnalysis.createCodeAnalyzer({
      roots, locate: async () => ({ file: 'fake', prefixArgs: [] }), settingsPath: analysisSettings, env: process.env,
      spawn: fakeSpawn, kill: fakeKill, exitGraceMs: 200, killGraceMs: 200,
    });
    codeAnalysis.registerAnalysisIpc(wrap, { analyzer });
    // 가짜 pty: 하단 터미널(mode:'shell')은 호출만 기록한다. 메인과 같은 검사(shellLaunch — 등록된 폴더·고정된 셸 종류)를 거치되 셸은 띄우지 않는다.
    // 탭 ID 로 오인되지 않게 앱 탭의 tabId 는 건드리지 않는다.
    const term = { creates: [], writes: [], resizes: [], failWith: null }; // creates: 호출 옵션 + 메인이 만들었을 명령(cmd, 거부면 null)
    const { shellLaunch } = require(path.join(ROOT, 'src/main/shellCmd.cjs'));
    ipcMain.handle('pty:create', async (_e, options) => {
      if (options.mode === 'shell') {
        let cmd = null;
        try {
          if (term.failWith) throw new Error(term.failWith);
          cmd = await shellLaunch({ shell: options.shell, cwd: options.cwd, roots, checkFolder: d => { if (!fs.existsSync(d)) throw new Error('폴더가 없습니다'); }, findBash: async () => 'C:\\Git\\bin\\bash.exe' });
        } finally { term.creates.push({ ...options, cmd }); }
        return { sessionId: null };
      }
      tabId = options.tabId; return { sessionId: 'preview-main' };
    });
    ipcMain.handle('pty:kill', () => {});
    ipcMain.on('pty:write', (_e, m) => { if (/^code-term-/.test(m?.tabId)) term.writes.push(m); });
    ipcMain.on('pty:resize', (_e, m) => { if (/^code-term-/.test(m?.tabId)) term.resizes.push(m); });
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
    let narrowAnalysis = null;
    let analysisResize = null;
    let gitPanelResize = null;
    let sideResize = null;
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

      // ───────── 코드 분석: 하단 패널과 실행 흐름 (가짜 claude, 실행기·IPC 는 실제) ─────────
      const A = s => pane(s);
      const anchorOf = (p, k) => `export function ${p}_${k}(x) { return x + ${k}; }`;
      const resultOf = tag => ({
        summary: `요약 본문 ${tag}\n영역: 긴 파일 — 함수 모음\n실행 흐름: A → B → C`,
        readingOrder: [
          { file: 'src/long.js', line: 120, anchor: anchorOf('lng', 120), why: '긴 파일의 핵심 함수' },
          { file: 'src/long.js', line: 10, anchor: anchorOf('lng', 90), why: '줄 번호가 틀린 항목' },
          { file: 'src/diff-long.js', line: 120, anchor: anchorOf('dif', 130), why: '삭제 줄이 끼는 비교 보기' },
        ],
        annotations: [{ file: 'src/long.js', line: 120, anchor: anchorOf('lng', 120), title: '핵심 함수', text: '설명 문장입니다.' }],
        keywords: [{ feature: '긴 파일 함수', terms: ['lng_77(', 'ZZZ_NOHIT'] }],
      });
      const scenario = (extra = {}) => { fake.scenario = { structured: resultOf('SUMMARY-ALPHA'), gate: null, model: 'claude-sonnet-5-5', isError: false, errorText: '', ...extra }; return fake.scenario; };
      const panelShown = `(() => { const p = ${A('.code-analysis')}; return !!p && !p.hidden && p.getClientRects().length > 0; })()`;
      const caStatus = () => js(`${A('.ca-status')}?.textContent || ''`);
      const caBodyText = () => js(`${A('.ca-body')}?.textContent || ''`);
      const clickBy = (cls, text) => js(`(() => { const b = [...document.querySelectorAll('#code-pane ${cls}')].find(e => e.textContent.trim() === ${sel(text)}); if (!b) throw new Error('단추 없음: ' + ${sel(text)}); b.click(); })()`);
      const statusHas = text => `(${A('.ca-status')}?.textContent || '').includes(${sel(text)})`;
      const bodyHas = text => `(${A('.ca-body')}?.textContent || '').includes(${sel(text)})`;
      const argAfter = (rec, flag) => rec.args[rec.args.indexOf(flag) + 1];
      const selectFolderUi = dir => js(`(() => { const s = ${A('.code-folder')}; s.value = ${sel(dir)}; s.dispatchEvent(new Event('change')); })()`);
      const diffViewText = () => js(`[...document.querySelectorAll('#code-pane .code-diff .view-lines')].map(e => e.textContent).join('')`);
      // 열린 모나코 편집기 중 그 파일(디스크 모델)의 것: 커서 줄·보이는지·화면 가운데에서 얼마나 벗어났는지
      const edInfo = rel => js(`(() => {
        const ed = monaco.editor.getEditors().find(e => { const m = e.getModel(); return m && m.uri.scheme === 'disk' && m.uri.path === ${sel('/' + rel)}; });
        if (!ed) return null;
        const line = ed.getPosition().lineNumber;
        return { line, vis: ed.getVisibleRanges().some(r => r.startLineNumber <= line && line <= r.endLineNumber), off: ed.getTopForLineNumber(line) + 9 - ed.getScrollTop() - ed.getLayoutInfo().height / 2 };
      })()`);
      const settle = async rec => { await waitCalls(() => rec.closed); await pause(300); };

      // 준비: diff-long.js 는 4~13줄을 지워 비교 보기에 삭제 줄 영역이 끼게 한다. 변경 상태가 화면에 반영될 때까지 기다린다.
      const dl = longLines('dif');
      put('src/diff-long.js', [...dl.slice(0, 3), ...dl.slice(13)].join('\n') + '\n');
      const poll0 = calls.poll;
      await js(`${A('.code-refresh')}.click()`);
      await waitCalls(() => calls.poll > poll0);
      await pause(300);
      await waitFor(`!${A('.code-analyze-changes')}.disabled`, 10000);

      // 분석 전: 패널 없음, 「이번 변경 분석」만 켜져 있고(파일을 안 열었으니 「이 파일 분석」은 꺼짐), 모델은 Sonnet.
      assert.equal(await js(panelShown), false, '분석 전에 패널이 보임');
      assert.equal(await js(`${A('.code-analyze-file')}.disabled`), true);
      assert.equal(await js(`${A('.code-analyze-model')}.value`), 'sonnet');
      assert.deepEqual(await js(`[...${A('.code-analyze-model')}.options].map(o => o.value)`), ['sonnet', 'opus', 'fable']);
      assert.deepEqual(await js(`[...${A('.code-analyze-model')}.options].map(o => o.textContent)`), ['Sonnet (기본)', 'Opus (사용량 많음)', 'Fable (사용량 가장 많음)']);
      assert.equal(await js(`${A('.code-analysis-reopen')}.hidden`), true, '분석 상태가 없는데 「분석 결과」 단추가 보임');

      // 분석 시작: 분석 중… 표시, 단추 비활성, 실행 인자(모델·노력)와 작업 폴더.
      const gate1 = deferred();
      scenario({ gate: gate1 });
      const n0 = fake.spawns.length;
      await js(`${A('.code-analyze-changes')}.click()`);
      await waitFor(panelShown, 5000);
      await waitFor(statusHas('분석 중…'), 5000);
      assert.equal(await js(`${A('.code-analyze-changes')}.disabled && ${A('.code-analyze-file')}.disabled`), true);
      assert.equal(await js(`${A('.ca-act')}.textContent`), '중단');
      await waitCalls(() => fake.spawns.length === n0 + 1);
      const sp1 = fake.spawns[n0];
      assert.equal(argAfter(sp1, '--model'), 'sonnet');
      assert.equal(argAfter(sp1, '--effort'), 'high');
      assert.equal(sp1.cwd, FIX);
      assert.ok(sp1.prompt.includes('src/a.js') && sp1.prompt.includes('[수정]'), '프롬프트에 변경 대상이 없음');
      await pause(1300);
      assert.match(await caStatus(), /분석 중… 0:0[1-9]/, '경과 시간이 올라가지 않음');
      gate1.open();
      await waitFor(`${statusHas('claude-sonnet-5-5')} && ${statusHas('API 환산 약 $0.04')}`, 5000);
      assert.match(await caStatus(), /claude-sonnet-5-5 · \d+초 · API 환산 약 \$0\.04/);
      assert.equal(await js(`${A('.ca-summary')}.textContent.includes('SUMMARY-ALPHA')`), true);
      assert.equal(await js(`${A('.code-analyze-changes')}.disabled`), false);
      assert.equal(await js(`${A('.ca-act')}.textContent`), '다시 분석');

      // 읽는 순서: 항목을 누르면 파일이 열리고 대상 줄이 가운데에 오며 첫 줄은 화면에서 사라진다 (README 가 열려 있다가 옮겨 가는 경우).
      await openPath('README.md');
      await waitFor(`${pane('.code-path')}.textContent === 'README.md' && ${viewText('.code-editor')}.includes(${sel(firstLine)})`, 10000);
      await clickBy('.ca-tab', '읽는 순서');
      await waitFor(`document.querySelectorAll('#code-pane .ca-item').length === 3`, 5000);
      assert.match(await js(`${A('.ca-item')}.textContent`), /1src\/long\.js:120긴 파일의 핵심 함수/);
      await js(`document.querySelectorAll('#code-pane .ca-item')[0].click()`);
      await waitFor(`${pane('.code-path')}.textContent === 'src/long.js' && ${viewText('.code-editor')}.includes('lng_120(')`, 20000);
      assert.equal(await js(`${viewText('.code-editor')}.includes('LNGSTART')`), false, '점프했는데 첫 줄이 그대로 보임');
      let ed = await edInfo('src/long.js');
      assert.ok(ed && ed.line === 120 && ed.vis && Math.abs(ed.off) < 40, JSON.stringify(ed));
      // 이미 열린 파일 안에서 줄 번호가 틀린 항목: anchor 로 찾아가고 「위치 추정」을 알린다.
      await js(`document.querySelectorAll('#code-pane .ca-item')[1].click()`);
      await waitFor(`${viewText('.code-editor')}.includes('lng_90(')`, 10000);
      ed = await edInfo('src/long.js');
      assert.ok(ed && ed.line === 90 && ed.vis && Math.abs(ed.off) < 40, JSON.stringify(ed));
      await waitFor(statusHas('위치 추정'), 5000);
      // 비교 보기로 열리는 파일: 삭제 줄 영역이 계산 뒤에 끼어도 대상 줄이 가운데로 다시 맞춰진다.
      await js(`document.querySelectorAll('#code-pane .ca-item')[2].click()`);
      await waitFor(`${pane('.code-path')}.textContent === 'src/diff-long.js' && ${visible('.code-diff')}`, 20000);
      await waitFor(`(${pane('.code-diff')}.textContent || '').includes('dif_130(')`, 10000);
      await waitFor(`!!document.querySelector('#code-pane .code-diff .line-delete')`, 10000);
      await pause(800);
      ed = await edInfo('src/diff-long.js');
      assert.ok(ed && ed.line === 120 && ed.vis && Math.abs(ed.off) < 40, `비교 보기 점프 위치: ${JSON.stringify(ed)}`);
      assert.equal(await js(`${A('.ca-status')}.textContent.includes('위치 추정')`), false, '위치가 맞는데 「위치 추정」이 남음');
      await capture('code-analysis-jump-diff');

      // 검색 키워드: 검색어를 누르면 묶음 아래 결과, 일치 없음 안내, 결과를 누르면 이동 (비교 보기 → 일반 보기 파일).
      await clickBy('.ca-tab', '검색 키워드');
      await clickBy('.ca-term', 'ZZZ_NOHIT');
      await waitFor(bodyHas('일치 없음'), 5000);
      assert.equal(await js(`document.querySelectorAll('#code-pane .ca-hit').length`), 0);
      await clickBy('.ca-term', 'lng_77(');
      await waitFor(`document.querySelectorAll('#code-pane .ca-hit').length === 1`, 5000);
      assert.match(await js(`${A('.ca-hit .ca-loc')}.textContent`), /^src\/long\.js:77$/);
      await js(`${A('.ca-hit')}.click()`);
      await waitFor(`${pane('.code-path')}.textContent === 'src/long.js' && ${viewText('.code-editor')}.includes('lng_77(')`, 20000);
      assert.equal(await js(`${viewText('.code-editor')}.includes('LNGSTART')`), false);
      ed = await edInfo('src/long.js');
      assert.ok(ed && ed.line === 77 && ed.vis && Math.abs(ed.off) < 40, JSON.stringify(ed));
      // 다른 파일을 그 사이 열면 늦게 온 점프는 적용되지 않는다 (README 를 열고 곧바로 점프를 눌러 도중에 다른 파일을 연다).
      await clickBy('.ca-tab', '읽는 순서');
      await openPath('src/a.js');
      await waitFor(`${pane('.code-path')}.textContent === 'src/a.js'`, 5000);
      await js(`(() => { document.querySelectorAll('#code-pane .ca-item')[0].click(); document.querySelector('#code-pane .code-node[data-path="README.md"]').click(); })()`);
      await waitFor(`${pane('.code-path')}.textContent === 'README.md' && ${viewText('.code-editor')}.includes(${sel(firstLine)})`, 20000);
      await pause(600);
      assert.equal(await js(`${pane('.code-path')}.textContent`), 'README.md', '점프가 뒤늦게 다른 파일을 열었음');
      assert.equal(await js(`${viewText('.code-editor')}.includes(${sel(firstLine)})`), true);

      // 같은 입력으로 다시 분석 → 실행 없이 「변경 없음 — 이전 결과」, 「다시 분석」은 실행 횟수가 늘어난다.
      const nSame = fake.spawns.length;
      await js(`${A('.code-analyze-changes')}.click()`);
      await waitFor(statusHas('변경 없음 — 이전 결과'), 10000);
      assert.equal(fake.spawns.length, nSame, '같은 입력인데 다시 실행함');
      await clickBy('.ca-act', '다시 분석');
      await waitCalls(() => fake.spawns.length === nSame + 1);
      await waitFor(`${statusHas('claude-sonnet-5-5')} && !${statusHas('이전 결과')}`, 10000);

      // Opus: 실행 인자 --model opus, --effort high, 실제 모델 표시. 선택 상자에 사용량 안내.
      await js(`(() => { const s = ${A('.code-analyze-model')}; s.value = 'opus'; s.dispatchEvent(new Event('change')); })()`);
      assert.match(await js(`${A('.code-analyze-model')}.title`), /사용량/);
      scenario({ model: 'claude-opus-5-5' });
      const nOpus = fake.spawns.length;
      await js(`${A('.code-analyze-changes')}.click()`);
      await waitCalls(() => fake.spawns.length === nOpus + 1);
      assert.equal(argAfter(fake.spawns[nOpus], '--model'), 'opus');
      assert.equal(argAfter(fake.spawns[nOpus], '--effort'), 'high');
      assert.ok(!fake.spawns[nOpus].args.includes('--dangerously-skip-permissions') && !fake.spawns[nOpus].args.includes('--setting-sources'));
      await waitFor(statusHas('claude-opus-5-5'), 10000);
      await js(`(() => { const s = ${A('.code-analyze-model')}; s.value = 'sonnet'; s.dispatchEvent(new Event('change')); })()`);

      // 큰 변경(미추적 21개): 실행 전에 확인 문구, 「그래도 분석」으로 실행.
      pickTarget = BIG;
      await js(`${pane('.code-pick')}.click()`);
      await waitFor(`${pane('.code-folder')}?.value === ${sel(BIG)} && !${A('.code-analyze-changes')}.disabled`, 10000);
      assert.equal(await js(panelShown), false, '다른 폴더에 이전 폴더의 분석이 보임');
      scenario({ structured: resultOf('BIG-SUMMARY') });
      const nBig = fake.spawns.length;
      await js(`${A('.code-analyze-changes')}.click()`);
      await waitFor(`!!${A('.ca-confirm-text')} && ${A('.ca-confirm-text')}.textContent.includes('대상 21개')`, 10000);
      assert.equal(fake.spawns.length, nBig, '확인 전에 실행함');
      assert.equal(await js(`${A('.ca-confirm-btn')}.textContent`), '그래도 분석');
      assert.match(await caStatus(), /크기 확인/);
      // 「취소」: 이전 결과가 없으면 패널이 사라지고(실행 없음), 다시 누르면 같은 확인 화면
      assert.equal(await js(`${A('.ca-cancel-btn')}.textContent`), '취소');
      await js(`${A('.ca-cancel-btn')}.click()`);
      await waitFor(`!(${panelShown})`, 5000);
      assert.equal(fake.spawns.length, nBig, '취소했는데 실행함');
      await js(`${A('.code-analyze-changes')}.click()`);
      await waitFor(`!!${A('.ca-confirm-text')} && ${A('.ca-confirm-text')}.textContent.includes('대상 21개')`, 10000);
      await js(`${A('.ca-confirm-btn')}.click()`);
      await waitCalls(() => fake.spawns.length === nBig + 1);
      assert.ok(fake.spawns[nBig].prompt.includes('[신규'), '신규 파일 표기가 프롬프트에 없음');
      assert.equal(fake.spawns[nBig].cwd, BIG);
      await waitFor(statusHas('claude-sonnet-5-5'), 10000);
      await clickBy('.ca-tab', '요약'); // 탭 선택은 폴더가 바뀌어도 유지된다
      await waitFor(`!!${A('.ca-summary')} && ${A('.ca-summary')}.textContent.includes('BIG-SUMMARY')`, 10000);
      // 결과가 하나뿐이면 범위는 글자로 보인다 (고르는 상자 없음)
      assert.equal(await js(`${A('.ca-scope-sel')}.hidden && !${A('.ca-scope')}.hidden && ${A('.ca-scope')}.textContent === '이번 변경'`), true, '결과가 하나인데 범위 선택 상자가 보임');
      await settle(fake.spawns[nBig]);
      // 「다시 분석」도 큰 변경은 먼저 확인받는다 (force 라 캐시를 쓰지 않아도 확인 없이 실행하지 않는다) → 「취소」는 이전 결과로 돌아간다.
      await clickBy('.ca-act', '다시 분석');
      await waitFor(`!!${A('.ca-confirm-text')} && ${A('.ca-confirm-text')}.textContent.includes('대상 21개')`, 10000);
      assert.equal(fake.spawns.length, nBig + 1, '다시 분석이 확인 없이 실행됨');
      await js(`${A('.ca-cancel-btn')}.click()`);
      await waitFor(`!${A('.ca-confirm')} && ${A('.ca-summary')}?.textContent.includes('BIG-SUMMARY')`, 5000);
      assert.equal(fake.spawns.length, nBig + 1, '취소했는데 실행함');
      // 확인 화면의 「그래도 분석」이 force 를 이어받아 (같은 입력이어도) 실행한다.
      await clickBy('.ca-act', '다시 분석');
      await waitFor(`!!${A('.ca-confirm-btn')}`, 10000);
      await js(`${A('.ca-confirm-btn')}.click()`);
      await waitCalls(() => fake.spawns.length === nBig + 2);
      await settle(fake.spawns[nBig + 1]);
      await waitFor(`!${A('.ca-confirm')} && ${A('.ca-summary')}?.textContent.includes('BIG-SUMMARY')`, 10000);

      // 중단: 실행을 멈추고 「중단했습니다」, 이전 결과는 그대로, 다시 실행할 수 있다. (FIX 로 돌아오면 아까 결과가 그대로 보인다.)
      pickTarget = FIX;
      await js(`${pane('.code-pick')}.click()`);
      await waitFor(`${pane('.code-folder')}?.value === ${sel(FIX)} && !${A('.code-analyze-changes')}.disabled`, 10000);
      await waitFor(panelShown, 5000);
      await clickBy('.ca-tab', '요약');
      assert.equal(await js(`${A('.ca-summary')}.textContent.includes('SUMMARY-ALPHA')`), true, '폴더로 돌아왔는데 그 폴더의 결과가 안 보임');
      await js(`(() => { const s = ${A('.code-analyze-model')}; s.value = 'fable'; s.dispatchEvent(new Event('change')); })()`);
      const gateStop = deferred();
      scenario({ gate: gateStop, model: 'claude-fable-5-1' });
      const nStop = fake.spawns.length;
      await js(`${A('.code-analyze-changes')}.click()`);
      await waitCalls(() => fake.spawns.length === nStop + 1);
      await waitFor(statusHas('분석 중…'), 5000);
      await clickBy('.ca-act', '중단');
      await waitFor(`!!${A('.ca-banner')} && ${A('.ca-banner')}.textContent === '중단했습니다'`, 10000);
      await waitCalls(() => fake.spawns[nStop].closed);
      assert.equal(await js(`${A('.ca-summary')}.textContent.includes('SUMMARY-ALPHA')`), true, '중단했더니 이전 결과가 사라짐');
      assert.equal(await js(`${A('.ca-body')}.firstElementChild.classList.contains('ca-banner')`), true, '중단 안내가 본문 위 첫 줄이 아님');
      assert.equal(await js(`${A('.ca-status')}.textContent.includes('중단')`), false, '결과가 있는데 중단 문구가 상태 줄에 남음');
      assert.equal(await js(`${A('.code-analyze-changes')}.disabled`), false, '중단 뒤 다시 실행할 수 없음');
      scenario({ model: 'claude-fable-5-1' });
      await js(`${A('.code-analyze-changes')}.click()`);
      await waitFor(statusHas('claude-fable-5-1'), 10000);

      // 분석 중 다른 폴더로 전환: 늦게 끝난 결과가 그 폴더 화면을 덮지 않고, 돌아오면 이 폴더 결과가 보인다.
      const gateSwitch = deferred();
      scenario({ gate: gateSwitch, structured: resultOf('SWITCH-RESULT'), model: 'claude-fable-5-1' });
      const nSw = fake.spawns.length;
      await clickBy('.ca-act', '다시 분석');
      await waitCalls(() => fake.spawns.length === nSw + 1);
      await waitFor(statusHas('분석 중…'), 5000);
      await selectFolderUi(ROOT);
      await waitFor(`${A('.code-folder')}.value === ${sel(ROOT)}`, 5000);
      assert.equal(await js(panelShown), false, '분석 중 다른 폴더로 갔는데 분석 패널이 남음');
      gateSwitch.open();
      await settle(fake.spawns[nSw]);
      assert.equal(await js(panelShown), false, '늦게 끝난 결과가 다른 폴더 화면에 나타남');
      assert.equal(await js(`${A('.code-analysis')}.textContent.includes('SWITCH-RESULT')`), false);
      await selectFolderUi(FIX);
      await waitFor(`${A('.code-folder')}.value === ${sel(FIX)} && ${panelShown}`, 10000);
      await waitFor(`${A('.ca-summary')}?.textContent.includes('SWITCH-RESULT')`, 5000);
      await waitFor(`!${A('.code-analyze-changes')}.disabled`, 10000);

      // 패널을 닫은 뒤 분석이 끝나면 다시 보인다.
      const gateClose = deferred();
      scenario({ gate: gateClose, structured: resultOf('SWITCH-RESULT'), model: 'claude-fable-5-1' });
      const nCl = fake.spawns.length;
      await clickBy('.ca-act', '다시 분석');
      await waitCalls(() => fake.spawns.length === nCl + 1);
      await js(`${A('.ca-close')}.click()`);
      await waitFor(`!(${panelShown})`, 5000);
      // 실행 중에 닫으면 파일 머리줄에 「분석 중 m:ss」 단추가 생기고, 누르면 패널이 돌아온다.
      await waitFor(`!${A('.code-analysis-reopen')}.hidden && /^분석 중 \\d+:\\d\\d$/.test(${A('.code-analysis-reopen')}.textContent)`, 5000);
      await js(`${A('.code-analysis-reopen')}.click()`);
      await waitFor(`${panelShown} && ${statusHas('분석 중…')} && ${A('.code-analysis-reopen')}.hidden`, 5000);
      await js(`${A('.ca-close')}.click()`);
      await waitFor(`!(${panelShown})`, 5000);
      gateClose.open();
      await waitFor(`${panelShown} && ${statusHas('claude-fable-5-1')}`, 10000);
      // 끝난 뒤에 닫으면 「분석 결과」 단추, 누르면 돌아온다.
      await js(`${A('.ca-close')}.click()`);
      await waitFor(`!(${panelShown}) && !${A('.code-analysis-reopen')}.hidden && ${A('.code-analysis-reopen')}.textContent === '분석 결과'`, 5000);
      await js(`${A('.code-analysis-reopen')}.click()`);
      await waitFor(`${panelShown} && ${A('.code-analysis-reopen')}.hidden`, 5000);

      // 오류 결과(is_error): 한국어 문구, 이전 결과는 유지.
      scenario({ isError: true, errorText: '모델 오류 시험' });
      await clickBy('.ca-act', '다시 분석');
      await waitFor(bodyHas('분석 실패:\n모델 오류 시험'), 10000);
      assert.equal(await js(`${A('.ca-banner')}.classList.contains('err')`), true);
      assert.equal(await js(`${A('.ca-body')}.firstElementChild === ${A('.ca-banner')}`), true, '오류가 본문 위 첫 줄이 아님');
      assert.equal(await js(`${A('.ca-status')}.textContent.includes('분석 실패')`), false, '결과가 있는데 오류가 상태 줄에 있음');
      assert.equal(await js(`${A('.ca-summary')}.textContent.includes('SWITCH-RESULT')`), true, '실패했더니 이전 결과가 사라짐');
      assert.equal(await js(`${A('.code-analyze-changes')}.disabled`), false);

      // 이 파일 분석: 파일을 열어야 켜지고, 범위 표시가 파일 이름이며 프롬프트에 파일 범위가 담긴다.
      await js(`(() => { const s = ${A('.code-analyze-model')}; s.value = 'sonnet'; s.dispatchEvent(new Event('change')); })()`);
      await openPath('src/long.js');
      await waitFor(`${pane('.code-path')}.textContent === 'src/long.js' && ${viewText('.code-editor')}.includes('lng_')`, 20000);
      await waitFor(`!${A('.code-analyze-file')}.disabled`, 5000);
      scenario({ structured: resultOf('FILE-SCOPE') });
      const nFile = fake.spawns.length;
      await js(`${A('.code-analyze-file')}.click()`);
      await waitCalls(() => fake.spawns.length === nFile + 1);
      assert.ok(fake.spawns[nFile].prompt.includes('분석 범위: 파일 하나 (src/long.js)'));
      await waitFor(`${statusHas('claude-sonnet-5-5')} && ${A('.ca-summary')}?.textContent.includes('FILE-SCOPE')`, 10000);
      assert.equal(await js(`${A('.ca-scope')}.textContent`), 'long.js');
      await clickBy('.ca-tab', '읽는 순서');
      await capture('code-analysis-panel');
      // 분석 뒤에 그 파일이 바뀌면 「분석 후 코드가 바뀜」.
      assert.equal(await js(`${A('.ca-status')}.textContent.includes('분석 후 코드가 바뀜')`), false);
      fs.appendFileSync(path.join(FIX, 'src', 'long.js'), '// 분석 뒤에 덧붙인 줄\n');
      await js(`${A('.code-refresh')}.click()`);
      await waitFor(statusHas('분석 후 코드가 바뀜'), 10000);
      assert.equal(await js(`!${A('.ca-warn')}.hidden && ${A('.ca-status')}.firstElementChild === ${A('.ca-warn')}`), true, '경고가 상태 줄 앞에 없음');
      assert.ok(Number(await js(`getComputedStyle(${A('.ca-warn')}).fontWeight`)) >= 600, '경고가 강조되지 않음');

      // 범위 전환: 결과가 둘(이번 변경·long.js)이면 범위는 고르는 상자 — 고르면 그 결과가 보인다.
      assert.equal(await js(`!${A('.ca-scope-sel')}.hidden && ${A('.ca-scope')}.hidden`), true, '결과가 둘인데 범위 선택 상자가 없음');
      assert.deepEqual(await js(`[...${A('.ca-scope-sel')}.options].map(o => o.textContent)`), ['이번 변경', 'long.js']);
      assert.equal(await js(`${A('.ca-scope-sel')}.value`), 'file:src/long.js');
      const pickScope = value => js(`(() => { const s = ${A('.ca-scope-sel')}; s.value = ${sel(value)}; s.dispatchEvent(new Event('change')); })()`);
      await clickBy('.ca-tab', '요약');
      await pickScope('changes');
      await waitFor(`${A('.ca-summary')}?.textContent.includes('SWITCH-RESULT') && ${A('.ca-scope-sel')}.value === 'changes'`, 5000);

      // 분석 중에 코드가 바뀌면 끝난 뒤 「분석 후 코드가 바뀜」 — 시작 시점의 상태·시각을 기준으로 삼는다.
      // 결과: 긴 요약(본문 스크롤용)과 바이너리 파일을 가리키는 읽는 순서 항목.
      fs.writeFileSync(path.join(FIX, 'src', 'bin.dat'), Buffer.from([0x62, 0x00, 0x6e, 0x01, 0x02]));
      const staleResult = { ...resultOf('STALE-RUN'), summary: `요약 STALE-RUN\n${'긴 요약 줄입니다.\n'.repeat(60)}끝`,
        readingOrder: [...resultOf('x').readingOrder, { file: 'src/bin.dat', line: 1, anchor: 'b', why: 'BIN-ITEM 바이너리' },
          ...Array.from({ length: 40 }, (_, i) => ({ file: 'src/long.js', line: i + 2, anchor: anchorOf('lng', i + 2), why: `채움 항목 ${i + 1}` }))] };
      await js(`${A('.code-refresh')}.click()`);
      await waitFor(`(() => { const s = ${node('src')}; if (s && s.getAttribute('aria-expanded') !== 'true') s.click(); return !!${node('src/bin.dat')}; })()`, 10000);
      const gateStale = deferred();
      scenario({ gate: gateStale, structured: staleResult });
      const nSt = fake.spawns.length;
      // 트리가 그려진 뒤에도 상태 조회가 끝날 때까지 분석 단추는 꺼져 있다 (treeBusy). 꺼진 단추를 누르면 분석이 시작되지 않는다.
      await waitFor(`[...document.querySelectorAll('#code-pane .ca-act')].some(b => b.textContent.includes('다시 분석') && !b.disabled)`, 10000);
      await clickBy('.ca-act', '다시 분석');
      await waitCalls(() => fake.spawns.length === nSt + 1);
      put('src/during.js', 'export const during = 1;\n'); // 분석이 도는 중에 새 파일이 생김
      const pSt = calls.poll;
      await js(`${A('.code-refresh')}.click()`);
      await waitCalls(() => calls.poll > pSt);
      await waitFor(`!!${node('src/during.js')}`, 10000);
      assert.equal(await js(`${A('.ca-status')}.textContent.includes('분석 후 코드가 바뀜')`), false, '분석 중에는 아직 결과가 없어 바뀜 표시가 없어야 함');
      gateStale.open();
      await settle(fake.spawns[nSt]);
      await waitFor(`${A('.ca-summary')}?.textContent.includes('STALE-RUN') && !${A('.ca-warn')}.hidden && ${A('.ca-warn')}.textContent.includes('분석 후 코드가 바뀜')`, 10000);
      assert.equal(await js(`${A('.ca-status')}.firstElementChild === ${A('.ca-warn')}`), true);
      // 탭이나 결과가 바뀌면 본문 스크롤은 맨 위로
      assert.equal(await js(`${A('.ca-body')}.scrollHeight > ${A('.ca-body')}.clientHeight + 50`), true, '본문이 스크롤될 만큼 길지 않아 시험이 되지 않음');
      await js(`${A('.ca-body')}.scrollTop = 120`);
      assert.ok(await js(`${A('.ca-body')}.scrollTop`) > 50, '본문을 스크롤하지 못함');
      await clickBy('.ca-tab', '읽는 순서');
      assert.equal(await js(`${A('.ca-body')}.scrollTop`), 0, '탭을 바꿨는데 본문 스크롤이 남음');
      await js(`${A('.ca-body')}.scrollTop = 120`);
      assert.ok(await js(`${A('.ca-body')}.scrollTop`) > 50, '읽는 순서 목록이 스크롤될 만큼 길지 않아 시험이 되지 않음');
      await clickBy('.ca-tab', '요약');
      assert.equal(await js(`${A('.ca-body')}.scrollTop`), 0, '탭을 바꿨는데 본문 스크롤이 남음 (읽는 순서 → 요약)');
      await js(`${A('.ca-body')}.scrollTop = 120`);
      assert.ok(await js(`${A('.ca-body')}.scrollTop`) > 50);
      await pickScope('file:src/long.js');
      await waitFor(`${A('.ca-summary')}?.textContent.includes('FILE-SCOPE') && ${A('.ca-body')}.scrollTop === 0`, 5000);

      // 점프: 안내만 보이는 파일(바이너리)·읽는 중인 파일로의 점프도 오류 없이 처리한다 (콘솔 오류는 끝에서 한꺼번에 확인).
      await pickScope('changes');
      await waitFor(`${A('.ca-summary')}?.textContent.includes('STALE-RUN')`, 5000);
      await clickBy('.ca-tab', '읽는 순서');
      await waitFor(`document.querySelectorAll('#code-pane .ca-item').length === 44`, 5000);
      await openPath('src/bin.dat');
      await waitFor(`${pane('.code-path')}.textContent === 'src/bin.dat' && ${pane('.code-message')}.textContent.includes('바이너리') && getComputedStyle(${pane('.code-message')}).display !== 'none'`, 10000);
      await js(`document.querySelectorAll('#code-pane .ca-item')[3].click()`); // 열려 있는 바이너리 파일로
      await pause(300);
      assert.equal(await js(`${pane('.code-path')}.textContent`), 'src/bin.dat');
      assert.equal(await js(`${pane('.code-message')}.textContent.includes('바이너리')`), true);
      await openPath('README.md');
      await waitFor(`${pane('.code-path')}.textContent === 'README.md' && ${viewText('.code-editor')}.includes(${sel(firstLine)})`, 10000);
      await js(`document.querySelectorAll('#code-pane .ca-item')[3].click()`); // 다른 파일에서 바이너리 파일로
      await waitFor(`${pane('.code-path')}.textContent === 'src/bin.dat' && ${pane('.code-message')}.textContent.includes('바이너리')`, 10000);
      await openPath('README.md');
      await waitFor(`${pane('.code-path')}.textContent === 'README.md' && ${viewText('.code-editor')}.includes(${sel(firstLine)})`, 10000);
      // 읽는 중인 파일로 (파일을 누른 직후, 아직 읽기 전에 같은 파일로 점프) → 다 읽은 뒤 그 줄이 가운데에 온다.
      await js(`(() => { document.querySelector('#code-pane .code-node[data-path="src/diff-long.js"]').click(); document.querySelectorAll('#code-pane .ca-item')[2].click(); })()`);
      await waitFor(`${pane('.code-path')}.textContent === 'src/diff-long.js' && ${visible('.code-diff')} && !!document.querySelector('#code-pane .code-diff .line-delete')`, 20000);
      await pause(800);
      ed = await edInfo('src/diff-long.js');
      assert.ok(ed && ed.line === 120 && ed.vis && Math.abs(ed.off) < 40, `읽는 중 점프 위치: ${JSON.stringify(ed)}`);
      // 이미 열려 있는 비교 보기로 점프: 첫 변경 줄로 되돌아가지 않고 대상 줄이 가운데에 남는다.
      await js(`monaco.editor.getEditors().find(e => { const m = e.getModel(); return m && m.uri.scheme === 'disk' && m.uri.path === '/src/diff-long.js'; }).revealLineInCenter(1)`);
      await pause(300);
      await js(`document.querySelectorAll('#code-pane .ca-item')[2].click()`);
      await pause(800);
      ed = await edInfo('src/diff-long.js');
      assert.ok(ed && ed.line === 120 && ed.vis && Math.abs(ed.off) < 40, `열린 비교 보기 점프 위치: ${JSON.stringify(ed)}`);
      await pickScope('file:src/long.js'); // 이어지는 시험은 파일 범위가 고른 상태를 전제로 한다
      await clickBy('.ca-tab', '요약');
      await waitFor(`${A('.ca-summary')}?.textContent.includes('FILE-SCOPE')`, 5000);

      // ───────── 코드 위 주석 (view zone, 가짜 claude 결과) ─────────
      const noteSel = scope => `document.querySelectorAll('#code-pane ${scope} .code-analysis-note')`;
      const noteCount = scope => js(`${noteSel(scope)}.length`);
      const notesRaw = () => js(`[...${noteSel('')}].map(n => { const r = n.getBoundingClientRect(); return { text: n.textContent, top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, h: r.height, shown: n.getClientRects().length > 0, sh: n.scrollHeight, ch: n.clientHeight }; })`);
      const edSrc = rel => `monaco.editor.getEditors().find(e => { const m = e.getModel(); return m && m.uri.scheme === 'disk' && m.uri.path === ${sel('/' + rel)}; })`;
      const modelHas = (rel, text) => `monaco.editor.getModels().some(m => m.uri.scheme === 'disk' && m.uri.path === ${sel('/' + rel)} && m.getValue().includes(${sel(text)}))`;
      // 줄 번호 요소의 top 과 그 줄 바로 위 주석의 bottom 을 비교한다.
      const noteGeom = (rel, line, tag) => js(`(() => {
        const ed = ${edSrc(rel)}; if (!ed) return { ed: false };
        const dom = ed.getDomNode();
        const num = [...dom.querySelectorAll('.margin-view-overlays .line-numbers')].find(e => e.textContent.trim() === ${sel(String(line))} && e.getClientRects().length);
        const note = [...dom.querySelectorAll('.code-analysis-note')].find(e => e.textContent.includes(${sel(tag)}) && e.getClientRects().length);
        if (!num || !note) return { ed: true, num: !!num, note: !!note };
        return { ed: true, numTop: num.getBoundingClientRect().top, noteTop: note.getBoundingClientRect().top, noteBottom: note.getBoundingClientRect().bottom, title: note.querySelector('.can-title').textContent };
      })()`);
      const revealCenter = async (rel, line) => { await js(`${edSrc(rel)}.revealLineInCenter(${line})`); await pause(300); };
      const expectAbove = async (rel, line, tag) => {
        await revealCenter(rel, line);
        const g = await noteGeom(rel, line, tag);
        assert.ok(g.numTop !== undefined && Math.abs(g.noteBottom - g.numTop) <= 2 && g.noteTop < g.numTop, `주석이 ${line}줄 바로 위가 아님 (${tag}): ${JSON.stringify(g)}`);
        assert.ok(g.title.startsWith(`▾ L${line} `) || g.title.startsWith(`▸ L${line} `), `제목에 줄 번호가 없음 (${tag}): ${g.title}`);
      };
      // 비교 보기에서 그 줄 바로 위에 삭제 줄이 끼는 주석: 주석은 삭제 블록 위에 놓이고(주석 bottom ≤ 첫 삭제 줄 top),
      // 인라인 비교의 원본 편집기 줄 번호(origLine)와 첫 삭제 줄의 top 이 같다 (삭제 줄 영역이 제 자리에 있다).
      const expectAboveDeleted = async (rel, line, tag, origLine) => {
        await revealCenter(rel, line);
        const g = await js(`(() => {
          const ed = ${edSrc(rel)}; if (!ed) return { ed: false };
          const dom = ed.getDomNode();
          const orig = monaco.editor.getEditors().find(e => { const m = e.getModel(); return m && m.uri.scheme === 'git-head' && m.uri.path === ${sel('/' + rel)}; });
          const note = [...dom.querySelectorAll('.code-analysis-note')].find(e => e.textContent.includes(${sel(tag)}) && e.getClientRects().length);
          const del = [...dom.querySelectorAll('.line-delete')].find(e => e.getClientRects().length);
          const num = orig && [...orig.getDomNode().querySelectorAll('.line-numbers')].find(e => e.textContent.trim() === ${sel(String(origLine))} && e.getClientRects().length);
          const t = e => e && e.getBoundingClientRect().top;
          return { ed: true, note: !!note, del: !!del, orig: !!orig, num: !!num, noteBottom: note && note.getBoundingClientRect().bottom, delTop: t(del), numTop: t(num), title: note && note.querySelector('.can-title').textContent };
        })()`);
        assert.ok(g.note && g.del && g.num, `삭제 줄 비교에 필요한 요소가 없음 (${tag}): ${JSON.stringify(g)}`);
        assert.ok(g.noteBottom <= g.delTop + 2, `주석이 첫 삭제 줄 위가 아님 (${tag}): ${JSON.stringify(g)}`);
        assert.ok(Math.abs(g.numTop - g.delTop) <= 2, `원본 ${origLine}줄 번호와 첫 삭제 줄의 위치가 다름 (${tag}): ${JSON.stringify(g)}`);
        assert.ok(g.title.includes(`L${line} ${tag}`), `제목에 줄 번호가 없음 (${tag}): ${g.title}`);
      };
      const firstVisExpr = rel => `${edSrc(rel)}.getVisibleRanges()[0].startLineNumber`;
      const firstVis = rel => js(`${edSrc(rel)}.getVisibleRanges()[0].startLineNumber`);
      const scrollToLine = async (rel, line) => { await js(`(() => { const ed = ${edSrc(rel)}; ed.setScrollTop(ed.getTopForLineNumber(${line})); })()`); await pause(300); };
      const reloadFile = async (rel, cond) => {
        const p = calls.poll;
        await js(`${A('.code-refresh')}.click()`);
        await waitCalls(() => calls.poll > p);
        await waitFor(cond, 10000);
      };
      const rewrite = (rel, fn) => { const lines = fs.readFileSync(path.join(FIX, rel), 'utf8').split('\n'); fn(lines); put(rel, lines.join('\n')); };
      const clickAt = async (x, y) => {
        x = Math.round(x); y = Math.round(y);
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y }); await pause(80);
        win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); await pause(50);
        win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await pause(300);
      };
      const hit = (a, b) => a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1;
      const noteResult = (tag, annotations) => ({ summary: `주석 시험 ${tag}`, readingOrder: [], annotations, keywords: [] });
      const ann = (file, line, anchor, title, text) => ({ file, line, anchor, title, text });
      const XSS = '<img src=x onerror="window.__xss=1">';

      // 준비: 중괄호만 있는 줄이 여럿인 새 파일 · 아주 긴 줄이 든 새 파일 (둘 다 미추적).
      put('src/braces.js', ['function f() {', '  return 1;', '}', 'function g() {', '  return 2;', '}', ''].join('\n'));
      put('src/wide.js', ['// wide', 'const short = 1;', `const long = "${'x'.repeat(3000)}";`, 'export { short, long };', ''].join('\n'));
      await js(`${A('.code-refresh')}.click()`);
      await waitFor(`(() => { const s = ${node('src')}; if (s && s.getAttribute('aria-expanded') !== 'true') s.click(); return !!${node('src/braces.js')} && !!${node('src/wide.js')}; })()`, 10000);

      // 변경 비교 보기(diff-long.js)가 열린 채 「이번 변경 분석」이 끝나면 주석이 나타난다. 삭제 줄 영역(4~13줄)이 끼는 파일이다.
      await openPath('src/diff-long.js');
      await waitFor(`${pane('.code-path')}.textContent === 'src/diff-long.js' && ${visible('.code-diff')}`, 20000);
      await waitFor(`!!document.querySelector('#code-pane .code-diff .line-delete')`, 10000);
      assert.equal(await noteCount(''), 0, '분석 전에 주석이 있음');
      await waitFor(`!${A('.code-analyze-changes')}.disabled`, 10000);
      scenario({ structured: noteResult('NOTES-CHANGES', [
        ann('src/diff-long.js', 4, anchorOf('dif', 14), 'DEL-NEXT', '삭제된 줄 바로 아래 줄의 설명입니다. 두 문장 이내로 씁니다.'),
        ann('src/diff-long.js', 120, anchorOf('dif', 130), 'DIFF-FAR', '멀리 떨어진 줄의 설명입니다.'),
        ann('src/braces.js', 3, '}', 'BRACE-A', '닫는 중괄호를 기준으로 한 주석입니다.'),
        ann('src/braces.js', 4, 'function g() {', 'BRACE-B', 'g 함수의 설명입니다.'),
        ann('src/wide.js', 2, 'const short = 1;', 'WIDE-NOTE', '긴 줄이 있는 파일의 주석입니다. 폭이 넓어지지 않아야 합니다.'),
      ]) });
      const nNotes = fake.spawns.length;
      await js(`${A('.code-analyze-changes')}.click()`);
      await waitCalls(() => fake.spawns.length === nNotes + 1);
      await waitFor(`${noteSel('')}.length === 2`, 10000);
      let raw = await notesRaw();
      assert.ok(raw.some(n => n.text.includes('DEL-NEXT') && n.text.includes('삭제된 줄 바로 아래')) && raw.some(n => n.text.includes('DIFF-FAR')), JSON.stringify(raw));
      assert.equal(await noteCount('.code-diff'), 2, '주석이 비교 보기 안에 없음');
      await expectAboveDeleted('src/diff-long.js', 4, 'DEL-NEXT', 4);
      await expectAbove('src/diff-long.js', 120, 'DIFF-FAR');
      // 삭제 줄 영역과 주석이 겹치지 않는다 (둘 다 보이는 자리에서).
      await revealCenter('src/diff-long.js', 4);
      const boxes = await js(`(() => {
        const rect = e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
        return { notes: [...${noteSel('.code-diff')}].filter(n => n.getClientRects().length).map(n => ({ ...rect(n), text: n.textContent.slice(0, 12) })),
          dels: [...${edSrc('src/diff-long.js')}.getDomNode().querySelectorAll('.line-delete')].filter(e => e.getClientRects().length).map(rect).filter(r => r.w > 0 && r.h > 0) };
      })()`);
      assert.ok(boxes.notes.length >= 1 && boxes.dels.length >= 1, `겹침 확인할 대상이 없음: ${JSON.stringify(boxes)}`);
      for (const n of boxes.notes) {
        for (const d of boxes.dels) assert.ok(!hit(n, d), `주석이 삭제 줄 영역과 겹침: ${JSON.stringify({ n, d })}`);
        for (const m of boxes.notes) if (m !== n) assert.ok(!hit(n, m), `주석끼리 겹침: ${JSON.stringify({ n, m })}`);
      }
      await capture('code-analysis-notes');

      // 이 파일 분석(long.js): 파일 결과가 있으면 변경 결과보다 먼저 쓴다. 주석 내용의 <img> 는 글자로만 보인다.
      await openPath('src/long.js');
      await waitFor(`${pane('.code-path')}.textContent === 'src/long.js' && ${visible('.code-diff')}`, 20000);
      assert.equal(await noteCount(''), 1, '다른 파일 주석이 남아 있거나 이전 결과의 주석이 없음'); // 앞선 시험의 이 파일 결과 주석 1개
      await waitFor(`!${A('.code-analyze-file')}.disabled`, 10000);
      scenario({ structured: noteResult('NOTES-FILE', [
        ann('src/long.js', 20, anchorOf('lng', 20), 'LONG-A', 'A 설명입니다. 이 함수는 호출 관계와 전제 조건을 한 줄보다 길게 풀어 써서 줄바꿈이 일어나는지 봅니다.'),
        ann('src/long.js', 60, anchorOf('lng', 60), `${XSS} LONG-B`, `<b>굵게</b> ${XSS} 본문입니다.`),
        ann('src/long.js', 100, anchorOf('lng', 100), 'LONG-C', 'C 설명입니다.'),
      ]) });
      const nFileNotes = fake.spawns.length;
      await js(`${A('.code-analyze-file')}.click()`);
      await waitCalls(() => fake.spawns.length === nFileNotes + 1);
      await waitFor(`${noteSel('')}.length === 3`, 10000);
      raw = await notesRaw();
      assert.ok(!raw.some(n => n.text.includes('DEL-NEXT')), '변경 결과의 주석이 파일 결과와 섞임');
      assert.equal(await noteCount('.code-diff'), 3);
      assert.equal(await js(`${noteSel('')}[1].textContent.includes('<img src=x')`), true, '<img> 가 글자로 표시되지 않음');
      assert.equal(await js(`document.querySelectorAll('#code-pane .code-analysis-note img, #code-pane .code-analysis-note b').length`), 0, '주석 안에 요소가 만들어짐');
      assert.equal(await js(`window.__xss`), undefined, '주석 안의 스크립트가 실행됨');
      await expectAbove('src/long.js', 20, 'LONG-A');
      await expectAbove('src/long.js', 60, 'LONG-B');
      await expectAbove('src/long.js', 100, 'LONG-C');

      // 비교 ↔ 일반 전환: 주석 수가 유지되고 다른 편집기에는 남지 않는다.
      await js(`${pane('.code-diff-toggle')}.click()`);
      await waitFor(`${visible('.code-editor')} && !${visible('.code-diff')}`, 10000);
      await waitFor(`${noteSel('')}.length === 3`, 5000);
      assert.equal(await noteCount('.code-editor'), 3, '일반 보기로 바꾸자 주석이 편집기 밖에 있음');
      await expectAbove('src/long.js', 20, 'LONG-A');
      await js(`${pane('.code-diff-toggle')}.click()`);
      await waitFor(`${visible('.code-diff')} && ${noteSel('.code-diff')}.length === 3 && ${noteSel('')}.length === 3`, 10000);
      assert.equal(await noteCount('.code-editor'), 0, '비교 보기로 돌아왔는데 일반 편집기에 주석이 남음');

      // 실제 마우스로 주석을 누르면 접히고(높이 감소·본문 숨김) 다시 누르면 펴진다.
      await revealCenter('src/long.js', 20);
      const a0 = (await notesRaw()).find(n => n.text.includes('LONG-A'));
      assert.ok(a0 && a0.shown && a0.text.includes('A 설명'), JSON.stringify(a0));
      await clickAt((a0.left + a0.right) / 2, (a0.top + a0.bottom) / 2);
      await waitFor(`![...${noteSel('')}].find(n => n.textContent.includes('LONG-A')).textContent.includes('A 설명')`, 5000);
      const a1 = (await notesRaw()).find(n => n.text.includes('LONG-A'));
      assert.ok(a1.h < a0.h - 5, `접었는데 높이가 줄지 않음: ${a0.h} → ${a1.h}`);
      await expectAbove('src/long.js', 20, 'LONG-A');

      // 파일 수정 뒤 재로드 (1): 보는 자리 위에 주석이 있어도 같은 줄이 첫 줄로 남는다 · 접힘 유지.
      await scrollToLine('src/long.js', 80);
      const fvA = await firstVis('src/long.js');
      assert.ok(fvA >= 70 && fvA <= 82, `스크롤 준비 실패: ${fvA}`);
      rewrite('src/long.js', lines => { lines.splice(lines.length - 1, 0, '// 두 번째 덧붙인 줄'); });
      await reloadFile('src/long.js', modelHas('src/long.js', '두 번째 덧붙인 줄'));
      await waitFor(`${noteSel('')}.length === 3`, 10000);
      await waitFor(`${firstVisExpr('src/long.js')} === ${fvA}`, 5000); // 재로드 뒤에도 첫 보이는 줄이 그대로
      raw = await notesRaw();
      assert.ok(!raw.some(n => n.text.includes('위치 추정')), '밀리지 않았는데 위치 추정 표시');
      assert.ok(!raw.find(n => n.text.includes('LONG-A')).text.includes('A 설명'), '재로드 뒤 접힘이 풀림');

      // 재로드 (2): 줄이 밀리면 기준 줄로 다시 찾아 「(위치 추정)」, 첫 보이는 줄 유지.
      await scrollToLine('src/long.js', 30);
      const fvB = await firstVis('src/long.js');
      rewrite('src/long.js', lines => { lines.splice(69, 0, '// 끼워 넣은 줄'); });
      await reloadFile('src/long.js', modelHas('src/long.js', '끼워 넣은 줄'));
      await waitFor(`${noteSel('')}.length === 3`, 10000);
      await waitFor(`${firstVisExpr('src/long.js')} === ${fvB}`, 5000); // 줄이 밀린 재로드 뒤에도 첫 보이는 줄이 그대로
      raw = await notesRaw();
      assert.deepEqual(raw.filter(n => n.text.includes('위치 추정')).map(n => n.text.slice(0, 13)), ['▾ L101 LONG-C'], JSON.stringify(raw.map(n => n.text.slice(0, 20))));
      await expectAbove('src/long.js', 101, 'LONG-C');

      // 재로드 (3): 기준 줄이 사라지면 그 주석만 숨기고 안내한다.
      rewrite('src/long.js', lines => { lines.splice(lines.findIndex(l => l.includes('lng_100(')), 1); });
      await reloadFile('src/long.js', '!' + modelHas('src/long.js', 'lng_100('));
      await waitFor(`${noteSel('')}.length === 2`, 10000);
      await waitFor(statusHas('주석 1개는 위치를 찾지 못해 숨김'), 5000);
      // 접어 둔 주석을 다시 눌러 편다.
      await revealCenter('src/long.js', 20);
      const c0 = (await notesRaw()).find(n => n.text.includes('LONG-A'));
      await clickAt((c0.left + c0.right) / 2, (c0.top + c0.bottom) / 2);
      await waitFor(`[...${noteSel('')}].find(n => n.textContent.includes('LONG-A')).textContent.includes('A 설명')`, 5000);

      // 코드 화면을 숨긴 채 분석이 끝나고 돌아와도 높이가 정상이다 (글자마다 줄바꿈되지 않음).
      const gateHid = deferred();
      scenario({ gate: gateHid, structured: noteResult('NOTES-HIDDEN', [
        ann('src/long.js', 20, anchorOf('lng', 20), 'HID-A', '숨겨진 채 끝난 분석의 주석입니다. 돌아와도 높이가 정상이어야 합니다.'),
        ann('src/long.js', 60, anchorOf('lng', 60), 'HID-B', '두 번째 주석입니다.'),
      ]) });
      const nHid = fake.spawns.length;
      await clickBy('.ca-act', '다시 분석');
      await waitCalls(() => fake.spawns.length === nHid + 1);
      await js(`document.querySelector('#mode-office').click()`); await pause(300);
      assert.equal(await js(`document.querySelector('#code-pane').hidden`), true);
      gateHid.open();
      await settle(fake.spawns[nHid]);
      await js(`document.querySelector('#mode-code').click()`);
      await waitFor(`${noteSel('')}.length === 2 && ${noteSel('')}[0].textContent.includes('HID-A')`, 10000);
      await revealCenter('src/long.js', 20);
      raw = (await notesRaw()).filter(n => n.shown);
      assert.ok(raw.length >= 1, '돌아왔는데 보이는 주석이 없음');
      for (const n of raw) assert.ok(n.h > 20 && n.h < 110 && n.sh <= n.ch + 1 && n.width > 200, `숨긴 채 끝난 분석의 주석 높이가 이상함: ${JSON.stringify(n)}`);

      // 중괄호만 있는 기준: 줄이 그대로면 붙고, 줄이 밀리면 어디가 맞는지 알 수 없어 숨긴다 (고유한 기준 줄만 따라간다).
      await openPath('src/braces.js');
      await waitFor(`${pane('.code-path')}.textContent === 'src/braces.js' && ${visible('.code-editor')} && ${noteSel('')}.length === 2`, 20000);
      assert.equal(await js(`[...${noteSel('')}].every(n => /BRACE-/.test(n.textContent))`), true, '다른 파일의 주석이 섞임');
      rewrite('src/braces.js', lines => { lines.unshift('// 첫 줄', '// 둘째 줄'); });
      await reloadFile('src/braces.js', modelHas('src/braces.js', '둘째 줄'));
      await waitFor(`${noteSel('')}.length === 1`, 10000);
      raw = await notesRaw();
      assert.ok(raw[0].text.includes('BRACE-B') && raw[0].text.includes('위치 추정'), JSON.stringify(raw));
      await waitFor(statusHas('주석 1개는 위치를 찾지 못해 숨김'), 5000);

      // 긴 줄이 있는 파일: 주석 폭이 편집기 내용 폭을 넘지 않는다.
      await openPath('src/wide.js');
      await waitFor(`${pane('.code-path')}.textContent === 'src/wide.js' && ${visible('.code-editor')} && ${noteSel('')}.length === 1`, 20000);
      await pause(300);
      const wide = await js(`(() => { const ed = ${edSrc('src/wide.js')}; const n = document.querySelector('#code-pane .code-analysis-note'); return { cw: ed.getLayoutInfo().contentWidth, sw: ed.getScrollWidth(), nw: n.offsetWidth }; })()`);
      assert.ok(wide.sw > wide.cw + 100, `긴 줄이 가로로 넘치지 않아 시험이 되지 않음: ${JSON.stringify(wide)}`);
      assert.ok(wide.nw <= wide.cw && wide.nw > 100, `긴 줄 때문에 주석 폭이 넓어짐: ${JSON.stringify(wide)}`);

      // 「주석 표시」 끄면 0개, 켜면 복원. 주석이 없는 문서에는 아무것도 없고, 측정 요소가 편집기 밖에 남지 않는다.
      await openPath('src/diff-long.js');
      await waitFor(`${pane('.code-path')}.textContent === 'src/diff-long.js' && ${visible('.code-diff')} && ${noteSel('')}.length === 2`, 20000);
      await clickBy('.ca-notes', '주석 표시');
      await waitFor(`${noteSel('')}.length === 0 && ${A('.ca-notes')}.getAttribute('aria-pressed') === 'false'`, 5000);
      await clickBy('.ca-notes', '주석 표시');
      await waitFor(`${noteSel('')}.length === 2 && ${A('.ca-notes')}.getAttribute('aria-pressed') === 'true'`, 5000);
      await openPath('README.md');
      await waitFor(`${pane('.code-path')}.textContent === 'README.md' && ${visible('.code-editor')}`, 10000);
      assert.equal(await noteCount(''), 0, '주석이 없는 파일에 상자가 있음');
      assert.equal(await js(`document.querySelectorAll('.code-analysis-note').length`), 0, '편집기 밖에 주석 노드가 남음 (측정 요소 누수)');

      // 500줄 파일 중간(250줄 근처)을 보던 중 분석이 끝나도, 주석 표시를 끄고 켜도, 코드 화면을 다녀와도 첫 보이는 줄이 그대로다 (주석은 보는 자리 위아래에 모두 있다).
      put('src/mid500.js', longLines('mid', 500).join('\n') + '\n');
      await js(`${A('.code-refresh')}.click()`);
      await waitFor(`(() => { const s = ${node('src')}; if (s && s.getAttribute('aria-expanded') !== 'true') s.click(); return !!${node('src/mid500.js')}; })()`, 10000);
      await openPath('src/mid500.js');
      await waitFor(`${pane('.code-path')}.textContent === 'src/mid500.js' && ${visible('.code-editor')} && ${viewText('.code-editor')}.includes('mid_')`, 20000);
      await scrollToLine('src/mid500.js', 250);
      const fvM = await firstVis('src/mid500.js');
      assert.ok(fvM >= 240 && fvM <= 255, `스크롤 준비 실패: ${fvM}`);
      scenario({ structured: noteResult('NOTES-MID', [100, 200, 300, 400].map(k => ann('src/mid500.js', k, anchorOf('mid', k), `MID-${k}`, `${k}줄 주석입니다. 보는 자리 ${k < 250 ? '위' : '아래'}에 있습니다.`))) });
      const nMid = fake.spawns.length;
      await js(`${A('.code-analyze-changes')}.click()`);
      await waitCalls(() => fake.spawns.length === nMid + 1);
      await waitFor(`${noteSel('')}.length === 4`, 10000);
      await waitFor(`${firstVisExpr('src/mid500.js')} === ${fvM}`, 5000);
      await clickBy('.ca-notes', '주석 표시');
      await waitFor(`${noteSel('')}.length === 0 && ${firstVisExpr('src/mid500.js')} === ${fvM}`, 5000);
      await clickBy('.ca-notes', '주석 표시');
      await waitFor(`${noteSel('')}.length === 4 && ${firstVisExpr('src/mid500.js')} === ${fvM}`, 5000);
      await js(`document.querySelector('#mode-office').click()`); await pause(300);
      await js(`document.querySelector('#mode-code').click()`);
      await waitFor(`${noteSel('')}.length === 4 && ${firstVisExpr('src/mid500.js')} === ${fvM}`, 10000);

      // 좁은 창(1100x680)에서 CLI 영역을 최대로 넓혀도 머리줄이 넘치지 않고 코드 영역이 남는다.
      await clickBy('.ca-tab', '요약');
      win.setSize(1100, 680); await pause(500);
      await js(`(() => { const l = document.querySelector('.layout'); l.style.setProperty('--cli-width', (l.clientWidth - 420) + 'px'); })()`);
      await pause(500);
      const small = await js(`(() => {
        const fits = s => { const e = document.querySelector('#code-pane ' + s); return { s, sw: e.scrollWidth, cw: e.clientWidth }; };
        const view = document.querySelector('#code-pane .code-view').getBoundingClientRect();
        const main = document.querySelector('#code-pane .code-main').getBoundingClientRect();
        const h = s => Math.round(document.querySelector('#code-pane ' + s).getBoundingClientRect().height);
        return { heads: ['.code-file-head', '.cb-tabs', '.code-bottom', '.ca-head', '.code-analysis', '.ca-body', '.code-analyze', '.git-panel', '.gp-head', '.gp-actions', '.gp-fixed'].map(fits), heights: { pane: h('.code-main'), head: h('.code-head'), file: h('.code-file-head'), analysis: h('.code-analysis'), caHead: h('.ca-head'), caBody: h('.ca-body') }, gpButtons: [...document.querySelectorAll('#code-pane .gp-actions button')].map(b => ({ s: b.textContent, sw: b.scrollWidth, cw: b.clientWidth })), viewH: view.height, mainW: main.width, noPageScroll: document.documentElement.scrollWidth <= innerWidth };
      })()`);
      for (const h of small.heads) assert.ok(h.sw <= h.cw, `좁은 창에서 넘침: ${JSON.stringify(small)}`);
      for (const b of small.gpButtons) assert.ok(b.sw <= b.cw, `좁은 창에서 Git 단추 글자가 잘림: ${JSON.stringify(small.gpButtons)}`);
      assert.equal(small.gpButtons.length, 3);
      assert.ok(small.viewH >= 150, `코드 영역이 너무 작음: ${JSON.stringify(small)}`);
      assert.ok(small.heights.caBody >= 60, `분석 패널 본문이 너무 작음: ${JSON.stringify(small)}`);
      assert.ok(small.mainW < 200 && small.noPageScroll, JSON.stringify(small));
      narrowAnalysis = small;
      await js(`document.querySelector('.layout').style.removeProperty('--cli-width')`);
      win.setSize(1600, 1000); await pause(500);

      // 왼쪽 목록 너비가 바뀌면 열려 있는 편집기도 따라간다 (끌기 자체는 아래 ⑭ 에서 시험한다 — 그때는 열린 편집기가 없다).
      const monacoFits = async () => { await pause(400); return js(`(() => { const w = s => Math.round(document.querySelector('#code-pane ' + s).getBoundingClientRect().width); return { side: w('.code-side'), view: w('.code-view'), monaco: w('.code-editor .monaco-editor') }; })()`); };
      await js(`${pane('.code-body')}.style.setProperty('--code-side-w', '380px')`);
      const monacoWide = await monacoFits();
      assert.ok(monacoWide.side === 380 && monacoWide.monaco > 0 && Math.abs(monacoWide.monaco - monacoWide.view) <= 2, `왼쪽 목록을 넓혀도 편집기 너비가 따라가지 않음: ${JSON.stringify(monacoWide)}`);
      await js(`${pane('.code-body')}.style.removeProperty('--code-side-w')`);
      const monacoBack = await monacoFits();
      assert.ok(monacoBack.side === 280 && Math.abs(monacoBack.monaco - monacoBack.view) <= 2 && monacoBack.monaco > monacoWide.monaco, `왼쪽 목록을 되돌려도 편집기 너비가 따라가지 않음: ${JSON.stringify({ monacoWide, monacoBack })}`);

      // 분석 패널 높이 조절: 위쪽 경계를 끌어 높이고 낮추며, 편집기 최소 높이·패널 머리줄은 남기고, 두 번 클릭하면 기본 높이.
      // 높이를 갖는 쪽은 하단 영역(.code-bottom)이라 패널 높이 = 하단 영역 높이, 머리줄 = 탭줄(.cb-tabs) + 분석 머리줄(.ca-head).
      const caBox = () => js(`(() => { const h = s => Math.round(document.querySelector('#code-pane ' + s).getBoundingClientRect().height);
        return { panel: h('.code-bottom'), view: h('.code-view'), head: h('.cb-tabs') + h('.ca-head'), saved: localStorage.getItem('ao.analysisHeight') }; })()`);
      const grip = await js(`(() => { const r = ${A('.ca-resizer')}.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      const dragCa = async (dy) => {
        const g = await js(`(() => { const r = ${A('.ca-resizer')}.getBoundingClientRect(); return Math.round(r.top + r.height / 2); })()`);
        // 끄는 동안의 이동에는 단추 눌림 상태를 실어야 한다 — 없으면 Chromium 이 포인터 캡처를 바로 푼다.
        const ev = (type, y) => win.webContents.sendInputEvent({ type, x: grip.x, y, button: 'left', clickCount: 1, ...(type === 'mouseMove' ? { modifiers: ['leftButtonDown'] } : {}) });
        win.webContents.sendInputEvent({ type: 'mouseMove', x: grip.x, y: g }); await pause(50);
        ev('mouseDown', g); for (let i = 1; i <= 5; i++) { ev('mouseMove', g + Math.round(dy * i / 5)); await pause(30); } ev('mouseUp', g + dy);
        await pause(300);
      };
      const ca0 = await caBox();
      assert.equal(ca0.saved, null, '조절 전 저장값이 있음');
      await dragCa(-150);
      const caUp = await caBox();
      assert.ok(Math.abs(caUp.panel - (ca0.panel + 150)) <= 2 && caUp.view < ca0.view, `위로 끌어도 패널이 높아지지 않음: ${JSON.stringify({ ca0, caUp })}`);
      assert.equal(Number(caUp.saved), caUp.panel, '조절한 높이를 저장하지 않음');
      await dragCa(2000);
      const caLow = await caBox();
      assert.equal(caLow.panel, caLow.head + 48, `가장 낮게 끌면 머리줄+48px(경계선 포함)이어야 함: ${JSON.stringify(caLow)}`);
      assert.equal(Number(caLow.saved), caLow.panel, '범위 밖으로 끈 값 대신 실제 높이를 저장해야 함');
      await dragCa(-2000);
      const caHigh = await caBox();
      assert.ok(caHigh.view >= 119 && caHigh.view <= 122, `가장 높게 끌어도 편집기 120px 는 남아야 함: ${JSON.stringify(caHigh)}`);
      win.webContents.sendInputEvent({ type: 'mouseDown', x: grip.x, y: (await js(`Math.round(${A('.ca-resizer')}.getBoundingClientRect().top + 4)`)), button: 'left', clickCount: 2 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: grip.x, y: (await js(`Math.round(${A('.ca-resizer')}.getBoundingClientRect().top + 4)`)), button: 'left', clickCount: 2 });
      await pause(300);
      const caReset = await caBox();
      assert.ok(caReset.panel === ca0.panel && caReset.saved === null, `두 번 클릭해도 기본 높이로 돌아가지 않음: ${JSON.stringify({ ca0, caReset })}`);
      analysisResize = { default: ca0.panel, up: caUp.panel, lowest: caLow.panel, highestView: caHigh.view, reset: caReset.panel };

      // 폴더당 분석 결과는 30개까지: 파일 분석을 31번 하면 가장 오래된 결과부터 사라지고, 지금 고른 범위(마지막 파일)는 남는다.
      for (let i = 1; i <= 31; i++) put(`cap/c${String(i).padStart(2, '0')}.js`, `export const c${i} = ${i};\n`);
      await js(`${A('.code-refresh')}.click()`);
      await waitFor(`(() => { const s = ${node('cap')}; if (s && s.getAttribute('aria-expanded') !== 'true') s.click(); return !!${node('cap/c31.js')}; })()`, 10000);
      scenario({ structured: resultOf('CAP') });
      for (let i = 1; i <= 31; i++) {
        const rel = `cap/c${String(i).padStart(2, '0')}.js`;
        await openPath(rel);
        await waitFor(`${pane('.code-path')}.textContent === ${sel(rel)} && ${visible('.code-editor')} && !${A('.code-analyze-file')}.disabled`, 20000);
        const nCap = fake.spawns.length;
        await js(`${A('.code-analyze-file')}.click()`);
        await waitCalls(() => fake.spawns.length === nCap + 1);
        await waitFor(`${A('.ca-scope-sel')}?.value === ${sel('file:' + rel)} && !${A('.code-analyze-file')}.disabled`, 10000);
      }
      const kept = await js(`[...${A('.ca-scope-sel')}.options].map(o => o.title)`);
      assert.equal(kept.length, 30, `결과가 30개로 제한되지 않음: ${kept.length}`);
      assert.ok(kept.includes('cap/c31.js') && kept.includes('cap/c02.js'), JSON.stringify(kept));
      assert.ok(!kept.includes('cap/c01.js'), '가장 오래된 결과가 남음');

      // ───────── Git 패널: 실제 code:git:* IPC (임시 저장소 GITFX · 원격 REMOTE · 다른 작업자 CLONE, 모두 임시 폴더) ─────────
      const GITFX = path.join(FIXBASE, 'gitfx'), REMOTE = path.join(FIXBASE, 'remote.git'), CLONE = path.join(FIXBASE, 'clone'), PLAIN = path.join(FIXBASE, 'plain');
      const gx = (...args) => gitAt(GITFX, ...args);
      const putG = (rel, text, base = GITFX) => { const f = path.join(base, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
      fs.mkdirSync(GITFX); fs.mkdirSync(PLAIN); putG('x.txt', 'x\n', PLAIN);
      gitAt(FIXBASE, 'init', '-q', '--bare', '-b', 'main', REMOTE);
      gx('init', '-q', '-b', 'main');
      gx('config', 'user.name', 'fx'); gx('config', 'user.email', 'fx@fx.test'); gx('config', 'core.autocrlf', 'false');
      putG('a.txt', 'one\n'); putG('docs/b.txt', 'bee\n'); putG('sub/in.txt', 'in\n'); putG('한글 파일.txt', '가나\n');
      gx('add', '-A'); gx('commit', '-q', '-m', 'init');
      const headOf = () => gx('rev-parse', 'HEAD').trim();
      const remoteHead = () => { try { return gitAt(FIXBASE, '--git-dir', REMOTE, 'rev-parse', 'main').trim(); } catch { return ''; } };
      const cachedNames = () => gx('-c', 'core.quotepath=false', 'diff', '--cached', '--name-only').split('\n').filter(Boolean).sort();
      const gpHeads = () => js(`[...document.querySelectorAll('#code-pane .gp-h')].filter(h => !h.hidden).map(h => h.querySelector('.gp-h-text').textContent)`);
      const gpList = list => js(`[...document.querySelectorAll('#code-pane .gp-${list} .gp-file')].map(b => b.dataset.path)`);
      const gpBadges = list => js(`Object.fromEntries([...document.querySelectorAll('#code-pane .gp-${list} li')].filter(li => li.querySelector('.gp-file')).map(li => [li.querySelector('.gp-file').dataset.path, li.querySelector('.code-badge').textContent]))`);
      const gpAct = (act, rel) => pane(`.gp-act[data-act=${act}][data-path=${sel(rel)}]`);
      const gpSet = text => js(`(() => { const t = ${pane('.gp-msg')}; t.value = ${sel(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      const gpVal = () => js(`${pane('.gp-msg')}.value`);
      const gpNote = () => js(`${pane('.gp-note')}.hidden ? '' : ${pane('.gp-note-text')}.textContent`);
      const gpNoteHas = text => `!${pane('.gp-note')}.hidden && ${pane('.gp-note-text')}.textContent.includes(${sel(text)})`;
      const gpOff = cls => js(`${pane('.' + cls)}.disabled`);
      const gpConfirmText = () => js(`${pane('.gp-confirm')}.hidden ? '' : ${pane('.gp-confirm-text')}.textContent`);
      const gpRemoteNote = text => `!${pane('.gp-note')}.hidden && ${pane('.gp-note-text')}.textContent === ${sel(text)}`;
      const gpFolder = async dir => { pickTarget = dir; await js(`${pane('.code-pick')}.click()`); await waitFor(`${pane('.code-folder')}?.value === ${sel(dir)}`, 10000); };
      // 새로 고침(⟳)으로 조회를 한 번 돌리고 응답이 화면에 반영될 시간을 준다.
      const gitRefresh = async () => { const g0 = calls.gitState; await js(`${pane('.code-refresh')}.click()`); await waitCalls(() => calls.gitState > g0); await pause(300); };
      const gpKey = init => js(`${pane('.gp-msg')}.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }, ${sel(init)})))`);

      // ① 상태·목록: 깨끗한 main 은 목록이 비고 단추가 꺼져 있다. 변경(수정·삭제·새 파일·한글 이름)은 변경 목록에 배지와 함께 나온다.
      await gpFolder(GITFX);
      await waitFor(`${pane('.gp-branch')}.textContent === 'main' && ${pane('.gp-lists')}.querySelectorAll('.gp-none').length === 2`, 10000);
      assert.equal(await js(`${pane('.git-panel')}.getAttribute('aria-label')`), 'Git');
      assert.deepEqual(await gpHeads(), ['스테이징된 변경 (0)', '변경 (0)']);
      assert.equal(await js(`${pane('.gp-conflicts')}.hidden`), true, '충돌이 없는데 충돌 목록이 보임');
      assert.equal(await js(`${pane('.gp-msg')}.maxLength`), 20000);
      assert.deepEqual(await js(`[${['gp-commit', 'gp-commit-push', 'gp-commit-sync'].map(c => pane('.' + c)).join(', ')}].map(b => b.textContent)`), ['Commit', 'Commit & Push', 'Commit & Sync']);
      assert.equal(await js(`[...document.querySelectorAll('#code-pane .gp-actions button')].every(b => b.scrollWidth <= b.clientWidth)`), true, '기본 폭에서 Git 단추 글자가 잘림');
      assert.equal(await js(`${pane('.gp-gen')}.disabled`), true, '변경이 없는데 메시지 생성이 켜짐');
      // 생성 버튼: VS Code 처럼 메시지 칸 안 오른쪽의 별 아이콘 (글자·별도 줄 없음, 입력한 글이 아이콘 아래로 가지 않음)
      const genBox = await js(`(() => { const g = ${pane('.gp-gen')}, m = ${pane('.gp-msg')}, gr = g.getBoundingClientRect(), mr = m.getBoundingClientRect(); return { inWrap: g.parentElement === m.parentElement && g.parentElement.className === 'gp-msg-wrap', row: !!document.querySelector('#code-pane .gp-gen-row'), text: g.textContent, svg: !!g.querySelector('svg path[d]'), label: g.getAttribute('aria-label'), title: g.title, inside: gr.left >= mr.left && gr.right <= mr.right && gr.top >= mr.top && gr.bottom <= mr.bottom, rightSide: gr.left > mr.left + mr.width / 2, pad: parseFloat(getComputedStyle(m).paddingRight), fromRight: mr.right - gr.left }; })()`);
      assert.equal(genBox.inWrap, true, '생성 버튼이 메시지 칸과 같은 묶음에 없음');
      assert.equal(genBox.row, false, '생성 버튼 줄이 남아 있음');
      assert.equal(genBox.text, '', '생성 버튼에 글자가 있음');
      assert.equal(genBox.svg, true, '생성 버튼에 아이콘이 없음');
      assert.equal(genBox.label, '커밋 메시지 생성');
      assert.equal(genBox.title, '커밋 메시지 생성');
      assert.equal(genBox.inside, true, `생성 버튼이 메시지 칸 밖에 있음 ${JSON.stringify(genBox)}`);
      assert.equal(genBox.rightSide, true, '생성 버튼이 메시지 칸 오른쪽에 있지 않음');
      assert.ok(genBox.pad >= genBox.fromRight, `입력한 글이 아이콘 아래로 들어감 ${JSON.stringify(genBox)}`);
      putG('a.txt', 'one\ntwo\n'); putG('new.txt', '신규\n'); fs.rmSync(path.join(GITFX, 'docs', 'b.txt')); putG('한글 파일.txt', '가나다\n');
      await gitRefresh();
      await waitFor(`document.querySelectorAll('#code-pane .gp-changes .gp-file').length === 4`, 10000);
      assert.deepEqual(await gpBadges('changes'), { 'a.txt': 'M', 'docs/b.txt': 'D', 'new.txt': 'U', '한글 파일.txt': 'M' });
      assert.deepEqual(await gpHeads(), ['스테이징된 변경 (0)', '변경 (4)']);
      assert.equal(await js(`${pane('.gp-gen')}.disabled`), false);
      // 원격이 없으면 Push·Sync 는 메시지가 있어도 꺼지고 이유를 title 로 알린다 (Commit 은 켜진다).
      assert.equal(await gpOff('gp-commit'), true, '메시지가 없는데 Commit 이 켜짐');
      await gpSet('x');
      assert.deepEqual([await gpOff('gp-commit'), await gpOff('gp-commit-push'), await gpOff('gp-commit-sync')], [false, true, true]);
      assert.equal(await js(`${pane('.gp-commit-push')}.title`), 'origin 원격이 없습니다');
      for (const [c, label] of [['fetch', 'Fetch'], ['pull', 'Pull'], ['push', 'Push']]) {
        assert.equal(await js(`${pane('.gp-' + c)}.getAttribute('aria-label')`), label);
        assert.equal(await js(`${pane('.gp-' + c)}.disabled`), true, `원격이 없는데 ${label} 이 켜짐`);
        assert.equal(await js(`${pane('.gp-' + c)}.title`), 'origin 원격이 없습니다');
        assert.equal(await js(`(() => { const h = ${pane('.gp-head')}.getBoundingClientRect(), r = ${pane('.gp-' + c)}.getBoundingClientRect(); return r.width > 0 && r.left >= h.left - 1 && r.right <= h.right + 1; })()`), true, `${label} 단추가 머리줄 밖으로 나감`);
      }
      assert.equal(await js(`${pane('.gp-graph-toggle')}.getAttribute('aria-expanded')`), 'false', '그래프가 기본으로 펼쳐져 있음');
      assert.ok((await js(`${pane('.gp-graph-head')}.textContent`)).includes('그래프'));
      assert.equal(await js(`${pane('.gp-graph')}.hidden`), true, '접힌 그래프 목록이 보임');
      await gpSet('');
      await capture('code-git-panel');

      // ② + / − / 전체: 단일 스테이징·해제와 전체 스테이징·해제가 실제 git 상태와 일치한다. 키보드로 + 를 누르면 초점이 다음 줄로 이어진다.
      await js(`${gpAct('stage', 'a.txt')}.focus()`);
      await js(`${gpAct('stage', 'a.txt')}.click()`);
      await waitFor(`!!${pane('.gp-staged .gp-file[data-path="a.txt"]')} && !${pane('.gp-changes .gp-file[data-path="a.txt"]')}`, 10000);
      assert.deepEqual(cachedNames(), ['a.txt']);
      assert.deepEqual(await gpBadges('staged'), { 'a.txt': 'M' });
      await waitFor(`document.activeElement?.dataset?.path === 'docs/b.txt' && document.activeElement.dataset.act === 'stage'`, 5000);
      await js(`${gpAct('unstage', 'a.txt')}.click()`);
      await waitFor(`!!${pane('.gp-changes .gp-file[data-path="a.txt"]')} && !${pane('.gp-staged .gp-file[data-path="a.txt"]')}`, 10000);
      assert.deepEqual(cachedNames(), []);
      await js(`${pane('.gp-all[data-act=stage]')}.click()`);
      await waitFor(`document.querySelectorAll('#code-pane .gp-staged .gp-file').length === 4 && document.querySelectorAll('#code-pane .gp-changes .gp-file').length === 0`, 10000);
      assert.deepEqual(cachedNames(), ['a.txt', 'docs/b.txt', 'new.txt', '한글 파일.txt']);
      assert.deepEqual(await gpBadges('staged'), { 'a.txt': 'M', 'docs/b.txt': 'D', 'new.txt': 'A', '한글 파일.txt': 'M' });
      await js(`${pane('.gp-all[data-act=unstage]')}.click()`);
      await waitFor(`document.querySelectorAll('#code-pane .gp-changes .gp-file').length === 4 && document.querySelectorAll('#code-pane .gp-staged .gp-file').length === 0`, 10000);
      assert.deepEqual(cachedNames(), []);
      // 초점이 이미 다른 곳(입력란)으로 갔으면 작업이 끝나도 초점을 빼앗지 않는다.
      const msgFocused = () => js(`document.activeElement === ${pane('.gp-msg')}`);
      await js(`${gpAct('stage', 'a.txt')}.focus()`);
      await js(`(() => { ${gpAct('stage', 'a.txt')}.click(); ${pane('.gp-msg')}.focus(); })()`);
      await waitFor(`!!${pane('.gp-staged .gp-file[data-path="a.txt"]')}`, 10000);
      await pause(500);
      assert.equal(await msgFocused(), true, '줄의 + 뒤 입력란으로 옮긴 초점을 빼앗김');
      await js(`${pane('.gp-all[data-act=stage]')}.focus()`);
      await js(`(() => { ${pane('.gp-all[data-act=stage]')}.click(); ${pane('.gp-msg')}.focus(); })()`);
      await waitFor(`document.querySelectorAll('#code-pane .gp-staged .gp-file').length === 4`, 10000);
      await pause(500);
      assert.equal(await msgFocused(), true, '전체 + 뒤 입력란으로 옮긴 초점을 빼앗김');
      await js(`${pane('.gp-all[data-act=unstage]')}.focus()`);
      await js(`(() => { ${pane('.gp-all[data-act=unstage]')}.click(); ${pane('.gp-msg')}.focus(); })()`);
      await waitFor(`document.querySelectorAll('#code-pane .gp-changes .gp-file').length === 4 && document.querySelectorAll('#code-pane .gp-staged .gp-file').length === 0`, 10000);
      await pause(500);
      assert.equal(await msgFocused(), true, '전체 − 뒤 입력란으로 옮긴 초점을 빼앗김');
      assert.deepEqual(cachedNames(), []);

      // ③ 스테이징 없이 Commit: 변경을 모두 스테이징할지 확인 → 확인하면 커밋되고 HEAD 가 바뀌며 목록·메시지가 비고 트리 배지가 사라진다.
      const head0 = headOf();
      await gpSet('첫 커밋 메시지 한글');
      await js(`${pane('.gp-commit')}.click()`);
      await waitFor(`!${pane('.gp-confirm')}.hidden`, 5000);
      assert.match(await gpConfirmText(), /변경 4개를 모두 스테이징하고 커밋할까요\?/);
      assert.ok(!(await gpConfirmText()).includes('에이전트'), '에이전트가 만지지 않았는데 에이전트 문구가 있음');
      assert.equal(headOf(), head0, '확인 전에 커밋됨');
      await js(`${pane('.gp-confirm-ok')}.click()`);
      await waitCalls(() => headOf() !== head0);
      await waitFor(`${pane('.gp-lists')}.querySelectorAll('.gp-none').length === 2 && ${pane('.gp-msg')}.value === '' && ${pane('.gp-confirm')}.hidden`, 10000);
      assert.equal(gx('log', '-1', '--format=%s').trim(), '첫 커밋 메시지 한글');
      assert.deepEqual(gx('-c', 'core.quotepath=false', 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort(), ['a.txt', 'docs/b.txt', 'new.txt', '한글 파일.txt']);
      await waitFor(`${gpNoteHas('커밋했습니다. ' + headOf().slice(0, 7))}`, 5000);
      await waitFor(`!!${node('a.txt')} && !${node('a.txt')}.querySelector('.code-badge')`, 10000);

      // ④ Ctrl+Enter 로 커밋. 한글 조합 중(isComposing·keyCode 229)의 Enter 는 무시한다.
      putG('a.txt', 'one\ntwo\nthree\n');
      await gitRefresh();
      await js(`${gpAct('stage', 'a.txt')}.click()`);
      await waitFor(`!!${pane('.gp-staged .gp-file[data-path="a.txt"]')}`, 10000);
      await gpSet('엔터 커밋');
      const head1 = headOf();
      await gpKey({ isComposing: true }); await pause(800);
      assert.equal(headOf(), head1, '조합 중 Ctrl+Enter 로 커밋됨');
      await gpKey({ keyCode: 229 }); await pause(800);
      assert.equal(headOf(), head1, 'keyCode 229 Ctrl+Enter 로 커밋됨');
      await gpKey({});
      await waitCalls(() => headOf() !== head1);
      assert.equal(gx('log', '-1', '--format=%s').trim(), '엔터 커밋');
      await waitFor(`${pane('.gp-msg')}.value === '' && ${pane('.gp-lists')}.querySelectorAll('.gp-none').length === 2`, 10000);

      // ⑤ 메시지 생성(가짜 claude): 입력란에 채우고, 만드는 동안 사용자가 쓴 글은 덮어쓰지 않고 적용·버림을 묻는다.
      putG('a.txt', 'one\ntwo\nthree\nfour\n');
      await gitRefresh();
      await waitFor(`!${pane('.gp-gen')}.disabled`, 10000);
      scenario({ resultText: '```\nfeat: 생성된 메시지\n```' });
      const nGen = fake.spawns.length;
      await js(`${pane('.gp-gen')}.click()`);
      await waitCalls(() => fake.spawns.length === nGen + 1);
      await waitFor(`${pane('.gp-msg')}.value === 'feat: 생성된 메시지'`, 10000);
      assert.equal(argAfter(fake.spawns[nGen], '--model'), 'sonnet');
      assert.equal(fake.spawns[nGen].cwd, GITFX);
      assert.ok(fake.spawns[nGen].prompt.includes('a.txt'), '메시지 프롬프트에 변경 파일이 없음');
      await settle(fake.spawns[nGen]);
      assert.equal(await js(`${pane('.gp-gen')}.getAttribute('aria-label')`), '커밋 메시지 생성');
      const gateG1 = deferred();
      scenario({ gate: gateG1, resultText: 'AAA 생성' });
      await gpSet('');
      const nGen1 = fake.spawns.length;
      await js(`${pane('.gp-gen')}.click()`);
      await waitCalls(() => fake.spawns.length === nGen1 + 1);
      await waitFor(`${pane('.gp-gen')}.getAttribute('aria-label') === '생성 중지' && !${pane('.gp-gen')}.disabled`, 5000);
      assert.equal(await js(`${pane('.gp-gen')}.title`), '생성 중지');
      assert.equal(await js(`${pane('.gp-gen')}.querySelector('path').getAttribute('d').startsWith('M5.25')`), true, '생성 중 아이콘이 중지 모양이 아님');
      await gpSet('내가 쓴 글');
      gateG1.open();
      await waitFor(`!${pane('.gp-pending')}.hidden`, 10000);
      assert.equal(await gpVal(), '내가 쓴 글', '생성 결과가 사용자 입력을 덮어씀');
      await js(`${pane('.gp-apply')}.click()`);
      await waitFor(`${pane('.gp-msg')}.value === 'AAA 생성' && ${pane('.gp-pending')}.hidden`, 5000);
      await settle(fake.spawns[nGen1]);
      const gateG2 = deferred();
      scenario({ gate: gateG2, resultText: 'BBB 생성' });
      const nGen2 = fake.spawns.length;
      await js(`${pane('.gp-gen')}.click()`);
      await waitCalls(() => fake.spawns.length === nGen2 + 1);
      await gpSet('초안 수정');
      gateG2.open();
      await waitFor(`!${pane('.gp-pending')}.hidden`, 10000);
      await js(`${pane('.gp-discard')}.click()`);
      await waitFor(`${pane('.gp-pending')}.hidden`, 5000);
      assert.equal(await gpVal(), '초안 수정');
      await settle(fake.spawns[nGen2]);
      // 중지: 만드는 중에 「중지」를 누르면 「중단했습니다」, 입력은 그대로.
      const gateG3 = deferred();
      scenario({ gate: gateG3, resultText: 'CCC 생성' });
      const nGen3 = fake.spawns.length;
      await js(`${pane('.gp-gen')}.click()`);
      await waitCalls(() => fake.spawns.length === nGen3 + 1);
      await waitFor(`${pane('.gp-gen')}.getAttribute('aria-label') === '생성 중지'`, 5000);
      await js(`${pane('.gp-gen')}.click()`);
      await waitFor(gpNoteHas('중단했습니다'), 10000);
      assert.equal(await gpVal(), '초안 수정');
      assert.equal(await js(`${pane('.gp-gen')}.getAttribute('aria-label')`), '커밋 메시지 생성');
      await waitCalls(() => fake.spawns[nGen3].closed);

      // ⑥ Commit & Push: 원격을 연결하면 켜지고, 커밋과 함께 첫 푸시(upstream 연결)까지 되어 원격 HEAD 가 같아진다.
      gx('remote', 'add', 'origin', REMOTE);
      await gpSet('푸시 커밋');
      await gitRefresh();
      await waitFor(`!${pane('.gp-commit-push')}.disabled && !${pane('.gp-commit-sync')}.disabled`, 10000);
      assert.equal(await js(`${pane('.gp-commit-push')}.title`), 'Commit & Push');
      await js(`${pane('.gp-commit-push')}.click()`);
      await waitFor(`!${pane('.gp-confirm')}.hidden`, 5000);
      await js(`${pane('.gp-confirm-ok')}.click()`);
      await waitCalls(() => remoteHead() !== '' && remoteHead() === headOf());
      await waitFor(`${gpNoteHas('커밋·푸시했습니다')} && ${pane('.gp-msg')}.value === ''`, 10000);
      assert.equal(gx('rev-parse', '--abbrev-ref', '@{u}').trim(), 'origin/main', '푸시 뒤 upstream 이 연결되지 않음');
      assert.equal(gx('log', '-1', '--format=%s').trim(), '푸시 커밋');

      // ⑦ 다른 작업자가 먼저 푸시한 뒤 Commit & Push 는 거절된다: 「커밋됨」과 오류를 알리고 메시지는 비운다 → Commit & Sync 로 해결.
      gitAt(FIXBASE, 'clone', '-q', REMOTE, CLONE);
      putG('other.txt', '다른 작업자\n', CLONE);
      gitAt(CLONE, 'add', '-A'); gitAt(CLONE, 'commit', '-q', '-m', '다른 작업자 커밋'); gitAt(CLONE, 'push', '-q', 'origin', 'main');
      putG('a.txt', 'one\ntwo\nthree\nfour\nfive\n');
      await gitRefresh();
      await gpSet('거절될 커밋');
      const headRej = headOf();
      await js(`${pane('.gp-commit-push')}.click()`);
      await waitFor(`!${pane('.gp-confirm')}.hidden`, 5000);
      await js(`${pane('.gp-confirm-ok')}.click()`);
      await waitFor(`${gpNoteHas('커밋됨')} && ${gpNoteHas('⚠')}`, 15000);
      assert.notEqual(headOf(), headRej, '푸시가 거절돼도 로컬 커밋은 남아야 함');
      assert.notEqual(remoteHead(), headOf());
      assert.equal(await gpVal(), '', '커밋됐는데 메시지가 남음');
      assert.equal(await js(`${pane('.gp-note')}.classList.contains('err')`), true);
      await waitFor(`${pane('.gp-ab')}.textContent.includes('↑1')`, 10000);
      // 커밋이 남았는데 커밋할 것이 없다(메시지 빈칸): Commit & Sync 만 켜지고 제목이 동기화만 한다고 알린다. 스테이징을 하면 커밋하려는 것이므로 다시 꺼진다.
      const SYNC_ONLY_TITLE = '커밋할 것이 없어 Pull 후 Push 합니다';
      await waitFor(`!${pane('.gp-commit-sync')}.disabled`, 10000);
      assert.deepEqual([await gpOff('gp-commit'), await gpOff('gp-commit-push'), await gpOff('gp-commit-sync')], [true, true, false], '거절된 푸시 뒤 Commit & Sync 만 켜져야 함');
      assert.equal(await js(`${pane('.gp-commit-sync')}.title`), SYNC_ONLY_TITLE);
      putG('docs/c.txt', '싱크용\n');
      await gitRefresh();
      await waitFor(`!!${gpAct('stage', 'docs/c.txt')} && !${pane('.gp-commit-sync')}.disabled`, 10000);
      assert.equal(await gpOff('gp-commit-sync'), false, '스테이징하지 않은 변경이 있어도 동기화만은 켜져 있어야 함');
      await js(`${gpAct('stage', 'docs/c.txt')}.click()`);
      await waitFor(`!!${pane('.gp-staged .gp-file[data-path="docs/c.txt"]')}`, 10000);
      await waitFor(`${pane('.gp-commit-sync')}.disabled`, 5000);
      assert.equal(await js(`${pane('.gp-commit-sync')}.title`), 'Commit & Sync');
      await waitFor(`!!${gpAct('unstage', 'docs/c.txt')}`, 5000);
      await js(`${gpAct('unstage', 'docs/c.txt')}.click()`);
      await waitFor(`!!${pane('.gp-changes .gp-file[data-path="docs/c.txt"]')} && !${pane('.gp-commit-sync')}.disabled`, 10000);
      assert.equal(await js(`${pane('.gp-commit-sync')}.title`), SYNC_ONLY_TITLE);
      await gpSet('싱크 커밋');
      await js(`${pane('.gp-commit-sync')}.click()`);
      await waitFor(`!${pane('.gp-confirm')}.hidden`, 5000);
      await js(`${pane('.gp-confirm-ok')}.click()`);
      await waitCalls(() => remoteHead() === headOf() && fs.existsSync(path.join(GITFX, 'other.txt')), 20000);
      await waitFor(`${gpNoteHas('커밋·푸시했습니다')} && ${pane('.gp-msg')}.value === ''`, 10000);
      assert.ok(gx('log', '--merges', '-1', '--format=%H').trim(), '싱크 뒤 병합 커밋이 없음');

      // ⑦-2 받을 것만 있으면(↓1, 올릴 커밋 없음) 메시지가 빈칸이어도 Commit & Sync 가 켜지고, 가져오기만 한다 (푸시 없음, 빨리 감기).
      gitAt(CLONE, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main');
      putG('other.txt', '받기만\n', CLONE);
      gitAt(CLONE, 'add', '-A'); gitAt(CLONE, 'commit', '-q', '-m', '받기만 커밋'); gitAt(CLONE, 'push', '-q', 'origin', 'main');
      await js(`${pane('.gp-fetch')}.click()`);
      await waitFor(gpRemoteNote('가져왔습니다'), 15000);
      await waitFor(`${pane('.gp-ab')}.textContent === '↓1' && !${pane('.gp-commit-sync')}.disabled`, 15000);
      assert.equal(await js(`${pane('.gp-commit-sync')}.title`), SYNC_ONLY_TITLE);
      assert.equal(await gpVal(), '');
      const remoteRecv = remoteHead(), countRecv0 = Number(gx('rev-list', '--count', 'HEAD').trim());
      await js(`${pane('.gp-commit-sync')}.click()`);
      await waitFor(gpRemoteNote('가져와 병합했습니다'), 20000);
      assert.equal(remoteHead(), remoteRecv, '받기만 하는데 원격이 바뀜');
      assert.equal(headOf(), remoteRecv, '가져온 뒤 로컬이 원격과 다름');
      assert.equal(Number(gx('rev-list', '--count', 'HEAD').trim()), countRecv0 + 1, '가져온 커밋 하나 말고 커밋이 더 생김');
      assert.equal(fs.readFileSync(path.join(GITFX, 'other.txt'), 'utf8'), '받기만\n');
      await waitFor(`${pane('.gp-ab')}.textContent === '' && ${pane('.gp-commit-sync')}.disabled`, 15000);
      assert.equal(await js(`${pane('.gp-commit-sync')}.title`), 'Commit & Sync');

      // ⑦-3 거절돼 남은 커밋만 있고 커밋할 것이 없으면 Commit & Sync 는 커밋 없이 Pull 후 Push 만 한다 (확인 줄 없음, 메시지 칸은 그대로 빈칸).
      putG('other.txt', '다른 작업자 수정\n', CLONE);
      gitAt(CLONE, 'add', '-A'); gitAt(CLONE, 'commit', '-q', '-m', '다른 작업자 수정'); gitAt(CLONE, 'push', '-q', 'origin', 'main');
      putG('docs/c.txt', '싱크용 2\n');
      await gitRefresh();
      await waitFor(`!!${gpAct('stage', 'docs/c.txt')}`, 10000);
      await gpSet('다시 거절될 커밋');
      await js(`${pane('.gp-commit-push')}.click()`);
      await waitFor(`!${pane('.gp-confirm')}.hidden`, 5000);
      await js(`${pane('.gp-confirm-ok')}.click()`);
      await waitFor(`${gpNoteHas('커밋됨')} && ${gpNoteHas('Commit & Sync')}`, 15000);
      assert.equal(await gpVal(), '', '커밋됐는데 메시지가 남음');
      await waitFor(`${pane('.gp-ab')}.textContent.includes('↑1') && !${pane('.gp-commit-sync')}.disabled`, 10000);
      assert.equal(await js(`${pane('.gp-commit-sync')}.title`), SYNC_ONLY_TITLE);
      assert.deepEqual([await gpOff('gp-commit'), await gpOff('gp-commit-push')], [true, true]);
      // 메시지가 있어도 커밋할 변경이 없으면 동기화만 한다고 켜져 있다
      await gpSet('메시지만 있음');
      await waitFor(`!${pane('.gp-commit-sync')}.disabled`, 5000);
      assert.equal(await js(`${pane('.gp-commit-sync')}.title`), SYNC_ONLY_TITLE);
      assert.deepEqual([await gpOff('gp-commit'), await gpOff('gp-commit-push')], [true, true], '커밋할 변경이 없는데 Commit/Push 가 켜짐');
      await gpSet('');
      // 스테이징하지 않은 변경은 그대로 두고 동기화만 한다: 성공 안내에 남긴 개수가 보인다
      putG('docs/c.txt', '동기화 중에도 그대로\n');
      await gitRefresh();
      await waitFor(`!!${gpAct('stage', 'docs/c.txt')} && !${pane('.gp-commit-sync')}.disabled`, 10000);
      const countSync0 = Number(gx('rev-list', '--count', 'HEAD').trim());
      await js(`${pane('.gp-commit-sync')}.click()`);
      await waitFor(`${gpNoteHas('가져와 푸시했습니다')} && ${gpNoteHas('변경 1개는 커밋하지 않고 그대로 뒀습니다')}`, 20000);
      assert.equal(remoteHead(), headOf(), '동기화 뒤 원격 HEAD 가 로컬과 다름');
      assert.equal(await js(`${pane('.gp-confirm')}.hidden`), true, '동기화만 하는데 확인 줄이 열림');
      assert.equal(fs.readFileSync(path.join(GITFX, 'other.txt'), 'utf8'), '다른 작업자 수정\n', '원격 커밋을 가져오지 못함');
      assert.equal(fs.readFileSync(path.join(GITFX, 'docs', 'c.txt'), 'utf8'), '동기화 중에도 그대로\n', '스테이징하지 않은 변경이 바뀜');
      assert.equal(gx('status', '--porcelain').trim(), 'M docs/c.txt', '동기화가 스테이징하거나 다른 파일을 건드림');
      assert.equal(Number(gx('rev-list', '--count', 'HEAD').trim()), countSync0 + 2, '원격 커밋 하나와 병합 커밋 하나 말고 커밋이 더 생김');
      assert.equal(gx('log', '-1', '--format=%P').trim().split(' ').length, 2, '병합 커밋이 맨 위가 아님');
      assert.equal(await gpVal(), '', '동기화가 메시지 칸을 건드림');
      await waitFor(`${pane('.gp-ab')}.textContent === '' && ${pane('.gp-commit-sync')}.disabled`, 15000);
      assert.equal(await js(`${pane('.gp-commit-sync')}.title`), 'Commit & Sync');
      // 뒤 시나리오는 깨끗한 main 에서 시작한다
      gx('checkout', '--', 'docs/c.txt');
      await gitRefresh();
      await waitFor(`!${pane('.gp-changes .gp-file[data-path="docs/c.txt"]')}`, 10000);

      // ⑮ 그래프(읽기 전용)·Fetch·Pull·Push: 깨끗한 main 이 원격과 같은 위치에서 시작한다. 접혀 있는 동안은 code:git:log 를 부르지 않는다.
      const gpGraph = () => js(`[...document.querySelectorAll('#code-pane .gp-graph .gp-node')].map(li => ({ subject: li.querySelector('.gp-subject').textContent, mark: li.querySelector('.gp-mark').textContent, chips: [...li.querySelectorAll('.gp-ref')].map(c => ({ t: c.textContent, c: c.className })), meta: li.querySelector('.gp-meta').textContent, title: li.title }))`);
      const gpGraphOpen = () => js(`${pane('.gp-graph-toggle')}.getAttribute('aria-expanded') === 'true'`);
      const gpToggle = () => js(`${pane('.gp-graph-toggle')}.click()`);
      const gpFirstSubject = text => `document.querySelector('#code-pane .gp-graph .gp-subject')?.textContent === ${sel(text)}`;
      const gpBtns = async () => { const r = {}; for (const c of ['fetch', 'pull', 'push']) r[c] = await js(`(() => { const b = ${pane('.gp-' + c)}; return { off: b.disabled, title: b.title }; })()`); return r; };
      const commitG = (file, msg) => { putG(file, msg + '\n'); gx('add', file); gx('commit', '-q', '-m', msg); };
      assert.equal(calls.gitLog, 0, `그래프가 접혀 있는데 code:git:log 가 불림: ${calls.gitLog}회`);
      assert.equal(await gpGraphOpen(), false);
      gx('tag', 'v1', gx('rev-list', '--max-parents=0', 'HEAD').trim());
      await gpToggle();
      await waitFor(`document.querySelectorAll('#code-pane .gp-graph .gp-node').length > 0 && !${pane('.gp-graph')}.hidden`, 10000);
      assert.equal(calls.gitLog, 1, '펼치자 한 번만 받아야 함');
      assert.equal(await gpGraphOpen(), true);
      assert.equal(await js(`localStorage.getItem('ao.gitGraphOpen')`), '1');
      let rows = await gpGraph();
      assert.equal(rows.length, Number(gx('rev-list', '--all', '--count').trim()), '그래프 줄 수가 커밋 수와 다름');
      assert.equal(rows[0].subject, gx('log', '-1', '--format=%s').trim());
      assert.equal(rows[0].mark, '◆', '병합 커밋에 ◆ 표식이 없음');
      assert.equal(rows[0].title, `${headOf().slice(0, 7)} · ${rows[0].subject}`);
      assert.deepEqual(rows[0].chips.map(c => c.t).sort(), ['main', 'origin/main']);
      assert.ok(rows[0].chips.find(c => c.t === 'main').c.includes('gp-ref-cur'), '현재 브랜치 칩에 강조가 없음');
      assert.ok(rows[0].chips.find(c => c.t === 'origin/main').c.includes('gp-ref-remote'));
      assert.match(rows[0].meta, /^.+ · \d\d:\d\d$/);
      const rootRow = rows[rows.length - 1];
      assert.equal(rootRow.subject, 'init');
      assert.equal(rootRow.mark, '●');
      assert.ok(rootRow.chips.some(c => c.t === 'v1' && c.c.includes('gp-ref-tag')), '태그 칩이 없음');
      // 클릭 동작이 없다: 단추·링크·초점 대상이 없고, 눌러도 아무 일도 없다 (Checkout 없음).
      assert.equal(await js(`${pane('.gp-graph')}.querySelectorAll('button, a, [tabindex]').length`), 0, '그래프 줄에 누를 수 있는 것이 있음');
      const headG0 = headOf();
      await js(`${pane('.gp-graph .gp-node:last-child')}.click()`);
      await pause(500);
      assert.equal(headOf(), headG0);
      assert.equal(gx('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main', '그래프 줄을 눌렀더니 브랜치가 바뀜');
      // 커밋이 생기면(밖에서 커밋) 한 번만 다시 받고, 파일만 바뀌거나 같은 상태를 다시 조회하면 받지 않는다.
      commitG('g1.txt', '그래프 갱신 1');
      await gitRefresh();
      await waitFor(gpFirstSubject('그래프 갱신 1'), 10000);
      assert.equal(calls.gitLog, 2);
      assert.equal((await gpGraph())[0].mark, '●');
      putG('dirty-only.txt', 'x\n');
      // ⟳ 는 그래프도 다시 받으므로(명시적 새로 고침) 여기서는 지문이 같은 일반 조회(주기 갱신)로 확인한다.
      await waitFor(`!!${pane('.gp-changes .gp-file[data-path="dirty-only.txt"]')}`, 30000);
      assert.equal(calls.gitLog, 2, '파일만 바뀌었는데 그래프를 다시 받음');
      fs.rmSync(path.join(GITFX, 'dirty-only.txt'));
      // 접으면 받지 않고, 다시 펼칠 때 바뀐 것만 받는다. 접었다 바로 펼치면 다시 받지 않는다.
      await gpToggle();
      assert.equal(await gpGraphOpen(), false);
      assert.equal(await js(`localStorage.getItem('ao.gitGraphOpen')`), '0');
      assert.equal(await js(`${pane('.gp-graph')}.hidden`), true);
      commitG('g2.txt', '그래프 접힌 중');
      await gitRefresh();
      await pause(500);
      assert.equal(calls.gitLog, 2, '접혀 있는데 그래프를 받음');
      await gpToggle();
      await waitFor(gpFirstSubject('그래프 접힌 중'), 10000);
      assert.equal(calls.gitLog, 3);
      await gpToggle(); await gpToggle();
      await pause(500);
      assert.equal(calls.gitLog, 3, '바뀐 것이 없는데 펼칠 때 다시 받음');
      // 조회가 거부되면 안내만 보이고(머리말 없이) 콘솔로 새지 않는다. 다음에 바뀌면 복구된다.
      calls.failGit = { ch: 'code:git:log', text: '로그 거부 시험' };
      commitG('g3.txt', '로그 거부 중');
      await gitRefresh();
      await waitFor(`${pane('.gp-graph')}.textContent.includes('로그 거부 시험')`, 10000);
      assert.ok((await js(`${pane('.gp-graph')}.textContent`)).includes('⚠'));
      assert.equal(await js(`${pane('.gp-graph')}.textContent.includes('Error invoking')`), false);
      calls.failGit = null;
      gx('commit', '--allow-empty', '-q', '-m', '로그 복구');
      await gitRefresh();
      await waitFor(gpFirstSubject('로그 복구'), 10000);

      // Fetch·Pull·Push: 로컬 커밋 4개가 앞서 있다 → Push 가 켜진다. 다른 작업자(CLONE)가 푸시한 뒤 Fetch 는 ↓1 만 만들고 작업 폴더는 그대로.
      let bt = await gpBtns();
      assert.deepEqual([bt.fetch.off, bt.pull.off, bt.push.off], [false, false, false], JSON.stringify(bt));
      assert.equal(bt.push.title, 'Push');
      gitAt(CLONE, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main');
      putG('clone2.txt', '다른 작업자 2\n', CLONE); gitAt(CLONE, 'add', 'clone2.txt'); gitAt(CLONE, 'commit', '-q', '-m', '다른 작업자 2'); gitAt(CLONE, 'push', '-q', 'origin', 'main');
      const headF0 = headOf();
      await js(`${pane('.gp-fetch')}.click()`);
      await waitFor(gpRemoteNote('가져왔습니다'), 15000);
      await waitFor(`${pane('.gp-ab')}.textContent === '↑4 ↓1'`, 15000);
      assert.equal(headOf(), headF0, 'Fetch 가 로컬 HEAD 를 바꿈');
      assert.equal(fs.existsSync(path.join(GITFX, 'clone2.txt')), false, 'Fetch 가 작업 폴더를 바꿈');
      await waitFor(`[...document.querySelectorAll('#code-pane .gp-graph .gp-node')].some(li => li.querySelector('.gp-subject').textContent === '다른 작업자 2' && [...li.querySelectorAll('.gp-ref')].some(c => c.textContent === 'origin/main'))`, 10000);
      // Pull: 병합해 가져온다 (↓ 가 사라지고 병합 커밋이 ↑ 에 더해진다).
      await js(`${pane('.gp-pull')}.click()`);
      await waitFor(gpRemoteNote('가져와 병합했습니다'), 20000);
      await waitFor(`${pane('.gp-ab')}.textContent === '↑5'`, 15000);
      assert.equal(fs.existsSync(path.join(GITFX, 'clone2.txt')), true, 'Pull 뒤 가져온 파일이 없음');
      await waitFor(`!!${node('clone2.txt')}`, 15000); // Pull 로 HEAD 가 바뀌면 트리의 파일 목록도 다시 받아 새 파일이 보여야 함
      await waitFor(`document.querySelector('#code-pane .gp-graph .gp-mark')?.textContent === '◆' && document.querySelector('#code-pane .gp-graph .gp-subject').textContent.startsWith('Merge')`, 10000);
      // Push: 원격이 로컬과 같아지고 ↑ 가 사라지며, 올릴 것이 없으면 Push 가 꺼진다.
      await js(`${pane('.gp-push')}.click()`);
      await waitFor(gpRemoteNote('푸시했습니다'), 20000);
      assert.equal(remoteHead(), headOf(), 'Push 뒤 원격 HEAD 가 로컬과 다름');
      await waitFor(`${pane('.gp-ab')}.textContent === ''`, 15000);
      bt = await gpBtns();
      assert.deepEqual([bt.fetch.off, bt.pull.off, bt.push.off], [false, false, true], JSON.stringify(bt));
      assert.equal(bt.push.title, '올릴 커밋이 없습니다');
      await waitFor(`[...document.querySelectorAll('#code-pane .gp-graph .gp-node')][0]?.querySelectorAll('.gp-ref').length === 2`, 10000);
      // 원격의 다른 브랜치에만 커밋이 올라와도 Fetch 하면 그래프에 나온다 (커밋 위치·앞섬/뒤처짐 지문이 그대로여도 쓰기 성공 뒤에는 다시 받는다).
      gitAt(CLONE, 'checkout', '-q', '-b', 'side-g'); putG('side-g.txt', '곁가지\n', CLONE); gitAt(CLONE, 'add', 'side-g.txt'); gitAt(CLONE, 'commit', '-q', '-m', '다른 브랜치 커밋'); gitAt(CLONE, 'push', '-q', 'origin', 'side-g'); gitAt(CLONE, 'checkout', '-q', 'main');
      await js(`${pane('.gp-fetch')}.click()`);
      await waitFor(gpRemoteNote('가져왔습니다'), 15000);
      await waitFor(`[...document.querySelectorAll('#code-pane .gp-graph .gp-node')].some(li => li.querySelector('.gp-subject').textContent === '다른 브랜치 커밋')`, 10000);
      // ⟳ 는 그래프도 다시 받는다: 태그는 지문에 들지 않지만 칩으로 보여야 한다. 칩 title 에는 전체 이름이 있다.
      gx('tag', 'v-term-1');
      await js(`${pane('.code-refresh')}.click()`);
      await waitFor(`!![...document.querySelectorAll('#code-pane .gp-graph .gp-ref-tag')].find(c => c.textContent === 'v-term-1')`, 10000);
      assert.equal(await js(`[...document.querySelectorAll('#code-pane .gp-graph .gp-ref-tag')].find(c => c.textContent === 'v-term-1').title.startsWith('v-term-1')`), true, '칩 title 에 전체 이름이 없음');
      gx('tag', '-d', 'v-term-1');
      // main 이 아닌 브랜치: Fetch 는 되고 Pull·Push 는 꺼진다. main 으로 돌아와 Pull(빨리 감기)로 맞춘다.
      gx('checkout', '-q', '-b', 'feature2');
      gitAt(CLONE, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main');
      putG('clone3.txt', '다른 작업자 3\n', CLONE); gitAt(CLONE, 'add', 'clone3.txt'); gitAt(CLONE, 'rm', '-q', 'clone2.txt'); gitAt(CLONE, 'commit', '-q', '-m', '다른 작업자 3'); gitAt(CLONE, 'push', '-q', 'origin', 'main');
      await gitRefresh();
      await waitFor(`${pane('.gp-branch')}.textContent === 'feature2'`, 10000);
      bt = await gpBtns();
      assert.deepEqual([bt.fetch.off, bt.pull.off, bt.push.off], [false, true, true], JSON.stringify(bt));
      assert.ok(bt.pull.title.includes('main 브랜치에서만') && bt.push.title.includes('main 브랜치에서만'), JSON.stringify(bt));
      await js(`${pane('.gp-fetch')}.click()`);
      await waitFor(gpRemoteNote('가져왔습니다'), 15000);
      assert.equal(gx('rev-parse', 'origin/main').trim(), gitAt(CLONE, 'rev-parse', 'HEAD').trim(), '다른 브랜치에서 Fetch 가 원격 정보를 갱신하지 못함');
      gx('checkout', '-q', 'main'); gx('branch', '-D', 'feature2');
      await gitRefresh();
      await waitFor(`${pane('.gp-branch')}.textContent === 'main' && ${pane('.gp-ab')}.textContent === '↓1' && !${pane('.gp-pull')}.disabled`, 10000);
      await js(`${pane('.gp-pull')}.click()`);
      await waitFor(gpRemoteNote('가져와 병합했습니다') + ` && ${pane('.gp-ab')}.textContent === ''`, 20000);
      assert.equal(headOf(), remoteHead(), 'Pull 뒤 로컬이 원격과 다름');
      await waitFor(`!!${node('clone3.txt')} && !${node('clone2.txt')}`, 15000); // 원격이 추가·삭제한 파일이 트리에 반영돼야 함

      // ⑧ main 이 아닌 브랜치: 쓰기를 모두 끄고 안내한다. main 으로 돌아오면 복구된다.
      gx('checkout', '-q', '-b', 'feature');
      putG('a.txt', 'one\ntwo\nthree\nfour\nfive\nsix\n');
      await gpSet('브랜치 확인');
      await gitRefresh();
      await waitFor(`${pane('.gp-branch')}.textContent === 'feature' && ${gpNoteHas('main 브랜치에서만')}`, 10000);
      assert.ok((await gpNote()).includes('(현재: feature)'), await gpNote());
      assert.deepEqual(await js(`[${pane('.gp-note-text')}.textContent.includes('\\n'), getComputedStyle(${pane('.gp-note-text')}).whiteSpace]`), [true, 'pre-wrap'], 'main 이 아닌 안내가 줄이 바뀌어 보이지 않음');
      assert.deepEqual([await gpOff('gp-commit'), await gpOff('gp-commit-push'), await gpOff('gp-commit-sync')], [true, true, true]);
      assert.equal(await js(`[...document.querySelectorAll('#code-pane .gp-act, #code-pane .gp-all')].every(b => b.disabled)`), true, '다른 브랜치인데 + − 가 켜져 있음');
      assert.equal(await js(`!!${pane('.gp-changes .gp-file[data-path="a.txt"]')}`), true, '다른 브랜치에서도 목록은 보여야 함');
      gx('checkout', '-q', 'main');
      await gitRefresh();
      await waitFor(`${pane('.gp-branch')}.textContent === 'main' && ${pane('.gp-note')}.hidden && !${pane('.gp-commit')}.disabled`, 10000);
      assert.equal(await js(`[...document.querySelectorAll('#code-pane .gp-act, #code-pane .gp-all')].every(b => !b.disabled)`), true, 'main 으로 돌아왔는데 + − 가 꺼져 있음');
      await gpSet('');

      // ⑩ 하위 폴더를 열면: 폴더 밖 파일은 목록에 보이되 열기는 꺼지고(스테이징은 가능), 안쪽 파일을 누르면 폴더 기준 경로로 열린다.
      putG('sub/in.txt', 'in\nmod\n');
      await gpFolder(path.join(GITFX, 'sub'));
      await waitFor(`document.querySelectorAll('#code-pane .gp-changes .gp-file').length === 2`, 10000);
      assert.equal(await js(`${pane('.gp-file[data-path="a.txt"]')}.disabled`), true, '폴더 밖 파일 열기가 켜져 있음');
      assert.match(await js(`${pane('.gp-file[data-path="a.txt"]')}.title`), /열린 폴더 밖 파일 — 스테이징만 할 수 있습니다/);
      assert.equal(await js(`${pane('.gp-file[data-path="sub/in.txt"]')}.disabled`), false);
      await js(`${pane('.gp-file[data-path="sub/in.txt"]')}.click()`);
      await waitFor(`${pane('.code-path')}.textContent === 'in.txt'`, 10000);
      await js(`${gpAct('stage', 'a.txt')}.click()`);
      await waitFor(`!!${pane('.gp-staged .gp-file[data-path="a.txt"]')}`, 10000);
      assert.deepEqual(cachedNames(), ['a.txt'], '폴더 밖 파일 스테이징이 안 됨');
      await js(`${gpAct('unstage', 'a.txt')}.click()`);
      await waitFor(`!${pane('.gp-staged .gp-file[data-path="a.txt"]')}`, 10000);

      // ⑪ 에이전트가 방금 수정한 파일: ● 표시, 커밋 전 확인 줄(취소하면 커밋 안 됨).
      await gpFolder(GITFX);
      await waitFor(`${pane('.gp-branch')}.textContent === 'main' && !!${pane('.gp-changes .gp-file[data-path="a.txt"]')}`, 10000);
      await js(`${gpAct('stage', 'a.txt')}.click()`);
      await waitFor(`!!${pane('.gp-staged .gp-file[data-path="a.txt"]')}`, 10000);
      assert.equal(await js(`!!${pane('.gp-agent')}`), false, '에이전트가 만지지 않았는데 ● 가 있음');
      event('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: path.join(GITFX, 'a.txt') } });
      await waitFor(`!!${pane('.gp-staged .gp-file[data-path="a.txt"] .gp-agent')}`, 10000);
      assert.match(await js(`${pane('.gp-agent')}.title`), /에이전트가 방금 수정/);
      await gpSet('에이전트 커밋');
      const headAg = headOf();
      await js(`${pane('.gp-commit')}.click()`);
      await waitFor(`!${pane('.gp-confirm')}.hidden`, 5000);
      assert.match(await gpConfirmText(), /에이전트가 방금 파일을 수정했습니다/);
      assert.ok(!(await gpConfirmText()).includes('모두 스테이징'), '스테이징이 있는데 모두 스테이징 문구가 있음');
      await js(`${pane('.gp-confirm-no')}.click()`);
      await waitFor(`${pane('.gp-confirm')}.hidden`, 5000);
      await pause(500);
      assert.equal(headOf(), headAg, '취소했는데 커밋됨');
      assert.equal(await gpVal(), '에이전트 커밋');
      await js(`${pane('.gp-commit')}.click()`);
      await waitFor(`!${pane('.gp-confirm')}.hidden`, 5000);
      await js(`${pane('.gp-confirm-ok')}.click()`);
      await waitCalls(() => headOf() !== headAg);
      // 커밋이 반영된 목록까지 기다린다: 옛 목록으로 연 확인 줄은 새 목록이 오면 닫히므로 (의도한 동작), 아래 시험의 확인 줄이 시작 전에 닫힐 수 있다.
      await waitFor(`${pane('.gp-msg')}.value === '' && !${pane('.gp-staged .gp-file')}`, 10000);

      // C1 확인 줄: (1) 열린 동안 목록이 바뀌면(밖에서 git add) 닫히고 커밋하지 않는다.
      await gpSet('C1 확인');
      const headC1 = headOf();
      await js(`${pane('.gp-commit')}.click()`);
      await waitFor(`!${pane('.gp-confirm')}.hidden`, 5000);
      assert.equal(await js(`document.activeElement === ${pane('.gp-confirm-ok')}`), true, '확인 줄이 뜨는데 확인 버튼에 초점이 없음');
      gx('add', 'sub/in.txt');
      await gitRefresh();
      await waitFor(`${pane('.gp-confirm')}.hidden && ${gpNoteHas('목록이 바뀌었습니다')}`, 10000);
      await pause(500);
      assert.equal(headOf(), headC1, '목록이 바뀌었는데 확인 없이 커밋됨');
      gx('reset', '-q');
      // (2) Push 확인 줄이 열린 동안 Ctrl+Enter·Commit 단추는 then 을 바꾸지 않고 확인 버튼으로 초점만 옮긴다.
      await gitRefresh();
      await js(`${pane('.gp-commit-push')}.click()`);
      await waitFor(`!${pane('.gp-confirm')}.hidden`, 5000);
      assert.match(await gpConfirmText(), /커밋·푸시/, '확인 글에 동작 이름이 없음');
      await js(`${pane('.gp-msg')}.focus()`);
      await gpKey({});
      assert.equal(await js(`document.activeElement === ${pane('.gp-confirm-ok')}`), true, 'Ctrl+Enter 가 확인 버튼으로 초점을 옮기지 않음');
      await js(`${pane('.gp-commit')}.click()`);
      assert.match(await gpConfirmText(), /커밋·푸시/, '확인 줄이 열린 동안 then 이 바뀜');
      await js(`${pane('.gp-confirm-ok')}.click()`);
      await waitCalls(() => remoteHead() !== '' && remoteHead() === headOf() && headOf() !== headC1, 20000);
      await waitFor(`${gpNoteHas('커밋·푸시했습니다')}`, 10000);
      // (3) 폴더를 옮기면 확인 줄이 닫힌다.
      putG('c1-folder.txt', '폴더 전환\n');
      await gitRefresh();
      await gpSet('C1 폴더');
      const headC1b = headOf();
      await js(`${pane('.gp-commit')}.click()`);
      await waitFor(`!${pane('.gp-confirm')}.hidden`, 5000);
      await selectFolderUi(FIX);
      await waitFor(`${pane('.code-folder')}.value === ${sel(FIX)}`, 10000);
      await selectFolderUi(GITFX);
      await waitFor(`${pane('.code-folder')}.value === ${sel(GITFX)}`, 10000);
      assert.equal(await js(`${pane('.gp-confirm')}.hidden`), true, '폴더를 옮겼는데 확인 줄이 남음');
      assert.equal(headOf(), headC1b);

      // staged-changed: 화면이 본 뒤 밖에서 스테이징이 바뀌면 커밋하지 않고 알린다 (메시지는 유지).
      putG('s1.txt', '1\n'); putG('s2.txt', '2\n');
      await gitRefresh();
      await waitFor(`!!${gpAct('stage', 's1.txt')}`, 10000);
      await js(`${gpAct('stage', 's1.txt')}.click()`);
      await waitFor(`!!${pane('.gp-staged .gp-file[data-path="s1.txt"]')}`, 10000);
      await gpSet('SC 메시지');
      const headSc = headOf();
      gx('add', 's2.txt');
      await js(`${pane('.gp-commit')}.click()`);
      await waitFor(gpNoteHas('스테이징 목록이 바뀌었습니다'), 10000);
      assert.equal(headOf(), headSc, '스테이징이 바뀌었는데 커밋됨');
      assert.equal(await gpVal(), 'SC 메시지');
      assert.equal(await js(`${pane('.gp-note')}.classList.contains('err')`), true);
      gx('reset', '-q');
      for (const r of ['s1.txt', 's2.txt', 'c1-folder.txt']) fs.rmSync(path.join(GITFX, r));
      await gpSet('');

      // 이름 변경 줄: title 에 옛 이름 → 새 이름, 해제하면 두 경로 모두 내려가고, 전체 + 로 다시 R 로 합쳐진다.
      putG('ren-old.txt', '첫째 줄\n둘째 줄\n셋째 줄\n넷째 줄\n');
      gx('add', '-A'); gx('commit', '-q', '-m', 'rename 준비');
      gx('mv', 'ren-old.txt', 'ren-new.txt');
      await gitRefresh();
      await waitFor(`!!${pane('.gp-staged .gp-file[data-path="ren-new.txt"]')}`, 10000);
      assert.equal(await js(`${pane('.gp-staged .gp-file[data-path="ren-new.txt"]')}.title`), 'ren-old.txt → ren-new.txt');
      assert.equal(await js(`${pane('.gp-staged .gp-file[data-path="ren-new.txt"] .code-badge')}.textContent`), 'R');
      await js(`${gpAct('unstage', 'ren-new.txt')}.click()`);
      await waitFor(`!${pane('.gp-staged .gp-file[data-path="ren-new.txt"]')} && !!${pane('.gp-changes .gp-file[data-path="ren-old.txt"]')}`, 10000);
      assert.deepEqual(cachedNames(), [], '이름 변경 해제 때 옛 경로가 남음');
      assert.deepEqual(await gpBadges('changes'), { 'ren-new.txt': 'U', 'ren-old.txt': 'D' });
      await js(`${pane('.gp-all[data-act=stage]')}.click()`);
      await waitFor(`!!${pane('.gp-staged .gp-file[data-path="ren-new.txt"]')} && ${pane('.gp-staged .gp-file[data-path="ren-new.txt"]')}.title.includes('→')`, 10000);
      assert.match(gx('diff', '--cached', '--name-status').trim(), /^R\d*\s+ren-old\.txt\s+ren-new\.txt$/);
      gx('commit', '-q', '-m', 'rename 끝');
      await gitRefresh();

      // stageable:false (서브모듈 내용만 더러움): + 가 없고 안내 title, 전체 + 와 커밋 대상에서 빠진다.
      const SM = path.join(GITFX, 'sm');
      fs.mkdirSync(SM); gitAt(SM, 'init', '-q', '-b', 'main'); putG('sm.txt', 'sub\n', SM); gitAt(SM, 'add', '-A'); gitAt(SM, 'commit', '-q', '-m', 'sm');
      gx('update-index', '--add', '--cacheinfo', `160000,${gitAt(SM, 'rev-parse', 'HEAD').trim()},sm`); gx('commit', '-q', '-m', '서브모듈 추가');
      putG('sm.txt', 'sub modified\n', SM);
      await gitRefresh();
      await waitFor(`!!${pane('.gp-changes .gp-file[data-path="sm"]')}`, 10000);
      assert.match(await js(`${pane('.gp-changes .gp-file[data-path="sm"]')}.title`), /서브모듈 안에서 커밋해 주세요\./);
      assert.equal(await js(`!${gpAct('stage', 'sm')}`), true, '서브모듈 항목에 + 가 있음');
      await gpSet('SM 메시지');
      assert.equal(await gpOff('gp-commit'), true, '스테이징할 수 없는 변경뿐인데 Commit 이 켜짐');
      gitAt(SM, 'checkout', '--', 'sm.txt');
      await gpSet('');
      await gitRefresh();

      // ⑫-b 비교 화면과 커밋 보호: 스테이징된 항목은 스테이징된 내용(HEAD ↔ 인덱스), 변경 항목은 작업 폴더 내용, 삭제는 지워질 내용.
      // 비밀 파일 이름은 확인 줄에 경고하고, 안에 별도 git 저장소가 있는 폴더는 스테이징할 수 없다. 끝에서 만든 변경을 되돌린다.
      const cmpVal = (scheme, rel) => `(monaco.editor.getModels().find(m => m.uri.scheme === ${sel(scheme)} && m.uri.path === ${sel('/' + rel)})?.getValue() ?? null)`;
      const cmpHas = (scheme, rel, text) => `((${cmpVal(scheme, rel)} ?? '').includes(${sel(text)}))`;
      const stagedBtn = rel => pane(`.gp-staged .gp-file[data-path=${sel(rel)}]`);
      const changesBtn = rel => pane(`.gp-changes .gp-file[data-path=${sel(rel)}]`);
      const headIn = gx('show', 'HEAD:sub/in.txt');
      putG('sub/in.txt', '스테이징한 글\n'); gx('add', 'sub/in.txt'); putG('sub/in.txt', '나중에 고친 글\n');
      await gitRefresh();
      await waitFor(`!!${stagedBtn('sub/in.txt')} && !!${changesBtn('sub/in.txt')}`, 10000);
      await js(`${stagedBtn('sub/in.txt')}.click()`);
      await waitFor(`${pane('.code-path')}.textContent === 'sub/in.txt (스테이징된 내용)' && ${cmpHas('disk', 'sub/in.txt', '스테이징한 글')}`, 20000);
      assert.equal(await js(cmpHas('disk', 'sub/in.txt', '나중에 고친 글')), false, '스테이징된 내용 보기에 작업 폴더의 나중 글이 보임');
      assert.equal(await js(cmpHas('git-head', 'sub/in.txt', headIn.trim())), true, '비교 원본이 HEAD 내용이 아님');
      await js(`${changesBtn('sub/in.txt')}.click()`);
      await waitFor(`${pane('.code-path')}.textContent === 'sub/in.txt' && ${cmpHas('disk', 'sub/in.txt', '나중에 고친 글')}`, 20000);
      assert.equal(await js(cmpHas('disk', 'sub/in.txt', '스테이징한 글')), false, '변경 항목이 스테이징된 내용을 보임');
      // 스테이징을 해제하면 스테이징된 내용 보기가 작업 폴더 보기로 돌아간다.
      await js(`${stagedBtn('sub/in.txt')}.click()`);
      await waitFor(`${pane('.code-path')}.textContent === 'sub/in.txt (스테이징된 내용)' && ${cmpHas('disk', 'sub/in.txt', '스테이징한 글')}`, 20000);
      gx('restore', '--staged', 'sub/in.txt');
      await gitRefresh();
      await waitFor(`${pane('.code-path')}.textContent === 'sub/in.txt' && ${cmpHas('disk', 'sub/in.txt', '나중에 고친 글')}`, 20000);
      // 삭제(git rm 으로 스테이징): 지워진 내용을 빈 글과 비교해 보인다.
      putG('sub/in.txt', headIn); gx('rm', '-q', '-f', 'sub/in.txt');
      await gitRefresh();
      await waitFor(`!!${stagedBtn('sub/in.txt')}`, 10000);
      await js(`${stagedBtn('sub/in.txt')}.click()`);
      await waitFor(`${pane('.code-path')}.textContent === 'sub/in.txt (스테이징된 내용)' && ${cmpHas('git-head', 'sub/in.txt', headIn.trim())} && ${cmpVal('disk', 'sub/in.txt')} === ''`, 20000);
      gx('reset', '-q', 'HEAD', '--', 'sub/in.txt'); putG('sub/in.txt', headIn);
      await gitRefresh();
      await waitFor(`${pane('.code-path')}.textContent === 'sub/in.txt'`, 20000);
      // 비밀 파일 이름: 스테이징된 .env 로 Commit & Push 를 누르면 확인 줄에 경고하고, 취소하면 커밋하지 않는다.
      putG('.env', 'TOKEN=1\n');
      await gitRefresh();
      await waitFor(`!!${gpAct('stage', '.env')}`, 10000);
      await js(`${gpAct('stage', '.env')}.click()`);
      await waitFor(`!!${stagedBtn('.env')}`, 10000);
      await gpSet('비밀 시험');
      const headSecret = headOf();
      await js(`${pane('.gp-commit-push')}.click()`);
      await waitFor(`!${pane('.gp-confirm')}.hidden`, 5000);
      assert.ok((await gpConfirmText()).includes('비밀 파일일 수 있습니다: .env'), `비밀 파일 경고가 없음: ${await gpConfirmText()}`);
      await js(`${pane('.gp-confirm-no')}.click()`);
      await waitFor(`${pane('.gp-confirm')}.hidden`, 5000);
      await pause(300);
      assert.equal(headOf(), headSecret, '취소했는데 커밋됨');
      await js(`${gpAct('unstage', '.env')}.click()`);
      await waitFor(`!${stagedBtn('.env')}`, 10000);
      fs.rmSync(path.join(GITFX, '.env'));
      await gpSet('');
      // 커밋 없는 중첩 저장소 폴더는 + 가 없고 안내가 title 에 붙는다.
      const NEST = path.join(GITFX, 'nest-empty');
      fs.mkdirSync(NEST); gitAt(NEST, 'init', '-q', '-b', 'main'); putG('f.txt', 'f\n', NEST);
      await gitRefresh();
      await waitFor(`!!${changesBtn('nest-empty')}`, 10000);
      assert.equal(await js(`!${gpAct('stage', 'nest-empty')}`), true, '중첩 저장소 폴더에 + 가 있음');
      assert.match(await js(`${changesBtn('nest-empty')}.title`), /별도 git 저장소/);
      fs.rmSync(NEST, { recursive: true, force: true });
      await gitRefresh();
      await waitFor(`!${changesBtn('nest-empty')}`, 10000);

      // ⑬ 높이 조절: 위쪽 경계를 끌어 높이고 낮추며, 위 목록 최소 높이·패널 머리줄은 남기고, 두 번 클릭하면 기본 높이. 저장 키는 ao.gitPanelHeight.
      const gpBox = () => js(`(() => { const h = s => Math.round(document.querySelector('#code-pane ' + s).getBoundingClientRect().height);
        return { panel: h('.git-panel'), top: h('.code-side-top'), head: h('.gp-head'), saved: localStorage.getItem('ao.gitPanelHeight') }; })()`);
      const gpGrip = await js(`(() => { const r = ${pane('.gp-resizer')}.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      const dragGp = async (dy) => {
        const g = await js(`(() => { const r = ${pane('.gp-resizer')}.getBoundingClientRect(); return Math.round(r.top + r.height / 2); })()`);
        const ev = (type, y) => win.webContents.sendInputEvent({ type, x: gpGrip.x, y, button: 'left', clickCount: 1, ...(type === 'mouseMove' ? { modifiers: ['leftButtonDown'] } : {}) });
        win.webContents.sendInputEvent({ type: 'mouseMove', x: gpGrip.x, y: g }); await pause(50);
        ev('mouseDown', g); for (let i = 1; i <= 5; i++) { ev('mouseMove', g + Math.round(dy * i / 5)); await pause(30); } ev('mouseUp', g + dy);
        await pause(300);
      };
      const gp0 = await gpBox();
      assert.equal(gp0.saved, null, 'Git 패널 조절 전 저장값이 있음');
      const sideH = await js(`${pane('.code-side')}.getBoundingClientRect().height`);
      assert.ok(Math.abs(gp0.panel - Math.min(300, sideH * 0.5)) <= 2, `기본 높이가 min(300px, 50%) 가 아님: ${JSON.stringify({ gp0, sideH })}`);
      await dragGp(-100);
      const gpUp = await gpBox();
      assert.ok(Math.abs(gpUp.panel - (gp0.panel + 100)) <= 2 && gpUp.top < gp0.top, `위로 끌어도 Git 패널이 높아지지 않음: ${JSON.stringify({ gp0, gpUp })}`);
      assert.equal(Number(gpUp.saved), gpUp.panel, '조절한 Git 패널 높이를 저장하지 않음');
      await dragGp(2000);
      const gpLow = await gpBox();
      assert.ok(Math.abs(gpLow.panel - (gpLow.head + 170)) <= 1, `가장 낮게 끌면 머리줄+170px 이어야 함: ${JSON.stringify(gpLow)}`);
      await dragGp(-2000);
      const gpHigh = await gpBox();
      assert.ok(gpHigh.top >= 119 && gpHigh.top <= 122, `가장 높게 끌어도 위 목록 120px 는 남아야 함: ${JSON.stringify(gpHigh)}`);
      const gpTop = await js(`Math.round(${pane('.gp-resizer')}.getBoundingClientRect().top + 4)`);
      win.webContents.sendInputEvent({ type: 'mouseDown', x: gpGrip.x, y: gpTop, button: 'left', clickCount: 2 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: gpGrip.x, y: gpTop, button: 'left', clickCount: 2 });
      await pause(300);
      const gpReset = await gpBox();
      assert.ok(gpReset.panel === gp0.panel && gpReset.saved === null, `두 번 클릭해도 기본 높이로 돌아가지 않음: ${JSON.stringify({ gp0, gpReset })}`);
      gitPanelResize = { default: gp0.panel, up: gpUp.panel, lowest: gpLow.panel, highestTop: gpHigh.top, reset: gpReset.panel };

      // ⑭ 왼쪽 목록 너비 조절: 오른쪽 경계를 끌어 넓히고 좁히며, 목록 최소(260)·편집기 쪽 200px 는 남기고, 두 번 클릭하면 기본 280. 저장 키는 ao.codeSideWidth.
      const sideBox = () => js(`(() => { const w = s => Math.round(document.querySelector('#code-pane ' + s).getBoundingClientRect().width);
        return { side: w('.code-side'), main: w('.code-main'), view: w('.code-view'), saved: localStorage.getItem('ao.codeSideWidth') }; })()`);
      const sideGrip = () => js(`(() => { const r = ${pane('.code-side-resizer')}.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top + r.height / 2) }; })()`);
      const dragSide = async (dx) => {
        const g = await sideGrip();
        const ev = (type, x) => win.webContents.sendInputEvent({ type, x, y: g.y, button: 'left', clickCount: 1, ...(type === 'mouseMove' ? { modifiers: ['leftButtonDown'] } : {}) });
        win.webContents.sendInputEvent({ type: 'mouseMove', x: g.x, y: g.y }); await pause(50);
        ev('mouseDown', g.x); for (let i = 1; i <= 5; i++) { ev('mouseMove', g.x + Math.round(dx * i / 5)); await pause(30); } ev('mouseUp', g.x + dx);
        await pause(300);
      };
      const sideFit = () => js(`(() => ({ boxes: ['.gp-actions', '.gp-head'].map(s => { const e = document.querySelector('#code-pane ' + s); return { s, sw: e.scrollWidth, cw: e.clientWidth }; }),
        buttons: [...document.querySelectorAll('#code-pane .gp-actions button')].map(b => ({ s: b.textContent, sw: b.scrollWidth, cw: b.clientWidth })) }))()`);
      const sd0 = await sideBox();
      assert.ok(sd0.side === 280 && sd0.saved === null, `조절 전 왼쪽 목록이 280px·저장값 없음이 아님: ${JSON.stringify(sd0)}`);
      await dragSide(100);
      const sdWide = await sideBox();
      assert.ok(Math.abs(sdWide.side - 380) <= 2 && Math.abs(sdWide.main - (sd0.main - 100)) <= 2, `오른쪽으로 끌어도 왼쪽 목록이 380px 로 넓어지지 않음: ${JSON.stringify({ sd0, sdWide })}`);
      assert.ok(Math.abs(Number(sdWide.saved) - sdWide.side) <= 1, `조절한 왼쪽 목록 너비를 저장하지 않음: ${JSON.stringify(sdWide)}`);
      await dragSide(-2000);
      const sdMin = await sideBox();
      assert.ok(Math.abs(sdMin.side - 260) <= 1, `가장 좁게 끌면 왼쪽 목록이 260px 이어야 함: ${JSON.stringify(sdMin)}`);
      const sdFit = await sideFit();
      for (const b of sdFit.boxes) assert.ok(b.sw <= b.cw, `왼쪽 목록 최소 너비에서 Git 패널이 넘침: ${JSON.stringify(sdFit)}`);
      assert.ok(sdFit.buttons.length > 0, 'Git 패널 단추가 없음');
      for (const b of sdFit.buttons) assert.ok(b.sw <= b.cw, `왼쪽 목록 최소 너비에서 Git 단추 글자가 잘림: ${JSON.stringify(sdFit.buttons)}`);
      await dragSide(5000);
      const sdMax = await sideBox();
      assert.ok(Math.abs(sdMax.main - 200) <= 2, `가장 넓게 끌어도 편집기 쪽 200px 는 남아야 함: ${JSON.stringify(sdMax)}`);
      // 저장값이 있는 채 오른쪽 영역을 최대로 넓히면 코드 화면이 좁아져 목록이 범위로 줄고, 되돌리면 저장값대로 다시 늘어난다.
      await js(`(() => { const l = document.querySelector('.layout'); l.style.setProperty('--cli-width', (l.clientWidth - 420) + 'px'); })()`);
      await pause(500);
      const sdNarrow = await sideBox();
      assert.ok(Math.abs(sdNarrow.side - 260) <= 1 && sdNarrow.saved === sdMax.saved, `코드 화면이 좁아졌는데 목록이 260px 로 줄지 않았거나 저장값이 바뀜: ${JSON.stringify({ sdMax, sdNarrow })}`);
      // 줄어 있는 동안 경계를 클릭만 하거나(1px 흔들림 포함) 해도 저장값은 그대로다.
      const sdClick = await sideGrip();
      win.webContents.sendInputEvent({ type: 'mouseMove', x: sdClick.x, y: sdClick.y }); await pause(50);
      win.webContents.sendInputEvent({ type: 'mouseDown', x: sdClick.x, y: sdClick.y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseMove', x: sdClick.x + 1, y: sdClick.y, modifiers: ['leftButtonDown'] }); await pause(30);
      win.webContents.sendInputEvent({ type: 'mouseUp', x: sdClick.x + 1, y: sdClick.y, button: 'left', clickCount: 1 });
      await pause(300);
      assert.equal((await sideBox()).saved, sdMax.saved, '클릭만 했는데 왼쪽 목록 저장값이 줄어듦');
      await js(`document.querySelector('.layout').style.removeProperty('--cli-width')`);
      await pause(500);
      const sdBack = await sideBox();
      assert.ok(Math.abs(sdBack.side - sdMax.side) <= 2 && sdBack.saved === sdMax.saved, `오른쪽 영역을 되돌려도 왼쪽 목록이 원래 너비로 돌아오지 않음: ${JSON.stringify({ sdMax, sdBack })}`);
      const sdGrab = await sideGrip();
      win.webContents.sendInputEvent({ type: 'mouseDown', x: sdGrab.x, y: sdGrab.y, button: 'left', clickCount: 2 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: sdGrab.x, y: sdGrab.y, button: 'left', clickCount: 2 });
      await pause(300);
      const sdReset = await sideBox();
      assert.ok(sdReset.side === 280 && sdReset.saved === null, `두 번 클릭해도 왼쪽 목록이 기본 280px 로 돌아가지 않음: ${JSON.stringify(sdReset)}`);
      sideResize = { default: sd0.side, wide: sdWide.side, min: sdMin.side, mainAtMax: sdMax.main, narrow: sdNarrow.side, back: sdBack.side, reset: sdReset.side };

      // M1·작업 중 표시·폴더 전환 뒤 결과: 커밋이 도는 동안 쓴 글은 남고, 경과가 보이며, 다른 폴더에 있다가 돌아오면 결과 안내가 보인다.
      putG('m1.txt', 'm1\n');
      await gitRefresh();
      await gpSet('M1 메시지');
      const headM1 = headOf();
      calls.delayGit = 8000; // 로그인 안내 기준(4초)보다 훨씬 길게: 4.5초 뒤에도 커밋 중이어야 「커밋 중에는 안내가 숨는다」를 확인할 수 있다
      await js(`${pane('.gp-commit')}.click()`);
      await waitFor(`!${pane('.gp-confirm')}.hidden`, 5000);
      await js(`${pane('.gp-confirm-ok')}.click()`);
      await waitFor(`!${pane('.gp-busy')}.hidden && /^커밋 중… 0:0\\d$/.test(${pane('.gp-busy')}.textContent)`, 5000);
      assert.equal(await gpOff('gp-commit'), true, '작업 중인데 Commit 이 켜져 있음');
      assert.equal(await js(`${pane('.gp-login')}.hidden`), true, '커밋 작업 중에 로그인 창 안내가 보임');
      await pause(4500);
      assert.equal(await js(`!${pane('.gp-busy')}.hidden && /^커밋 중… 0:0[4-9]$/.test(${pane('.gp-busy')}.textContent)`), true, `4.5초 뒤에도 커밋 중이어야 함: ${await js(`${pane('.gp-busy')}.textContent`)}`);
      assert.equal(await js(`${pane('.gp-login')}.hidden`), true, '커밋이 4초 넘게 이어져도 로그인 창 안내가 보임 (네트워크 작업이 아님)');
      await gpSet('M1 메시지 뒤에 쓴 글');
      // 커밋이 도는 중에 도착한 메시지 생성 결과는 입력란에 넣지 않고 적용 줄에 둔다 (커밋이 끝나도 입력란에 낡은 메시지가 남지 않게).
      const gateOp = deferred();
      scenario({ gate: gateOp, resultText: 'M1 도중 생성' });
      const nOp = fake.spawns.length;
      await js(`${pane('.gp-gen')}.click()`);
      await waitCalls(() => fake.spawns.length === nOp + 1);
      gateOp.open();
      await waitFor(`!${pane('.gp-pending')}.hidden`, 3000);
      assert.equal(await gpVal(), 'M1 메시지 뒤에 쓴 글', '커밋 중 도착한 생성 결과가 입력란에 들어감');
      await settle(fake.spawns[nOp]);
      await waitCalls(() => headOf() !== headM1, 15000);
      await waitFor(`${pane('.gp-busy')}.hidden`, 10000);
      calls.delayGit = 0;
      assert.equal(await gpVal(), 'M1 메시지 뒤에 쓴 글', '커밋이 도는 동안 쓴 글이 지워짐');
      assert.equal(gx('log', '-1', '--format=%s').trim(), 'M1 메시지');
      await gpSet('');
      putG('last.txt', 'last\n');
      await gitRefresh();
      await gpSet('LAST 메시지');
      const headLast = headOf();
      calls.delayGit = 2000;
      await js(`${pane('.gp-commit')}.click()`);
      await waitFor(`!${pane('.gp-confirm')}.hidden`, 5000);
      await js(`${pane('.gp-confirm-ok')}.click()`);
      await selectFolderUi(FIX);
      await waitFor(`${pane('.code-folder')}.value === ${sel(FIX)}`, 10000);
      await waitCalls(() => headOf() !== headLast, 15000);
      await pause(800);
      calls.delayGit = 0;
      await selectFolderUi(GITFX);
      await waitFor(`${pane('.code-folder')}.value === ${sel(GITFX)}`, 10000);
      await waitFor(gpNoteHas('커밋했습니다'), 5000);
      assert.equal(await gpVal(), '', '다른 폴더에서 끝난 커밋의 메시지가 남음');
      await waitFor(`${pane('.gp-note')}.hidden`, 8000); // 성공 안내는 폴더로 돌아와 보인 것도 4초 뒤 사라진다

      // 느린 원격 작업: 푸시가 4초 넘게 이어지면 로그인 창 안내가 보이고, 끝나면 사라진다 (pre-push hook 으로 늘린다 — 원격은 로컬 폴더라 인증은 쓰지 않는다).
      const slowHook = path.join(GITFX, '.git', 'hooks', 'pre-push');
      fs.writeFileSync(slowHook, '#!/bin/sh\nsleep 6\nexit 0\n');
      gx('commit', '--allow-empty', '-q', '-m', '느린 푸시 시험');
      await gitRefresh();
      await waitFor(`${pane('.gp-branch')}.textContent === 'main' && !${pane('.gp-push')}.disabled`, 10000);
      assert.equal(await js(`${pane('.gp-login')}.hidden`), true, '작업이 없는데 로그인 창 안내가 보임');
      await js(`${pane('.gp-push')}.click()`);
      await waitFor(`!${pane('.gp-busy')}.hidden`, 5000);
      assert.equal(await js(`${pane('.gp-login')}.hidden`), true, '푸시를 막 시작했는데 로그인 창 안내가 보임');
      await waitFor(`!${pane('.gp-login')}.hidden`, 8000);
      assert.deepEqual(await js(`[${pane('.gp-login')}.textContent, getComputedStyle(${pane('.gp-login')}).whiteSpace]`),
        ['로그인 창에서 로그인을 진행하세요.\n로그인 창이 안 보이면 작업 표시줄을 확인하세요.', 'pre-wrap'], '로그인 안내 문구나 줄바꿈 표시가 사양과 다름');
      await waitFor(gpRemoteNote('푸시했습니다'), 20000);
      assert.equal(await js(`${pane('.gp-login')}.hidden`), true, '푸시가 끝났는데 로그인 창 안내가 남음');
      assert.equal(remoteHead(), headOf(), '느린 푸시 뒤 원격이 로컬과 다름');
      fs.rmSync(slowHook, { force: true });
      await waitFor(`${pane('.gp-note')}.hidden`, 8000);

      // M2·M3: 패널을 가장 낮춰도 Commit 단추는 스크롤 없이 보이고, 새로 뜬 「생성한 메시지」 줄·오류 안내는 (고정 영역을 아래로 내려 두었어도) 보이는 자리로 스크롤된다.
      // 「생성한 메시지」 줄은 오류 안내와 따로 함께 보인다.
      putG('m2.txt', 'm2\n');
      await gitRefresh();
      await gpSet('');
      await dragGp(2000);
      await waitFor(`${pane('.gp-note')}.hidden && ${pane('.gp-pending')}.hidden`, 5000);
      const inFixed = q => js(`(() => { const f = ${pane('.gp-fixed')}.getBoundingClientRect(), e = ${pane(q)}.getBoundingClientRect(); return e.height > 0 && e.top >= f.top - 1 && e.bottom <= f.bottom + 1; })()`);
      assert.equal(await inFixed('.gp-commit'), true, '가장 낮춘 패널에서 Commit 단추가 스크롤 없이 보이지 않음');
      const gateM = deferred();
      scenario({ gate: gateM, resultText: 'M2 생성' });
      const nM = fake.spawns.length;
      await js(`${pane('.gp-gen')}.click()`);
      await waitCalls(() => fake.spawns.length === nM + 1);
      await gpSet('M2 내 글');
      await js(`${pane('.gp-fixed')}.scrollTop = 0`); // 고정 영역을 맨 위로 (생성 메시지 줄은 맨 아래에 뜬다)
      gateM.open();
      await waitFor(`!${pane('.gp-pending')}.hidden`, 10000);
      await pause(200);
      assert.equal(await inFixed('.gp-pending'), true, '새로 뜬 생성 메시지 줄이 보이는 범위 밖에 있음');
      assert.equal(await js(`getComputedStyle(${pane('.gp-apply')}).borderTopWidth`), '1px', '적용·버림 단추 모양(CSS)이 빠짐');
      assert.equal(await js(`!${pane('.gp-note')}.contains(${pane('.gp-pending')})`), true, '생성 메시지 줄이 안내 안에 있음');
      await settle(fake.spawns[nM]);
      await js(`${pane('.gp-fixed')}.scrollTop = ${pane('.gp-fixed')}.scrollHeight`); // 다시 맨 아래로 (오류 안내는 맨 위에 생긴다)
      calls.failGit = { ch: 'code:git:commit', text: Array.from({ length: 12 }, (_, i) => `거부 줄 ${i + 1}`).join('\n') };
      await js(`${pane('.gp-commit')}.click()`);
      await waitFor(`!${pane('.gp-confirm')}.hidden`, 5000);
      await js(`${pane('.gp-fixed')}.scrollTop = ${pane('.gp-fixed')}.scrollHeight`);
      await js(`${pane('.gp-confirm-ok')}.click()`);
      await waitFor(gpNoteHas('거부 줄 12'), 10000);
      await pause(200);
      assert.equal(await inFixed('.gp-note'), true, '커밋 실패 안내가 보이는 범위 밖에 있음');
      assert.equal(await js(`getComputedStyle(${pane('.gp-note-close')}).backgroundColor`), 'rgba(0, 0, 0, 0)', '안내 닫기(×)가 다른 단추 규칙에 덮임');
      assert.equal(await js(`${pane('.gp-note-text')}.textContent.includes('Error invoking')`), false);
      assert.equal(await js(`!${pane('.gp-pending')}.hidden && !${pane('.gp-note')}.hidden`), true, '생성 메시지 줄이 있는데 커밋 실패 안내가 안 보임');
      assert.equal(await js(`${pane('.gp-note')}.scrollHeight > ${pane('.gp-note')}.clientHeight`), true, '12줄 안내가 최대 높이로 제한되지 않음');
      const fx = await js(`(() => { const f = ${pane('.gp-fixed')}; return { sh: f.scrollHeight, ch: f.clientHeight, lists: ${pane('.gp-lists')}.clientHeight }; })()`);
      assert.ok(fx.sh > fx.ch, `낮은 패널에서 고정 영역이 스크롤되지 않음: ${JSON.stringify(fx)}`);
      assert.ok(fx.lists >= 59, `목록 최소 높이가 지켜지지 않음: ${JSON.stringify(fx)}`);
      await js(`${pane('.gp-note-close')}.click()`);
      await waitFor(`${pane('.gp-note')}.hidden`, 5000);
      assert.equal(await js(`!${pane('.gp-pending')}.hidden`), true, '안내를 닫았더니 생성 메시지 줄도 사라짐');
      assert.equal(await js(`${pane('.gp-note-close')}.getAttribute('aria-label')`), '안내 닫기');
      await js(`${pane('.gp-discard')}.click()`);
      await waitFor(`${pane('.gp-pending')}.hidden`, 5000);
      calls.failGit = null;
      const gpTop2 = await js(`Math.round(${pane('.gp-resizer')}.getBoundingClientRect().top + 4)`);
      win.webContents.sendInputEvent({ type: 'mouseDown', x: gpGrip.x, y: gpTop2, button: 'left', clickCount: 2 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: gpGrip.x, y: gpTop2, button: 'left', clickCount: 2 });
      await pause(300);
      await gpSet('');

      // IPC 거부: 조회가 거부되면 안내만 보이고(머리말 없이) 쓰기는 꺼지며 콘솔 오류가 새지 않는다 (끝의 errors 단언). 풀리면 복구된다.
      calls.failGit = { ch: 'code:git:state', text: '상태 거부 시험' };
      await gitRefresh();
      await waitFor(gpNoteHas('상태 거부 시험'), 10000);
      assert.equal(await js(`${pane('.gp-note-text')}.textContent.includes('Error invoking')`), false);
      await gpSet('거부 중');
      assert.deepEqual([await gpOff('gp-commit'), await gpOff('gp-commit-push'), await gpOff('gp-commit-sync')], [true, true, true]);
      assert.equal(await js(`${pane('.gp-lists')}.querySelectorAll('.gp-file').length`), 0);
      calls.failGit = null;
      await gitRefresh();
      await waitFor(`${pane('.gp-branch')}.textContent === 'main' && ${pane('.gp-note')}.hidden`, 10000);
      await gpSet('');

      // ⑫ 입력 유지: 쓰던 메시지는 10초 갱신(11초 대기)과 폴더 왕복에도 폴더별로 남는다.
      await gpSet('DRAFT 유지');
      const gs0 = calls.gitState;
      await pause(11000);
      assert.ok(calls.gitState > gs0, '11초 동안 깃 조회가 돌지 않아 시험이 되지 않음');
      assert.equal(await gpVal(), 'DRAFT 유지', '갱신 뒤 입력이 사라짐');
      await selectFolderUi(FIX);
      await waitFor(`${pane('.code-folder')}.value === ${sel(FIX)}`, 10000);
      assert.equal(await gpVal(), '', '다른 폴더에 이전 폴더의 메시지가 보임');
      await gpSet('FIX 초안');
      await selectFolderUi(GITFX);
      await waitFor(`${pane('.code-folder')}.value === ${sel(GITFX)}`, 10000);
      assert.equal(await gpVal(), 'DRAFT 유지', '폴더를 왕복했더니 입력이 사라짐');
      await selectFolderUi(FIX);
      await waitFor(`${pane('.code-folder')}.value === ${sel(FIX)}`, 10000);
      assert.equal(await gpVal(), 'FIX 초안');

      // ⑨ 병합 중(FIX): 충돌 항목과 안내, 메시지가 있어도 커밋은 꺼진다. 깃이 아닌 폴더: 안내만 있고 모두 꺼진다.
      await waitFor(`${gpNoteHas('병합 등 다른 git 작업이 진행 중')} && !!${pane('.gp-conflicts .gp-file[data-path="merge.txt"]')}`, 10000);
      assert.equal(await js(`${pane('.gp-conflicts .gp-file[data-path="merge.txt"] .code-badge')}.textContent`), '!');
      assert.equal(await js(`${pane('.gp-conflicts')}.hidden`), false);
      assert.ok((await gpHeads()).includes('충돌 (1)'));
      assert.deepEqual([await gpOff('gp-commit'), await gpOff('gp-commit-push'), await gpOff('gp-commit-sync')], [true, true, true], '병합 중인데 커밋이 켜져 있음');
      const logsAtPlain = calls.gitLog;
      await gpFolder(PLAIN);
      await waitFor(gpNoteHas('깃 저장소에서만'), 10000);
      assert.equal(await js(`${pane('.gp-lists')}.querySelectorAll('.gp-file').length`), 0);
      // 갱신 주기의 상태 조회가 실패로 돌아와도 안내가 그대로다 (폴더를 연 뒤 git init 을 알아채려고 깃이 아닌 폴더에서도 묻는다). 콘솔 오류는 끝의 errors 단언이 본다.
      const gsPlain = calls.gitState;
      await pause(11000);
      assert.ok(calls.gitState > gsPlain, '11초 동안 깃이 아닌 폴더의 상태 조회가 돌지 않아 시험이 되지 않음');
      assert.equal(await js(gpNoteHas('깃 저장소에서만')), true, '상태 조회 실패 뒤 안내가 사라짐');
      assert.equal(await js(`${pane('.gp-branch')}.textContent`), '', '깃이 아닌 폴더에 브랜치가 보임');
      assert.equal(calls.gitLog, logsAtPlain, '깃이 아닌 폴더에서 code:git:log 를 부름');
      assert.equal(await js(`document.querySelectorAll('#code-pane .gp-graph .gp-node').length`), 0, '깃이 아닌 폴더에 이전 폴더의 그래프가 남음');
      assert.deepEqual(await js(`['fetch', 'pull', 'push'].map(c => document.querySelector('#code-pane .gp-' + c).disabled)`), [true, true, true]);
      // 커밋이 하나도 없는 저장소: 그래프는 「커밋이 없습니다」
      const EMPTY = path.join(FIXBASE, 'empty');
      fs.mkdirSync(EMPTY); gitAt(EMPTY, 'init', '-q', '-b', 'main');
      await gpFolder(EMPTY);
      await waitFor(`${pane('.gp-graph-empty')}?.textContent === '커밋이 없습니다'`, 10000);
      assert.equal(await js(`document.querySelectorAll('#code-pane .gp-graph .gp-node').length`), 0);
      assert.deepEqual([await gpOff('gp-commit'), await gpOff('gp-commit-push'), await gpOff('gp-commit-sync'), await gpOff('gp-gen')], [true, true, true, true]);
      await selectFolderUi(FIX);
      await waitFor(`${pane('.code-folder')}.value === ${sel(FIX)}`, 10000);

      // 깃이 아닌 폴더의 안내는 깃 폴더로 돌아오면 사라진다.
      await selectFolderUi(GITFX);
      await waitFor(`${pane('.code-folder')}.value === ${sel(GITFX)} && ${pane('.gp-branch')}.textContent === 'main' && !(${gpNoteHas('깃 저장소에서만')})`, 10000);
      // 폴더를 연 뒤 터미널에서 git init 하면 ⟳ 을 누르지 않아도 갱신 주기 안에 저장소로 보인다 (PLAIN 을 재사용하지 않는 새 폴더).
      const LATE = path.join(FIXBASE, 'late-init');
      fs.mkdirSync(LATE); putG('late.txt', 'late\n', LATE);
      await gpFolder(LATE);
      await waitFor(gpNoteHas('깃 저장소에서만'), 10000);
      gitAt(LATE, 'init', '-q', '-b', 'main'); gitAt(LATE, 'config', 'user.name', 'late'); gitAt(LATE, 'config', 'user.email', 'late@late.test');
      await waitFor(`${pane('.gp-branch')}.textContent === 'main' && !(${gpNoteHas('깃 저장소에서만')}) && !!${pane('.gp-changes .gp-file[data-path="late.txt"]')}`, 15000);
      await selectFolderUi(GITFX);
      await waitFor(`${pane('.code-folder')}.value === ${sel(GITFX)}`, 10000);
      // 긴 목록: 묶음마다 500줄까지만 그리고 나머지는 「외 N개」, 전체 + 는 전체 기준. (미추적 520개 짜리 임시 저장소)
      const MANY = path.join(FIXBASE, 'many');
      fs.mkdirSync(MANY); gitAt(MANY, 'init', '-q', '-b', 'main'); gitAt(MANY, 'config', 'user.name', 'm'); gitAt(MANY, 'config', 'user.email', 'm@m.test');
      for (let i = 1; i <= 520; i++) fs.writeFileSync(path.join(MANY, `f${String(i).padStart(3, '0')}.txt`), `${i}\n`);
      await gpFolder(MANY);
      await waitFor(`document.querySelectorAll('#code-pane .gp-changes .gp-file').length === 500`, 20000);
      assert.equal(await js(`${pane('.gp-more')}.textContent`), '외 20개');
      assert.ok((await gpHeads()).includes('변경 (520)'), JSON.stringify(await gpHeads()));
      await js(`${pane('.gp-all[data-act=stage]')}.click()`);
      await waitFor(`${pane('.gp-lists')}.textContent.includes('스테이징된 변경 (520)')`, 20000);
      assert.equal(gitAt(MANY, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).length, 520, '전체 + 가 보이는 500개만 스테이징함');
      await selectFolderUi(FIX);
      await waitFor(`${pane('.code-folder')}.value === ${sel(FIX)}`, 10000);

      // ───────── 하단 터미널 (가짜 pty: mode:'shell' 호출은 기록만, 출력은 pty:data·종료는 pty:exit 로 흉내) ─────────
      // 분석 상태가 정해진 곳에서 시작한다: README.md 를 열어 그 파일 분석을 한 번 돌려 두고(캐시여도 된다) 분석 탭이 보이게. (이번 변경 분석은 FIX 의 변경이 커서 확인 화면이 뜬다)
      await waitFor(`!!${node('README.md')}`, 20000); // 폴더를 막 바꾼 뒤라 트리가 올 때까지
      await openPath('README.md');
      await waitFor(`${pane('.code-path')}.textContent === 'README.md' && ${visible('.code-editor')} && !${A('.code-analyze-file')}.disabled`, 20000);
      scenario({ structured: resultOf('TERM-SETUP') });
      await js(`${A('.code-analyze-file')}.click()`);
      await waitFor(`${panelShown} && !(${statusHas('분석 중…')}) && (${A('.ca-scope')}?.textContent === 'README.md' || ${A('.ca-scope-sel')}?.value === 'file:README.md')`, 15000);
      const termHas = t => `((${pane('.code-terminal .xterm-rows')}?.textContent || '').replace(/\\u00a0/g, ' ')).includes(${sel(t)})`;
      const termShown = `(() => { const e = ${pane('.code-terminal')}; return !!e && e.getClientRects().length > 0 && !!e.querySelector('.xterm'); })()`;
      const bottomTabClick = id => js(`${pane(`.cb-tab[data-tab=${id}]`)}.click()`);
      const termKey = (key, keyCode) => js(`(() => { const ta = ${pane('.code-terminal .xterm-helper-textarea')}; ta.focus(); ta.dispatchEvent(new KeyboardEvent('keydown', { key: ${sel(key)}, code: ${sel(key)}, keyCode: ${keyCode}, which: ${keyCode}, bubbles: true, cancelable: true })); })()`);
      const termSend = (channel, payload) => win.webContents.send(channel, payload);

      // 처음 열기 전에는 셸이 없다. 분석 탭이 보이고, 셸 선택·다시 시작은 숨겨져 있다.
      assert.equal(term.creates.length, 0, '터미널을 열기 전에 셸이 만들어짐');
      assert.equal(await js(`${A('.code-term-toggle')}.getAttribute('aria-pressed')`), 'false');
      assert.equal(await js(`${A('.cb-shell')}.hidden && ${A('.cb-restart')}.hidden && ${A('.cb-dot')}.hidden`), true, '터미널을 열기 전에 셸 단추·● 가 보임');
      assert.equal(await js(`${A('.cb-tabs')}.hidden`), true, '터미널을 열기 전에 탭줄이 보임 (분석 패널만 예전 모습 그대로여야 함)');

      // 「터미널」을 열면: 분석 대신 터미널 탭, 등록된 폴더에서 PowerShell 이 mode:'shell' 로 만들어진다.
      await js(`${A('.code-term-toggle')}.click()`);
      await waitCalls(() => term.creates.length === 1);
      const c1 = term.creates[0];
      assert.equal(c1.mode, 'shell');
      assert.equal(c1.shell, 'powershell');
      assert.equal(c1.cwd, FIX, '등록된 작업 폴더에서 열어야 함');
      assert.match(c1.tabId, /^code-term-\d+$/);
      assert.notEqual(c1.tabId, tabId, '앱 탭 ID 와 겹침');
      assert.ok(c1.cols > 0 && c1.rows > 0, JSON.stringify(c1));
      assert.match(c1.cmd.file, /^[A-Za-z]:\\.*\\powershell\.exe$/i, 'PowerShell 은 절대 경로로 띄워야 함');
      await waitFor(termShown, 5000);
      assert.equal(await js(panelShown), false, '터미널 탭을 열었는데 분석 패널이 보임');
      assert.equal(await js(`${A('.code-term-toggle')}.getAttribute('aria-pressed')`), 'true');
      assert.equal(await js(`!${A('.cb-shell')}.hidden && ${A('.cb-shell')}.value === 'powershell' && !${A('.cb-restart')}.hidden`), true);
      assert.equal(await js(`${A('.cb-tab[data-tab=terminal]')}.classList.contains('on')`), true);
      const id1 = c1.tabId;

      // 가짜 프롬프트(pty:data)는 터미널에만 나온다 — 앱 탭의 터미널·사무실 캐릭터로 새지 않는다.
      termSend('pty:data', { tabId: id1, data: 'PS TERM-ONE> ' });
      await waitFor(termHas('TERM-ONE'), 5000);
      assert.equal(await js(`[...document.querySelectorAll('.xterm-rows')].some(e => !e.closest('#code-pane') && e.textContent.includes('TERM-ONE'))`), false, '터미널 출력이 앱 탭 터미널에 나옴');
      termSend('pty:data', { tabId, data: 'APP-TAB-OK' }); // 앱 탭의 ID 는 가로채지 않고 앱 탭으로 간다 (위 단언이 항상 참이 아님을 보인다)
      await waitFor(`[...document.querySelectorAll('.xterm-rows')].some(e => !e.closest('#code-pane') && e.textContent.includes('APP-TAB-OK'))`, 5000);
      assert.equal(await js(termHas('APP-TAB-OK')), false, '앱 탭의 출력이 터미널에 나옴');

      // 입력(붙여넣기·Enter)은 pty:write 로 그 터미널 ID 에 간다.
      await js(`(() => { const ta = ${pane('.code-terminal .xterm-helper-textarea')}; ta.focus(); const dt = new DataTransfer(); dt.setData('text/plain', 'git-status'); ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
      await termKey('Enter', 13);
      await waitCalls(() => term.writes.some(w => w.data.includes('git-status')) && term.writes.some(w => w.data === '\r'), 5000);
      assert.ok(term.writes.every(w => w.tabId === id1), JSON.stringify(term.writes));

      // 폴더를 바꾸면 그 폴더의 터미널로 바뀐다: 이전 출력은 안 보이고, 돌아오면 (숨은 동안 온 출력까지) 그대로, 셸은 새로 만들지 않는다.
      await selectFolderUi(OTHER);
      await waitFor(`${A('.code-folder')}.value === ${sel(OTHER)}`, 10000);
      await waitCalls(() => term.creates.length === 2);
      const c2 = term.creates[1];
      assert.equal(c2.cwd, OTHER);
      assert.match(c2.tabId, /^code-term-\d+$/);
      assert.notEqual(c2.tabId, id1, '다른 폴더가 같은 터미널 ID 를 씀');
      await waitFor(termShown, 5000);
      assert.equal(await js(termHas('TERM-ONE')), false, '다른 폴더의 터미널에 이전 폴더 출력이 보임');
      termSend('pty:data', { tabId: id1, data: 'ONE-BACKGROUND>' });
      termSend('pty:data', { tabId: c2.tabId, data: 'PS TERM-TWO> ' });
      await waitFor(termHas('TERM-TWO'), 5000);
      assert.equal(await js(termHas('ONE-BACKGROUND')), false, '숨은 폴더의 출력이 보임');
      await selectFolderUi(FIX);
      await waitFor(`${A('.code-folder')}.value === ${sel(FIX)} && ${termHas('TERM-ONE')} && ${termHas('ONE-BACKGROUND')}`, 10000);
      assert.equal(await js(termHas('TERM-TWO')), false);
      await pause(400);
      assert.equal(term.creates.length, 2, '폴더를 되돌렸는데 셸이 새로 만들어짐');

      // 셸이 끝나면 안내하고, 「다시 시작」·Enter 로 같은 터미널 ID 로 다시 띄운다.
      termSend('pty:exit', { tabId: id1, exitCode: 3 });
      await waitFor(termHas('셸 종료 · 코드 3'), 5000);
      await js(`${A('.cb-restart')}.click()`);
      await waitCalls(() => term.creates.length === 3);
      assert.equal(term.creates[2].tabId, id1);
      assert.equal(term.creates[2].cwd, FIX);
      termSend('pty:exit', { tabId: id1, exitCode: 0 });
      await waitFor(termHas('셸 종료 · 코드 0'), 5000);
      await termKey('Enter', 13);
      await waitCalls(() => term.creates.length === 4);
      assert.equal(term.creates[3].tabId, id1);
      assert.equal(await js(termHas('셸을 다시 시작합니다')), true);

      // 셸 종류 변경: 실행 중인 셸은 끊지 않고 값만 바꿔 안내한다 (createPty 호출이 늘지 않는다). 「다시 시작」이 새 셸로 띄운다. 고른 값은 저장한다.
      const setShell = v => js(`(() => { const s = ${A('.cb-shell')}; s.value = ${sel(v)}; s.dispatchEvent(new Event('change')); })()`);
      const restartClick = () => js(`${A('.cb-restart')}.click()`);
      const nShell0 = term.creates.length;
      await setShell('bash');
      await pause(500);
      assert.equal(term.creates.length, nShell0, '실행 중인 셸을 종류만 바꿨는데 다시 띄움');
      await waitFor(termHas('다음 시작부터 Git Bash 을 씁니다'), 5000);
      assert.equal(await js(`${A('.cb-shell')}.value`), 'bash');
      assert.equal(await js(`localStorage.getItem('ao.termShell')`), 'bash');
      assert.equal(await js(`${A('.cb-restart')}.title.includes('실행 중인 명령이 있으면 끝납니다')`), true);
      await restartClick();
      await waitCalls(() => term.creates.length === nShell0 + 1);
      assert.equal(term.creates[nShell0].shell, 'bash');
      assert.deepEqual(term.creates[nShell0].cmd, { file: 'C:\\Git\\bin\\bash.exe', args: ['--login', '-i'] });
      // Git Bash 를 못 찾는 따위의 거부: 터미널에 ⚠ 로 보이고 콘솔로 새지 않으며, 살아 있던 셸은 그대로 두고(입력이 계속 간다) 셸 종류·저장값을 되돌린다.
      term.failWith = 'Git Bash 를 찾지 못했습니다';
      await setShell('powershell');
      await restartClick();
      await waitCalls(() => term.creates.length === nShell0 + 2);
      await waitFor(termHas('⚠ Git Bash 를 찾지 못했습니다'), 5000);
      assert.equal(await js(termHas('Error invoking')), false, 'IPC 거부 머리말이 그대로 보임');
      term.failWith = null;
      await waitFor(`${A('.cb-shell')}.value === 'bash'`, 5000);
      assert.equal(await js(`localStorage.getItem('ao.termShell')`), 'bash', '실패했는데 저장값이 되돌아가지 않음');
      const writes0 = term.writes.length;
      await termKey('Enter', 13);
      await waitCalls(() => term.writes.length > writes0, 5000);
      assert.equal(term.creates.length, nShell0 + 2, '살아 있는 셸에서 Enter 가 셸을 다시 띄움');
      await setShell('powershell');
      await restartClick();
      await waitCalls(() => term.creates.length === nShell0 + 3);
      assert.equal(term.creates[nShell0 + 2].shell, 'powershell');
      assert.equal(await js(`localStorage.getItem('ao.termShell')`), 'powershell');
      // 폴더마다 셸이 따로다: A(FIX) PowerShell · B(OTHER) Git Bash 를 오가도 각자 값이 보이고 셸은 새로 만들지 않는다.
      const nShell1 = term.creates.length;
      await selectFolderUi(OTHER);
      await waitFor(`${A('.code-folder')}.value === ${sel(OTHER)} && ${termShown}`, 10000);
      assert.equal(await js(`${A('.cb-shell')}.value`), 'powershell');
      await setShell('bash');
      await pause(300);
      assert.equal(await js(`${A('.cb-shell')}.value`), 'bash');
      await selectFolderUi(FIX);
      await waitFor(`${A('.code-folder')}.value === ${sel(FIX)} && ${A('.cb-shell')}.value === 'powershell'`, 10000);
      await selectFolderUi(OTHER);
      await waitFor(`${A('.code-folder')}.value === ${sel(OTHER)} && ${A('.cb-shell')}.value === 'bash'`, 10000);
      await selectFolderUi(FIX);
      await waitFor(`${A('.code-folder')}.value === ${sel(FIX)} && ${A('.cb-shell')}.value === 'powershell'`, 10000);
      assert.equal(term.creates.length, nShell1, '폴더를 오가며 셸 종류 표시만 바꿨는데 셸이 새로 만들어짐');

      // 터미널을 보는 동안 분석이 끝나도 가리지 않고 탭에 ● 만 켠다. 분석 탭을 보면 꺼진다.
      await bottomTabClick('analysis');
      await waitFor(`${panelShown} && !${A('.ca-act')}.disabled`, 10000); // 폴더를 막 바꾼 뒤라 트리를 다 받아야 분석을 시작할 수 있다
      const gateTerm = deferred();
      scenario({ gate: gateTerm, structured: resultOf('TERM-DONE') });
      const nTerm = fake.spawns.length;
      await clickBy('.ca-act', '다시 분석');
      await waitCalls(() => fake.spawns.length === nTerm + 1);
      await waitFor(`${panelShown} && ${statusHas('분석 중…')}`, 5000);
      await bottomTabClick('terminal');
      await waitFor(`${termShown} && !(${panelShown})`, 5000);
      gateTerm.open();
      await settle(fake.spawns[nTerm]);
      await waitFor(`!${A('.cb-dot')}.hidden`, 10000);
      assert.equal(await js(`${termShown} && !(${panelShown})`), true, '분석이 끝났다고 터미널 탭을 가림');
      await bottomTabClick('analysis');
      await waitFor(`${panelShown} && ${A('.cb-dot')}.hidden && ${bodyHas('TERM-DONE')}`, 5000);
      // 사용자가 분석을 시작하면 (터미널 탭을 보고 있어도) 분석 탭으로.
      await bottomTabClick('terminal');
      await waitFor(`${termShown} && !(${panelShown})`, 5000);
      await waitFor(`!!${node('README.md')}`, 20000);
      await openPath('README.md'); // 폴더를 바꿨다 돌아오면 열린 파일이 비워진다
      await waitFor(`${pane('.code-path')}.textContent === 'README.md' && !${A('.code-analyze-file')}.disabled`, 20000);
      await js(`${A('.code-analyze-file')}.click()`);
      await waitFor(panelShown, 5000);
      await waitFor(`!(${statusHas('분석 중…')})`, 15000);
      assert.equal(await js(termShown), false, '분석을 시작했는데 터미널 탭이 남음');

      // 하단 닫기: 영역이 사라져도 셸은 유지된다 (다시 열어도 셸을 새로 만들지 않는다).
      await bottomTabClick('terminal');
      await waitFor(termShown, 5000);
      termSend('pty:data', { tabId: id1, data: '\r\nKEEP-MARK>' });
      await waitFor(termHas('KEEP-MARK'), 5000);
      await js(`${A('.cb-close')}.click()`);
      await waitFor(`${A('.code-bottom')}.hidden`, 5000);
      assert.equal(await js(`${A('.code-term-toggle')}.getAttribute('aria-pressed')`), 'false');
      const createdBeforeReopen = term.creates.length;
      await js(`${A('.code-term-toggle')}.click()`);
      await waitFor(termShown, 5000);
      await pause(400);
      assert.equal(term.creates.length, createdBeforeReopen, '하단을 다시 열었는데 셸이 새로 만들어짐');
      assert.equal(await js(termHas('KEEP-MARK')), true, '하단을 닫았다 열었더니 출력이 사라짐');

      // 코드 화면을 숨기는 동안에는 셸 크기를 맞추지 않고, 다시 보이면 맞춘다.
      await pause(300);
      const rz0 = term.resizes.length;
      await js(`document.querySelector('#mode-office').click()`); await pause(300);
      win.setSize(1300, 900); await pause(700);
      assert.equal(term.resizes.length, rz0, '코드 화면을 숨긴 동안 셸 크기를 바꿈');
      await js(`document.querySelector('#mode-code').click()`);
      await waitFor(termShown, 5000);
      await waitCalls(() => term.resizes.length > rz0, 5000);

      // 좁은 창(1100x680)에서 CLI 영역을 최대로 넓혀도 터미널 탭줄이 넘치지 않고 터미널·코드 영역이 남는다.
      win.setSize(1100, 680); await pause(500);
      await js(`(() => { const l = document.querySelector('.layout'); l.style.setProperty('--cli-width', (l.clientWidth - 420) + 'px'); })()`);
      await pause(500);
      const smallTerm = await js(`(() => {
        const fits = s => { const e = document.querySelector('#code-pane ' + s); return { s, sw: e.scrollWidth, cw: e.clientWidth }; };
        const h = s => Math.round(document.querySelector('#code-pane ' + s).getBoundingClientRect().height);
        return { heads: ['.cb-tabs', '.code-bottom', '.code-terminal'].map(fits), viewH: h('.code-view'), tabsH: h('.cb-tabs'), termH: h('.code-terminal'), noPageScroll: document.documentElement.scrollWidth <= innerWidth };
      })()`);
      for (const x of smallTerm.heads) assert.ok(x.sw <= x.cw, `좁은 창에서 터미널 영역이 넘침: ${JSON.stringify(smallTerm)}`);
      assert.ok(smallTerm.viewH >= 150 && smallTerm.termH >= 60 && smallTerm.noPageScroll, `좁은 창에서 터미널 영역이 너무 작음: ${JSON.stringify(smallTerm)}`);
      await js(`document.querySelector('.layout').style.removeProperty('--cli-width')`);
      win.setSize(1600, 1000); await pause(500);
      await capture('code-terminal');

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
      const pollsAtHide = calls.poll, gitStatesAtHide = calls.gitState, gitLogsAtHide = calls.gitLog;
      await pause(12000);
      assert.equal(calls.poll - pollsAtHide, 0, `숨긴 뒤에도 code:poll 이 불림: ${calls.poll - pollsAtHide}회`);
      assert.equal(calls.gitState - gitStatesAtHide, 0, `숨긴 뒤에도 code:git:state 가 불림: ${calls.gitState - gitStatesAtHide}회`);
      assert.equal(calls.gitLog - gitLogsAtHide, 0, `숨긴 뒤에도 code:git:log 가 불림: ${calls.gitLog - gitLogsAtHide}회`);
    } finally {
      await cleanup();
    }

    await pause(300);
    assert.ok(editorWorkerLoads >= 1 && editorWorkerLoads <= 2, `모나코 워커가 파일을 열 때마다 새로 뜸: ${editorWorkerLoads}회`);
    assert.deepEqual(errors, []);
    console.log('코드 화면 점검 통과');
    console.log(JSON.stringify({ hiddenSecond: { draw: after.draw - before.draw, update: after.update - before.update, notify: after.notify - before.notify }, walker, camera, geometry, fixture: ['README.md', 'src/a.js', 'docs/×표.md', 'merge.txt'], polls: calls.poll, gitStates: calls.gitState, gitLogs: calls.gitLog, narrowAnalysis: { viewH: Math.round(narrowAnalysis.viewH), heights: narrowAnalysis.heights }, analysisResize, gitPanelResize, sideResize, analysisSpawns: fake.spawns.length, output: [path.join(OUT, 'code-git-panel.png'), path.join(OUT, 'code-analysis-panel.png'), path.join(OUT, 'code-analysis-jump-diff.png'), path.join(OUT, 'code-analysis-notes.png'), path.join(OUT, 'code-view-toggle.png'), path.join(OUT, 'code-view.png'), path.join(OUT, 'code-view-diff.png')] }, null, 2));
    clearTimeout(timeout); app.exit(0);
  }).catch(async e => {
    clearTimeout(timeout);
    // 실패 원인을 볼 수 있게 코드 화면의 현재 모습을 함께 남긴다.
    try { console.error(await js(`JSON.stringify({ status: document.querySelector('#code-pane .code-status')?.textContent, message: document.querySelector('#code-pane .code-message')?.textContent, path: document.querySelector('#code-pane .code-path')?.textContent, hidden: ['.code-editor', '.code-diff', '.code-message'].map(s => document.querySelector('#code-pane ' + s)?.hidden), monaco: typeof window.monaco, text: (document.querySelector('#code-pane .view-lines')?.textContent || '').slice(0, 80) })`)); } catch { /* 화면 상태를 못 읽음 */ }
    fail(e.stack || e);
  });
}
