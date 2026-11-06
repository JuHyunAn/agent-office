// 협업 대화 탭 화면: 나 · 참여 AI(기본 Claude · Codex)가 한 대화창에서 실시간으로 주고받는다.
import { Moderator, inputMode, isEmptyReply, rosterOf, nameOf, ownerOptions, targetsOf, mentionOf, agreedText, placeholderOf, effortLevels, AUTO_OPTION, MODEL_OPTIONS, EFFORT_OPTIONS, EFFORT_IN_MODEL, EFFORT_LABEL, MODEL_LABEL } from './moderator.js';
import { agentById } from '../../shared/agents.js';
import { toolPhrase } from '../office/phrases.js';
import { t, onLangChange } from '../../shared/i18n.js';

const STATUS_KEY = {
  idle: 'collab.status.idle',
  question: 'collab.status.question',
  stopped: 'collab.status.stopped',
  error: 'collab.status.error',
};
// 화면에는 최근 메시지만 그린다 — 한 탭에서 오래 대화해도 화면 요소가 끝없이 늘지 않게. (AI 에게 보내는 내용과는 무관)
const FOLD = 50;
// Claude·Codex 는 기존 CSS 색(.collab-claude 등)을 쓰고, 그 밖의 AI 는 레지스트리 색을 --agent-color 로 넘긴다.
const isBuiltinColor = (id) => id === 'claude' || id === 'codex';

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

// agents: 참여 AI id 배열 (2명 이상이면 그대로, 아니면 Claude·Codex)
export function createCollabPanel({ api, roomId, cwd, agents = null, onStatus = () => {}, onTransition = () => {}, onSpeaker = () => {} }) {
  let frame = 0, last = 'idle', lastRunning = null;
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); }); };
  const mod = new Moderator({
    send: (agent, text, choice, turn) => api.collabSend({ roomId, agent, cwd, text, turn, roster: mod.roster, ...choice }),
    stop: (agent) => api.collabStop(roomId, agent),
    steer: (agent, text, turn) => api.collabSteer(roomId, agent, text, turn),
    onChange: () => { changed(); schedule(); },
    roster: rosterOf(agents),
  });
  const roster = mod.roster; // 진행자가 검증·동결한 참여자 하나만 쓴다

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
  const modelOptions = (agent) => (mod.catalog[agent] ? [AUTO_OPTION, ...mod.catalog[agent].map((m) => ({ value: m.value, label: m.label, title: m.description }))] : MODEL_OPTIONS[agent] || [AUTO_OPTION]);
  const effortOptions = (agent) => {
    const list = mod.catalog[agent];
    if (!list) return EFFORT_IN_MODEL.has(agent) ? [AUTO_OPTION] : EFFORT_OPTIONS;
    return [AUTO_OPTION, ...effortLevels(list, mod.prefs[agent].model).map((e) => ({ value: e, label: EFFORT_LABEL[e] || e }))];
  };
  const prefSelects = {};
  // 단계 선택지가 「자동」 하나뿐이면(Gemini 처럼 단계가 모델 이름에 들어 있는 경우) 상자를 숨긴다. 모델 변경·목록 도착 모두 이 함수를 거친다.
  const syncEfforts = (agent) => {
    const options = effortOptions(agent);
    mod.prefs[agent].effort = fill(prefSelects[agent].effort, options, mod.prefs[agent].effort);
    prefSelects[agent].effort.hidden = options.length === 1;
  };
  const agentPrefs = (agent) => {
    const model = select(modelOptions(agent), 'auto', (v) => { mod.prefs[agent].model = v; syncEfforts(agent); }, t('collab.aria.model', { name: nameOf(agent) }));
    const firstEfforts = effortOptions(agent);
    const effort = select(firstEfforts, 'auto', (v) => { mod.prefs[agent].effort = v; }, t('collab.aria.effort', { name: nameOf(agent) }));
    effort.hidden = firstEfforts.length === 1;
    prefSelects[agent] = { model, effort };
    const own = !isBuiltinColor(agent) && agentById(agent)?.color; // Claude·Codex 외 AI 의 색
    return node('span', { class: `collab-agent collab-${agent}${own ? ' collab-agent-x' : ''}`, style: own ? `--agent-color: ${own}` : null }, node('b', {}, nameOf(agent)), model, effort);
  };
  const labelOf = (agent, model) => mod.catalog[agent]?.find((m) => m.value === model)?.label || MODEL_LABEL[model] || model;
  const ownerText = document.createTextNode(`${t('collab.owner.label')} `);
  const ownerSelect = select(ownerOptions(roster), mod.owner, (v) => { mod.owner = v; }, t('collab.owner.label'));
  const autoText = document.createTextNode(` ${t('collab.autoContinue.label')}`);
  const autoLabel = node('label', { title: t('collab.autoContinue.title') }, autoBox, autoText);
  const header = node('div', { class: 'collab-head' },
    node('div', { class: 'collab-row' },
      node('label', {}, ownerText, ownerSelect),
      autoLabel,
      node('span', { class: 'spacer' })),
    node('div', { class: `collab-row collab-models${roster.length >= 3 ? ' collab-models-wrap' : ''}` }, roster.map((agent) => agentPrefs(agent))),
    node('div', { class: 'collab-row collab-sub' }, status, catalogNote, node('span', { class: 'collab-cwd', title: cwd }, cwd)));

  const log = node('div', { class: 'collab-log', role: 'log', 'aria-live': 'polite', tabindex: '-1' });
  const target = select(targetsOf(roster), 'all', () => {}, t('collab.target.label'));
  const input = node('textarea', { rows: 3, placeholder: placeholderOf(roster) });
  const submit = () => {
    let text = input.value.trim();
    if (!text) return;
    let to = target.value;
    const m = mentionOf(roster, text);
    if (m) { to = m.to; text = m.text; }
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
    const label = t(mode === 'stop' ? 'collab.send.stop' : 'collab.send.send');
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
    const final = mod.roster.includes(m.from) ? node('span', { class: 'msg-final', hidden: !m.final }, t('collab.msg.final')) : null; // 합의되면 나중에 나타난다
    const pending = m.from === 'user' ? node('span', { class: 'msg-pending', hidden: !m.steering }, t('collab.msg.pending')) : null; // 답변 중에 보냈고 아직 반영 확인 전
    const own = mod.roster.includes(m.from) && !isBuiltinColor(m.from) && agentById(m.from)?.color; // Claude·Codex 외 AI 의 색
    const el = node('div', { class: `msg from-${m.from}${own ? ' from-agent' : ''}${m.streaming ? ' streaming' : ''}`, style: own ? `--agent-color: ${own}` : null, hidden: !!m.skip || isEmptyReply(m) },
      node('div', { class: 'msg-head' }, node('b', {}, nameOf(m.from)), final, pending, meta ? node('span', { class: 'msg-meta' }, meta) : null,
        m.target && m.target !== 'all' ? node('span', { class: 'msg-meta' }, `→ ${nameOf(m.target)}`) : null,
        node('time', {}, hhmm(m.at))),
      tools.length ? node('ul', { class: 'msg-tools' }, tools) : null,
      node('div', { class: 'msg-body' }, m.text || (m.streaming ? t('collab.msg.thinking') : '')),
      choices.length ? node('div', { class: 'msg-choices', role: 'group', 'aria-label': t('collab.msg.choices') }, choices) : null);
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
    mod.say(`선택: ${c.name}`, m.from); // AI 에게 가는 답 형식(협업 규칙의 「선택: 이름」) — 번역하지 않는다
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
    const moreText = t('collab.fold.more', { folded: start, next: Math.min(FOLD, start) });
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
    const askers = mod.status === 'running' && mod.round.askers.length ? ` · ${t('collab.status.askers', { names: mod.round.askers.map(nameOf).join('·') })}` : '';
    const agreed = mod.status === 'idle' && mod.round.final;
    status.textContent = (mod.status === 'running' ? t('collab.status.running', { name: nameOf(mod.running) }) : agreed ? agreedText(mod.roster) : t(STATUS_KEY[mod.status])) + askers;
    status.className = `collab-status ${mod.status}`;
    if (atBottom && !expanded) log.scrollTop = log.scrollHeight; // 펼친 직후에는 드러난 메시지를 보여 준다
    onStatus(mod.status);
    syncSend();
  }
  render();

  // 목록을 받기 전·실패 시에는 기본 선택지를 쓰고 그 사실을 알린다. 못 받은 쪽은 선택 상자를 열 때 다시 시도한다.
  let loading = null, catalogView = null; // catalogView: [글, 툴팁] 을 만드는 함수 — 언어가 바뀌면 다시 불러 새 말로 쓴다
  const showCatalog = (view) => { catalogView = view; [catalogNote.textContent, catalogNote.title] = view(); };
  const unlisted = new Set(); // 목록 조회 결과에 키 자체가 없는 AI (조회 대상이 아님) — 다시 시도하지 않는다. 키가 있고 null 이면 조회 실패라 다시 시도한다.
  function loadCatalog() {
    if (loading || roster.every((a) => mod.catalog[a] || unlisted.has(a))) return;
    showCatalog(() => [t('collab.catalog.loading'), '']);
    loading = Promise.resolve(api.collabModels?.()).then((catalog) => {
      for (const agent of roster) {
        if (catalog && typeof catalog === 'object' && !Object.hasOwn(catalog, agent)) { unlisted.add(agent); continue; }
        if (!catalog?.[agent]?.length) continue;
        mod.catalog[agent] = catalog[agent];
        mod.prefs[agent].model = fill(prefSelects[agent].model, modelOptions(agent), mod.prefs[agent].model);
        syncEfforts(agent);
      }
      return catalog?.errors || {};
    }, (e) => Object.fromEntries(roster.map((a) => [a, e?.message || String(e)]))).then((errors) => {
      loading = null;
      const missing = roster.filter((a) => !mod.catalog[a] && !unlisted.has(a));
      showCatalog(() => [
        missing.length ? t('collab.catalog.missing', { names: missing.map(nameOf).join('·') }) : '',
        missing.map((a) => `${nameOf(a)}: ${errors[a] || t('collab.error.unknown')}`).join('\n'),
      ]);
    });
  }
  for (const agent of roster) prefSelects[agent].model.addEventListener('focus', loadCatalog);
  loadCatalog();

  // 실행 중 언어 전환: 한 번만 만드는 머리말·입력창은 글자만 갱신하고, 선택 상자는 고른 값을 지킨 채 이름표만 바꾼다.
  const offLang = onLangChange(() => {
    ownerText.data = `${t('collab.owner.label')} `;
    autoText.data = ` ${t('collab.autoContinue.label')}`;
    autoLabel.title = t('collab.autoContinue.title');
    ownerSelect.setAttribute('aria-label', t('collab.owner.label'));
    fill(ownerSelect, ownerOptions(roster), mod.owner);
    target.setAttribute('aria-label', t('collab.target.label'));
    fill(target, targetsOf(roster), target.value);
    input.placeholder = placeholderOf(roster);
    for (const agent of roster) {
      const { model, effort } = prefSelects[agent];
      model.setAttribute('aria-label', t('collab.aria.model', { name: nameOf(agent) }));
      effort.setAttribute('aria-label', t('collab.aria.effort', { name: nameOf(agent) }));
      mod.prefs[agent].model = fill(model, modelOptions(agent), mod.prefs[agent].model);
      syncEfforts(agent);
    }
    if (catalogView) showCatalog(catalogView);
    for (const n of nodes) if (n) n.key = null; // 말풍선의 이름표·라벨(나·최종 답변·선택지)은 새 말로 다시 그린다
    render(); // 상태줄·더 보기·보내기 버튼 글자도 render() 가 다시 쓴다
  });

  return {
    root, moderator: mod,
    destroy: offLang, // 탭을 닫을 때 언어 구독을 푼다
    handle: (agent, ev) => mod.handle(agent, ev),
    focus: () => input.focus(),
    running: () => mod.status === 'running',
  };
}
