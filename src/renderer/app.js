// 화면 조립: 진입(로그인) → 왼쪽 사무실(항상 표시) + 오른쪽 Claude Code 탭.
import { OfficeEngine } from './office/engine.js';
import { OfficeView } from './office/view.js';
import { baseName } from './office/phrases.js';
import { THEMES, getTheme } from './themes/index.js';
import { createCollabPanel } from './collab/panel.js';
import { setupCliResizer } from './layout.js';

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

async function refreshStatus() {
  try {
    state.status = await api.status();
  } catch (e) {
    state.status = { error: String(e && e.message || e) };
  }
  renderGate();
  renderTopbar();
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
    );
    return;
  }
  if (!st.auth || !st.auth.loggedIn) {
    body.append(
      el('p', {}, `Claude Code ${st.claude.version || ''} 이(가) 설치되어 있습니다. Claude 계정으로 로그인해 주세요.`),
      el('p', { class: 'hint' }, '로그인은 공식 Claude Code 가 진행합니다 (브라우저가 열립니다).'),
      el('div', { class: 'gate-row' },
        el('button', { class: 'btn primary', onclick: startLogin }, 'Claude 로그인'),
        el('button', { class: 'btn', onclick: refreshStatus }, '다시 확인')),
      st.auth && st.auth.error ? el('p', { class: 'err' }, st.auth.error) : null,
    );
    return;
  }
  const a = st.auth;
  body.append(
    el('p', { class: 'gate-account' }, `✅ ${a.email || '로그인됨'}${a.subscriptionType ? ` · ${a.subscriptionType} 플랜` : ''}`),
    el('p', { class: 'hint' }, `Claude Code ${st.claude.version || ''} · VS Code 등에서 쓰는 로그인과 같은 계정입니다.`),
    el('button', { class: 'btn primary', onclick: enter }, '입장하기'),
  );
}

async function startLogin() {
  const host = $('#gate-term');
  host.hidden = false;
  if (!gateTerm) {
    gateTerm = newTerminal();
    gateTerm.term.open(host);
    gateTerm.term.onData((d) => api.writePty('login', d));
  }
  gateTerm.fit.fit();
  try {
    await api.createPty({ tabId: 'login', mode: 'login', cols: gateTerm.term.cols, rows: gateTerm.term.rows });
  } catch (e) {
    gateTerm.term.write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`);
  }
}

async function enter() {
  state.entered = true;
  $('#gate').hidden = true;
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

function renderThemes() {
  const sel = $('#theme-select');
  sel.replaceChildren(...THEMES.map((t) => el('option', { value: t.id }, t.name)));
  sel.value = theme.id;
  sel.addEventListener('change', async () => {
    const next = getTheme(sel.value);
    try {
      await view.setTheme(next);
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
async function openTab({ cwd, mode = 'new', resumeId = null, kind = 'claude' }) {
  const id = `t${Date.now().toString(36)}${(state.seq++).toString(36)}`;
  const label = uniqueLabel(`${KIND_PREFIX[kind]}${baseName(cwd) || cwd}`);
  const pane = el('div', { class: 'pane' });
  $('#panes').append(pane);
  const dot = el('span', { class: 'dot' });
  const btn = el('button', { class: `tab kind-${kind}`, title: `${KIND_NAME[kind]} · ${cwd}`, onclick: () => activate(id) },
    dot, el('span', { class: 'name' }, label),
    el('span', { class: 'close', title: '탭 닫기', onclick: (e) => { e.stopPropagation(); closeTab(id); } }, '×'));
  $('#tabs').append(btn);
  store.set('ao.recent', [cwd, ...store.get('ao.recent', []).filter((p) => p !== cwd)].slice(0, 8));

  // sessions: 이 탭에서 나온 모든 세션 (탭 안에서 실행한 중첩 claude 포함) — 탭을 닫을 때 함께 정리한다.
  const tab = { id, kind, label, cwd, mode, sessionId: null, sessions: new Set(), term: null, fit: null, panel: null, pane, btn, dot, status: 'idle', exited: false };
  state.tabs.set(id, tab);
  if (kind === 'collab') {
    pane.classList.add('pane-collab');
    tab.panel = createCollabPanel({ api, roomId: id, cwd, onStatus: (s) => setTabStatus(tab, s === 'running' ? 'working' : s === 'question' ? 'alert' : 'idle') });
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
    if (tab.status === 'alert' && !tab.panel) setTabStatus(tab, 'idle');
    requestAnimationFrame(() => { fitTab(tab); if (tab.panel) tab.panel.focus(); else tab.term.focus(); });
  }
}

async function closeTab(id) {
  const tab = state.tabs.get(id);
  if (!tab) return;
  const what = tab.kind === 'collab' ? '협업 대화(Claude·Codex)' : `${KIND_NAME[tab.kind]} 세션`;
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
  if (next) activate(next); else { state.active = null; $('#empty').hidden = false; }
}

function setTabStatus(tab, status) {
  tab.status = status;
  tab.dot.className = `dot ${status}`;
}

function tabForEvent(ev) {
  if (ev._tab && state.tabs.has(ev._tab)) return state.tabs.get(ev._tab);
  for (const t of state.tabs.values()) if (t.sessions.has(ev.session_id)) return t;
  return null;
}

function endTabSessions(tab) {
  for (const sid of tab.sessions) engine.endSession(sid);
  tab.sessions.clear();
}

function onHookEvent(ev) {
  // 닫은 탭의 늦은 이벤트(Codex hook 은 PowerShell 을 거쳐 늦게 오기도 한다)는 버린다 — 유령 캐릭터·외부 세션 오인 방지.
  if (ev._tab && state.closedTabs.has(ev._tab)) return;
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
      setTabStatus(tab, 'alert');
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
  updateHeadcount();
}

api.onHookEvent(onHookEvent);
api.onPtyData(({ tabId, data }) => {
  if (tabId === 'login') { if (gateTerm) gateTerm.term.write(data); return; }
  const tab = state.tabs.get(tabId);
  if (tab?.term) tab.term.write(data);
});
api.onCollabEvent(({ roomId, agent, ...ev }) => state.tabs.get(roomId)?.panel?.handle(agent, ev));
api.onPtyExit(({ tabId, exitCode }) => {
  if (tabId === 'login') { refreshStatus(); return; }
  const tab = state.tabs.get(tabId);
  if (!tab?.term) return;
  tab.exited = true;
  setTabStatus(tab, 'exited');
  tab.term.write(`\r\n\x1b[90m[${KIND_NAME[tab.kind]} 종료 · 코드 ${exitCode}] 탭을 닫거나 ＋ 로 새로 여세요.\x1b[0m\r\n`);
  endTabSessions(tab);
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
$('#new-tab').addEventListener('click', openNewTabDialog);
$('#empty-new').addEventListener('click', openNewTabDialog);

// ───────────────────────── 시작 ─────────────────────────

renderThemes();
refreshStatus();
