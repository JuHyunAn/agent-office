'use strict';

// 펫 화면(src/renderer/pet)을 실제 Electron 에 띄우고, 합성 상태를 보내 DOM 을 점검한다. 투명 창·드래그·트레이는 점검하지 않는다.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ROOT = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const { cleanEnv } = require('../src/main/env.cjs');
  const child = spawn(require('electron'), [__filename], { env: cleanEnv(), stdio: 'inherit', windowsHide: true });
  child.on('error', e => { console.error(e); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, protocol, net, ipcMain, nativeImage } = require('electron');
  const { pathToFileURL } = require('node:url');
  const assert = require('node:assert/strict');
  const errors = [];
  const calls = { size: [], hover: [], drag: [], open: [], perm: [], 'usage:refresh': [], 'usage:toggle': [], sprite: [] };
  let win;
  const pause = ms => new Promise(r => setTimeout(r, ms));
  app.disableHardwareAcceleration();
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pet-')));
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  const watchdog = setTimeout(() => { console.error('Pet check timed out'); app.exit(1); }, 120000); // 마우스 바라보기 10초 타이머 점검 포함

  const alert = (key, label, at) => ({ key, tabId: key, label, reason: 'permission', kind: 'alert', text: '❓ 권한 확인', at });
  const read = () => win.webContents.executeJavaScript(`[...document.querySelectorAll('.pet')].map(p => ({
    kind: p.dataset.kind, state: p.dataset.state,
    bubble: p.querySelector('.pet-bubble').hidden ? null : p.querySelector('.pet-bubble').textContent,
    badge: p.querySelector('.pet-badge').hidden ? null : p.querySelector('.pet-badge').textContent,
    card: p.querySelector('.pet-card').hidden ? null : {
      head: p.querySelector('.pet-card-head').textContent,
      preview: p.querySelector('.pet-card-preview').hidden ? null : p.querySelector('.pet-card-preview').textContent,
      more: p.querySelector('.pet-card-more').hidden ? null : p.querySelector('.pet-card-more').textContent,
      hint: p.querySelector('.pet-card-hint').hidden ? null : p.querySelector('.pet-card-hint').textContent,
      actions: !p.querySelector('.pet-card-actions').hidden,
      allowDisabled: p.querySelector('.pet-card-actions').hidden ? null : p.querySelector('.pet-card-allow').disabled,
      denyDisabled: p.querySelector('.pet-card-actions').hidden ? null : p.querySelector('.pet-card-deny').disabled } }))`);
  const canvasAlpha = () => win.webContents.executeJavaScript(`[...document.querySelectorAll('canvas')].map(c => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let sum = 0;
    for (let i = 3; i < d.length; i += 4) sum += d[i];
    return sum; })`);
  const scene = async payload => { win.webContents.send('pet:state', payload); await pause(200); return read(); };

  app.whenReady().then(async () => {
    protocol.handle('app', req => {
      const target = path.normalize(path.join(ROOT, decodeURIComponent(new URL(req.url).pathname)));
      if (!target.startsWith(ROOT + path.sep)) return new Response('forbidden', { status: 403 });
      return net.fetch(pathToFileURL(target).toString());
    });
    // 메인 쪽 그림 스텁: nativeImage 로 만든 단색 PNG (시트 1536x1872 · 잠자기 줄 1536x208) 를 키별로 돌려준다
    const solid = (w, h, [r, g, b]) => {
      const buf = Buffer.alloc(w * h * 4);
      for (let i = 0; i < buf.length; i += 4) { buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = 255; } // BGRA
      return nativeImage.createFromBitmap(buf, { width: w, height: h }).toPNG();
    };
    const SPRITE_COLORS = { 'builtin:test-a': [200, 30, 30], 'builtin:test-b': [30, 30, 200], 'builtin:slow': [30, 200, 200], 'builtin:legacy': [200, 200, 30], 'builtin:lying': [200, 30, 200] };
    const SLEEP_COLOR = [30, 200, 30];
    const sheetsByKey = Object.fromEntries(Object.entries(SPRITE_COLORS).map(([key, rgb]) => [key, solid(1536, 1872, rgb)]));
    const sleepPng = solid(1536, 208, SLEEP_COLOR);
    // 버전 2 스텁 시트 (1536x2288): 바탕은 회색, 9·10행(커서를 바라보는 16방향)의 16칸은 서로 다른 색
    const V2_BASE = [128, 128, 128];
    const GAZE_COLORS = Array.from({ length: 16 }, (_, o) => [20 + o * 14, 240 - o * 13, 60 + (o % 4) * 50]);
    const v2Sheet = (() => {
      const w = 1536, h = 2288, buf = Buffer.alloc(w * h * 4);
      const put = (x0, y0, [r, g, b]) => {
        for (let y = y0; y < y0 + 208; y++) for (let x = x0; x < x0 + 192; x++) { const i = (y * w + x) * 4; buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = 255; }
      };
      for (let row = 0; row < 11; row++) for (let col = 0; col < 8; col++) put(col * 192, row * 208, row >= 9 ? GAZE_COLORS[(row - 9) * 8 + col] : V2_BASE);
      return nativeImage.createFromBitmap(buf, { width: w, height: h }).toPNG();
    })();
    ipcMain.handle('pet:sprite', async (_e, p) => {
      calls.sprite.push(p);
      if (p.key === 'builtin:slow') await pause(400);
      const base = { key: p.key, displayName: p.key, type: 'image/png', sleepType: 'image/png', sleepBytes: sleepPng };
      if (p.key === 'builtin:test-v2') return { ...base, version: 2, bytes: v2Sheet };
      if (p.key === 'builtin:legacy') return { ...base, bytes: sheetsByKey[p.key] }; // 예전 응답: version 없음 → 1
      if (p.key === 'builtin:lying') return { ...base, version: 2, bytes: sheetsByKey[p.key] }; // 버전 2 라는데 그림은 1536x1872 → 실패 처리
      const bytes = sheetsByKey[p.key];
      return bytes ? { ...base, version: 1, bytes } : { key: p.key, none: true };
    });
    for (const ch of ['size', 'hover', 'drag', 'open', 'perm', 'usage:refresh', 'usage:toggle']) ipcMain.on(`pet:${ch}`, (_e, v) => calls[ch].push(v));
    win = new BrowserWindow({ width: 400, height: 300, show: false, webPreferences: {
      preload: path.join(ROOT, 'src/main/preload-pet.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false, offscreen: true,
    } });
    win.webContents.on('console-message', e => { if (e.level === 'error' || e.level === 3) errors.push(e.message); });
    win.webContents.on('did-fail-load', (_e, code, detail) => errors.push(`${code}: ${detail}`));
    await win.loadURL('app://office/src/renderer/pet/index.html');
    await pause(200);

    // 1. 상시 표시 · Codex 있음 · 알림 없음 · Claude 작업 중
    const working = await scene({ mode: 'always', codex: true, kinds: { claude: { working: true, attention: [] }, codex: { working: false, attention: [] } } });
    assert.deepEqual(working, [{ kind: 'claude', state: 'running', bubble: null, badge: null, card: null }, { kind: 'codex', state: 'idle', bubble: null, badge: null, card: null }]);

    // 5. 캔버스에 그림이 그려졌는지 (기본 그림을 불러올 시간을 준다)
    await pause(500);
    const alpha = await canvasAlpha();
    assert.equal(alpha.length, 2);
    assert.ok(alpha.every(a => a > 0), `빈 캔버스: ${alpha}`);

    // 2. 상시 표시 · Codex 없음 · Claude 완료 알림 1개
    const done = await scene({ mode: 'always', codex: false, kinds: {
      claude: { working: false, attention: [{ key: 't1', tabId: 't1', label: 'proj', reason: 'done', kind: 'done', text: '✅ 답변 완료', at: 1 }] },
      codex: { working: false, attention: [] } } });
    assert.deepEqual(done, [{ kind: 'claude', state: 'waving', bubble: '✅ 답변 완료 · proj', badge: null, card: null }]);

    // 3. 알림만 표시 · Codex 권한 알림 2개
    const alerts = await scene({ mode: 'alerts', codex: true, kinds: {
      claude: { working: true, attention: [] },
      codex: { working: false, attention: [alert('t2', 'a', 1), alert('t3', 'b', 2)] } } });
    assert.equal(alerts.length, 1);
    assert.deepEqual({ kind: alerts[0].kind, state: alerts[0].state, badge: alerts[0].badge }, { kind: 'codex', state: 'waiting', badge: '2' });
    // 권한 요청은 말풍선 대신 카드로 — 답할 수 없는 요청(permId·canAnswer 없음)은 버튼 없이 안내만
    assert.equal(alerts[0].bubble, null);
    assert.deepEqual(alerts[0].card, { head: '🔐 b', preview: null, more: '외 1건', hint: '그 터미널에서 답해 주세요', actions: false, allowDisabled: null, denyDisabled: null });

    // 4. 끄기
    assert.deepEqual(await scene({ mode: 'off', codex: true, kinds: {} }), []);

    // 7. 자는 모습: 점검용 시계(window.__petNow)로 5분이 지난 것처럼 만든다
    await win.webContents.executeJavaScript('window.__petOffset = 0; window.__petNow = () => Date.now() + window.__petOffset; 0');
    const idle = { mode: 'always', codex: true, kinds: { claude: { working: false, attention: [] }, codex: { working: false, attention: [] } } };
    const awake = await scene(idle);
    assert.deepEqual(awake.map(p => p.state), ['idle', 'idle']);
    await win.webContents.executeJavaScript(`window.__petOffset = ${5 * 60000 + 1000}; 0`);
    const sleeping = await scene(idle);
    assert.deepEqual(sleeping.map(p => p.state), ['sleeping', 'sleeping']);
    await pause(400);
    const sleepAlpha = await canvasAlpha();
    assert.ok(sleepAlpha.length === 2 && sleepAlpha.every(a => a > 0), `자는 모습이 비어 있음: ${sleepAlpha}`);
    const woke = await scene({ ...idle, kinds: { ...idle.kinds, claude: { working: true, attention: [] } } });
    assert.deepEqual(woke.map(p => p.state), ['running', 'sleeping']); // 작업을 시작한 쪽만 깬다
    const wokeByAlert = await scene({ ...idle, kinds: { ...idle.kinds, codex: { working: false, attention: [alert('t9', 'z', 1)] } } });
    assert.deepEqual(wokeByAlert.map(p => p.state), ['idle', 'waiting']); // 알림이 오면 깨고, claude 는 대기 시간을 다시 센다
    await win.webContents.executeJavaScript('window.__petOffset = 0; 0');

    // 8. 협업 대화: 알림만 표시 모드에서도 둘 다 보이고, 말하는 쪽 running · 듣는 쪽 review
    const talk = (speaker, turn, prev) => ({ mode: 'alerts', codex: true, kinds: idle.kinds, collab: { active: true, speaker, turn, prev } });
    await scene({ mode: 'off', codex: true, kinds: {} });
    const collabStart = await scene(talk('claude', 1, null));
    assert.deepEqual(collabStart.map(p => [p.kind, p.state]), [['claude', 'running'], ['codex', 'review']]);
    const collabClass = () => win.webContents.executeJavaScript("document.querySelector('#pets').classList.contains('collab')");
    assert.equal(await collabClass(), true, '협업 중에는 #pets 에 collab class');
    const chatCount = () => win.webContents.executeJavaScript("document.querySelectorAll('.pet-chat').length");
    assert.equal(await chatCount(), 0, '처음 본 차례에는 💬 가 없어야 함');
    const handoff = await scene(talk('codex', 2, 'claude'));
    assert.deepEqual(handoff.map(p => [p.kind, p.state]), [['claude', 'review'], ['codex', 'running']]);
    const chats = await win.webContents.executeJavaScript("[...document.querySelectorAll('.pet-chat')].map(e => e.textContent)");
    assert.deepEqual(chats, ['💬']);
    await pause(700); // 💬 가 도착한 뒤: 받는 펫이 한 번 깡충 뛴다
    const arrived = await read();
    assert.equal(await chatCount(), 0, '💬 가 도착한 뒤에는 지워져야 함');
    assert.ok(['jumping', 'running'].includes(arrived[1].state), `받는 펫 상태: ${arrived[1].state}`);
    await pause(1100);
    const settled = await read();
    assert.deepEqual(settled.map(p => p.state), ['review', 'running']); // 한 바퀴 뛴 뒤 원래 상태로
    assert.equal(await chatCount(), 0);
    const ended = await scene({ mode: 'alerts', codex: true, kinds: idle.kinds, collab: { active: false } });
    assert.deepEqual(ended, []); // 협업이 끝나고 알림도 없으면 알림만 모드에서는 사라진다
    assert.equal(await collabClass(), false, '협업이 끝나면 collab class 가 빠져야 함');

    // 협업 기준 탭이 바뀌면 차례 번호가 달라도 💬 를 날리지 않는다
    const tabTalk = (tabId, speaker, turn, prev) => ({ mode: 'alerts', codex: true, kinds: idle.kinds, collab: { active: true, tabId, speaker, turn, prev } });
    await scene(tabTalk('c1', 'claude', 5, null));
    await scene(tabTalk('c2', 'codex', 9, 'claude'));
    assert.equal(await chatCount(), 0, '기준 탭이 바뀐 차례에는 💬 가 없어야 함');
    await scene(tabTalk('c2', 'claude', 10, 'codex'));
    assert.equal(await chatCount(), 1, '같은 탭에서 말하는 쪽이 바뀌면 💬');
    await scene({ mode: 'off', codex: true, kinds: {} });

    // 9. 권한 카드 허용·거부
    const ID1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ID2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const permItem = (permId, at, extra = {}) => ({ key: `p${at}`, tabId: `t${at}`, label: `탭${at}`, reason: 'permission', kind: 'alert', text: '❓ 권한 확인', at,
      permId, tool: 'Bash', preview: 'npm test', canAnswer: true, ...extra });
    const cardScene = items => scene({ mode: 'always', codex: false, kinds: { claude: { working: false, attention: items }, codex: { working: false, attention: [] } } });
    const click = sel => win.webContents.executeJavaScript(`document.querySelector('${sel}').click(); 0`);
    await scene({ mode: 'off', codex: true, kinds: {} });
    const armed = await cardScene([permItem(ID1, 1)]);
    assert.equal(armed[0].bubble, null);
    assert.deepEqual(armed[0].card, { head: '🔐 탭1 · Bash', preview: 'npm test', more: null, hint: null, actions: true, allowDisabled: true, denyDisabled: true }); // 처음에는 버튼이 막혀 있다
    await click('.pet-card-allow'); // 막힌 동안의 클릭은 아무 일도 하지 않는다
    await pause(100);
    assert.deepEqual(calls.perm, []);
    await pause(700); // 처음 그린 지 900ms 가 지났다
    const enabled = (await read())[0].card;
    assert.deepEqual([enabled.allowDisabled, enabled.denyDisabled], [false, false]);
    const again = await cardScene([permItem(ID1, 1)]); // 같은 permId 를 다시 그려도 상태가 초기화되지 않는다
    assert.deepEqual([again[0].card.allowDisabled, again[0].card.denyDisabled], [false, false]);
    // 새 항목이 더 와도 가장 오래된 canAnswer 카드(ID1)가 유지되고 버튼도 다시 막히지 않는다
    const pinned = await cardScene([permItem(ID1, 1), permItem(ID2, 5, { label: '새 탭' })]);
    assert.equal(pinned[0].card.head, '🔐 탭1 · Bash');
    assert.equal(pinned[0].card.more, '외 1건');
    assert.deepEqual([pinned[0].card.allowDisabled, pinned[0].card.denyDisabled], [false, false]);
    await click('.pet-card-allow');
    await pause(100);
    assert.deepEqual(calls.perm, [{ permId: ID1, decision: 'allow' }]);
    assert.deepEqual(calls.open, [], '버튼 클릭이 카드 클릭(열기)으로 번지지 않는다');
    const answered = (await read())[0].card;
    assert.deepEqual([answered.allowDisabled, answered.denyDisabled], [true, true]); // 누르면 두 버튼 모두 막힌다
    await click('.pet-card-deny');
    await pause(100);
    assert.equal(calls.perm.length, 1, '막힌 버튼은 두 번째 답을 보내지 않는다');
    const kept = await cardScene([permItem(ID1, 1), permItem(ID2, 5)]);
    assert.deepEqual([kept[0].card.allowDisabled, kept[0].card.denyDisabled], [true, true]); // 같은 permId 를 다시 그려도 계속 막혀 있다
    // 다른 permId 카드로 바뀌면 다시 800ms 막는다
    const next = await cardScene([permItem(ID2, 5)]);
    assert.deepEqual([next[0].card.allowDisabled, next[0].card.denyDisabled], [true, true]);
    await click('.pet-card-deny');
    await pause(100);
    assert.equal(calls.perm.length, 1, '새 카드도 처음 800ms 는 막혀 있다');
    await pause(800);
    await click('.pet-card-deny');
    await pause(100);
    assert.deepEqual(calls.perm, [{ permId: ID1, decision: 'allow' }, { permId: ID2, decision: 'deny' }]);
    // 카드를 눌러 열기 (버튼 밖)
    await win.webContents.executeJavaScript(`document.querySelector('.pet-card-head').click(); 0`);
    await pause(100);
    assert.equal(calls.open.length, 1, '카드 클릭은 말풍선 클릭과 같은 열기');
    // 답할 수 없는 카드: 버튼 없이 안내만
    const hint = await cardScene([permItem(null, 3, { canAnswer: false })]);
    assert.deepEqual(hint[0].card, { head: '🔐 탭3 · Bash', preview: 'npm test', more: null, hint: '그 터미널에서 답해 주세요', actions: false, allowDisabled: null, denyDisabled: null });
    assert.equal(hint[0].bubble, null);
    const noPreview = await cardScene([permItem(ID1, 3, { preview: '', canAnswer: false })]);
    assert.equal(noPreview[0].card.preview, null);
    // 글은 textContent 로만 들어간다 (HTML 로 해석되지 않는다)
    const html = '<img src=x onerror=alert(1)>';
    await cardScene([permItem(ID1, 3, { preview: html, label: '<b>x</b>' })]);
    const injected = await win.webContents.executeJavaScript(`({ children: document.querySelector('.pet-card').querySelectorAll('img, b').length, preview: document.querySelector('.pet-card-preview').textContent, head: document.querySelector('.pet-card-head').textContent })`);
    assert.deepEqual(injected, { children: 0, preview: html, head: '🔐 <b>x</b> · Bash' });
    // 카드의 미리보기 = 승인 대상 전체: 161자 이상은 (canAnswer 라고 와도) 버튼 없이 안내, 160자·4줄(줄바꿈 3개)은 잘림 없이 전부 보인다
    const long161 = 'x'.repeat(161);
    const longCard = (await cardScene([permItem(ID1, 3, { preview: long161 })]))[0].card;
    assert.deepEqual([longCard.actions, longCard.hint, longCard.preview], [false, '그 터미널에서 답해 주세요', long161]);
    const fullCheck = `(() => { const e = document.querySelector('.pet-card-preview'); return { text: e.textContent, clipped: e.scrollHeight > e.clientHeight + 1 }; })()`;
    for (const cmd of ['y'.repeat(160), 'a'.repeat(60) + '\n' + 'b'.repeat(60) + '\n' + 'c'.repeat(30) + '\nd']) {
      const full = (await cardScene([permItem(ID1, 3, { preview: cmd })]))[0].card;
      assert.equal(full.actions, true, '160자 이하 명령은 버튼이 뜬다');
      const shown = await win.webContents.executeJavaScript(fullCheck);
      assert.equal(shown.text, cmd, '미리보기 글이 원문과 같다');
      assert.equal(shown.clipped, false, '미리보기가 잘리지 않는다');
      assert.ok(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.pet-card-preview')).webkitLineClamp === 'none'`), '줄 수 제한 없음');
      assert.ok(await win.webContents.executeJavaScript(`document.querySelector('.pet-card-preview').getBoundingClientRect().top >= 0`), '미리보기가 창 위로 잘려 나가지 않는다');
    }
    // 안내 카드(버튼 없음)만 미리보기를 4줄로 제한한다
    await cardScene([permItem(ID1, 3, { preview: long161 })]);
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.pet-card-preview')).webkitLineClamp`), '4', '안내 카드는 4줄까지');
    // Grep(path 포함)·Bash(dangerouslyDisableSandbox) 처럼 카드에 다 안 보이는 요청은 버튼 없음 (메인이 canAnswer 를 꺼서 보낸다; Grep 은 도구 자체가 허용 밖)
    for (const extra of [{ tool: 'Grep', preview: 'foo' }, { tool: 'Grep', preview: 'foo', canAnswer: false }, { tool: 'Bash', preview: 'npm test', canAnswer: false }]) {
      const c = (await cardScene([permItem(ID1, 3, extra)]))[0].card;
      assert.deepEqual([c.actions, c.hint], [false, '그 터미널에서 답해 주세요'], JSON.stringify(extra));
    }
    // 허용 목록 밖 도구(Write 등)는 canAnswer 라고 와도 버튼이 없다
    const writeCard = (await cardScene([permItem(ID1, 3, { tool: 'Write', preview: 'a.txt' })]))[0].card;
    assert.deepEqual([writeCard.actions, writeCard.hint], [false, '그 터미널에서 답해 주세요']);
    // 머리줄의 긴 도구 이름도 잘리지 않는다
    await cardScene([permItem(ID1, 3, { tool: 'mcp__server__' + 'long_tool_name'.repeat(3), canAnswer: false })]);
    const headFit = await win.webContents.executeJavaScript(`(() => { const e = document.querySelector('.pet-card-head'); return e.scrollWidth <= e.clientWidth + 1 && e.scrollHeight <= e.clientHeight + 1; })()`);
    assert.equal(headFit, true, '머리줄이 잘리지 않는다');

    // 카드 클릭은 카드 항목의 탭을 연다 (더 최근의 다른 알림이 있어도)
    calls.open.length = 0;
    await cardScene([permItem(ID1, 3), { key: 'newer', tabId: 'tNew', label: '새', reason: 'done', kind: 'done', text: '✅ 답변 완료', at: 99 }]);
    await win.webContents.executeJavaScript(`document.querySelector('.pet-card-head').click(); 0`);
    await pause(100);
    assert.deepEqual(calls.open, [{ key: 'p3', tabId: 't3' }]);

    // 배치 이동 오클릭 방지: Claude·Codex 카드가 함께 떠 있다가 Codex 항목이 사라지면 남은 Claude 카드 버튼을 다시 800ms 막는다
    const twoCards = items => scene({ mode: 'always', codex: true, kinds: { claude: { working: false, attention: [permItem(ID1, 1)] }, codex: { working: false, attention: items } } });
    await scene({ mode: 'off', codex: true, kinds: {} });
    await twoCards([permItem(ID2, 2)]);
    await pause(900);
    const claudeBtns = async () => (await read()).find(p => p.kind === 'claude').card;
    assert.deepEqual([(await claudeBtns()).allowDisabled, (await claudeBtns()).denyDisabled], [false, false], '둘 다 떠 있고 900ms 지나면 열린다');
    await twoCards([]); // Codex 카드가 사라졌다
    const shifted = await claudeBtns();
    assert.deepEqual([shifted.allowDisabled, shifted.denyDisabled], [true, true], '배치가 바뀐 직후 버튼이 막힌다');
    await pause(500);
    await twoCards([]); // 배치 변화 없음 — 타이머가 다시 걸리지 않는다
    await pause(450); // 처음 변화로부터 950ms
    const settledBtns = await claudeBtns();
    assert.deepEqual([settledBtns.allowDisabled, settledBtns.denyDisabled], [false, false], '800ms 뒤 열린다 (타이머는 누적·연장되지 않는다)');
    // 다시 Codex 카드가 생겨 밀려도, 펫 자체가 사라져 밀려도 마찬가지
    await twoCards([permItem(ID2, 2)]);
    assert.equal((await claudeBtns()).allowDisabled, true);
    await pause(900);
    assert.equal((await claudeBtns()).allowDisabled, false);
    await scene({ mode: 'alerts', codex: true, kinds: { claude: { working: false, attention: [permItem(ID1, 1)] }, codex: { working: false, attention: [permItem(ID2, 2)] } } });
    await pause(900);
    assert.equal((await claudeBtns()).allowDisabled, false);
    const gonePet = await scene({ mode: 'alerts', codex: true, kinds: { claude: { working: false, attention: [permItem(ID1, 1)] }, codex: { working: false, attention: [] } } });
    assert.equal(gonePet.length, 1, 'Codex 펫이 사라졌다');
    assert.equal(gonePet[0].card.allowDisabled, true, 'Codex 펫이 사라진 직후 Claude 카드 버튼이 막힌다');
    await pause(900);
    assert.equal((await claudeBtns()).allowDisabled, false);
    // 이미 답을 보낸 카드는 배치가 바뀌어도 계속 막혀 있다
    calls.perm.length = 0;
    await click('.pet-card-allow');
    await pause(100);
    assert.equal(calls.perm.length, 1);
    await scene({ mode: 'always', codex: true, kinds: { claude: { working: false, attention: [permItem(ID1, 1)] }, codex: { working: false, attention: [permItem(ID2, 2)] } } });
    await pause(900);
    assert.equal((await claudeBtns()).allowDisabled, true, '답을 보낸 카드는 계속 막혀 있다');

    // 권한 요청이 없어지면 카드가 사라진다
    const gone = await cardScene([]);
    assert.equal(gone[0].card, null);
    await scene({ mode: 'off', codex: true, kinds: {} });

    // 10. 사용량 패널: 합성 'pet:usage' 로 행 글·막대·세션 줄·버튼·접기·hover·크기를 점검한다 (패널은 .pet 밖이다)
    const MIN = 60000;
    let usageSize = null;
    const t0 = Date.now();
    const usageSnap = (extra = {}) => ({ expanded: true,
      claude: { rows: [
        { id: 'session', label: '세션', percent: 58, resetsAt: t0 + 133 * MIN + 30000, resetsText: null, observedAt: t0 },
        { id: 'week', label: '주간', percent: 12, resetsAt: t0 + 3 * 24 * 60 * MIN, resetsText: null, observedAt: t0 },
        { id: 'model:Fable', label: 'Fable', percent: 95, resetsAt: null, resetsText: 'Nov 1, 7am (Asia/Seoul)', observedAt: t0 }], error: null, updatedAt: t0 - 5 * MIN },
      codex: { rows: [{ id: 'session', label: '세션', percent: null, resetsAt: t0 - MIN, resetsText: null, observedAt: t0 }], error: null, updatedAt: t0 - 5 * MIN },
      session: { kind: 'claude', label: 'proj', requests: 3, contextPercent: null },
      refresh: { busy: false, nextAllowedAt: t0 + 4 * MIN + 30000, lastRunAt: t0 - 5 * MIN }, ...extra });
    const usageScene = async (snap) => { win.webContents.send('pet:usage', snap); await pause(200); return readUsage(); };
    const readUsage = () => win.webContents.executeJavaScript(`(() => {
      const u = document.querySelector('#usage');
      const sec = k => { const s = document.querySelector('#usage-' + k); return s.hidden ? null : {
        rows: [...s.querySelectorAll('.usage-row')].map(r => ({ text: r.querySelector('.usage-row-text').textContent,
          width: r.querySelector('.usage-fill').style.width, level: r.querySelector('.usage-fill').dataset.level,
          now: r.querySelector('.usage-bar').getAttribute('aria-valuenow'), role: r.querySelector('.usage-bar').getAttribute('role') })),
        err: s.querySelector('.usage-err').textContent }; };
      const b = document.querySelector('#usage-refresh'), t = document.querySelector('#usage-toggle'), session = document.querySelector('#usage-session');
      return { hidden: u.hidden, open: u.dataset.open, bodyHidden: document.querySelector('#usage-body').hidden, claude: sec('claude'), codex: sec('codex'),
        session: session.hidden ? null : session.textContent, updated: document.querySelector('#usage-updated').textContent,
        refreshDisabled: b.disabled, refreshTitle: b.title, toggle: t.textContent, expanded: t.getAttribute('aria-expanded'),
        inPets: !!document.querySelector('#pets #usage'), width: u.getBoundingClientRect().width }; })()`);
    const usageClick = sel => win.webContents.executeJavaScript(`document.querySelector('${sel}').click(); 0`);
    const wrapRect = () => win.webContents.executeJavaScript(`(() => { const r = document.querySelector('#wrap').getBoundingClientRect(); return { width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`);

    // 펫이 없으면 패널도 없다 (패널만 따로 뜨지 않는다)
    await scene({ mode: 'off', codex: true, kinds: {} });
    assert.equal((await usageScene(usageSnap())).hidden, true, '펫이 없으면 패널이 숨는다');
    assert.deepEqual(calls.size.at(-1), { width: 40, height: 40 });
    await scene({ mode: 'always', codex: true, kinds: { claude: { working: false, attention: [] }, codex: { working: false, attention: [] } } });
    const u1 = await readUsage();
    assert.equal(u1.hidden, false, '펫이 생기면 이미 받은 사용량이 보인다');
    assert.equal(u1.inPets, false, '패널은 #pets(.pet 배치) 밖에 있다');
    assert.equal(u1.width, 280);
    assert.deepEqual(u1.claude.rows.map(r => r.text.replace(/\(.\) (오전|오후) \d+:\d+/, '(요일) 시각')), [
      '세션 · 58% 사용 · 리셋 2시간 13분 후', '주간 · 12% 사용 · (요일) 시각 재설정', 'Fable · 95% 사용 · Nov 1, 7am (Asia/Seoul) 재설정']);
    assert.deepEqual(u1.claude.rows.map(r => [r.width, r.level, r.now, r.role]), [['58%', 'ok', '58', 'progressbar'], ['12%', 'ok', '12', 'progressbar'], ['95%', 'high', '95', 'progressbar']]);
    assert.deepEqual(u1.codex.rows.map(r => [r.text, r.width, r.now]), [['세션 · 리셋됨', '0%', null]]);
    assert.equal(u1.session, 'proj · 요청 3회 · 컨텍스트 —');
    assert.equal(u1.updated, '5분 전 갱신');
    assert.deepEqual([u1.refreshDisabled, u1.refreshTitle], [true, '5분 뒤 다시 갱신할 수 있어요']);
    assert.deepEqual([u1.open, u1.toggle, u1.expanded], ['true', '∨ 사용량', 'true']);

    // 구역 숨김: 행도 오류도 없으면 숨기고, 오류만 있으면 글만. 세션 줄은 session 이 null 이면 숨긴다.
    const u2 = await usageScene(usageSnap({ codex: { rows: [], error: null, updatedAt: null }, claude: { rows: [], error: 'Claude 사용량을 읽지 못했어요', updatedAt: t0 }, session: null }));
    assert.deepEqual([u2.codex, u2.session], [null, null]);
    assert.deepEqual(u2.claude, { rows: [], err: 'Claude 사용량을 읽지 못했어요' });
    // 글은 textContent 로만 들어간다 (위의 html 재사용)
    await usageScene(usageSnap({ session: { kind: 'codex', label: html, requests: 1, contextPercent: 5 },
      claude: { rows: [{ id: 'session', label: html, percent: 5, resetsAt: null, resetsText: html, observedAt: t0 }], error: html, updatedAt: t0 } }));
    const inj = await win.webContents.executeJavaScript(`({ children: document.querySelectorAll('#usage img, #usage b').length, row: document.querySelector('.usage-row-text').textContent, err: document.querySelector('#usage-claude .usage-err').textContent, session: document.querySelector('#usage-session').textContent })`);
    assert.deepEqual(inj, { children: 0, row: `${html} · 5% 사용 · ${html} 재설정`, err: html, session: `${html} · 요청 1회 · 컨텍스트 5%` });

    // ⟳: 막힌 동안(nextAllowedAt 미래)의 클릭은 보내지 않고, 열리면 보낸다
    await usageScene(usageSnap());
    await usageClick('#usage-refresh');
    await pause(100);
    assert.deepEqual(calls['usage:refresh'], []);
    const u3 = await usageScene(usageSnap({ refresh: { busy: false, nextAllowedAt: t0 - 1, lastRunAt: t0 } }));
    assert.deepEqual([u3.refreshDisabled, u3.refreshTitle], [false, '사용량 다시 읽기']);
    await usageClick('#usage-refresh');
    await pause(100);
    assert.equal(calls['usage:refresh'].length, 1);
    const u4 = await usageScene(usageSnap({ refresh: { busy: true, nextAllowedAt: null, lastRunAt: t0 } }));
    assert.equal(u4.refreshDisabled, true, '읽는 중에는 막힌다');
    await usageScene(usageSnap({ refresh: { busy: false, nextAllowedAt: null, lastRunAt: t0 } }));

    // 카드가 떠 있는 동안 패널이 바뀌고 접혀도 카드 버튼은 다시 막히지 않는다 (패널은 카드 배치 서명에 영향을 주지 않는다)
    await scene({ mode: 'off', codex: true, kinds: {} });
    await twoCards([permItem(ID2, 2)]);
    await pause(900);
    assert.equal((await claudeBtns()).allowDisabled, false);
    await usageScene(usageSnap({ claude: { rows: [], error: null, updatedAt: null } }));
    await usageClick('#usage-toggle');
    await pause(100);
    await usageClick('#usage-toggle');
    await pause(100);
    assert.deepEqual([(await claudeBtns()).allowDisabled, (await claudeBtns()).denyDisabled], [false, false], '패널 변화가 카드 버튼을 다시 막지 않는다');

    // 접기: 버튼만 남고 toggle(false) 을 보낸다. 다시 펼치면 toggle(true).
    calls['usage:toggle'].length = 0;
    await usageScene(usageSnap());
    await usageClick('#usage-toggle');
    await pause(100);
    const u5 = await readUsage();
    assert.deepEqual(calls['usage:toggle'], [false]);
    assert.deepEqual([u5.open, u5.bodyHidden, u5.toggle, u5.expanded], ['false', true, '∧ 사용량', 'false']);
    assert.ok(u5.width < 120, `접으면 버튼 크기만: ${u5.width}`);
    const collapsed = await wrapRect();
    await usageClick('#usage-toggle');
    await pause(100);
    assert.deepEqual(calls['usage:toggle'], [false, true]);
    const u6 = await readUsage();
    assert.deepEqual([u6.open, u6.bodyHidden, u6.toggle, u6.expanded], ['true', false, '∨ 사용량', 'true']);
    assert.ok((await wrapRect()).height > collapsed.height, '펼치면 창이 커진다');
    // 메인이 저장된 접힘 상태를 보내면 따른다
    assert.equal((await usageScene(usageSnap({ expanded: false }))).open, 'false');
    await usageScene(usageSnap());

    // 패널 위에 마우스가 오르면 클릭 통과를 푼다 (pet:hover true), 벗어나면 다시 건다
    calls.hover.length = 0;
    await win.webContents.executeJavaScript(`document.querySelector('#usage').dispatchEvent(new PointerEvent('pointerenter')); 0`);
    await win.webContents.executeJavaScript(`document.querySelector('#usage').dispatchEvent(new PointerEvent('pointerleave')); 0`);
    await pause(100);
    assert.deepEqual(calls.hover, [true, false]);

    // 창 크기 보고는 #wrap 실측: 폭 ≤ 600, 카드 2장 + 패널이 함께 떠도 높이 ≤ 600
    await scene({ mode: 'off', codex: true, kinds: {} });
    const bothCards = await scene({ mode: 'always', codex: true, kinds: {
      claude: { working: false, attention: [permItem(ID1, 1, { preview: 'a'.repeat(60) + '\n' + 'b'.repeat(60) + '\n' + 'c'.repeat(30) + '\nd' })] },
      codex: { working: false, attention: [permItem(ID2, 2, { preview: 'e'.repeat(160) })] } } });
    assert.equal(bothCards.length, 2);
    await usageScene(usageSnap());
    const rect = await wrapRect();
    assert.deepEqual(calls.size.at(-1), rect, '보고한 크기 = #wrap 실측');
    assert.ok(rect.width <= 600 && rect.width >= 286, `폭: ${rect.width}`);
    assert.ok(rect.height <= 600, `카드 2장 + 패널 높이: ${rect.height}`);
    const panelBottom = await win.webContents.executeJavaScript(`document.querySelector('#usage').getBoundingClientRect().bottom <= document.querySelector('#pets').getBoundingClientRect().top + 1`);
    assert.ok(panelBottom, '패널은 펫 위에 있다');
    usageSize = rect;

    // 카드가 아주 커서 600 을 넘으려 하면 패널 본문(스크롤)의 max-height 가 줄어 보고 높이가 600 안에 들어온다 (최소 60px). 카드가 작아지면 원래대로.
    const bigRows = ['session', 'week', 'model:A', 'model:B', 'model:C', 'model:D'].map((id, i) => ({ id, label: id === 'session' ? '세션' : id === 'week' ? '주간' : id.slice(6), percent: 10 + i, resetsAt: t0 + (i + 1) * 60 * MIN, resetsText: null, observedAt: t0 }));
    const bigSnap = usageSnap({ claude: { rows: bigRows, error: null, updatedAt: t0 }, codex: { rows: bigRows, error: null, updatedAt: t0 } });
    const bodyMax = () => win.webContents.executeJavaScript(`(() => { const b = document.querySelector('#usage-body'); return { inline: b.style.maxHeight, height: Math.round(b.getBoundingClientRect().height), scrolls: b.scrollHeight > b.clientHeight }; })()`);
    await usageScene(bigSnap);
    const natural = await bodyMax();
    assert.deepEqual([natural.inline, natural.scrolls], ['', true], `보통 카드: 본문은 줄이지 않는다 (${JSON.stringify(natural)})`);
    await win.webContents.executeJavaScript(`(() => { const s = document.createElement('style'); s.id = 'tall-cards'; s.textContent = '.pet-card { min-height: 280px; }'; document.head.append(s); return 0; })()`);
    await usageScene(bigSnap);
    const shrunk = await bodyMax();
    const tallRect = await wrapRect();
    assert.ok(tallRect.height <= 600, `큰 카드 2장 + 펼친 패널: 높이 ${tallRect.height}`);
    assert.deepEqual(calls.size.at(-1), tallRect, '보고한 크기 = #wrap 실측');
    const px = parseInt(shrunk.inline, 10);
    assert.ok(px >= 60 && px < natural.height && shrunk.scrolls, `패널 본문이 줄어 스크롤된다: ${JSON.stringify(shrunk)}`);
    await win.webContents.executeJavaScript(`document.querySelector('#tall-cards').remove(); 0`);
    await usageScene(bigSnap);
    assert.equal((await bodyMax()).inline, '', '카드가 작아지면 본문 높이를 되돌린다');
    await scene({ mode: 'off', codex: true, kinds: {} });

    // 11. 펫 그림 시트: 메인이 돌려준 1536x1872 PNG 가 시트 경로로 그려진다 (캔버스 가운데 픽셀이 시트 색)
    await scene({ mode: 'off', codex: true, kinds: {} });
    await win.webContents.executeJavaScript(`(() => { window.__bitmaps = []; const orig = window.createImageBitmap.bind(window);
      window.createImageBitmap = async (...a) => { const b = await orig(...a); window.__bitmaps.push(b); return b; }; return 0; })()`);
    const centerPx = kind => win.webContents.executeJavaScript(`(() => { const c = document.querySelector('.pet[data-kind="${kind}"] canvas');
      return Array.from(c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data); })()`);
    const near = (px, rgb, msg) => assert.ok(px[3] === 255 && rgb.every((v, i) => Math.abs(px[i] - v) <= 4), `${msg}: ${px} ≠ ${rgb}`);
    const closedFlags = () => win.webContents.executeJavaScript('window.__bitmaps.map(b => b.width === 0)');
    const withSprites = (sprites, extra = {}) => ({ mode: 'always', codex: true, kinds: idle.kinds, sprites, ...extra });

    await scene(withSprites({ claude: 'builtin:test-a', codex: 'none' }));
    await pause(900); // PNG 두 장을 읽어 비트맵으로 바꿀 시간
    assert.deepEqual(calls.sprite, [{ kind: 'claude', key: 'builtin:test-a' }], '아이콘(none) 종류는 요청하지 않는다');
    near(await centerPx('claude'), SPRITE_COLORS['builtin:test-a'], '시트 경로로 그려진 가운데 픽셀');
    assert.equal((await canvasAlpha())[0] > 0, true);
    await scene(withSprites({ claude: 'builtin:test-a', codex: 'none' }));
    await scene(withSprites({ claude: 'builtin:test-a', codex: 'none' }, { collab: { active: false } }));
    assert.equal(calls.sprite.length, 1, '같은 key 는 다시 요청하지 않는다');

    // key 가 바뀌면 다시 요청하고, 이전 비트맵은 닫힌다
    await scene(withSprites({ claude: 'builtin:test-b', codex: 'none' }));
    await pause(900);
    assert.deepEqual(calls.sprite.at(-1), { kind: 'claude', key: 'builtin:test-b' });
    assert.equal(calls.sprite.length, 2);
    near(await centerPx('claude'), SPRITE_COLORS['builtin:test-b'], '바뀐 그림');
    assert.deepEqual(await closedFlags(), [true, true, false, false], '이전 시트·잠자기 비트맵은 닫히고 새 것은 열려 있다');

    // 자는 모습은 잠자기 줄 그림으로
    await win.webContents.executeJavaScript(`window.__petOffset = ${5 * 60000 + 1000}; 0`);
    const asleep = await scene(withSprites({ claude: 'builtin:test-b', codex: 'none' }));
    assert.equal(asleep[0].state, 'sleeping');
    await pause(400);
    near(await centerPx('claude'), SLEEP_COLOR, '잠자기 줄 그림');
    await win.webContents.executeJavaScript('window.__petOffset = 0; 0');

    // 늦게 온 응답은 버린다: 느린 그림을 요청한 직후 다른 그림으로 바꾸면 느린 쪽 응답은 반영되지 않는다
    const bitmapsBefore = (await closedFlags()).length;
    await scene(withSprites({ claude: 'builtin:slow', codex: 'none' }));
    await scene(withSprites({ claude: 'builtin:test-a', codex: 'none' }));
    await pause(1300);
    near(await centerPx('claude'), SPRITE_COLORS['builtin:test-a'], '늦은 응답이 덮어쓰지 않는다');
    assert.deepEqual(calls.sprite.slice(-2), [{ kind: 'claude', key: 'builtin:slow' }, { kind: 'claude', key: 'builtin:test-a' }]);
    assert.equal((await closedFlags()).length, bitmapsBefore + 2, '버려진 응답은 비트맵을 만들지 않는다');

    // none 으로 바꾸면 캐시를 비우고 기본 그림(아이콘)으로, 요청은 없다
    const requestsBeforeNone = calls.sprite.length;
    await scene(withSprites({ claude: 'none', codex: 'none' }));
    await pause(200);
    assert.equal(calls.sprite.length, requestsBeforeNone);
    assert.ok((await closedFlags()).every(Boolean), '캐시가 비워지며 비트맵이 모두 닫힌다');
    const iconPx = await centerPx('claude');
    assert.ok(!(iconPx[3] === 255 && SPRITE_COLORS['builtin:test-a'].every((v, i) => Math.abs(iconPx[i] - v) <= 4)), '아이콘으로 돌아간다');
    assert.ok((await canvasAlpha())[0] > 0);

    // 알림만 모드에서 알림이 세 번 오고 가도 그림 요청은 한 번 (사라졌다 다시 생겨도 캐시를 쓴다)
    await scene({ mode: 'off', codex: true, kinds: {} });
    const requestsBeforeAlerts = calls.sprite.length;
    const alertState = sprites => ({ mode: 'alerts', codex: true, sprites,
      kinds: { claude: { working: false, attention: [{ key: 'a1', tabId: 'a1', label: 'p', reason: 'done', kind: 'done', text: '✅ 답변 완료', at: 1 }] }, codex: { working: false, attention: [] } } });
    const quiet = sprites => ({ mode: 'alerts', codex: true, kinds: idle.kinds, sprites });
    const alertSprites = { claude: 'builtin:test-b', codex: 'none' };
    for (let n = 0; n < 3; n++) {
      const shown = await scene(alertState(alertSprites));
      assert.equal(shown.length, 1, `${n + 1}번째 알림`);
      if (n > 0) near(await centerPx('claude'), SPRITE_COLORS['builtin:test-b'], '캐시로 바로 그려진다');
      else await pause(900);
      assert.deepEqual(await scene(quiet(alertSprites)), [], '알림이 끝나면 펫이 사라진다');
    }
    assert.equal(calls.sprite.length - requestsBeforeAlerts, 1, '알림 세 번에 그림 요청은 한 번');
    // 숨겨진 사이 선택이 바뀌면 캐시를 비우고, 다시 생길 때 새로 요청한다
    await scene(quiet({ claude: 'builtin:test-a', codex: 'none' }));
    assert.ok((await closedFlags()).every(Boolean), '보이지 않는 종류의 캐시도 선택이 바뀌면 닫힌다');
    await scene(alertState({ claude: 'builtin:test-a', codex: 'none' }));
    await pause(900);
    assert.equal(calls.sprite.length - requestsBeforeAlerts, 2);
    near(await centerPx('claude'), SPRITE_COLORS['builtin:test-a'], '새 선택');
    await scene({ mode: 'off', codex: true, kinds: {} });

    // 12. 마우스 바라보기 (Codex 와 같다): 그림 사각형 안으로 들어올 때 시작 · 버전 2 펫만 9·10행의 방향 칸 · 대기일 때만 · 10초 뒤 끝 · 사각형 밖으로 나갔다 다시 들어오면 다시
    await win.webContents.executeJavaScript('window.__petOffset = 0; 0');
    await scene({ mode: 'off', codex: true, kinds: {} });
    await scene(withSprites({ claude: 'builtin:test-v2', codex: 'builtin:test-a' }));
    await pause(1800); // 큰 시트를 읽어 비트맵으로 바꿀 시간
    assert.ok(calls.sprite.some(c => c.key === 'builtin:test-v2'));
    const cursorOf = kind => win.webContents.executeJavaScript(`(() => { const r = document.querySelector('.pet[data-kind="${kind}"] canvas').getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
    const move = (x, y, init = '') => win.webContents.executeJavaScript(`document.dispatchEvent(new PointerEvent('pointermove', { clientX: ${x}, clientY: ${y}, bubbles: true, isPrimary: true, ${init} })); 0`);
    const leave = () => win.webContents.executeJavaScript(`document.documentElement.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null })); 0`);
    const V1_A = SPRITE_COLORS['builtin:test-a'];
    near(await centerPx('claude'), V2_BASE, '커서가 없으면 대기 줄');
    const c0 = await cursorOf('claude');
    const aim = (deg, r = 80) => move(c0.cx + r * Math.sin(deg * Math.PI / 180), c0.cy - r * Math.cos(deg * Math.PI / 180));
    await aim(90); // 그림 사각형 밖(창 안 빈 곳)에서 움직이기만 하면 시작하지 않는다
    near(await centerPx('claude'), V2_BASE, '사각형 밖에서는 시작하지 않는다');
    await move(c0.cx, c0.cy); // 사각형 안으로 들어옴 → 세션 시작 (중심이라 방향은 없음)
    near(await centerPx('claude'), V2_BASE, '중심에서는 바라보지 않는다 (들어온 직후)');
    for (let o = 0; o < 16; o++) { // 16방향 모두: 위쪽(0°)에서 시계 방향 22.5° 마다 한 칸 (커서는 사각형 밖이어도 세션 중이면 계속 바라본다)
      await aim(o * 22.5);
      near(await centerPx('claude'), GAZE_COLORS[o], `${o * 22.5}° 방향 (${o}번째 칸)`);
      near(await centerPx('codex'), V1_A, 'v1 펫은 커서를 보내도 대기 그림 그대로');
    }
    await move(c0.cx, c0.cy); // 펫 중심 1px 이내 → 방향 없음 → 대기 줄
    near(await centerPx('claude'), V2_BASE, '중심에서는 바라보지 않는다');
    await aim(90);
    near(await centerPx('claude'), GAZE_COLORS[4], '오른쪽 (90°)');
    // 대기를 벗어나면 바라보기가 끝나고, 다시 대기가 돼도 자동으로 다시 바라보지 않는다 (사각형 밖으로 나갔다 새로 들어와야)
    const workingScene = { ...withSprites({ claude: 'builtin:test-v2', codex: 'builtin:test-a' }), kinds: { ...idle.kinds, claude: { working: true, attention: [] } } };
    await scene(workingScene);
    near(await centerPx('claude'), V2_BASE, '작업 중에는 바라보지 않는다');
    await aim(270);
    near(await centerPx('claude'), V2_BASE, '작업 중 커서가 움직여도 그대로');
    await scene(withSprites({ claude: 'builtin:test-v2', codex: 'builtin:test-a' }));
    near(await centerPx('claude'), V2_BASE, '대기로 돌아와도 자동으로 다시 바라보지 않는다');
    await aim(270);
    near(await centerPx('claude'), V2_BASE, '밖에서 움직이기만 해서는 시작하지 않는다');
    await scene(workingScene);
    await move(c0.cx, c0.cy); // 작업 중인 펫 위로 들어옴 → 대기가 아니므로 세션 없음, 대기가 돼도 새로 들어와야 시작
    await move(c0.cx + 2, c0.cy);
    await scene(withSprites({ claude: 'builtin:test-v2', codex: 'builtin:test-a' }));
    await move(c0.cx + 4, c0.cy);
    near(await centerPx('claude'), V2_BASE, '작업 중에 들어와 있다가 대기가 돼도 시작하지 않는다');
    await aim(180);
    await move(c0.cx, c0.cy);
    await aim(270);
    near(await centerPx('claude'), GAZE_COLORS[12], '나갔다 새로 들어오면 바라본다');
    // 10초가 지나면 (시계를 건너뛴 뒤 다음 pointermove 에서) 끝나고, 사각형 안에 머문 채 움직여도 다시 시작하지 않는다
    await aim(180); // 밖
    await move(c0.cx, c0.cy); // 안으로 → 시작 (until = 지금 + 10초)
    await win.webContents.executeJavaScript('window.__petOffset = 11000; 0');
    await move(c0.cx + 3, c0.cy);
    near(await centerPx('claude'), V2_BASE, '10초 뒤에는 대기 그림으로 돌아온다');
    await move(c0.cx + 6, c0.cy - 4);
    near(await centerPx('claude'), V2_BASE, '사각형 안에 머문 채 움직여도 다시 시작하지 않는다');
    await aim(180);
    near(await centerPx('claude'), V2_BASE, '끝난 뒤 밖으로 나가도 바로 바라보지 않는다');
    await win.webContents.executeJavaScript('window.__petOffset = 0; 0');
    await move(c0.cx, c0.cy);
    await aim(180);
    near(await centerPx('claude'), GAZE_COLORS[8], '밖으로 나갔다 다시 들어오면 다시 바라본다');
    // 진짜 10초 타이머: 커서가 더 오지 않아도 10초 뒤에는 대기 그림으로
    await pause(10500);
    near(await centerPx('claude'), V2_BASE, '10초 타이머로 바라보기가 끝난다');
    await aim(0);
    near(await centerPx('claude'), V2_BASE, '타이머로 끝난 뒤에도 밖에서는 시작하지 않는다');
    await move(c0.cx, c0.cy);
    await aim(0);
    near(await centerPx('claude'), GAZE_COLORS[0], '나갔다 다시 들어오면 다시');
    // 터치·보조 포인터는 무시한다
    await leave();
    await move(c0.cx, c0.cy, "pointerType: 'touch'");
    await aim(90);
    near(await centerPx('claude'), V2_BASE, 'touch 는 시작하지 않는다');
    await win.webContents.executeJavaScript(`document.dispatchEvent(new PointerEvent('pointermove', { clientX: ${c0.cx}, clientY: ${c0.cy}, bubbles: true, isPrimary: false })); 0`);
    await aim(90);
    near(await centerPx('claude'), V2_BASE, 'isPrimary 가 아니면 시작하지 않는다');
    await move(c0.cx, c0.cy);
    await aim(90);
    near(await centerPx('claude'), GAZE_COLORS[4], '기본 포인터는 시작한다');
    // 보조 경로: 합성 mouseout (relatedTarget null) → 세션 끝. forward 모드에서는 오지 않을 수 있다
    await leave();
    near(await centerPx('claude'), V2_BASE, '창을 떠나면 바로 대기 그림 (보조 경로)');
    // 문서가 숨겨진 상태(visibilityState 스텁)에서는 시작하지 않는다
    await win.webContents.executeJavaScript(`Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); 0`);
    await move(c0.cx, c0.cy);
    await aim(90);
    near(await centerPx('claude'), V2_BASE, '문서가 숨겨지면 시작하지 않는다');
    await win.webContents.executeJavaScript(`delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); 0`);
    await aim(90);
    await move(c0.cx, c0.cy);
    await aim(90);
    near(await centerPx('claude'), GAZE_COLORS[4], '다시 보이면 새로 들어올 때 시작한다');
    // 동작 줄이기 설정(미디어 쿼리 에뮬레이션)이면 시작하지 않는다
    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
    await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await pause(200);
    near(await centerPx('claude'), V2_BASE, '동작 줄이기가 켜지면 진행 중이던 바라보기도 끝난다');
    await aim(180);
    await move(c0.cx, c0.cy);
    await aim(90);
    near(await centerPx('claude'), V2_BASE, '동작 줄이기 설정이면 시작하지 않는다');
    await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await pause(200);
    await aim(180);
    await move(c0.cx, c0.cy);
    await aim(90);
    near(await centerPx('claude'), GAZE_COLORS[4], '설정이 꺼지면 다시 시작한다');
    dbg.detach();
    await leave();
    // v1 펫만 있으면 세션이 없다: 나중에 버전 2 로 바뀌어도 이미 들어와 있던 커서로는 시작하지 않는다
    await scene(withSprites({ claude: 'builtin:test-a', codex: 'builtin:test-b' }));
    await pause(900);
    const c1 = await cursorOf('claude');
    await move(c1.cx, c1.cy);
    await scene(withSprites({ claude: 'builtin:test-v2', codex: 'builtin:test-b' }));
    await pause(1800);
    await win.webContents.executeJavaScript(`document.dispatchEvent(new PointerEvent('pointermove', { clientX: ${c1.cx + 80}, clientY: ${c1.cy}, bubbles: true, isPrimary: true })); 0`);
    near(await centerPx('claude'), V2_BASE, 'v1 펫 위에 들어온 커서로는 세션이 없다');
    await scene(withSprites({ claude: 'builtin:test-v2', codex: 'builtin:test-a' }));
    // version 이 없는 예전 응답은 1 로 본다 · 버전과 그림 크기가 어긋나면 그림을 쓰지 않는다
    await scene({ mode: 'off', codex: true, kinds: {} });
    await scene(withSprites({ claude: 'builtin:legacy', codex: 'builtin:lying' }));
    await pause(1200);
    near(await centerPx('claude'), SPRITE_COLORS['builtin:legacy'], 'version 없는 응답은 v1 시트로 그려진다');
    await aim(45);
    near(await centerPx('claude'), SPRITE_COLORS['builtin:legacy'], 'v1 시트는 커서를 보내도 그대로');
    const lying = await centerPx('codex');
    assert.ok(!(lying[3] === 255 && SPRITE_COLORS['builtin:lying'].every((v, i) => Math.abs(lying[i] - v) <= 4)), '버전 2 인데 1536x1872 인 그림은 쓰지 않는다 (아이콘)');
    await leave();
    await scene({ mode: 'off', codex: true, kinds: {} });

    // 6. 창 크기 보고
    assert.ok(calls.size.length > 0, '크기 보고 없음');
    assert.ok(calls.size.every(s => s.width > 0 && s.height > 0), JSON.stringify(calls.size));

    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ working, alpha, done, alerts, permCalls: calls.perm, sleeping, sleepAlpha, woke, wokeByAlert, collabStart, handoff, chats, arrived, settled, ended, usageWithTwoCards: usageSize, sizeReports: calls.size.length, lastSize: calls.size.at(-1), consoleErrors: errors }, null, 2));
    clearTimeout(watchdog);
    app.exit(0);
  }).catch(e => { console.error(e.stack || e); console.error(JSON.stringify({ consoleErrors: errors })); clearTimeout(watchdog); app.exit(1); });
}
