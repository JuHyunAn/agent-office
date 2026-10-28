// 협업 대화 탭 화면: 나 · Claude · Codex 가 한 대화창에서 실시간으로 주고받는다.
import { Moderator, NAMES, OWNERS, MODEL_OPTIONS, EFFORT_OPTIONS, EFFORT_LABEL, MODEL_LABEL } from './moderator.js';
import { toolPhrase } from '../office/phrases.js';

const STATUS_TEXT = {
  idle: '대기 중 — 메시지를 보내면 대화가 시작됩니다',
  running: '답변 중',
  question: '❓ AI 가 질문했습니다 — 답을 보내면 이어서 진행합니다',
  stopped: '⏸ 중단됨 — 메시지를 보내면 이어서 진행합니다',
  error: '⚠ 오류 — 메시지를 보내면 다시 시도합니다',
};
const TARGETS = [{ value: 'all', label: '모두에게' }, { value: 'claude', label: 'Claude 에게' }, { value: 'codex', label: 'Codex 에게' }];

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

// 선택지를 채우고, 고르던 값이 새 선택지에 없으면 첫 항목(자동)으로 돌린다. 실제로 고른 값을 돌려준다.
function fill(s, options, value) {
  s.replaceChildren(...options.map((o) => node('option', { value: o.value, title: o.title || null }, o.label)));
  s.value = options.some((o) => o.value === value) ? value : options[0].value;
  return s.value;
}

function select(options, value, onchange, label) {
  const s = node('select', { 'aria-label': label, onchange: () => onchange(s.value) });
  fill(s, options, value);
  return s;
}

const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);

export function createCollabPanel({ api, roomId, cwd, onStatus = () => {} }) {
  let frame = 0;
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); }); };
  const mod = new Moderator({
    send: (agent, text, choice, turn) => api.collabSend({ roomId, agent, cwd, text, turn, ...choice }),
    stop: (agent) => api.collabStop(roomId, agent),
    onChange: schedule,
  });

  const status = node('span', { class: 'collab-status', role: 'status' });
  const catalogNote = node('span', { class: 'collab-catalog' });
  const stopBtn = node('button', { type: 'button', class: 'collab-stop', title: '진행 중인 답변을 멈춥니다', onclick: () => mod.halt() }, '■ 중단');
  const autoBox = node('input', { type: 'checkbox', checked: true, onchange: () => { mod.auto = autoBox.checked; } });
  // 모델·단계 선택지: 각 CLI 가 알려 준 목록이 도착하면 그것으로 바꾼다 (받기 전·실패 시 기본 선택지).
  const AUTO = { value: 'auto', label: '자동' };
  const modelOptions = (agent) => (mod.catalog[agent] ? [AUTO, ...mod.catalog[agent].map((m) => ({ value: m.value, label: m.label, title: m.description }))] : MODEL_OPTIONS[agent]);
  const effortOptions = (agent) => {
    const list = mod.catalog[agent];
    if (!list) return EFFORT_OPTIONS;
    const model = mod.prefs[agent].model;
    const levels = model === 'auto' ? [...new Set(list.flatMap((m) => m.efforts))] : list.find((m) => m.value === model)?.efforts || [];
    return [AUTO, ...levels.map((e) => ({ value: e, label: EFFORT_LABEL[e] || e }))];
  };
  const prefSelects = {};
  const syncEfforts = (agent) => { mod.prefs[agent].effort = fill(prefSelects[agent].effort, effortOptions(agent), mod.prefs[agent].effort); };
  const agentPrefs = (agent) => {
    const model = select(MODEL_OPTIONS[agent], 'auto', (v) => { mod.prefs[agent].model = v; syncEfforts(agent); }, `${NAMES[agent]} 모델`);
    const effort = select(EFFORT_OPTIONS, 'auto', (v) => { mod.prefs[agent].effort = v; }, `${NAMES[agent]} 추론 단계`);
    prefSelects[agent] = { model, effort };
    return node('span', { class: `collab-agent collab-${agent}` }, node('b', {}, NAMES[agent]), model, effort);
  };
  const labelOf = (agent, model) => mod.catalog[agent]?.find((m) => m.value === model)?.label || MODEL_LABEL[model] || model;
  const header = node('div', { class: 'collab-head' },
    node('div', { class: 'collab-row' },
      node('label', {}, '구현 담당 ', select(OWNERS, mod.owner, (v) => { mod.owner = v; }, '구현 담당')),
      node('label', { title: '끄면 지정한 상대만 한 번 답하고 멈춥니다' }, autoBox, ' 자동 대화 이어가기'),
      node('span', { class: 'spacer' }), stopBtn),
    node('div', { class: 'collab-row collab-models' }, agentPrefs('claude'), agentPrefs('codex')),
    node('div', { class: 'collab-row collab-sub' }, status, catalogNote, node('span', { class: 'collab-cwd', title: cwd }, cwd)));

  const log = node('div', { class: 'collab-log', role: 'log', 'aria-live': 'polite' });
  const target = select(TARGETS, 'all', () => {}, '받는 사람');
  const input = node('textarea', { rows: 3, placeholder: '메시지 입력 · Enter 보내기 · Shift+Enter 줄바꿈 · @claude / @codex 로 지정 · 대화 중에도 끼어들 수 있어요' });
  const submit = () => {
    let text = input.value.trim();
    if (!text) return;
    let to = target.value;
    const m = text.match(/^@(claude|codex)\b\s*/i);
    if (m) { to = m[1].toLowerCase(); text = text.slice(m[0].length) || text; }
    input.value = '';
    mod.say(text, to);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  const composer = node('div', { class: 'collab-compose' }, target, input, node('button', { type: 'button', class: 'btn primary', onclick: submit }, '보내기'));
  const root = node('div', { class: 'collab' }, header, log, composer);

  const nodes = [];
  function messageNode(m) {
    const meta = m.model ? [labelOf(m.from, m.model), m.effort && (EFFORT_LABEL[m.effort] || m.effort)].filter(Boolean).join(' · ') : '';
    const tools = (m.tools || []).slice(-6).map((t) => node('li', {}, toolPhrase(t.name, t.input) || t.name));
    return node('div', { class: `msg from-${m.from}${m.streaming ? ' streaming' : ''}` },
      node('div', { class: 'msg-head' }, node('b', {}, NAMES[m.from] || m.from), meta ? node('span', { class: 'msg-meta' }, meta) : null,
        m.target && m.target !== 'all' ? node('span', { class: 'msg-meta' }, `→ ${NAMES[m.target]}`) : null,
        node('time', {}, hhmm(m.at))),
      tools.length ? node('ul', { class: 'msg-tools' }, tools) : null,
      node('div', { class: 'msg-body' }, m.text || (m.streaming ? '생각 중…' : '(내용 없음)')));
  }
  function render() {
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    mod.messages.forEach((m, i) => {
      const key = `${m.text.length}/${m.tools?.length || 0}/${m.streaming ? 1 : 0}`;
      if (nodes[i]?.key === key) return;
      const n = messageNode(m);
      if (nodes[i]) nodes[i].el.replaceWith(n); else log.append(n);
      nodes[i] = { el: n, key };
    });
    status.textContent = mod.status === 'running' ? `${NAMES[mod.running]} ${STATUS_TEXT.running}…` : STATUS_TEXT[mod.status];
    status.className = `collab-status ${mod.status}`;
    stopBtn.disabled = mod.status !== 'running';
    if (atBottom) log.scrollTop = log.scrollHeight;
    onStatus(mod.status);
  }
  render();

  // 목록을 받기 전·실패 시에는 기본 선택지를 쓰고 그 사실을 알린다. 못 받은 쪽은 선택 상자를 열 때 다시 시도한다.
  let loading = null;
  function loadCatalog() {
    if (loading || (mod.catalog.claude && mod.catalog.codex)) return;
    catalogNote.textContent = '모델 목록 불러오는 중…'; catalogNote.title = '';
    loading = Promise.resolve(api.collabModels?.()).then((catalog) => {
      for (const agent of ['claude', 'codex']) {
        if (!catalog?.[agent]?.length) continue;
        mod.catalog[agent] = catalog[agent];
        mod.prefs[agent].model = fill(prefSelects[agent].model, modelOptions(agent), mod.prefs[agent].model);
        syncEfforts(agent);
      }
      return catalog?.errors || {};
    }, (e) => ({ claude: e?.message || String(e), codex: e?.message || String(e) })).then((errors) => {
      loading = null;
      const missing = ['claude', 'codex'].filter((a) => !mod.catalog[a]);
      catalogNote.textContent = missing.length ? `⚠ ${missing.map((a) => NAMES[a]).join('·')} 모델 목록을 받지 못해 기본 선택지 사용 — 선택 상자를 열면 다시 시도` : '';
      catalogNote.title = missing.map((a) => `${NAMES[a]}: ${errors[a] || '알 수 없음'}`).join('\n');
    });
  }
  for (const agent of ['claude', 'codex']) prefSelects[agent].model.addEventListener('focus', loadCatalog);
  loadCatalog();

  return {
    root, moderator: mod,
    handle: (agent, ev) => mod.handle(agent, ev),
    focus: () => input.focus(),
    running: () => mod.status === 'running',
  };
}
