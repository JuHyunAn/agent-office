// 협업 대화 탭 화면: 나 · Claude · Codex 가 한 대화창에서 실시간으로 주고받는다.
import { Moderator, inputMode, isEmptyReply, NAMES, OWNERS, MODEL_OPTIONS, EFFORT_OPTIONS, EFFORT_LABEL, MODEL_LABEL } from './moderator.js';
import { toolPhrase } from '../office/phrases.js';

const STATUS_TEXT = {
  idle: '대기 중 — 메시지를 보내면 대화가 시작됩니다',
  running: '답변 중',
  question: '❓ AI 가 질문했습니다 — 답을 보내면 이어서 진행합니다',
  stopped: '⏸ 중단됨 — 메시지를 보내면 이어서 진행합니다',
  error: '⚠ 오류 — 메시지를 보내면 다시 시도합니다',
};
// 화면에는 최근 메시지만 그린다 — 한 탭에서 오래 대화해도 화면 요소가 끝없이 늘지 않게. (AI 에게 보내는 내용과는 무관)
const FOLD = 50;
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

// 입력창 버튼 아이콘 — Heroicons(MIT) 20 solid, Claude Code 입력창과 같은 모양.
const STOP_D = 'M5.25 3A2.25 2.25 0 0 0 3 5.25v9.5A2.25 2.25 0 0 0 5.25 17h9.5A2.25 2.25 0 0 0 17 14.75v-9.5A2.25 2.25 0 0 0 14.75 3h-9.5Z';
const SEND_D = 'M10 17a.75.75 0 0 1-.75-.75V5.612L5.29 9.77a.75.75 0 0 1-1.08-1.04l5.25-5.5a.75.75 0 0 1 1.08 0l5.25 5.5a.75.75 0 1 1-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0 1 10 17Z';
function svgIcon(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d); path.setAttribute('fill', 'currentColor'); path.setAttribute('fill-rule', 'evenodd'); path.setAttribute('clip-rule', 'evenodd');
  svg.append(path);
  return svg;
}

export function createCollabPanel({ api, roomId, cwd, onStatus = () => {}, onTransition = () => {}, onSpeaker = () => {} }) {
  let frame = 0, last = 'idle', lastRunning = null;
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); }); };
  const mod = new Moderator({
    send: (agent, text, choice, turn) => api.collabSend({ roomId, agent, cwd, text, turn, ...choice }),
    stop: (agent) => api.collabStop(roomId, agent),
    steer: (agent, text, turn) => api.collabSteer(roomId, agent, text, turn),
    onChange: () => { changed(); schedule(); },
  });

  // 상태가 바뀐 순간을 바로 알린다 — 렌더(requestAnimationFrame)는 창이 숨겨지면 멈추므로 거기에 묶지 않는다.
  function changed() {
    if (mod.running !== lastRunning) { lastRunning = mod.running; onSpeaker(mod.running); } // 말하는 AI 가 바뀜 (null = 아무도 안 말함)
    if (mod.status === last) return;
    const prev = last;
    last = mod.status;
    onTransition(prev, mod.status, mod.status === 'question' ? mod.asker : mod.lastSpeaker);
  }

  const status = node('span', { class: 'collab-status', role: 'status' });
  const catalogNote = node('span', { class: 'collab-catalog' });
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
      node('span', { class: 'spacer' })),
    node('div', { class: 'collab-row collab-models' }, agentPrefs('claude'), agentPrefs('codex')),
    node('div', { class: 'collab-row collab-sub' }, status, catalogNote, node('span', { class: 'collab-cwd', title: cwd }, cwd)));

  const log = node('div', { class: 'collab-log', role: 'log', 'aria-live': 'polite', tabindex: '-1' });
  const target = select(TARGETS, 'all', () => {}, '받는 사람');
  const input = node('textarea', { rows: 3, placeholder: '메시지 입력 · Enter 보내기 · Shift+Enter 줄바꿈 · Esc 중단 · @claude / @codex 로 지정 · 답변 중에 보내면 지금 답변에 반영해요 (Codex 는 하던 작업이 끝난 지점에서)' });
  const submit = () => {
    let text = input.value.trim();
    if (!text) return;
    let to = target.value;
    const m = text.match(/^@(claude|codex)\b\s*/i);
    if (m) { to = m[1].toLowerCase(); text = text.slice(m[0].length) || text; }
    input.value = '';
    mod.say(text, to);
    syncSend();
  };
  // 버튼 하나: 글이 있으면 보내기, 답변 중에 비어 있으면 중단 (Claude Code 입력창과 같은 동작).
  const sendBtn = node('button', {
    type: 'button', class: 'collab-send',
    onclick: () => { if (inputMode(input.value, mod.status) === 'stop') mod.halt(); else submit(); input.focus(); },
  });
  let sendMode = null;
  function syncSend() {
    const mode = inputMode(input.value, mod.status);
    if (mode !== sendMode) { sendMode = mode; sendBtn.replaceChildren(svgIcon(mode === 'stop' ? STOP_D : SEND_D)); }
    sendBtn.classList.toggle('stop', mode === 'stop');
    sendBtn.disabled = mode === 'idle';
    const label = mode === 'stop' ? '중단 (Esc)' : '보내기 (Enter)';
    sendBtn.setAttribute('aria-label', label); sendBtn.title = label;
  }
  input.addEventListener('input', syncSend);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  const composer = node('div', { class: 'collab-compose' }, target, input, sendBtn);
  const root = node('div', { class: 'collab' }, header, log, composer);
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.isComposing && mod.status === 'running') { e.preventDefault(); e.stopPropagation(); mod.halt(); input.focus(); }
  });

  const nodes = [];
  let shown = FOLD, first = 0; // first: 화면에 그린 첫 메시지 위치
  const more = node('button', { type: 'button', class: 'collab-more', hidden: true, onclick: () => { shown += FOLD; schedule(); } });
  log.append(more);
  function messageNode(m) {
    const meta = m.model ? [labelOf(m.from, m.model), m.effort && (EFFORT_LABEL[m.effort] || m.effort)].filter(Boolean).join(' · ') : '';
    const tools = (m.tools || []).slice(-6).map((t) => node('li', {}, toolPhrase(t.name, t.input) || t.name));
    const choices = (m.question?.choices || []).map((c) => node('button', {
      type: 'button', class: 'msg-choice', title: `${c.name}${c.desc ? ` — ${c.desc}` : ''}`, onclick: () => choose(m, c),
    }, node('b', {}, c.name), c.desc ? node('span', {}, c.desc) : null));
    const final = m.from === 'claude' || m.from === 'codex' ? node('span', { class: 'msg-final', hidden: !m.final }, '최종 답변') : null; // 합의되면 나중에 나타난다
    const pending = m.from === 'user' ? node('span', { class: 'msg-pending', hidden: !m.steering }, '반영 대기 중') : null; // 답변 중에 보냈고 아직 반영 확인 전
    const el = node('div', { class: `msg from-${m.from}${m.streaming ? ' streaming' : ''}`, hidden: !!m.skip || isEmptyReply(m) },
      node('div', { class: 'msg-head' }, node('b', {}, NAMES[m.from] || m.from), final, pending, meta ? node('span', { class: 'msg-meta' }, meta) : null,
        m.target && m.target !== 'all' ? node('span', { class: 'msg-meta' }, `→ ${NAMES[m.target]}`) : null,
        node('time', {}, hhmm(m.at))),
      tools.length ? node('ul', { class: 'msg-tools' }, tools) : null,
      node('div', { class: 'msg-body' }, m.text || (m.streaming ? '생각 중…' : '')),
      choices.length ? node('div', { class: 'msg-choices', role: 'group', 'aria-label': '선택지' }, choices) : null);
    return { el, choices, final, pending };
  }
  // 선택지 버튼: 답을 기다리는 질문의 것만 눌린다. 다시 그리지 않고 disabled 만 맞춘다 (다시 그리면 포커스·화면 읽기가 끊긴다).
  function syncChoices(m, entry) {
    const off = !mod.isActiveQuestion(m);
    for (const b of entry.choices) if (b.disabled !== off) b.disabled = off;
  }
  // 최종 답변 표시: 합의는 메시지가 그려진 뒤에 정해지므로 다시 그리지 않고 상태만 맞춘다.
  function syncFinal(m, entry) {
    const on = !!m.final;
    if (entry.final.hidden === on) entry.final.hidden = !on;
    if (entry.el.classList.contains('final') !== on) entry.el.classList.toggle('final', on);
  }
  // 반영 대기 표시: 받았다는 확인은 메시지가 그려진 뒤에 오므로 다시 그리지 않고 상태만 맞춘다.
  function syncPending(m, entry) {
    if (entry.pending.hidden !== !m.steering) entry.pending.hidden = !m.steering;
  }
  function choose(m, c) {
    if (!mod.isActiveQuestion(m)) return;
    mod.say(`선택: ${c.name}`, m.from);
    input.focus();
  }
  const keyOf = (m) => `${m.text.length}/${m.tools?.length || 0}/${m.streaming ? 1 : 0}`;
  function render() {
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const start = Math.max(0, mod.messages.length - shown), expanded = start < first;
    if (expanded) {
      // 더 펼치면 새로 드러난 메시지만 맨 위에 끼워 넣고, 읽던 위치를 그대로 둔다.
      const added = document.createDocumentFragment(), before = log.scrollHeight;
      for (let i = start; i < first; i++) { const m = mod.messages[i], n = messageNode(m); added.append(n.el); nodes[i] = { ...n, key: keyOf(m) }; }
      more.after(added);
      log.scrollTop += log.scrollHeight - before;
    } else for (let i = first; i < start; i++) { nodes[i]?.el.remove(); nodes[i] = null; }
    first = start;
    if (!start && document.activeElement === more) log.focus({ preventScroll: true }); // 마지막으로 펼쳐 버튼이 사라져도 포커스가 대화창에 남게
    more.hidden = !start;
    const moreText = `이전 대화 ${start}개 접힘 · ${Math.min(FOLD, start)}개 더 보기`;
    if (more.textContent !== moreText) more.textContent = moreText; // 같은 문구를 다시 쓰면 화면 읽기 프로그램이 반복해 읽는다
    for (let i = start; i < mod.messages.length; i++) {
      const m = mod.messages[i];
      const key = keyOf(m);
      if (nodes[i]?.key !== key) {
        const n = messageNode(m);
        if (nodes[i]) nodes[i].el.replaceWith(n.el); else log.append(n.el);
        nodes[i] = { ...n, key };
      }
      if (nodes[i].choices.length) syncChoices(m, nodes[i]);
      if (nodes[i].final) syncFinal(m, nodes[i]);
      if (nodes[i].pending) syncPending(m, nodes[i]);
    }
    const askers = mod.status === 'running' && mod.round.askers.length ? ` · ${mod.round.askers.map((a) => NAMES[a]).join('·')} 질문 있음` : '';
    const agreed = mod.status === 'idle' && mod.round.final;
    status.textContent = (mod.status === 'running' ? `${NAMES[mod.running]} ${STATUS_TEXT.running}…` : agreed ? '두 AI 합의 완료 — 최종 답변 표시를 확인하세요' : STATUS_TEXT[mod.status]) + askers;
    status.className = `collab-status ${mod.status}`;
    if (atBottom && !expanded) log.scrollTop = log.scrollHeight; // 펼친 직후에는 드러난 메시지를 보여 준다
    onStatus(mod.status);
    syncSend();
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
