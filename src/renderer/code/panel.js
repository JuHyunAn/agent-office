// 코드 화면: 폴더 선택 · 이번 작업에서 건드린 파일 · 전체 파일 트리 · 모나코 보기/변경 비교 · 10초 갱신.
// 읽기 전용이다 (파일을 바꾸는 기능이 없다). 화면(DOM)은 시작 때 만들고, 모나코는 첫 파일을 열 때 불러온다.
import { touchedFrom, TouchedList, buildTree, createRefresher } from './model.js';
import { loadMonaco } from './monaco.js';

function node(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c instanceof Node ? c : String(c));
  return n;
}

// 폴더 비교 키: 끝 구분자를 떼고 소문자로 (Windows 는 대소문자를 가리지 않는다).
const keyOf = (dir) => String(dir).replace(/[\\/]+$/, '').toLowerCase();
const clock = () => new Date().toTimeString().slice(0, 8);
const hm = (t) => new Date(t).toTimeString().slice(0, 5);
// IPC 거부 메시지의 「Error invoking remote method '…': Error: 」 머리말은 떼고 보여 준다.
const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
const baseOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
const dirOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

// 상태 글자: 병합 충돌 → !, ?? → U, 그 밖엔 두 글자 중 공백이 아닌 첫 글자 (M 수정 · A 추가 · D 삭제 · R 이름 바뀜 · C 복사).
const CONFLICTS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const letterOf = (code) => (CONFLICTS.has(code) ? '!' : code === '??' ? 'U' : code.trim()[0] || '');
const LETTER_TITLE = { M: '수정됨', A: '추가됨', D: '삭제됨', R: '이름이 바뀜', C: '복사됨', U: '추적하지 않는 새 파일', '!': '병합 충돌' };

const GIT_TEXT = {
  'not-repo': '깃 저장소에서만 코드 화면을 지원합니다',
  'no-git': 'git 을 찾지 못했습니다',
  unsafe: 'git 이 이 폴더를 안전하지 않은 저장소로 봅니다 (safe.directory 설정 필요)',
};
const FILE_NOTE = {
  binary: () => '바이너리 파일은 표시하지 않습니다',
  large: (r) => `파일이 커서(${(r.size / 1048576).toFixed(1)} MB) 표시하지 않습니다`,
  dir: () => '폴더(서브모듈)는 표시하지 않습니다',
  missing: () => '파일이 없습니다 (삭제되었거나 이름이 바뀜)',
};
const EDITOR_FONT = '"Cascadia Mono", Consolas, "D2Coding", "Malgun Gothic", monospace';

export function createCodePanel({ api, host }) {
  const folders = []; // setFolders 로 받은 탭 폴더 — 더하기만 한다 (탭을 닫아도 앱을 끌 때까지 목록에서 고를 수 있다)
  const picked = []; // 「폴더 열기…」로 직접 고른 폴더
  const touchedBy = new Map(); // keyOf(폴더) → TouchedList — 앱 시작부터 모은다 (보이든 안 보이든)
  const expanded = new Set(); // 펼친 폴더 경로 (갱신해도 유지)

  let current = null; // 지금 보는 폴더
  let visible = false;
  // 늦은 응답 버리기: gen 은 폴더·파일을 바꿀 때마다, folderGen 은 폴더를 바꿀 때만, treeSeq 는 트리를 다시 받을 때마다 올린다.
  let gen = 0;
  let folderGen = 0;
  let treeSeq = 0;
  let treeBusy = false;
  let treeInfo = null; // codeTree 결과 ({ git: true, files, truncated } | { git: false, reason })
  let tree = null;
  let fileSet = new Set();
  let fileByLower = new Map(); // 소문자 경로 → 트리 표기 (대소문자만 다른 경로를 트리 표기로 맞춘다)
  let treeError = ''; // 트리를 받지 못한 이유 (안내 영역에 보인다)
  let status = new Map(); // 경로 → 두 글자 코드
  let dirty = new Set(); // 변경이 든 폴더 경로
  let lastMissing = ''; // 마지막으로 트리를 다시 받게 한 「트리에 없는 변경 경로」 — 같은 이유로 되풀이하지 않게
  let open = null; // 열린 파일 { rel, kind('error' 면 열기 실패), text, base, mtimeMs, code, loading }
  let diffPref = true; // 「변경 비교」 토글 (변경이 있고 원본을 받았을 때만 효력)

  let monaco = null;
  let editor = null;
  let diff = null;
  let models = [];
  let view = 'message'; // 'editor' | 'diff' | 'message' | 'idle'
  let revealFirst = false;

  // ───────── DOM ─────────
  const folderSel = node('select', { class: 'code-folder', 'aria-label': '작업 폴더', onchange: () => selectFolder(folderSel.value) });
  const pickBtn = node('button', { class: 'code-pick', type: 'button', onclick: pick }, '폴더 열기…');
  const refreshBtn = node('button', { class: 'code-refresh', type: 'button', title: '지금 새로 고침', 'aria-label': '새로 고침', onclick: () => { loadTree(); } }, '⟳');
  const statusEl = node('span', { class: 'code-status' });
  const touchedEl = node('ul', { class: 'code-touched' });
  const noteEl = node('p', { class: 'code-note', hidden: true });
  const treeEl = node('ul', { class: 'code-tree' });
  const pathEl = node('span', { class: 'code-path' });
  const toggleBtn = node('button', { class: 'code-diff-toggle', type: 'button', 'aria-pressed': 'false', disabled: true, onclick: toggleDiff }, '변경 비교');
  const editorEl = node('div', { class: 'code-editor', hidden: true });
  const diffEl = node('div', { class: 'code-diff', hidden: true });
  const messageEl = node('p', { class: 'code-message' });
  // 파일을 고르기 전 빈 화면: 안내 글 대신 회색 로고만 둔다.
  const idleEl = node('div', { class: 'code-idle', hidden: true }, node('span', { class: 'brand-mark', 'aria-hidden': 'true' }));

  host.replaceChildren(
    node('div', { class: 'code-head' }, folderSel, pickBtn, refreshBtn, statusEl),
    node('div', { class: 'code-body' },
      node('div', { class: 'code-side' },
        node('h3', { class: 'code-section' }, '이번 작업에서 건드린 파일'), touchedEl,
        node('h3', { class: 'code-section' }, '전체 파일'), noteEl, treeEl),
      node('div', { class: 'code-main' },
        node('div', { class: 'code-file-head' }, pathEl, toggleBtn),
        node('div', { class: 'code-view' }, editorEl, diffEl, messageEl, idleEl))));

  // 트리에 대소문자만 다른 같은 경로가 있으면 트리 표기로 맞춘다 (정확히 같은 표기가 먼저, 없으면 원래 표기 그대로).
  function canon(rel) {
    return fileSet.has(rel) ? rel : fileByLower.get(rel.toLowerCase()) ?? rel;
  }

  // 목록을 다시 그려도 키보드 초점이 있던 항목을 되찾는다.
  function keepFocus(container, itemClass, draw) {
    const a = document.activeElement;
    const path = a && container.contains(a) ? a.dataset.path : null;
    draw();
    if (path != null) [...container.querySelectorAll(itemClass)].find((b) => b.dataset.path === path)?.focus({ preventScroll: true });
  }

  function setStatus(text, error = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle('err', error);
    statusEl.title = error ? text : '';
  }

  function setMessage(text) {
    messageEl.textContent = text;
    showView('message');
  }

  function showView(kind) {
    view = kind;
    editorEl.hidden = kind !== 'editor';
    diffEl.hidden = kind !== 'diff';
    messageEl.hidden = kind !== 'message';
    idleEl.hidden = kind !== 'idle';
    // 숨겨진 채로 만들어진 편집기는 크기가 0 이었으니 보이게 된 뒤 한 번 맞춘다.
    if (kind === 'editor') editor?.layout();
    if (kind === 'diff') diff?.layout();
    updateToggle();
  }

  function updateToggle() {
    const can = !!open && typeof open.base === 'string' && open.kind === 'text';
    toggleBtn.disabled = !can;
    toggleBtn.setAttribute('aria-pressed', String(can && diffPref));
  }

  // ───────── 폴더 ─────────
  function options() {
    const seen = new Set();
    const out = [];
    for (const d of [...folders, ...picked, ...(current ? [current] : [])]) {
      const k = keyOf(d);
      if (!seen.has(k)) { seen.add(k); out.push(d); }
    }
    return out;
  }

  function renderFolders() {
    const list = options();
    folderSel.replaceChildren(...(list.length ? list.map((d) => node('option', { value: d, title: d }, d)) : [node('option', { value: '' }, '열린 작업 폴더 없음')]));
    folderSel.disabled = !list.length;
    if (current) folderSel.value = current;
  }

  function pickDefault(activeCwd) {
    const list = options();
    const first = (activeCwd && list.find((d) => keyOf(d) === keyOf(activeCwd))) || list[0];
    if (first) selectFolder(first);
    else renderMain();
  }

  function selectFolder(dir) {
    if (!dir) return;
    const same = options().find((d) => keyOf(d) === keyOf(dir));
    current = same || dir;
    gen++; folderGen++;
    treeInfo = null; tree = null; fileSet = new Set(); fileByLower = new Map(); treeError = ''; status = new Map(); dirty = new Set(); lastMissing = '';
    expanded.clear();
    open = null;
    release();
    renderFolders(); renderTouched(); renderTree(); renderFileHead(); renderMain();
    loadTree();
  }

  async function pick() {
    try {
      const dir = await api.codePick();
      if (!dir) return; // 취소
      if (!options().some((d) => keyOf(d) === keyOf(dir))) picked.push(dir);
      selectFolder(dir);
    } catch (e) { setStatus(`⚠ ${errText(e)}`, true); }
  }

  // ───────── 트리 ─────────
  async function loadTree(withPoll = true) {
    const root = current;
    if (!root) return;
    const fg = folderGen;
    const my = ++treeSeq;
    treeBusy = true;
    setStatus('불러오는 중…');
    try {
      const t = await api.codeTree(root);
      if (fg !== folderGen || my !== treeSeq) return;
      treeInfo = t;
      treeError = '';
      if (t.git) { tree = buildTree(t.files); fileSet = new Set(t.files); fileByLower = new Map(t.files.map((f) => [f.toLowerCase(), f])); } else { tree = null; fileSet = new Set(); fileByLower = new Map(); }
      renderTree();
      if (!open) renderMain();
      if (!t.git) { setStatus(GIT_TEXT[t.reason] || '지원하지 않는 폴더입니다', true); return; }
      if (withPoll) await pollCore();
      else setStatus(`${clock()} 갱신`);
    } catch (e) {
      if (fg === folderGen && my === treeSeq) {
        treeError = errText(e);
        setStatus(`⚠ ${treeError}`, true);
        if (!open && !treeInfo) renderMain(); // 「불러오는 중…」에 머물지 않고 오류를 안내한다
      }
    } finally {
      if (my === treeSeq) treeBusy = false;
    }
  }

  function renderTree() {
    keepFocus(treeEl, '.code-node', () => {
      treeEl.replaceChildren();
      noteEl.hidden = !treeInfo?.truncated;
      noteEl.textContent = treeInfo?.truncated ? '파일이 많아 20000개까지만 표시합니다' : '';
      if (tree) treeEl.append(...treeItems(tree.children, 0));
    });
  }

  // 펼친 폴더의 자식만 DOM 으로 만든다 (파일이 2만 개여도 가볍게).
  function treeItems(children, depth) {
    return children.map((n) => {
      const li = node('li');
      const code = status.get(n.path);
      if (n.dir) {
        const isOpen = expanded.has(n.path);
        const btn = node('button', { class: 'code-node code-folder-node', type: 'button', 'data-path': n.path, 'aria-expanded': String(isOpen), title: n.path, onclick: () => toggleFolder(n.path) },
          node('span', { class: 'code-caret', 'aria-hidden': 'true' }, isOpen ? '▾' : '▸'),
          node('span', { class: 'code-name' }, n.name),
          dirty.has(n.path) ? node('span', { class: 'code-dot', title: '변경된 파일이 있음', role: 'img', 'aria-label': '변경된 파일이 있음' }, '●') : null);
        btn.style.setProperty('--depth', depth);
        li.append(btn);
        if (isOpen) li.append(node('ul', { class: 'code-children' }, treeItems(n.children, depth + 1)));
      } else {
        const letter = code ? letterOf(code) : '';
        const btn = node('button', { class: 'code-node code-file', type: 'button', 'data-path': n.path, title: n.path, 'aria-current': open?.rel === n.path ? 'true' : null, onclick: () => openFile(n.path) },
          node('span', { class: 'code-caret', 'aria-hidden': 'true' }),
          node('span', { class: 'code-name' }, n.name),
          letter ? node('span', { class: 'code-badge', 'data-code': letter, title: LETTER_TITLE[letter] || '', 'aria-label': LETTER_TITLE[letter] || letter }, letter) : null);
        btn.style.setProperty('--depth', depth);
        li.append(btn);
      }
      return li;
    });
  }

  function toggleFolder(p) {
    if (expanded.has(p)) expanded.delete(p); else expanded.add(p);
    renderTree();
  }

  // 변경 상태를 받는다. 달라졌을 때만 트리를 다시 그린다.
  function applyStatus(changes) {
    const next = new Map(changes.map((c) => [c.path, c.code]));
    const same = next.size === status.size && [...next].every(([k, v]) => status.get(k) === v);
    status = next;
    if (same) return;
    dirty = new Set();
    for (const p of next.keys()) {
      for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) dirty.add(p.slice(0, i));
    }
    renderTree();
  }

  // ───────── 건드린 파일 ─────────
  function renderTouched() {
    const list = current ? touchedBy.get(keyOf(current))?.items() ?? [] : [];
    keepFocus(touchedEl, '.code-touch', () => {
      touchedEl.replaceChildren(...(list.length ? list.map((t) => node('li', {},
        node('button', { class: 'code-touch', type: 'button', 'data-path': t.rel, title: t.rel, 'aria-current': open?.rel === canon(t.rel) ? 'true' : null, onclick: () => openFile(t.rel) },
          node('span', { class: 'code-mark', 'data-kind': t.kind, role: 'img', 'aria-label': t.kind === 'edit' ? '수정' : '읽기' }, t.kind === 'edit' ? '●' : '○'),
          node('span', { class: 'code-name' }, baseOf(t.rel)),
          node('span', { class: 'code-meta' }, `${t.cli === 'codex' ? 'Codex' : 'Claude'} · ${hm(t.at)}`),
          node('span', { class: 'code-dir' }, dirOf(t.rel))))) : [node('li', { class: 'code-none' }, '아직 없습니다')]));
    });
  }

  // 현재 열린 파일 표시(aria-current)만 옮긴다.
  function markCurrent() {
    for (const b of host.querySelectorAll('.code-node.code-file, .code-touch')) {
      if (open && canon(b.dataset.path) === open.rel) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    }
  }

  // ───────── 파일 열기·보기 ─────────
  function renderFileHead() {
    pathEl.textContent = open ? open.rel : '';
    updateToggle();
  }

  // 파일을 안 고른 상태의 안내 글. 알릴 것이 없으면(고르기만 하면 되면) null — 로고를 보인다.
  function idleMessage() {
    if (!options().length) return '작업 폴더를 열거나 「폴더 열기…」로 폴더를 고르세요';
    if (treeInfo && !treeInfo.git) return GIT_TEXT[treeInfo.reason] || '지원하지 않는 폴더입니다';
    if (!treeInfo) return treeError ? `⚠ ${treeError}` : '불러오는 중…';
    return null;
  }

  function renderMain() {
    if (open) return;
    const text = idleMessage();
    if (text) setMessage(text); else showView('idle');
  }

  // 편집기에서 모델을 떼고 버린다. 비교 편집기에서 먼저 떼야 한다 (순서가 반대면 콘솔 오류).
  function release() {
    diff?.setModel(null);
    editor?.setModel(null);
    for (const m of models) m.dispose();
    models = [];
  }

  function ensureEditors() {
    if (editor) return;
    // unicodeHighlight: 모호한 글자(×·한글 따옴표 등) 강조는 끈다 — 읽기 전용 보기에 상자가 가득 차지 않게 (보이지 않는 글자 강조는 기본값 유지)
    const common = { readOnly: true, domReadOnly: true, theme: 'vs-dark', automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 13, fontFamily: EDITOR_FONT, unicodeHighlight: { ambiguousCharacters: false } };
    editor = monaco.editor.create(editorEl, common);
    diff = monaco.editor.createDiffEditor(diffEl, { ...common, renderSideBySide: false, originalEditable: false });
    // 새로 연 파일의 비교는 첫 변경 줄로 이동한다 (갱신 때는 보던 자리를 지킨다).
    diff.onDidUpdateDiff(() => { if (revealFirst) { revealFirst = false; diff.revealFirstDiff?.(); } });
  }

  function makeModel(scheme, rel, text) {
    const uri = monaco.Uri.from({ scheme, path: `/${rel}` });
    monaco.editor.getModel(uri)?.dispose();
    return monaco.editor.createModel(text, undefined, uri); // 언어는 URI 확장자로 모나코가 정한다
  }

  function scrollTop() {
    return view === 'diff' ? diff.getModifiedEditor().getScrollTop() : view === 'editor' ? editor.getScrollTop() : 0;
  }

  // 열린 파일의 텍스트(와 원본)를 모나코에 보여 준다. keep: 갱신이라 보던 스크롤 위치를 지킨다.
  function showText(keep) {
    ensureEditors();
    const top = keep ? scrollTop() : 0;
    release();
    const modified = makeModel('disk', open.rel, open.text);
    const useDiff = typeof open.base === 'string' && diffPref;
    if (useDiff) {
      const original = makeModel('git-head', open.rel, open.base);
      revealFirst = !keep;
      diff.setModel({ original, modified });
      models = [original, modified];
    } else {
      editor.setModel(modified);
      models = [modified];
    }
    showView(useDiff ? 'diff' : 'editor');
    if (top) (useDiff ? diff.getModifiedEditor() : editor).setScrollTop(top);
  }

  async function fetchBase(root, rel) {
    const b = await api.codeBase(root, rel);
    return typeof b?.text === 'string' ? b.text : null;
  }

  // o.text 가 있는 상태에서 원본(HEAD)을 받아 보여 준다. 상태 코드가 없으면(변경 없음·삭제) 원본은 필요 없다.
  async function present(root, o, g, keep) {
    o.base = o.code ? await fetchBase(root, o.rel) : null;
    if (g !== gen || open !== o) return;
    if (!monaco) {
      try { monaco = await loadMonaco(); } catch { if (g === gen && open === o) { release(); setMessage('코드 편집기를 불러오지 못했습니다'); } return; }
      if (g !== gen || open !== o) return;
    }
    showText(keep);
  }

  // 파일을 읽어 o 에 반영하고 보여 준다 (열 때·파일이 바뀌었을 때 공통).
  async function readOpen(root, o, g, keep) {
    const r = await api.codeRead(root, o.rel);
    if (g !== gen || open !== o) return;
    o.kind = r.kind;
    // 안내만 보이는 파일(바이너리·큰 파일·폴더)의 시각은 첫 갱신 때 기억한다 (그래야 매번 다시 읽지 않는다).
    o.mtimeMs = r.kind === 'text' ? r.mtimeMs : r.kind === 'missing' ? null : undefined;
    if (r.kind !== 'text') {
      o.text = null; o.base = null;
      release();
      setMessage(FILE_NOTE[r.kind]?.(r) ?? '표시할 수 없는 파일입니다');
      return;
    }
    o.text = r.text;
    await present(root, o, g, keep);
  }

  async function openFile(rel) {
    rel = canon(rel);
    if (!current || (open?.rel === rel && open.kind !== 'error')) return; // 열기에 실패한 파일은 다시 누르면 다시 연다
    const root = current;
    const g = ++gen;
    const o = { rel, kind: null, text: null, base: null, mtimeMs: undefined, code: status.get(rel) ?? null, loading: true };
    open = o;
    renderFileHead();
    markCurrent();
    revealInTree(rel);
    setMessage('불러오는 중…');
    try {
      await readOpen(root, o, g, false);
    } catch (e) {
      if (open === o) {
        o.kind = 'error'; o.text = null; o.base = null;
        release();
        setMessage(`⚠ ${errText(e)}`);
      }
    } finally {
      o.loading = false;
    }
  }

  // 목록(건드린 파일)에서 열면 트리에서도 그 파일이 보이게 부모 폴더를 펼친다.
  function revealInTree(rel) {
    let changed = false;
    for (let i = rel.indexOf('/'); i > 0; i = rel.indexOf('/', i + 1)) {
      const p = rel.slice(0, i);
      if (!expanded.has(p)) { expanded.add(p); changed = true; }
    }
    if (changed) renderTree();
  }

  function toggleDiff() {
    if (toggleBtn.disabled) return;
    diffPref = !diffPref;
    if (open && open.kind === 'text' && open.text != null && monaco) showText(true);
    else updateToggle();
  }

  // ───────── 갱신 ─────────
  // 상태·열린 파일 시각을 한 번 확인한다. 열린 파일이 바뀌었으면 다시 읽고, 상태 코드가 바뀌었으면 원본을 다시 받는다.
  async function pollCore() {
    const root = current;
    const fg = folderGen;
    const g = gen;
    const o = open;
    const r = await api.codePoll(root, o && o.kind !== 'error' ? o.rel : null); // 열기에 실패한 파일은 시각을 묻지 않는다
    if (fg !== folderGen) return;
    applyStatus(r.changes);
    setStatus(`${clock()} 갱신`);
    if (o && o.kind !== 'error' && g === gen && open === o && !o.loading) await syncOpen(root, o, g, r.mtimeMs);
    await reloadTreeIfNew(r.changes, fg);
  }

  async function syncOpen(root, o, g, mtimeMs) {
    if (o.mtimeMs === undefined) { o.mtimeMs = mtimeMs; return; }
    const code = status.get(o.rel) ?? null;
    const fileChanged = mtimeMs !== o.mtimeMs;
    const codeChanged = code !== o.code;
    if (!fileChanged && !codeChanged) return;
    o.code = code;
    o.loading = true;
    try {
      if (fileChanged) await readOpen(root, o, g, true);
      else if (o.kind === 'text') await present(root, o, g, true);
    } finally {
      o.loading = false;
    }
  }

  // 트리에 없는 변경 경로(새로 생긴 파일)가 있으면 트리를 다시 받는다. 목록이 잘렸으면 자동으로 다시 받지 않고, 같은 경로들로는 되풀이하지 않는다.
  async function reloadTreeIfNew(changes, fg) {
    if (!treeInfo?.git || treeInfo.truncated) return;
    const missing = changes.filter((c) => !c.code.includes('D') && !fileSet.has(c.path)).map((c) => c.path).sort().join('\0');
    if (!missing) { lastMissing = ''; return; }
    if (missing === lastMissing || fg !== folderGen) return;
    lastMissing = missing;
    await loadTree(false);
  }

  // 갱신기가 부르는 한 번의 확인. 트리를 아직 못 받았으면(오류 뒤 포함) 트리부터 받는다.
  async function tick() {
    if (!current || treeBusy) return;
    if (!treeInfo) { await loadTree(); return; }
    if (!treeInfo.git) return;
    await pollCore();
  }

  const refresher = createRefresher({ run: tick, onError: (e) => setStatus(`⚠ ${errText(e)}`, true) });

  // ───────── 바깥에 내놓는 것 ─────────
  renderFolders(); renderTouched(); renderMain();

  return {
    // 코드 화면이 보인다: 처음이면 폴더를 정하고(activeCwd 가 목록에 있으면 그 폴더) 10초 갱신을 켠다.
    show(activeCwd) {
      visible = true;
      if (!current) pickDefault(activeCwd);
      renderTouched(); // 숨겨진 동안 쌓인 것을 반영
      refresher.start();
    },
    hide() {
      visible = false;
      refresher.stop();
    },
    // 열린 탭(login 제외)의 작업 폴더 목록. 받은 폴더를 기존 목록에 더하기만 한다 (대소문자 무시 중복 제거, 순서 유지, 제거 없음).
    setFolders(list) {
      const seen = new Set(folders.map(keyOf));
      for (const d of Array.isArray(list) ? list : []) {
        if (typeof d !== 'string' || !d || seen.has(keyOf(d))) continue;
        seen.add(keyOf(d));
        folders.push(d);
      }
      renderFolders();
      if (!current && visible) pickDefault();
      else if (!current) renderMain();
    },
    // 에이전트 도구 호출 → 폴더별 「건드린 파일」. 현재 폴더에서 파일을 수정했으면 3초 안에 다시 확인하게 앞당긴다.
    onHookEvent(ev) {
      for (const dir of options()) {
        const item = touchedFrom(ev, dir);
        if (!item) continue;
        const k = keyOf(dir);
        let list = touchedBy.get(k);
        if (!list) touchedBy.set(k, list = new TouchedList());
        const changed = list.add(item);
        if (!current || k !== keyOf(current)) continue;
        if (changed && visible) renderTouched();
        if (item.kind === 'edit') refresher.bump();
      }
    },
  };
}
