// 코드 화면 왼쪽 아래 Git 패널: 메시지 입력 · 커밋 단추 · Fetch/Pull/Push · 스테이징된 변경 / 변경 / 충돌 목록 · 읽기 전용 그래프. 화면(DOM)과 쓰기 요청만 다룬다.
// 상태 조회는 하지 않는다 — panel.js 의 10초 갱신(pollCore)이 setState 로 넘겨 준다. 쓰기가 끝나면 onChanged 로 바로 다시 조회하게 한다.
// 예외는 그래프(읽기 전용 커밋 목록)뿐이다: 펼쳐져 있고 커밋 위치·원격이 바뀌었을 때만 code:git:log 를 직접 부른다.
// 고정 노드는 만들 때 한 번만 만들고 textarea 는 다시 만들지 않는다. 결과·경로·메시지는 모두 textContent 로만 표시한다.
import { toLocal, expectedPaths, stageablePaths, capList, recentEditSet, secretPaths, secretWarning, gitFingerprint, aheadBehindText, reasonText, refChips, logTime, logKey, loginHint, canSyncOnly } from './gitModel.js';

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

// 폴더 비교 키: panel.js 와 같은 규칙
const keyOf = (dir) => String(dir).replace(/[\\/]+$/, '').toLowerCase();
// IPC 거부 메시지의 「Error invoking remote method '…': Error: 」 머리말은 떼고 보여 준다.
const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
const baseOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
const dirOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const mmss = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const MESSAGE_MAX = 20000;
const GIT_LIST_MAX = 500; // 묶음마다 그리는 최대 줄 수 (넘으면 「외 N개」)
// 메시지 생성 단추 아이콘: 별은 직접 그린 네 갈래 별 두 개, 중지는 협업 입력창과 같은 네모 (Heroicons, MIT)
const SVG_NS = 'http://www.w3.org/2000/svg';
const SPARKLE_D = 'M8.5 3 10 8l5 1.5L10 11l-1.5 5L7 11 2 9.5 7 8ZM15.5 2l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7Z';
const STOP_D = 'M5.25 3A2.25 2.25 0 0 0 3 5.25v9.5A2.25 2.25 0 0 0 5.25 17h9.5A2.25 2.25 0 0 0 17 14.75v-9.5A2.25 2.25 0 0 0 14.75 3h-9.5Z';
const OK_NOTE_MS = 4000; // 성공 안내를 보여 두는 시간
const OP_TEXT = { commit: '커밋 중', push: '푸시 중', sync: '동기화 중', stage: '스테이징 중', fetch: '가져오는 중', pull: '받아 병합 중', pushOnly: '푸시 중', syncOnly: '동기화 중' };
const GRAPH_OPS = new Set(['commit', 'push', 'sync', 'fetch', 'pull', 'pushOnly', 'syncOnly']); // 성공하면 그래프를 다시 받는 쓰기
const OK_TEXT = { fetch: '가져왔습니다', pull: '가져와 병합했습니다', pushOnly: '푸시했습니다', syncOnly: '가져와 푸시했습니다' }; // Fetch·Pull·Push 와 커밋 없는 Sync 의 성공 안내
const LETTER_TITLE = { M: '수정됨', A: '추가됨', D: '삭제됨', R: '이름이 바뀜', C: '복사됨', U: '추적하지 않는 새 파일', '!': '병합 충돌' };
const letterOf = (code) => (code === 'T' ? 'M' : code); // 파일 종류만 바뀐 것도 수정으로 보인다
const AGENT_TITLE = '에이전트가 방금 수정 (앱에서 연 AI 기준)';
const OUTSIDE_TITLE = '열린 폴더 밖 파일 — 스테이징만 할 수 있습니다';
const SUBMODULE_TITLE = '서브모듈 안에서 커밋해 주세요.';
const NESTED_TITLE = '안에 별도 git 저장소가 있는 폴더입니다.\n서브모듈로 추가하거나 .gitignore 에 넣어 주세요.';
const NO_REMOTE_TITLE = 'origin 원격이 없습니다';
const NOTHING_TO_PUSH_TITLE = '올릴 커밋이 없습니다';
const SYNC_ONLY_TITLE = '커밋할 것이 없어 Pull 후 Push 합니다';
const GRAPH_KEY = 'ao.gitGraphOpen'; // 그래프 펼침 저장 (기본 접힘)
const REF_TITLE = { local: '브랜치', remote: '원격 브랜치', tag: '태그', head: '분리된 HEAD' };
const STALE_TEXT = '목록이 바뀌었습니다.\n다시 눌러 주세요.';
const COMMIT_TEXT = { commit: '커밋', push: '커밋·푸시', sync: '커밋·동기화' };

// 요청은 던지지 않는 값으로 바꾼다 (IPC 거부가 콘솔 오류로 새지 않게)
async function call(fn) {
  try {
    const r = await fn();
    return r && typeof r === 'object' ? r : { ok: false, code: 'ipc', error: '응답이 올바르지 않습니다' };
  } catch (e) {
    return { ok: false, code: 'ipc', error: errText(e) };
  }
}

export function createGitPanel({ api, onOpenFile, onChanged, agentEdits }) {
  let current = null; // 지금 보는 폴더
  let gs = null; // 마지막으로 받은 상태 (ok:true 인 것만). 폴더를 옮기거나 쓸 수 없으면 null
  let marks = new Set(); // 에이전트가 방금 수정한 저장소 기준 소문자 경로
  let unavailable = ''; // 패널을 쓸 수 없는 이유 (비어 있으면 쓸 수 있음)
  let flash = null; // { text, err } — 마지막 동작의 결과 안내
  let flashTimer = null;
  let confirmThen; // 확인 줄이 열려 있으면 { then, stageAll } — 확인을 누를 때 이 값과 지금 상태가 다르면 실행하지 않는다
  let dismissed = ''; // 닫기(×)로 숨긴 안내 글
  let refocus = null; // + − 를 누른 자리: 항목이 다른 목록으로 가면 다음 줄(또는 전체 단추)로 초점을 잇는다 (초점이 그 단추나 body 일 때만)
  let fp = ''; // 마지막으로 그린 목록의 지문
  let listFp = ''; // 에이전트 표시를 뺀 목록의 지문
  let staleNote = ''; // 조회 시간 초과 안내 (마지막 목록은 그대로 둔다)
  let visible = false;
  let busyTimer = null;
  let graphOpen = false; // 그래프 펼침 (펼치면 localStorage 에 저장)
  try { graphOpen = localStorage.getItem(GRAPH_KEY) === '1'; } catch { /* 저장소를 못 읽으면 접힌 채로 */ }
  let graph = null; // { commits } | { error } | null(아직 못 받음). 새 키를 받는 동안에는 이전 것을 그대로 둔다
  let graphKey = ''; // graph 를 받아 온 때의 logKey
  let graphPending = ''; // 받는 중인 logKey
  let logSeq = 0; // 늦게 온 응답을 버리기 위한 순번
  const drafts = new Map(); // keyOf(폴더) → { text, gen: { before, discard } | null, last: { text, err } | null, pending: 문자열 | null }
  const ops = new Map(); // keyOf(폴더) → { kind, startedAt }

  const draftOf = (k) => {
    let d = drafts.get(k);
    if (!d) { d = { text: '', gen: null, last: null, pending: null }; drafts.set(k, d); }
    return d;
  };
  const curKey = () => (current ? keyOf(current) : null);
  const curOp = () => (current ? ops.get(keyOf(current)) : undefined);

  // ───────── DOM ─────────
  const resizer = node('div', { class: 'gp-resizer', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Git 패널 높이 조절', title: '끌어서 높이 조절 · 두 번 클릭하면 기본 높이' });
  const branchEl = node('span', { class: 'gp-branch' });
  const abEl = node('span', { class: 'gp-ab' });
  const busyEl = node('span', { class: 'gp-busy', hidden: true });
  const fetchBtn = node('button', { class: 'gp-rbtn gp-fetch', type: 'button', 'aria-label': 'Fetch', title: 'Fetch', disabled: true, onclick: () => remoteOp('fetch', fetchBtn, (r) => api.codeGitFetch(r)) }, '⇣');
  const pullBtn = node('button', { class: 'gp-rbtn gp-pull', type: 'button', 'aria-label': 'Pull', title: 'Pull', disabled: true, onclick: () => remoteOp('pull', pullBtn, (r) => api.codeGitPull(r)) }, '⇓');
  const pushOnlyBtn = node('button', { class: 'gp-rbtn gp-push', type: 'button', 'aria-label': 'Push', title: 'Push', disabled: true, onclick: () => remoteOp('pushOnly', pushOnlyBtn, (r) => api.codeGitPush(r)) }, '⇑');
  const headEl = node('div', { class: 'gp-head' }, node('span', { class: 'gp-title' }, 'Git'), branchEl, abEl, busyEl, node('span', { class: 'gp-remote' }, fetchBtn, pullBtn, pushOnlyBtn));
  const loginEl = node('div', { class: 'gp-login', role: 'status', hidden: true });
  const noteTextEl = node('span', { class: 'gp-note-text' });
  const noteClose = node('button', { class: 'gp-note-close', type: 'button', 'aria-label': '안내 닫기', title: '안내 닫기', onclick: dismissNote }, '×');
  const noteEl = node('div', { class: 'gp-note', role: 'status', hidden: true }, noteTextEl, noteClose);
  const applyBtn = node('button', { class: 'gp-apply', type: 'button', onclick: applyPending }, '적용');
  const discardBtn = node('button', { class: 'gp-discard', type: 'button', onclick: discardPending }, '버림');
  const pendingEl = node('div', { class: 'gp-pending', hidden: true }, node('span', { class: 'gp-pending-text' }, '생성한 메시지가 있습니다'), applyBtn, discardBtn);
  const msgEl = node('textarea', { class: 'gp-msg', 'aria-label': '커밋 메시지', placeholder: '커밋 메시지', rows: 2, maxlength: MESSAGE_MAX });
  const genIcon = document.createElementNS(SVG_NS, 'svg');
  genIcon.setAttribute('viewBox', '0 0 20 20'); genIcon.setAttribute('aria-hidden', 'true');
  const genPath = document.createElementNS(SVG_NS, 'path');
  genPath.setAttribute('fill', 'currentColor'); genPath.setAttribute('d', SPARKLE_D);
  genIcon.append(genPath);
  const genBtn = node('button', { class: 'gp-gen', type: 'button', onclick: generate }, genIcon);
  const commitBtn = node('button', { class: 'gp-commit', type: 'button', onclick: () => startCommit(null) }, 'Commit');
  const pushBtn = node('button', { class: 'gp-commit-push', type: 'button', onclick: () => startCommit('push') }, 'Commit & Push');
  const syncBtn = node('button', { class: 'gp-commit-sync', type: 'button', onclick: () => startCommit('sync') }, 'Commit & Sync');
  const confirmTextEl = node('span', { class: 'gp-confirm-text' });
  const confirmOk = node('button', { class: 'gp-confirm-ok', type: 'button', onclick: confirmCommit }, '확인');
  const confirmNo = node('button', { class: 'gp-confirm-no', type: 'button', onclick: closeConfirm }, '취소');
  const confirmEl = node('div', { class: 'gp-confirm', hidden: true }, confirmTextEl, confirmOk, confirmNo);

  const stagedText = node('span', { class: 'gp-h-text' });
  const stagedAll = node('button', { class: 'gp-all', type: 'button', 'data-act': 'unstage', 'aria-label': '모두 스테이징 해제', title: '모두 스테이징 해제', onclick: () => unstageAll() }, '−');
  const changesText = node('span', { class: 'gp-h-text' });
  const changesAll = node('button', { class: 'gp-all', type: 'button', 'data-act': 'stage', 'aria-label': '모두 스테이징', title: '모두 스테이징', onclick: () => stageAllChanges() }, '+');
  const conflictsText = node('span', { class: 'gp-h-text' });
  const stagedUl = node('ul', { class: 'gp-staged' });
  const changesUl = node('ul', { class: 'gp-changes' });
  const conflictsUl = node('ul', { class: 'gp-conflicts', hidden: true });
  const conflictsHead = node('h4', { class: 'gp-h', hidden: true }, conflictsText);
  // 그래프: 목록 맨 아래 (같이 스크롤). 머리글 클래스는 gp-h 가 아니다 — 위 묶음 머리글 집계에 섞이지 않게
  const graphToggle = node('button', { class: 'gp-graph-toggle', type: 'button', 'aria-expanded': 'false', onclick: toggleGraph });
  const graphHead = node('h4', { class: 'gp-graph-head' }, graphToggle);
  const graphUl = node('ul', { class: 'gp-graph', hidden: true });
  const listsEl = node('div', { class: 'gp-lists' },
    node('h4', { class: 'gp-h' }, stagedText, stagedAll), stagedUl,
    node('h4', { class: 'gp-h' }, changesText, changesAll), changesUl,
    conflictsHead, conflictsUl, graphHead, graphUl);

  // 머리줄 아래 고정 영역: 패널이 낮으면 이 안에서 스크롤해서 단추에 닿는다 (목록은 최소 높이를 지킨다)
  const fixedEl = node('div', { class: 'gp-fixed' },
    noteEl,
    node('div', { class: 'gp-msg-wrap' }, msgEl, genBtn),
    node('div', { class: 'gp-actions' }, commitBtn, pushBtn, syncBtn),
    confirmEl, pendingEl);
  const el = node('section', { class: 'git-panel', 'aria-label': 'Git' }, resizer, headEl, loginEl, fixedEl, listsEl);

  msgEl.addEventListener('input', () => {
    if (current) draftOf(keyOf(current)).text = msgEl.value;
    autosize();
    updateControls();
  });
  msgEl.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 한글 조합 중 Enter 는 글자 확정이다
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      if (!commitBtn.disabled) startCommit(null);
    }
  });

  // 입력 높이는 글에 맞추되 최대 8줄 (넘으면 스크롤). 숨겨져 있으면 잴 수 없으니 건드리지 않는다.
  function autosize() {
    msgEl.style.height = 'auto';
    if (msgEl.scrollHeight > 0) msgEl.style.height = `${msgEl.scrollHeight + msgEl.offsetHeight - msgEl.clientHeight}px`; // 테두리까지 (box-sizing: border-box)
    else msgEl.style.removeProperty('height');
  }

  // ───────── 안내 ─────────
  function setFlash(text, err = false, keepMs = 0) {
    clearTimeout(flashTimer);
    flashTimer = null;
    const f = text ? { text, err } : null;
    flash = f;
    if (f) dismissed = '';
    if (f && keepMs) flashTimer = setTimeout(() => { if (flash === f) { flash = null; renderNote(); } }, keepMs);
    renderNote();
    if (f && !noteEl.hidden) noteEl.scrollIntoView({ block: 'nearest' }); // 패널이 낮아 고정 영역을 아래로 내려 두었어도 새 안내는 보이게
  }

  function renderNote() {
    let text = '';
    let err = false;
    if (flash) { text = flash.text; err = flash.err; }
    else if (unavailable) text = unavailable;
    else if (staleNote) text = staleNote;
    else if (gs && !gs.canWrite) text = reasonText(gs) || '';
    const shown = text && text !== dismissed ? text : '';
    noteTextEl.textContent = shown;
    noteEl.classList.toggle('err', err && !!shown);
    noteEl.hidden = !shown;
    renderPending();
  }

  // 「생성한 메시지가 있습니다」는 오류·안내와 따로 항상 함께 보인다
  function renderPending() {
    const d = current ? draftOf(keyOf(current)) : null;
    const was = !pendingEl.hidden;
    pendingEl.hidden = !d?.pending;
    pendingEl.title = d?.pending || '';
    if (!pendingEl.hidden && !was) pendingEl.scrollIntoView({ block: 'nearest' }); // 새로 뜬 적용 줄도 보이는 자리로
  }

  function dismissNote() {
    dismissed = noteTextEl.textContent;
    renderNote();
  }

  function applyPending() {
    const d = current ? draftOf(keyOf(current)) : null;
    if (!d?.pending) return;
    d.text = d.pending;
    d.pending = null;
    msgEl.value = d.text;
    autosize();
    renderPending();
    updateControls();
  }

  function discardPending() {
    const d = current ? draftOf(keyOf(current)) : null;
    if (!d) return;
    d.pending = null;
    renderPending();
  }

  // ───────── 단추 상태 ─────────
  function hasStageable() {
    return !!gs && stageablePaths(gs.changes).length > 0;
  }

  function canCommit(then) {
    if (!gs || unavailable || !gs.canWrite || curOp()) return false;
    if (!msgEl.value.trim()) return false;
    if (!gs.staged.length && !hasStageable()) return false;
    return !then || !!gs.hasRemote;
  }

  // 커밋할 것이 없고 주고받을 커밋이 있어 Commit & Sync 가 동기화만 하는 상태 (거절된 푸시 뒤처럼)
  const syncOnlyNow = () => !unavailable && !curOp() && typeof api.codeGitSync === 'function' && canSyncOnly(gs, msgEl.value);

  // 머리줄 단추의 title: 꺼진 이유를 알린다 (켜져 있으면 이름)
  function remoteTitle(name, needWrite, isPush) {
    if (!gs || unavailable) return name;
    if (!gs.hasRemote) return NO_REMOTE_TITLE;
    if (needWrite && !gs.canWrite) return reasonText(gs) || name;
    if (isPush && gs.upstream && gs.ahead === 0) return NOTHING_TO_PUSH_TITLE;
    return name;
  }

  function updateControls() {
    const writable = !!gs && !unavailable && gs.canWrite && !curOp();
    for (const b of listsEl.querySelectorAll('.gp-act, .gp-all')) b.disabled = !writable;
    commitBtn.disabled = !canCommit(null);
    pushBtn.disabled = !canCommit('push');
    syncBtn.disabled = !canCommit('sync') && !syncOnlyNow();
    const noRemote = !!gs && !gs.hasRemote;
    pushBtn.title = noRemote ? NO_REMOTE_TITLE : 'Commit & Push';
    syncBtn.title = noRemote ? NO_REMOTE_TITLE : syncOnlyNow() ? SYNC_ONLY_TITLE : 'Commit & Sync';
    commitBtn.title = 'Commit';
    const remote = !!gs && !unavailable && !!gs.hasRemote && !curOp();
    const write = remote && gs.canWrite;
    fetchBtn.disabled = !remote || typeof api.codeGitFetch !== 'function';
    pullBtn.disabled = !write || typeof api.codeGitPull !== 'function';
    pushOnlyBtn.disabled = !write || (!!gs.upstream && gs.ahead === 0) || typeof api.codeGitPush !== 'function';
    fetchBtn.title = remoteTitle('Fetch', false, false);
    pullBtn.title = remoteTitle('Pull', true, false);
    pushOnlyBtn.title = remoteTitle('Push', true, true);
    const d = current ? draftOf(keyOf(current)) : null;
    const generating = !!d?.gen;
    const genLabel = generating ? '생성 중지' : '커밋 메시지 생성';
    genPath.setAttribute('d', generating ? STOP_D : SPARKLE_D);
    genBtn.title = genLabel;
    genBtn.setAttribute('aria-label', genLabel);
    genBtn.disabled = !generating && !(!!gs && !unavailable && (gs.staged.length > 0 || hasStageable()) && typeof api.codeGitMessage === 'function');
    syncBusy();
  }

  // ───────── 경과 표시 ─────────
  function drawBusy() {
    const op = curOp();
    busyEl.hidden = !op;
    busyEl.textContent = op ? `${OP_TEXT[op.kind] || '작업 중'}… ${mmss(Date.now() - op.startedAt)}` : '';
    const hint = op ? loginHint(op.kind, Date.now() - op.startedAt) : '';
    loginEl.hidden = !hint;
    if (loginEl.textContent !== hint) loginEl.textContent = hint;
  }

  function syncBusy() {
    drawBusy();
    const need = visible && !!curOp();
    if (!need) { if (busyTimer) { clearInterval(busyTimer); busyTimer = null; } } else if (!busyTimer) busyTimer = setInterval(drawBusy, 1000);
  }

  // ───────── 목록 ─────────
  function fileItem(section, item, { act } = {}) {
    const local = toLocal(item.path, gs.prefix);
    const letter = letterOf(section === 'conflicts' ? '!' : item.code);
    const agent = marks.has(item.path.toLowerCase()) || (!!item.orig && marks.has(item.orig.toLowerCase()));
    const title = item.orig ? `${item.orig} → ${item.path}` : item.path;
    const fileBtn = node('button', {
      class: 'gp-file', type: 'button', 'data-path': item.path, 'data-key': `${section}|${item.path}|file`,
      title: local == null ? `${title}\n${OUTSIDE_TITLE}` : title, disabled: local == null,
      onclick: () => { if (local != null) onOpenFile(local, { staged: section === 'staged', orig: item.orig ? toLocal(item.orig, gs.prefix) : null }); },
    },
    node('span', { class: 'code-badge', 'data-code': letter, title: LETTER_TITLE[letter] || '', 'aria-label': LETTER_TITLE[letter] || letter }, letter),
    node('span', { class: 'gp-name' }, baseOf(item.path)),
    agent ? node('span', { class: 'gp-agent', title: AGENT_TITLE, role: 'img', 'aria-label': AGENT_TITLE }, '●') : null,
    dirOf(item.path) ? node('span', { class: 'gp-dir' }, dirOf(item.path)) : null);
    const li = node('li', {}, fileBtn);
    if (act === 'stage' && item.stageable === false) {
      fileBtn.title = `${fileBtn.title}\n${item.nested ? NESTED_TITLE : SUBMODULE_TITLE}`;
    } else if (act) {
      const stage = act === 'stage';
      li.append(node('button', {
        class: 'gp-act', type: 'button', 'data-path': item.path, 'data-act': act, 'data-key': `${section}|${item.path}|act`,
        'aria-label': `${stage ? '스테이징' : '스테이징 해제'}: ${item.path}`, title: stage ? '스테이징' : '스테이징 해제',
        onclick: (e) => (stage ? stageOnly(item, e.currentTarget) : unstageOnly(item, e.currentTarget)),
      }, stage ? '+' : '−'));
    }
    return li;
  }

  const none = () => node('li', { class: 'gp-none' }, '없습니다');

  // 초점이 눌렀던 단추 자신이거나 아무 데도 없을 때(body)만 초점을 옮겨도 된다
  const focusFree = (btn) => { const a = document.activeElement; return !a || a === document.body || a === btn; };

  // 묶음 하나를 그린다: 길면 GIT_LIST_MAX 줄까지만, 나머지는 「외 N개」 (+ 와 커밋은 전체 목록 기준이다)
  function fillList(ul, section, list, act) {
    const { shown, more } = capList(list, GIT_LIST_MAX);
    const items = shown.map((it) => fileItem(section, it, { act }));
    if (more) items.push(node('li', { class: 'gp-more' }, `외 ${more}개`));
    ul.replaceChildren(...(items.length ? items : section === 'conflicts' ? [] : [none()]));
  }

  function renderLists() {
    const a = document.activeElement;
    const focusKey = a && listsEl.contains(a) ? a.dataset.key : null;
    const top = listsEl.scrollTop;
    const staged = gs ? gs.staged : [];
    const changes = gs ? gs.changes : [];
    const conflicts = gs ? gs.conflicts : [];
    stagedText.textContent = `스테이징된 변경 (${staged.length})`;
    changesText.textContent = `변경 (${changes.length})`;
    conflictsText.textContent = `충돌 (${conflicts.length})`;
    conflictsHead.hidden = !conflicts.length;
    conflictsUl.hidden = !conflicts.length;
    fillList(stagedUl, 'staged', staged, 'unstage');
    fillList(changesUl, 'changes', changes, 'stage');
    fillList(conflictsUl, 'conflicts', conflicts);
    listsEl.scrollTop = top;
    const same = focusKey ? [...listsEl.querySelectorAll('[data-key]')].find((b) => b.dataset.key === focusKey && !b.disabled) : null;
    if (same) { same.focus({ preventScroll: true }); refocus = null; }
    else if (refocus && !refocus.all && !curOp()) {
      // 누른 + − 의 항목이 다른 목록으로 갔다: 같은 목록의 다음 줄(없으면 전체 단추)로 초점을 잇는다.
      // 그 사이 사용자가 다른 곳(입력란 등)으로 초점을 옮겼으면 건드리지 않는다.
      if (focusFree(refocus.btn)) {
        const staging = refocus.section === 'staged';
        const acts = [...(staging ? stagedUl : changesUl).querySelectorAll('.gp-act')];
        const target = acts[Math.min(refocus.index, acts.length - 1)] || (staging ? stagedAll : changesAll);
        if (!target.disabled) target.focus({ preventScroll: true });
      }
      refocus = null;
    }
  }

  function renderHead() {
    branchEl.textContent = gs ? gs.branch || (gs.detached ? '분리된 HEAD' : '') : '';
    branchEl.title = branchEl.textContent;
    const ab = gs ? aheadBehindText(gs) : '';
    abEl.textContent = ab;
    abEl.title = ab ? `원격보다 앞섬 ${gs.ahead || 0} · 뒤처짐 ${gs.behind || 0}` : '';
  }

  // ───────── 쓰기 ─────────
  function beginOp(root, kind) {
    closeConfirm();
    ops.set(keyOf(root), { kind, startedAt: Date.now() });
    setFlash('');
    updateControls();
  }

  // 쓰기가 끝났을 때의 공통 마무리. 폴더를 옮긴 뒤라면 결과 안내는 그 폴더 draft 에 보관한다.
  // sent: 보낸 커밋 메시지 — 커밋된 뒤 입력란이 아직 그 글일 때만 비운다 (커밋이 도는 동안 쓴 글은 남긴다)
  function finishOp(root, kind, r, sent = '') {
    const k = keyOf(root);
    ops.delete(k);
    const d = draftOf(k);
    const here = k === curKey();
    const oid = String(r.oid || '').slice(0, 7);
    let text = '';
    let err = false;
    if (r.committed) {
      const same = (t) => String(t).trim() === String(sent).trim();
      d.pending = null;
      if (d.gen) { d.gen.discard = true; call(() => api.codeGitMessageStop(root)); } // 만들던 메시지는 방금 커밋한 변경 것이라 버린다
      if (here) { if (same(msgEl.value)) { msgEl.value = ''; d.text = ''; autosize(); } } else if (same(d.text)) d.text = '';
    }
    if (r.ok === false) { text = r.committed ? `커밋됨 ${oid}\n⚠ ${r.error}` : `⚠ ${r.error}`; err = true; } else if (kind === 'commit' || kind === 'push' || kind === 'sync') text = `${r.pushed ? '커밋·푸시했습니다.' : '커밋했습니다.'} ${oid}`;
    else if (kind === 'syncOnly') {
      text = r.pushed === false ? OK_TEXT.pull : OK_TEXT.syncOnly; // 받을 것만 있었으면 푸시하지 않았다
      if (r.left > 0) text += `\n변경 ${r.left}개는 커밋하지 않고 그대로 뒀습니다.`;
    } else if (kind === 'pull' && r.upToDate) text = '이미 최신 상태입니다';
    else if (OK_TEXT[kind]) text = OK_TEXT[kind];
    if (here) setFlash(text, err, err ? 0 : OK_NOTE_MS);
    else d.last = text ? { text, err } : null;
    // 커밋·Fetch·Pull·Push 로 커밋 그래프가 바뀌었을 수 있다 (다른 브랜치만 가져와 logKey 가 그대로여도 다시 받는다)
    if (r.committed || (r.ok !== false && GRAPH_OPS.has(kind))) { graphKey = ''; graphPending = ''; }
    updateControls();
    renderNote();
    // 실패했거나 전체 단추였으면 눌렀던 단추로 초점을 돌려준다 (작업 중 꺼졌다 켜지며 초점이 빠진다)
    if (refocus && (r.ok === false || refocus.all)) {
      if (here && refocus.btn.isConnected && !refocus.btn.disabled && focusFree(refocus.btn)) refocus.btn.focus({ preventScroll: true });
      refocus = null;
    }
    onChanged();
  }

  async function runWrite(root, kind, fn, sent) {
    beginOp(root, kind);
    finishOp(root, kind, await call(fn), sent);
  }

  // 머리줄 Fetch·Pull·Push 와 Commit & Sync 의 동기화(커밋할 것이 없을 때): 꺼진 단추는 눌러도 아무 일도 없다 (켜는 조건은 updateControls). 끝나면 눌렀던 단추로 초점을 돌려준다.
  function remoteOp(kind, btn, run) {
    if (!current || curOp() || btn.disabled) return;
    const root = current;
    refocus = { btn, all: true };
    runWrite(root, kind, () => run(root));
  }

  function markRefocus(btn) {
    const ul = btn.closest('ul');
    refocus = ul ? { btn, section: ul === stagedUl ? 'staged' : 'changes', index: [...ul.children].indexOf(btn.closest('li')) } : { btn, all: true };
  }

  function stageOnly(item, btn) {
    if (!current || curOp() || !gs?.canWrite) return;
    const root = current;
    const paths = stageablePaths([item]);
    if (btn) markRefocus(btn);
    if (paths.length) runWrite(root, 'stage', () => api.codeGitStage(root, paths));
  }

  function unstageOnly(item, btn) {
    if (!current || curOp() || !gs?.canWrite) return;
    const root = current;
    if (btn) markRefocus(btn);
    runWrite(root, 'stage', () => api.codeGitUnstage(root, expectedPaths([item])));
  }

  function stageAllChanges() {
    if (!current || curOp() || !gs?.canWrite) return;
    const root = current;
    const paths = stageablePaths(gs.changes);
    refocus = { btn: changesAll, all: true };
    if (paths.length) runWrite(root, 'stage', () => api.codeGitStage(root, paths));
  }

  function unstageAll() {
    if (!current || curOp() || !gs?.canWrite) return;
    const root = current;
    const paths = expectedPaths(gs.staged);
    refocus = { btn: stagedAll, all: true };
    if (paths.length) runWrite(root, 'stage', () => api.codeGitUnstage(root, paths));
  }

  // 커밋: 스테이징이 없어 변경을 모두 스테이징하게 되거나 에이전트가 방금 수정한 파일이 들어가면 먼저 확인받는다.
  // 확인 줄이 열려 있는 동안 다시 누르면(단추·Ctrl+Enter) 동작을 바꾸지 않고 확인 버튼으로 초점만 옮긴다.
  function startCommit(then) {
    if (confirmThen) { confirmOk.focus(); return; }
    if (then === 'sync' && !canCommit('sync') && syncOnlyNow()) { const hasMessage = !!msgEl.value.trim(); remoteOp('syncOnly', syncBtn, (r) => api.codeGitSync(r, hasMessage)); return; }
    if (!canCommit(then)) return;
    const stageAll = !gs.staged.length;
    const targets = stageAll ? gs.changes.filter((c) => c.stageable !== false) : gs.staged;
    marks = recentEditSet(agentEdits(), gs.prefix, Date.now());
    const agent = targets.some((t) => marks.has(t.path.toLowerCase()) || (!!t.orig && marks.has(t.orig.toLowerCase())));
    const secret = secretPaths(targets);
    if (!stageAll && !agent && !secret.length) { runCommit(then); return; }
    const act = COMMIT_TEXT[then || 'commit'];
    const parts = [];
    if (secret.length) parts.push(secretWarning(secret));
    if (agent) parts.push('에이전트가 방금 파일을 수정했습니다');
    parts.push(stageAll ? `변경 ${targets.length}개를 모두 스테이징하고 ${act}할까요?` : `${act}할까요?`);
    confirmThen = { then, stageAll };
    confirmTextEl.textContent = parts.join('\n');
    confirmEl.hidden = false;
    confirmOk.focus();
  }

  function closeConfirm() {
    confirmThen = undefined;
    confirmEl.hidden = true;
  }

  // 확인을 눌렀을 때 지금 상태가 확인 줄을 띄운 때와 다르면(스테이징이 생기거나 없어짐) 실행하지 않는다.
  function confirmCommit() {
    const c = confirmThen;
    closeConfirm();
    if (!c) return;
    if (!msgEl.value.trim()) { setFlash('커밋 메시지를 입력해 주세요.', true); return; }
    if (!gs || !gs.staged.length !== c.stageAll) { setFlash(STALE_TEXT); return; }
    runCommit(c.then);
  }

  // 요청은 누른 순간 화면의 상태로 만든다 (보낸 expected 와 메인이 지금 보는 스테이징이 다르면 메인이 거부한다)
  function runCommit(then) {
    if (!canCommit(then)) return;
    const root = current;
    const message = msgEl.value;
    const req = {
      root, message, expected: expectedPaths(gs.staged),
      stage: gs.staged.length ? undefined : stageablePaths(gs.changes),
      then: then ?? null,
    };
    runWrite(root, then === 'push' ? 'push' : then === 'sync' ? 'sync' : 'commit', () => api.codeGitCommit(req), message);
  }

  // ───────── 메시지 생성 ─────────
  async function generate() {
    if (!current) return;
    const root = current;
    const k = keyOf(root);
    const d = draftOf(k);
    if (d.gen) { call(() => api.codeGitMessageStop(root)); return; } // 응답이 「중단했습니다」로 온다
    if (genBtn.disabled) return;
    d.gen = { before: msgEl.value, discard: false };
    const mine = d.gen;
    setFlash('');
    updateControls();
    const r = await call(() => api.codeGitMessage(root));
    if (d.gen === mine) d.gen = null;
    const here = k === curKey();
    let text = '';
    let err = false;
    if (mine.discard) {
      // 그 사이 커밋되어 이 메시지는 버린다
    } else if (r.ok && typeof r.message === 'string' && r.message) {
      if (here && !ops.has(k) && msgEl.value === mine.before) { msgEl.value = r.message; d.text = r.message; d.pending = null; autosize(); }
      else if (!here && !ops.has(k) && d.text === mine.before) { d.text = r.message; d.pending = null; }
      else d.pending = r.message; // 그 사이 입력이 달라졌거나 커밋이 도는 중이면 덮어쓰지 않고 적용 여부를 묻는다
    } else if (r.stopped) text = '중단했습니다';
    else { text = `⚠ ${r.error || '메시지를 만들지 못했습니다'}`; err = true; }
    if (text) { if (here) setFlash(text, err); else d.last = { text, err }; }
    if (here) { renderNote(); updateControls(); }
    else renderPending();
  }

  // ───────── 그래프 (읽기 전용: 줄에 누르는 동작이 없다) ─────────
  function graphRow(c, now) {
    const hash7 = String(c.hash || '').slice(0, 7);
    const merge = Array.isArray(c.parents) && c.parents.length > 1;
    const chips = refChips(c.refs).map((ch) => node('span', { class: `gp-ref gp-ref-${ch.kind}${ch.current ? ' gp-ref-cur' : ''}`, title: `${ch.current ? 'HEAD (현재 위치) · ' : ''}${ch.label} · ${REF_TITLE[ch.kind]}` }, ch.label));
    return node('li', { class: 'gp-node', title: `${hash7} · ${c.subject}` },
      node('div', { class: 'gp-node-top' },
        node('span', { class: 'gp-mark', title: merge ? '병합 커밋' : '커밋' }, merge ? '◆' : '●'),
        node('span', { class: 'gp-subject' }, c.subject),
        chips),
      node('div', { class: 'gp-meta' }, [c.author, logTime(c.at, now)].filter(Boolean).join(' · ')));
  }

  const graphMsg = (text, err = false) => node('li', { class: err ? 'gp-graph-empty err' : 'gp-graph-empty' }, text);

  let drawn = null; // 마지막으로 그린 { shown, has }
  function renderGraph() {
    graphToggle.textContent = `${graphOpen ? '▾' : '▸'} 그래프`;
    graphToggle.setAttribute('aria-expanded', String(graphOpen));
    graphUl.hidden = !graphOpen;
    if (!graphOpen) return; // 접혀 있는 동안은 그대로 둔다 (다시 펼칠 때 바뀌었으면 refreshGraph 가 받는다)
    const shown = gs ? graph : undefined; // 상태가 없으면 비운다. 그린 것과 같으면 다시 그리지 않는다 (10초 조회마다 줄을 새로 만들지 않게)
    if (drawn !== null && drawn.shown === shown && drawn.has === !!gs) return;
    drawn = { shown, has: !!gs };
    const top = listsEl.scrollTop;
    if (!gs) graphUl.replaceChildren();
    else if (!graph) graphUl.replaceChildren(graphMsg('불러오는 중…'));
    else if (graph.error) graphUl.replaceChildren(graphMsg(`⚠ ${graph.error}`, true));
    else if (!graph.commits.length) graphUl.replaceChildren(graphMsg('커밋이 없습니다'));
    else { const now = Date.now(); graphUl.replaceChildren(...graph.commits.map((c) => graphRow(c, now))); }
    listsEl.scrollTop = top;
  }

  function resetGraph() {
    logSeq += 1; // 받는 중이던 응답은 버린다
    graph = null;
    graphKey = '';
    graphPending = '';
    renderGraph();
  }

  // 펼쳐져 있고 보이는 동안, 커밋 위치·원격 연결·앞섬/뒤처짐(logKey)이 바뀌었을 때만 받는다. 거부·실패는 목록 자리에 ⚠ 로 보이고 콘솔로 새지 않는다.
  function refreshGraph() {
    renderGraph();
    if (!graphOpen || !visible || !gs || unavailable || !current || typeof api.codeGitLog !== 'function') return;
    const key = logKey(gs);
    if (key === graphKey || key === graphPending) return;
    loadGraph(current, key);
  }

  async function loadGraph(root, key) {
    const seq = ++logSeq;
    graphPending = key;
    const r = await call(() => api.codeGitLog(root));
    if (seq !== logSeq || root !== current) return; // 그 사이 폴더가 바뀌었거나 더 새 요청이 나갔다
    graphPending = '';
    const okLog = r.ok && Array.isArray(r.commits);
    if (okLog) graphKey = key;
    graph = okLog ? { commits: r.commits } : { error: r.error || '그래프를 불러오지 못했습니다' };
    renderGraph();
  }

  function toggleGraph() {
    graphOpen = !graphOpen;
    try { localStorage.setItem(GRAPH_KEY, graphOpen ? '1' : '0'); } catch { /* 저장하지 못해도 이번에는 동작한다 */ }
    refreshGraph();
    if (graphOpen) listsEl.scrollTop = Math.max(0, graphHead.offsetTop - listsEl.offsetTop); // 펼친 그래프가 바로 보이게
  }

  // ───────── 바깥에 내놓는 것 ─────────
  function clearLists() {
    gs = null;
    fp = '';
    listFp = '';
    staleNote = '';
    marks = new Set();
    renderLists();
    renderHead();
    resetGraph();
  }

  function setUnavailable(text) {
    unavailable = String(text || '지원하지 않는 폴더입니다');
    closeConfirm();
    clearTimeout(flashTimer);
    flash = null;
    refocus = null;
    clearLists();
    renderNote();
    updateControls();
  }

  renderGraph();

  return {
    el,
    head: headEl,
    resizer,
    // 보는 폴더가 바뀜: 입력 중인 글은 이전 폴더 몫으로 저장하고 새 폴더의 글을 꺼낸다. 상태는 다음 조회가 올 때까지 비운다.
    setRoot(root) {
      if (current) draftOf(keyOf(current)).text = msgEl.value;
      current = root || null;
      const d = current ? draftOf(keyOf(current)) : null;
      msgEl.value = d ? d.text : '';
      autosize();
      closeConfirm();
      unavailable = '';
      dismissed = '';
      refocus = null;
      clearLists();
      // 다른 폴더에 있는 동안 끝난 작업의 결과 안내 (성공 안내는 여기서도 잠깐만 보인다)
      const last = d?.last;
      if (d) d.last = null;
      setFlash(last ? last.text : '', !!last?.err, last && !last.err ? OK_NOTE_MS : 0);
      updateControls();
    },
    // 조회 결과 (ok:false 도 받는다). 지문이 같으면 목록은 그대로 두고 단추 상태만 갱신한다.
    setState(next) {
      // 잠깐 느린 것: 마지막 목록·확인 줄을 그대로 두고 안내만 한다 (쓰기는 메인이 다시 검사한다). 그 밖의 실패는 쓸 수 없는 상태로.
      if (next && next.ok === false && next.code === 'timeout' && gs) { staleNote = next.error; renderNote(); return; }
      staleNote = '';
      if (!next || next.ok === false) { setUnavailable((next && next.error) || '깃 상태를 읽지 못했습니다'); return; }
      const prev = gs;
      unavailable = '';
      gs = next;
      // 쓸 수 있는지·이유가 바뀌면 지난 성공 안내는 지운다 (오류 안내는 남긴다)
      if (prev && (prev.canWrite !== next.canWrite || prev.reason !== next.reason) && flash && !flash.err) { clearTimeout(flashTimer); flash = null; }
      const prevMarks = marks;
      marks = recentEditSet(agentEdits(), next.prefix, Date.now());
      const now = gitFingerprint(next, marks);
      const list = gitFingerprint(next);
      if (now !== fp) {
        const contentChanged = list !== listFp || [...marks].some((m) => !prevMarks.has(m));
        fp = now;
        renderLists();
        renderHead();
        // 확인 줄이 열려 있는 동안 목록이 바뀌었으면 닫는다: 확인 줄이 가리킨 변경과 실제 커밋 대상이 어긋나지 않게
        if (confirmThen && contentChanged) { closeConfirm(); setFlash(STALE_TEXT); }
      }
      listFp = list;
      renderNote();
      updateControls();
      refreshGraph();
    },
    // 쓸 수 없는 폴더·상태: 쓰기를 모두 끄고 목록을 비우고 이유를 안내한다.
    setUnavailable,
    // ⟳: 태그처럼 지문(logKey)에 안 드는 변화도 보이게, 이어서 오는 상태 조회(setState)에서 그래프를 다시 받게 한다 (그 조회에서 한 번만 받는다. 펼쳐져 있고 보일 때만).
    refreshGraph() { logSeq += 1; graphKey = ''; graphPending = ''; },
    show() {
      visible = true;
      autosize(); // 숨겨진 동안은 높이를 잴 수 없었다
      syncBusy();
      refreshGraph();
    },
    hide() {
      visible = false;
      syncBusy();
    },
  };
}
