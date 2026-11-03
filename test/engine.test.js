import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfficeEngine } from '../src/renderer/office/engine.js';
import { workBrief } from '../src/renderer/office/phrases.js';
import layout from '../src/renderer/themes/mockup/layout.js';

const SID = 'sess-1';

function seeded(seed = 1) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

function mk(timing = {}) {
  const feed = [];
  const e = new OfficeEngine(layout, { random: seeded(), timing, onFeed: (f) => feed.push(f.text) });
  return { e, feed };
}

function run(e, ms, step = 50) {
  for (let t = 0; t < ms; t += step) e.update(step);
}

function ev(name, extra = {}) {
  return { session_id: SID, cwd: 'C:\\work\\proj', hook_event_name: name, ...extra };
}

function agent(e, id) {
  return e.agents.get(`${SID}:${id}`);
}

test('어떤 이벤트든 오면 팀장이 출근해 팀장실 자리에 앉는다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: '테스트 보강해줘' }), { label: 'proj' });
  run(e, 20000);
  const lead = agent(e, 'lead');
  assert.equal(lead.label, 'proj');
  assert.equal(e.roomAt(lead.x, lead.y), 'lead');
  assert.equal(lead.status, 'working');
});

test('하위 에이전트는 종류에 맞는 방으로 출근한다', () => {
  const { e } = mk();
  const cases = [['a1', 'Explore', 'analysis'], ['a2', 'oh-my-claudecode:executor', 'dev'],
    ['a3', 'senior-reviewer', 'review'], ['a4', 'Plan', 'planning'], ['a5', 'cross-checker', 'review'], ['a6', 'dba', 'dev']];
  for (const [id, type] of cases) e.handleEvent(ev('SubagentStart', { agent_id: id, agent_type: type }));
  run(e, 30000);
  for (const [id, , room] of cases) {
    const a = agent(e, id);
    assert.equal(e.roomAt(a.x, a.y), room, `${id} → ${room}`);
  }
  assert.equal(agent(e, 'a2').label, 'executor');
});

test('Agent 도구 호출의 설명이 하위 에이전트 작업명으로 붙는다', () => {
  const { e } = mk();
  e.handleEvent(ev('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'Explore', description: '폴더 구조 파악' } }));
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'Explore' }));
  assert.equal(agent(e, 'x1').task, '폴더 구조 파악');
});

test('하위 에이전트의 도구 호출은 그 에이전트 말풍선으로 표시된다', () => {
  const { e } = mk();
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  e.handleEvent(ev('PreToolUse', { agent_id: 'x1', agent_type: 'executor', tool_name: 'Edit', tool_input: { file_path: 'C:\\a\\Foo.kt' } }));
  const a = agent(e, 'x1');
  assert.match(a.bubble.text, /수정 중: Foo\.kt/);
  run(e, 30000);
  assert.equal(e.snapshot().find((s) => s.id === a.key).pose, 'type');
});

test('작업이 끝나면 팀장에게 보고한 뒤 휴게실로 간다', () => {
  const { e, feed } = mk();
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'Explore' }));
  run(e, 20000);
  e.handleEvent(ev('SubagentStop', { agent_id: 'x1', agent_type: 'Explore', last_assistant_message: '파일 3개' }));
  const a = agent(e, 'x1');
  assert.equal(a.bubble.text, '📋 보고 중...');
  let visitedLead = false;
  for (let t = 0; t < 40000; t += 50) {
    e.update(50);
    if (e.roomAt(a.x, a.y) === 'lead') visitedLead = true;
  }
  assert.ok(visitedLead, '팀장실을 거쳐야 한다');
  assert.equal(a.status, 'resting');
  assert.equal(e.roomAt(a.x, a.y), 'rest');
  assert.ok(feed.some((f) => f.includes('Explore 완료 — 파일 3개')));
});

test('끝난 직후 다음 에이전트가 시작하면 결과 공유(추정)로 그 자리까지 간다', () => {
  const { e, feed } = mk();
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'Explore' }));
  run(e, 20000);
  e.handleEvent(ev('SubagentStop', { agent_id: 'x1', agent_type: 'Explore' }));
  run(e, 3000);
  e.handleEvent(ev('SubagentStart', { agent_id: 'x2', agent_type: 'executor' }));
  const donor = agent(e, 'x1');
  const target = agent(e, 'x2');
  assert.equal(donor.status, 'sharing');
  assert.equal(donor.bubble.text, '📨 결과 공유 중...');
  let reached = false;
  for (let t = 0; t < 40000; t += 50) {
    e.update(50);
    if (Math.hypot(donor.x - target.seat.x, donor.y - target.seat.y) < 40) reached = true;
  }
  assert.ok(reached, '받는 사람 자리까지 가야 한다');
  assert.equal(donor.status, 'resting');
  assert.ok(feed.some((f) => f.includes('Explore → executor 결과 전달 (추정)')));
});

test('공유 대기 시간이 지나면 결과 공유로 연출하지 않는다', () => {
  const { e } = mk({ handoffWindowMs: 5000 });
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'Explore' }));
  e.handleEvent(ev('SubagentStop', { agent_id: 'x1', agent_type: 'Explore' }));
  run(e, 8000);
  e.handleEvent(ev('SubagentStart', { agent_id: 'x2', agent_type: 'executor' }));
  assert.notEqual(agent(e, 'x1').status, 'sharing');
});

test('SendMessage 는 정확한 직접 전달로 표시된다', () => {
  const { e, feed } = mk();
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'analyst' }));
  e.handleEvent(ev('SubagentStart', { agent_id: 'x2', agent_type: 'executor' }));
  run(e, 20000);
  e.handleEvent(ev('PreToolUse', { agent_id: 'x1', agent_type: 'analyst', tool_name: 'SendMessage', tool_input: { to: 'executor', message: 'hi' } }));
  assert.equal(agent(e, 'x1').status, 'sharing');
  assert.ok(feed.some((f) => f.endsWith('analyst → executor 결과 전달')));
  run(e, 40000);
  assert.equal(e.roomAt(agent(e, 'x1').x, agent(e, 'x1').y), 'analysis', '일하던 사람은 자기 방으로 돌아온다');
});

const MIN = 60000;

test('하위 에이전트는 작업이 끝나고 1분 동안 일이 없으면 퇴근한다', () => {
  const { e } = mk();
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'Explore' }));
  run(e, 15000);
  e.handleEvent(ev('SubagentStop', { agent_id: 'x1', agent_type: 'Explore' }));
  run(e, 59000, 250);
  assert.equal(agent(e, 'x1').status, 'resting', '1분 전에는 휴게실에 남는다');
  run(e, 2000, 250);
  assert.equal(agent(e, 'x1').status, 'leaving', '1분이 지나면 퇴근길에 오른다');
  run(e, MIN, 250);
  assert.equal(agent(e, 'x1'), undefined);
});

test('팀장은 답변 완료 후 3분 동안 일이 없으면 퇴근하고, 다시 요청이 오면 같은 외형으로 출근한다', () => {
  const { e } = mk({ leadIdleToRestMs: 20000 });
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }), { label: 'proj' });
  e.handleEvent(ev('Stop'), { label: 'proj' });
  const look = agent(e, 'lead').appearance;
  run(e, 179000, 250);
  assert.equal(agent(e, 'lead').status, 'away', '3분 전에는 휴게실에 남는다');
  run(e, 2000, 250);
  assert.equal(agent(e, 'lead').status, 'leaving', '3분이 지나면 퇴근길에 오른다');
  run(e, MIN, 250);
  assert.equal(agent(e, 'lead'), undefined);
  e.handleEvent(ev('UserPromptSubmit', { prompt: '다음 일' }), { label: 'proj' });
  assert.deepEqual(agent(e, 'lead').appearance, look);
});

test('백그라운드 에이전트가 일하는 동안 팀장은 퇴근하지 않는다', () => {
  const { e } = mk({ leadIdleToRestMs: 20000 });
  e.handleEvent(ev('Stop'));
  e.handleEvent(ev('SubagentStart', { agent_id: 'bg', agent_type: 'executor' }));
  for (let i = 0; i < 30; i++) {
    run(e, MIN, 250);
    e.handleEvent(ev('PreToolUse', { agent_id: 'bg', agent_type: 'executor', tool_name: 'Read', tool_input: { file_path: 'a.js' } }));
  }
  assert.ok(agent(e, 'lead'));
  assert.notEqual(agent(e, 'lead').status, 'leaving');
});

test('팀장이 사용자 확인을 기다리는 동안은 3분이 지나도 퇴근하지 않는다', () => {
  const { e } = mk();
  e.handleEvent(ev('PermissionRequest', { tool_name: 'Bash' }), { label: 'proj' });
  run(e, 45 * MIN, 250);
  assert.ok(agent(e, 'lead'));
  assert.equal(agent(e, 'lead').bubble.kind, 'alert');
});

test('권한 요청은 해제될 때까지 남는 경고 말풍선을 띄운다', () => {
  const { e } = mk();
  e.handleEvent(ev('PermissionRequest', { tool_name: 'Bash' }));
  run(e, 60000);
  assert.equal(agent(e, 'lead').bubble.kind, 'alert');
  e.handleEvent(ev('PreToolUse', { tool_name: 'Bash', tool_input: { description: '테스트 실행' } }));
  assert.equal(agent(e, 'lead').bubble.kind, 'work');
});

test('한가한 팀장은 휴게실에 갔다가 일이 오면 돌아온다', () => {
  const { e } = mk({ leadIdleToRestMs: 10000 });
  e.handleEvent(ev('Stop'));
  run(e, 40000);
  const lead = agent(e, 'lead');
  assert.equal(e.roomAt(lead.x, lead.y), 'rest');
  e.handleEvent(ev('UserPromptSubmit', { prompt: '다음 일' }));
  run(e, 30000);
  assert.equal(e.roomAt(lead.x, lead.y), 'lead');
});

test('세션이 끝나면 모두 휴게실에 모였다가 1분 뒤 다 같이 퇴근한다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }));
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'Explore' }));
  e.handleEvent(ev('SubagentStart', { agent_id: 'x2', agent_type: 'executor' }));
  run(e, 5000);
  e.endSession(SID);
  run(e, MIN - 1000, 250);
  const crew = [...e.agents.values()];
  assert.equal(crew.length, 3);
  for (const a of crew) {
    assert.notEqual(a.status, 'leaving', `${a.label} 는 1분 전에 떠나지 않는다`);
    assert.equal(e.roomAt(a.x, a.y), 'rest', `${a.label} 는 휴게실에서 기다린다`);
  }
  run(e, 2000, 250);
  assert.ok(crew.every((a) => a.status === 'leaving'), '같은 순간에 함께 퇴근한다');
  run(e, MIN, 250);
  assert.equal(e.agents.size, 0);
});

test('끝난 세션에 늦게 도착한 신호로는 아무도 다시 출근하지 않는다', () => {
  const { e } = mk();
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'Explore' }));
  e.endSession(SID);
  e.handleEvent(ev('PreToolUse', { agent_id: 'x1', agent_type: 'Explore', tool_name: 'Read', tool_input: { file_path: 'a.js' } }));
  e.handleEvent(ev('Stop'));
  assert.equal(agent(e, 'lead'), undefined);
  assert.notEqual(agent(e, 'x1').status, 'working');
  run(e, 2 * MIN, 250);
  e.handleEvent(ev('SubagentStart', { agent_id: 'x2', agent_type: 'executor' }));
  assert.equal(e.agents.size, 0);
});

test('끝난 세션도 다시 시작(SessionStart)하면 정상으로 돌아온다', () => {
  const { e } = mk();
  e.handleEvent(ev('Stop'));
  e.endSession(SID);
  run(e, 30000, 250); // 퇴근 유예(1분) 안에서 다시 시작한다
  e.handleEvent(ev('SessionStart', { source: 'resume' }));
  assert.ok(agent(e, 'lead'));
  run(e, 2 * MIN, 250);
  assert.ok(agent(e, 'lead'), '다시 시작한 세션은 1분 뒤 퇴근 예약이 남지 않는다');
});

test('같은 종류 여러 명은 번호로 구분하고 자리가 겹치지 않는다', () => {
  const { e } = mk();
  for (const id of ['p1', 'p2', 'p3']) e.handleEvent(ev('SubagentStart', { agent_id: id, agent_type: 'executor' }));
  assert.deepEqual(['p1', 'p2', 'p3'].map((id) => agent(e, id).label), ['executor', 'executor #2', 'executor #3']);
  const seats = new Set(['p1', 'p2', 'p3'].map((id) => `${agent(e, id).seat.room}:${agent(e, id).seat.index}`));
  assert.equal(seats.size, 3);
});

test('외부 세션은 폴더 이름으로 표시된다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }));
  assert.equal(agent(e, 'lead').label, '외부 · proj');
});

test('끝 이벤트 없이 조용해진 외부 세션은 모두 퇴근한 뒤 기록이 정리된다 (앱 탭 세션 기록은 유지)', () => {
  const { e } = mk({ externalSessionIdleMs: 60000, idleLeaveMs: 120000 });
  e.handleEvent(ev('Stop'));
  e.handleEvent({ ...ev('Stop'), session_id: 'tab-sess' }, { label: '내 탭' });
  run(e, 100000, 100);
  assert.ok(e.sessions.has(SID), '사람이 남아 있는 동안은 기록을 지우지 않는다');
  run(e, 100000, 100);
  assert.equal(agent(e, 'lead'), undefined);
  assert.equal(e.sessions.has(SID), false);
  assert.ok(e.sessions.has('tab-sess'));
});

test('신호가 끊긴 작업 중 하위 에이전트는 5분 뒤 휴게실, 휴게실에 간 지 1분 뒤 퇴근한다', () => {
  const { e } = mk();
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  run(e, 5 * MIN + 10000, 250);
  const a = agent(e, 'x1');
  assert.equal(a.status, 'resting');
  assert.equal(e.roomAt(a.x, a.y), 'rest');
  run(e, 30000, 250);
  assert.ok(agent(e, 'x1'), '휴게실로 간 뒤 1분 전에는 남는다');
  run(e, 2 * MIN, 250);
  assert.equal(agent(e, 'x1'), undefined);
});

test('신호가 끊긴 작업 중 팀장도 20분 뒤 휴게실, 휴게실에 간 지 3분 뒤 퇴근한다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: '오래 걸리는 일' }));
  run(e, 21 * MIN, 250);
  const lead = agent(e, 'lead');
  assert.equal(lead.status, 'away');
  assert.equal(e.roomAt(lead.x, lead.y), 'rest');
  run(e, 2 * MIN, 250);
  assert.ok(agent(e, 'lead'), '휴게실로 간 뒤 3분 전에는 남는다');
  run(e, 2 * MIN, 250);
  assert.equal(agent(e, 'lead'), undefined);
});

test('확인을 기다리는 하위 에이전트는 신호가 없어도 휴게실로 가지 않는다', () => {
  const { e } = mk();
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }), { label: 'proj' });
  e.handleEvent(ev('PermissionRequest', { agent_id: 'x1', agent_type: 'executor', tool_name: 'Bash' }), { label: 'proj' });
  run(e, 45 * MIN, 250);
  assert.equal(agent(e, 'x1').status, 'working');
  assert.equal(agent(e, 'x1').bubble.kind, 'alert');
});

test('화면이 멈춘 동안에도 퇴근 시간은 실제 시계로 잰다', () => {
  let clock = 0;
  const e = new OfficeEngine(layout, { random: seeded(), now: () => clock });
  e.handleEvent(ev('SubagentStart', { agent_id: 'busy', agent_type: 'executor' }));
  e.handleEvent(ev('SubagentStart', { agent_id: 'done', agent_type: 'Explore' }));
  e.handleEvent(ev('SubagentStop', { agent_id: 'done', agent_type: 'Explore' }));
  // 창이 최소화돼 update() 가 불리지 않는 30분 동안에도 hook 신호는 계속 들어온다.
  for (let i = 0; i < 30; i++) {
    clock += MIN;
    e.handleEvent(ev('PreToolUse', { agent_id: 'busy', agent_type: 'executor', tool_name: 'Edit', tool_input: { file_path: 'a.js' } }));
  }
  e.update(16);
  assert.equal(agent(e, 'busy').status, 'working', '계속 신호를 보낸 에이전트는 일하는 중으로 남는다');
  // 창이 돌아오면 멈춰 있던 보고를 마저 하고, 이미 1분이 훨씬 지났으므로 곧바로 퇴근한다.
  for (let t = 0; t < MIN; t += 50) { clock += 50; e.update(50); }
  assert.equal(agent(e, 'done'), undefined);
  assert.equal(agent(e, 'busy').status, 'working');
});

test('답변 후 「입력 대기」 알림(idle_prompt)은 팀장 퇴근을 막지 않는다', () => {
  const { e } = mk({ leadIdleToRestMs: 20000 });
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }));
  e.handleEvent(ev('Stop'));
  run(e, MIN, 250);
  e.handleEvent(ev('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }));
  run(e, 22 * MIN, 250);
  assert.equal(agent(e, 'lead'), undefined);
});

test('하위 에이전트가 확인을 기다리는 동안 팀장도 퇴근하지 않는다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }), { label: 'proj' });
  e.handleEvent(ev('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'executor', description: 'y' } }), { label: 'proj' });
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }), { label: 'proj' });
  e.handleEvent(ev('PermissionRequest', { agent_id: 'x1', agent_type: 'executor', tool_name: 'Bash' }), { label: 'proj' });
  run(e, 45 * MIN, 250);
  assert.ok(agent(e, 'lead'));
  assert.equal(agent(e, 'lead').status, 'working');
});

test('확인 대기 중 끊긴 외부 세션도 결국 모두 퇴근하고 기록이 정리된다', () => {
  const { e } = mk();
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  e.handleEvent(ev('PermissionRequest', { agent_id: 'x1', agent_type: 'executor', tool_name: 'Bash' }));
  run(e, 75 * MIN, 250);
  assert.equal(e.agents.size, 0);
  assert.equal(e.sessions.has(SID), false);
});

test('세션 종료 시각도 실제 시계로 잰다 (창이 멈춘 뒤 종료돼도 1분을 기다린다)', () => {
  let clock = 0;
  const e = new OfficeEngine(layout, { random: seeded(), now: () => clock });
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }), { label: 'proj' });
  clock += 10 * MIN; // 창이 최소화된 동안 claude 가 종료됨
  e.endSession(SID);
  const tick = (ms) => { for (let t = 0; t < ms; t += 50) { clock += 50; e.update(50); } };
  tick(50000);
  assert.notEqual(agent(e, 'x1').status, 'leaving');
  tick(20000);
  assert.ok(!agent(e, 'x1') || agent(e, 'x1').status === 'leaving', '1분이 지나면 퇴근한다');
});

test('외부 세션 기록이 지워진 뒤 다시 와도 팀장 외형은 같다', () => {
  const { e } = mk();
  e.handleEvent(ev('Stop'));
  const look = agent(e, 'lead').appearance;
  run(e, 40 * MIN, 250);
  assert.equal(e.sessions.has(SID), false);
  e.handleEvent(ev('UserPromptSubmit', { prompt: '다시' }));
  assert.deepEqual(agent(e, 'lead').appearance, look);
});

test('퇴근 대기 중 다시 시작한 세션은 「세션 종료」 작업명이 남지 않는다', () => {
  const { e } = mk();
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  e.endSession(SID);
  e.handleEvent(ev('SessionStart', { source: 'resume' }));
  assert.ok([...e.agents.values()].every((a) => !a.task.includes('세션 종료')));
});

test('실제 시계를 써도 update(dt) 로 빨리 감을 수 있다 (화면 검증 스크립트용)', () => {
  const e = new OfficeEngine(layout, { random: seeded(), now: () => 0 });
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'Explore' }));
  run(e, 20000);
  e.handleEvent(ev('SubagentStop', { agent_id: 'x1', agent_type: 'Explore' }));
  run(e, 40000);
  assert.equal(agent(e, 'x1').status, 'resting');
});

test('팀장 결과 공유 중 Stop 이 오면 공유 후 대기 상태가 된다', () => {
  const { e } = mk({ leadIdleToRestMs: 20000 });
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }));
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  run(e, 15000);
  e.handleEvent(ev('PreToolUse', { tool_name: 'SendMessage', tool_input: { to: 'executor' } }));
  e.handleEvent(ev('Stop'));
  run(e, 25000);
  assert.equal(agent(e, 'lead').status === 'idle' || agent(e, 'lead').status === 'away', true);
  run(e, 60000);
  assert.equal(agent(e, 'lead').status, 'away', '대기 후 휴식으로 넘어가야 한다');
});

test('휴식 중인 팀장에게 확인 요청이 오면 자리로 오되 작업 중으로 바뀌지 않는다', () => {
  const { e } = mk({ leadIdleToRestMs: 10000 });
  e.handleEvent(ev('Stop'));
  run(e, 40000);
  e.handleEvent(ev('Notification', { message: '입력을 기다립니다' }));
  run(e, 20000);
  const lead = agent(e, 'lead');
  assert.equal(lead.status, 'idle');
  assert.equal(e.roomAt(lead.x, lead.y), 'lead');
  assert.equal(lead.bubble.kind, 'alert');
});

test('배치도를 바꿔도 사람은 같은 방에 남는다', () => {
  const { e } = mk();
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'senior-reviewer' }));
  run(e, 20000);
  e.setLayout(layout);
  const a = agent(e, 'x1');
  assert.equal(e.roomAt(a.x, a.y), 'review');
});

test('setAttention: 말풍선이 사라진 뒤에도 확인할 내용을 깜빡임 표시와 함께 보여 준다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }), { label: 'p' });
  e.handleEvent(ev('Stop'));
  e.setAttention([{ sessionId: SID, agentId: null, text: '✅ 답변 완료', kind: 'done' }]);
  run(e, 10000);
  const lead = e.snapshot().find((a) => a.id === `${SID}:lead`);
  assert.deepEqual(lead.bubble, { text: '✅ 답변 완료', kind: 'done', attention: true });
});

test('확인 요청 말풍선은 엔진 문구를 유지하고, 작업 요약은 확인 내용으로 바꾼다', () => {
  const { e } = mk();
  e.handleEvent(ev('PermissionRequest', { tool_name: 'Bash' }));
  e.setAttention([{ sessionId: SID, agentId: null, text: '❓ 권한 확인', kind: 'alert' }]);
  run(e, 1000);
  const bubble = e.snapshot().find((a) => a.id === `${SID}:lead`).bubble;
  assert.equal(bubble.kind, 'alert');
  assert.equal(bubble.attention, true);
  assert.ok(bubble.text.includes('Bash'), bubble.text);

  const { e: q } = mk();
  q.handleEvent(ev('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: {} }));
  q.setAttention([{ sessionId: SID, agentId: null, text: '❓ 선택을 기다려요', kind: 'alert' }]);
  run(q, 1000);
  const asked = q.snapshot().find((a) => a.id === `${SID}:lead`).bubble;
  assert.equal(asked.text, '❓ 선택을 기다려요');
  assert.equal(asked.attention, true);
});

test('확인 필요 표시는 퇴근을 막지 않는다', () => {
  const { e } = mk({ idleLeaveMs: 60000 });
  e.handleEvent(ev('Stop'));
  e.setAttention([{ sessionId: SID, agentId: null, text: '✅ 답변 완료', kind: 'done' }]);
  run(e, 60000 + 60000);
  const lead = agent(e, 'lead');
  assert.ok(!lead || lead.status === 'leaving', lead?.status);
  if (lead) assert.ok(!e.snapshot().find((a) => a.id === `${SID}:lead`).bubble?.attention);
});

test('완료 표시 뒤 「입력 대기」 알림이 와도 완료 내용을 그대로 보여 준다', () => {
  const { e } = mk();
  e.handleEvent(ev('Stop'));
  e.setAttention([{ sessionId: SID, agentId: null, text: '✅ 답변 완료', kind: 'done' }]);
  e.handleEvent(ev('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }));
  assert.deepEqual(e.snapshot().find((a) => a.id === `${SID}:lead`).bubble, { text: '✅ 답변 완료', kind: 'done', attention: true });
});

test('setAttention 은 하위 에이전트도 가리키고, 빈 목록이면 지운다', () => {
  const { e } = mk();
  e.handleEvent(ev('SubagentStart', { agent_id: 'a1', agent_type: 'executor' }));
  run(e, 5000);
  e.setAttention([{ sessionId: SID, agentId: 'a1', text: '❓ 권한 확인', kind: 'alert' }]);
  const by = () => Object.fromEntries(e.snapshot().map((a) => [a.id, a.bubble]));
  assert.equal(by()[`${SID}:a1`]?.attention, true);
  assert.ok(!by()[`${SID}:lead`]?.attention);
  e.setAttention([]);
  assert.ok(Object.values(by()).every((b) => !b?.attention));
});

// ───────────────────────── 하위 에이전트 정리 · 말풍선 축약 ─────────────────────────

const delegate = (extra = {}) => ev('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'executor', description: '화면 구성 개선', ...extra } });
const bubbleOf = (e, id) => e.snapshot().find((a) => a.id === `${SID}:${id}`).bubble;

test('앞쪽(포그라운드) 하위 에이전트는 SubagentStop 이 없어도 메인 Stop 에 휴게실로 간다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }));
  e.handleEvent(delegate());
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  run(e, 5000);
  e.handleEvent(ev('Stop'));
  const a = agent(e, 'x1');
  assert.equal(a.status, 'resting');
  assert.equal(a.skill, null);
  assert.equal(a.task, '작업 종료 · 휴식');
  assert.equal(a.finishedAt, null);
  run(e, 30000);
  assert.equal(e.roomAt(a.x, a.y), 'rest');
});

test('run_in_background 로 시작한 하위 에이전트는 메인 Stop 뒤에도 일한다 (문자열·불리언 모두)', () => {
  for (const flag of ['true', true]) {
    const { e } = mk();
    e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }));
    e.handleEvent(delegate({ run_in_background: flag }));
    e.handleEvent(ev('SubagentStart', { agent_id: 'bg', agent_type: 'executor' }));
    e.handleEvent(ev('Stop'));
    assert.equal(agent(e, 'bg').background, true);
    assert.equal(agent(e, 'bg').status, 'working', String(flag));
  }
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }));
  e.handleEvent(delegate({ run_in_background: 'false' }));
  e.handleEvent(ev('SubagentStart', { agent_id: 'fg', agent_type: 'executor' }));
  e.handleEvent(ev('Stop'));
  assert.equal(agent(e, 'fg').status, 'resting');
});

test('메인 턴이 끝난 뒤 Agent 호출 기록 없이 시작한 하위 에이전트는 백그라운드로 보고 다음 Stop 에도 정리하지 않는다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }));
  e.handleEvent(ev('Stop'));
  e.handleEvent(ev('SubagentStart', { agent_id: 'bg', agent_type: 'executor' }));
  assert.equal(agent(e, 'bg').background, true);
  e.handleEvent(ev('UserPromptSubmit', { prompt: '다음' }));
  e.handleEvent(ev('Stop'));
  assert.equal(agent(e, 'bg').status, 'working');
});

test('포그라운드로 시작했어도 메인 Stop 뒤에 활동하면 백그라운드가 되어 다음 Stop 에 정리되지 않는다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }));
  e.handleEvent(delegate());
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  assert.equal(agent(e, 'x1').background, false);
  e.handleEvent(ev('Stop'));
  assert.equal(agent(e, 'x1').status, 'resting');
  e.handleEvent(ev('PreToolUse', { agent_id: 'x1', agent_type: 'executor', tool_name: 'Read', tool_input: { file_path: 'a.js' } }));
  assert.equal(agent(e, 'x1').background, true);
  assert.equal(agent(e, 'x1').status, 'working');
  e.handleEvent(ev('UserPromptSubmit', { prompt: '다음' }));
  e.handleEvent(ev('Stop'));
  assert.equal(agent(e, 'x1').status, 'working');
});

test('Stop 없이(사용자 중단) 새 요청이 오면 앞쪽 하위 에이전트를 정리하고 오래된 Agent 호출 기록도 지운다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }));
  e.handleEvent(delegate({ description: '거부된 호출' }));
  e.handleEvent(delegate());
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  assert.equal(agent(e, 'x1').task, '거부된 호출');
  run(e, 15000); // 신호가 끊긴 지 promptKeepMs 가 지나야 중단된 것으로 본다
  e.handleEvent(ev('UserPromptSubmit', { prompt: '다시 해줘' }));
  assert.equal(agent(e, 'x1').status, 'resting');
  e.handleEvent(ev('SubagentStart', { agent_id: 'x2', agent_type: 'executor' }));
  assert.equal(agent(e, 'x2').task, 'executor 작업', '지난 요청의 Agent 호출 기록이 붙지 않는다');
});

test('결과를 공유하던 앞쪽 하위 에이전트는 연출을 마친 뒤 자리 대신 휴게실로 간다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }));
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'analyst' }));
  e.handleEvent(ev('SubagentStart', { agent_id: 'x2', agent_type: 'executor' }));
  run(e, 20000);
  e.handleEvent(ev('PreToolUse', { agent_id: 'x1', agent_type: 'analyst', tool_name: 'SendMessage', tool_input: { to: 'executor', message: 'hi' } }));
  assert.equal(agent(e, 'x1').status, 'sharing');
  e.handleEvent(ev('Stop'));
  assert.equal(agent(e, 'x1').status, 'sharing', '연출은 끝까지 보여 준다');
  run(e, 40000);
  const a = agent(e, 'x1');
  assert.equal(a.status, 'resting');
  assert.equal(e.roomAt(a.x, a.y), 'rest');
});

test('사용자 확인을 기다리는 하위 에이전트는 메인 Stop 에도 정리하지 않는다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }));
  e.handleEvent(delegate());
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  e.handleEvent(ev('PermissionRequest', { agent_id: 'x1', agent_type: 'executor', tool_name: 'Bash' }));
  e.handleEvent(ev('Stop'));
  assert.equal(agent(e, 'x1').status, 'working');
  assert.equal(agent(e, 'x1').bubble.kind, 'alert');
});

test('사용자 중단 뒤 새 요청이 오면 앞쪽 하위 에이전트의 확인 요청도 지우고 정리하며 팀장 퇴근을 막지 않는다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }));
  e.handleEvent(delegate());
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  e.handleEvent(ev('PermissionRequest', { agent_id: 'x1', agent_type: 'executor', tool_name: 'Bash' }));
  e.handleEvent(ev('UserPromptSubmit', { prompt: '다시' }));
  assert.equal(agent(e, 'x1').status, 'resting');
  assert.notEqual(bubbleOf(e, 'x1')?.kind, 'alert');
  run(e, 45 * MIN, 250);
  assert.equal(agent(e, 'lead'), undefined);
});

test('하위 에이전트만 5분 넘게 신호가 없으면 휴게실로 가고 팀장은 20분 규칙을 따른다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }));
  e.handleEvent(delegate());
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  run(e, 4 * MIN, 250);
  assert.equal(agent(e, 'x1').status, 'working');
  run(e, 90000, 250); // 5분 30초 — 휴게실로 가고 1분(퇴근)이 되기 전
  assert.equal(agent(e, 'x1').status, 'resting');
  assert.equal(agent(e, 'lead').status, 'working');
  run(e, 13.5 * MIN, 250);
  assert.equal(agent(e, 'lead').status, 'working');
  run(e, 3 * MIN, 250);
  assert.equal(agent(e, 'lead').status, 'away');
});

test('작업 말풍선은 내용이 바뀐 직후 두 줄, 3초 뒤 한 줄 요약이고 종류가 바뀌면 다시 두 줄이 된다', () => {
  const { e } = mk();
  e.handleEvent(delegate());
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  const tool = (name, input) => e.handleEvent(ev('PreToolUse', { agent_id: 'x1', agent_type: 'executor', tool_name: name, tool_input: input }));
  const bubble = () => bubbleOf(e, 'x1');
  tool('Edit', { file_path: 'C:\\a\\Foo.kt' });
  assert.ok(bubble().text.includes('\n'), bubble().text);
  assert.equal(bubble().summary, true);
  run(e, 3100);
  assert.equal(bubble().text, '⌨ 코드 수정 중');
  assert.equal(bubble().brief, true);
  tool('Edit', { file_path: 'C:\\a\\Bar.kt' });
  assert.equal(bubble().text, '⌨ 코드 수정 중', '같은 종류 도구는 다시 펼치지 않는다');
  tool('Bash', { command: 'npm test' });
  assert.ok(bubble().text.includes('\n') && bubble().text.includes('테스트 실행 중'), bubble().text);
  assert.equal(bubble().brief, undefined);
  run(e, 3100);
  assert.equal(bubble().text, '🧪 테스트 실행 중');
});

test('새 업무(SubagentStart)나 새 요청을 받으면 한 줄로 줄었던 말풍선도 다시 두 줄로 시작한다', () => {
  const { e } = mk();
  e.handleEvent(delegate());
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  run(e, 5000);
  assert.equal(bubbleOf(e, 'x1').text, '🚶 작업 준비 중');
  e.handleEvent(delegate({ description: '새 업무' }));
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  assert.equal(bubbleOf(e, 'x1').text, '새 업무\n맡은 작업 준비 중');
  e.handleEvent(ev('UserPromptSubmit', { prompt: '요청' }));
  assert.ok(bubbleOf(e, 'lead').text.includes('\n'));
  run(e, 5000);
  assert.equal(bubbleOf(e, 'lead').text, '📥 요청 검토 중');
  e.handleEvent(ev('UserPromptSubmit', { prompt: '또 요청' }));
  assert.ok(bubbleOf(e, 'lead').text.includes('\n'));
});

test('workBrief: 도구 종류별 한 줄 요약', () => {
  const cases = [
    ['Read', {}, '📖 자료 검토 중'], ['Grep', {}, '🔍 코드 찾는 중'], ['LS', {}, '🔍 코드 찾는 중'],
    ['WebFetch', {}, '🌐 자료 조사 중'], ['Edit', {}, '⌨ 코드 수정 중'], ['apply_patch', {}, '⌨ 코드 수정 중'],
    ['Write', {}, '📝 파일 작성 중'], ['Bash', { command: 'npm test' }, '🧪 테스트 실행 중'],
    ['Bash', { command: 'ls -la' }, '명령 실행 중 ▶️'], ['PowerShell', {}, '명령 실행 중 ▶️'],
    ['Skill', {}, '🧩 스킬 작업 중'], ['Agent', {}, '📣 업무 지시 중'], ['SendMessage', {}, '💬 결과 공유 중'],
    ['TodoWrite', {}, '🗒 작업 정리 중'], ['AskUserQuestion', {}, '❓ 확인 요청 중'],
    ['mcp__x__y', {}, '🔌 도구 사용 중'], ['Whatever', {}, '⚙ 작업 중'], [undefined, undefined, '⚙ 작업 중'],
  ];
  for (const [name, input, want] of cases) assert.equal(workBrief(name, input), want, String(name));
});

test('작업 도중 보낸 메시지(새 요청)에는 방금 신호를 보낸 앞쪽 하위 에이전트를 정리하지 않고, 15초 넘게 조용했으면 정리한다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }));
  e.handleEvent(delegate());
  e.handleEvent(delegate());
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  e.handleEvent(ev('SubagentStart', { agent_id: 'x2', agent_type: 'executor' }));
  run(e, 15000);
  e.handleEvent(ev('PreToolUse', { agent_id: 'x1', agent_type: 'executor', tool_name: 'Read', tool_input: { file_path: 'a.js' } }));
  run(e, 5000);
  e.handleEvent(ev('UserPromptSubmit', { prompt: '답하는 중에 보낸 메시지' }));
  assert.equal(agent(e, 'x1').status, 'working', '5초 전에 신호를 보낸 하위는 아직 일한다');
  assert.equal(agent(e, 'x2').status, 'resting', '20초 동안 조용한 하위는 정리한다');
});

test('새 요청이 와도 확인 요청이 떠 있던 하위 에이전트는 최근 신호가 있어도 정리한다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }));
  e.handleEvent(delegate());
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  e.handleEvent(ev('PermissionRequest', { agent_id: 'x1', agent_type: 'executor', tool_name: 'Bash' }));
  run(e, 2000);
  e.handleEvent(ev('UserPromptSubmit', { prompt: '다시' }));
  assert.equal(agent(e, 'x1').status, 'resting');
});

test('정리되는 하위 에이전트의 비차단 알림 말풍선은 메인 Stop 에도 남지 않는다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }));
  e.handleEvent(delegate());
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  e.handleEvent(ev('Notification', { agent_id: 'x1', agent_type: 'executor', notification_type: 'idle_prompt', message: '입력 대기' }));
  assert.equal(bubbleOf(e, 'x1').kind, 'alert');
  e.handleEvent(ev('Stop'));
  assert.equal(agent(e, 'x1').status, 'resting');
  assert.notEqual(bubbleOf(e, 'x1')?.kind, 'alert');
});

test('공유를 마치고 휴게실 상태로 돌아오면 휴식 시작 시각과 다음 한가한 행동 시각이 잡힌다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }));
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'analyst' }));
  e.handleEvent(ev('SubagentStart', { agent_id: 'x2', agent_type: 'executor' }));
  run(e, 20000);
  e.handleEvent(ev('PreToolUse', { agent_id: 'x1', agent_type: 'analyst', tool_name: 'SendMessage', tool_input: { to: 'executor', message: 'hi' } }));
  e.handleEvent(ev('Stop'));
  const a = agent(e, 'x1');
  assert.equal(a.restSince, null);
  for (let i = 0; i < 1200 && a.status !== 'resting'; i++) e.update(50);
  assert.equal(a.status, 'resting');
  assert.ok(a.restSince != null && e.time - a.restSince <= 100, `restSince=${a.restSince} time=${e.time}`);
  assert.ok(a.nextIdleAt > a.restSince);
});

test('Stop 뒤 결과 공유 연출 중에는 팀장 턴이 끝난 것으로 보아 활동하는 하위 에이전트를 백그라운드로 본다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }));
  e.handleEvent(delegate());
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  run(e, 15000);
  e.handleEvent(ev('PreToolUse', { tool_name: 'SendMessage', tool_input: { to: 'executor' } }));
  e.handleEvent(ev('Stop'));
  assert.equal(agent(e, 'lead').status, 'sharing');
  assert.equal(e.turnActive(e.sessions.get(SID)), false);
  e.handleEvent(ev('PreToolUse', { agent_id: 'x1', agent_type: 'executor', tool_name: 'Read', tool_input: { file_path: 'a.js' } }));
  assert.equal(agent(e, 'x1').background, true);
});

test('휴게실에서 돌아오거나 대기 중이던 팀장이 도구를 쓰면 같은 종류여도 말풍선이 두 줄로 시작한다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: '요청' }));
  const read = () => e.handleEvent(ev('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'a.js' } }));
  read();
  run(e, 4000);
  assert.equal(bubbleOf(e, 'lead').text, '📖 자료 검토 중');
  e.handleEvent(ev('Stop'));
  read();
  assert.ok(bubbleOf(e, 'lead').text.includes('\n'), '대기 중이던 팀장은 다시 두 줄부터');
  run(e, 4000);
  assert.equal(bubbleOf(e, 'lead').text, '📖 자료 검토 중');
  read();
  assert.equal(bubbleOf(e, 'lead').text, '📖 자료 검토 중', '일하던 중이면 같은 종류는 펼치지 않는다');

  e.handleEvent(delegate());
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  const sub = () => e.handleEvent(ev('PreToolUse', { agent_id: 'x1', agent_type: 'executor', tool_name: 'Read', tool_input: { file_path: 'b.js' } }));
  sub();
  run(e, 4000);
  assert.equal(bubbleOf(e, 'x1').text, '📖 자료 검토 중');
  e.handleEvent(ev('Stop'));
  assert.equal(agent(e, 'x1').status, 'resting');
  sub();
  assert.equal(agent(e, 'x1').status, 'working');
  assert.ok(bubbleOf(e, 'x1').text.includes('\n'), '휴게실에서 돌아오면 두 줄로 시작');
});

test('Skill·SendMessage 도구의 한 줄 요약은 각각 스킬·결과 공유 문구다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }));
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  e.handleEvent(ev('PreToolUse', { agent_id: 'x1', agent_type: 'executor', tool_name: 'Skill', tool_input: { skill: 'pdf' } }));
  assert.equal(agent(e, 'x1').brief, '🧩 스킬 작업 중');
  e.handleEvent(ev('PreToolUse', { tool_name: 'SendMessage', tool_input: { to: 'executor', message: 'hi' } }));
  assert.equal(agent(e, 'lead').brief, '💬 결과 공유 중');
});

test('하위 에이전트가 퇴근한 뒤 같은 agent_id 로 다시 일하면 같은 이름·외형으로 다시 출근한다', () => {
  const { e } = mk();
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  const look = agent(e, 'x1').appearance;
  const color = agent(e, 'x1').colorIndex;
  e.handleEvent(ev('SubagentStop', { agent_id: 'x1', agent_type: 'executor' }));
  run(e, 3 * MIN, 250);
  assert.equal(agent(e, 'x1'), undefined, '1분 뒤 퇴근했다');
  e.handleEvent(ev('PreToolUse', { agent_id: 'x1', agent_type: 'executor', tool_name: 'Read', tool_input: { file_path: 'a.js' } }));
  assert.equal(agent(e, 'x1').label, 'executor', '#2 가 아니라 같은 이름');
  assert.deepEqual(agent(e, 'x1').appearance, look);
  assert.equal(agent(e, 'x1').colorIndex, color);
  e.handleEvent(ev('SubagentStart', { agent_id: 'x2', agent_type: 'executor' }));
  assert.equal(agent(e, 'x2').label, 'executor #2', '다른 agent_id 는 다른 사람');
});

test('settle: 작업 중인 팀장은 대기로 돌아가고 말풍선은 넘긴 문구, 앞쪽 하위는 정리하고 백그라운드 하위는 둔다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: '중단될 일' }));
  e.handleEvent(delegate());
  e.handleEvent(ev('SubagentStart', { agent_id: 'fg', agent_type: 'executor' }));
  e.handleEvent(delegate({ subagent_type: 'Explore', run_in_background: true }));
  e.handleEvent(ev('SubagentStart', { agent_id: 'bg', agent_type: 'Explore' }));
  run(e, 15000, 250);
  assert.equal(agent(e, 'lead').status, 'working');
  e.settle(SID, '⏹️ 작업 중단');
  assert.equal(agent(e, 'lead').status, 'idle');
  assert.equal(agent(e, 'lead').task, '다음 요청 대기 중');
  assert.equal(bubbleOf(e, 'lead').text, '⏹️ 작업 중단');
  assert.equal(agent(e, 'fg').status, 'resting', '앞쪽 하위는 휴게실로');
  assert.equal(agent(e, 'bg').status, 'working', '백그라운드 하위는 그대로');
});

test('settle 뒤 팀장·정리된 하위의 퇴근 시간은 지금부터 잰다', () => {
  const { e } = mk({ leadIdleToRestMs: 20000 });
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }));
  e.handleEvent(delegate());
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  run(e, 4 * MIN, 250); // 신호 없이 오래 흐른 뒤 중단돼도 바로 퇴근하지 않는다
  e.settle(SID, '❌ 오류로 끝남');
  run(e, 40000, 250);
  assert.ok(agent(e, 'x1'), '정리된 하위는 휴게실에 간 때부터 1분');
  assert.ok(agent(e, 'lead'), '팀장은 작업이 끝난 때부터 3분');
  run(e, 2 * MIN, 250);
  assert.equal(agent(e, 'x1'), undefined);
  assert.ok(agent(e, 'lead'));
  run(e, 2 * MIN, 250);
  assert.equal(agent(e, 'lead'), undefined);
});

test('settle: 없는 세션·끝난 세션은 무시한다', () => {
  const { e } = mk();
  e.settle('nope', '⏹️ 작업 중단');
  assert.equal(e.agents.size, 0);
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }));
  e.endSession(SID);
  const task = agent(e, 'lead').task;
  e.settle(SID, '⏹️ 작업 중단');
  assert.equal(agent(e, 'lead').task, task);
  assert.notEqual(bubbleOf(e, 'lead')?.text, '⏹️ 작업 중단');
});

test('하위 에이전트가 신호 없이 오래 일해도(긴 도구 하나) 팀장은 먼저 퇴근하지 않는다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: '작업' }));
  e.handleEvent(ev('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'executor', description: '긴 빌드', run_in_background: 'true' } }));
  e.handleEvent(ev('SubagentStart', { agent_id: 'bg', agent_type: 'executor' }));
  e.handleEvent(ev('PreToolUse', { agent_id: 'bg', tool_name: 'Bash', tool_input: { command: 'npm run build' } }));
  e.handleEvent(ev('Stop'));
  run(e, 4 * 60000, 250); // 팀장 퇴근 시간(3분)이 지났지만 하위는 4분째 신호 없이 일하는 중
  assert.equal(agent(e, 'bg').status, 'working');
  assert.ok(agent(e, 'lead') && agent(e, 'lead').status !== 'leaving', '하위가 일하는 동안 팀장은 남는다');
  run(e, 2 * 60000, 250); // 하위는 5분 무신호로 휴게실 → 그 뒤 팀장도 퇴근 규칙을 탄다
  assert.equal(agent(e, 'bg').status, 'resting');
});

test('settle: 팀장이 이미 떠났어도 앞쪽 하위 에이전트는 정리한다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: '작업' }));
  e.handleEvent(ev('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'executor', description: '구현' } }));
  e.handleEvent(ev('SubagentStart', { agent_id: 'fg', agent_type: 'executor' }));
  e.agents.get(`${SID}:lead`).status = 'leaving';
  e.settle(SID, '❌ 오류로 끝남');
  assert.equal(agent(e, 'fg').status, 'resting');
});
