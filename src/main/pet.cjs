'use strict';

// 바탕화면 펫 창: 투명·항상 위·포커스 없는 작은 창에 펫을 띄운다. 상태는 메인 화면이 보내 주고(pet:state), 여기서는 창만 관리한다.
const fs = require('node:fs');
const path = require('node:path');
const {
  PET_MODES, PET_KINDS, PET_ID_RE, normalizePetConfig, normalizeSprite, sanitizeUsage, shouldShow, placeBounds, anchorOf, readPet, answerableIds, permsToRelease, CARD_FIELDS, cardPreview,
  sheetVersionOf, spriteVersion,
} = require('./petRules.cjs');
const { imageSize } = require('./petImport.cjs');

const SHEET_HEAD_BYTES = 64 * 1024; // 목록에서 시트 크기를 볼 때 읽는 앞부분
const TAB_ID_RE = /^[a-z0-9-]{1,40}$/i;
const PERM_ID_RE = /^[0-9a-f-]{36}$/i;
const PERM_WATCH_MS = 1000;
const DRAG_MAX_MS = 60 * 1000; // 마우스 놓침 같은 이상으로 드래그가 끝나지 않을 때의 안전장치
const CRASH_RETRY_MS = 10 * 1000;
const CRASH_PAUSE_MS = 60 * 1000;
const ITEM_TEXT = ['key', 'tabId', 'label', 'reason', 'kind', 'text'];

// 메인 화면이 보낸 상태를 정리한다: claude·codex 만, 알려진 필드만, 문자열은 길이를 제한한다.
function sanitizeKinds(kinds) {
  const out = {};
  for (const kind of PET_KINDS) {
    const k = kinds?.[kind] && typeof kinds[kind] === 'object' ? kinds[kind] : {};
    const attention = [];
    for (const x of Array.isArray(k.attention) ? k.attention.slice(-50) : []) {
      if (!x || typeof x !== 'object') continue;
      const item = { at: Number.isFinite(x.at) ? x.at : 0 };
      for (const f of ITEM_TEXT) item[f] = typeof x[f] === 'string' ? x[f].slice(0, 200) : null;
      item.permId = typeof x.permId === 'string' && PERM_ID_RE.test(x.permId) ? x.permId : null;
      item.tool = typeof x.tool === 'string' ? x.tool.slice(0, 60) : '';
      item.preview = typeof x.preview === 'string' ? x.preview.slice(0, 300) : '';
      // 카드 허용은 렌더러가 말한 canAnswer 만 믿지 않고 여기서도 다시 확인한다: permId 가 있고, 허용 목록 도구의 실행 필드 전체가 미리보기와 같을 때만 (cardPreview 규칙).
      const field = Object.hasOwn(CARD_FIELDS, item.tool) ? CARD_FIELDS[item.tool] : null;
      item.canAnswer = x.canAnswer === true && item.permId !== null && field !== null && typeof x.preview === 'string'
        && cardPreview(item.tool, { [field]: x.preview }) === x.preview;
      attention.push(item);
    }
    out[kind] = { working: !!k.working, attention };
  }
  return out;
}

// 협업 대화 정보: active 가 아니면 null. 말하는 AI 는 claude·codex 만 받는다.
function sanitizeCollab(c) {
  if (!c || typeof c !== 'object' || !c.active) return null;
  const agent = (v) => (PET_KINDS.includes(v) ? v : null);
  const tabId = typeof c.tabId === 'string' && TAB_ID_RE.test(c.tabId) ? c.tabId : null;
  return { active: true, tabId, speaker: agent(c.speaker), prev: agent(c.prev), turn: Number.isFinite(c.turn) ? Math.trunc(c.turn) : 0 };
}

// 폴더 안의 펫 목록 [{ id, displayName, version }] — 소문자 폴더 이름에 readPet 검사를 통과하고, 그림 앞부분(64KB)으로 본 크기가 1536x1872(v1)·1536x2288(v2) 이며
// pet.json 의 그림 버전 선언이 있으면 크기가 정한 버전과 같은 것만. 폴더가 없으면 빈 목록.
function scanPets(dir) {
  if (!dir) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && PET_ID_RE.test(d.name) && d.name === d.name.toLowerCase())
      .map((d) => readPet(dir, d.name, fs, { bytes: false, head: SHEET_HEAD_BYTES }))
      .map((r) => ({ r, version: r ? spriteVersion(r.spriteVersionNumber, sheetVersionOf(imageSize(r.head))) : null }))
      .filter((x) => x.version !== null)
      .map(({ r, version }) => ({ id: r.id, displayName: r.displayName, version }));
  } catch {
    return [];
  }
}

function createPetController({
  ipcMain, screen, BrowserWindow, getMainWindow, showMainWindow, sendMain, config, saveConfig,
  isCodexAvailable, userDataDir, onModeChanged, permissions, onUsageRefresh, builtinPetsDir,
}) {
  const before = JSON.stringify(config.pet);
  config.pet = normalizePetConfig(config.pet);
  if (JSON.stringify(config.pet) !== before) saveConfig(config);

  // 펫 그림 목록: 앱에 넣은 기본 펫은 시작 때 한 번, 가져온 펫은 목록을 열 때마다 다시 읽는다 (pushState 에서는 파일에 접근하지 않는다).
  const userPetsDir = path.join(userDataDir, 'pets');
  const builtinPets = scanPets(builtinPetsDir);
  const builtinIds = new Set(builtinPets.map((p) => p.id));
  let userPets = scanPets(userPetsDir);

  // 종류마다 실제로 쓸 그림 키: 'none' (아이콘) | 'builtin:<id>' | 'user:<id>'
  const defaultSprite = (kind) => (builtinIds.has(`office-${kind}`) ? `builtin:office-${kind}` : 'none');
  function resolveSprite(kind) {
    const v = config.pet.sprites[kind];
    if (v === 'none') return 'none';
    if (v === null) return defaultSprite(kind);
    if (v.startsWith('builtin:')) return builtinIds.has(v.slice(8)) ? v : defaultSprite(kind);
    return userPets.some((p) => p.id === v.slice(5)) ? v : 'none';
  }
  // 목록에 있는 키의 펫을 읽는다 (없거나 못 읽으면 null)
  function readPetByKey(key) {
    if (typeof key !== 'string') return null;
    if (key.startsWith('builtin:')) return builtinIds.has(key.slice(8)) ? readPet(builtinPetsDir, key.slice(8)) : null;
    if (key.startsWith('user:')) return userPets.some((p) => p.id === key.slice(5)) ? readPet(userPetsDir, key.slice(5)) : null;
    return null;
  }

  let win = null;
  let last = { kinds: {}, collab: null };
  let size = { width: 220, height: 170 };
  let drag = null;
  let lastCrash = 0;
  let crashUntil = 0; // 렌더러가 짧은 간격으로 반복해서 죽으면 이 시각까지 창을 만들지 않는다
  let disposed = false; // 종료 중에는 창을 다시 만들지 않는다
  let loaded = false; // 펫 화면이 다 불러와졌는지 (카드가 아직 그려질 수 없으면 승인을 붙잡지 않는다)
  let lastUsage = null; // 메인 사용량 서비스가 마지막으로 보낸 스냅샷 (정리됨) — 창이 새로 뜰 때 다시 보낸다

  // 붙잡힌 권한 요청의 보류 관리 (permissions 가 없으면 이 기능은 꺼져 있다).
  // 붙잡은 요청은 렌더러가 보낸 펫 상태에 「답할 수 있음」으로 나타나 있는 동안만 유지하고, 아니면 풀어서 원래 터미널 승인으로 넘긴다.
  const seen = new Set(); // 카드로 답할 수 있다고 확인된 permId — 나타났다가 빠지면 바로 푼다
  let watchTimer = null;

  const alive = () => !!win && !win.isDestroyed();
  // 지금 펫 카드로 권한을 받을 수 있는가: 펫이 켜져 있고 창이 떠서 다 불러와졌고, 렌더러가 반복해서 죽는 중이 아닐 때.
  const canAnswer = () => !disposed && config.pet.mode !== 'off' && alive() && loaded && Date.now() >= crashUntil && !process.env.AGENT_OFFICE_SMOKE;

  function stopWatch() {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
  }

  // 붙잡은 요청을 마지막 펫 상태와 맞춰 본다: 카드로 답할 수 없게 된 것은 {} 로 풀고, 더 없으면 감시를 멈춘다.
  function reconcile() {
    if (!permissions) return;
    const pending = permissions.pending();
    for (const id of permsToRelease(pending, answerableIds(last.kinds, pending), seen, Date.now())) permissions.resolve(id, null);
    const live = new Set(permissions.pending().map((p) => p.id));
    for (const id of [...seen]) if (!live.has(id)) seen.delete(id);
    if (!live.size) stopWatch();
  }

  // 붙잡은 요청이 생기면 hook 서버가 부른다: 1초마다 대조한다 (타이머는 하나).
  function watchPermissions() {
    if (!permissions || watchTimer) return;
    watchTimer = setInterval(reconcile, PERM_WATCH_MS);
  }

  // 펫이 답할 수 없게 되는 순간: 붙잡은 요청을 모두 푼다.
  function releasePermissions() {
    if (!permissions) return;
    permissions.releaseAll();
    seen.clear();
    stopWatch();
  }
  const place = (anchor) => placeBounds(anchor, size, screen.getAllDisplays(), screen.getPrimaryDisplay());

  function pushState() {
    if (!alive()) return;
    let kinds = last.kinds || {};
    if (permissions) {
      // 서버가 붙잡은 요청과 대조해 거부할 항목은 버튼이 켜지지 않게 canAnswer 를 다시 계산해 보낸다
      const ok = answerableIds(kinds, permissions.pending());
      kinds = Object.fromEntries(PET_KINDS.map((kind) => [kind, {
        ...kinds[kind],
        attention: (kinds[kind]?.attention || []).map((x) => (x.canAnswer && !ok.has(x.permId) ? { ...x, canAnswer: false } : x)),
      }]));
    }
    win.webContents.send('pet:state', {
      mode: config.pet.mode, codex: !!isCodexAvailable(), kinds, collab: last.collab,
      sprites: { claude: resolveSprite('claude'), codex: resolveSprite('codex') },
    });
  }

  // 가져온 펫 목록을 다시 읽고, 쓰던 펫이 사라졌으면 펫 화면에 알린다.
  function refreshUserPets() {
    userPets = scanPets(userPetsDir);
    pushState();
  }

  // 선택 화면용 목록: 내장 펫 → 가져온 펫 순. selected 는 설정 원값, resolved 는 지금 실제로 쓰는 그림.
  function listPets() {
    userPets = scanPets(userPetsDir);
    return {
      pets: [
        ...builtinPets.map((p) => ({ key: `builtin:${p.id}`, source: 'builtin', id: p.id, displayName: p.displayName, version: p.version })),
        ...userPets.map((p) => ({ key: `user:${p.id}`, source: 'user', id: p.id, displayName: p.displayName, version: p.version })),
      ],
      selected: { claude: config.pet.sprites.claude, codex: config.pet.sprites.codex },
      resolved: { claude: resolveSprite('claude'), codex: resolveSprite('codex') },
    };
  }

  // 종류별 그림 선택 (null 기본 · 'none' 아이콘만 · 목록에 있는 키). 어긋나면 { ok: false }.
  function selectPet(kind, value) {
    if (!PET_KINDS.includes(kind)) return { ok: false };
    const v = value === null ? null : normalizeSprite(value);
    if (value !== null && v === null) return { ok: false };
    if (v !== null && v !== 'none') {
      if (v.startsWith('user:')) userPets = scanPets(userPetsDir);
      const known = v.startsWith('builtin:') ? builtinIds.has(v.slice(8)) : userPets.some((p) => p.id === v.slice(5));
      if (!known) return { ok: false };
    }
    config.pet.sprites[kind] = v;
    saveConfig(config);
    pushState();
    return { ok: true, selected: v };
  }

  // 사용량 패널 내용을 펫 화면에 보낸다 (스냅샷이 아직 없으면 보내지 않는다 — 패널은 숨김 그대로).
  function pushUsage() {
    if (!alive() || !lastUsage) return;
    win.webContents.send('pet:usage', { expanded: config.pet.usage.expanded, ...lastUsage });
  }

  function setUsage(snapshot) {
    lastUsage = sanitizeUsage(snapshot);
    pushUsage();
  }

  function stopDrag() {
    if (drag) clearInterval(drag.timer);
    drag = null;
  }

  function ensureWindow() {
    if (disposed || alive() || Date.now() < crashUntil) return;
    const w = new BrowserWindow({
      ...place(config.pet.anchor),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      title: 'Agent Office 펫',
      webPreferences: {
        preload: path.join(__dirname, 'preload-pet.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win = w;
    loaded = false;
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.loadURL('app://office/src/renderer/pet/index.html');
    w.webContents.on('did-finish-load', () => { if (win === w) { loaded = true; pushState(); pushUsage(); } });
    w.webContents.on('render-process-gone', () => {
      // 펫 화면이 죽으면 창을 다시 만든다. 10초 안에 또 죽으면 1분 동안 포기한다 (모드를 바꾸면 바로 다시 시도).
      if (win !== w) return; // 이미 바뀐 이전 창의 소식은 세지 않는다
      const retry = Date.now() - lastCrash > CRASH_RETRY_MS;
      lastCrash = Date.now();
      if (!retry) crashUntil = lastCrash + CRASH_PAUSE_MS;
      releasePermissions(); // 카드가 사라졌으니 붙잡은 권한 요청을 모두 푼다
      stopDrag();
      win = null;
      loaded = false;
      if (!w.isDestroyed()) w.destroy();
      if (retry) refresh();
    });
    w.on('closed', () => { if (win === w) { releasePermissions(); win = null; loaded = false; stopDrag(); } });
  }

  function refresh() {
    if (disposed || process.env.AGENT_OFFICE_SMOKE) return;
    if (config.pet.mode === 'off') { destroy(); return; }
    ensureWindow();
    if (!alive()) return; // 렌더러 반복 사망으로 잠시 쉬는 중
    pushState();
    const show = shouldShow(config.pet.mode, last);
    if (show && !win.isVisible()) {
      win.setIgnoreMouseEvents(true, { forward: true });
      win.showInactive();
    } else if (!show && win.isVisible()) {
      stopDrag();
      win.hide();
      win.setIgnoreMouseEvents(true); // 숨길 때는 forward 를 꺼서 전역 마우스 훅을 푼다
    }
  }

  function setState(payload) {
    if (!payload || typeof payload.kinds !== 'object' || !payload.kinds) return;
    last = { kinds: sanitizeKinds(payload.kinds), collab: sanitizeCollab(payload.collab) };
    refresh();
    reconcile();
  }

  function clearState() {
    last = { kinds: {}, collab: null };
    refresh();
    reconcile();
  }

  function setMode(mode) {
    if (!PET_MODES.includes(mode)) return config.pet.mode;
    if (mode === 'off') releasePermissions();
    config.pet.mode = mode;
    crashUntil = 0;
    saveConfig(config);
    if (onModeChanged) onModeChanged(mode);
    refresh();
    return mode;
  }

  function resetPosition() {
    stopDrag();
    config.pet.anchor = null;
    saveConfig(config);
    if (alive()) win.setBounds(place(null));
  }

  function destroy() {
    releasePermissions();
    stopDrag();
    if (alive()) win.destroy();
    win = null;
    loaded = false;
  }

  function shutdown() {
    disposed = true;
    destroy();
  }

  function startDrag() {
    if (!alive() || drag) return;
    drag = { cursor: screen.getCursorScreenPoint(), bounds: win.getBounds(), started: Date.now(), timer: null };
    win.setIgnoreMouseEvents(false);
    drag.timer = setInterval(() => {
      if (!alive() || !drag) { stopDrag(); return; }
      if (Date.now() - drag.started > DRAG_MAX_MS) { endDrag(); return; }
      const p = screen.getCursorScreenPoint();
      win.setBounds({
        x: drag.bounds.x + p.x - drag.cursor.x,
        y: drag.bounds.y + p.y - drag.cursor.y,
        width: drag.bounds.width,
        height: drag.bounds.height,
      });
    }, 16);
  }

  function endDrag() {
    if (!drag) return;
    const start = drag.bounds;
    stopDrag();
    if (!alive()) return;
    win.setIgnoreMouseEvents(true, { forward: true });
    const end = win.getBounds();
    if (end.x === start.x && end.y === start.y) return; // 클릭만 했으면 위치를 고정하지 않는다
    win.setBounds(place(anchorOf(end)));
    config.pet.anchor = anchorOf(win.getBounds());
    saveConfig(config);
  }

  function resize(s) {
    if (!alive() || drag || !s || typeof s !== 'object') return;
    const fit = (v) => Math.min(600, Math.max(40, Math.round(Number(v))));
    const width = fit(s.width);
    const height = fit(s.height);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    if (width === size.width && height === size.height) return;
    size = { width, height };
    win.setBounds(place(config.pet.anchor)); // 기본 위치(anchor 없음)는 그대로 오른쪽 아래 기준으로 유지
  }

  const relayout = () => { if (alive() && !drag) win.setBounds(place(config.pet.anchor)); };
  for (const ev of ['display-removed', 'display-added', 'display-metrics-changed']) screen.on(ev, relayout);

  const fromPet = (e) => alive() && e.sender === win.webContents;
  const fromMain = (e) => { const m = getMainWindow(); return !!m && !m.isDestroyed() && e.sender === m.webContents; };

  ipcMain.on('pet:state', (e, p) => { if (fromMain(e)) setState(p); });
  ipcMain.handle('pet:mode:set', (e, p) => ({ mode: fromMain(e) ? setMode(p?.mode) : config.pet.mode }));
  ipcMain.on('pet:hover', (e, on) => {
    if (!fromPet(e) || drag || !win.isVisible()) return; // 숨긴 창에 forward 를 다시 걸면 전역 마우스 훅이 되살아난다
    if (on) win.setIgnoreMouseEvents(false);
    else win.setIgnoreMouseEvents(true, { forward: true });
  });
  ipcMain.on('pet:drag', (e, phase) => {
    if (!fromPet(e)) return;
    if (phase === 'start') startDrag();
    else if (phase === 'end') endDrag();
  });
  ipcMain.on('pet:size', (e, s) => { if (fromPet(e)) resize(s); });
  ipcMain.on('pet:usage:refresh', (e) => { if (fromPet(e)) onUsageRefresh?.(); });
  ipcMain.on('pet:usage:toggle', (e, expanded) => {
    if (!fromPet(e) || typeof expanded !== 'boolean') return;
    config.pet.usage.expanded = expanded;
    saveConfig(config);
    pushUsage();
  });
  // 카드의 허용·거부: 펫 창에서 왔고, 마지막 펫 상태에 「답할 수 있음」으로 있는 permId 이며, 서버가 붙잡은 도구·입력으로 만든 미리보기가 카드의 것과 같을 때만 전달된다.
  ipcMain.on('pet:perm', (e, p) => {
    if (!permissions || !fromPet(e) || !p || typeof p !== 'object') return;
    if (p.decision !== 'allow' && p.decision !== 'deny') return;
    if (typeof p.permId !== 'string' || !canAnswer() || !answerableIds(last.kinds, permissions.pending()).has(p.permId)) return;
    permissions.resolve(p.permId, p.decision);
  });
  ipcMain.on('pet:open', (e, p) => {
    if (!fromPet(e)) return;
    const tabId = p?.tabId;
    showMainWindow();
    sendMain('pet:activate', { tabId: typeof tabId === 'string' && TAB_ID_RE.test(tabId) ? tabId : null });
  });
  // 펫 그림 요청: 펫 창에서 왔고 key 가 지금 그 종류에 쓸 그림과 같을 때만 읽어 준다. 아니면 (아이콘·불일치·읽기 실패) { key, none: true }.
  ipcMain.handle('pet:sprite', (e, p) => {
    if (!fromPet(e) || !p || typeof p !== 'object' || !PET_KINDS.includes(p.kind) || typeof p.key !== 'string' || p.key.length > 100) return null;
    const none = { key: p.key, none: true };
    if (p.key === 'none' || p.key !== resolveSprite(p.kind)) return none;
    const r = readPetByKey(p.key);
    if (!r) return none;
    // 그림 버전은 지금 보내는 바이트의 크기(높이)로 정한다. 크기를 못 읽거나 허용 밖이면 그림을 쓰지 않는다.
    const version = spriteVersion(r.spriteVersionNumber, sheetVersionOf(imageSize(r.bytes)));
    if (version === null) return none;
    return { key: p.key, displayName: r.displayName, version, type: r.type, bytes: r.bytes, sleepType: r.sleepType ?? null, sleepBytes: r.sleepBytes ?? null };
  });

  function menuItems() {
    return [{
      label: '펫',
      submenu: [
        ...[['always', '상시 표시'], ['alerts', '알림만 표시'], ['off', '끄기']].map(([m, label]) => ({
          label, type: 'radio', checked: config.pet.mode === m, click: () => setMode(m),
        })),
        { type: 'separator' },
        { label: '펫 위치 초기화', click: resetPosition },
      ],
    }];
  }

  return {
    mode: () => config.pet.mode, setMode, setState, setUsage, clearState, refresh, resetPosition, destroy, shutdown, menuItems, canAnswer, watchPermissions,
    listPets, selectPet, refreshUserPets, readPetByKey, builtinIds,
  };
}

module.exports = { createPetController, sanitizeKinds };
