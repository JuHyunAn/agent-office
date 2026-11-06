// 코드 화면: 폴더 선택 · 이번 작업에서 건드린 파일 · 전체 파일 트리 · 모나코 보기/변경 비교 · 10초 갱신.
// 편집기는 읽기 전용이고, 저장소를 바꾸는 일(스테이징·커밋)은 왼쪽 Git 패널(gitPanel.js)만 한다. 화면(DOM)은 시작 때 만들고, 모나코는 첫 파일을 열 때 불러온다.
import { touchedFrom, TouchedList, buildTree, createRefresher } from './model.js';
import { loadMonaco } from './monaco.js';
import { jumpLine, splitLines, notesForFile } from './analysis.js';
import { createNotesLayer } from './notes.js';
import { createAnalysisPanel } from './analysisPanel.js';
import { createGitPanel } from './gitPanel.js';
import { letterTitle } from './gitModel.js';
import { t, onLangChange } from '../../shared/i18n.js';
import { createTerminalPanel } from './terminalPanel.js';
import { setupAnalysisResizer, setupSideResizer } from '../layout.js';

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
const isStagedCode = (code) => !!code && code[0] !== ' ' && code[0] !== '?' && !CONFLICTS.has(code); // v1 상태 XY 의 X 가 스테이징 쪽
const letterOf = (code) => (CONFLICTS.has(code) ? '!' : code === '??' ? 'U' : code.trim()[0] || '');

// 문구는 사전 키로 두고 쓸 때 t() 로 읽는다 (언어를 바꾸면 새 문구가 나오게).
const GIT_KEYS = { 'not-repo': 'code.view.notRepo', 'no-git': 'code.repo.noGit', unsafe: 'code.view.gitUnsafe' };
const gitText = (reason) => t(GIT_KEYS[reason] || 'code.view.unsupported');
const FILE_NOTE = {
  binary: () => t('code.view.fileBinary'),
  large: (r) => t('code.view.fileLarge', { mb: (r.size / 1048576).toFixed(1) }),
  dir: () => t('code.view.fileDir'),
  missing: () => t('code.view.fileMissing'),
  unshown: () => t('code.view.fileUnshown'),
};
const EDITOR_FONT = '"Cascadia Mono", Consolas, "D2Coding", "Malgun Gothic", monospace';
const MODEL_TITLE_KEYS = { opus: 'code.view.modelOpus', fable: 'code.view.modelFable' };
const modelTitle = (value) => (MODEL_TITLE_KEYS[value] ? t(MODEL_TITLE_KEYS[value]) : '');
const RESULTS_MAX = 30; // 폴더당 보관하는 분석 결과 수 (넘으면 가장 오래된 것부터 지운다)
const mmss = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function createCodePanel({ api, host, newTerminal }) {
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
  let pollWanted = false; // 트리를 받은 뒤 상태 조회가 필요함 — 앞선 요청이 더 새로운 loadTree 에 밀려도 이어받는다 (⟳ 가 최대 10초 늦게 반영되지 않게)
  let treeInfo = null; // codeTree 결과 ({ git: true, files, truncated } | { git: false, reason })
  let tree = null;
  let fileSet = new Set();
  let fileByLower = new Map(); // 소문자 경로 → 트리 표기 (대소문자만 다른 경로를 트리 표기로 맞춘다)
  let treeError = ''; // 트리를 받지 못한 이유 (안내 영역에 보인다)
  let status = new Map(); // 경로 → 두 글자 코드
  let dirty = new Set(); // 변경이 든 폴더 경로
  let lastMissing = ''; // 마지막으로 트리를 다시 받게 한 「트리에 없는 변경 경로」 — 같은 이유로 되풀이하지 않게
  let lastOid = null; // 이 폴더에서 마지막으로 본 HEAD 커밋 (폴더를 바꾸면 비운다) — 바뀌면 트리의 파일 목록도 다시 받는다
  let tickSkipped = false; // 트리를 받는 중이라 건너뛴 갱신이 있다 — 트리를 다 받으면 바로 이어서 한다
  let open = null; // 열린 파일 { rel, kind('error' 면 열기 실패), text, base, mtimeMs, code, loading }
  let diffPref = true; // 「변경 비교」 토글 (변경이 있고 원본을 받았을 때만 효력)

  let monaco = null;
  let editor = null;
  let diff = null;
  let models = [];
  let view = 'message'; // 'editor' | 'diff' | 'message' | 'idle'
  let revealFirst = false;
  let notesLayer = null; // 줄 사이 주석 (모나코를 불러온 뒤 만든다)
  let shownDoc = null; // 편집기에 실제로 보이는 { rel, text } — 주석은 이 글을 기준으로 붙인다
  let notesHidden = 0; // 코드가 바뀌어 숨긴 주석 수 (패널에 알린다)

  // 코드 분석: 폴더별 상태 (메모리에만). 실행·결과는 시작한 폴더 항목에 넣고, 화면은 지금 폴더일 때만 갱신한다.
  const analysisByRoot = new Map(); // keyOf(폴더) → { active, results: Map(scopeKey → {...}), run, error, stopped, confirm, closed, notesOn, collapsed, jumpAt }
  let pendingJump = null; // { g, item } — 파일이 열린 뒤 옮길 자리 (g 가 지금 gen 과 같을 때만 적용)
  let diffReveal = null; // 비교 보기에서 삭제 줄 영역이 끼어든 뒤 다시 맞출 줄 (한 번 쓰고 비운다)
  // 하단 영역(.code-bottom): 분석 패널과 터미널이 탭으로 나눠 쓴다. bottomOpen 은 영역 자체(× 로 닫아도 셸은 유지), termOpened 는 터미널을 한 번이라도 열었는지.
  let bottomOpen = true;
  let termOpened = false;
  let bottomTab = 'analysis'; // 'analysis' | 'terminal' — 둘 다 있을 때 보는 쪽
  let reopenTimer = null; // 닫힌 패널의 「분석 중 m:ss」 단추 글자를 1초마다 갱신

  // ───────── DOM ─────────
  const folderSel = node('select', { class: 'code-folder', onchange: () => selectFolder(folderSel.value) });
  const pickBtn = node('button', { class: 'code-pick', type: 'button', onclick: pick });
  const refreshBtn = node('button', { class: 'code-refresh', type: 'button', onclick: () => { loadTree(); gitPanel.refreshGraph(); } }, '⟳');
  const termToggle = node('button', { class: 'code-term-toggle', type: 'button', 'aria-pressed': 'false', onclick: toggleTerminal });
  const statusEl = node('span', { class: 'code-status' });
  const touchedEl = node('ul', { class: 'code-touched' });
  const noteEl = node('p', { class: 'code-note', hidden: true });
  const treeEl = node('ul', { class: 'code-tree' });
  const pathEl = node('span', { class: 'code-path' });
  const toggleBtn = node('button', { class: 'code-diff-toggle', type: 'button', 'aria-pressed': 'false', disabled: true, onclick: toggleDiff });
  const editorEl = node('div', { class: 'code-editor', hidden: true });
  const diffEl = node('div', { class: 'code-diff', hidden: true });
  const messageEl = node('p', { class: 'code-message' });
  // 파일을 고르기 전 빈 화면: 안내 글 대신 회색 로고만 둔다.
  const idleEl = node('div', { class: 'code-idle', hidden: true }, node('span', { class: 'brand-mark', 'aria-hidden': 'true' }));

  // 분석 시작 단추 (깃 폴더일 때만 보인다)
  const analyzeChangesBtn = node('button', { class: 'code-act code-analyze-changes', type: 'button', onclick: () => startFromButton('changes') });
  const analyzeFileBtn = node('button', { class: 'code-act code-analyze-file', type: 'button', onclick: () => startFromButton('file') });
  const modelSel = node('select', { class: 'code-analyze-model', onchange: updateModelTitle },
    node('option', { value: 'sonnet' }), node('option', { value: 'opus' }), node('option', { value: 'fable' }));
  // 패널을 닫은 뒤 돌아오는 단추: 그 폴더에 분석 상태가 있을 때만 보인다 (실행 중이면 경과 시간)
  const reopenBtn = node('button', { class: 'code-act code-analysis-reopen', type: 'button', hidden: true, onclick: reopenAnalysis });
  const analyzeBox = node('div', { class: 'code-analyze', hidden: true }, analyzeChangesBtn, analyzeFileBtn, modelSel, reopenBtn);
  const analysis = createAnalysisPanel({
    onJump: (item) => { openFile(item.file, item); },
    onSearch: searchIn,
    onStop: stopAnalysis,
    onClose: () => { const s = curAnalysis(); if (s) { s.closed = true; if (termOpened) bottomTab = 'terminal'; renderAnalysis(); } },
    onToggleNotes: (on) => { const s = curAnalysis(); if (s) { s.notesOn = on; applyNotes(); renderAnalysis(); } },
    onRerun: rerunAnalysis,
    onConfirm: confirmAnalysis,
    onCancel: cancelConfirm,
    onScope: (key) => { const s = curAnalysis(); if (s && s.results.has(key)) { s.active = key; renderAnalysis(); } },
  });

  // Git 패널: 조회는 pollCore 가 넘겨 주고, 쓰기가 끝나면 곧바로 다시 조회하게 한다 (refresher 는 아래에서 만든다).
  const gitPanel = createGitPanel({
    api,
    onOpenFile: (rel, src) => openFile(rel, null, src),
    onChanged: () => refresher.bump(0),
    agentEdits: () => (current ? touchedBy.get(keyOf(current))?.items() ?? [] : []),
  });
  const terminal = createTerminalPanel({ api, newTerminal, onShellChange: () => { shellSel.value = terminal.getShell(); } });
  const analysisTabText = node('span', {});
  const analysisDot = node('span', { class: 'cb-dot', hidden: true }, '●');
  const analysisTabBtn = node('button', { class: 'cb-tab', type: 'button', role: 'tab', 'data-tab': 'analysis', onclick: () => { bottomTab = 'analysis'; syncBottom(); } }, analysisTabText, analysisDot);
  const termTabBtn = node('button', { class: 'cb-tab', type: 'button', role: 'tab', 'data-tab': 'terminal', onclick: openTerminal });
  const shellSel = node('select', { class: 'cb-shell', hidden: true, onchange: () => terminal.setShell(shellSel.value) },
    node('option', { value: 'powershell' }, 'PowerShell'), node('option', { value: 'bash' }, 'Git Bash'));
  const restartBtn = node('button', { class: 'cb-restart', type: 'button', hidden: true, onclick: () => terminal.restart() });
  const bottomCloseBtn = node('button', { class: 'cb-close', type: 'button', onclick: () => { bottomOpen = false; syncBottom(); } }, '×');
  const tabsEl = node('div', { class: 'cb-tabs', role: 'tablist' }, analysisTabBtn, termTabBtn, shellSel, restartBtn, bottomCloseBtn);
  // 위쪽 경계(분석 패널의 resizer)는 하단 영역의 첫 자식으로 옮긴다 — 어느 탭이든 같은 높이를 끈다.
  const bottomEl = node('div', { class: 'code-bottom', hidden: true }, analysis.resizer, tabsEl, analysis.el, terminal.el);
  const touchedHead = node('h3', { class: 'code-section' });
  const treeHead = node('h3', { class: 'code-section' });
  const sideTopEl = node('div', { class: 'code-side-top' }, touchedHead, touchedEl, treeHead, noteEl, treeEl);

  const viewEl = node('div', { class: 'code-view' }, editorEl, diffEl, messageEl, idleEl);
  const sideEl = node('div', { class: 'code-side' }, sideTopEl, gitPanel.el);
  const sideResizer = node('div', { class: 'code-side-resizer', role: 'separator', 'aria-orientation': 'vertical' });
  const bodyEl = node('div', { class: 'code-body' },
    sideEl, sideResizer,
    node('div', { class: 'code-main' },
      node('div', { class: 'code-file-head' }, pathEl, toggleBtn, analyzeBox),
      viewEl,
      bottomEl));
  host.replaceChildren(
    node('div', { class: 'code-head' }, folderSel, pickBtn, refreshBtn, termToggle, statusEl),
    bodyEl);

  // 한 번만 만드는 요소의 글자·툴팁·접근성 이름. 만들 때 한 번, 언어가 바뀔 때 다시 쓴다 (reopenBtn 의 「분석 중 m:ss」는 updateReopen 이 쓴다).
  function paintLabels() {
    folderSel.setAttribute('aria-label', t('code.view.folderLabel'));
    pickBtn.textContent = t('code.view.pick');
    refreshBtn.title = t('code.view.refreshTitle');
    refreshBtn.setAttribute('aria-label', t('code.view.refresh'));
    termToggle.textContent = t('code.view.terminal');
    termToggle.title = t('code.view.termToggleTitle');
    toggleBtn.textContent = t('code.view.diffToggle');
    analyzeChangesBtn.textContent = t('code.view.analyzeChanges');
    analyzeFileBtn.textContent = t('code.view.analyzeFile');
    modelSel.setAttribute('aria-label', t('code.view.modelLabel'));
    ['optSonnet', 'optOpus', 'optFable'].forEach((key, i) => {
      const opt = modelSel.options[i];
      opt.textContent = t(`code.view.${key}`);
      if (modelTitle(opt.value)) opt.title = modelTitle(opt.value); else opt.removeAttribute('title'); // 기본 모델은 툴팁이 없다
    });
    reopenBtn.title = t('code.view.reopenTitle');
    reopenBtn.textContent = t('code.view.analysisResult');
    analysisTabText.textContent = t('code.view.analysisTab');
    analysisDot.setAttribute('aria-label', t('code.view.newResult'));
    termTabBtn.textContent = t('code.view.terminal');
    shellSel.setAttribute('aria-label', t('code.view.shellLabel'));
    shellSel.title = t('code.view.shellTitle');
    restartBtn.textContent = t('code.view.restart');
    restartBtn.title = t('code.view.restartTitle');
    bottomCloseBtn.setAttribute('aria-label', t('code.view.closeBottom'));
    bottomCloseBtn.title = t('code.view.closeBottomTitle');
    tabsEl.setAttribute('aria-label', t('code.view.bottomArea'));
    touchedHead.textContent = t('code.view.touchedHead');
    treeHead.textContent = t('code.view.treeHead');
    sideResizer.setAttribute('aria-label', t('code.view.sideResizeAria'));
    sideResizer.title = t('code.view.sideResizeTitle');
  }
  paintLabels();

  // 최소 높이는 탭줄 + (분석 탭이면) 분석 머리줄 + 본문 48px
  const resizeAnalysis = setupAnalysisResizer(bottomEl, () => tabsEl.offsetHeight + (shownTab() === 'analysis' ? analysis.head.offsetHeight : 0), viewEl, analysis.resizer);
  const resizeGit = setupAnalysisResizer(gitPanel.el, gitPanel.head, sideTopEl, gitPanel.resizer, { key: 'ao.gitPanelHeight', cssVar: '--gp-height', bodyMin: 170 });
  setupSideResizer(bodyEl, sideEl, sideResizer);

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

  // text 는 글이거나 글을 돌려주는 함수 (함수면 언어가 바뀔 때 다시 불러 새 문구로 바꾼다)
  let statusSrc = null;
  function setStatus(text, error = false) {
    statusSrc = typeof text === 'function' ? text : null;
    const shown = statusSrc ? statusSrc() : text;
    statusEl.textContent = shown;
    statusEl.classList.toggle('err', error);
    statusEl.title = error ? shown : '';
  }

  // 「HH:MM:SS 갱신」 — 시각은 지금 것을 잡아 두고 문구만 언어를 따른다
  function setUpdated() {
    const time = clock();
    setStatus(() => t('code.view.updated', { time }));
  }

  function setMessage(text) {
    messageEl.textContent = text;
    showView('message');
    applyNotes();
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
    const can = !!open && typeof open.base === 'string' && open.kind === 'text' && !open.gone;
    toggleBtn.disabled = !can;
    toggleBtn.setAttribute('aria-pressed', String(can && diffPref));
    updateAnalyzeControls();
  }

  // ───────── 코드 분석 ─────────
  function updateModelTitle() {
    modelSel.title = modelTitle(modelSel.value);
  }

  const curAnalysis = () => (current ? analysisByRoot.get(keyOf(current)) : undefined);
  function analysisOf(root) {
    const k = keyOf(root);
    let s = analysisByRoot.get(k);
    if (!s) {
      s = { active: 'changes', results: new Map(), run: null, error: '', stopped: false, confirm: null, closed: false, notesOn: true, collapsed: new Set(), jumpAt: '' };
      analysisByRoot.set(k, s);
    }
    return s;
  }
  const scopeLabelOf = (scopeKey) => (scopeKey.startsWith('file:') ? baseOf(scopeKey.slice(5)) : t('code.view.scopeChanges'));

  // 분석을 시작할 수 있는 폴더 상태: 깃 폴더이고 트리를 받는 중이 아니며 이 폴더에서 분석 중이 아님.
  // 단추뿐 아니라 「다시 분석」·「그래도 분석」도 같은 조건이다.
  const canStart = () => !!current && !!treeInfo?.git && !treeBusy && !curAnalysis()?.run && typeof api.codeAnalyze === 'function';

  // 분석 시작·열린 파일·트리 상태에 따라 단추를 켜고 끈다.
  function updateAnalyzeControls() {
    const can = !!current && !!treeInfo?.git && typeof api.codeAnalyze === 'function';
    analyzeBox.hidden = !can;
    const common = canStart();
    analyzeChangesBtn.disabled = !common;
    analyzeFileBtn.disabled = !(common && open?.kind === 'text' && !open.loading && !open.gone);
    updateReopen(can);
  }

  // 패널이 닫혀 있고 그 폴더에 분석 상태(결과·실행 중·확인·오류)가 있으면 머리줄에 돌아오는 단추를 보인다.
  function updateReopen(can = true) {
    const s = curAnalysis();
    const has = !!s && (s.run || s.results.size || s.confirm || s.error || s.stopped);
    const show = can && !!s && (s.closed || !bottomOpen) && !!has; // 분석 패널을 닫았거나 하단 영역을 닫아 둔 경우
    reopenBtn.hidden = !show;
    if (show) reopenBtn.textContent = s.run ? t('code.view.analyzing', { time: mmss(Date.now() - s.run.startedAt) }) : t('code.view.analysisResult');
    const need = show && !!s.run && visible;
    if (!need) { if (reopenTimer) { clearInterval(reopenTimer); reopenTimer = null; } }
    else if (!reopenTimer) reopenTimer = setInterval(() => updateReopen(), 1000);
  }

  function reopenAnalysis() {
    const s = curAnalysis();
    if (!s) return;
    s.closed = false;
    bottomOpen = true; bottomTab = 'analysis'; // 하단을 닫아 두었어도 열고 분석 탭으로
    renderAnalysis();
  }

  // 변경 상태의 지문: 분석 뒤 코드가 바뀌었는지 비교한다. 파일 범위는 그 파일의 상태 코드만 본다.
  function statusSig(scopeKey) {
    if (scopeKey.startsWith('file:')) return status.get(scopeKey.slice(5)) ?? '';
    return [...status].map(([k, v]) => `${k}\t${v}`).sort().join('\n');
  }

  function isStale(scopeKey, res) {
    if (treeBusy || !treeInfo?.git) return false;
    if (res.statusAt !== statusSig(scopeKey)) return true;
    const sameFile = !scopeKey.startsWith('file:') || (!!open && open.rel.toLowerCase() === scopeKey.slice(5).toLowerCase());
    return sameFile && !!open && open.kind === 'text' && typeof open.mtimeMs === 'number' && open.mtimeMs > res.doneAt;
  }

  // 범위 선택용 목록: 결과가 있는 범위(와 지금 고른 범위). 둘 이상일 때만 패널이 고르기 UI 를 보인다.
  function scopeChoices(s) {
    const keys = [...s.results.keys()];
    if (!keys.includes(s.active)) keys.push(s.active);
    return keys.map((key) => ({ key, label: scopeLabelOf(key), title: key.startsWith('file:') ? key.slice(5) : t('code.view.scopeChanges') }));
  }

  function analysisView() {
    const s = curAnalysis();
    if (!s || s.closed) return null;
    const res = s.results.get(s.active) || null;
    const st = s.run ? 'running' : s.confirm ? 'confirm' : s.stopped ? 'stopped' : s.error ? 'error' : res ? 'done' : null;
    if (!st) return null;
    return {
      status: st, scopeLabel: scopeLabelOf(s.active), scopes: scopeChoices(s), active: s.active, canStart: canStart(), result: res ? res.result : null, cached: !!res?.cached, model: res?.model ?? '', ms: res?.ms ?? 0,
      costUsd: res?.costUsd ?? null, error: s.error, confirm: s.confirm ? { files: s.confirm.files, chars: s.confirm.chars } : null,
      startedAt: s.run ? s.run.startedAt : 0, notesOn: s.notesOn, hiddenNotes: notesHidden, stale: st === 'done' && !!res && isStale(s.active, res), jumpNote: s.jumpAt ? t('code.view.jumpEstimated', { where: s.jumpAt }) : '',
    };
  }

  // 지금 하단에 보이는 탭: 둘 다 있으면 bottomTab, 하나뿐이면 그것, 아무것도 없으면 null (영역 숨김)
  function shownTab() {
    if (!bottomOpen) return null;
    if (bottomTab === 'terminal' && termOpened) return 'terminal';
    if (!analysis.el.hidden) return 'analysis';
    return termOpened ? 'terminal' : null;
  }

  function syncBottom() {
    const shown = shownTab();
    const hasA = !analysis.el.hidden;
    const s = curAnalysis();
    if (shown === 'analysis' && s) s.unseen = false;
    bottomEl.hidden = shown === null;
    analysis.el.classList.toggle('cb-off', shown !== 'analysis');
    terminal.el.classList.toggle('cb-off', shown !== 'terminal');
    tabsEl.hidden = !termOpened; // 터미널을 한 번 열기 전에는 탭줄 없이 분석 패널만 (예전 모습 그대로)
    analysisTabBtn.hidden = !hasA;
    analysisDot.hidden = !(hasA && !!s?.unseen && shown !== 'analysis'); // 터미널을 보는 동안 끝난 분석
    for (const [b, id] of [[analysisTabBtn, 'analysis'], [termTabBtn, 'terminal']]) { b.classList.toggle('on', shown === id); b.setAttribute('aria-selected', String(shown === id)); }
    shellSel.hidden = restartBtn.hidden = shown !== 'terminal';
    shellSel.value = terminal.getShell();
    termToggle.setAttribute('aria-pressed', String(shown === 'terminal'));
    resizeAnalysis.apply(); // 영역이 방금 보였으면 저장된 높이를 그리기 전에 맞춘다
    if (visible && shown === 'terminal') terminal.activate(); else terminal.deactivate();
    updateAnalyzeControls(); // 하단을 열고 닫으면 「분석 결과」 단추 표시도 달라진다
  }

  function openTerminal() {
    bottomOpen = true; termOpened = true; bottomTab = 'terminal';
    syncBottom();
  }

  function toggleTerminal() {
    if (shownTab() === 'terminal') { bottomOpen = false; syncBottom(); } else openTerminal();
  }

  function renderAnalysis() {
    analysis.render(analysisView());
    syncBottom();
    updateAnalyzeControls();
  }

  function startFromButton(kind) {
    if (kind === 'file') {
      if (open?.kind === 'text' && !open.loading) startAnalysis(`file:${open.rel}`, open.rel, { force: false, confirm: false });
    } else startAnalysis('changes', null, { force: false, confirm: false });
  }

  // 분석을 시작한 폴더(root)를 잡아 두고, 끝나면 그 폴더 항목에 넣는다. 지금 폴더일 때만 화면을 바꾼다.
  async function startAnalysis(scopeKey, rel, { force, confirm, model = modelSel.value }) {
    const root = current;
    if (!root || !canStart()) return; // 트리를 받는 중이면 변경 상태가 정해지지 않았으니 시작하지 않는다
    const s = analysisOf(root);
    if (s.run) return;
    s.run = { scopeKey, startedAt: Date.now(), statusAtStart: statusSig(scopeKey) };
    s.active = scopeKey; s.error = ''; s.stopped = false; s.confirm = null; s.closed = false; s.jumpAt = '';
    bottomOpen = true; bottomTab = 'analysis'; // 사용자가 분석을 시작하면 분석 탭으로
    renderAnalysis();
    let r;
    try {
      r = await api.codeAnalyze({ root, scope: rel == null ? 'changes' : 'file', rel: rel ?? undefined, model, force, confirm });
    } catch (e) {
      r = { ok: false, error: errText(e) };
    }
    const run = s.run;
    s.run = null;
    s.closed = false; // 실행 중 닫았어도 끝나면 다시 보인다
    s.unseen = true; // 터미널 탭을 보는 중이면 가리지 않고 탭의 ● 만 켠다 (분석 탭을 보면 꺼진다)
    const here = !!current && keyOf(current) === keyOf(root);
    if (here && !bottomOpen) { bottomOpen = true; bottomTab = 'analysis'; } // 하단을 닫아 둔 채 끝났으면 결과가 보이게
    if (r && r.ok) {
      // 성공 때만 결과를 바꾼다 (실패·중단은 문구만 — 이전 결과 유지)
      // 시작 시점의 상태·시각을 적는다: 분석 중에 바뀐 코드는 끝난 뒤 「분석 후 코드가 바뀜」으로 드러난다
      s.results.set(scopeKey, {
        result: r.result, cached: !!r.cached, model: r.model, ms: r.ms, costUsd: r.costUsd,
        statusAt: run.statusAtStart, doneAt: run.startedAt,
      });
      trimResults(s, here);
      s.error = ''; s.stopped = false; s.confirm = null;
    } else if (r && r.needConfirm) {
      s.confirm = { scopeKey, rel, model, force, files: r.needConfirm.files, chars: r.needConfirm.chars };
    } else if (r && r.stopped) {
      s.stopped = true; s.error = r.error || t('code.analysis.stopped');
    } else {
      s.error = (r && r.error) || t('code.view.analyzeFailed');
    }
    if (here) {
      if (r && r.ok) applyNotes();
      renderAnalysis();
    }
  }

  // 폴더당 결과 수 상한: 넘으면 가장 오래된 것부터 지우되 지금 고른 범위와 열린 파일의 결과는 남긴다.
  // (지운 결과의 접힘 키는 문자열뿐이라 그대로 둔다)
  function trimResults(s, here) {
    const keep = new Set([s.active]);
    if (here && open) keep.add(`file:${open.rel}`);
    while (s.results.size > RESULTS_MAX) {
      let oldest = null;
      for (const [k, v] of s.results) if (!keep.has(k) && (oldest === null || v.doneAt < s.results.get(oldest).doneAt)) oldest = k;
      if (oldest === null) return;
      s.results.delete(oldest);
    }
  }

  // 「다시 분석」은 캐시를 쓰지 않되 큰 변경이면 먼저 확인받는다 (확인 화면의 「그래도 분석」이 force 를 이어받는다)
  function rerunAnalysis() {
    const s = curAnalysis();
    if (!s || s.run || !canStart()) return;
    startAnalysis(s.active, s.active.startsWith('file:') ? s.active.slice(5) : null, { force: true, confirm: false });
  }

  function confirmAnalysis() {
    const s = curAnalysis();
    const c = s?.confirm;
    if (!c || s.run || !canStart()) return;
    startAnalysis(c.scopeKey, c.rel, { force: c.force, confirm: true, model: c.model });
  }

  // 확인 화면의 「취소」: 이전 결과(없으면 패널 없음)로 돌아간다
  function cancelConfirm() {
    const s = curAnalysis();
    if (!s?.confirm) return;
    s.confirm = null;
    renderAnalysis();
  }

  function stopAnalysis() {
    const root = current;
    if (!root || !curAnalysis()?.run) return;
    Promise.resolve(api.codeAnalyzeStop(root)).catch(() => {}); // 끝나면 codeAnalyze 응답이 「중단했습니다」로 온다
  }

  // 검색어 → 결과. 폴더가 바뀐 뒤 늦게 온 응답은 null 로 버린다.
  async function searchIn(term) {
    const root = current;
    const fg = folderGen;
    if (!root) return null;
    try {
      const r = await api.codeSearch(root, term);
      return fg === folderGen ? r : null;
    } catch (e) {
      if (fg !== folderGen) return null;
      throw new Error(errText(e));
    }
  }

  // 주석 표시: 지금 편집기에 보이는 글자 파일의 결과(파일 분석 결과가 있으면 그것, 없으면 이번 변경 결과)를 줄 사이에 붙이거나, 붙일 것이 없으면 지운다.
  // 패널 다시 그리기는 이 함수를 부르지 않으므로 서로 되풀이하지 않는다.
  // keepScroll: 분석 완료·토글·폴더 복귀처럼 보던 자리에서 주석만 바뀌는 호출은 첫 보이는 줄과 그 오프셋을 지킨다
  // (showText 는 자기 스크롤 복원이 있어 false).
  // rebuild: 언어가 바뀌어 같은 주석도 글자(위치 추정 표시)가 달라졌으니 영역을 다시 만든다 (스크롤 기준은 지우기 전에 잡는다).
  function applyNotes(keepScroll = true, rebuild = false) {
    const s = curAnalysis();
    const ed = view === 'diff' ? diff?.getModifiedEditor() : view === 'editor' ? editor : null;
    const res = s && s.notesOn && shownDoc ? s.results.get(`file:${shownDoc.rel}`) || s.results.get('changes') : null;
    const at = keepScroll && ed ? scrollAnchor(ed) : null;
    if (rebuild) notesLayer?.clear();
    let hidden = 0;
    if (notesLayer && ed && res) {
      const r = notesForFile(res.result, shownDoc.rel, shownDoc.text);
      hidden = r.hidden;
      notesLayer.show(ed, r.shown, s.collapsed); // false 면 편집기가 숨겨져 폭이 없는 것 — 있는 주석은 그대로, 보이게 되면 스스로 만든다
    } else notesLayer?.clear();
    if (at) restoreAnchor(ed, at);
    if (hidden !== notesHidden) { notesHidden = hidden; renderAnalysis(); }
  }

  // 첫 보이는 줄과 그 줄 위쪽 끝에서의 오프셋 (영역이 늘고 줄어도 같은 줄이 같은 자리에 오게)
  function scrollAnchor(ed) {
    try {
      const r = ed.getVisibleRanges()[0];
      if (!r) return null;
      const line = r.startLineNumber;
      return { line, offset: ed.getScrollTop() - ed.getTopForLineNumber(line) };
    } catch { return null; }
  }

  function restoreAnchor(ed, at) {
    try {
      const want = ed.getTopForLineNumber(at.line) + at.offset;
      if (Math.abs(ed.getScrollTop() - want) >= 1) ed.setScrollTop(Math.max(0, want));
    } catch { /* 편집기가 정리되는 중 */ }
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
    folderSel.replaceChildren(...(list.length ? list.map((d) => node('option', { value: d, title: d }, d)) : [node('option', { value: '' }, t('code.view.noFolderOption'))]));
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
    treeInfo = null; tree = null; fileSet = new Set(); fileByLower = new Map(); treeError = ''; status = new Map(); dirty = new Set(); lastMissing = ''; lastOid = null;
    expanded.clear();
    open = null;
    pendingJump = null;
    release();
    applyNotes();
    gitPanel.setRoot(current);
    terminal.setRoot(current);
    renderFolders(); renderTouched(); renderTree(); renderFileHead(); renderMain(); renderAnalysis();
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
    pollWanted = pollWanted || withPoll;
    treeBusy = true;
    updateAnalyzeControls();
    setStatus(() => t('code.view.loading'));
    try {
      const res = await api.codeTree(root);
      if (fg !== folderGen || my !== treeSeq) return;
      const poll = pollWanted;
      pollWanted = false;
      treeInfo = res;
      treeError = '';
      if (res.git) { tree = buildTree(res.files); fileSet = new Set(res.files); fileByLower = new Map(res.files.map((f) => [f.toLowerCase(), f])); } else { tree = null; fileSet = new Set(); fileByLower = new Map(); }
      renderTree();
      if (!open) renderMain();
      if (!res.git) { gitPanel.setUnavailable(gitText(res.reason)); setStatus(() => gitText(res.reason), true); return; }
      if (poll) await pollCore();
      else setUpdated();
    } catch (e) {
      if (fg === folderGen && my === treeSeq) {
        treeError = errText(e);
        if (!treeInfo?.git) gitPanel.setUnavailable(`⚠ ${treeError}`);
        setStatus(`⚠ ${treeError}`, true);
        if (!open && !treeInfo) renderMain(); // 「불러오는 중…」에 머물지 않고 오류를 안내한다
      }
    } finally {
      if (my === treeSeq) {
        treeBusy = false;
        renderAnalysis(); // 변경 상태를 다 받았으니 「분석 후 바뀜」을 다시 판단
        if (tickSkipped) { tickSkipped = false; refresher.bump(0); } // 트리를 받는 동안 건너뛴 갱신을 바로 이어서
      }
    }
  }

  function renderTree() {
    keepFocus(treeEl, '.code-node', () => {
      treeEl.replaceChildren();
      noteEl.hidden = !treeInfo?.truncated;
      noteEl.textContent = treeInfo?.truncated ? t('code.view.treeTruncated') : '';
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
          dirty.has(n.path) ? node('span', { class: 'code-dot', title: t('code.view.dirty'), role: 'img', 'aria-label': t('code.view.dirty') }, '●') : null);
        btn.style.setProperty('--depth', depth);
        li.append(btn);
        if (isOpen) li.append(node('ul', { class: 'code-children' }, treeItems(n.children, depth + 1)));
      } else {
        const letter = code ? letterOf(code) : '';
        const btn = node('button', { class: 'code-node code-file', type: 'button', 'data-path': n.path, title: n.path, 'aria-current': open?.rel === n.path ? 'true' : null, onclick: () => openFile(n.path) },
          node('span', { class: 'code-caret', 'aria-hidden': 'true' }),
          node('span', { class: 'code-name' }, n.name),
          letter ? node('span', { class: 'code-badge', 'data-code': letter, title: letterTitle(letter), 'aria-label': letterTitle(letter) || letter }, letter) : null);
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
      touchedEl.replaceChildren(...(list.length ? list.map((it) => node('li', {},
        node('button', { class: 'code-touch', type: 'button', 'data-path': it.rel, title: it.rel, 'aria-current': open?.rel === canon(it.rel) ? 'true' : null, onclick: () => openFile(it.rel) },
          node('span', { class: 'code-mark', 'data-kind': it.kind, role: 'img', 'aria-label': t(it.kind === 'edit' ? 'code.view.touchEdit' : 'code.view.touchRead') }, it.kind === 'edit' ? '●' : '○'),
          node('span', { class: 'code-name' }, baseOf(it.rel)),
          node('span', { class: 'code-meta' }, `${it.cli === 'codex' ? 'Codex' : 'Claude'} · ${hm(it.at)}`),
          node('span', { class: 'code-dir' }, dirOf(it.rel))))) : [node('li', { class: 'code-none' }, t('code.view.touchNone'))]));
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
    pathEl.textContent = open ? (open.staged ? t('code.view.stagedSuffix', { rel: open.rel }) : open.rel) : '';
    updateToggle();
  }

  // 파일을 안 고른 상태의 안내 글. 알릴 것이 없으면(고르기만 하면 되면) null — 로고를 보인다.
  function idleMessage() {
    if (!options().length) return t('code.view.noFolder');
    if (treeInfo && !treeInfo.git) return gitText(treeInfo.reason);
    if (!treeInfo) return treeError ? `⚠ ${treeError}` : t('code.view.loading');
    return null;
  }

  function renderMain() {
    if (open) return;
    const text = idleMessage();
    if (text) setMessage(text); else showView('idle');
  }

  // 편집기에서 모델을 떼고 버린다. 비교 편집기에서 먼저 떼야 한다 (순서가 반대면 콘솔 오류).
  function release() {
    notesLayer?.clear();
    shownDoc = null;
    diffReveal = null;
    diff?.setModel(null);
    editor?.setModel(null);
    for (const m of models) m.dispose();
    models = [];
  }

  function ensureEditors() {
    if (editor) return;
    // unicodeHighlight: 모호한 글자(×·한글 따옴표 등) 강조는 끈다 — 읽기 전용 보기에 상자가 가득 차지 않게 (보이지 않는 글자 강조는 기본값 유지)
    const common = { readOnly: true, domReadOnly: true, theme: 'vs-dark', automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 13, fontFamily: EDITOR_FONT, unicodeHighlight: { ambiguousCharacters: false } };
    // 모나코는 모델이 하나도 없으면 워커를 끈다 — 파일을 바꿀 때마다 워커를 새로 띄우지 않게 빈 모델 하나를 계속 둔다 (실측: 40번 전환 시 워커 40개 → 1개).
    monaco.editor.createModel('', 'plaintext', monaco.Uri.from({ scheme: 'keep-worker', path: '/empty' }));
    editor = monaco.editor.create(editorEl, common);
    notesLayer = createNotesLayer(monaco);
    diff = monaco.editor.createDiffEditor(diffEl, { ...common, renderSideBySide: false, originalEditable: false });
    // 새로 연 파일의 비교는 첫 변경 줄로 이동한다 (갱신 때는 보던 자리를 지킨다).
    // 점프해 온 비교 보기는 삭제 줄 영역이 계산 뒤에 끼어들어 줄이 밀리므로 그 줄을 다시 맞춘다.
    diff.onDidUpdateDiff(() => {
      if (diffReveal) { const line = diffReveal; diffReveal = null; revealAt(diff.getModifiedEditor(), line); return; }
      if (revealFirst) { revealFirst = false; diff.revealFirstDiff?.(); }
    });
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
    const useDiff = typeof open.base === 'string' && (diffPref || open.gone);
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
    shownDoc = { rel: open.rel, text: open.text };
    applyNotes(false);
    if (top) (useDiff ? diff.getModifiedEditor() : editor).setScrollTop(top);
    if (pendingJump && pendingJump.g === gen) {
      const item = pendingJump.item;
      pendingJump = null;
      const line = applyJump(item);
      revealFirst = false;
      if (useDiff) diffReveal = line;
    }
  }

  function revealAt(ed, line) {
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: 1 });
  }

  // 열린 글자 파일의 item.line 쪽으로 옮기고 옮긴 줄을 돌려준다. anchor 가 있으면(읽는 순서) 줄이 밀렸어도 찾아가고, 검색 결과는 줄 번호 그대로다.
  function applyJump(item) {
    const total = splitLines(open.text).length;
    let at;
    if (typeof item.anchor === 'string') at = jumpLine(item, open.text);
    else at = { line: Math.min(Math.max(Number.isInteger(item.line) ? item.line : 1, 1), total), moved: false };
    revealAt(view === 'diff' ? diff.getModifiedEditor() : editor, at.line);
    const s = curAnalysis();
    if (s) { s.jumpAt = at.moved ? `${open.rel}:${at.line}` : ''; renderAnalysis(); }
    return at.line;
  }

  // 이미 열린 파일로의 점프: 보이는 중이면 바로, 읽는 중이면 다 읽은 뒤(showText)에. 안내만 보이는 파일은 무시한다.
  function jumpOpen(item) {
    if (open.kind === 'text' && !open.loading && (view === 'editor' || view === 'diff')) {
      const line = applyJump(item);
      revealFirst = false; // 아직 계산 전인 비교 보기가 첫 변경 줄로 되돌리지 않게
      if (view === 'diff') diffReveal = line; // 삭제 줄 영역이 계산 뒤에 끼어 줄이 밀리면 다시 맞춘다
    } else if (open.loading) pendingJump = { g: gen, item };
  }

  async function fetchBase(root, rel) {
    const b = await api.codeBase(root, rel);
    return typeof b?.text === 'string' ? b.text : null;
  }

  // o.text 가 있는 상태에서 원본(HEAD)을 받아 보여 준다. 상태 코드도 없고 스테이징된 내용 보기도 아니면(변경 없음) 원본은 필요 없다.
  // 이름이 바뀐 스테이징 항목은 옛 경로(baseRel)의 HEAD 와 비교한다.
  async function present(root, o, g, keep) {
    o.base = o.code || o.staged ? await fetchBase(root, o.baseRel) : null;
    if (g !== gen || open !== o) return;
    if (!monaco) {
      try { monaco = await loadMonaco(); } catch (e) {
        console.error('[code] 모나코 로드 실패', e);
        if (g === gen && open === o) { release(); setMessage(t('code.view.editorFailed')); }
        return;
      }
      if (g !== gen || open !== o) return;
    }
    showText(keep);
  }

  // 파일을 읽어 o 에 반영하고 보여 준다 (열 때·파일이 바뀌었을 때 공통).
  async function readOpen(root, o, g, keep) {
    let r = await (o.staged ? api.codeIndex(root, o.rel) : api.codeRead(root, o.rel));
    if (g !== gen || open !== o) return;
    // 삭제된 파일: HEAD 내용을 빈 글과 비교해 무엇이 지워지는지 보인다 (HEAD 에 없으면 안내만).
    o.gone = false;
    if (r.kind === 'missing' && (o.code || o.staged)) {
      const b = await fetchBase(root, o.baseRel);
      if (g !== gen || open !== o) return;
      if (typeof b === 'string') { r = { kind: 'text', text: '', mtimeMs: null }; o.gone = true; }
    }
    o.kind = r.kind;
    o.size = r.size; // large 안내의 크기 (언어가 바뀌면 안내를 다시 만든다)
    // 안내만 보이는 파일(바이너리·큰 파일·폴더)의 시각은 첫 갱신 때 기억한다 (그래야 매번 다시 읽지 않는다).
    o.mtimeMs = r.kind === 'text' ? r.mtimeMs : r.kind === 'missing' ? null : undefined;
    if (r.kind !== 'text') {
      o.text = null; o.base = null;
      pendingJump = null;
      release();
      setMessage(FILE_NOTE[r.kind]?.(r) ?? t('code.view.fileUnsupported'));
      return;
    }
    o.text = r.text;
    await present(root, o, g, keep);
  }

  // jump: 분석 결과에서 온 이동 { file, line, anchor? } — 파일이 열린 뒤 그 줄로 옮긴다.
  async function openFile(rel, jump = null, src = null) {
    rel = canon(rel);
    if (!current) return;
    const staged = !!src?.staged;
    if (open?.rel === rel && open.kind !== 'error' && !!open.staged === staged) { if (jump) jumpOpen(jump); return; } // 열기에 실패한 파일은 다시 누르면 다시 연다
    const root = current;
    const g = ++gen;
    pendingJump = jump ? { g, item: jump } : null;
    const o = { rel, kind: null, text: null, base: null, mtimeMs: undefined, code: status.get(rel) ?? null, loading: true, staged, baseRel: src?.orig ? canon(src.orig) : rel, gone: false };
    open = o;
    renderFileHead();
    markCurrent();
    revealInTree(rel);
    setMessage(t('code.view.loading'));
    try {
      await readOpen(root, o, g, false);
    } catch (e) {
      if (open === o) {
        o.kind = 'error'; o.text = null; o.base = null;
        pendingJump = null;
        release();
        setMessage(`⚠ ${errText(e)}`);
      }
    } finally {
      o.loading = false;
      updateAnalyzeControls();
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
    // 깃 상태(Git 패널)도 같은 주기로 함께 묻는다. 거부돼도 패널 안내로만 보이고 콘솔 오류로 새지 않는다.
    const [polled, gs] = await Promise.all([
      Promise.resolve().then(() => api.codePoll(root, o && o.kind !== 'error' ? o.rel : null)).then((r) => ({ r }), (error) => ({ error })), // 열기에 실패한 파일은 시각을 묻지 않는다
      Promise.resolve().then(() => api.codeGitState(root)).catch((e) => ({ ok: false, code: 'ipc', error: errText(e) })),
    ]);
    if (fg !== folderGen) return;
    // 변경 목록을 못 받아도 패널에는 상태 조회 결과를 알린다 (폴더가 지워졌으면 비우고, 시간 초과면 안내만). 실패는 상태 줄로 넘긴다.
    if (polled.error) { gitPanel.setState(gs); throw polled.error; }
    const { r } = polled;
    applyStatus(r.changes);
    gitPanel.setState(gs);
    // HEAD 가 달라졌다(Pull·터미널의 git pull·checkout 등): 새로 들어온 파일·지워진 파일이 트리에 반영되게 목록을 다시 받는다 (첫 값은 비교 대상이 아니다).
    const headMoved = !!gs && gs.ok !== false && !!gs.oid && lastOid !== null && lastOid !== gs.oid;
    if (gs && gs.ok !== false && gs.oid) lastOid = gs.oid;
    setUpdated();
    if (o && o.kind !== 'error' && g === gen && open === o && !o.loading) await syncOpen(root, o, g, r.mtimeMs, headMoved);
    if (fg === folderGen) renderAnalysis(); // 변경 상태·열린 파일 시각이 달라졌으면 「분석 후 코드가 바뀜」을 반영
    await reloadTreeIfNew(r.changes, fg);
    if (headMoved && fg === folderGen) await loadTree(false);
  }

  async function syncOpen(root, o, g, mtimeMs, headMoved = false) { // headMoved: HEAD 가 움직여 비교 원본이 달라졌을 수 있다 (상태 코드·내용이 같아도 다시 받는다)
    // 스테이징된 내용 보기: 더 이상 스테이징되어 있지 않으면 작업 폴더 보기로 돌아가고, 인덱스가 바뀌었을 때만 다시 그린다.
    if (o.staged) {
      const code = status.get(o.rel) ?? null;
      o.loading = true;
      try {
        if (!isStagedCode(code)) { o.staged = false; o.baseRel = o.rel; o.code = code; renderFileHead(); await readOpen(root, o, g, true); return; }
        const r = await api.codeIndex(root, o.rel);
        if (g !== gen || open !== o) return;
        const same = !headMoved && code === o.code && (r.kind === 'text' ? !o.gone && r.text === o.text : r.kind === 'missing' ? o.gone || o.kind === 'missing' : r.kind === o.kind);
        if (same) return;
        o.code = code;
        await readOpen(root, o, g, true);
      } finally {
        o.loading = false;
        updateAnalyzeControls();
      }
      return;
    }
    if (o.mtimeMs === undefined) { o.mtimeMs = mtimeMs; return; }
    const code = status.get(o.rel) ?? null;
    const fileChanged = mtimeMs !== o.mtimeMs;
    const codeChanged = code !== o.code;
    if (!fileChanged && !codeChanged && !headMoved) return;
    o.code = code;
    o.loading = true;
    try {
      if (fileChanged || o.gone) await readOpen(root, o, g, true); // 삭제 보기는 상태가 바뀌면 다시 판단한다 (커밋되면 안내로)
      else if (o.kind === 'text') await present(root, o, g, true);
    } finally {
      o.loading = false;
      updateAnalyzeControls();
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
    if (!current) return;
    if (treeBusy) { tickSkipped = true; return; }
    if (!treeInfo) { await loadTree(); return; }
    // 깃 저장소가 아니던 폴더: 터미널에서 git init 했을 수 있으니 상태만 묻고, 저장소가 됐으면 트리부터 다시 받는다.
    if (!treeInfo.git) {
      const root = current;
      const fg = folderGen;
      const gs = await Promise.resolve().then(() => api.codeGitState(root)).catch(() => null);
      if (fg === folderGen && !treeInfo?.git && gs && gs.ok !== false) await loadTree(); // 기다리는 사이 ⟳ 가 이미 받았으면 다시 받지 않는다
      return;
    }
    await pollCore();
  }

  const refresher = createRefresher({ run: tick, onError: (e) => setStatus(`⚠ ${errText(e)}`, true) });

  // ───────── 바깥에 내놓는 것 ─────────
  renderFolders(); renderTouched(); renderMain(); renderAnalysis();

  // 언어가 바뀜(창을 새로고침하지 않는다): 한 번 만든 글자를 다시 쓰고, 오래 보이는 목록·상태·안내를 새 언어로 다시 그린다.
  // 이미 쌓인 활동 기록·분석 오류·Git 안내 같은 잠깐 보이는 글은 다음 갱신 때 바뀐다. 코드 화면이 감춰져 있어도 같은 DOM 이라 그대로 그린다.
  function relabel() {
    paintLabels();
    terminal.relabel();
    gitPanel.relabel();
    if (statusSrc) setStatus(statusSrc, statusEl.classList.contains('err'));
    renderFolders(); renderTouched(); renderTree(); renderFileHead(); renderMain();
    if (open && !open.loading && FILE_NOTE[open.kind]) setMessage(FILE_NOTE[open.kind](open)); // 바이너리·큰 파일 같은 안내가 남아 있는 파일
    applyNotes(true, true);
    renderAnalysis(); // 범위 이름·「위치 추정」 줄은 분석 상태에서 다시 만든다
    analysis.relabel(); // 본문·상태 줄은 지문이 같아 건너뛰므로 비우고 다시 그린다
    updateModelTitle();
    syncBottom(); updateAnalyzeControls(); updateReopen();
  }
  onLangChange(relabel);

  return {
    // 코드 화면이 보인다: 처음이면 폴더를 정하고(activeCwd 가 목록에 있으면 그 폴더) 10초 갱신을 켠다.
    show(activeCwd) {
      visible = true;
      if (!current) pickDefault(activeCwd);
      renderTouched(); // 숨겨진 동안 쌓인 것을 반영
      applyNotes(); // 숨겨진 동안 끝난 분석 반영 (Task 5)
      renderAnalysis();
      resizeGit.apply(); gitPanel.show(); // 저장된 높이를 그리기 전에 맞춘다
      analysis.refresh(); // 멈췄던 경과 시간을 지금 시각으로
      refresher.start();
    },
    hide() {
      visible = false;
      gitPanel.hide();
      terminal.deactivate();
      if (reopenTimer) { clearInterval(reopenTimer); reopenTimer = null; }
      analysis.stopTimer();
      refresher.stop();
    },
    // 터미널 ID 의 출력·종료면 터미널이 처리하고 true (app.js 가 탭으로 찾지 않게).
    onPtyData: (tabId, data) => terminal.onPtyData(tabId, data),
    onPtyExit: (tabId, exitCode) => terminal.onPtyExit(tabId, exitCode),
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
