// 바탕화면 펫 화면: 종류(Claude·Codex)마다 캔버스 하나. 상태는 메인이 보내 주고, 여기서는 그리기·드래그·클릭만 한다.
import { ROWS, CELL, SHEETS, SLEEP_SHEET, SLEEP_AFTER_MS, gazeCell, visiblePets, petState, bubbleOf, cardOf, usageRowText, updatedText, refreshButton, sessionText } from './model.js';

const W = 96, H = 104; // 캔버스의 CSS 크기
const CHAT_MS = 600; // 💬 가 날아가는 시간 (CSS transition)
const CARD_ARM_MS = 800; // 새 권한 카드·배치가 바뀐 카드의 허용·거부 버튼을 막아 두는 시간 (다른 클릭이 우연히 허용으로 이어지지 않게)
const calcDpr = () => Math.max(1, Math.round((window.devicePixelRatio || 1) * 100) / 100);
let dpr = calcDpr();
const USAGE_TICK_MS = 60000; // 사용량 패널의 남은 시간 문구를 다시 계산하는 간격
const MAX_WINDOW_H = 600; // 메인이 받아 주는 창 높이 상한 (pet.cjs 의 fit)
const MIN_USAGE_BODY_H = 60; // 창이 모자라도 패널 본문은 이만큼은 남긴다
const wrap = document.querySelector('#wrap'); // 창 크기를 재는 기준 (사용량 패널 + 펫)
const root = document.querySelector('#pets');
const now = () => (typeof window.__petNow === 'function' ? window.__petNow() : Date.now()); // 점검에서 시간 경과를 흉내 낼 수 있게

let state = { mode: 'always', codex: false, kinds: {}, collab: null, sprites: {} };
const sheets = new Map(); // 종류 → { key, sheet, sleepSheet, version, gen }: 그림 시트 캐시 (version = Codex 펫 형식 1·2). 펫이 사라졌다 다시 생겨도 재사용하고, 선택한 그림(key)이 바뀔 때만 다시 요청한다
const failedSprites = new Map(); // 종류 → { key, at }: 그림 요청이 마지막으로 실패한 때 (SPRITE_RETRY_MS 안에는 같은 key 를 다시 요청하지 않는다)
const SPRITE_RETRY_MS = 30 * 1000;
let genSeq = 0; // 요청 세대 번호 (늦게 온 응답을 버리는 데 쓴다)
let lastTurn = null; // 마지막으로 본 협업 차례 (협업이 아니면 null)
let lastCollabTab = null; // 그 차례를 보고한 협업 탭 (기준 탭이 바뀌면 차례 번호를 비교하지 않는다)
let layoutSig = null; // 직전 렌더의 카드 배치: 보이는 펫 종류 + 카드 permId 유무 + 각 카드의 오른쪽 끝 기준 위치
const pets = new Map(); // 종류 → { el, canvas, ctx, bubble, card, badge, sheet, sleepSheet, fallback, anim, drag, idleSince, sleepTimer, once, ... }
const flights = new Set(); // 날아가는 중인 💬 → { el, timer }
let usage = null; // 마지막으로 받은 사용량 스냅샷 ({ expanded, claude, codex, session, refresh }) — 아직 못 받았으면 null (패널 숨김)
let usageRows = []; // 지금 그려진 행 → { row, text, bar, fill } (1분마다 글·막대만 다시 맞춘다)
let usageTimer = null; // 1분 타이머 (패널이 보이고 펼쳐져 있고 문서가 보일 때만, 하나)
let usageHoverTimer = null;
const U = {
  root: document.querySelector('#usage'),
  body: document.querySelector('#usage-body'),
  session: document.querySelector('#usage-session'),
  updated: document.querySelector('#usage-updated'),
  refresh: document.querySelector('#usage-refresh'),
  toggle: document.querySelector('#usage-toggle'),
  sec: Object.fromEntries(['claude', 'codex'].map((k) => {
    const s = document.querySelector(`#usage-${k}`);
    return [k, { root: s, rows: s.querySelector('.usage-rows'), err: s.querySelector('.usage-err') }];
  })),
};

// ───────────────────────── 그림 ─────────────────────────

function claudeFallback() {
  const img = new Image();
  img.src = '../assets/pet/claude.png';
  return img;
}

// 그림 시트가 없을 때의 기본 모양. Claude 는 앱 아이콘, Codex 는 캔버스에 직접 그린다.
function drawBase(ctx, p) {
  if (p.kind === 'claude') {
    if (p.fallback.complete && p.fallback.naturalWidth) {
      // 그림 크기(고해상도 원본)와 상관없이 76x76 으로 맞춰 그린다. 줄여 그릴 때는 부드럽게 해야 선명하다.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(p.fallback, -38, -76, 76, 76);
    }
    return;
  }
  ctx.fillStyle = '#1f2a3a';
  ctx.beginPath();
  ctx.roundRect(-34, -72, 68, 72, 14);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(-12, -52, 3, 0, Math.PI * 2); ctx.arc(12, -52, 3, 0, Math.PI * 2); ctx.fill();
  ctx.font = 'bold 22px Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('>_', 0, -24);
}

// 상태별 변형: [위아래 px, 기울기 도, 투명도]
function wobble(name, frame, count) {
  const odd = frame % 2;
  switch (name) {
    case 'idle': return [[0, 0, 1, 1, 1, 0][frame] || 0, 0, 1];
    case 'running': return [-3 * odd, 0, 1];
    case 'waiting': return [0, odd ? 6 : -6, 1];
    case 'waving':
    case 'jumping': return [-8 * Math.abs(Math.sin(Math.PI * frame / count)), 0, 1];
    case 'review': return [-odd, 0, 1];
    case 'failed': return [4, 12, 0.6];
    case 'running-left': return [0, -8, 1];
    case 'running-right': return [0, 8, 1];
    default: return [0, 0, 1];
  }
}

// 협업 대화 중에는 두 캐릭터가 서로 마주 본다: 기본 그림만 3° 기울인다 (시트 그림은 좌우가 정해져 있어 그대로).
const facing = (p) => (state.collab?.active ? (p.kind === 'claude' ? 3 : -3) : 0);

// 자는 모습의 「z」: 프레임마다 위로 떠오르며 옅어진다.
function drawZ(ctx, frame) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < 3; i++) {
    const t = ((frame + i * 2) % 6) / 6;
    ctx.globalAlpha = 1 - t;
    ctx.font = `bold ${10 + i * 3}px "Malgun Gothic", sans-serif`;
    ctx.fillStyle = '#5a6b8c';
    ctx.fillText('z', W * 0.62 + i * 7, 34 - t * 22 - i * 4);
  }
  ctx.globalAlpha = 1;
}

function drawSleep(p, frame) {
  const { ctx, canvas } = p;
  if (p.sleepSheet) { // 자는 동작 줄이 있으면 그대로 (z 는 그림에 이미 있다)
    ctx.drawImage(p.sleepSheet, frame * CELL.width, 0, CELL.width, CELL.height, 0, 0, canvas.width, canvas.height);
    return;
  }
  if (p.sheet) {
    ctx.globalAlpha = 0.75;
    ctx.drawImage(p.sheet, 0, 0, CELL.width, CELL.height, 0, 0, canvas.width, canvas.height); // idle 첫 칸
    ctx.globalAlpha = 1;
  } else {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.translate(W / 2, H - 4);
    ctx.rotate((10 + facing(p)) * Math.PI / 180); // 눕듯이 기울인다
    drawBase(ctx, p);
    ctx.restore();
  }
  drawZ(ctx, frame);
}

function draw(p, name, frame) {
  const { ctx, canvas } = p;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  if (name === 'sleeping') { drawSleep(p, frame); return; }
  const def = ROWS[name];
  if (p.sheet) {
    if (name === 'idle' && p.version === 2 && p.gaze) { // 커서를 바라보는 중: 대기 줄 대신 방향 칸 1장 (버전 2 시트의 9·10행)
      ctx.drawImage(p.sheet, p.gaze.col * CELL.width, p.gaze.row * CELL.height, CELL.width, CELL.height, 0, 0, canvas.width, canvas.height);
      return;
    }
    ctx.drawImage(p.sheet, frame * CELL.width, def.row * CELL.height, CELL.width, CELL.height, 0, 0, canvas.width, canvas.height);
    return;
  }
  const [dy, deg, alpha] = wobble(name, frame, def.ms.length);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(W / 2, H - 4 + dy);
  ctx.rotate((deg + facing(p)) * Math.PI / 180);
  drawBase(ctx, p);
  ctx.restore();
}

// ───────────────────────── 애니메이션 (rAF 대신 칸별 시간으로 setTimeout) ─────────────────────────

function stopTimer(p) {
  clearTimeout(p.anim.timer);
  p.anim.timer = null;
}

function tick(p) {
  const a = p.anim, def = ROWS[a.name];
  a.shown = a.frame;
  draw(p, a.name, a.frame);
  const wait = def.ms[a.frame];
  const lastFrame = a.frame === def.ms.length - 1;
  a.frame = (a.frame + 1) % def.ms.length;
  if (document.visibilityState === 'hidden') { a.timer = null; return; }
  a.timer = setTimeout(() => {
    if (lastFrame && p.once && a.name === p.once) { p.once = null; settle(p); } // 한 바퀴만 도는 동작이 끝나면 원래 상태로
    else tick(p);
  }, wait);
}

// 지금 보여 줄 동작을 정하고 재생한다. 대기 시간(idleSince)도 여기서 관리한다: 대기가 아니거나 드래그·클릭하면 처음부터 다시 센다.
function settle(p) {
  clearTimeout(p.sleepTimer);
  p.sleepTimer = null;
  if (p.dead) return;
  const ks = kindState(p.kind);
  const opts = { collab: state.collab, kind: p.kind };
  const t = now();
  if (p.drag || petState(ks, null, opts) !== 'idle') p.idleSince = null;
  else if (p.idleSince == null) p.idleSince = t;
  const idleFor = p.idleSince == null ? 0 : t - p.idleSince;
  let name = petState(ks, p.drag, { ...opts, idleFor });
  if (p.once && (name === 'running' || name === 'review')) name = 'jumping';
  else p.once = null;
  p.el.dataset.state = name;
  play(p, name);
  // 곧 잠들 때가 되면 한 번만 다시 확인한다 (타이머는 펫마다 하나, 상태가 바뀔 때마다 다시 잡는다).
  if (name === 'idle' && document.visibilityState !== 'hidden') p.sleepTimer = setTimeout(() => settle(p), Math.max(0, SLEEP_AFTER_MS - idleFor) + 50);
}

function play(p, name) {
  if (p.anim.name === name) return;
  // 바라보기 세션에 들어 있던 대기 펫인가 (커서가 중심 1px 안이라 p.gaze 가 비어 있어도 세션 중이면 끝낸다)
  const wasGazing = gaze.on && p.version === 2 && !!p.sheet && p.anim.name === 'idle';
  stopTimer(p);
  p.anim.name = name;
  p.anim.frame = 0;
  p.gaze = null; // 대기를 벗어나면 바라보기를 끝낸다 (다시 대기가 돼도 자동 재개하지 않음 — 새로 들어와야 시작)
  if (wasGazing && name !== 'idle') stopGaze(false);
  tick(p);
}

// 그림이 늦게 도착하면 지금 칸을 다시 그린다.
function redraw(p) {
  if (p.anim.name) draw(p, p.anim.name, p.anim.shown);
}

// 화면 배율(dpr)이 바뀌면 캔버스 픽셀 크기를 다시 맞추고 그린다. 감시는 현재 배율에 대해 한 번만 걸고, 바뀔 때마다 새 배율로 다시 건다.
function sizeCanvas(p) {
  p.canvas.width = Math.round(W * dpr);
  p.canvas.height = Math.round(H * dpr);
  p.ctx.imageSmoothingEnabled = false;
}

function watchDpr() {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener('change', () => {
    dpr = calcDpr();
    for (const p of pets.values()) { sizeCanvas(p); redraw(p); }
    watchDpr();
  }, { once: true });
}
watchDpr();

// ───────────────────────── 마우스 바라보기 (Codex 와 같다) ─────────────────────────
// 창 안의 pointermove 만 받는다. 커서가 버전 2 펫 그림 사각형 안으로 들어오면(inside && !wasInside) 10초 동안 펫이 커서 쪽을 바라보고(진행 중이면 연장),
// 10초 뒤에는 커서가 사각형 밖으로 나갔다 다시 들어올 때까지 바라보지 않는다. 대기를 벗어나면 끝나고 다시 대기가 돼도 새로 들어와야 시작한다.
// 창이 숨겨지거나 동작 줄이기 설정이면 바라보지 않는다. 타이머는 창 전체에 하나.
// 펫 창은 setIgnoreMouseEvents(true,{forward:true}) 라 「창 떠남」 이벤트가 거의 오지 않는다: 그래서 잠금 해제는 사각형 밖 pointermove 로 한다.

const GAZE_MS = 10000;
const gaze = { on: false, wasInside: false, x: 0, y: 0, until: 0, timer: null }; // wasInside = 직전 pointermove 가 펫 그림 사각형 안이었는지
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// 지금 이 펫이 바라볼 칸 ({ row, col }) 또는 null: 세션 중이고, 버전 2 그림이 있고, 대기 동작일 때만 마지막 커서와 캔버스 중심으로 계산한다.
function gazeOf(p) {
  if (!gaze.on || p.version !== 2 || !p.sheet || p.anim.name !== 'idle') return null;
  const r = p.canvas.getBoundingClientRect();
  return gazeCell(gaze.x - (r.left + r.width / 2), gaze.y - (r.top + r.height / 2));
}

// 칸이 바뀐 펫만 다시 그린다.
function updateGaze(p) {
  const next = gazeOf(p), cur = p.gaze;
  if (cur === next || (cur && next && cur.row === next.row && cur.col === next.col)) return;
  p.gaze = next;
  if (p.anim.name === 'idle') redraw(p);
}

// 세션을 끝낸다. leave = 커서가 창을 떠났거나 창이 숨겨진 것 (wasInside 도 푼다: 다시 들어오면 새로 시작).
// 시간이 다 됐거나 대기를 벗어난 경우는 wasInside 를 그대로 둔다 (사각형 안에 머문 채로는 다시 시작하지 않음).
function stopGaze(leave) {
  clearTimeout(gaze.timer);
  gaze.timer = null;
  gaze.on = false;
  if (leave) gaze.wasInside = false;
  for (const p of pets.values()) updateGaze(p);
}

// 커서(x,y)가 그림 사각형 안인 버전 2 펫들 (그림이 있고 보이는 것만)
function petsUnder(x, y) {
  const hit = [];
  for (const p of pets.values()) {
    if (p.version !== 2 || !p.sheet) continue;
    const r = p.canvas.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) hit.push(p);
  }
  return hit;
}

document.addEventListener('pointermove', (e) => {
  if (!e.isPrimary || e.pointerType === 'touch') return;
  if (!Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) return;
  if (gaze.on && now() >= gaze.until) stopGaze(false); // 타이머 전에 시간이 지난 경우 (점검에서 시계를 건너뛸 때)
  const under = petsUnder(e.clientX, e.clientY);
  const inside = under.length > 0;
  // 사각형 안으로 새로 들어왔고 그 펫이 대기 중일 때만 시작·연장한다 (대기가 아니면 wasInside 만 올려, 대기로 돌아와도 새로 들어와야 시작)
  if (inside && !gaze.wasInside && !reduceMotion.matches && document.visibilityState !== 'hidden' && under.some((p) => p.anim.name === 'idle')) {
    gaze.on = true;
    gaze.until = now() + GAZE_MS;
    clearTimeout(gaze.timer);
    gaze.timer = setTimeout(() => { gaze.timer = null; stopGaze(false); }, GAZE_MS);
  }
  gaze.wasInside = inside;
  if (!gaze.on) return;
  gaze.x = e.clientX;
  gaze.y = e.clientY;
  for (const p of pets.values()) updateGaze(p);
});
// 보조: 창을 떠남. forward 모드에서는 오지 않을 수 있다 (WM_MOUSELEAVE 를 Electron 이 삼킴) — 주 경로는 위의 「사각형 밖 pointermove」.
document.documentElement.addEventListener('mouseleave', () => stopGaze(true));
document.documentElement.addEventListener('mouseout', (e) => { if (!e.relatedTarget) stopGaze(true); });
reduceMotion.addEventListener('change', () => { if (reduceMotion.matches) stopGaze(false); });

document.addEventListener('visibilitychange', () => {
  syncUsageTimer();
  if (usageTimer) { updateUsageTexts(); reportSize(); } // 숨겨 둔 사이 지난 시간을 바로 반영
  if (document.visibilityState === 'hidden') { clearFlights(); stopGaze(true); }
  for (const p of pets.values()) {
    if (document.visibilityState === 'hidden') {
      p.cancelPress?.(); // 누른 채 숨겨지면 끝나지 않은 드래그가 남지 않게
      stopTimer(p);
      clearTimeout(p.sleepTimer);
      p.sleepTimer = null;
      p.once = null;
    } else {
      settle(p); // 숨겨 둔 사이 잠들 때가 지났을 수 있다
      if (!p.anim.timer && p.anim.name) tick(p);
    }
  }
});

// ───────────────────────── 💬 주고받기 ─────────────────────────

function clearFlights() {
  for (const f of flights) { clearTimeout(f.timer); f.el.remove(); }
  flights.clear();
}

// 말하던 펫(from) 머리 위에서 다음에 말하는 펫(to) 머리 위로 💬 를 날린다. 끝나면 지우고, 받는 펫이 한 번 깡충 뛴다.
function flyChat(from, to) {
  if (flights.size >= 2) { const old = flights.values().next().value; clearTimeout(old.timer); old.el.remove(); flights.delete(old); }
  const a = from.canvas.getBoundingClientRect(), b = to.canvas.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'pet-chat';
  el.textContent = '💬';
  el.style.left = `${a.left + a.width / 2}px`;
  el.style.top = `${a.top}px`;
  el.style.transition = `transform ${CHAT_MS}ms ease-in-out`;
  document.body.append(el);
  el.getBoundingClientRect(); // 시작 위치를 확정한 뒤 옮겨야 transition 이 돈다
  el.style.transform = `translate(${b.left - a.left}px, ${b.top - a.top}px)`;
  const f = { el, timer: null };
  f.timer = setTimeout(() => {
    flights.delete(f);
    el.remove();
    if (to.dead || document.visibilityState === 'hidden') return;
    to.once = 'jumping';
    settle(to);
  }, CHAT_MS + 50);
  flights.add(f);
}

// ───────────────────────── 펫 만들기·지우기 ─────────────────────────

// 그림 파일을 비트맵으로 읽는다. 크기가 want 와 다르거나 못 읽으면 null.
async function bitmapOf(bytes, type, want) {
  if (!bytes) return null;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type }));
    if (bitmap.width !== want.width || bitmap.height !== want.height) { bitmap.close(); return null; }
    return bitmap;
  } catch { return null; }
}

const wantedSprite = (kind) => { const k = state.sprites[kind]; return k && k !== 'none' ? k : null; }; // 'none'·없음 = 기본 그림(아이콘)

function closeSheets(c) {
  c.sheet?.close();
  c.sleepSheet?.close();
  c.sheet = null;
  c.sleepSheet = null;
}

// 펫이 쓰는 비트맵을 캐시 것으로 맞춘다 (비트맵은 캐시가 갖고 있다 — 펫이 사라져도 닫지 않는다).
function useSheets(p, c) {
  const sheet = c?.sheet ?? null, sleepSheet = c?.sleepSheet ?? null, version = sheet ? c.version : null;
  if (p.sheet === sheet && p.sleepSheet === sleepSheet && p.version === version) return;
  p.sheet = sheet;
  p.sleepSheet = sleepSheet;
  p.version = version; // 그림이 없으면 null
  p.gaze = gazeOf(p); // 바라보는 중이었다면 새 그림에 맞춰 다시 계산
  redraw(p);
}

// 메인에 그림을 요청한다. 그 사이 선택이 바뀌었으면 (키·세대가 다르면) 받은 비트맵을 닫고 버린다.
async function requestSheet(kind, c) {
  const { key, gen } = c;
  const current = () => { const cur = sheets.get(kind); return !!cur && cur.key === key && cur.gen === gen; };
  let r = null;
  try { r = await window.pet.sprite(kind, key); } catch { r = null; } // 못 읽으면 기본 그림 (실패로 기록)
  if (!current()) return;
  if (r?.none && r.key === key) return; // 메인이 아이콘을 쓰라고 한 것은 실패가 아니다
  // 응답의 그림 버전(1·2)에 맞는 크기여야 한다. 버전이 없으면 1 (예전 응답), 그 밖의 값은 실패.
  const version = r?.version === 2 ? 2 : r?.version === 1 || r?.version === undefined ? 1 : null;
  const sheet = r && r.key === key && version ? await bitmapOf(r.bytes, r.type, SHEETS[version]) : null;
  // 자는 동작 줄은 앱 전용 선택 항목 — 없거나 1536x208 이 아니면 기본 자는 모습을 쓴다. 본 시트가 없으면 읽지 않는다.
  const sleepSheet = sheet ? await bitmapOf(r.sleepBytes, r.sleepType, SLEEP_SHEET) : null;
  if (!current()) { sheet?.close(); sleepSheet?.close(); return; }
  if (!sheet) {
    // 요청 실패: 캐시를 비우고 실패 시각을 남긴다 — RETRY_MS 뒤 다음 화면 갱신에서 같은 key 를 다시 요청한다 (타이머는 두지 않는다)
    sleepSheet?.close();
    failedSprites.set(kind, { key, at: Date.now() });
    closeSheets(c);
    sheets.delete(kind);
    const q = pets.get(kind);
    if (q) useSheets(q, null);
    return;
  }
  failedSprites.delete(kind);
  c.sheet = sheet;
  c.sleepSheet = sleepSheet;
  c.version = version;
  const p = pets.get(kind);
  if (p) useSheets(p, c);
}

// 선택한 그림(state.sprites)에 펫을 맞춘다: 캐시 key 가 같으면 그대로 쓰고, 다를 때만 이전 비트맵을 닫고 새로 요청한다.
function syncSprite(p) {
  const key = wantedSprite(p.kind);
  const c = sheets.get(p.kind);
  if (!key) {
    if (c) { closeSheets(c); sheets.delete(p.kind); }
    failedSprites.delete(p.kind);
    useSheets(p, null);
    return;
  }
  if (c?.key === key) { useSheets(p, c); return; }
  if (c) { closeSheets(c); sheets.delete(p.kind); }
  const failed = failedSprites.get(p.kind);
  if (failed && failed.key === key && Date.now() - failed.at < SPRITE_RETRY_MS) { useSheets(p, null); return; } // 실패 뒤 기다리는 중
  const next = { key, sheet: null, sleepSheet: null, version: null, gen: ++genSeq };
  sheets.set(p.kind, next);
  useSheets(p, next);
  requestSheet(p.kind, next);
}

function kindState(kind) {
  return state.kinds[kind] || {};
}

// ───────────────────────── 권한 카드 ─────────────────────────

// 말풍선 대신 쓰는 권한 요청 카드: 머리줄 · 명령 미리보기 · (외 n건) · [허용][거부] 또는 안내. 글은 모두 textContent 로만 넣는다.
function createCard() {
  const part = (tag, cls, text) => {
    const n = document.createElement(tag);
    n.className = cls;
    if (text) n.textContent = text;
    return n;
  };
  const root = part('div', 'pet-card');
  root.hidden = true;
  const head = part('div', 'pet-card-head');
  const preview = part('div', 'pet-card-preview');
  const more = part('div', 'pet-card-more');
  const hint = part('div', 'pet-card-hint', '그 터미널에서 답해 주세요');
  const actions = part('div', 'pet-card-actions');
  const allow = part('button', 'pet-card-allow', '허용');
  const deny = part('button', 'pet-card-deny', '거부');
  allow.type = 'button';
  deny.type = 'button';
  actions.append(allow, deny);
  root.append(head, preview, more, hint, actions);
  return { root, head, preview, more, hint, actions, allow, deny };
}

// 허용·거부 버튼을 800ms 막는다. 타이머는 카드(펫)마다 하나 — 다시 걸면 이전 것을 취소하므로 쌓이지 않는다. 이미 답을 보낸 카드는 계속 막혀 있다.
function armCard(p) {
  const u = p.card, id = p.cardPermId;
  clearTimeout(p.cardTimer);
  p.cardTimer = null;
  if (!id) return;
  u.allow.disabled = true;
  u.deny.disabled = true;
  if (p.cardAnswered) return;
  p.cardTimer = setTimeout(() => {
    p.cardTimer = null;
    if (p.cardPermId === id && !p.cardAnswered) { u.allow.disabled = false; u.deny.disabled = false; }
  }, CARD_ARM_MS);
}

// 카드 내용을 맞춘다. 같은 permId 로 다시 그릴 때는 버튼 상태·타이머를 건드리지 않고, permId 가 바뀔 때만 버튼을 800ms 막는다 (배치가 바뀐 경우는 render 가 armCard 를 다시 부른다).
function renderCard(p, c) {
  const u = p.card;
  if (!c) {
    if (!u.root.hidden) {
      const wasHover = u.root.matches(':hover');
      u.root.hidden = true;
      // 마우스가 올라간 채 카드가 사라지면 pointerleave 가 오지 않는다: 레이아웃이 갱신된 뒤 아직 펫 위면 계속 닿게, 아니면 놓는다 (타이머는 펫마다 하나).
      if (wasHover) {
        clearTimeout(p.hoverTimer);
        p.hoverTimer = setTimeout(() => {
          p.hoverTimer = null;
          if (!p.dead) window.pet.hover(p.el.matches(':hover'));
        }, 0);
      }
    }
    clearTimeout(p.cardTimer);
    p.cardTimer = null;
    p.cardPermId = null;
    return;
  }
  u.root.hidden = false;
  u.head.textContent = `🔐 ${[c.label, c.tool].filter(Boolean).join(' · ')}`;
  u.preview.textContent = c.preview; // 승인 대상 전체를 줄임 없이 보인다 (cardOf 의 canAnswer 는 길이·줄 수 제한을 이미 지켰다)
  u.preview.hidden = !c.preview;
  u.root.classList.toggle('hint', !c.canAnswer); // 안내 카드는 미리보기를 4줄까지만 (답할 수 있는 카드는 전문)
  u.more.textContent = c.more > 0 ? `외 ${c.more}건` : '';
  u.more.hidden = c.more <= 0;
  u.actions.hidden = !c.canAnswer;
  u.hint.hidden = c.canAnswer;
  if (!c.canAnswer) {
    clearTimeout(p.cardTimer);
    p.cardTimer = null;
    p.cardPermId = null;
    return;
  }
  if (p.cardPermId === c.permId) return;
  p.cardPermId = c.permId;
  p.cardAnswered = false;
  armCard(p);
}

function createPet(kind) {
  const canvas = document.createElement('canvas');
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  const ctx = canvas.getContext('2d');
  const bubble = document.createElement('div');
  bubble.className = 'pet-bubble';
  bubble.hidden = true;
  const badge = document.createElement('span');
  badge.className = 'pet-badge';
  badge.hidden = true;
  const art = document.createElement('div');
  art.className = 'pet-art';
  art.append(canvas, badge);
  const card = createCard();
  const el = document.createElement('div');
  el.className = 'pet';
  el.append(card.root, bubble, art);
  root.append(el);

  const p = { kind, el, canvas, ctx, bubble, card, badge, sheet: null, sleepSheet: null, version: null, gaze: null, fallback: null, anim: { name: null, frame: 0, shown: 0, timer: null }, drag: null, dead: false,
    idleSince: null, sleepTimer: null, once: null, cancelPress: null, cardPermId: null, cardAnswered: false, cardTimer: null, hoverTimer: null };
  sizeCanvas(p);
  if (kind === 'claude') {
    p.fallback = claudeFallback();
    p.fallback.addEventListener('load', () => redraw(p));
  }
  attachPointer(p);
  pets.set(kind, p);
  syncSprite(p); // 캐시가 있으면 바로 쓴다
  return p;
}

function removePet(p) {
  p.dead = true;
  p.gaze = null;
  // 바라보던 버전 2 펫이 모두 사라지면 세션을 끝낸다 (새로 생긴 펫은 새로 들어와야 바라본다)
  if (gaze.on && ![...pets.values()].some((q) => q !== p && q.version === 2 && q.sheet)) stopGaze(false);
  if (p.el.matches(':hover')) window.pet.hover(false); // 마우스가 올라간 채 사라지면 pointerleave 가 오지 않는다
  stopTimer(p);
  clearTimeout(p.sleepTimer);
  clearTimeout(p.cardTimer);
  clearTimeout(p.hoverTimer);
  p.el.remove(); // 그림 비트맵은 캐시(sheets) 것이라 닫지 않는다
  pets.delete(p.kind);
}

// ───────────────────────── 마우스 ─────────────────────────

function attachPointer(p) {
  const { el, canvas } = p;
  let press = null;
  const open = () => {
    const b = bubbleOf(kindState(p.kind));
    window.pet.open(b?.key ?? null, b?.tabId ?? null);
  };
  // 누른 채로 캡처를 잃거나 창이 숨겨질 때: 진행 중인 누름·드래그를 정리한다 (pointerup 이 오지 않는다).
  p.cancelPress = () => {
    if (!press) return;
    press = null;
    p.drag = null;
    window.pet.drag('end');
    window.pet.hover(false);
    settle(p);
  };
  el.addEventListener('pointerenter', () => window.pet.hover(true));
  el.addEventListener('pointerleave', () => { if (!press) window.pet.hover(false); });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    press = { x: e.screenX, y: e.screenY, moved: false, lastX: e.screenX };
    p.idleSince = null; // 만지면 깬다
    settle(p);
    window.pet.drag('start');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!press) return;
    if (!press.moved && Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) press.moved = true;
    if (!press.moved) return;
    const dx = e.screenX - press.lastX;
    if (Math.abs(dx) < 2) return;
    p.drag = dx < 0 ? 'left' : 'right';
    press.lastX = e.screenX;
    settle(p);
  });
  const release = (e) => {
    if (!press) return;
    const { moved } = press;
    press = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* 이미 풀림 */ }
    window.pet.drag('end');
    p.drag = null;
    settle(p);
    const r = el.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom) window.pet.hover(true); // 놓은 자리가 아직 펫 위면 클릭이 계속 닿게
    else window.pet.hover(false);
    if (moved || e.type !== 'pointerup') return;
    open();
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('lostpointercapture', p.cancelPress);
  p.bubble.addEventListener('click', open); // 말풍선 클릭도 캔버스 클릭과 같다 (드래그는 캔버스에서만)
  p.card.root.addEventListener('click', () => { // 카드 클릭(버튼 밖)은 카드가 가리키는 항목의 탭을 연다
    const c = cardOf(kindState(p.kind));
    window.pet.open(c?.key ?? null, c?.tabId ?? null);
  });
  for (const [btn, decision] of [[p.card.allow, 'allow'], [p.card.deny, 'deny']]) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // 카드 클릭(open)으로 이어지지 않게
      if (btn.disabled || !p.cardPermId) return;
      p.cardAnswered = true; // 한 번 누르면 둘 다 막는다 (이 요청에는 더 답할 수 없다)
      clearTimeout(p.cardTimer);
      p.cardTimer = null;
      p.card.allow.disabled = true;
      p.card.deny.disabled = true;
      window.pet.answer(p.cardPermId, decision);
    });
  }
}

// ───────────────────────── 사용량 패널 ─────────────────────────

// 행 하나: 「라벨 · 58% 사용 · 리셋 2시간 13분 후」 + 가는 막대. 글·막대 내용은 updateUsageTexts 가 채운다 (모두 textContent).
function createUsageRow(row) {
  const el = document.createElement('div');
  el.className = 'usage-row';
  const text = document.createElement('div');
  text.className = 'usage-row-text';
  const bar = document.createElement('div');
  bar.className = 'usage-bar';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', row.label);
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  const fill = document.createElement('div');
  fill.className = 'usage-fill';
  bar.append(fill);
  el.append(text, bar);
  usageRows.push({ row, text, bar, fill });
  return el;
}

// 행의 글·막대와 아래 줄(갱신 시각·⟳ 버튼)을 지금 시각으로 다시 맞춘다. DOM 은 새로 만들지 않는다.
function updateUsageTexts() {
  if (!usage) return;
  const t = now();
  for (const r of usageRows) {
    const { pct, reset } = usageRowText(r.row, t);
    r.text.textContent = `${r.row.label} · ${pct}${reset && reset !== pct ? ` · ${reset}` : ''}`; // 「리셋됨」이 두 번 나오지 않게
    const known = Number.isFinite(r.row.percent) && !(Number.isFinite(r.row.resetsAt) && r.row.resetsAt <= t); // 리셋 시각이 지난 값은 막대를 비운다
    r.fill.style.width = known ? `${r.row.percent}%` : '0%';
    r.fill.dataset.level = known ? (r.row.percent >= 90 ? 'high' : r.row.percent >= 70 ? 'warn' : 'ok') : 'ok';
    if (known) r.bar.setAttribute('aria-valuenow', String(r.row.percent));
    else r.bar.removeAttribute('aria-valuenow');
  }
  const stamps = [usage.claude.updatedAt, usage.codex.updatedAt].filter(Number.isFinite);
  U.updated.textContent = updatedText(stamps.length ? Math.max(...stamps) : null, t);
  const btn = refreshButton(usage.refresh, t);
  U.refresh.disabled = btn.disabled;
  U.refresh.title = btn.title;
}

// 1분 타이머는 패널이 보이고 펼쳐져 있고 문서가 숨겨지지 않았을 때만 돈다 (하나만).
function syncUsageTimer() {
  const need = !!usage && usage.expanded && !U.root.hidden && document.visibilityState !== 'hidden';
  if (need && !usageTimer) usageTimer = setInterval(() => { updateUsageTexts(); reportSize(); }, USAGE_TICK_MS);
  else if (!need && usageTimer) { clearInterval(usageTimer); usageTimer = null; }
}

// 마우스가 올라간 채 패널이 사라지거나 접히면 pointerleave 가 오지 않는다: 레이아웃이 갱신된 뒤 아직 패널·펫 위인지 다시 알린다 (타이머 하나).
function syncUsageHover() {
  clearTimeout(usageHoverTimer);
  usageHoverTimer = setTimeout(() => {
    usageHoverTimer = null;
    window.pet.hover(document.querySelector('#usage:hover, .pet:hover') !== null);
  }, 0);
}

// 패널을 받은 스냅샷대로 다시 그린다 (펫이 하나도 없으면 숨김). 창 크기 보고는 부르는 쪽이 한다.
function renderUsage() {
  const show = !!usage && pets.size > 0;
  const wasHover = !U.root.hidden && U.root.matches(':hover');
  const wasOpen = U.root.dataset.open;
  U.root.hidden = !show;
  if (show) {
    const open = usage.expanded;
    U.root.dataset.open = String(open);
    U.body.hidden = !open;
    U.toggle.textContent = open ? '∨ 사용량' : '∧ 사용량';
    U.toggle.setAttribute('aria-expanded', String(open));
    usageRows = [];
    if (open) {
      for (const kind of ['claude', 'codex']) {
        const s = usage[kind], sec = U.sec[kind];
        sec.rows.replaceChildren(...s.rows.map(createUsageRow));
        sec.err.textContent = s.error || '';
        sec.root.hidden = !s.rows.length && !s.error;
      }
      U.session.hidden = !usage.session;
      U.session.textContent = usage.session ? sessionText(usage.session) : '';
      updateUsageTexts();
    }
  }
  syncUsageTimer();
  if (wasHover && (!show || U.root.dataset.open !== wasOpen)) syncUsageHover();
}

U.root.addEventListener('pointerenter', () => window.pet.hover(true));
U.root.addEventListener('pointerleave', () => window.pet.hover(false));
U.refresh.addEventListener('click', () => { if (!U.refresh.disabled) window.pet.usageRefresh(); });
U.toggle.addEventListener('click', () => {
  if (!usage) return;
  usage.expanded = !usage.expanded;
  renderUsage();
  reportSize();
  window.pet.usageToggle(usage.expanded);
});

// 창 크기를 내용(#wrap: 사용량 패널 + 펫)에 맞춰 보고한다. 보일 펫이 없으면 가장 작게.
function reportSize() {
  if (!pets.size) { window.pet.size(40, 40); return; }
  U.body.style.maxHeight = ''; // 이전에 줄인 높이는 풀고 다시 잰다
  let r = wrap.getBoundingClientRect();
  if (r.height > MAX_WINDOW_H) {
    // 창 높이 상한(메인이 600 으로 자른다)을 넘으면 패널 본문(스크롤됨)을 넘는 만큼 줄여 다시 잰다 (최소 60px).
    const bodyH = U.body.getBoundingClientRect().height;
    if (bodyH > 0) {
      U.body.style.maxHeight = `${Math.max(MIN_USAGE_BODY_H, Math.floor(bodyH - (r.height - MAX_WINDOW_H)))}px`;
      r = wrap.getBoundingClientRect();
    }
  }
  window.pet.size(Math.ceil(r.width), Math.ceil(r.height));
}

// ───────────────────────── 화면 갱신 ─────────────────────────

function render() {
  const want = visiblePets(state);
  for (const p of [...pets.values()]) if (!want.includes(p.kind)) removePet(p);
  // 보이지 않는 종류의 캐시는 선택이 바뀌었을 때만 비운다 (알림만 모드에서 다시 생길 때 재사용하려고 그 밖에는 둔다)
  for (const [kind, c] of [...sheets]) if (!pets.has(kind) && c.key !== wantedSprite(kind)) { closeSheets(c); sheets.delete(kind); }
  for (const kind of want) {
    const p = pets.get(kind) || createPet(kind);
    syncSprite(p);
    const ks = kindState(kind);
    const b = bubbleOf(ks);
    const card = cardOf(ks);
    const list = ks.attention || [];
    renderCard(p, card);
    p.bubble.textContent = b?.text || '';
    p.bubble.hidden = !b || !!card; // 권한 카드가 있으면 말풍선 대신 카드
    p.el.dataset.kind = kind;
    p.el.dataset.attn = list.at(-1)?.kind || '';
    p.badge.hidden = list.length < 2;
    p.badge.textContent = list.length >= 2 ? String(list.length) : '';
    settle(p);
  }
  // 종류 순서를 유지한다 (순서가 달라졌을 때만 옮긴다 — 드래그 중 요소를 옮기면 마우스 캡처가 풀린다).
  if (want.some((k, i) => root.children[i] !== pets.get(k).el)) root.append(...want.map((k) => pets.get(k).el));
  if (gaze.on) for (const p of pets.values()) updateGaze(p); // 배치가 바뀌었을 수 있으니 바라보는 칸을 다시 계산
  // 카드 배치가 바뀌면(펫이 사라지거나 카드가 생기고 사라져 카드가 밀림) 남은 카드의 버튼을 다시 800ms 막는다 — 누르려던 카드가 옮겨 가 다른 요청을 허용하는 오클릭 방지.
  // 위치는 창이 붙어 있는 오른쪽 끝 기준이다 (오른쪽의 폭이 달라지면 화면에서 카드가 밀린다).
  const rr = root.getBoundingClientRect().right;
  const sig = want.map((k) => { const p = pets.get(k); return `${k}:${p.cardPermId ? 1 : 0}:${Math.round(p.el.getBoundingClientRect().left - rr)}`; }).join('|');
  if (layoutSig !== null && sig !== layoutSig) for (const k of want) { const p = pets.get(k); if (p.cardPermId && !p.card.root.hidden) armCard(p); }
  layoutSig = sig;
  // 협업 대화에서 말하는 AI 가 바뀌었으면 💬 를 날린다. 처음 본 차례(창이 막 떴거나 협업이 막 시작)는 지나간 일이라 날리지 않는다.
  // 기준 협업 탭이 바뀌었으면 차례 번호를 비교하지 않는다 (다른 탭의 번호라 가짜 💬 가 생긴다).
  const c = state.collab;
  root.classList.toggle('collab', !!c?.active); // 날아가는 💬 가 창 위에서 잘리지 않게 위 여백을 넓힌다 (크기 보고에 포함)
  if (c?.active) {
    if (c.tabId !== lastCollabTab) lastTurn = null;
    const from = pets.get(c.prev), to = pets.get(c.speaker);
    if (lastTurn !== null && c.turn !== lastTurn && from && to && from !== to && document.visibilityState !== 'hidden') flyChat(from, to);
    lastTurn = c.turn;
    lastCollabTab = c.tabId;
  } else {
    lastTurn = null;
    lastCollabTab = null;
  }
  if (U.root.hidden === !!(usage && pets.size)) renderUsage(); // 보일 펫이 생기거나 없어지면 패널도 보이거나 숨긴다 (내용은 사용량을 받을 때만 다시 그린다)
  reportSize();
}

window.pet.onState((s) => {
  const sprite = (v) => (typeof v === 'string' && v.length <= 100 ? v : null);
  state = {
    mode: s?.mode || 'always', codex: !!s?.codex, kinds: s?.kinds || {}, collab: s?.collab?.active ? s.collab : null,
    sprites: { claude: sprite(s?.sprites?.claude), codex: sprite(s?.sprites?.codex) },
  };
  render();
});

window.pet.onUsage((s) => {
  if (!s || typeof s !== 'object') return;
  const section = (x) => ({ rows: Array.isArray(x?.rows) ? x.rows : [], error: typeof x?.error === 'string' ? x.error : null, updatedAt: Number.isFinite(x?.updatedAt) ? x.updatedAt : null });
  usage = { expanded: s.expanded !== false, claude: section(s.claude), codex: section(s.codex), session: s.session || null, refresh: s.refresh || {} };
  renderUsage();
  reportSize();
});
