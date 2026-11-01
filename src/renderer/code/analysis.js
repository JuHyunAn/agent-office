// 코드 분석 결과를 화면에 붙이는 순수 로직: 주석 줄 찾기·읽는 순서 이동 줄.
// 화면(DOM)·모나코·IPC 와 무관해서 화면 없이 테스트할 수 있다.
// 모델이 준 줄 번호는 틀리거나 분석 뒤 파일이 바뀌어 밀릴 수 있으므로, 줄 번호보다 anchor(그 줄의 코드 원문)를 믿는다.

// 공백 제외 길이가 이보다 짧은 anchor 는 `}` 같은 흔한 줄이라 여러 곳에 있으면 어디가 맞는지 알 수 없다.
const MIN_AMBIGUOUS = 8;

export const splitLines = (text) => String(text).split(/\r?\n/);

// 앞뒤 공백을 무시하고 비교하기 위한 정리.
const norm = (s) => (typeof s === 'string' ? s.trim() : '');

// 주석이 붙을 줄을 찾는다. 못 찾거나 모호하면 null(숨김).
// note.line 의 줄이 anchor 와 같으면 그대로, 아니면 같은 줄 후보 중 note.line 에 가장 가까운 줄(같은 거리면 위쪽).
export function locateNote(note, lines) {
  const anchor = norm(note?.anchor);
  if (!anchor || !Array.isArray(lines)) return null;
  const want = Number.isInteger(note.line) ? note.line : 0;
  if (want >= 1 && want <= lines.length && norm(lines[want - 1]) === anchor) return { line: want, moved: false };
  const hits = [];
  for (let i = 0; i < lines.length; i++) if (norm(lines[i]) === anchor) hits.push(i + 1);
  if (hits.length === 0) return null;
  if (hits.length === 1) return { line: hits[0], moved: true };
  if (anchor.replace(/\s+/g, '').length < MIN_AMBIGUOUS) return null;
  let best = hits[0];
  for (const h of hits) if (Math.abs(h - want) < Math.abs(best - want)) best = h; // 오름차순이라 같은 거리면 먼저 나온 위쪽이 남는다
  return { line: best, moved: true };
}

const pathKey = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase();

// result 의 주석 중 rel 파일 것을 현재 text 기준 줄에 붙인다. 못 찾은 주석은 hidden 개수로만 센다.
// 같은 줄 주석은 입력 순서를 유지한다(Array.prototype.sort 는 안정 정렬).
export function notesForFile(result, rel, text) {
  const list = Array.isArray(result?.annotations) ? result.annotations : [];
  if (!list.length) return { shown: [], hidden: 0 };
  const want = pathKey(rel);
  const lines = typeof text === 'string' ? splitLines(text) : [];
  const shown = [];
  let hidden = 0;
  for (const note of list) {
    if (!note || pathKey(note.file) !== want) continue;
    const at = locateNote(note, lines);
    if (!at) { hidden++; continue; }
    shown.push({ ...note, line: at.line, moved: at.moved, key: `${want}|${note.title}|${note.anchor}` });
  }
  shown.sort((a, b) => a.line - b.line);
  return { shown, hidden };
}

// 읽는 순서 항목을 눌렀을 때 이동할 줄. 못 찾으면 원래 줄(파일 줄 수로 자름)을 moved 로 돌려준다.
// text 가 없으면(아직 파일을 안 읽음) 원래 줄 그대로.
export function jumpLine(item, text) {
  const orig = Number.isInteger(item?.line) ? item.line : 1;
  if (typeof text !== 'string') return { line: orig, moved: false };
  const lines = splitLines(text);
  const at = locateNote(item, lines);
  if (at) return at;
  return { line: Math.min(Math.max(orig, 1), lines.length), moved: true };
}
