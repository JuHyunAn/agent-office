// 오른쪽(터미널·대화) 영역 너비 조절: 기본 배치(styles.css .layout 의 0.9fr / 3fr, 최소 350px)가 최소 너비이고 왼쪽으로 끌어 넓힌다.
export const CLI_MIN_RATIO = 0.9 / 3;
export const CLI_MIN_PX = 350;
export const OFFICE_MIN = 420; // 사무실 화면이 남겨야 할 최소 너비

// want: 사용자가 끌어 정한 너비, total: 본문 전체 너비 → 적용할 px, 기본 배치를 쓰면 null
export function cliWidthFor(want, total) {
  const min = Math.max(CLI_MIN_PX, total * CLI_MIN_RATIO);
  if (!(want > min)) return null;
  return Math.round(Math.min(want, Math.max(min, total - OFFICE_MIN)));
}

const KEY = 'ao.cliWidth';

export function setupCliResizer(layout, handle) {
  let want = 0;
  try { want = Number(localStorage.getItem(KEY)) || 0; } catch { /* 저장소 없음 */ }
  const apply = () => {
    const px = cliWidthFor(want, layout.clientWidth);
    if (px == null) layout.style.removeProperty('--cli-width');
    else layout.style.setProperty('--cli-width', `${px}px`);
  };
  const save = () => { try { if (want) localStorage.setItem(KEY, String(Math.round(want))); else localStorage.removeItem(KEY); } catch { /* 저장소 없음 */ } };

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging'); document.body.classList.add('resizing-cli');
    const right = layout.getBoundingClientRect().right;
    const move = (ev) => {
      // 기본보다 좁게 끌면 기본 너비에 머문다 — 저장값도 기본 이하로 내려가지 않게 잘라 둔다
      want = Math.min(right - ev.clientX, layout.clientWidth - OFFICE_MIN);
      apply();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
      handle.classList.remove('dragging'); document.body.classList.remove('resizing-cli');
      if (cliWidthFor(want, layout.clientWidth) == null) want = 0;
      save();
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => { want = 0; apply(); save(); });
  window.addEventListener('resize', apply);
  apply();
}

// 코드 화면 아래 분석 패널 높이 조절: 위쪽 경계를 끌어 높이를 바꾼다. 조절 전에는 styles.css 의 기본(min(240px, 40%)).
export const EDITOR_MIN = 120; // 편집기가 남겨야 할 최소 높이
export const CA_BODY_MIN = 48; // 패널 머리줄 아래 본문이 남길 최소 높이 (경계선 포함)

// want: 사용자가 끌어 정한 높이, room: 편집기+분석 패널이 나눠 쓰는 높이, min: 패널 최소(머리줄+본문) → px, 기본이면 null
// viewMin: 편집기(위쪽 영역)가 남길 높이(기본 EDITOR_MIN). 편집기 최소보다 패널 최소가 우선이고, 둘 다 못 지키게 낮은 창에서도 room 을 넘지 않는다.
export function analysisHeightFor(want, room, min, viewMin = EDITOR_MIN) {
  if (!(want > 0)) return null;
  return Math.round(Math.min(room, Math.max(min, Math.min(want, room - viewMin))));
}

const CA_KEY = 'ao.analysisHeight';
const DRAG_START_PX = 3; // 이만큼 움직여야 끌기로 본다 — 클릭 중 손떨림에 저장값이 바뀌지 않게

// panel: 분석 패널, head: 패널 머리줄 (요소, 또는 머리줄 높이를 돌려주는 함수 — 코드 화면 하단은 탭줄+분석 머리줄을 합친다), view: 편집기 영역, handle: 패널 위쪽 경계
// 왼쪽 Git 패널도 같은 동작이라 저장 키·CSS 변수·끄는 중 표시 클래스·머리줄 아래 최소 높이·남길 최소 높이를 옵션으로 받는다 (기본은 분석 패널).
export function setupAnalysisResizer(panel, head, view, handle, { key = CA_KEY, cssVar = '--ca-height', bodyClass = 'resizing-ca', bodyMin = CA_BODY_MIN, viewMin = EDITOR_MIN } = {}) {
  let want = 0;
  try { want = Number(localStorage.getItem(key)) || 0; } catch { /* 저장소 없음 */ }
  // 숨겨져 있으면(패널 닫힘·코드 화면이 아님) 크기를 잴 수 없다 — 다시 보일 때 맞춘다
  const visible = () => !panel.hidden && panel.getClientRects().length > 0;
  const headH = () => (typeof head === 'function' ? head() : head.offsetHeight);
  // 편집기+패널이 나눠 쓰는 높이. 둘의 합으로 재면 창을 한 번에 줄였을 때(편집기가 0 까지 눌려 패널이 넘침) 실제보다 크게 나오므로 부모에서 나머지를 뺀다.
  const room = () => {
    const parent = panel.parentElement;
    let rest = 0;
    for (const c of parent.children) if (c !== panel && c !== view && getComputedStyle(c).position !== 'absolute') rest += c.offsetHeight;
    return parent.clientHeight - rest;
  };
  const fit = () => analysisHeightFor(want, room(), headH() + bodyMin, viewMin);
  const apply = () => {
    if (!visible()) return;
    const px = fit();
    if (px == null) panel.style.removeProperty(cssVar);
    else panel.style.setProperty(cssVar, `${px}px`);
  };
  const save = () => { try { if (want) localStorage.setItem(key, String(Math.round(want))); else localStorage.removeItem(key); } catch { /* 저장소 없음 */ } };

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging'); document.body.classList.add(bodyClass);
    // 잡은 지점 기준으로 끈 거리만큼 바꾼다 (경계의 어디를 잡아도 높이가 튀지 않는다).
    // 패널 아래로 끌어 내려도 0 이하(=기본 높이)로 튀지 않고 최소 높이에 머물게 한다.
    const startH = panel.offsetHeight, startY = e.clientY;
    let moved = false;
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientY - startY) < DRAG_START_PX) return;
      moved = true; want = Math.max(1, startH + startY - ev.clientY); apply();
    };
    // 놓기·취소·패널 닫힘 등 어떤 이유로 캡처가 풀려도 이 이벤트가 온다 — 마무리를 여기 한 곳에서 한다
    const done = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('lostpointercapture', done);
      handle.classList.remove('dragging'); document.body.classList.remove(bodyClass);
      // 끌다 만 범위 밖 값 대신 실제로 적용된 높이를 기억한다. 끌지 않고 클릭만 했으면 잠시 줄어 있던 저장값을 덮어쓰지 않는다.
      if (moved && visible()) want = fit() ?? 0;
      save();
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('lostpointercapture', done);
  });
  handle.addEventListener('dblclick', () => { want = 0; apply(); save(); });
  // 창 크기·머리줄 줄 수가 바뀌면 범위 안으로 다시 맞춘다
  const observer = new ResizeObserver(apply);
  observer.observe(panel.parentElement);
  if (typeof head !== 'function') observer.observe(head);
  apply();
  return { apply };
}

// 코드 화면 왼쪽 목록 너비 조절: 오른쪽 경계를 끌어 넓히거나 좁힌다. 조절 전에는 styles.css 의 기본(280px).
export const SIDE_MIN = 260; // Git 패널 단추 3개가 나란히 들어가는 너비 (D-073)
export const SIDE_MAIN_MIN = 200; // 편집기 쪽이 남겨야 할 최소 너비

// want: 사용자가 끌어 정한 너비, total: 코드 화면 본문 너비 → px, 기본이면 null. 공간이 모자라면 목록 최소가 우선.
export function sideWidthFor(want, total) {
  if (!(want > 0)) return null;
  return Math.round(Math.max(SIDE_MIN, Math.min(want, total - SIDE_MAIN_MIN)));
}

const SIDE_KEY = 'ao.codeSideWidth';

// body: 코드 화면 본문(CSS 변수 --code-side-w 를 둔다), side: 왼쪽 목록, handle: 둘 사이 경계
export function setupSideResizer(body, side, handle) {
  let want = 0;
  try { want = Number(localStorage.getItem(SIDE_KEY)) || 0; } catch { /* 저장소 없음 */ }
  // 코드 화면이 아니면 숨겨져 있어 너비를 잴 수 없다 — 다시 보일 때 맞춘다
  const visible = () => side.getClientRects().length > 0;
  const fit = () => sideWidthFor(want, body.clientWidth);
  // want 는 건드리지 않는다 — 오른쪽 영역을 잠시 넓혔다 되돌리면 원래 너비로 돌아온다
  const apply = () => {
    if (!visible()) return;
    const px = fit();
    if (px == null) body.style.removeProperty('--code-side-w');
    else body.style.setProperty('--code-side-w', `${px}px`);
  };
  const save = () => { try { if (want) localStorage.setItem(SIDE_KEY, String(Math.round(want))); else localStorage.removeItem(SIDE_KEY); } catch { /* 저장소 없음 */ } };

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging'); document.body.classList.add('resizing-cli');
    // 잡은 지점 기준으로 끈 거리만큼 바꾼다. 왼쪽으로 끌어도 0 이하(=기본 너비)로 튀지 않고 최소 너비에 머문다.
    const startW = side.offsetWidth, startX = e.clientX;
    let moved = false;
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - startX) < DRAG_START_PX) return;
      moved = true; want = Math.max(1, startW + ev.clientX - startX); apply();
    };
    // 놓기·취소·화면 전환 등 어떤 이유로 캡처가 풀려도 이 이벤트가 온다 — 마무리를 여기 한 곳에서 한다
    const done = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('lostpointercapture', done);
      handle.classList.remove('dragging'); document.body.classList.remove('resizing-cli');
      // 끌다 만 범위 밖 값 대신 실제로 적용된 너비를 기억한다. 끌지 않고 클릭만 했으면 잠시 줄어 있던 저장값을 덮어쓰지 않는다.
      if (moved && visible()) want = fit() ?? 0;
      save();
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('lostpointercapture', done);
  });
  handle.addEventListener('dblclick', () => { want = 0; apply(); save(); });
  new ResizeObserver(apply).observe(body);
  apply();
}
