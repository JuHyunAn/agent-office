// 화면 조립: 진입(로그인) → 왼쪽 사무실(항상 표시) + 오른쪽 Claude Code 탭.
import { OfficeEngine, NON_BLOCKING_NOTIFICATIONS } from './office/engine.js';
import { OfficeView } from './office/view.js';
import { baseName } from './office/phrases.js';
import { THEMES, getTheme } from './themes/index.js';
import { createCollabPanel } from './collab/panel.js';
import { rosterOf } from './collab/moderator.js';
import { setupCliResizer, setupAnalysisResizer } from './layout.js';
import { cardPreview } from './pet/model.js';
import { createCodePanel } from './code/panel.js';
import { AGENTS, AGENT_IDS, agentName, agentById, normAgent } from '../shared/agents.js';
import { agentsOf, connectedIds, canEnter, accountText, pickDefault, collabReady, collabSupported } from './agentStatus.js';
import { t, hasKey, getLang, onLangChange } from '../shared/i18n.js';
import { initLang, bindLangToggle } from './i18n-dom.js';

const api = window.office;
const $ = (sel) => document.querySelector(sel);
const FEED_MAX = 200; // 활동 기록 보관 수 — 칸을 끌어 키우면 더 보이고, 넘치면 스크롤 (addFeed 가 위쪽 코드에서도 불리므로 파일 맨 위에 둔다)

// 다른 그리기보다 먼저 저장된 언어를 적용한다. 메인에는 시작 때와 바뀔 때마다 알린다 (구버전 preload 에는 setLang 이 없을 수 있다).
function syncMainLang() {
  try { Promise.resolve(api.setLang?.(getLang())).catch(() => {}); } catch { /* 메인에 알리지 못해도 화면은 계속 */ }
}
initLang();
bindLangToggle($('#lang-toggle'));
bindLangToggle($('#gate-lang'));
syncMainLang();

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 저장 불가 환경 */ }
  },
};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c instanceof Node ? c : String(c));
  return node;
}

function hhmm(d = new Date()) {
  return d.toTimeString().slice(0, 8);
}

function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  return m < 1 ? t('app.time.now') : m < 60 ? t('app.time.minutesAgo', { n: m }) : t('app.time.hoursAgo', { n: Math.floor(m / 60) });
}

// ───────────────────────── 상태 ─────────────────────────

const state = {
  status: null,
  tabs: new Map(),
  active: null,
  external: new Map(), // 앱 탭이 아닌 세션 (사용자 전역 hook 으로 들어온 것)
  closedTabs: new Set(), // 닫은 탭 ID (탭 ID 는 다시 쓰지 않는다)
  seq: 0,
  attention: new Map(), // 「확인 필요」: 탭 id(외부 세션은 ext:<세션 id>) → 항목 — 사무실 말풍선 반짝임(과 다음 단계 펫)의 단일 출처
  entered: false,
  agentPick: null, // AI 목록에서 고른 AI (id) — 진입 화면과 「AI 연결」 대화상자가 함께 쓴다
};

let theme = getTheme(store.get('ao.theme', 'pixel-office'));
const engine = new OfficeEngine(theme.layout, { onFeed: addFeed, now: () => performance.now(), timing: { leadIdleToRestMs: 20000 } });
const view = new OfficeView($('#office'), engine, theme, { tooltip: $('#tooltip'), onState({ zoom, minZoom, playerTask, headcount, environment, interactionMenu, heldItem }) {
  $('#zoom-level').textContent = `${zoom}%`;
  $('#zoom-out').disabled = zoom <= minZoom;
  $('#player-state').textContent = playerTask || t('app.life.lookAround');
  $('#headcount').textContent = t('app.top.headcount', { n: headcount });
  $('#environment-state').textContent = environment.label;
  $('#held-item').textContent = heldItem ? `☕ ${heldItem}` : '';
  $('#held-item').hidden = !heldItem;
  renderInteractionMenu(interactionMenu);
} });
let displayedMenu = null;
function renderInteractionMenu(menu) {
  const key = menu?.itemId || null;
  if (displayedMenu === key) return;
  displayedMenu = key;
  const panel = $('#interaction-menu'); panel.hidden = !menu; panel.replaceChildren();
  if (!menu) return;
  panel.append(el('div', { class: 'menu-heading' }, el('h3', { id: 'interaction-title' }, t('app.life.coffeeTitle')),
    el('button', { class: 'menu-close', type: 'button', 'aria-label': t('app.life.drinkClose'), onclick: () => view.closeInteractionMenu() }, '×')),
  el('div', { class: 'drink-choices' }, menu.choices.map(drink => el('button', {
    class: 'drink-choice', type: 'button', 'data-drink': drink.id,
    onclick: () => { if (view.chooseDrink(drink.id)) $('#office').focus({ preventScroll: true }); },
  }, el('img', { class: 'drink-thumbnail', src: drink.image, alt: '', width: '36', height: '40' }),
  el('span', {}, drink.label)))));
  panel.querySelector('.drink-choice')?.focus({ preventScroll: true });
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && view.life?.menu) { e.preventDefault(); view.closeInteractionMenu(); } });
async function refreshWeather() {
  try { view.environment.setWeather(await api.getWeather()); }
  catch { /* Retain the last observation until it expires. */ }
}
refreshWeather();
const weatherTimer = setInterval(refreshWeather, 10 * 60 * 1000);
window.addEventListener('beforeunload', () => clearInterval(weatherTimer), { once: true });
$('#weather-credit').addEventListener('click', e => { e.preventDefault(); api.openExternal('https://open-meteo.com/'); });
$('#zoom-in').addEventListener('click', () => view.zoomBy(1.25));
$('#zoom-out').addEventListener('click', () => view.zoomBy(0.8));
$('#zoom-fit').addEventListener('click', () => view.fit());
$('#focus-player').addEventListener('click', () => view.focusPlayer());
setupCliResizer($('.layout'), $('#cli-resizer'));
// 활동 기록 높이: 머리줄·여백(27px) 아래 2줄(34px)은 남기고, 사무실 칸은 200px 남긴다.
setupAnalysisResizer($('.feed-panel'), $('.feed-heading'), $('.office-stage'), $('#feed-resizer'), { key: 'ao.feedHeight', cssVar: '--feed-height', bodyMin: 61, viewMin: 200 });

// ───────────────────────── 왼쪽 화면 전환 (사무실 ↔ 코드) ─────────────────────────
// 코드 화면은 사무실 영역을 덮는다. 사무실은 그리기만 쉬고 계산은 계속한다 (view.setHidden). 상태는 저장하지 않아 앱을 켜면 사무실이다.

const codePanel = createCodePanel({ api, host: $('#code-pane'), newTerminal }); // 화면(DOM)만 만든다 — 모나코는 첫 파일을 열 때 불러온다
let codeMode = false;

// 열린 탭(Codex 로그인 탭 제외)의 작업 폴더를 코드 패널의 폴더 목록으로 알린다.
function syncCodeFolders() {
  codePanel.setFolders([...state.tabs.values()].filter((t) => !t.login).map((t) => t.cwd));
}

function setCodeMode(on) {
  on = !!on;
  if (on === codeMode) return;
  if (on && view.theme.editor?.editing) { addFeed({ text: t('app.feed.finishEditFirst') }); return; }
  codeMode = on;
  $('#mode-office').setAttribute('aria-pressed', String(!on));
  $('#mode-code').setAttribute('aria-pressed', String(on));
  document.body.classList.toggle('code-mode', on);
  for (const e of document.querySelectorAll('.office-stage, .life-bar, .feed-panel')) e.toggleAttribute('inert', on); // 덮여 보이지 않는 사무실 쪽이 키보드 초점을 받지 않게
  view.setHidden(on);
  $('#code-pane').hidden = !on;
  if (on) { const tab = state.tabs.get(state.active); codePanel.show(tab && !tab.login ? tab.cwd : null); } else codePanel.hide(); // 처음 열 때 지금 보는 탭의 폴더를 기본으로
}

$('#mode-office').addEventListener('click', () => setCodeMode(false));
$('#mode-code').addEventListener('click', () => setCodeMode(true));
// 코드 화면이 도구줄 아래부터 덮도록 도구줄 높이를 CSS 변수로 알린다 (날씨 줄이 줄바꿈되면 높이가 바뀐다).
const officeToolbar = $('.office-toolbar');
new ResizeObserver(() => document.documentElement.style.setProperty('--office-toolbar-h', `${officeToolbar.offsetHeight}px`)).observe(officeToolbar);

const TERM_OPTS = {
  fontFamily: '"Cascadia Mono", Consolas, "D2Coding", "Malgun Gothic", monospace',
  fontSize: 13,
  cursorBlink: true,
  scrollback: 5000,
  allowProposedApi: true,
  theme: { background: '#1a1a1f', foreground: '#e8e6e3', cursor: '#d97757', selectionBackground: '#5a4a6a' },
  ...(navigator.userAgent.includes('Windows') ? { windowsPty: { backend: 'conpty' } } : {}),
};

function newTerminal() {
  const term = new window.Terminal(TERM_OPTS);
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  // Ctrl+C: 선택 영역이 있으면 복사, 없으면 그대로 Claude 로 (중단 신호). Ctrl+V: 붙여넣기.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || e.altKey) return true;
    const k = e.key.toLowerCase();
    if (k === 'c' && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection()).catch(() => {});
      term.clearSelection();
      return false;
    }
    if (k === 'v' && !e.shiftKey) {
      e.preventDefault(); // 브라우저 기본 붙여넣기까지 일어나면 두 번 입력된다
      navigator.clipboard.readText().then((t) => t && term.paste(t)).catch(() => {});
      return false;
    }
    return true;
  });
  return { term, fit };
}

// ───────────────────────── 진입 화면 ─────────────────────────

const IS_WIN = /Windows/i.test(navigator.userAgent); // 앱 안 설치(공식 PowerShell 명령)는 Windows 에서만 — 메인도 같은 기준으로 막는다
const setupName = (id, mode) => t(mode === 'install' ? 'app.tab.install' : 'app.tab.login', { name: agentName(id) }); // 준비 터미널·탭의 이름

let gateTerm = null;
let loginAgent = null; // 진입 화면 터미널이 마지막으로 띄운 로그인·설치의 AI id
let loginMode = 'login'; // 그 터미널이 띄운 것: 'login' | 'install'
let loginRunning = false; // 그 터미널이 아직 끝나지 않았다 (종료 알림 전)
let loginGen = 0; // startGateProc 호출마다 올린다 — 늦게 끝난 앞선 호출이 화면을 덮어쓰지 않게
let gateUi = null; // 진입 화면(정상 상태)에서 갱신하는 요소들
let statusLoading = null; // 진행 중인 상태 확인 — 겹쳐 부르면 같은 결과를 기다린다
let statusAgain = false; // 확인 중에 다시 불렸으면 끝난 뒤 한 번 더 (로그인 직후 옛 결과가 남지 않게)

const currentAgents = () => agentsOf(state.status);

function refreshStatus() {
  if (statusLoading) { statusAgain = true; return statusLoading; }
  statusLoading = (async () => {
    try {
      state.status = await api.status();
    } catch (e) {
      state.status = { error: String(e && e.message || e) };
    }
    renderGate();
    if ($('#agentsdlg').open) syncAgentsDialog(false);
    updateAgentPanels();
    renderTopbar();
    publishPet();
    renderKindPick(); // 닫혀 있어도 맞춰 둔다 (열기 전에 눌린 폴더 선택 등이 최신 연결 상태를 보게)
  })().finally(() => {
    statusLoading = null;
    if (statusAgain) { statusAgain = false; refreshStatus(); }
  });
  return statusLoading;
}

// 상태를 읽지 못했거나(오류) 아직 읽는 중일 때 보여 줄 안내 — 진입 화면·AI 연결 대화상자 공용
function statusNote(st) {
  if (!st) return [el('p', {}, t('app.gate.checking'))];
  return [el('p', { class: 'err' }, st.error), el('button', { type: 'button', class: 'btn', onclick: refreshStatus }, t('app.agents.recheck'))];
}

function renderGate() {
  const body = $('#gate-body');
  const st = state.status;
  if (!st || st.error) {
    body.dataset.mode = st ? 'error' : 'loading';
    gateUi = null;
    body.replaceChildren(...statusNote(st));
    return;
  }
  if (body.dataset.mode !== 'ready') {
    // 정상 화면은 처음 한 번만 만든다 — 이후 상태 갱신은 제자리에서 (초점·로그인 터미널 위치가 흐트러지지 않게)
    body.dataset.mode = 'ready';
    const count = el('p', { class: 'gate-count' });
    const hint = el('p', { class: 'hint' });
    const enterBtn = el('button', { id: 'gate-enter', type: 'button', class: 'btn primary', onclick: () => enter() });
    const host = el('div', { class: 'gate-panel' });
    body.replaceChildren(
      el('div', { class: 'gate-head' },
        el('div', { class: 'gate-headtext' }, count, hint),
        enterBtn),
      host);
    gateUi = { count, hint, enterBtn };
    renderAgentPanel(host, { where: 'gate' });
  }
  const list = currentAgents();
  gateUi.count.textContent = t('app.agents.connected', { n: connectedIds(list).length, total: list.length });
  gateUi.hint.textContent = t('app.gate.hint'); // 글자는 매번 맞춘다 — 언어를 바꿔도 이 블록은 다시 만들지 않는다
  gateUi.enterBtn.textContent = t('app.gate.enter');
  gateUi.enterBtn.disabled = !canEnter(list);
  gateUi.enterBtn.title = canEnter(list) ? '' : t('app.gate.needOne');
}

// ───────────────────────── AI 목록 패널 (진입 화면 · 「AI 연결」 대화상자 공용) ─────────────────────────
// 왼쪽 목록(listbox) + 오른쪽 고른 AI 상세. 행은 처음 한 번만 만들고, 상태가 바뀌면 점·요약·선택 표시만 고치고 상세만 다시 그린다.
// 같은 패널이 두 곳에 함께 있을 수 있어 패널 안 요소에는 id 를 쓰지 않는다 (data-agent 사용).

const agentPanels = new Set();

function dropAgentPanels(host) {
  for (const p of agentPanels) if (p.host === host) agentPanels.delete(p);
}

function renderAgentPanel(host, { where }) {
  dropAgentPanels(host);
  const list = el('ul', { class: 'agent-list', role: 'listbox', 'aria-label': t('app.agents.listLabel') });
  const detail = el('div', { class: 'agent-detail' });
  const panel = { host, where, list, detail, rows: new Map() };
  for (const def of AGENTS) {
    const dot = el('span', { class: 'agent-dot' });
    dot.style.setProperty('--dot', def.color);
    const sub = el('span', { class: 'agent-sub' });
    const row = el('li', { class: 'agent-row', role: 'option', tabindex: '-1', 'aria-selected': 'false', 'data-agent': def.id, onclick: () => pickAgent(def.id) },
      dot, el('span', { class: 'agent-text' }, el('b', {}, def.product), sub));
    panel.rows.set(def.id, { row, dot, sub });
    list.append(row);
  }
  list.addEventListener('keydown', (e) => agentListKey(e, panel));
  host.replaceChildren(el('div', { class: 'agent-split' }, list, detail));
  agentPanels.add(panel);
  updateAgentPanel(panel);
}

// APG listbox: 위·아래 화살표(Home/End 포함)는 선택과 초점을 함께 옮기고, Space·Enter 는 페이지가 스크롤·제출되지 않게만 막는다.
function agentListKey(e, panel) {
  const ids = AGENTS.map((a) => a.id);
  const at = ids.indexOf(e.target.closest?.('.agent-row')?.dataset.agent ?? state.agentPick);
  let next = null;
  if (e.key === 'ArrowDown') next = Math.min(ids.length - 1, at + 1);
  else if (e.key === 'ArrowUp') next = Math.max(0, at - 1);
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = ids.length - 1;
  else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (at >= 0) pickAgent(ids[at]); return; }
  else return;
  e.preventDefault();
  pickAgent(ids[next]);
  panel.rows.get(ids[next])?.row.focus();
}

function pickAgent(id) {
  state.agentPick = id;
  store.set('ao.agentPick', id);
  updateAgentPanels();
}

function updateAgentPanels() {
  for (const p of agentPanels) {
    if (!p.list.isConnected) agentPanels.delete(p);
    else updateAgentPanel(p);
  }
}

function updateAgentPanel(panel) {
  const st = state.status;
  if (!st || st.error) return;
  const list = currentAgents();
  panel.list.setAttribute('aria-label', t('app.agents.listLabel'));
  if (!list.some((e) => e.id === state.agentPick)) state.agentPick = pickDefault(list, store.get('ao.agentPick', null));
  for (const e of list) {
    const r = panel.rows.get(e.id);
    r.dot.className = `agent-dot state-${e.state}`;
    r.sub.textContent = accountText(e);
    const on = e.id === state.agentPick;
    r.row.setAttribute('aria-selected', String(on));
    r.row.tabIndex = on ? 0 : -1;
  }
  renderAgentDetail(panel, list.find((e) => e.id === state.agentPick));
}

// 로그인만으로는 쓸 수 없는 AI 의 계정 조건 안내 (로그인 필요·오류 상태의 상세에만 붙는다). Muse 는 결제 수단·구독이 없으면 로그인 직후 CLI 가 자격 증명을 지운다 (1.4.14 실측).
const ACCOUNT_NOTES = {
  muse: {
    text: 'app.agents.museNote',
    label: 'app.agents.museNoteBtn',
    url: 'https://accountscenter.meta.com/muse_code/',
  },
};

function renderAgentDetail(panel, e) {
  const { def } = e;
  const recheck = el('button', { type: 'button', class: 'btn', 'data-act': 'recheck', onclick: () => refreshStatus() }, t('app.agents.recheck'));
  const loginBtn = el('button', { type: 'button', class: 'btn primary', 'data-act': 'login', onclick: () => {
    if (panel.where === 'gate') { startGateProc(def.id, 'login'); return; }
    $('#agentsdlg').close();
    openSetupTab(def.id, 'login');
  } }, t('app.agents.loginBtn', { name: def.name }));
  const installBtn = el('button', { type: 'button', class: 'btn primary', 'data-act': 'install', onclick: () => {
    if (panel.where === 'gate') { startGateProc(def.id, 'install'); return; }
    $('#agentsdlg').close();
    openSetupTab(def.id, 'install');
  } }, t('app.agents.installBtn', { name: def.name }));
  const loginHint = el('p', { class: 'hint' }, t('app.agents.loginHint')); // Antigravity 는 전용 로그인 명령이 없어 CLI 화면 자체로 로그인한다
  const note = ACCOUNT_NOTES[def.id];
  const accountNote = note ? [el('p', { class: 'hint' }, t(note.text)), el('div', { class: 'gate-row' }, el('button', { type: 'button', class: 'btn', 'data-act': 'account', onclick: () => api.openExternal(note.url) }, t(note.label)))] : [];
  const kids = [el('h3', { class: 'agent-title' }, e.version ? `${def.product} · ${e.version}` : def.product)];
  if (e.state === 'missing') {
    kids.push(
      el('p', {}, t('app.agents.notInstalled')),
      ...(IS_WIN ? [el('div', { class: 'gate-row' }, installBtn),
        el('p', { class: 'hint' }, t('app.agents.installHint'))] : []),
      el('code', {}, def.install.cmd),
      el('div', { class: 'gate-row' }, el('button', { type: 'button', class: 'btn', onclick: () => api.openExternal(def.install.url) }, t('app.agents.installGuide')), recheck));
  } else if (e.state === 'login') {
    kids.push(el('p', {}, t('app.agents.notLoggedIn')), el('div', { class: 'gate-row' }, loginBtn, recheck), loginHint, ...accountNote);
  } else if (e.state === 'error') {
    kids.push(el('p', {}, t('app.agents.statusFailed')), el('p', { class: 'err' }, e.auth?.error || ''), el('div', { class: 'gate-row' }, loginBtn, recheck), loginHint, ...accountNote);
  } else {
    kids.push(
      el('p', { class: 'gate-account', title: [e.version && t('app.agents.version', { version: e.version }), e.path].filter(Boolean).join('\n') }, accountText(e)),
      el('div', { class: 'gate-row' }, recheck));
    if (def.id === 'antigravity' && state.status?.hooks?.agy) kids.push(el('p', { class: 'err', title: state.status.hooks.agy.error || '' }, t('app.agents.agyHooksErr')));
  }
  // 상세를 다시 그려도 그 안에 있던 키보드 초점은 같은 동작 버튼으로 되돌린다 (「다시 확인」을 누른 뒤 초점이 사라지지 않게)
  const act = panel.detail.contains(document.activeElement) ? document.activeElement.dataset?.act : null;
  panel.detail.replaceChildren(...kids);
  if (act) panel.detail.querySelector(`[data-act="${act}"]`)?.focus();
}

// 진입 화면 로그인·설치 터미널 (id: AI id, mode: 'login' | 'install'). 터미널은 하나라 이전 출력을 지우고 새로 시작한다.
async function startGateProc(id, mode = 'login') {
  if (loginRunning && loginMode === 'install' && !window.confirm(t('app.gate.confirmRestartInstall'))) return;
  const gen = ++loginGen;
  const switched = loginRunning && (loginAgent !== id || loginMode !== mode); // 다른 AI·다른 종류로 바꿨다 — 끊긴 앞 터미널은 종료 알림이 없다
  loginAgent = id;
  loginMode = mode;
  const host = $('#gate-term');
  host.hidden = false;
  const title = $('#gate-term-title');
  title.hidden = false;
  paintGateTitle();
  if (!gateTerm) {
    gateTerm = newTerminal();
    gateTerm.term.open(host);
    gateTerm.term.onData((d) => api.writePty('login', d));
  }
  gateTerm.term.reset();
  gateTerm.fit.fit();
  loginRunning = true;
  try {
    await api.createPty({ tabId: 'login', mode, cli: id, cols: gateTerm.term.cols, rows: gateTerm.term.rows });
  } catch (e) {
    if (gen === loginGen) { loginRunning = false; gateTerm.term.write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`); }
  }
  if (switched) refreshStatus();
}

// 진입 화면 터미널 위의 안내 한 줄 (언어를 바꾸면 다시 쓴다)
function paintGateTitle() {
  const title = $('#gate-term-title');
  if (title.hidden || !loginAgent) return;
  title.textContent = t(loginMode === 'install' ? 'app.gate.installTitle' : 'app.gate.loginTitle', { product: agentById(loginAgent).product });
}

async function enter() {
  if (loginRunning && !window.confirm(loginMode === 'install'
    ? t('app.gate.confirmInstallEnter')
    : t('app.gate.confirmLoginEnter', { product: agentById(loginAgent).product }))) return;
  loginRunning = false;
  state.entered = true;
  $('#gate').hidden = true;
  if (gateTerm) api.killPty('login'); // 입장 뒤 보이지 않는 로그인 프로세스를 남기지 않는다
  try {
    await view.start();
  } catch (e) {
    addFeed({ text: t('app.feed.themeFallback', { name: themeLabel(theme), error: e.message }) });
    theme = THEMES[0];
    store.set('ao.theme', theme.id);
    $('#theme-select').value = theme.id;
    view.theme = theme;
    engine.setLayout(theme.layout);
    await view.start();
  }
  if (state.tabs.size === 0) openNewTabDialog();
}

// ───────────────────────── 상단 막대 ─────────────────────────

// 상단 「연결 n/N」 칸 — 누르면 같은 AI 목록 패널이 대화상자로 뜬다.
function renderAgentsPill() {
  const btn = $('#agents-pill');
  const st = state.status;
  if (!st) { btn.textContent = t('app.top.pillChecking'); btn.className = 'pill pill-btn'; btn.title = ''; return; }
  if (st.error) { btn.textContent = t('app.top.pillFailed'); btn.className = 'pill pill-btn warn'; btn.title = t('app.top.pillFailedTitle', { error: st.error }); return; }
  const list = currentAgents();
  const n = connectedIds(list).length;
  btn.textContent = t('app.agents.connected', { n, total: list.length });
  btn.className = `pill pill-btn${n === list.length ? ' on' : n === 0 ? ' warn' : ''}`;
  btn.title = list.map((e) => `${e.def.product}: ${accountText(e)}`).join('\n'); // 칸이 잘려도 계정을 볼 수 있게
  btn.setAttribute('aria-label', t('app.top.pillAria', { label: btn.textContent })); // 화면 낭독기가 무엇의 연결인지 읽게
}

// 「AI 연결」 대화상자 본문: 열 때 새로 만들고, 상태가 바뀌면 제자리에서 갱신 (오류↔정상이 바뀌면 다시 만든다)
function syncAgentsDialog(fresh) {
  const host = $('#agentsdlg-body');
  const st = state.status;
  if (!st || st.error) {
    host.dataset.mode = 'error';
    dropAgentPanels(host);
    host.replaceChildren(...statusNote(st));
  } else if (fresh || host.dataset.mode !== 'panel') {
    host.dataset.mode = 'panel';
    renderAgentPanel(host, { where: 'dialog' });
  }
}

$('#agents-pill').addEventListener('click', () => {
  if (!state.entered) return; // 입장 전에는 진입 화면이 같은 목록을 보여 준다 (키보드로 뒤쪽 칸에 닿아도 열지 않음)
  if (state.status?.error) { refreshStatus(); return; }
  const dlg = $('#agentsdlg');
  if (dlg.open) return;
  syncAgentsDialog(true);
  dlg.showModal();
});
$('#agentsdlg-close').addEventListener('click', () => $('#agentsdlg').close());
$('#agentsdlg').addEventListener('close', () => {
  const host = $('#agentsdlg-body');
  dropAgentPanels(host);
  delete host.dataset.mode;
  host.replaceChildren();
});

function renderTopbar() {
  const st = state.status;
  renderAgentsPill();
  if (st?.pet?.mode) $('#pet-mode').value = st.pet.mode;
  const btn = $('#global-hooks');
  btn.hidden = !!st && !st.error && !currentAgents().find((e) => e.id === 'claude')?.found; // 다른 곳 세션 보기는 Claude Code 기능이다
  const g = st && st.hook && st.hook.global;
  if (!g) { btn.textContent = t('app.top.hooksNone'); return; }
  if (g.error) { btn.textContent = t('app.top.hooksError'); btn.className = 'pill pill-btn warn'; btn.title = g.error; return; }
  if (needsReconnect(g)) {
    btn.textContent = t('app.top.hooksReconnect');
    btn.className = 'pill pill-btn warn';
    btn.title = t('app.top.hooksReconnectTitle');
  } else {
    btn.textContent = t(g.installed ? 'app.top.hooksOn' : 'app.top.hooksOff');
    btn.className = `pill pill-btn ${g.installed ? 'on' : ''}`;
    btn.title = t('app.top.hooksTitle');
  }
}

function needsReconnect(g) {
  return g.installed && (g.portMatches === false || g.tokenMatches === false);
}

$('#global-hooks').addEventListener('click', async () => {
  const g = state.status && state.status.hook && state.status.hook.global;
  if (!g) return;
  const enable = !g.installed || needsReconnect(g);
  try {
    const r = await api.setGlobalHooks(enable);
    state.status.hook.global = r.global;
    if (!r.cancelled) addFeed({ text: t(enable ? 'app.feed.hookAdded' : 'app.feed.hookRemoved') });
  } catch (e) {
    addFeed({ text: t('app.feed.hookFailed', { error: e.message }) });
  }
  renderTopbar();
});

$('#pet-mode').addEventListener('change', async (e) => {
  const sel = e.target, want = sel.value;
  try {
    const r = await api.setPetMode(want);
    if (state.status) state.status.pet = { mode: r?.mode || want };
    sel.value = r?.mode || want;
  } catch (err) {
    sel.value = state.status?.pet?.mode || 'always';
    addFeed({ text: t('app.feed.petFailed', { error: err.message }) });
  }
});
api.onPetMode?.(({ mode } = {}) => { if (state.status) state.status.pet = { mode }; $('#pet-mode').value = mode || 'always'; });

// 테마 이름: 사전에 theme.name.<id> 가 있으면 그것, 없으면 테마가 가진 이름
const themeLabel = (th) => (hasKey(`theme.name.${th.id}`) ? t(`theme.name.${th.id}`) : th.name);

function fillThemeOptions() {
  const sel = $('#theme-select');
  sel.replaceChildren(...THEMES.map((th) => el('option', { value: th.id }, themeLabel(th))));
  sel.value = theme.id;
}

function renderThemes() {
  const sel = $('#theme-select');
  fillThemeOptions();
  sel.addEventListener('change', async () => {
    const next = getTheme(sel.value);
    try {
      if (!(await view.setTheme(next))) return; // 그 사이 다른 테마를 골랐다
      theme = next;
      store.set('ao.theme', theme.id); // 불러오기에 성공한 테마만 기억한다
      if (codeMode && view.theme.editor?.editing) setCodeMode(false); // 편집 중인 테마(제작 화면)는 코드 화면 아래에 둘 수 없다
    } catch (e) {
      sel.value = theme.id;
      addFeed({ text: t('app.feed.themeFailed', { name: themeLabel(next), error: e.message }) });
    }
  });
}

function updateHeadcount() {
  const n = engine.snapshot().filter((a) => a.status !== 'leaving').length;
  $('#headcount').textContent = t('app.top.headcount', { n });
}

// ───────────────────────── 활동 피드 ─────────────────────────

function addFeed(item) {
  const ul = $('#feed');
  ul.prepend(el('li', {}, el('time', {}, hhmm()), item.text));
  while (ul.children.length > FEED_MAX) ul.lastChild.remove();
}

// ───────────────────────── 탭 ─────────────────────────

function uniqueLabel(base) {
  const names = new Set([...state.tabs.values()].map((t) => t.label));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} #${i}`)) return `${base} #${i}`;
}

const KIND_NAME = Object.fromEntries(AGENTS.map((a) => [a.id, a.product]));
const KIND_PREFIX = Object.fromEntries(AGENTS.map((a) => [a.id, a.tabPrefix]));
const kindName = (kind) => (kind === 'collab' ? t('app.tab.collabName') : KIND_NAME[kind]);
const kindPrefix = (kind) => (kind === 'collab' ? t('app.tab.collabPrefix') : KIND_PREFIX[kind]);
// 탭 이름의 바탕과 마우스 올렸을 때 설명 — 언어를 바꾸면 relabelTabs 가 다시 만든다 (겹침 번호 ` #2` 는 tab.dup 으로 따로 둔다)
const tabBase = ({ login, mode, kind, cwd }) => (login ? setupName(login, mode) : `${kindPrefix(kind)}${baseName(cwd) || cwd}`);
const tabTitle = ({ login, mode, kind, cwd }) => (login
  ? t(mode === 'install' ? 'app.tab.installTitle' : 'app.tab.loginTitle', { product: agentById(login).product })
  : `${kindName(kind)} · ${cwd}`);

// kind: claude(공식 Claude Code 화면) · codex(공식 Codex 화면) · collab(고른 AI 들의 협업 대화)
// login: 입장 뒤 로그인·설치 탭 — 준비하려는 AI 의 id (mode 가 'login' 이면 공식 로그인 명령, 'install' 이면 공식 설치 명령). 폴더 없이 홈 폴더에서 띄운다 (아니면 false).
// agents: 협업 대화에 참여하는 AI id 목록 (대화창에 그대로 넘긴다 — 없으면 Claude·Codex)
async function openTab({ cwd, mode = 'new', resumeId = null, kind = 'claude', login = false, agents = null }) {
  const id = `t${Date.now().toString(36)}${(state.seq++).toString(36)}`;
  const base = tabBase({ login, mode, kind, cwd });
  const label = uniqueLabel(base);
  const pane = el('div', { class: 'pane' });
  $('#panes').append(pane);
  const dot = el('span', { class: 'dot' });
  const btn = el('button', { class: `tab kind-${kind}`, title: tabTitle({ login, mode, kind, cwd }), onclick: () => activate(id) },
    dot, el('span', { class: 'name' }, label),
    el('span', { class: 'close', title: t('app.tab.closeTitle'), onclick: (e) => { e.stopPropagation(); closeTab(id); } }, '×'));
  $('#tabs').append(btn);
  if (!login) store.set('ao.recent', [cwd, ...store.get('ao.recent', []).filter((p) => p !== cwd)].slice(0, 8));

  // sessions: 이 탭에서 나온 모든 세션 (탭 안에서 실행한 중첩 claude 포함) — 탭을 닫을 때 함께 정리한다.
  const tab = { id, kind, label, dup: label.slice(base.length), cwd, mode, login, agents, sessionId: null, sessions: new Set(), term: null, fit: null, panel: null, pane, btn, dot, status: 'idle', exited: false,
    collabSpeaker: null, collabLast: null, collabPrev: null, collabTurn: 0, collabAt: 0 };
  state.tabs.set(id, tab);
  publishPet(); // 탭을 연 AI 가 쓰는 중이 된다 — 펫이 나타나게
  // 코드 화면의 허용 폴더 등록 (협업 탭도 첫 메시지 전에 등록) — 등록이 끝난 뒤 폴더 목록을 알린다. 실패해도 조용히 넘어간다 (고르면 화면에 오류가 보인다).
  if (!login) api.codeAllow(cwd).catch(() => {}).then(syncCodeFolders);
  // 탭 영역(터미널·대화창)을 클릭하거나 포커스가 들어오면 「확인 필요」를 끈다.
  pane.addEventListener('focusin', () => lookedAt(id));
  pane.addEventListener('pointerdown', () => lookedAt(id));
  if (kind === 'collab') {
    pane.classList.add('pane-collab');
    // 작업 상태는 전이 알림(동기)으로도 정한다 — 창이 숨겨져 렌더가 멈춰도 펫이 협업 진행을 바로 알게.
    tab.panel = createCollabPanel({ api, roomId: id, cwd, agents, onStatus: (s) => setTabStatus(tab, s === 'running' ? 'working' : 'idle'), onTransition: (prev, next, agent) => { setTabStatus(tab, next === 'running' ? 'working' : 'idle'); collabAttention(tab, prev, next, agent); collabSettle(tab, prev, next, agent); }, onSpeaker: (agent) => collabSpeaker(tab, agent) });
    pane.append(tab.panel.root);
    activate(id);
    return;
  }
  const { term, fit } = newTerminal();
  Object.assign(tab, { term, fit });
  term.open(pane);
  term.onData((d) => { if (!tab.exited) api.writePty(id, d); });
  new ResizeObserver(() => fitTab(tab)).observe(pane);
  activate(id);

  try {
    const r = await api.createPty({ tabId: id, cwd, mode, resumeId, label, cli: kind, cols: term.cols, rows: term.rows });
    if (r.sessionId) { tab.sessionId = tab.sessionId || r.sessionId; tab.sessions.add(r.sessionId); }
  } catch (e) {
    tab.exited = true;
    setTabStatus(tab, 'exited');
    term.write(`\x1b[31m${t('app.term.runFailed', { error: e.message })}\x1b[0m\r\n`);
  }
}

// 입장 뒤 로그인·설치: 같은 AI·같은 종류의 열린 준비 탭이 있으면 그 탭으로, 없으면 새로 연다.
function openSetupTab(id, mode = 'login') {
  const open = [...state.tabs.values()].find((t) => t.login === id && t.mode === mode && !t.exited);
  if (open) activate(open.id);
  else openTab({ kind: id, mode, login: id });
}

function fitTab(tab) {
  if (!tab.term || state.active !== tab.id || tab.pane.hidden) return;
  try {
    tab.fit.fit();
    if (!tab.exited) api.resizePty(tab.id, tab.term.cols, tab.term.rows);
  } catch { /* 숨김 상태에서는 크기 계산 불가 */ }
}

function activate(id) {
  state.active = id;
  for (const t of state.tabs.values()) {
    const on = t.id === id;
    t.pane.hidden = !on;
    t.btn.classList.toggle('active', on);
  }
  $('#empty').hidden = state.tabs.size > 0;
  const tab = state.tabs.get(id);
  if (tab) {
    lookedAt(id);
    requestAnimationFrame(() => { fitTab(tab); if (tab.panel) tab.panel.focus(); else tab.term.focus(); });
  }
  publishFocus();
}

// 지금 보고 있는 탭을 메인에 알린다 (사용량 패널의 세션 줄용) — 같은 내용이면 보내지 않는다.
let lastFocus = '';
function publishFocus() {
  const tab = state.tabs.get(state.active);
  const focus = tab ? { tabId: tab.id, kind: tab.kind, label: tab.label } : { tabId: null, kind: null, label: '' };
  const json = JSON.stringify(focus);
  if (json === lastFocus) return;
  lastFocus = json;
  api.petFocus?.(focus);
}

// 언어를 바꾸면 이름이 언어를 따르는 탭(로그인·설치, 협업)의 이름·설명을 다시 쓴다. 이름은 확인 창·펫 포커스에도 쓰여 tab.label 도 함께 바꾼다.
function relabelTabs() {
  for (const tab of state.tabs.values()) {
    tab.label = tabBase(tab) + tab.dup;
    tab.btn.querySelector('.name').textContent = tab.label;
    tab.btn.title = tabTitle(tab);
    tab.btn.querySelector('.close').title = t('app.tab.closeTitle');
    // 사무실 이름표: 이벤트 때 붙인 이름(hook 처리부와 같은 규칙)을 새 탭 이름으로 바꾼다. 협업 세션은 이름 끝의 AI 이름을 유지한다.
    for (const sid of tab.sessions) {
      const s = engine.sessions.get(sid);
      if (!s?.name) continue;
      if (tab.kind === 'collab') { const ai = s.name.slice(s.name.lastIndexOf(' · ') + 3); s.name = `${tab.label} · ${ai}`; }
      else s.name = sid === tab.sessionId ? tab.label : t('app.tab.subSession', { label: tab.label });
    }
  }
}

async function closeTab(id) {
  const tab = state.tabs.get(id);
  if (!tab) return;
  const what = tab.login ? setupName(tab.login, tab.mode) : tab.kind === 'collab' ? t('app.tab.closeWhatCollab', { names: rosterOf(tab.agents).map(agentName).join('·') }) : t('app.tab.closeWhatSession', { name: kindName(tab.kind) });
  if (!tab.exited && !window.confirm(t('app.tab.confirmClose', { label: tab.label, what }))) return;
  state.tabs.delete(id);
  syncCodeFolders();
  state.closedTabs.add(id);
  if (state.closedTabs.size > 200) state.closedTabs.delete(state.closedTabs.values().next().value); // 오래 켜 둬도 끝없이 늘지 않게
  if (tab.panel) { tab.panel.destroy?.(); await api.collabClose(id); } // 대화창의 언어 구독을 풀고 닫는다
  else { await api.killPty(id); tab.term?.dispose(); } // 만들다 실패한 탭은 term 이 없을 수 있다
  tab.pane.remove();
  tab.btn.remove();
  endTabSessions(tab);
  const next = [...state.tabs.keys()].pop() || null;
  if (next) activate(next); else { state.active = null; $('#empty').hidden = false; publishFocus(); }
  publishPet();
  if (tab.login) refreshStatus(); // 닫으며 끝낸 로그인 프로세스는 종료 알림을 보내지 않는다 — 로그인을 마쳤을 수 있으니 다시 확인
}

// ───────────────────────── 확인 필요 ─────────────────────────
// 완료·권한 요청·질문처럼 사용자가 봐야 할 것. 켜고 끄는 일은 모두 attend/dismiss 를 거쳐 publishAttention 한 곳으로 나간다.

const EXTERNAL_ATTENTION_MS = 20 * 60000; // 앱 탭이 아닌 세션은 끌 탭이 없다 — 퇴근 규칙(20분)과 같은 시간 뒤 저절로 끈다
const ATTENTION_KEY = {
  done: 'app.attention.done', permission: 'app.attention.permission', notification: 'app.attention.notification', question: 'app.attention.question',
  'collab-question': 'app.attention.collabQuestion', 'collab-idle': 'app.attention.collabIdle', 'collab-error': 'app.attention.collabError',
};
const attentionText = (reason) => (ATTENTION_KEY[reason] ? t(ATTENTION_KEY[reason]) : undefined); // 항목에는 reason 을 두고 문구는 보낼 때 만든다

// 사용자가 그 탭을 보고 있다: 활성 탭이고 창이 보이며 포커스가 있고, 새 탭·펫 그림 대화상자가 닫혀 있다.
function isLooking(tabId) {
  return tabId != null && state.active === tabId && document.visibilityState === 'visible' && document.hasFocus() && !$('#newtab').open && !$('#petpick').open && !$('#agentsdlg').open;
}

function renderDot(tab) {
  tab.dot.className = `dot ${state.attention.has(tab.id) ? 'alert' : tab.status}`;
}

function publishAttention() {
  engine.setAttention([...state.attention.values()]);
  for (const t of state.tabs.values()) renderDot(t);
  publishPet();
}

// 바탕화면 펫에 보낼 상태 — 같은 내용이면 보내지 않는다 (hook 이벤트마다 불린다).
let lastPet = '';
function publishPet() {
  const kinds = Object.fromEntries(AGENT_IDS.map((k) => [k, { working: false, attention: [] }]));
  for (const t of state.tabs.values()) if (t.status === 'working') for (const k of t.kind === 'collab' ? rosterOf(t.agents) : [t.kind]) if (kinds[k]) kinds[k].working = true;
  for (const x of [...state.attention.values()].sort((a, b) => a.at - b.at)) {
    kinds[normAgent(x.cli)].attention.push({ key: x.key, tabId: x.tabId, label: x.label, reason: x.reason, kind: x.kind, text: x.text, at: x.at,
      permId: x.permId ?? null, tool: x.tool ?? '', preview: x.preview ?? '', canAnswer: !!x.canAnswer });
  }
  // 협업 대화: 답변 중인 협업 탭 가운데 말하는 AI 가 가장 최근에 바뀐 탭 기준 (두 캐릭터 상호작용용).
  let best = null;
  for (const t of state.tabs.values()) if (t.kind === 'collab' && t.status === 'working' && (!best || t.collabAt >= best.collabAt)) best = t;
  const collab = best ? { active: true, tabId: best.id, speaker: best.collabSpeaker, turn: best.collabTurn, prev: best.collabPrev, agents: rosterOf(best.agents) } : { active: false };
  // 쓰는 중인 AI: 앱에서 탭을 연 AI (협업 탭은 참여 AI 전부, 로그인 탭은 제외). 탭이 없으면 빈 목록 → 펫 없음.
  const inUse = AGENT_IDS.filter((k) => [...state.tabs.values()].some((t) => !t.login && (t.kind === 'collab' ? rosterOf(t.agents) : [t.kind]).includes(k)));
  const json = JSON.stringify({ kinds, collab, inUse });
  if (json === lastPet) return;
  lastPet = json;
  api.petState?.({ kinds, collab, inUse });
}

const attentionTimers = new Map(); // 외부 세션 key → 자동 해제 타이머 (항목마다 하나만)

function attend(key, entry) {
  if (entry.tabId && isLooking(entry.tabId)) return;
  state.attention.set(key, { ...entry, key, at: Date.now() });
  if (!entry.tabId) {
    clearTimeout(attentionTimers.get(key));
    attentionTimers.set(key, setTimeout(() => dismiss((x) => x.key === key), EXTERNAL_ATTENTION_MS));
  }
  publishAttention();
}

function dismiss(match) {
  let changed = false;
  for (const [k, x] of state.attention) {
    if (!match(x)) continue;
    state.attention.delete(k);
    clearTimeout(attentionTimers.get(k));
    attentionTimers.delete(k);
    changed = true;
  }
  if (changed) publishAttention();
}

const lookedAt = (tabId) => dismiss((x) => x.tabId === tabId);

// hook 이벤트로 켜고 끈다. 탭은 주 세션만 본다 (탭 안에서 실행된 claude -p 등의 완료로 깜빡이지 않게).
// 외부 세션은 답이 필요한 것만 켠다 (VS Code 등에서 턴이 끝날 때마다 깜빡이지 않게).
// 카드로 답할 수 없는 권한 요청의 안내용 한 줄 (명령·파일·주소 등). 문자열인 첫 값만 쓴다. 답할 수 있는 요청은 model.js 의 cardPreview (승인 대상 전체) 를 쓴다.
function permissionPreview(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description']) if (typeof input[k] === 'string') return input[k];
  return '';
}

function noteAttention(tab, ev) {
  const sid = ev.session_id, name = ev.hook_event_name, agentId = ev.agent_id || null;
  if (tab?.kind === 'collab') { if (ev._cli) (tab.cliSession ||= {})[ev._cli] = sid; return; } // 협업 대화는 대화창 상태로 정한다 (Stop 은 턴마다 온다)
  if (tab ? sid !== tab.sessionId : ev._tab === 'login' || !agentById(normAgent(ev._cli))?.caps.externalSessions) return; // 외부 세션은 다른 곳 세션을 받을 수 있는 AI 만
  const key = tab ? tab.id : `ext:${sid}`, prev = state.attention.get(key);
  let reason = null;
  if (name === 'Stop' && !agentId) reason = tab ? 'done' : null;
  else if (name === 'PermissionRequest') reason = prev?.reason === 'question' && ev.tool_name === 'AskUserQuestion' ? '' : 'permission'; // 질문 도구의 권한 요청은 「질문」 그대로
  else if (name === 'Notification' && !NON_BLOCKING_NOTIFICATIONS.has(ev.notification_type)) reason = (prev?.reason === 'permission' || prev?.reason === 'question') && ev.notification_type === 'permission_prompt' ? '' : 'notification'; // 권한 요청·질문 뒤 따라오는 알림
  else if (name === 'PreToolUse' && ev.tool_name === 'AskUserQuestion') reason = 'question';
  if (reason === '') return;
  if (reason) {
    if (!engine.isLive(sid)) return;
    const permId = reason === 'permission' ? ev._permId || null : null;
    const tool = ev.tool_name || '';
    const exact = cardPreview(tool, ev.tool_input); // 카드로 답할 수 있으면 승인 대상 전체 (아니면 null → 안내만)
    const preview = exact ?? permissionPreview(ev.tool_input);
    attend(key, { tabId: tab?.id ?? null, sessionId: sid, agentId: reason === 'done' ? null : agentId, cli: ev._cli || 'claude',
      label: tab?.label || baseName(ev.cwd || ''), reason, kind: reason === 'done' ? 'done' : 'alert', text: attentionText(reason),
      permId, tool, preview, canAnswer: !!permId && !!tab && exact !== null }); // 앱 탭이 아닌 세션은 안내만
    return;
  }
  // 진행 신호: 답을 보냈거나 승인돼 다음 도구로 넘어갔거나 턴이 끝났다 (외부 세션의 Stop — 탭의 Stop 은 위에서 「완료」가 된다).
  // 같은 액터만 — 백그라운드 에이전트의 작업은 팀장 표시를 끄지 않는다.
  if (!prev || prev.sessionId !== sid) return;
  if (name === 'UserPromptSubmit' || name === 'SessionEnd' || (name === 'Stop' && !agentId)
    || ((name === 'PreToolUse' || name === 'SubagentStop') && prev.agentId === agentId)) dismiss((x) => x.key === key);
}

// 협업 대화: AI 가 [질문]했거나, 대화가 끝났거나, 오류로 멈추면 켜고, 사용자가 답을 보내 다시 진행하면 끈다.
function collabAttention(tab, prev, next, agent) {
  if (next === 'running') { lookedAt(tab.id); return; }
  const reason = `collab-${next}`;
  if (prev !== 'running' || !ATTENTION_KEY[reason]) return;
  attend(tab.id, { tabId: tab.id, sessionId: tab.cliSession?.[agent] ?? null, agentId: null, cli: agent || 'claude', label: tab.label,
    reason, kind: next === 'idle' ? 'done' : 'alert', text: attentionText(reason) });
}

// 협업 대화: AI 가 오류·중단으로 끝나면 Stop hook 이 오지 않으니 사무실에 바로 작업 끝으로 알린다 (D-068 — 정상 완료는 실제 Stop hook 이 온다).
function collabSettle(tab, prev, next, agent) {
  if (prev !== 'running' || (next !== 'stopped' && next !== 'error')) return;
  const sid = tab.cliSession?.[agent];
  if (!sid) return;
  engine.settle(sid, t(next === 'stopped' ? 'app.settle.stopped' : 'app.settle.error'));
  updateHeadcount();
}

// 협업 대화에서 말하는 AI 가 바뀜 (null = 아무도 안 말함): 펫이 서로 주고받는 모습을 보이도록 직전 발언자와 차례를 기록한다.
function collabSpeaker(tab, agent) {
  tab.collabSpeaker = agent;
  if (agent) {
    tab.collabPrev = tab.collabLast;
    tab.collabLast = agent;
    tab.collabTurn += 1;
    tab.collabAt = Date.now();
  }
  publishPet();
}

// 창으로 돌아오면(트레이에서 다시 열기 포함) 보고 있는 탭의 「확인 필요」를 끈다.
const lookAgain = () => { if (isLooking(state.active)) lookedAt(state.active); };
window.addEventListener('focus', lookAgain);
document.addEventListener('visibilitychange', lookAgain);
$('#newtab').addEventListener('close', lookAgain);
$('#petpick').addEventListener('close', lookAgain);
$('#agentsdlg').addEventListener('close', lookAgain);

function setTabStatus(tab, status) {
  tab.status = status;
  renderDot(tab);
  publishPet();
  if (state.active === tab.id) publishFocus();
}

function tabForEvent(ev) {
  if (ev._tab && state.tabs.has(ev._tab)) return state.tabs.get(ev._tab);
  for (const t of state.tabs.values()) if (t.sessions.has(ev.session_id)) return t;
  return null;
}

function endTabSessions(tab) {
  for (const sid of tab.sessions) engine.endSession(sid);
  tab.sessions.clear();
  lookedAt(tab.id);
}

function onHookEvent(ev) {
  // 닫은 탭의 늦은 이벤트(Codex hook 은 PowerShell 을 거쳐 늦게 오기도 한다)는 버린다 — 유령 캐릭터·외부 세션 오인 방지.
  if (ev._tab && state.closedTabs.has(ev._tab)) return;
  // 로그인 탭(진입 화면 로그인 터미널 'login' 포함)의 프로세스가 보내는 hook 은 세션·캐릭터로 잡지 않는다.
  if (ev._tab === 'login' || tabForEvent(ev)?.login) return;
  // 붙잡힌 권한 요청이 전역 hook 사본과 겹쳐 두 번째로 온 사본: 엔진·탭 상태는 건드리지 않고 카드 정보(permId)만 갱신한다.
  if (ev._dupHold) { noteAttention(tabForEvent(ev), ev); updateHeadcount(); return; }
  const tab = tabForEvent(ev);
  let label = null;
  if (tab && ev.session_id) {
    if (!tab.sessionId) {
      tab.sessionId = ev.session_id; // 이어받기(복제) 탭은 첫 이벤트에서 세션 ID 를 알게 된다
    } else if (tab.kind !== 'collab' && tab.sessionId !== ev.session_id && ev.hook_event_name === 'SessionStart'
      && (ev.source === 'clear' || ev.source === 'resume' || tab.kind === 'codex')) { // Codex 탭은 하위 세션 없이 /new 등으로만 바뀐다
      engine.endSession(tab.sessionId); // /clear·/resume 로 탭의 대화가 바뀜
      tab.sessions.delete(tab.sessionId);
      tab.sessionId = ev.session_id;
    }
    tab.sessions.add(ev.session_id);
    label = ev.session_id === tab.sessionId ? tab.label : t('app.tab.subSession', { label: tab.label });
    // 협업 대화는 Claude·Codex 두 세션이 한 탭에 있다 — 각각 팀장 캐릭터로 표시하고, 탭 상태는 대화창이 정한다.
    if (tab.kind === 'collab') label = `${tab.label} · ${agentName(normAgent(ev._cli))}`;
  }
  if (tab && tab.kind !== 'collab' && ev.session_id === tab.sessionId) {
    const name = ev.hook_event_name;
    if (name === 'Notification' || name === 'PermissionRequest') {
      setTabStatus(tab, 'idle'); // 답을 기다리는 중 — 눈에 띄는 표시는 「확인 필요」가 맡는다
    } else if (name === 'Stop' || name === 'SessionEnd') {
      setTabStatus(tab, 'idle');
    } else if (!tab.exited) {
      setTabStatus(tab, 'working');
    }
  } else if (!tab && ev._tab !== 'login' && agentById(normAgent(ev._cli))?.caps.externalSessions) { // 외부 세션 목록은 Claude 이어받기용
    const prev = state.external.get(ev.session_id) || {};
    state.external.set(ev.session_id, { sessionId: ev.session_id, cwd: ev.cwd || prev.cwd || '', at: Date.now() });
    if (ev.hook_event_name === 'SessionEnd') state.external.delete(ev.session_id);
    // 새 탭 대화상자는 6시간 안의 세션만 보여 준다 — 그보다 오래된 기록은 지워 끝없이 늘지 않게 한다.
    for (const [sid, x] of state.external) if (Date.now() - x.at > 6 * 3600 * 1000) state.external.delete(sid);
  }
  // 협업 대화의 Codex 는 턴마다 실행·종료되고 Claude 도 모델을 바꿀 때 다시 뜬다 — 그때의 SessionEnd 로 퇴근시키지 않는다 (탭을 닫으면 정리).
  if (tab?.kind === 'collab' && ev.hook_event_name === 'SessionEnd') return;
  // 협업 대화가 AI 에게 보내는 프롬프트에는 진행 규칙·이전 발언이 붙는다 — 사무실에는 사용자의 실제 요청만 보여 준다.
  if (tab?.kind === 'collab' && ev.hook_event_name === 'UserPromptSubmit') ev = { ...ev, prompt: tab.panel.moderator.lastUserText() || ev.prompt };
  engine.handleEvent(ev, { label });
  noteAttention(tab, ev);
  updateHeadcount();
  codePanel.onHookEvent(ev); // 코드 화면의 「건드린 파일」 — 화면이 숨겨져 있어도 모은다
}

api.onHookEvent(onHookEvent);
// 메인이 붙잡은 권한 요청을 풀었다: 카드로 결정했으면(decided) 항목을 지우고, 그 밖(시간 초과·연결 끊김·해제)이면 표시는 남기고 카드는 안내로 바꾼다.
// 렌더러는 보류 해제를 직접 보내지 않는다 — 메인이 펫 상태와 대조해서 푼다.
api.onPermClosed?.(({ permId, how } = {}) => {
  if (typeof permId !== 'string') return;
  if (how === 'decided') { dismiss((x) => x.permId === permId); return; }
  let changed = false;
  for (const [k, x] of state.attention) if (x.permId === permId) { state.attention.set(k, { ...x, permId: null, canAnswer: false }); changed = true; }
  if (changed) publishAttention();
});
api.onPetActivate?.(({ tabId } = {}) => { if (tabId && state.tabs.has(tabId)) activate(tabId); });
api.onPtyData(({ tabId, data }) => {
  if (tabId === 'login') { if (gateTerm) gateTerm.term.write(data); return; }
  if (codePanel.onPtyData(tabId, data)) return;
  const tab = state.tabs.get(tabId);
  if (tab?.term) tab.term.write(data);
});
api.onCollabEvent(({ roomId, agent, ...ev }) => state.tabs.get(roomId)?.panel?.handle(agent, ev));
api.onPtyExit(({ tabId, exitCode }) => {
  if (tabId === 'login') {
    loginRunning = false; // 바꾸거나 끝낸 앞 로그인의 종료 알림은 오지 않는다 (PtyManager) — 이 알림은 지금 로그인의 것
    gateTerm?.term.write(`\r\n\x1b[90m${loginMode === 'install'
      ? t(exitCode === 0 ? 'app.term.gateInstallDone' : 'app.term.gateInstallFail', { code: exitCode })
      : t('app.term.gateLoginExit', { code: exitCode })}\x1b[0m\r\n`);
    refreshStatus();
    return;
  }
  if (codePanel.onPtyExit(tabId, exitCode)) return;
  const tab = state.tabs.get(tabId);
  if (!tab?.term) return;
  tab.exited = true;
  setTabStatus(tab, 'exited');
  tab.term.write(`\r\n\x1b[90m${t('app.term.exited', { what: tab.login ? setupName(tab.login, tab.mode) : kindName(tab.kind), code: exitCode })}\x1b[0m\r\n`);
  endTabSessions(tab);
  if (tab.login) { tab.term.write(`\r\n\x1b[90m${t('app.term.rechecking')}\x1b[0m\r\n`); refreshStatus(); }
});

// ───────────────────────── 새 탭 대화상자 ─────────────────────────

const KIND_HINT_KEY = { claude: 'app.newtab.hintClaude', codex: 'app.newtab.hintCodex', collab: 'app.newtab.hintCollab' };

// 실행 종류 라디오(AI 마다 하나 + 협업)와 협업 참여 체크박스는 처음 한 번만 만든다. 이후에는 disabled·checked·글자만 바꾼다.
function buildKindPick() {
  const radios = new Map();
  const checks = new Map();
  const makeRadio = (value, color = null) => {
    const input = el('input', { type: 'radio', name: 'tab-kind', value });
    const dot = el('span', { class: 'agent-dot', 'aria-hidden': 'true' }); // 진입 화면 AI 목록과 같은 상태 점 (협업은 점 없이 자리만)
    if (color) dot.style.setProperty('--dot', color);
    const text = el('span', {});
    input.addEventListener('change', () => { store.set('ao.tabKind', selectedKind()); renderKindPick(); });
    $('#newtab .kind-pick').append(el('label', {}, dot, input, text));
    return { input, text, dot };
  };
  for (const def of AGENTS) radios.set(def.id, makeRadio(def.id, def.color));
  const collab = makeRadio('collab');
  for (const def of AGENTS) {
    const input = el('input', { type: 'checkbox', name: 'collab-agent', value: def.id });
    const text = el('span', {});
    input.addEventListener('change', () => { store.set('ao.collabAgents', selectedCollabAgents()); renderKindPick(); });
    $('#collab-agents-list').append(el('label', {}, input, text));
    checks.set(def.id, { input, text });
  }
  return { radios, collab, checks };
}
const kindUi = buildKindPick();

function selectedKind() {
  return document.querySelector('input[name="tab-kind"]:checked')?.value || null;
}

// 협업에 참여하도록 체크된 AI (AGENTS 순서)
function selectedCollabAgents() {
  return [...document.querySelectorAll('input[name="collab-agent"]:checked')].map((i) => i.value);
}

// 고른 실행 종류로 지금 폴더를 열 수 있는가: 그 종류가 활성이고, 협업이면 참여 AI 가 2개 이상이며 지원되는 조합이어야 한다.
function canOpenSelected() {
  const kind = selectedKind();
  if (!kind || document.querySelector(`input[name="tab-kind"][value="${kind}"]`)?.disabled !== false) return false;
  if (kind !== 'collab') return true;
  const sel = selectedCollabAgents();
  return collabReady(sel) && collabSupported(sel);
}

function renderKindPick() {
  const list = currentAgents();
  const ids = connectedIds(list);
  const connected = new Set(ids);
  for (const e of list) {
    const r = kindUi.radios.get(e.id);
    r.input.disabled = !connected.has(e.id);
    r.dot.className = `agent-dot state-${e.state}`;
    r.text.textContent = e.state === 'connected' ? e.def.product : `${e.def.product} · ${t(e.state === 'missing' ? 'app.newtab.notInstalled' : e.state === 'error' ? 'app.agents.acctError' : 'app.agents.acctNeedLogin')}`;
    const c = kindUi.checks.get(e.id);
    c.input.disabled = !connected.has(e.id);
    if (!connected.has(e.id)) c.input.checked = false;
    c.text.textContent = e.def.product;
  }
  kindUi.collab.input.disabled = ids.length < 2;
  kindUi.collab.text.textContent = t('app.tab.collabName');
  // 기본 선택: 새 탭 창에서 고른 값 → 진입 화면에서 고른 AI(연결돼 있으면) → 첫 연결 AI
  const saved = store.get('ao.tabKind', null);
  const want = (saved === 'collab' ? !kindUi.collab.input.disabled : connected.has(saved)) ? saved : (connected.has(state.agentPick) ? state.agentPick : (ids[0] ?? null));
  for (const [id, r] of kindUi.radios) r.input.checked = id === want;
  kindUi.collab.input.checked = want === 'collab';
  $('#collab-agents').hidden = want !== 'collab';
  const sel = selectedCollabAgents();
  $('#collab-agents-hint').textContent = !collabReady(sel) ? t('app.newtab.pickTwo')
    : !collabSupported(sel) ? t('app.newtab.collabUnsupported') : '';
  let hint;
  if (ids.length === 0) {
    hint = t('app.newtab.noneConnected', { pill: t('app.agents.connected', { n: 0, total: list.length }) });
  } else {
    hint = KIND_HINT_KEY[want] ? t(KIND_HINT_KEY[want]) : t('app.newtab.hintGeneric', { product: agentById(want).product });
    if (ids.length < list.length) hint += t('app.newtab.moreLogin', { pill: t('app.agents.connected', { n: ids.length, total: list.length }) });
  }
  $('#kind-hint').textContent = hint;
  // 열 수 없는 동안에는 폴더를 여는 버튼을 모두 막는다 (이어받기는 Claude 연결일 때만)
  const ok = canOpenSelected();
  $('#pick-folder').disabled = !ok;
  // 이어받기는 실행 종류와 상관없이 항상 Claude 로 연다 — Claude 연결만 본다
  for (const b of document.querySelectorAll('#recent button, #external button')) b.disabled = b.dataset.resume !== undefined ? !connected.has('claude') : !ok;
}

// 대화상자를 열 때 협업 참여 체크를 정한다: 저장해 둔 것 중 연결된 것, 2개 미만이면 연결된 전부.
function resetCollabChecks() {
  const ids = connectedIds(currentAgents());
  const saved = store.get('ao.collabAgents', []);
  let chosen = Array.isArray(saved) ? ids.filter((id) => saved.includes(id)) : [];
  if (chosen.length < 2) chosen = ids;
  for (const [id, c] of kindUi.checks) c.input.checked = chosen.includes(id);
}

// 탭을 만들기 전에 폴더를 확인한다. 문제가 있으면 팝업으로 알리고 false. 확인 자체가 실패하면 막지 않는다 (탭의 실행 실패 안내가 남아 있다).
let checkingFolder = false;
async function folderOk(cwd) {
  if (checkingFolder) return false; // 연달아 눌러 탭이 두 개 열리지 않게
  checkingFolder = true;
  try {
    const r = await api.codeFolderCheck(cwd).catch(() => null);
    if (!r?.problem) return true;
    showFolderProblem(cwd, r.problem);
    return false;
  } finally {
    checkingFolder = false;
  }
}

function showFolderProblem(cwd, text) {
  $('#folderdlg-text').textContent = text;
  $('#folderdlg-path').textContent = cwd;
  const remove = $('#folderdlg-remove');
  remove.hidden = !store.get('ao.recent', []).includes(cwd);
  remove.onclick = () => {
    store.set('ao.recent', store.get('ao.recent', []).filter((p) => p !== cwd));
    renderRecent();
    renderKindPick();
    $('#folderdlg').close();
  };
  $('#folderdlg').showModal();
}

// 고른 실행 종류로 폴더를 연다. 열 수 없는 상태(버튼이 막히기 전에 눌렸거나 도중에 상태가 바뀜)면 무시한다.
async function openHere(cwd) {
  if (!canOpenSelected() || !(await folderOk(cwd)) || !canOpenSelected()) return;
  const kind = selectedKind();
  const agents = kind === 'collab' ? selectedCollabAgents() : null;
  $('#newtab').close();
  openTab({ cwd, kind, agents });
}

function renderRecent() {
  $('#recent').replaceChildren(...store.get('ao.recent', []).map((p) => el('li', {},
    el('span', { class: 'grow', title: p }, `📁 ${p}`),
    el('button', { type: 'button', class: 'btn small', onclick: () => openHere(p) }, t('app.newtab.open')))));
}

// 다른 곳에서 실행 중인 세션 안내와 목록 (펼침 여부는 건드리지 않고, 보일 세션 수를 돌려준다)
function renderExternal() {
  const g = state.status && state.status.hook && state.status.hook.global;
  const claudeFound = !!currentAgents().find((e) => e.id === 'claude')?.found;
  $('#external-hint').textContent = !claudeFound ? t('app.newtab.extNoClaude')
    : g && g.installed
      ? t('app.newtab.extResume')
      : t('app.newtab.extEnable');
  const since = Date.now() - 6 * 3600 * 1000;
  const ext = [...state.external.values()].filter((x) => x.at > since && x.cwd).sort((a, b) => b.at - a.at).slice(0, 10);
  $('#external').replaceChildren(...ext.map((x) => el('li', {},
    el('span', { class: 'grow', title: x.cwd }, `🖥 ${baseName(x.cwd)} `, el('span', { class: 'sub' }, `${x.cwd} · ${ago(x.at)}`)),
    el('button', { type: 'button', class: 'btn small', onclick: () => openHere(x.cwd) }, t('app.newtab.newHere')),
    el('button', { type: 'button', class: 'btn small', 'data-resume': '', onclick: async () => {
      if (!connectedIds(currentAgents()).includes('claude') || !(await folderOk(x.cwd))) return;
      $('#newtab').close();
      openTab({ cwd: x.cwd, mode: 'resume', resumeId: x.sessionId });
    } }, t('app.newtab.resume')))));
  return ext.length;
}

function openNewTabDialog() {
  const dlg = $('#newtab');
  resetCollabChecks();
  renderRecent();
  $('#newtab-external').open = renderExternal() > 0; // 외부 세션이 있을 때만 펼쳐 둔다
  renderKindPick(); // 폴더 열기 버튼들을 만든 뒤에 불러야 그 버튼들의 disabled 가 맞는다
  dlg.showModal();
}

$('#pick-folder').addEventListener('click', async () => {
  if (!canOpenSelected()) return;
  const p = await api.pickFolder();
  if (!p) return;
  openHere(p);
});
$('#new-tab').addEventListener('click', openNewTabDialog);
$('#empty-new').addEventListener('click', openNewTabDialog);

// ───────────────────────── 펫 그림 선택 ─────────────────────────

const PICK_KINDS = AGENT_IDS;
const PREVIEW_W = 96, PREVIEW_H = 104; // 미리보기 캔버스 CSS 크기 (시트 한 칸 192x208 의 절반)
let petpickGen = 0; // 대화상자를 열고 닫을 때마다 올린다 — 닫은 뒤 늦게 오는 목록·미리보기 결과를 버린다
let petpickSig = ''; // 마지막으로 그린 목록의 모양 — 같으면 선택 표시만 갱신한다
let petpickBusy = false;
let previewTargets = new Map(); // 펫 키 → 그 펫을 그리는 캔버스들 (두 구역에 모두 나온다). 대화상자가 열려 있는 동안만 둔다

const petpickMsg = (text) => { $('#petpick-msg').textContent = text; };

// 정적 마크업에 없는 AI(Claude·Codex 밖)의 펫 그림 구역을 만든다 (메시지 줄 앞에, 시작 때 한 번).
for (const kind of PICK_KINDS) {
  if ($(`#petpick-${kind}`)) continue;
  $('#petpick-msg').before(el('section', {},
    el('h3', {}),
    el('div', { id: `petpick-${kind}`, class: 'petpick-list', role: 'radiogroup' })));
}

// 구역 제목·라벨은 AI 이름이 들어가 사전의 {name} 자리로 쓴다 — 정적 마크업에 있는 Claude·Codex 구역도 함께 (시작 때와 언어가 바뀔 때)
function paintPetpickSections() {
  for (const kind of PICK_KINDS) {
    const list = $(`#petpick-${kind}`);
    const name = agentName(kind);
    list.setAttribute('aria-label', t('app.petpick.sectionLabel', { name }));
    list.closest('section').querySelector('h3').textContent = t('app.petpick.section', { name });
  }
}
paintPetpickSections();

function setPetpickBusy(busy) {
  petpickBusy = busy;
  for (const id of ['#petpick-zip', '#petpick-folder']) $(id).disabled = busy;
  for (const b of document.querySelectorAll('#petpick .petcard-del')) b.disabled = busy; // 가져오는 중에는 삭제도 막는다
}

// 라디오 카드 하나. key 가 있으면 미리보기 캔버스를 달고, user 면 삭제 버튼도 단다. 글은 모두 textContent 로만 들어간다.
function petCard(kind, value, title, sub, key, user) {
  const input = el('input', { type: 'radio', name: `petpick-${kind}`, value });
  input.addEventListener('change', () => { if (input.checked) selectPetArt(kind, value); });
  let art;
  if (key) {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    art = el('canvas', { class: 'petcard-art', width: Math.round(PREVIEW_W * dpr), height: Math.round(PREVIEW_H * dpr) });
    if (!previewTargets.has(key)) previewTargets.set(key, []);
    previewTargets.get(key).push(art);
  } else {
    art = el('div', { class: 'petcard-art petcard-none' }, t(value === 'none' ? 'app.petpick.iconArt' : 'app.petpick.default'));
  }
  const card = el('div', { class: 'petcard' },
    el('label', { class: 'petcard-pick' }, input, art, el('span', { class: 'petcard-name', title }, title), el('span', { class: 'petcard-sub' }, sub)));
  if (user) {
    const del = el('button', { type: 'button', class: 'btn small petcard-del', onclick: () => removePetArt(key, title) }, t('app.petpick.delete'));
    del.disabled = petpickBusy; // 가져오는 중에 새로 그려진 카드도 막는다
    card.append(del);
  }
  return card;
}

// 미리보기: 펫을 하나씩 받아 첫 칸만 그리고 비트맵은 바로 닫는다. 대화상자를 닫거나 목록을 다시 그리면 멈춘다.
async function loadPetPreviews(gen, targets) {
  for (const [key, canvases] of targets) {
    if (gen !== petpickGen || targets !== previewTargets) return;
    try {
      const r = await api.petsPreview(key);
      if (!r?.bytes) continue;
      const bitmap = await createImageBitmap(new Blob([r.bytes], { type: r.type }), 0, 0, 192, 208);
      try {
        if (gen === petpickGen && targets === previewTargets) {
          for (const c of canvases) {
            const ctx = c.getContext('2d');
            ctx.imageSmoothingQuality = 'high';
            ctx.clearRect(0, 0, c.width, c.height);
            ctx.drawImage(bitmap, 0, 0, 192, 208, 0, 0, c.width, c.height);
          }
        }
      } finally { bitmap.close(); }
    } catch { /* 이 펫의 미리보기만 비워 둔다 */ }
  }
}

function renderPetPick(data, gen) {
  const pets = Array.isArray(data?.pets) ? data.pets : [];
  const sig = pets.map((p) => `${p.key}=${p.displayName}`).join('|');
  if (sig !== petpickSig) {
    petpickSig = sig;
    previewTargets = new Map();
    for (const kind of PICK_KINDS) {
      $(`#petpick-${kind}`).replaceChildren(
        petCard(kind, '', t('app.petpick.default'), t('app.petpick.defaultSub'), null, false),
        petCard(kind, 'none', t('app.petpick.iconOnly'), t('app.petpick.iconOnlySub'), null, false),
        ...pets.map((p) => petCard(kind, p.key, p.displayName, t(p.source === 'builtin' ? 'app.petpick.builtin' : 'app.petpick.imported'), p.key, p.source === 'user')));
    }
    loadPetPreviews(gen, previewTargets);
  }
  const values = new Set(['', 'none', ...pets.map((p) => p.key)]);
  for (const kind of PICK_KINDS) {
    // 실제로 쓰이는 그림(resolved)을 기준으로 표시한다: 설정이 null 이고 기본 펫(또는 기본 그림이 아이콘)이면 「기본」, 'none' 이면 「아이콘만」, 그 밖은 그 펫의 카드.
    const raw = data?.selected?.[kind] ?? null;
    const resolved = data?.resolved?.[kind];
    let want;
    if (typeof resolved !== 'string') want = raw === null ? '' : values.has(raw) ? raw : 'none';
    else if (raw === null && (resolved === `builtin:office-${kind}` || resolved === 'none')) want = '';
    else if (resolved === 'none') want = 'none';
    else want = values.has(resolved) ? resolved : 'none';
    for (const r of document.querySelectorAll(`input[name="petpick-${kind}"]`)) r.checked = r.value === want;
  }
}

async function refreshPetPick() {
  const gen = petpickGen;
  let data;
  try { data = await api.petsList(); } catch { if (gen === petpickGen) petpickMsg(t('app.petpick.listFailed')); return; }
  if (gen !== petpickGen || !$('#petpick').open) return;
  renderPetPick(data, gen);
}

async function selectPetArt(kind, value) {
  petpickMsg('');
  try {
    const r = await api.petsSelect(kind, value === '' ? null : value);
    if (r?.ok) return;
    petpickMsg(t('app.petpick.selectFailed'));
  } catch { petpickMsg(t('app.petpick.selectFailed')); }
  await refreshPetPick(); // 화면의 선택을 실제 저장된 값으로 되돌린다
}

// 여러 개를 가져온 결과 한 줄 요약: 성공한 펫 이름과, 실패한 파일·이유.
function importSummary(results) {
  const ok = results.filter((x) => x.ok), bad = results.filter((x) => !x.ok);
  const cut = (s) => String(s || '').slice(0, 80);
  if (results.length === 1) {
    return ok.length ? t('app.petpick.importedOne', { name: cut(ok[0].displayName) }) : cut(bad[0].error) || t('app.petpick.importFailed');
  }
  const parts = [];
  if (ok.length) parts.push(t('app.petpick.importedMany', { count: ok.length, names: `${ok.slice(0, 5).map((x) => `「${cut(x.displayName)}」`).join(', ')}${ok.length > 5 ? t('app.petpick.more') : ''}` }));
  if (bad.length) parts.push(t('app.petpick.failedMany', { count: bad.length, items: `${bad.slice(0, 3).map((x) => `${cut(x.name)} — ${cut(x.error) || t('app.petpick.unknown')}`).join(' / ')}${bad.length > 3 ? t('app.petpick.more') : ''}` }));
  return parts.join(' ');
}

async function importPetArt(kind) {
  if (petpickBusy) return;
  setPetpickBusy(true);
  petpickMsg(t(kind === 'zip' ? 'app.petpick.checkingZip' : 'app.petpick.checkingFolder'));
  try {
    const r = await api.petsImport(kind);
    if (r?.cancelled) petpickMsg('');
    else if (Array.isArray(r?.results)) { petpickMsg(importSummary(r.results)); if (r.results.some((x) => x.ok)) await refreshPetPick(); }
    else petpickMsg(typeof r?.error === 'string' ? r.error.slice(0, 200) : t('app.petpick.importFailed'));
  } catch { petpickMsg(t('app.petpick.importFailed')); } finally { setPetpickBusy(false); }
}

async function removePetArt(key, name) {
  if (petpickBusy || !confirm(t('app.petpick.confirmDelete', { name }))) return;
  try {
    const r = await api.petsRemove(key);
    petpickMsg(r?.ok ? t('app.petpick.deleted', { name }) : t('app.petpick.deleteFailed'));
  } catch { petpickMsg(t('app.petpick.deleteFailed')); }
  await refreshPetPick();
}

$('#pet-art').addEventListener('click', async () => {
  const dlg = $('#petpick');
  if (dlg.open || !api.petsList) return;
  petpickGen++;
  petpickSig = '';
  petpickMsg('');
  setPetpickBusy(false);
  dlg.showModal();
  await refreshPetPick();
});
$('#petpick').addEventListener('close', () => {
  petpickGen++; // 늦게 오는 결과를 버린다
  petpickSig = '';
  previewTargets = new Map(); // 미리보기 캔버스는 열려 있는 동안만 둔다
  for (const kind of PICK_KINDS) $(`#petpick-${kind}`).replaceChildren();
});
$('#petpick-zip').addEventListener('click', () => importPetArt('zip'));
$('#petpick-folder').addEventListener('click', () => importPetArt('folder'));
api.onPetsChanged?.(() => { if ($('#petpick').open) refreshPetPick(); });

// ───────────────────────── 언어 전환 ─────────────────────────
// 창을 새로고침하지 않는다 (메인이 터미널·협업을 정리한다). 오래 보이는 화면을 새 언어로 다시 그린다.
// initLang 의 정적 문구(applyStatic) 알림이 먼저 등록돼 있어, 아래는 그 뒤에 실행된다.
// 활동 기록에 쌓인 줄·말풍선 같은 잠깐 보이는 글은 그대로 두고 다음 갱신 때 바뀐다.
function repaintLang() {
  syncMainLang();
  fillThemeOptions();
  renderTopbar();
  renderGate();
  paintGateTitle();
  if ($('#agentsdlg').open) syncAgentsDialog(false);
  updateAgentPanels();
  if ($('#newtab').open) { renderRecent(); renderExternal(); } // 목록 버튼을 새로 만들었으니 renderKindPick 이 막힘 여부를 다시 맞춘다
  renderKindPick();
  relabelTabs();
  for (const [k, x] of state.attention) state.attention.set(k, { ...x, text: attentionText(x.reason) ?? x.text, label: state.tabs.get(x.tabId)?.label ?? x.label });
  publishAttention(); // 사무실 말풍선과 펫이 새 언어 문구를 받는다
  publishFocus();
  paintPetpickSections();
  if ($('#petpick').open) { petpickSig = ''; refreshPetPick(); } // 카드 글자를 새 언어로 다시 그린다
  displayedMenu = null; // 상호작용 메뉴·사무실 상태줄은 아래 notify 가 새 글자로 다시 그린다
  if (state.entered) { view.lastState = null; view.notify(); }
}
onLangChange(repaintLang);

// ───────────────────────── 시작 ─────────────────────────

renderThemes();
renderGate(); // 첫 그림부터 현재 언어의 「확인 중」 안내
refreshStatus();
publishFocus(); // 새로 고친 화면이 첫 포커스(탭 없음)를 한 번 알린다 — 메인이 dropSessions 로 비운 상태와 맞춘다
