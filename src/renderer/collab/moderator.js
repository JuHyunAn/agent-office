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

// [질문] 줄: 앞의 불릿(-, *, •)과 굵게(**, __) 꾸밈도 허용한다. 인용(>)은 상대 질문을 옮겨 적은 것이라 제외.
const QUESTION_HEAD = String.raw`^\s*(?:[-*•]\s+)?(?:\*\*|__)?\[\s*질문\s*\](?:\*\*|__)?`;
const QUESTION_RE = new RegExp(QUESTION_HEAD, 'm');
const QUESTION_LINE_RE = new RegExp(`${QUESTION_HEAD}\\s*(.*)$`);
// [완료] 줄: [질문] 처럼 앞의 불릿과 굵게 꾸밈을 허용한다 (꾸밈 하나로 합의가 끊기지 않게).
const DONE_LINE = String.raw`^\s*(?:[-*•]\s+)?(?:\*\*|__)?\[\s*완료\s*\](?:\*\*|__)?\s*$`;
const DONE_RE = new RegExp(DONE_LINE, 'm');
const DONE_LINES_RE = new RegExp(DONE_LINE, 'gm');
// AI 가 형식을 예로 든 코드 블록 안의 [질문]·[완료]·[선택] 은 무시한다.
// 줄 맨 앞의 ``` 또는 ~~~ 펜스만 블록으로 보고(백틱 펜스 뒤 글에 백틱이 있으면 펜스 아님), 같은 펜스로 닫히지 않으면 끝까지 지운다.
// 여는 펜스는 lookahead 로 한 번에 잡는다 — 줄바꿈 없는 긴 백틱 줄에서 되돌아가며 느려지지 않게.
export function stripCode(text) {
  return String(text || '').replace(/^[ \t]*(?=(`{3,}|~{3,}))\1(?:(?<=`)[^`\n]*|(?<=~)[^\n]*)\n[\s\S]*?(?:^[ \t]*\1[^\n]*$|(?![\s\S]))/gm, '');
}

// 마지막 [질문] 줄과 그 아래 [선택] 줄들 → { question, choices: [{ name, desc }] }. 선택지가 2개 미만이면 null.
export function parseQuestion(text) {
  const lines = stripCode(text).split(/\r?\n/);
  let i = lines.length - 1;
  let q = null;
  for (; i >= 0; i--) { q = lines[i].match(QUESTION_LINE_RE); if (q) break; }
  if (!q) return null;
  const question = q[1].replace(/\*\*|__/g, '').replace(/^\s*[:：]\s*/, '').trim();
  const unwrap = (s) => s.trim().replace(/^(\*\*|__|`)(.*)\1$/, '$2').trim();
  const choices = [];
  for (let k = i + 1; k < lines.length; k++) {
    const line = lines[k];
    if (!line.trim()) continue;
    const isChoice = /^\s*(?:(?:[-*•]|\d+[.)])\s+)?(?:\*\*|__|`)?\[\s*선택\s*\]/.test(line);
    if (choices.length && !isChoice && /^(?: {2,}|\t)/.test(line)) continue; // 하위 설명 (들여쓴 [선택] 은 중첩 목록이라 읽는다)
    let s = line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '');
    s = s.replace(/^(\*\*|__)((?:(?!\1).)*)\1$/, '$2').trim();
    s = s.replace(/^(?:\*\*|__|`)?(\[\s*선택\s*\])(?:\*\*|__|`)?/, '$1');
    const c = s.match(/^\[\s*선택\s*\]\s*(.*)$/);
    if (!c) { if (choices.length) break; continue; }
    const body = c[1].replace(/\*\*|__/g, ''); // 「**이름** — 설명」·「**A안:** 설명」 같은 굵게 꾸밈
    // 가장 앞의 구분자: 양쪽 공백 있는 대시, 숫자 앞이 아닌 ：, 뒤에 공백 있는 : (10:30·http:// 은 나누지 않는다)
    const at = body.search(/(?:^|\s)[—–-]\s|：(?!\d)|:(?=\s)/);
    let name = body, desc = '';
    if (at >= 0) { name = body.slice(0, at); desc = body.slice(at).replace(/^(?:\s?[—–-]\s|[:：])/, ''); }
    name = unwrap(name).slice(0, 60); desc = unwrap(desc).slice(0, 160);
    if (!name || choices.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    choices.push({ name, desc });
  }
  return choices.length >= 2 ? { question, choices: choices.slice(0, 8) } : null;
}
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
// 한 라운드(사용자 메시지 하나에 대한 답들): askers 질문한 AI 순서, asked AI → 그 AI 의 질문 메시지,
// proposal 아직 상대 동의를 못 받은 [완료] 메시지(최종안 제안), final 합의된 최종 답변 메시지, start 이 라운드 첫 메시지 위치
const newRound = (start) => ({ askers: [], asked: new Map(), proposal: null, final: null, start });

// 입력창 버튼 상태: 글이 있으면 보내기, 빈 입력으로 답변 중이면 중단, 그 밖에는 비활성.
export function inputMode(text, status) {
  return String(text || '').trim() ? 'send' : status === 'running' ? 'stop' : 'idle';
}

// 글도 도구 사용도 없이 끝난 AI 발언 (중단·오류·말풍선 분리 등) — 화면에 빈 말풍선을 남기지 않는다.
export function isEmptyReply(m) {
  return (m.from === 'claude' || m.from === 'codex') && !m.streaming && !String(m.text || '').trim() && !(m.tools || []).length;
}

export class Moderator {
  constructor({ send, stop, steer = null, onChange = () => {}, now = () => Date.now() }) {
    Object.assign(this, { sendFn: send, stopFn: stop, steerFn: steer, onChange, now });
    this.messages = [];
    this.seen = { claude: 0, codex: 0 }; // 각자 이미 받은 메시지 위치
    this.owner = 'claude';
    this.auto = true; // 자동 이어가기: 끄면 지정한 상대만 답하고 멈춘다
    this.prefs = { claude: { model: 'auto', effort: 'auto' }, codex: { model: 'auto', effort: 'auto' } };
    this.catalog = { claude: null, codex: null }; // CLI 가 알려 준 모델 목록
    this.status = 'idle'; // idle · running · question · stopped · error
    this.running = null; this.current = null; this.pending = []; this.round = newRound(0);
    this.goal = ''; // 현재 요청(최종 목표) — 대기 중에 보낸 메시지로만 바뀐다 (질문 답·끼어들기·오류/중단 뒤 이어 가기는 그대로)
    this.interjection = null; // 답변 중에 끼어든 사용자 메시지의 대상 — 그 턴이 끝나면 먼저 처리한다
    this.turnSeq = 0;
  }

  get asker() { return this.round.askers[0] ?? null; }

  // 답을 기다리는 질문 메시지인가 (질문한 AI 의 이번 라운드 질문만 — 예전 질문의 버튼이 다시 살아나지 않게).
  // 상대 차례에서 중단돼도 질문 답을 기다리는 중이다 (say() 의 answering 과 같은 조건).
  isActiveQuestion(m) { return (this.status === 'question' || this.status === 'stopped') && this.round.asked.get(m.from) === m; }

  push(msg) { const m = { at: this.now(), text: '', ...msg }; this.messages.push(m); return m; }

  // 진행 중인 답변에 반영할 수 있는 AI — Claude 는 진행 중 프로세스에 바로, Codex 는 안전 지점에서 끊고 같은 세션으로 이어 답한다 (D-039·D-037).
  canSteer(agent) { return (agent === 'claude' || agent === 'codex') && typeof this.steerFn === 'function'; }

  say(text, target = 'all') {
    const t = String(text || '').trim();
    if (!t) return;
    if (!this.running && this.status === 'idle') this.goal = t; // 오류·중단 뒤의 「다시」「계속해」는 이어 가기라 목표를 바꾸지 않는다
    const msg = this.push({ from: 'user', text: t, target });
    this.route(msg, target);
  }

  route(msg, target) {
    if (this.running) {
      const a = this.running;
      if ((target === 'all' || target === a) && this.canSteer(a)) { this.steer(a, msg, target); return; }
      this.interjection = target; this.onChange(); return; // 진행 중이면 이 턴이 끝난 뒤 먼저 전달된다
    }
    const answering = (this.status === 'question' || this.status === 'stopped') && this.asker; // 질문에 답하는 중
    const first = target === 'claude' || target === 'codex' ? target
      : answering ? this.asker // 상대 차례에서 중단했어도 질문한 쪽이 먼저
        : this.owner === 'codex' ? 'codex' : 'claude';
    this.round = newRound(this.messages.length);
    this.pending = target === 'all' ? [first, other(first)] : [first];
    this.next();
  }

  // 답변 중인 AI 에 사용자 메시지를 바로 넣는다. 받았다는 확인(steered)이 오면 말풍선을 나눈다.
  steer(agent, msg, target) {
    msg.steering = agent; // 보냈지만 아직 받았다는 확인(되돌림) 전
    if (target === 'all' && !this.pending.includes(other(agent))) this.pending.push(other(agent)); // 모두에게면 이 턴 뒤 상대도 답한다
    else if (target === agent) this.pending = this.pending.filter((a) => a !== other(agent)); // 이 AI 에게만이면 기존 끼어들기처럼 지정한 상대만
    const turn = this.current?.turn;
    const fail = () => {
      if (msg.steering !== agent) return;
      msg.steering = null;
      if (this.running === agent && this.current?.turn === turn) this.interjection = target; // 같은 턴이면 기존처럼 다음 차례로
      else if (!this.running) this.route(msg, target); // 방어: 그 사이 턴이 끝났으면 새 메시지처럼 보낸다 (보통은 done·halt 가 먼저 steering 을 푼다)
      this.onChange();
    };
    try {
      const r = this.steerFn(agent, `[사용자] ${msg.text}`, turn);
      if (r && typeof r.then === 'function') r.then((ok) => { if (ok === false) fail(); }, fail);
      else if (r === false) fail();
    } catch { fail(); }
    this.onChange();
  }

  // Claude 가 진행 중 답변에서 사용자 메시지를 받은 순간 — 앞 글은 그 위, 반영한 답은 그 아래 새 말풍선으로 (Claude Code 와 같은 순서).
  splitFor(agent, cur) {
    const msg = this.messages.find((m) => m.steering === agent); // 먼저 보낸 것부터
    if (!msg) return;
    msg.steering = null;
    msg.steered = agent; // 이 AI 는 진행 중 답변에서 받았다 — 다음 프롬프트에 다시 넣지 않는다 (확인 안 된 다른 메시지는 그대로 남음)
    cur.streaming = false;
    if (!cur.text.trim() && !cur.tools.length) cur.skip = true; // 아직 아무것도 안 쓴 말풍선은 숨긴다
    const { model, effort, turn } = cur;
    this.current = this.push({ from: agent, streaming: true, tools: [], turn, model, effort });
    this.round = newRound(this.messages.length - 1); // 새 사용자 입력: 합의·질문 연쇄를 새 말풍선부터 다시
    this.onChange();
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
    if (this.owner === 'ask') {
      // 두 AI 가 같은 승인 질문을 겹쳐 내지 않도록 묻는 쪽을 Claude 로 정한다.
      return agent === 'claude'
        ? '구현 담당: 정하지 않음 — 파일을 수정하지 마세요. 계획에 둘 다 동의하면 당신(Claude)이 구현 승인과 구현 담당을 한 [질문] 으로 사용자에게 묻습니다.'
        : '구현 담당: 정하지 않음 — 파일을 수정하지 마세요. 계획에 둘 다 동의하면 Claude 가 구현 승인과 구현 담당을 묻습니다. 당신(Codex)은 승인 [질문] 을 내지 말고 계획 의견만 내세요.';
    }
    return `구현 담당: ${NAMES[this.owner]}${this.owner === agent ? ' (당신)' : ` — 당신(${NAMES[agent]})은 파일을 수정하지 말고 설계·검토·의견만 내세요.`}`;
  }

  // 합의된 최종 답변 메시지: 최종안이 짧으면 「동의 [완료]」 같은 제안이라 같은 라운드 앞의 AI 답이 실제 최종 답변이다.
  // 길이는 코드 블록까지 포함한 원문으로 잰다 (코드 위주 최종안이 앞 메시지에 표시를 뺏기지 않게).
  finalOf(p) {
    const body = p.text.replace(DONE_LINES_RE, '').trim();
    if (body.length >= 80) return p;
    const asked = [...this.round.asked.values()];
    for (let i = this.messages.indexOf(p) - 1; i >= this.round.start; i--) {
      const m = this.messages[i];
      if ((m.from === 'claude' || m.from === 'codex') && !m.streaming && !asked.includes(m)) return m;
    }
    return p;
  }

  promptFor(agent) {
    const lines = this.messages.slice(this.seen[agent])
      .filter((m) => (m.from === 'user' || m.from === other(agent)) && m.steered !== agent && m.text.trim())
      .map((m) => `[${m.from === 'user' ? '사용자' : NAMES[m.from]}] ${m.text.trim()}`);
    const goal = this.goal.replace(/\s+/g, ' ').trim().slice(0, 300);
    const p = this.round.proposal;
    const cue = p && p.from !== agent
      ? `상대(${NAMES[p.from]})가 [완료] 로 최종안을 냈습니다. 동의하면 짧은 동의와 함께 마지막 줄에 [완료] 를, 반론이나 보탤 내용이 있으면 그것만 적으세요 (구현 전 계획이라면 [완료] 대신 구현 담당이 승인 [질문] 을 합니다).`
      : '결론에 만족하면 마지막 줄에 [완료] 를 적으세요 (코드 작업의 구현 전 계획 단계라면 [완료] 대신 구현 담당이 승인 [질문] 을 합니다).';
    return `[협업 대화] ${this.ownerLine(agent)}${goal ? `\n현재 요청(최종 목표): ${goal}` : ''}\n\n${lines.join('\n\n')}\n\n— 당신(${NAMES[agent]}) 차례입니다. 이어서 답하세요. ${cue}`;
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
    } else if (ev.type === 'steered') {
      this.splitFor(agent, cur);
    } else if (ev.type === 'done') {
      cur.streaming = false;
      const lost = this.messages.filter((m) => m.steering === agent);
      for (const m of lost) m.steering = null; // 받았다는 확인이 없었다 — 다음 프롬프트에 그대로 들어간다
      this.running = null; this.current = null;
      // 정상 종료인데 반영 확인이 없었으면 끼어들기처럼 그 메시지부터 답한다 — 대상이 여럿이면 하나라도 모두에게면 모두에게.
      const targets = [this.interjection, ...(ev.ok && !ev.stopped ? lost.map((m) => m.target) : [])].filter(Boolean);
      const interjected = targets.includes('all') ? 'all' : targets.at(-1) || null; this.interjection = null;
      if (ev.stopped || this.status === 'stopped') { this.status = 'stopped'; }
      else if (!ev.ok) { this.status = 'error'; this.pending = []; this.push({ from: 'system', text: `${NAMES[agent]} 오류: ${ev.error || '알 수 없음'}` }); }
      else if (interjected) {
        // 답변 중에 사용자가 끼어들었으면 자동 이어가기·[완료]·[질문] 과 관계없이 그 메시지부터 답한다 (모두에게면 상대 → 답하던 쪽 순서로 둘 다).
        this.round = newRound(this.messages.length);
        this.pending = interjected === 'all' ? [other(agent), agent] : [interjected];
        this.next(); return;
      }
      else {
        // 「모두에게」 보낸 메시지는 두 AI 가 한 번씩 답한 뒤에 [질문]·[완료] 를 따른다.
        const plain = stripCode(cur.text);
        if (QUESTION_RE.test(plain)) {
          cur.question = parseQuestion(plain); // 선택지 형식이 아니면 null — 그래도 질문이다
          if (!this.round.askers.includes(agent)) this.round.askers.push(agent);
          this.round.asked.set(agent, cur);
          this.round.proposal = null; // 질문은 합의를 끊는다
        } else if (DONE_RE.test(plain)) {
          const p = this.round.proposal;
          if (p && p.from !== agent) { const f = this.finalOf(p); f.final = true; this.round.final = f; this.round.proposal = null; }
          else this.round.proposal = cur; // 먼저 [완료] 를 쓴 답이 최종안 제안
        } else this.round.proposal = null; // 반론·보탬이 나오면 합의를 다시
        if (this.pending.length) { this.next(); return; }
        if (this.round.askers.length) { this.status = 'question'; }
        else if (this.round.final) { this.status = 'idle'; } // 두 AI 가 이어서 [완료] — 합의
        else { this.next(); return; } // 한쪽 [완료] 는 제안일 뿐 — 상대 차례 (자동 이어가기를 끄면 next() 가 idle 로 멈춤)
      }
    }
    this.onChange();
  }

  // 사용자 중단: 진행 중인 발언을 즉시 끝내고 다음 차례로 넘기지 않는다.
  // 메인의 중단 알림을 기다리지 않으므로 프로세스가 아직 뜨기 전이어도 다음 메시지가 막히지 않는다.
  halt() {
    this.pending = []; this.interjection = null;
    for (const m of this.messages) if (m.steering) m.steering = null; // 확인 전 메시지는 다음 프롬프트(seen 기준)에 들어간다
    this.status = 'stopped';
    if (this.running) {
      this.stopFn(this.running);
      if (this.current) this.current.streaming = false;
      this.running = null; this.current = null;
    }
    this.onChange();
  }
}
