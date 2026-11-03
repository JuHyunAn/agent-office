// 사무실 시뮬레이션 엔진 — hook 이벤트를 캐릭터의 위치·상태·말풍선으로 바꾼다.
// DOM·Canvas 를 쓰지 않는다. 그림은 테마(themes/*)가 snapshot() 결과를 받아 그린다.

import { roleOf, displayType } from './roles.js';
import { toolPhrase, toolPose, clip, baseName, activitySummary, workBrief } from './phrases.js';
import { Navigation } from './navigation.js';
import { createAppearance } from './appearance.js';
import { AGENT_IDS, normAgent } from '../../shared/agents.js';

export const TIMING = {
  speed: 150, // 논리 좌표 px/초
  handoffWindowMs: 30000, // 이 시간 안에 다음 에이전트가 시작하면 「결과 공유」로 연출 (추정)
  idleLeaveMs: 3 * 60000, // 팀장: 작업 중이 아닌 상태가 이만큼 이어지면 퇴근 (D-068 — 예전 20분)
  subIdleLeaveMs: 60000, // 하위 에이전트: 일을 마친 뒤 이만큼이면 퇴근 (D-068)
  sessionEndGraceMs: 60000, // 세션이 끝나면 휴게실에 모였다가 이만큼 뒤 다 같이 퇴근 (D-068 — 예전 5분)
  leadIdleToRestMs: 150000, // 팀장이 이만큼 한가하면 휴게실로
  bubbleMs: 4500,
  idleMinMs: 5000,
  idleMaxMs: 12000,
  maxShares: 3,
  externalSessionIdleMs: 30 * 60000, // 앱 탭이 아닌 세션이 이만큼 조용하면 끝난 것으로 본다 (강제 종료·크래시 대비)
  silentWorkMs: 20 * 60000, // 작업 중인데 이벤트가 이만큼 없으면 휴게실로 (Stop 누락 대비) — 휴게실에 간 뒤 idleLeaveMs(팀장) 가 지나면 퇴근
  subSilentWorkMs: 5 * 60000, // 하위 에이전트가 작업 중인데 이벤트가 이만큼 없으면 휴게실로 (끝 신호 누락·중단 대비, 팀장은 silentWorkMs) — 그 뒤 subIdleLeaveMs 가 지나면 퇴근
  briefBubbleMs: 3000, // 작업 말풍선은 내용이 바뀐 뒤 이만큼만 두 줄로, 그 뒤 한 줄 요약
  promptKeepMs: 10000, // 새 요청 때 이 안에 신호를 보낸 앞쪽 하위 에이전트는 아직 일하는 것으로 본다 (답하는 중 보낸 메시지)
};

const ENDED_TASK = '세션 종료 · 퇴근 대기';
// 사용자가 답해야 진행되는 알림만 퇴근을 막는다 (답변 후 「입력 대기」 알림 등은 제외).
export const NON_BLOCKING_NOTIFICATIONS = new Set(['idle_prompt', 'auth_success']);
const CHAT = ['☕ 커피 맛있네요', '💬 아까 그 버그 말이죠…', '😴 잠깐만 쉴게요', '🍪 간식 드실래요?', '📈 오늘 순조롭네요', '🎧 음악 듣는 중', '🌿 화분 물 줬어요'];
const SITTING_ROOMS = new Set(['lead', 'analysis', 'planning', 'dev', 'review', 'skills']);
// 오래 켜 둬도 세션 기록이 끝없이 늘지 않게, 가장 오래된 것부터 지운다.
const SESSION_MEMORY = 500;
function remember(collection, key, value) {
  if (collection instanceof Map) collection.set(key, value); else collection.add(key);
  if (collection.size > SESSION_MEMORY) collection.delete(collection.keys().next().value);
}

function hash(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) | 0;
  return Math.abs(h);
}

export class OfficeEngine {
  constructor(layout, opts = {}) {
    this.layout = layout;
    this.navigation = layout.walkBounds ? new Navigation(layout) : null;
    this.random = opts.random || Math.random;
    this.timing = { ...TIMING, ...(opts.timing || {}) };
    this.roleOverrides = opts.roleOverrides || {};
    this.onFeed = opts.onFeed || null;
    // now 를 주면 시간이 실제 시계보다 늦지 않는다 — 창이 최소화돼 update() 가 멈춰도 퇴근 시간이 밀리지 않게.
    this.now = opts.now || null;
    this.time = this.now ? this.now() : 0;
    this.agents = new Map();
    this.sessions = new Map();
    this.closed = new Set(); // 퇴근까지 끝난 세션 — 늦게 온 이벤트로 다시 출근시키지 않는다
    this.leadLooks = new Map(); // 세션별 팀장 외형 — 세션 기록이 지워진 뒤 다시 와도 같은 사람으로
    this.seats = new Map();
    this.feed = [];
    this.attention = new Map(); // 「확인 필요」: 액터 key → { text, kind } — app.js 가 정하고 엔진은 말풍선에 보여 주기만 한다 (퇴근 규칙과 무관)
  }

  // ───────────────────────── 공개 API ─────────────────────────

  handleEvent(ev, meta = {}) {
    const sid = ev && ev.session_id;
    if (!sid) return;
    this.sync();
    if (ev.hook_event_name === 'SessionStart') {
      // 같은 세션을 다시 시작(/resume 등)하면 퇴근 예약을 거둔다.
      this.closed.delete(sid);
      const prev = this.sessions.get(sid);
      if (prev && prev.endedAt != null) {
        prev.endedAt = null;
        for (const a of this.agents.values()) if (a.sessionId === sid && a.task === ENDED_TASK) a.task = '';
      }
    } else if (this.closed.has(sid) || this.sessions.get(sid)?.endedAt != null) {
      return;
    }
    const s = this.ensureSession(sid, meta, ev);
    s.lastEventAt = this.time;
    this.dispatch(s, ev);
    const sub = ev.agent_id && this.agents.get(`${sid}:${ev.agent_id}`);
    if (sub) {
      sub.lastEventAt = this.time;
      // 턴이 끝난 뒤에도 일하는 하위 에이전트(턴 중 백그라운드로 넘긴 것·팀 동료)는 다음 Stop 에 정리하지 않는다.
      if (ev.hook_event_name !== 'SubagentStop' && !this.turnActive(s)) sub.background = true;
    }
    // 팀장은 세션 안의 누가 일하든 자리를 지킨다 (백그라운드 에이전트 포함).
    const lead = this.agents.get(`${sid}:lead`);
    if (lead) lead.lastEventAt = this.time;
  }

  dispatch(s, ev) {
    const sid = s.id;
    switch (ev.hook_event_name) {
      case 'SessionStart': this.onSessionStart(s); break;
      case 'UserPromptSubmit': this.onPrompt(s, ev); break;
      case 'PreToolUse': this.onTool(s, ev); break;
      case 'SubagentStart': this.onSubStart(s, ev); break;
      case 'SubagentStop': this.onSubStop(s, ev); break;
      case 'Notification': this.onAlert(s, ev, `❓ ${clip(ev.message || '확인이 필요합니다', 22)}`); break;
      case 'PermissionRequest': this.onAlert(s, ev, `❓ 권한 확인: ${clip(ev.tool_name || '', 14)}`); break;
      case 'Stop': this.onStop(s, ev); break;
      case 'SessionEnd': this.endSession(sid); break;
      default: break;
    }
  }

  // 세션이 끝나면(탭 삭제·claude 종료·/clear·SessionEnd) 모두 일을 멈추고 휴게실에 모였다가
  // sessionEndGraceMs 뒤 다 같이 퇴근한다 (expire 가 처리).
  endSession(sessionId) {
    this.sync(); // app.js 가 직접 부르므로 창이 멈춰 있던 동안의 시간도 반영한다
    const s = this.sessions.get(sessionId);
    if (!s) { remember(this.closed, sessionId); return; }
    if (s.endedAt != null) return;
    s.endedAt = this.time;
    for (const a of this.agents.values()) {
      if (a.sessionId !== sessionId || a.status === 'leaving') continue;
      this.interrupt(a);
      a.skill = null;
      a.finishedAt = null;
      if (a.bubble && a.bubble.kind === 'alert') a.bubble = null; // 답할 세션이 없다
      a.task = ENDED_TASK;
      this.rest(a);
    }
  }

  // 「확인 필요」 목록을 통째로 바꾼다: [{ sessionId, agentId, text, kind }] — kind 는 말풍선 종류(done·alert).
  setAttention(list) {
    this.attention = new Map(list.map((x) => [`${x.sessionId}:${x.agentId || 'lead'}`, { text: x.text, kind: x.kind }]));
  }

  // 이벤트를 받아들인 살아 있는 세션인가 (닫혔거나 끝난 세션의 늦은 이벤트는 아니다).
  isLive(sessionId) {
    const s = this.sessions.get(sessionId);
    return !!s && s.endedAt == null;
  }

  // 테마가 바뀌면 배치도도 바뀐다 — 사람은 그대로 두고 같은 방의 새 자리로 옮긴다.
  setLayout(layout) {
    this.layout = layout;
    this.navigation = layout.walkBounds ? new Navigation(layout) : null;
    this.seats.clear();
    for (const a of this.agents.values()) {
      const previous = a.seat ? a.seat.room : (a.isLead ? 'lead' : a.role);
      const room = layout.rooms[previous] ? previous : (a.isLead ? 'lead' : a.role);
      if (!layout.rooms.skills) a.skill = null;
      a.seat = null;
      this.allocSeat(a, room);
      a.x = a.seat.x;
      a.y = a.seat.y;
      a.path = [];
      for (const op of a.queue) if (op.room && !layout.rooms[op.room]) op.room = room;
    }
  }

  sync() {
    if (this.now) this.time = Math.max(this.time, this.now());
  }

  update(dtMs) {
    const dt = Math.max(0, Math.min(dtMs, 250)); // 이동은 한 번에 최대 0.25초만큼만 (창 복귀 시 순간이동 방지)
    // 실제 시계보다 늦지 않게 따라잡되, update(dt) 로 빨리 감는 것도 허용한다 (시간은 되돌아가지 않음).
    this.time = this.now ? Math.max(this.time + dt, this.now()) : this.time + dt;
    this.expire();
    for (const a of [...this.agents.values()]) {
      if (a.bubble && a.bubble.until <= this.time) a.bubble = null;
      this.idle(a);
      this.step(a, dt);
    }
  }

  // 퇴근 규칙과, 끝 이벤트가 오지 않은 세션·에이전트 정리.
  expire() {
    const t = this.timing;
    for (const s of [...this.sessions.values()]) {
      // 끝 이벤트 없이 조용해진 외부 세션: 확인 요청도 더는 답할 곳이 없다고 보고,
      // 사람은 아래 퇴근 규칙이 내보내며, 모두 떠난 뒤 기록만 지운다.
      if (s.endedAt == null && s.external && this.time - s.lastEventAt > t.externalSessionIdleMs) {
        const crew = [...this.agents.values()].filter((a) => a.sessionId === s.id);
        for (const a of crew) if (a.bubble && a.bubble.kind === 'alert') a.bubble = null;
        if (!crew.length) this.sessions.delete(s.id);
      }
      if (s.endedAt != null && this.time - s.endedAt >= t.sessionEndGraceMs) {
        for (const a of this.agents.values()) if (a.sessionId === s.id && a.status !== 'leaving') this.goHome(a);
        this.sessions.delete(s.id);
        remember(this.closed, s.id);
      }
    }
    for (const a of [...this.agents.values()]) {
      if (a.status === 'leaving' || this.sessions.get(a.sessionId)?.endedAt != null) continue;
      if (this.waitingOnUser(a)) continue;
      // 하위 에이전트가 사용자 확인을 기다리는 동안 팀장도 자리를 지킨다.
      if (a.isLead && [...this.agents.values()].some((b) => b.sessionId === a.sessionId && this.waitingOnUser(b))) continue;
      // 하위 에이전트가 아직 일하는(보고·공유 포함) 동안 팀장은 퇴근하지 않는다 — 긴 도구 하나를 실행하는 동안은 신호가 없다 (도구 종료 hook 없음).
      if (a.isLead && a.status !== 'working' && [...this.agents.values()].some((b) => b.sessionId === a.sessionId && !b.isLead && ['working', 'reporting', 'sharing'].includes(b.status))) continue;
      if (a.status === 'working') {
        if (a.path.length || a.queue.length || this.time - a.lastEventAt <= (a.isLead ? t.silentWorkMs : t.subSilentWorkMs)) continue;
        a.task = '응답 없음 · 휴식';
        a.skill = null;
        this.rest(a); // rest() 가 휴게실에 간 때(idleSince)부터 다시 퇴근 시간(하위 subIdleLeaveMs · 팀장 idleLeaveMs)을 잰다
      } else if (a.status === 'idle' || a.status === 'resting' || a.status === 'away') {
        const leave = a.isLead ? t.idleLeaveMs : t.subIdleLeaveMs;
        if (this.time - Math.max(a.lastEventAt, a.idleSince ?? 0) >= leave) this.goHome(a);
      }
    }
  }

  // 일을 멈추고 휴게실로 간다 (팀장은 「잠깐 휴식」).
  rest(a) {
    const status = a.isLead ? 'away' : 'resting';
    a.queue.push({ op: 'goSeat', room: 'rest' }, { op: 'status', status });
    a.status = status;
    a.idleSince = this.time; // 휴게실에 간 때부터 퇴근 시간을 잰다 (앞쪽 하위 정리·중단 뒤 바로 퇴근하지 않게)
    a.restSince = this.time;
    a.nextIdleAt = this.time + this.idleDelay();
  }

  waitingOnUser(a) {
    return !!(a.bubble && a.bubble.kind === 'alert' && a.bubble.blocking);
  }

  goHome(a) {
    this.interrupt(a);
    a.skill = null;
    if (a.bubble && a.bubble.kind === 'alert') a.bubble = null; // 「퇴근합니다」가 가려지지 않게
    a.status = 'leaving';
    a.queue.push({ op: 'say', text: '👋 퇴근합니다', kind: 'info', ms: 3000 }, { op: 'leave' });
  }

  snapshot() {
    const out = [];
    for (const a of this.agents.values()) {
      out.push({
        id: a.key,
        x: a.x,
        y: a.y,
        pose: this.poseOf(a),
        facing: a.facing,
        moving: a.path.length > 0,
        isLead: a.isLead,
        cli: a.cli,
        type: a.type,
        displayType: a.isLead ? 'lead' : displayType(a.type),
        role: a.isLead ? 'lead' : a.role,
        label: a.label,
        sessionLabel: this.sessions.get(a.sessionId)?.label || '',
        colorIndex: a.colorIndex,
        appearance: a.appearance,
        status: a.status,
        task: a.task,
        skill: a.skill || null,
        bubble: this.attentionBubble(a, this.workBubble(a)),
      });
    }
    return out;
  }

  workBubble(a) {
    if (a.bubble && a.bubble.kind === 'alert') return { text: a.bubble.text, kind: a.bubble.kind };
    if (a.status === 'working') {
      const lines = [];
      if (a.assignment) lines.push(clip(a.assignment, 28));
      const activity = a.activity || (a.skill ? `${a.skill} 스킬 작업 중` : '맡은 작업 준비 중');
      if (!lines.length || lines[0] !== activity) lines.push(clip(activity, 36));
      // 내용이 바뀐 직후에만 두 줄, 조금 지나면 한 줄 요약으로 줄여 말풍선이 계속 커지지 않게 한다.
      const fresh = a.briefSince == null || !a.brief || this.time - a.briefSince < this.timing.briefBubbleMs;
      return fresh ? { text: lines.join('\n'), kind: 'work', summary: true } : { text: a.brief, kind: 'work', summary: true, brief: true };
    }
    return a.bubble ? { text: a.bubble.text, kind: a.bubble.kind } : null;
  }

  // 「확인 필요」 액터의 말풍선: 확인 요청이면 엔진의 확인 요청 말풍선(권한 대상 등)이 더 구체적이라 그대로 두고,
  // 그 밖(작업 요약·잡담·말풍선 없음, 완료 뒤 따라오는 「입력 대기」 알림)은 확인할 내용으로 바꾼다. 테마는 attention 이면 배경을 깜빡인다.
  attentionBubble(a, bubble) {
    const mark = a.status !== 'leaving' && this.attention.get(a.key);
    if (!mark) return bubble;
    return mark.kind === 'alert' && bubble?.kind === 'alert' ? { ...bubble, attention: true } : { text: mark.text, kind: mark.kind, attention: true };
  }

  roomAt(x, y) {
    for (const [k, r] of Object.entries(this.layout.rooms)) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return k;
    }
    return null;
  }

  // ───────────────────────── 이벤트 처리 ─────────────────────────

  ensureSession(sid, meta, ev) {
    let s = this.sessions.get(sid);
    const label = meta.label || (ev.cwd ? `외부 · ${baseName(ev.cwd)}` : '외부 세션');
    if (!s) {
      s = { id: sid, label, cli: normAgent(ev._cli), external: !meta.label, pending: [], typeCounts: {}, subLooks: new Map(), lastEventAt: this.time };
      this.sessions.set(sid, s);
    } else if (meta.label && s.label !== meta.label) {
      s.label = meta.label;
      s.external = false;
      const lead = this.agents.get(`${sid}:lead`);
      if (lead) lead.label = meta.label;
    }
    if (AGENT_IDS.includes(ev._cli) && s.cli !== ev._cli) {
      s.cli = ev._cli;
      for (const a of this.agents.values()) if (a.sessionId === sid) a.cli = s.cli;
    }
    return s;
  }

  ensureLead(s) {
    const key = `${s.id}:lead`;
    let a = this.agents.get(key);
    if (a && a.status !== 'leaving') return a;
    if (a) { this.agents.delete(key); this.releaseSeat(a); }
    a = this.newAgent({ key, sessionId: s.id, cli: s.cli, isLead: true, type: 'lead', label: s.label, role: 'lead' });
    a.status = 'idle';
    a.colorIndex = -1;
    // 퇴근했다 다시 출근해도 같은 사람으로 보이게 세션별로 외형을 기억한다.
    // 다시 출근하면 최근 기록으로 옮겨, 오래 일하는 세션의 외형이 먼저 지워지지 않게 한다.
    if (this.leadLooks.has(s.id)) { a.appearance = this.leadLooks.get(s.id); this.leadLooks.delete(s.id); }
    remember(this.leadLooks, s.id, a.appearance);
    this.allocSeat(a, 'lead');
    this.say(a, '👋 출근했습니다', 'info', 2500);
    a.queue.push({ op: 'goSeat', room: 'lead' });
    return a;
  }

  ensureSub(s, agentId, type) {
    const key = `${s.id}:${agentId}`;
    let a = this.agents.get(key);
    if (a && a.status !== 'leaving') return a;
    if (a) { this.agents.delete(key); this.releaseSeat(a); }
    const dt = displayType(type) || 'agent';
    // 퇴근했다 같은 agent_id 로 다시 일하면 같은 이름·외형으로 다시 출근한다 (새 번호를 매기지 않는다).
    const look = s.subLooks.get(agentId);
    if (!look) s.typeCounts[dt] = (s.typeCounts[dt] || 0) + 1;
    const label = look ? look.label : (s.typeCounts[dt] > 1 ? `${dt} #${s.typeCounts[dt]}` : dt);
    a = this.newAgent({ key, sessionId: s.id, cli: s.cli, isLead: false, type: type || 'agent', label, role: roleOf(type, this.roleOverrides) });
    a.name = dt;
    if (look) { a.appearance = look.appearance; a.colorIndex = look.colorIndex; }
    s.subLooks.delete(agentId); // 다시 출근하면 최근 기록으로 옮긴다 (leadLooks 와 같은 방식)
    remember(s.subLooks, agentId, { label, appearance: a.appearance, colorIndex: a.colorIndex });
    a.status = 'working';
    a.background = !this.turnActive(s); // onSubStart 가 Agent 호출 기록(pending)으로 다시 정한다
    a.lastEventAt = this.time;
    this.allocSeat(a, a.role); // 결과 공유가 곧바로 이 자리를 목적지로 쓸 수 있게 미리 잡는다
    a.queue.push({ op: 'goSeat', room: a.role });
    return a;
  }

  newAgent({ key, sessionId, cli = 'claude', isLead, type, label, role }) {
    const e = this.layout.entrance;
    const a = {
      key, sessionId, cli, isLead, type, label, role,
      name: label,
      colorIndex: hash(displayType(type)) % 8,
      appearance: createAppearance(this.random),
      x: e.x, y: e.y,
      facing: 'right',
      path: [], queue: [], waitUntil: 0,
      seat: null,
      status: 'arriving',
      workPose: 'type',
      task: '',
      bubble: null,
      finishedAt: null,
      brief: null, // 말풍선 한 줄 요약
      briefSince: null, // 지금 내용이 시작된 시각
      lastEventAt: this.time,
      idleSince: null,
      restSince: null,
      nextIdleAt: 0,
      talkUntil: 0,
      shareCount: 0,
    };
    this.agents.set(key, a);
    return a;
  }

  onSessionStart(s) {
    this.ensureLead(s);
  }

  onPrompt(s, ev) {
    this.finishForeground(s, { clearAlerts: true, keepRecent: true });
    s.pending = []; // 거부·실패한 Agent 호출 기록이 다음 SubagentStart 에 잘못 붙지 않게
    const lead = this.ensureLead(s);
    this.finishSkill(lead);
    this.wake(lead);
    // 결과 공유 연출 중이면 끝난 뒤 「작업 중」으로 돌아오게 예약만 한다 (앞 턴 Stop 이 남긴 「대기」 복귀가 새 턴을 덮지 않게).
    if (lead.status === 'sharing') lead.returnStatus = 'working'; else lead.status = 'working';
    lead.workPose = 'type';
    lead.task = clip(ev.prompt, 60);
    lead.assignment = clip(ev.prompt, 28);
    lead.activity = '요청 내용을 확인 중';
    this.setBrief(lead, '📥 요청 검토 중', true);
    this.say(lead, `📥 업무 접수: ${clip(ev.prompt, 18)}`, 'info', 5000);
    this.pushFeed(`${s.label}: 새 요청 — ${clip(ev.prompt, 40)}`);
  }

  onTool(s, ev) {
    const tool = ev.tool_name;
    const input = ev.tool_input || {};
    const actor = ev.agent_id ? this.ensureSub(s, ev.agent_id, ev.agent_type) : this.ensureLead(s);
    const wasWorking = actor.status === 'working';
    this.wake(actor);
    actor.activity = activitySummary(tool, input);
    // 일하던 중이 아니었다면(대기 중이던 팀장 등) 새 업무처럼 다시 두 줄부터 보여 준다.
    this.setBrief(actor, workBrief(tool, input), !wasWorking);

    if (tool === 'Skill' && input.skill && this.layout.rooms.skills) {
      this.interrupt(actor);
      actor.skill = clip(input.skill, 140);
      actor.finishedAt = null;
      actor.status = 'working'; actor.workPose = 'type';
      actor.task = `스킬 작업: ${actor.skill}`;
      this.allocSeat(actor, 'skills');
      actor.queue.push({ op: 'goSeat', room: 'skills' });
      this.say(actor, `🧩 ${clip(actor.skill, 22)}`, 'work', 6000);
      this.pushFeed(`${s.label}: ${actor.label} · 스킬 ${actor.skill}`);
      return;
    }

    if (!ev.agent_id && (tool === 'Agent' || tool === 'Task')) {
      s.pending.push({ type: input.subagent_type || '', desc: input.description || '', background: input.run_in_background === true || input.run_in_background === 'true' });
      if (s.pending.length > 20) s.pending.shift();
      actor.status = 'working';
      actor.workPose = 'talk';
      const who = displayType(input.subagent_type) || '에이전트';
      this.say(actor, `📣 업무 지시 → ${clip(who, 14)}`, 'info', 3500);
      return;
    }

    if (tool === 'SendMessage' && input.to) {
      const target = this.findByName(s, String(input.to), actor);
      if (target) { this.share(actor, target, true); return; }
    }

    actor.task = toolPhrase(tool, input);
    actor.workPose = toolPose(tool);
    if (actor.status !== 'sharing' && actor.status !== 'reporting') actor.status = 'working';
    this.say(actor, actor.task, 'work', this.timing.bubbleMs);
  }

  onSubStart(s, ev) {
    const a = this.ensureSub(s, ev.agent_id, ev.agent_type);
    const dt = displayType(ev.agent_type);
    const pi = s.pending.findIndex((p) => displayType(p.type) === dt);
    const p = pi >= 0 ? s.pending.splice(pi, 1)[0] : null;
    a.task = p && p.desc ? clip(p.desc, 60) : `${dt || '에이전트'} 작업`;
    a.assignment = p && p.desc ? clip(p.desc, 28) : '';
    a.activity = '맡은 작업 준비 중';
    this.setBrief(a, '🚶 작업 준비 중', true);
    a.background = p ? !!p.background : !this.turnActive(s);
    a.status = 'working';
    this.say(a, `🚶 출근 · ${clip(a.task, 16)}`, 'info', 4000);
    this.pushFeed(`${s.label}: ${a.label} 시작 — ${a.task}`);

    // 메인 Claude 를 거쳐 넘어가는 결과를 「직접 전달」로 연출한다 (사용자 선택 — 가끔 틀릴 수 있음).
    const donor = [...this.agents.values()]
      .filter((x) => x.sessionId === s.id && !x.isLead && x.key !== a.key && x.finishedAt != null
        && this.time - x.finishedAt <= this.timing.handoffWindowMs
        && x.shareCount < this.timing.maxShares && x.status !== 'leaving')
      .sort((x, y) => y.finishedAt - x.finishedAt)[0];
    if (donor) this.share(donor, a, false);
  }

  onSubStop(s, ev) {
    const a = this.agents.get(`${s.id}:${ev.agent_id}`);
    const summary = clip(ev.last_assistant_message, 50);
    if (!a) { this.pushFeed(`${s.label}: ${displayType(ev.agent_type)} 완료${summary ? ' — ' + summary : ''}`); return; }
    a.skill = null;
    a.finishedAt = this.time;
    a.status = 'reporting';
    a.task = '작업 완료 · 보고';
    const lead = this.ensureLead(s);
    this.interrupt(a);
    this.say(a, '📋 보고 중...', 'report', Infinity);
    a.queue.push(
      { op: 'goNear', key: lead.key, dx: 30, dy: 12 },
      { op: 'say', text: '✅ 보고 완료', kind: 'done', ms: 2000 },
      { op: 'sayOther', key: lead.key, text: '👍 수고했어요', kind: 'info', ms: 2200 },
      { op: 'wait', ms: 1400 },
      { op: 'goSeat', room: 'rest' },
      { op: 'status', status: 'resting' },
    );
    this.pushFeed(`${s.label}: ${a.label} 완료${summary ? ' — ' + summary : ''}`);
  }

  onAlert(s, ev, text) {
    const actor = ev.agent_id ? this.ensureSub(s, ev.agent_id, ev.agent_type) : this.ensureLead(s);
    // 확인 요청은 자리로 불러오기만 한다 (팀장을 「작업 중」으로 바꾸지 않음).
    this.wake(actor, actor.isLead ? 'idle' : 'working');
    this.say(actor, text, 'alert', Infinity);
    actor.bubble.blocking = ev.hook_event_name === 'PermissionRequest' || !NON_BLOCKING_NOTIFICATIONS.has(ev.notification_type);
    this.pushFeed(`${s.label}: ${text}`);
  }

  onStop(s, ev = {}) {
    if (ev.agent_id) {
      const actor = this.agents.get(`${s.id}:${ev.agent_id}`);
      if (actor) this.finishSkill(actor);
      return;
    }
    this.finishTurn(s, '✅ 답변 완료');
  }

  // 협업 중 AI 가 오류·중단으로 끝나면 Stop hook 이 오지 않는다 — app.js 가 알려 주면 Stop 과 똑같이 작업을 끝낸다 (말풍선만 text).
  // 살아 있는 세션의 팀장이 있을 때만 한다 (퇴근했거나 끝난 세션이면 무시).
  settle(sessionId, text) {
    this.sync(); // app.js 가 직접 부르므로 창이 멈춰 있던 동안의 시간도 반영한다
    if (!this.isLive(sessionId)) return;
    const s = this.sessions.get(sessionId);
    const lead = this.agents.get(`${sessionId}:lead`);
    if (!lead || lead.status === 'leaving') { this.finishForeground(s); return; } // 팀장이 이미 떠났어도 앞쪽 하위는 정리한다
    this.finishTurn(s, text);
  }

  // 메인 턴을 끝낸다 (Stop · settle 공통): 앞쪽 하위 정리, 팀장은 대기로. 퇴근 시간은 지금부터 잰다.
  finishTurn(s, text) {
    s.lastEventAt = this.time;
    this.finishForeground(s);
    const lead = this.ensureLead(s);
    lead.lastEventAt = this.time;
    this.finishSkill(lead);
    // 결과 공유 연출 중이면 끝난 뒤 「대기」로 돌아가게 예약한다.
    if (lead.status === 'sharing') lead.returnStatus = 'idle'; else lead.status = 'idle';
    lead.task = '다음 요청 대기 중';
    this.say(lead, text, 'done', 6000);
  }

  finishSkill(a) {
    if (!a.skill) return;
    a.skill = null;
    if (a.status === 'sharing' || a.status === 'reporting') {
      for (const op of a.queue) if (op.op === 'goSeat' && op.room === 'skills') op.room = a.isLead ? 'lead' : a.role;
      return;
    }
    this.interrupt(a);
    const room = a.isLead ? 'lead' : a.role;
    this.allocSeat(a, room);
    a.queue.push({ op: 'goSeat', room });
  }

  // 팀장의 턴이 진행 중인가 — 이때 시작한 하위 에이전트는 앞쪽(포그라운드), 턴이 끝난 뒤에 시작·활동하면 백그라운드로 본다.
  turnActive(s) {
    const lead = this.agents.get(`${s.id}:lead`);
    if (!lead) return false;
    if (lead.status === 'sharing') return lead.returnStatus !== 'idle'; // 턴이 끝난 뒤(Stop) 공유 연출 중이면 아니다
    return lead.status === 'working';
  }

  // 메인 턴이 끝났는데(Stop) 또는 새 요청이 왔는데 SubagentStop 을 못 받은 앞쪽(포그라운드) 하위 에이전트를 휴게실로 보낸다.
  // 사용자 중단(Esc)이면 Claude 는 Stop 도 보내지 않으므로 다음 요청에서 정리한다 (clearAlerts: 중단된 확인 요청 말풍선도 지운다).
  // keepRecent: 새 요청 때 방금까지 신호를 보내던(promptKeepMs 안) 하위는 답하는 중 보낸 메시지일 수 있어 그대로 둔다 (확인 요청이 떠 있었다면 중단으로 본다).
  finishForeground(s, { clearAlerts = false, keepRecent = false } = {}) {
    for (const a of this.agents.values()) {
      if (a.sessionId !== s.id || a.isLead || a.background === true) continue;
      if (a.status === 'sharing' && a.finishedAt == null) {
        // 결과 공유 연출은 끝까지 보여 주고, 돌아올 때 자리 대신 휴게실로 보낸다.
        a.returnStatus = 'resting';
        a.skill = null;
        a.task = '작업 종료 · 휴식';
        for (const op of a.queue) if (op.op === 'goSeat') op.room = 'rest';
      } else if (a.status === 'working') {
        const alerting = !!(a.bubble && a.bubble.kind === 'alert');
        if (keepRecent && !alerting && this.time - a.lastEventAt < this.timing.promptKeepMs) continue;
        if (clearAlerts && alerting) a.bubble = null;
        if (this.waitingOnUser(a)) continue;
        if (a.bubble && a.bubble.kind === 'alert') a.bubble = null; // 정리되는 하위의 비차단 알림 말풍선은 남기지 않는다
        this.interrupt(a);
        a.skill = null;
        a.finishedAt = null; // 「결과 공유」 연출의 donor 가 되지 않게
        a.task = '작업 종료 · 휴식';
        a.activity = '';
        a.brief = null;
        this.rest(a);
      }
    }
  }

  findByName(s, name, except) {
    for (const a of this.agents.values()) {
      if (a.sessionId !== s.id || a === except || a.status === 'leaving') continue;
      if (a.name === name || a.label === name || displayType(a.type) === name) return a;
    }
    return null;
  }

  share(from, to, exact) {
    const finished = from.finishedAt != null;
    this.interrupt(from);
    from.status = 'sharing';
    from.shareCount += 1;
    this.say(from, '📨 결과 공유 중...', 'share', Infinity);
    from.queue.push(
      { op: 'goNear', key: to.key, dx: -28, dy: 8 },
      { op: 'say', text: '✅ 전달 완료', kind: 'done', ms: 2200 },
      { op: 'sayOther', key: to.key, text: '👀 결과 확인 중', kind: 'info', ms: 2500 },
      { op: 'wait', ms: 1600 },
    );
    if (finished) {
      from.queue.push({ op: 'goSeat', room: 'rest' }, { op: 'status', status: 'resting' });
    } else {
      from.returnStatus = null;
      from.queue.push({ op: 'goSeat', room: from.skill ? 'skills' : (from.isLead ? 'lead' : from.role) }, { op: 'status', status: '@return' });
    }
    const s = this.sessions.get(from.sessionId);
    this.pushFeed(`${s ? s.label + ': ' : ''}${from.label} → ${to.label} 결과 전달${exact ? '' : ' (추정)'}`);
  }

  // 쉬던 사람이 일을 받으면 자기 자리로 돌아간다.
  wake(a, status = 'working') {
    const home = a.skill ? 'skills' : (a.isLead ? 'lead' : a.role);
    if (a.status === 'sharing' || a.status === 'reporting' || a.status === 'leaving') return;
    if (a.status === 'resting' || a.status === 'away') {
      this.interrupt(a);
      a.queue.push({ op: 'goSeat', room: home });
      a.status = status;
      a.finishedAt = null;
      a.brief = null; // 돌아오면 다시 두 줄로 시작
      return;
    }
    if (a.bubble && a.bubble.kind === 'alert') a.bubble = null;
  }

  interrupt(a) {
    a.path = [];
    a.queue = [];
    a.waitUntil = 0;
  }

  // 작업 말풍선의 한 줄 요약(종류)이 바뀌거나 새 업무를 받으면(force) 다시 두 줄로 펼친다.
  // 같은 종류 도구를 연달아 써도(파일만 바뀜) 펼치지 않는다 — 말풍선이 계속 커지는 것을 막으려는 것.
  setBrief(a, brief, force = false) {
    if (force || a.brief !== brief) { a.brief = brief; a.briefSince = this.time; }
  }

  say(a, text, kind = 'info', ms = this.timing.bubbleMs) {
    a.bubble = { text, kind, until: ms === Infinity ? Infinity : this.time + ms };
  }

  pushFeed(text) {
    const item = { time: this.time, text };
    this.feed.push(item);
    if (this.feed.length > 80) this.feed.shift();
    if (this.onFeed) this.onFeed(item);
  }

  // ───────────────────────── 이동·행동 ─────────────────────────

  allocSeat(a, room) {
    this.releaseSeat(a);
    const r = this.layout.rooms[room];
    const seats = (r && r.seats) || [];
    for (let i = 0; i < seats.length; i++) {
      const k = `${room}:${i}`;
      if (!this.seats.has(k)) {
        this.seats.set(k, a.key);
        a.seat = { room, index: i, x: seats[i].x, y: seats[i].y, facing: seats[i].facing || 'up' };
        return a.seat;
      }
    }
    const p = this.randomPointIn(room);
    a.seat = { room, index: -1, x: p.x, y: p.y, facing: 'down' };
    return a.seat;
  }

  releaseSeat(a) {
    if (a.seat && a.seat.index >= 0) {
      const k = `${a.seat.room}:${a.seat.index}`;
      if (this.seats.get(k) === a.key) this.seats.delete(k);
    }
    a.seat = null;
  }

  randomPointIn(room) {
    const r = this.layout.rooms[room];
    const area = r.wander || { x: r.x + 30, y: r.y + 60, w: Math.max(10, r.w - 60), h: Math.max(10, r.h - 90) };
    return { x: area.x + this.random() * area.w, y: area.y + this.random() * area.h };
  }

  // 방 → 문 → 복도 → 문 → 방. 배치도가 「위·아래 줄 방 + 가운데 복도」라는 전제.
  route(a, to, toRoom) {
    if (this.navigation) {
      const path = this.navigation.findPath(a, to);
      // A reserved sofa seat is reached from its walkable approach cell.
      if (path.length && toRoom && this.layout.rooms[toRoom]?.seats.some(s => s.x === to.x && s.y === to.y)) {
        const last = path[path.length - 1];
        if (last.x !== to.x || last.y !== to.y) path.push({ x: to.x, y: to.y });
      }
      return path;
    }
    const rooms = this.layout.rooms;
    const hy = this.layout.hallway.y;
    const fromRoom = this.roomAt(a.x, a.y);
    if (fromRoom && fromRoom === toRoom) return [to];
    const pts = [];
    if (fromRoom) {
      const d = rooms[fromRoom].door;
      pts.push({ x: d.x, y: d.y }, { x: d.x, y: hy });
    } else {
      pts.push({ x: a.x, y: hy });
    }
    if (toRoom) {
      const d = rooms[toRoom].door;
      pts.push({ x: d.x, y: hy }, { x: d.x, y: d.y });
    }
    pts.push({ x: to.x, y: to.y });
    return pts;
  }

  walkTo(a, point, toRoom) {
    a.path = this.route(a, point, toRoom === undefined ? this.roomAt(point.x, point.y) : toRoom);
  }

  exec(a, op) {
    switch (op.op) {
      case 'goSeat': {
        const seat = a.seat && a.seat.room === op.room ? a.seat : this.allocSeat(a, op.room);
        this.walkTo(a, seat, op.room);
        break;
      }
      case 'goTo':
        if (op.release) this.releaseSeat(a);
        this.walkTo(a, op.point);
        break;
      case 'goNear': {
        const t = this.agents.get(op.key);
        if (!t) break;
        const base = t.seat || t;
        this.releaseSeat(a);
        const p = { x: base.x + (op.dx ?? 26), y: base.y + (op.dy ?? 0) };
        this.walkTo(a, p, this.roomAt(base.x, base.y));
        break;
      }
      case 'say':
        // 예약된 연출 문구가 확인 요청(경고) 말풍선을 덮지 않게 한다.
        if (!(a.bubble && a.bubble.kind === 'alert' && op.kind !== 'alert')) this.say(a, op.text, op.kind, op.ms);
        break;
      case 'sayOther': {
        const t = this.agents.get(op.key);
        if (t && !(t.bubble && t.bubble.kind === 'alert')) this.say(t, op.text, op.kind, op.ms);
        break;
      }
      case 'wait': a.waitUntil = this.time + op.ms; break;
      case 'status':
        if (op.status === '@return') {
          a.status = a.returnStatus || 'working'; a.returnStatus = null;
          if (a.status === 'resting') { a.restSince = this.time; a.nextIdleAt = this.time + this.idleDelay(); } // rest() 와 같은 값
          break;
        }
        a.status = op.status;
        if (op.status === 'resting') { a.restSince = this.time; a.nextIdleAt = this.time + this.idleDelay(); }
        break;
      case 'leave':
        this.releaseSeat(a);
        this.walkTo(a, this.layout.entrance, null);
        a.queue.unshift({ op: 'remove' });
        break;
      case 'remove':
        this.releaseSeat(a);
        this.agents.delete(a.key);
        break;
      default: break;
    }
  }

  step(a, dt) {
    if (a.path.length) {
      let budget = (this.timing.speed * dt) / 1000;
      while (budget > 0 && a.path.length) {
        const p = a.path[0];
        const dx = p.x - a.x;
        const dy = p.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d > 0.01) a.facing = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
        if (d <= budget) { a.x = p.x; a.y = p.y; a.path.shift(); budget -= d; } else { a.x += (dx / d) * budget; a.y += (dy / d) * budget; budget = 0; }
      }
      if (a.path.length) return;
      if (a.seat && Math.hypot(a.x - a.seat.x, a.y - a.seat.y) < 1) a.facing = a.seat.facing;
    }
    while (a.queue.length && !a.path.length && a.waitUntil <= this.time && this.agents.has(a.key)) {
      this.exec(a, a.queue.shift());
    }
  }

  idleDelay() {
    const { idleMinMs, idleMaxMs } = this.timing;
    return idleMinMs + this.random() * (idleMaxMs - idleMinMs);
  }

  idle(a) {
    if (a.path.length || a.queue.length || a.waitUntil > this.time) return;

    if (a.isLead && a.status === 'idle') {
      if (a.bubble && a.bubble.kind === 'alert') return; // 사용자 확인을 기다리는 동안은 자리를 지킨다
      const s = this.sessions.get(a.sessionId);
      if (s && this.time - s.lastEventAt > this.timing.leadIdleToRestMs) {
        a.status = 'away';
        a.restSince = this.time;
        a.nextIdleAt = this.time + this.idleDelay();
        a.queue.push({ op: 'say', text: '☕ 잠깐 휴식', kind: 'chat', ms: 3000 }, { op: 'goSeat', room: 'rest' });
      }
      return;
    }

    if (a.status !== 'resting' && a.status !== 'away') return;
    if (this.time < a.nextIdleAt) return;
    a.nextIdleAt = this.time + this.idleDelay();

    const r = this.random();
    if (r < 0.45) {
      a.queue.push({ op: 'goTo', point: this.randomPointIn('rest'), release: true });
    } else if (r < 0.8) {
      const mate = [...this.agents.values()].find((b) => b !== a && (b.status === 'resting' || b.status === 'away')
        && !b.path.length && b.talkUntil <= this.time && this.roomAt(b.x, b.y) === 'rest');
      if (mate) {
        const line = CHAT[Math.floor(this.random() * CHAT.length)];
        const reply = CHAT[Math.floor(this.random() * CHAT.length)];
        a.talkUntil = mate.talkUntil = this.time + 2600;
        a.facing = mate.x < a.x ? 'left' : 'right';
        mate.facing = a.x < mate.x ? 'left' : 'right';
        this.say(a, line, 'chat', 2600);
        mate.queue.push({ op: 'wait', ms: 900 }, { op: 'say', text: reply, kind: 'chat', ms: 2400 });
      } else {
        a.queue.push({ op: 'goSeat', room: 'rest' });
      }
    } else {
      a.queue.push({ op: 'goSeat', room: 'rest' });
    }
  }

  poseOf(a) {
    if (a.path.length) return 'walk';
    if (a.talkUntil > this.time) return 'talk';
    if (a.bubble && a.bubble.kind === 'alert') return 'alert';
    const atSeat = a.seat && a.seat.index >= 0 && Math.hypot(a.x - a.seat.x, a.y - a.seat.y) < 2;
    if (!atSeat) return 'stand';
    if (a.status === 'working' && SITTING_ROOMS.has(a.seat.room)) return a.workPose || 'type';
    return 'sit';
  }
}
