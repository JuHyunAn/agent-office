// 협업 대화 진행자: 사용자·Claude·Codex 가 한 대화방에서 말할 차례를 정한다.
// 프로세스 실행은 메인(collabAgents.cjs)이 맡고, 여기서는 「누구에게 무엇을 보낼지」만 정한다 (화면 없이 테스트 가능).

export const NAMES = { user: '나', claude: 'Claude', codex: 'Codex', system: '안내' };
export const OWNERS = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'ask', label: '구현 전에 물어보기' },
];
// CLI 에서 목록을 받아오지 못했을 때 쓰는 기본 선택지 (받아오면 화면이 CLI 목록으로 바꾼다).
export const MODEL_OPTIONS = {
  claude: [{ value: 'auto', label: '자동' }, { value: 'opus', label: 'Opus' }, { value: 'fable', label: 'Fable' }, { value: 'sonnet', label: 'Sonnet' }],
  codex: [{ value: 'auto', label: '자동' }, { value: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }, { value: 'gpt-6-astra', label: 'GPT-6 Astra' }],
};
export const EFFORT_LABEL = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max', ultra: 'Ultra' };
export const EFFORT_OPTIONS = [{ value: 'auto', label: '자동' }, { value: 'high', label: 'High' }, { value: 'xhigh', label: 'Extra High' }];
export const MODEL_LABEL = Object.fromEntries(Object.values(MODEL_OPTIONS).flat().map((o) => [o.value, o.label]));

const QUESTION_RE = /^\s*\[질문\]/m;
const DONE_RE = /^\s*\[완료\]\s*$/m;
// 설계가 끝난 단순 작업 (주석·오타·문법·정해진 대로 구현) → 가벼운 모델
const SIMPLE_RE = /주석|오타|문법|맞춤법|포맷|들여쓰기|이름\s*(변경|바꾸)|rename|lint|typo|사소|계획대로|설계대로|정해진\s*대로|그대로\s*구현|단순\s*(코딩|수정|작업)/i;
// 깊은 추론이 필요한 작업 → 최상위 모델 + Extra High
const HARD_RE = /설계|아키텍|구조\s*(개선|변경|검토)|원인|분석|추론|검토|리뷰|전략|복잡|어려|디버그|버그|보안|성능|동시성|최적화|trade.?off|race|architecture|design|debug|review/i;

// 사용자의 최근 요청 내용으로 고른다 (AI 끼리 주고받는 말에는 「검토」 같은 단어가 늘 섞여 있어 기준으로 쓰지 않는다).
export function autoChoice(agent, text = '') {
  const kind = SIMPLE_RE.test(text) ? 'simple' : HARD_RE.test(text) ? 'hard' : 'normal';
  const effort = kind === 'hard' ? 'xhigh' : 'high';
  if (agent === 'claude') return { kind, model: kind === 'hard' ? 'fable' : kind === 'simple' ? 'sonnet' : 'opus', effort };
  return { kind, model: kind === 'hard' ? 'gpt-6-astra' : 'gpt-6.1-sol', effort };
}

// 모델이 지원하지 않는 단계면 High → 지원 단계 중 가장 높은 것 → 생략(null, CLI 기본값) 순으로 맞춘다.
export function fitEffort(effort, efforts) {
  if (!Array.isArray(efforts) || efforts.includes(effort)) return effort;
  if (efforts.includes('high')) return 'high';
  return efforts.at(-1) ?? null;
}

// catalog: CLI 가 알려 준 모델 목록 [{ value, label, efforts }] — 없으면 단계를 맞추지 않는다.
export function resolveChoice(agent, prefs, text, catalog = null) {
  const auto = autoChoice(agent, text);
  const model = prefs.model === 'auto' ? auto.model : prefs.model;
  const efforts = catalog?.find((m) => m.value === model)?.efforts;
  return { model, effort: fitEffort(prefs.effort === 'auto' ? auto.effort : prefs.effort, efforts) };
}

const other = (agent) => (agent === 'claude' ? 'codex' : 'claude');

export class Moderator {
  constructor({ send, stop, onChange = () => {}, now = () => Date.now() }) {
    Object.assign(this, { sendFn: send, stopFn: stop, onChange, now });
    this.messages = [];
    this.seen = { claude: 0, codex: 0 }; // 각자 이미 받은 메시지 위치
    this.owner = 'claude';
    this.auto = true; // 자동 이어가기: 끄면 지정한 상대만 답하고 멈춘다
    this.prefs = { claude: { model: 'auto', effort: 'auto' }, codex: { model: 'auto', effort: 'auto' } };
    this.catalog = { claude: null, codex: null }; // CLI 가 알려 준 모델 목록
    this.status = 'idle'; // idle · running · question · stopped · error
    this.running = null; this.current = null; this.pending = []; this.asker = null;
    this.interjection = null; // 답변 중에 끼어든 사용자 메시지의 대상 — 그 턴이 끝나면 먼저 처리한다
    this.turnSeq = 0;
  }

  push(msg) { const m = { at: this.now(), text: '', ...msg }; this.messages.push(m); return m; }

  say(text, target = 'all') {
    const t = String(text || '').trim();
    if (!t) return;
    this.push({ from: 'user', text: t, target });
    if (this.running) { this.interjection = target; this.onChange(); return; } // 진행 중이면 이 턴이 끝난 뒤 먼저 전달된다
    const first = target === 'claude' || target === 'codex' ? target
      : this.status === 'question' && this.asker ? this.asker
        : this.owner === 'codex' ? 'codex' : 'claude';
    this.pending = target === 'all' ? [first, other(first)] : [first];
    this.asker = null;
    this.next();
  }

  next() {
    const agent = this.pending.shift() || (this.auto && this.lastSpeaker ? other(this.lastSpeaker) : null);
    if (!agent) { this.status = 'idle'; this.onChange(); return; }
    this.speak(agent);
  }

  lastUserText() {
    for (let i = this.messages.length - 1; i >= 0; i--) if (this.messages[i].from === 'user') return this.messages[i].text;
    return '';
  }

  ownerLine(agent) {
    if (this.owner === 'ask') return '구현 담당: 정하지 않음 — 파일을 수정하기 전에 누가 구현할지 [질문] 으로 사용자에게 물어보세요.';
    return `구현 담당: ${NAMES[this.owner]}${this.owner === agent ? ' (당신)' : ` — 당신(${NAMES[agent]})은 파일을 수정하지 말고 설계·검토·의견만 내세요.`}`;
  }

  promptFor(agent) {
    const lines = this.messages.slice(this.seen[agent])
      .filter((m) => (m.from === 'user' || m.from === other(agent)) && m.text.trim())
      .map((m) => `[${m.from === 'user' ? '사용자' : NAMES[m.from]}] ${m.text.trim()}`);
    return `[협업 대화] ${this.ownerLine(agent)}\n\n${lines.join('\n\n')}\n\n— 당신(${NAMES[agent]}) 차례입니다. 이어서 답하세요.`;
  }

  speak(agent) {
    const text = this.promptFor(agent);
    const choice = resolveChoice(agent, this.prefs[agent], this.lastUserText(), this.catalog[agent]);
    const turn = ++this.turnSeq;
    this.current = this.push({ from: agent, streaming: true, tools: [], turn, ...choice });
    this.seen[agent] = this.messages.length;
    this.running = agent; this.lastSpeaker = agent; this.status = 'running';
    this.onChange();
    const fail = (e) => this.handle(agent, { type: 'done', ok: false, error: e?.message || String(e), turn });
    try {
      const r = this.sendFn(agent, text, choice, turn);
      if (r && typeof r.catch === 'function') r.catch(fail);
    } catch (e) { fail(e); }
  }

  handle(agent, ev) {
    const cur = this.current;
    if (!cur || cur.from !== agent || !cur.streaming) return;
    if (ev.turn != null && ev.turn !== cur.turn) return; // 이미 끝낸 턴의 늦은 이벤트
    if (ev.type === 'text') {
      cur.text += ev.block && cur.text ? `\n\n${ev.text}` : ev.text;
    } else if (ev.type === 'tool') {
      cur.tools.push({ name: ev.name, input: ev.input || {} });
    } else if (ev.type === 'notice') {
      this.push({ from: 'system', text: `${NAMES[agent]}: ${ev.text}` });
    } else if (ev.type === 'done') {
      cur.streaming = false; this.running = null; this.current = null;
      const interjected = this.interjection; this.interjection = null;
      if (ev.stopped || this.status === 'stopped') { this.status = 'stopped'; }
      else if (!ev.ok) { this.status = 'error'; this.pending = []; this.push({ from: 'system', text: `${NAMES[agent]} 오류: ${ev.error || '알 수 없음'}` }); }
      else if (interjected) {
        // 답변 중에 사용자가 끼어들었으면 자동 이어가기·[완료]·[질문] 과 관계없이 그 메시지부터 답한다.
        this.pending = [interjected === 'all' ? other(agent) : interjected];
        this.next(); return;
      }
      else if (QUESTION_RE.test(cur.text)) { this.status = 'question'; this.asker = agent; this.pending = []; }
      else if (DONE_RE.test(cur.text)) { this.status = 'idle'; this.pending = []; }
      else { this.next(); return; }
    }
    this.onChange();
  }

  // 사용자 중단: 진행 중인 발언을 즉시 끝내고 다음 차례로 넘기지 않는다.
  // 메인의 중단 알림을 기다리지 않으므로 프로세스가 아직 뜨기 전이어도 다음 메시지가 막히지 않는다.
  halt() {
    this.pending = []; this.interjection = null;
    this.status = 'stopped';
    if (this.running) {
      this.stopFn(this.running);
      if (this.current) this.current.streaming = false;
      this.running = null; this.current = null;
    }
    this.onChange();
  }
}
