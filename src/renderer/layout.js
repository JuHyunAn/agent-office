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
