// 화면 조립: 진입(로그인) → 왼쪽 사무실(항상 표시) + 오른쪽 Claude Code 탭.
import { OfficeEngine, NON_BLOCKING_NOTIFICATIONS } from './office/engine.js';
import { OfficeView } from './office/view.js';
import { baseName } from './office/phrases.js';
import { THEMES, getTheme } from './themes/index.js';
import { createCollabPanel } from './collab/panel.js';
import { setupCliResizer } from './layout.js';
import { cardPreview } from './pet/model.js';

const api = window.office;
const $ = (sel) => document.querySelector(sel);

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
  return m < 1 ? '방금' : m < 60 ? `${m}분 전` : `${Math.floor(m / 60)}시간 전`;
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
};

let theme = getTheme(store.get('ao.theme', 'pixel-office'));
const engine = new OfficeEngine(theme.layout, { onFeed: addFeed, now: () => performance.now(), timing: { leadIdleToRestMs: 20000 } });
const view = new OfficeView($('#office'), engine, theme, { tooltip: $('#tooltip'), onState({ zoom, minZoom, playerTask, headcount, environment, interactionMenu, heldItem }) {
  $('#zoom-level').textContent = `${zoom}%`;
  $('#zoom-out').disabled = zoom <= minZoom;
  $('#player-state').textContent = playerTask || '사무실을 둘러보세요';
  $('#headcount').textContent = `에이전트 ${headcount}명`;
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
  panel.append(el('div', { class: 'menu-heading' }, el('h3', { id: 'interaction-title' }, '커피 · 음료'),
    el('button', { class: 'menu-close', type: 'button', 'aria-label': '음료 선택 닫기', onclick: () => view.closeInteractionMenu() }, '×')),
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

let gateTerm = null;
let loginCli = 'claude'; // 진입 화면 로그인 터미널이 마지막으로 띄운 로그인 (claude · codex)
let statusLoading = null; // 진행 중인 상태 확인 — 겹쳐 부르면 같은 결과를 기다린다
let statusAgain = false; // 확인 중에 다시 불렸으면 끝난 뒤 한 번 더 (로그인 직후 옛 결과가 남지 않게)

function refreshStatus() {
  if (statusLoading) { statusAgain = true; return statusLoading; }
  statusLoading = (async () => {
    try {
      state.status = await api.status();
    } catch (e) {
      state.status = { error: String(e && e.message || e) };
    }
    renderGate();
    renderTopbar();
    publishPet();
    renderCodexAccount();
    if ($('#newtab').open) renderKindPick();
  })().finally(() => {
    statusLoading = null;
    if (statusAgain) { statusAgain = false; refreshStatus(); }
  });
  return statusLoading;
}

// 진입 화면의 Codex(ChatGPT) 줄 — 입장하기가 있는 화면(Claude 로그인 뒤)에만 붙는다. 선택 사항이라 입장은 막지 않는다.
function codexGateRow(st) {
  const ca = st.codexAuth;
  const row = el('div', { class: 'gate-codex' });
  const recheck = el('button', { class: 'btn', onclick: refreshStatus }, '다시 확인');
  if (!st.codex) {
    row.append(
      el('p', { class: 'hint' }, 'Codex(ChatGPT) — 설치되어 있지 않습니다 (선택 사항 · Codex 탭·협업 대화에 필요)'),
      el('div', { class: 'gate-row' },
        el('button', { class: 'btn', onclick: () => api.openExternal('https://developers.openai.com/codex/cli') }, '설치 안내'), recheck));
  } else if (ca?.loggedIn) {
    row.append(el('p', { class: 'gate-account' }, `✅ Codex · ${ca.email || ca.methodLabel || '로그인됨'}${ca.plan ? ` · ${ca.plan} 플랜` : ''}`));
  } else if (ca?.error) {
    row.append(el('p', {}, 'Codex(ChatGPT) — 상태를 확인하지 못했습니다'), el('p', { class: 'err' }, ca.error), recheck);
  } else {
    row.append(
      el('p', {}, 'Codex(ChatGPT) — 로그인되어 있지 않습니다 (선택 사항)'),
      el('div', { class: 'gate-row' }, el('button', { class: 'btn', onclick: () => startLogin('codex') }, 'Codex 로그인'), recheck));
  }
  return row;
}

// Claude 로그인 전 화면의 Codex 상태 한 줄 (같은 터미널에서 두 로그인이 부딪히지 않게 버튼은 두지 않는다)
function codexGateHint(st) {
  const ca = st.codexAuth;
  const text = !st.codex ? '설치되어 있지 않음 (선택 사항)'
    : ca?.loggedIn ? `✅ ${ca.email || ca.methodLabel || '로그인됨'}`
      : ca?.error ? '상태를 확인하지 못했습니다'
        : '로그인 필요 (Claude 로그인 뒤 할 수 있습니다)';
  return el('p', { class: 'hint' }, `Codex(ChatGPT): ${text}`);
}

function renderGate() {
  const body = $('#gate-body');
  body.replaceChildren();
  const st = state.status;
  if (!st) { body.append('Claude Code 확인 중…'); return; }
  if (st.error) {
    body.append(el('p', { class: 'err' }, st.error), el('button', { class: 'btn', onclick: refreshStatus }, '다시 확인'));
    return;
  }
  if (!st.claude) {
    body.append(
      el('p', {}, 'Claude Code 가 설치되어 있지 않습니다. 아래 명령으로 설치한 뒤 다시 확인해 주세요.'),
      el('code', {}, 'npm install -g @anthropic-ai/claude-code'),
      el('div', { class: 'gate-row' },
        el('button', { class: 'btn', onclick: () => api.openExternal('https://code.claude.com/docs/en/setup') }, '설치 안내 열기'),
        el('button', { class: 'btn primary', onclick: refreshStatus }, '다시 확인')),
      codexGateHint(st),
    );
    return;
  }
  if (!st.auth || !st.auth.loggedIn) {
    body.append(
      el('p', {}, `Claude Code ${st.claude.version || ''} 이(가) 설치되어 있습니다. Claude 계정으로 로그인해 주세요.`),
      el('p', { class: 'hint' }, '로그인은 공식 Claude Code 가 진행합니다 (브라우저가 열립니다).'),
      el('div', { class: 'gate-row' },
        el('button', { class: 'btn primary', onclick: () => startLogin('claude') }, 'Claude 로그인'),
        el('button', { class: 'btn', onclick: refreshStatus }, '다시 확인')),
      st.auth && st.auth.error ? el('p', { class: 'err' }, st.auth.error) : null,
      codexGateHint(st),
    );
    return;
  }
  const a = st.auth;
  body.append(
    el('p', { class: 'gate-account' }, `✅ ${a.email || '로그인됨'}${a.subscriptionType ? ` · ${a.subscriptionType} 플랜` : ''}`),
    el('p', { class: 'hint' }, `Claude Code ${st.claude.version || ''} · VS Code 등에서 쓰는 로그인과 같은 계정입니다.`),
    el('button', { class: 'btn primary', onclick: enter }, '입장하기'),
    codexGateRow(st),
  );
}

// 진입 화면 로그인 터미널 (cli: claude · codex). 터미널은 하나라 이전 출력을 지우고 새로 시작한다.
async function startLogin(cli = 'claude') {
  loginCli = cli;
  const host = $('#gate-term');
  host.hidden = false;
  if (!gateTerm) {
    gateTerm = newTerminal();
    gateTerm.term.open(host);
    gateTerm.term.onData((d) => api.writePty('login', d));
  }
  gateTerm.term.reset();
  gateTerm.fit.fit();
  try {
    await api.createPty({ tabId: 'login', mode: 'login', cli, cols: gateTerm.term.cols, rows: gateTerm.term.rows });
  } catch (e) {
    gateTerm.term.write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`);
  }
}

async function enter() {
  state.entered = true;
  $('#gate').hidden = true;
  if (gateTerm) api.killPty('login'); // 입장 뒤 보이지 않는 로그인 프로세스를 남기지 않는다
  try {
    await view.start();
  } catch (e) {
    addFeed({ text: `테마 「${theme.name}」 불러오기 실패 — 기본 테마로 바꿉니다: ${e.message}` });
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

function renderTopbar() {
  const st = state.status;
  if (st?.pet?.mode) $('#pet-mode').value = st.pet.mode;
  const acc = $('#account');
  if (st && st.auth && st.auth.loggedIn) {
    acc.textContent = `● ${st.auth.email || '로그인됨'}${st.auth.subscriptionType ? ` · ${st.auth.subscriptionType}` : ''}`;
    acc.className = 'pill on';
  } else {
    acc.textContent = '로그인 필요';
    acc.className = 'pill warn';
  }
  const btn = $('#global-hooks');
  const g = st && st.hook && st.hook.global;
  if (!g) { btn.textContent = '다른 세션 보기: -'; return; }
  if (g.error) { btn.textContent = '다른 세션 보기: 설정 오류'; btn.className = 'pill pill-btn warn'; btn.title = g.error; return; }
  if (needsReconnect(g)) {
    btn.textContent = '다른 세션 보기: 다시 연결 필요';
    btn.className = 'pill pill-btn warn';
    btn.title = '사용자 설정의 hook 주소가 지금 앱과 다릅니다 (포트 또는 앱 설정 변경). 눌러서 다시 연결하세요.';
  } else {
    btn.textContent = `다른 세션 보기: ${g.installed ? '켜짐' : '꺼짐'}`;
    btn.className = `pill pill-btn ${g.installed ? 'on' : ''}`;
    btn.title = 'VS Code·터미널 등 다른 곳의 Claude Code 세션도 사무실에 표시';
  }
}

function needsReconnect(g) {
  return g.installed && (g.portMatches === false || g.tokenMatches === false);
}

// 상단 Codex(ChatGPT) 계정 칸 — Codex 를 찾았을 때만 보인다. 선택 사항이라 로그인이 없어도 막지 않는다.
function renderCodexAccount() {
  const st = state.status;
  const btn = $('#codex-account');
  const ca = st?.codexAuth;
  btn.hidden = !st?.codex;
  if (btn.hidden) return;
  if (ca?.loggedIn) {
    btn.textContent = `● Codex · ${ca.email || ca.methodLabel || '로그인됨'}${ca.plan ? ` · ${ca.plan}` : ''}`;
    btn.className = 'pill pill-btn on';
    btn.title = `${btn.textContent.slice(2)} — 눌러서 다시 확인`; // 칸이 잘려도 전체 계정을 볼 수 있게
  } else if (ca?.error) {
    btn.textContent = '⚠ Codex 상태 확인 실패';
    btn.className = 'pill pill-btn warn';
    btn.title = ca.error;
  } else {
    btn.textContent = 'Codex 로그인 필요';
    btn.className = 'pill pill-btn warn';
    btn.title = '눌러서 Codex(ChatGPT) 로그인 탭 열기';
  }
}

$('#codex-account').addEventListener('click', () => {
  const st = state.status;
  const ca = st?.codexAuth;
  const needLogin = !!st?.codex && !ca?.loggedIn && !ca?.error;
  if (needLogin && state.entered) { openCodexLogin(); return; }
  if (needLogin && st.auth?.loggedIn) { startLogin('codex'); return; } // 진입 전에는 Claude 로그인이 끝났을 때만
  $('#codex-account').textContent = 'Codex 확인 중…';
  refreshStatus();
});

$('#global-hooks').addEventListener('click', async () => {
  const g = state.status && state.status.hook && state.status.hook.global;
  if (!g) return;
  const enable = !g.installed || needsReconnect(g);
  try {
    const r = await api.setGlobalHooks(enable);
    state.status.hook.global = r.global;
    if (!r.cancelled) addFeed({ text: enable ? '사용자 설정에 hook 을 추가했습니다 (백업 저장됨)' : '사용자 설정에서 hook 을 제거했습니다' });
  } catch (e) {
    addFeed({ text: `hook 설정 실패: ${e.message}` });
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
    addFeed({ text: `펫 설정 실패: ${err.message}` });
  }
});
api.onPetMode?.(({ mode } = {}) => { if (state.status) state.status.pet = { mode }; $('#pet-mode').value = mode || 'always'; });

function renderThemes() {
  const sel = $('#theme-select');
  sel.replaceChildren(...THEMES.map((t) => el('option', { value: t.id }, t.name)));
  sel.value = theme.id;
  sel.addEventListener('change', async () => {
    const next = getTheme(sel.value);
    try {
      if (!(await view.setTheme(next))) return; // 그 사이 다른 테마를 골랐다
      theme = next;
      store.set('ao.theme', theme.id); // 불러오기에 성공한 테마만 기억한다
    } catch (e) {
      sel.value = theme.id;
      addFeed({ text: `테마 「${next.name}」 불러오기 실패: ${e.message}` });
    }
  });
}

function updateHeadcount() {
  const n = engine.snapshot().filter((a) => a.status !== 'leaving').length;
  $('#headcount').textContent = `에이전트 ${n}명`;
}

// ───────────────────────── 활동 피드 ─────────────────────────

function addFeed(item) {
  const ul = $('#feed');
  ul.prepend(el('li', {}, el('time', {}, hhmm()), item.text));
  while (ul.children.length > 5) ul.lastChild.remove();
}

// ───────────────────────── 탭 ─────────────────────────

function uniqueLabel(base) {
  const names = new Set([...state.tabs.values()].map((t) => t.label));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} #${i}`)) return `${base} #${i}`;
}

const KIND_NAME = { claude: 'Claude Code', codex: 'Codex', collab: '협업 대화' };
const KIND_PREFIX = { claude: '', codex: 'Codex · ', collab: '협업 · ' };

// kind: claude(공식 Claude Code 화면) · codex(공식 Codex 화면) · collab(Claude + Codex 협업 대화)
// login: 입장 뒤 Codex(ChatGPT) 로그인 탭 — 폴더 없이 홈 폴더에서 공식 codex login 을 띄운다.
async function openTab({ cwd, mode = 'new', resumeId = null, kind = 'claude', login = false }) {
  const id = `t${Date.now().toString(36)}${(state.seq++).toString(36)}`;
  const label = uniqueLabel(login ? 'Codex 로그인' : `${KIND_PREFIX[kind]}${baseName(cwd) || cwd}`);
  const pane = el('div', { class: 'pane' });
  $('#panes').append(pane);
  const dot = el('span', { class: 'dot' });
  const btn = el('button', { class: `tab kind-${kind}`, title: login ? 'Codex 로그인 (공식 codex login)' : `${KIND_NAME[kind]} · ${cwd}`, onclick: () => activate(id) },
    dot, el('span', { class: 'name' }, label),
    el('span', { class: 'close', title: '탭 닫기', onclick: (e) => { e.stopPropagation(); closeTab(id); } }, '×'));
  $('#tabs').append(btn);
  if (!login) store.set('ao.recent', [cwd, ...store.get('ao.recent', []).filter((p) => p !== cwd)].slice(0, 8));

  // sessions: 이 탭에서 나온 모든 세션 (탭 안에서 실행한 중첩 claude 포함) — 탭을 닫을 때 함께 정리한다.
  const tab = { id, kind, label, cwd, mode, login, sessionId: null, sessions: new Set(), term: null, fit: null, panel: null, pane, btn, dot, status: 'idle', exited: false,
    collabSpeaker: null, collabLast: null, collabPrev: null, collabTurn: 0, collabAt: 0 };
  state.tabs.set(id, tab);
  // 탭 영역(터미널·대화창)을 클릭하거나 포커스가 들어오면 「확인 필요」를 끈다.
  pane.addEventListener('focusin', () => lookedAt(id));
  pane.addEventListener('pointerdown', () => lookedAt(id));
  if (kind === 'collab') {
    pane.classList.add('pane-collab');
    // 작업 상태는 전이 알림(동기)으로도 정한다 — 창이 숨겨져 렌더가 멈춰도 펫이 협업 진행을 바로 알게.
    tab.panel = createCollabPanel({ api, roomId: id, cwd, onStatus: (s) => setTabStatus(tab, s === 'running' ? 'working' : 'idle'), onTransition: (prev, next, agent) => { setTabStatus(tab, next === 'running' ? 'working' : 'idle'); collabAttention(tab, prev, next, agent); }, onSpeaker: (agent) => collabSpeaker(tab, agent) });
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
    term.write(`\x1b[31m실행 실패: ${e.message}\x1b[0m\r\n`);
  }
}

// 입장 뒤 Codex 로그인: 이미 열린 로그인 탭이 있으면 그 탭으로, 없으면 일반 탭으로 연다.
function openCodexLogin() {
  const open = [...state.tabs.values()].find((t) => t.login && !t.exited);
  if (open) activate(open.id);
  else openTab({ kind: 'codex', mode: 'login', login: true });
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

async function closeTab(id) {
  const tab = state.tabs.get(id);
  if (!tab) return;
  const what = tab.login ? 'Codex 로그인' : tab.kind === 'collab' ? '협업 대화(Claude·Codex)' : `${KIND_NAME[tab.kind]} 세션`;
  if (!tab.exited && !window.confirm(`「${tab.label}」 탭을 닫으면 그 ${what}도 종료됩니다. 닫을까요?`)) return;
  state.tabs.delete(id);
  state.closedTabs.add(id);
  if (state.closedTabs.size > 200) state.closedTabs.delete(state.closedTabs.values().next().value); // 오래 켜 둬도 끝없이 늘지 않게
  if (tab.panel) await api.collabClose(id);
  else { await api.killPty(id); tab.term.dispose(); }
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
const ATTENTION_TEXT = {
  done: '✅ 답변 완료', permission: '❓ 권한 확인', notification: '❓ 확인이 필요합니다', question: '❓ 선택을 기다려요',
  'collab-question': '❓ 질문이 있어요', 'collab-idle': '✅ 대화 완료', 'collab-error': '⚠ 오류 — 확인 필요',
};

// 사용자가 그 탭을 보고 있다: 활성 탭이고 창이 보이며 포커스가 있고, 새 탭·펫 그림 대화상자가 닫혀 있다.
function isLooking(tabId) {
  return tabId != null && state.active === tabId && document.visibilityState === 'visible' && document.hasFocus() && !$('#newtab').open && !$('#petpick').open;
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
  const kinds = { claude: { working: false, attention: [] }, codex: { working: false, attention: [] } };
  for (const t of state.tabs.values()) if (t.status === 'working') for (const k of t.kind === 'collab' ? ['claude', 'codex'] : [t.kind]) if (kinds[k]) kinds[k].working = true;
  for (const x of [...state.attention.values()].sort((a, b) => a.at - b.at)) {
    kinds[x.cli === 'codex' ? 'codex' : 'claude'].attention.push({ key: x.key, tabId: x.tabId, label: x.label, reason: x.reason, kind: x.kind, text: x.text, at: x.at,
      permId: x.permId ?? null, tool: x.tool ?? '', preview: x.preview ?? '', canAnswer: !!x.canAnswer });
  }
  // 협업 대화: 답변 중인 협업 탭 가운데 말하는 AI 가 가장 최근에 바뀐 탭 기준 (두 캐릭터 상호작용용).
  let best = null;
  for (const t of state.tabs.values()) if (t.kind === 'collab' && t.status === 'working' && (!best || t.collabAt >= best.collabAt)) best = t;
  const collab = best ? { active: true, tabId: best.id, speaker: best.collabSpeaker, turn: best.collabTurn, prev: best.collabPrev } : { active: false };
  const json = JSON.stringify({ kinds, collab });
  if (json === lastPet) return;
  lastPet = json;
  api.petState?.({ kinds, collab });
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
  if (tab ? sid !== tab.sessionId : ev._tab === 'login' || ev._cli === 'codex') return;
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
      label: tab?.label || baseName(ev.cwd || ''), reason, kind: reason === 'done' ? 'done' : 'alert', text: ATTENTION_TEXT[reason],
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
  if (prev !== 'running' || !ATTENTION_TEXT[reason]) return;
  attend(tab.id, { tabId: tab.id, sessionId: tab.cliSession?.[agent] ?? null, agentId: null, cli: agent || 'claude', label: tab.label,
    reason, kind: next === 'idle' ? 'done' : 'alert', text: ATTENTION_TEXT[reason] });
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
    label = ev.session_id === tab.sessionId ? tab.label : `${tab.label} · 하위`;
    // 협업 대화는 Claude·Codex 두 세션이 한 탭에 있다 — 각각 팀장 캐릭터로 표시하고, 탭 상태는 대화창이 정한다.
    if (tab.kind === 'collab') label = `${tab.label} · ${ev._cli === 'codex' ? 'Codex' : 'Claude'}`;
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
  } else if (!tab && ev._tab !== 'login' && ev._cli !== 'codex') { // 외부 세션 목록은 Claude 이어받기용
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
  const tab = state.tabs.get(tabId);
  if (tab?.term) tab.term.write(data);
});
api.onCollabEvent(({ roomId, agent, ...ev }) => state.tabs.get(roomId)?.panel?.handle(agent, ev));
api.onPtyExit(({ tabId, exitCode }) => {
  if (tabId === 'login') {
    gateTerm?.term.write(`\r\n\x1b[90m[로그인 터미널 종료 · 코드 ${exitCode}] 상태를 다시 확인합니다\x1b[0m\r\n`);
    refreshStatus();
    return;
  }
  const tab = state.tabs.get(tabId);
  if (!tab?.term) return;
  tab.exited = true;
  setTabStatus(tab, 'exited');
  tab.term.write(`\r\n\x1b[90m[${KIND_NAME[tab.kind]} 종료 · 코드 ${exitCode}] 탭을 닫거나 ＋ 로 새로 여세요.\x1b[0m\r\n`);
  endTabSessions(tab);
  if (tab.login) { tab.term.write('\r\n\x1b[90m상태를 다시 확인합니다…\x1b[0m\r\n'); refreshStatus(); }
});

// ───────────────────────── 새 탭 대화상자 ─────────────────────────

const KIND_HINT = {
  claude: '공식 Claude Code 화면을 엽니다.',
  codex: '공식 Codex 화면을 엽니다. 처음 여는 폴더는 Codex 가 신뢰 여부를 묻습니다.',
  collab: 'Claude 와 Codex 가 한 대화창에서 의견을 주고받습니다. Bypass 모드로 실행되며(확인 없이 파일 수정·명령 실행), 언제든 끼어들거나 중단할 수 있습니다.',
};

function selectedKind() {
  return document.querySelector('input[name="tab-kind"]:checked')?.value || 'claude';
}

function renderKindPick() {
  const hasCodex = !!state.status?.codex;
  const want = hasCodex ? store.get('ao.tabKind', 'claude') : 'claude';
  for (const r of document.querySelectorAll('input[name="tab-kind"]')) {
    r.disabled = r.value !== 'claude' && !hasCodex;
    r.checked = r.value === want;
  }
  $('#kind-hint').textContent = hasCodex ? KIND_HINT[selectedKind()]
    : `${KIND_HINT.claude} Codex 를 찾지 못해 Codex·협업 대화는 쓸 수 없습니다 (Codex 앱 또는 npm install -g @openai/codex 설치 후 앱을 다시 실행).`;
  // Codex 가 필요한 종류(Codex·협업)인데 로그인이 확인되지 않았다 — 열기는 막지 않고 로그인 탭만 안내한다.
  const needCodexLogin = hasCodex && !state.status?.codexAuth?.loggedIn && selectedKind() !== 'claude';
  $('#kind-login').hidden = !needCodexLogin;
  if (needCodexLogin) $('#kind-hint').textContent += ' Codex 로그인이 확인되지 않았습니다 — 로그인하지 않았으면 Codex 화면이 로그인을 요구하고 협업 대화의 Codex 차례는 오류가 납니다.';
}

for (const r of document.querySelectorAll('input[name="tab-kind"]')) {
  r.addEventListener('change', () => { store.set('ao.tabKind', selectedKind()); renderKindPick(); });
}

function openNewTabDialog() {
  const dlg = $('#newtab');
  const recent = $('#recent');
  renderKindPick();
  recent.replaceChildren(...store.get('ao.recent', []).map((p) => el('li', {},
    el('span', { class: 'grow', title: p }, `📁 ${p}`),
    el('button', { type: 'button', class: 'btn small', onclick: () => { dlg.close(); openTab({ cwd: p, kind: selectedKind() }); } }, '열기'))));

  const g = state.status && state.status.hook && state.status.hook.global;
  $('#external-hint').textContent = g && g.installed
    ? '이어받기는 기존 대화를 복제해 새 세션으로 이어 갑니다 (원래 세션은 그대로).'
    : '상단 「다른 세션 보기」를 켜면 VS Code·터미널에서 실행 중인 세션이 여기에 나타납니다.';
  const since = Date.now() - 6 * 3600 * 1000;
  const ext = [...state.external.values()].filter((x) => x.at > since && x.cwd).sort((a, b) => b.at - a.at).slice(0, 10);
  $('#external').replaceChildren(...ext.map((x) => el('li', {},
    el('span', { class: 'grow', title: x.cwd }, `🖥 ${baseName(x.cwd)} `, el('span', { class: 'sub' }, `${x.cwd} · ${ago(x.at)}`)),
    el('button', { type: 'button', class: 'btn small', onclick: () => { dlg.close(); openTab({ cwd: x.cwd, kind: selectedKind() }); } }, '이 폴더에서 새 세션'),
    el('button', { type: 'button', class: 'btn small', onclick: () => { dlg.close(); openTab({ cwd: x.cwd, mode: 'resume', resumeId: x.sessionId }); } }, '이어받기(복제)'))));
  dlg.showModal();
}

$('#pick-folder').addEventListener('click', async () => {
  const p = await api.pickFolder();
  if (!p) return;
  $('#newtab').close();
  openTab({ cwd: p, kind: selectedKind() });
});
$('#kind-login-btn').addEventListener('click', () => { $('#newtab').close(); openCodexLogin(); });
$('#new-tab').addEventListener('click', openNewTabDialog);
$('#empty-new').addEventListener('click', openNewTabDialog);

// ───────────────────────── 펫 그림 선택 ─────────────────────────

const PICK_KINDS = ['claude', 'codex'];
const PREVIEW_W = 96, PREVIEW_H = 104; // 미리보기 캔버스 CSS 크기 (시트 한 칸 192x208 의 절반)
let petpickGen = 0; // 대화상자를 열고 닫을 때마다 올린다 — 닫은 뒤 늦게 오는 목록·미리보기 결과를 버린다
let petpickSig = ''; // 마지막으로 그린 목록의 모양 — 같으면 선택 표시만 갱신한다
let petpickBusy = false;
let previewTargets = new Map(); // 펫 키 → 그 펫을 그리는 캔버스들 (두 구역에 모두 나온다). 대화상자가 열려 있는 동안만 둔다

const petpickMsg = (text) => { $('#petpick-msg').textContent = text; };

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
    art = el('div', { class: 'petcard-art petcard-none' }, value === 'none' ? '아이콘' : '기본');
  }
  const card = el('div', { class: 'petcard' },
    el('label', { class: 'petcard-pick' }, input, art, el('span', { class: 'petcard-name', title }, title), el('span', { class: 'petcard-sub' }, sub)));
  if (user) {
    const del = el('button', { type: 'button', class: 'btn small petcard-del', onclick: () => removePetArt(key, title) }, '삭제');
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
        petCard(kind, '', '기본', '앱 기본 그림', null, false),
        petCard(kind, 'none', '아이콘만', '그림 없이 아이콘', null, false),
        ...pets.map((p) => petCard(kind, p.key, p.displayName, p.source === 'builtin' ? '기본 제공' : '가져옴', p.key, p.source === 'user')));
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
  try { data = await api.petsList(); } catch { if (gen === petpickGen) petpickMsg('펫 목록을 읽지 못했습니다'); return; }
  if (gen !== petpickGen || !$('#petpick').open) return;
  renderPetPick(data, gen);
}

async function selectPetArt(kind, value) {
  petpickMsg('');
  try {
    const r = await api.petsSelect(kind, value === '' ? null : value);
    if (r?.ok) return;
    petpickMsg('선택하지 못했습니다');
  } catch { petpickMsg('선택하지 못했습니다'); }
  await refreshPetPick(); // 화면의 선택을 실제 저장된 값으로 되돌린다
}

// 여러 개를 가져온 결과 한 줄 요약: 성공한 펫 이름과, 실패한 파일·이유.
function importSummary(results) {
  const ok = results.filter((x) => x.ok), bad = results.filter((x) => !x.ok);
  const cut = (s) => String(s || '').slice(0, 80);
  if (results.length === 1) {
    return ok.length ? `「${cut(ok[0].displayName)}」 펫을 가져왔습니다. 위 목록에서 골라 주세요.` : cut(bad[0].error) || '펫을 가져오지 못했습니다';
  }
  const parts = [];
  if (ok.length) parts.push(`${ok.length}개 펫을 가져왔습니다 (${ok.slice(0, 5).map((x) => `「${cut(x.displayName)}」`).join(', ')}${ok.length > 5 ? ' 외' : ''}). 위 목록에서 골라 주세요.`);
  if (bad.length) parts.push(`${bad.length}개 실패: ${bad.slice(0, 3).map((x) => `${cut(x.name)} — ${cut(x.error) || '알 수 없음'}`).join(' / ')}${bad.length > 3 ? ' 외' : ''}`);
  return parts.join(' ');
}

async function importPetArt(kind) {
  if (petpickBusy) return;
  setPetpickBusy(true);
  petpickMsg(kind === 'zip' ? 'zip 파일을 확인하는 중…' : '폴더를 확인하는 중…');
  try {
    const r = await api.petsImport(kind);
    if (r?.cancelled) petpickMsg('');
    else if (Array.isArray(r?.results)) { petpickMsg(importSummary(r.results)); if (r.results.some((x) => x.ok)) await refreshPetPick(); }
    else petpickMsg(typeof r?.error === 'string' ? r.error.slice(0, 200) : '펫을 가져오지 못했습니다');
  } catch { petpickMsg('펫을 가져오지 못했습니다'); } finally { setPetpickBusy(false); }
}

async function removePetArt(key, name) {
  if (petpickBusy || !confirm(`「${name}」 펫을 삭제할까요?\n이 펫을 고른 종류는 기본 그림으로 돌아갑니다.`)) return;
  try {
    const r = await api.petsRemove(key);
    petpickMsg(r?.ok ? `「${name}」 펫을 삭제했습니다` : '삭제하지 못했습니다');
  } catch { petpickMsg('삭제하지 못했습니다'); }
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

// ───────────────────────── 시작 ─────────────────────────

renderThemes();
refreshStatus();
publishFocus(); // 새로 고친 화면이 첫 포커스(탭 없음)를 한 번 알린다 — 메인이 dropSessions 로 비운 상태와 맞춘다
