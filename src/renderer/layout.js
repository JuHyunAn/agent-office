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
// 편집기 최소보다 패널 최소가 우선이고, 둘 다 못 지키게 낮은 창에서도 room 을 넘지 않는다.
export function analysisHeightFor(want, room, min) {
  if (!(want > 0)) return null;
  return Math.round(Math.min(room, Math.max(min, Math.min(want, room - EDITOR_MIN))));
}

const CA_KEY = 'ao.analysisHeight';

// panel: 분석 패널, head: 패널 머리줄, view: 편집기 영역, handle: 패널 위쪽 경계
export function setupAnalysisResizer(panel, head, view, handle) {
  let want = 0;
  try { want = Number(localStorage.getItem(CA_KEY)) || 0; } catch { /* 저장소 없음 */ }
  // 숨겨져 있으면(패널 닫힘·코드 화면이 아님) 크기를 잴 수 없다 — 다시 보일 때 맞춘다
  const visible = () => !panel.hidden && panel.getClientRects().length > 0;
  const fit = () => analysisHeightFor(want, view.offsetHeight + panel.offsetHeight, head.offsetHeight + CA_BODY_MIN);
  const apply = () => {
    if (!visible()) return;
    const px = fit();
    if (px == null) panel.style.removeProperty('--ca-height');
    else panel.style.setProperty('--ca-height', `${px}px`);
  };
  const save = () => { try { if (want) localStorage.setItem(CA_KEY, String(Math.round(want))); else localStorage.removeItem(CA_KEY); } catch { /* 저장소 없음 */ } };

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging'); document.body.classList.add('resizing-ca');
    // 잡은 지점 기준으로 끈 거리만큼 바꾼다 (경계의 어디를 잡아도 높이가 튀지 않는다).
    // 패널 아래로 끌어 내려도 0 이하(=기본 높이)로 튀지 않고 최소 높이에 머물게 한다.
    const startH = panel.offsetHeight, startY = e.clientY;
    const move = (ev) => { want = Math.max(1, startH + startY - ev.clientY); apply(); };
    // 놓기·취소·패널 닫힘 등 어떤 이유로 캡처가 풀려도 이 이벤트가 온다 — 마무리를 여기 한 곳에서 한다
    const done = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('lostpointercapture', done);
      handle.classList.remove('dragging'); document.body.classList.remove('resizing-ca');
      // 끌다 만 범위 밖 값 대신 실제로 적용된 높이를 기억한다
      if (visible()) want = fit() ?? 0;
      save();
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('lostpointercapture', done);
  });
  handle.addEventListener('dblclick', () => { want = 0; apply(); save(); });
  // 창 크기·머리줄 줄 수가 바뀌면 범위 안으로 다시 맞춘다
  const observer = new ResizeObserver(apply);
  observer.observe(panel.parentElement); observer.observe(head);
  apply();
  return { apply };
}
