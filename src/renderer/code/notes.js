// 코드 줄 사이 주석: 모나코 view zone 으로 코드 줄 위에 해설 상자를 끼워 넣는다. 화면(DOM)과 모나코만 다루고, 어떤 주석을 어느 줄에 둘지는 바깥(panel.js)이 정한다.
// 모나코 사실(실측): 새 모델을 붙이면 영역은 사라진다 · 영역 안 DOM 은 마우스를 받지 못해 클릭은 편집기 onMouseDown(CONTENT_VIEW_ZONE) 으로 받는다 ·
// 영역을 더하면 모나코가 노드 폭을 100% 로 덮어쓴다(= 긴 줄이 있으면 넓어짐) → 더한 뒤에 폭을 다시 지정한다 · layoutZone 은 더할 때 넘긴 객체의 heightInPx 를 다시 읽는다.
// 비교 보기의 삭제 줄 영역 기본 ordinal 은 10000 (diffEditorViewZones.js:218) → 주석은 그보다 작은 값으로 삭제 블록 위에 고정한다.
// 모든 글은 textContent 로만 넣는다.

const MIN_WIDTH = 50; // 편집기가 숨겨져 폭이 거의 없으면 영역을 만들지 않는다 (글자마다 줄바꿈되어 높이가 터무니없이 커짐)
const NOTE_ORDINAL = 5000; // 삭제 줄 영역(10000)보다 앞 = 같은 자리에서 삭제 블록 위에 주석이 온다
const FIT_ROUNDS = 3; // 영역을 더하면 세로 스크롤바가 생겨 폭이 바뀔 수 있어 맞춤을 몇 번까지 되풀이한다

export function createNotesLayer(monaco) {
  const states = new WeakMap(); // 편집기 → 상태 (리스너는 편집기마다 한 번만 붙인다)
  let active = null; // 지금 영역을 넣어 둔 편집기의 상태

  // 상자 내용: 접힘 표시 + 줄 번호(L12) + 제목(+ 위치 추정) 한 줄, 접히지 않았으면 본문.
  // 주석이 삭제 블록 위에 놓여 해설할 줄과 멀어질 수 있어 줄 번호를 제목에 적는다.
  function fill(el, note, collapsed) {
    const title = document.createElement('div');
    title.className = 'can-title';
    title.textContent = `${collapsed ? '▸' : '▾'} L${note.line} ${note.title}${note.moved ? ' (위치 추정)' : ''}`;
    const kids = [title];
    if (!collapsed) {
      const body = document.createElement('div');
      body.className = 'can-body';
      body.textContent = note.text;
      kids.push(body);
    }
    el.replaceChildren(...kids);
  }

  // 같은 클래스·같은 폭의 숨김 요소로 높이를 잰다 (재고 나면 지운다).
  function measure(note, collapsed, width) {
    const el = document.createElement('div');
    el.className = 'code-analysis-note';
    el.style.cssText = `position:absolute;visibility:hidden;left:-9999px;top:0;width:${width}px`;
    fill(el, note, collapsed);
    document.body.append(el);
    const h = el.offsetHeight;
    el.remove();
    return Math.max(h, 1);
  }

  function stateOf(editor) {
    let st = states.get(editor);
    if (st) return st;
    st = { editor, zones: [], width: 0, req: null, built: null }; // built: 지금 영역이 만들어진 모델·주석 서명
    states.set(editor, st);
    editor.onMouseDown((e) => onDown(st, e));
    editor.onDidLayoutChange((info) => onLayout(st, info));
    return st;
  }

  const widthOf = (st) => st.editor.getLayoutInfo().contentWidth;

  // 영역마다 폭을 맞추고 높이가 달라진 것만 layoutZone 으로 갱신한다.
  function fit(st) {
    for (let round = 0; round < FIT_ROUNDS; round++) {
      const w = widthOf(st);
      st.width = w;
      if (w < MIN_WIDTH || !st.zones.length) return;
      st.editor.changeViewZones((acc) => {
        for (const z of st.zones) {
          z.el.style.width = `${w}px`;
          const h = measure(z.note, z.collapsed, w);
          if (h !== z.spec.heightInPx) { z.spec.heightInPx = h; acc.layoutZone(z.id); }
        }
      });
      if (widthOf(st) === w) return; // 스크롤바가 생기거나 사라져 폭이 바뀌었으면 한 번 더
    }
  }

  const sigOf = (n) => `${n.key}|${n.line}|${n.moved ? 1 : 0}|${n.title}|${n.text}`;

  // 영역이 지금 요청(모델·주석 목록·접힘)과 같게 만들어져 있는가 — 같으면 다시 만들지 않는다
  function upToDate(st) {
    const b = st.built;
    if (!b || !st.req) return false;
    const { notes, collapsed } = st.req;
    return b.model === st.editor.getModel() && b.sigs.length === notes.length && st.zones.length === notes.length
      && notes.every((n, i) => sigOf(n) === b.sigs[i]) && st.zones.every((z) => z.collapsed === collapsed.has(z.note.key));
  }

  function removeZones(st) {
    const ids = st.zones.map((z) => z.id);
    st.zones = [];
    st.built = null;
    if (!ids.length) return;
    try {
      st.editor.changeViewZones((acc) => { for (const id of ids) acc.removeZone(id); });
    } catch { /* 편집기가 이미 정리됨 */ }
  }

  function build(st) {
    const w = widthOf(st);
    st.width = w;
    if (w < MIN_WIDTH) return false;
    const { notes, collapsed } = st.req;
    st.editor.changeViewZones((acc) => {
      for (const note of notes) {
        const isCollapsed = collapsed.has(note.key);
        const el = document.createElement('div');
        el.className = 'code-analysis-note';
        fill(el, note, isCollapsed);
        // ordinal: 같은 자리에 비교 보기의 삭제 줄 영역(기본 10000)이 있으면 그 위에 오게 한다 — 삭제 블록이 길어도 주석이 스크롤 없이 보인다
        const spec = { afterLineNumber: note.line - 1, ordinal: NOTE_ORDINAL, heightInPx: measure(note, isCollapsed, w), domNode: el, suppressMouseDown: true };
        const id = acc.addZone(spec);
        el.style.width = `${w}px`; // 더한 뒤에 지정해야 모나코의 width:100% 에 덮이지 않는다
        st.zones.push({ id, note, el, spec, collapsed: isCollapsed });
      }
    });
    st.built = { model: st.editor.getModel(), sigs: notes.map(sigOf) };
    if (widthOf(st) !== w) fit(st); // 영역을 더해 세로 스크롤바가 생겨 폭이 바뀐 경우만 다시 잰다 (폭이 같으면 이미 그 폭으로 쟀다)
    return true;
  }

  function onLayout(st, info) {
    if (st !== active || !st.req) return;
    const w = info.contentWidth;
    if (w === st.width) return;
    try {
      if (w < MIN_WIDTH) { st.width = w; return; }
      if (upToDate(st)) fit(st);
      else { removeZones(st); build(st); } // 숨겨져 있다가 보이게 됨 (그 사이 요청이 바뀌었으면 새로)
    } catch { /* 모델이 바뀌는 중 */ }
  }

  function onDown(st, e) {
    if (st !== active) return;
    const t = e.target;
    if (!t || t.type !== monaco.editor.MouseTargetType.CONTENT_VIEW_ZONE) return;
    const id = t.detail && t.detail.viewZoneId;
    const z = st.zones.find((x) => x.id === id);
    if (!z) return;
    if (e.event && e.event.leftButton === false) return;
    z.collapsed = !z.collapsed;
    if (z.collapsed) st.req.collapsed.add(z.note.key); else st.req.collapsed.delete(z.note.key);
    fill(z.el, z.note, z.collapsed);
    try {
      st.editor.changeViewZones((acc) => {
        z.spec.heightInPx = measure(z.note, z.collapsed, widthOf(st));
        acc.layoutZone(z.id);
      });
    } catch { /* 모델이 바뀌는 중 */ }
  }

  // 영역을 넣었던 편집기에서 지운다. 편집기·모델이 없어도, 여러 번 불러도 안전하다.
  function clear() {
    const st = active;
    active = null;
    if (!st) return;
    removeZones(st);
    st.req = null;
    st.width = 0;
  }

  // notes: [{ line, title, text, moved, key }] (줄 번호순).
  // 같은 편집기·모델·주석 목록·접힘이면 다시 만들지 않고 true. 편집기가 숨겨져 폭이 없으면 있는 영역은 그대로 두고 false —
  // 요청만 기억해 두었다가 보이게 되면 스스로 만든다 (숨김 해제 직전 호출이 주석을 잠깐 지우지 않게).
  function show(editor, notes, collapsed) {
    if (!editor || !Array.isArray(notes) || !notes.length) { clear(); return true; }
    try {
      if (!editor.getModel()) { clear(); return false; }
      const st = stateOf(editor);
      if (active && active !== st) clear();
      active = st;
      st.req = { notes, collapsed: collapsed instanceof Set ? collapsed : new Set() };
      if (widthOf(st) < MIN_WIDTH) { st.width = widthOf(st); return false; }
      if (upToDate(st)) return true;
      removeZones(st);
      return build(st);
    } catch {
      return false;
    }
  }

  return { show, clear };
}
