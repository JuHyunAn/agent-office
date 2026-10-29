import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfficeEngine } from '../src/renderer/office/engine.js';
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

test('하위 에이전트는 작업이 끝나고 20분 동안 일이 없으면 퇴근한다', () => {
  const { e } = mk();
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'Explore' }));
  run(e, 15000);
  e.handleEvent(ev('SubagentStop', { agent_id: 'x1', agent_type: 'Explore' }));
  run(e, 19 * MIN, 250);
  assert.equal(agent(e, 'x1').status, 'resting', '20분 전에는 휴게실에 남는다');
  run(e, 2 * MIN, 250);
  assert.equal(agent(e, 'x1'), undefined);
});

test('팀장은 답변 완료 후 20분 동안 일이 없으면 퇴근하고, 다시 요청이 오면 같은 외형으로 출근한다', () => {
  const { e } = mk({ leadIdleToRestMs: 20000 });
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }), { label: 'proj' });
  e.handleEvent(ev('Stop'), { label: 'proj' });
  const look = agent(e, 'lead').appearance;
  run(e, 19 * MIN, 250);
  assert.equal(agent(e, 'lead').status, 'away');
  run(e, 2 * MIN, 250);
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

test('팀장이 사용자 확인을 기다리는 동안은 20분이 지나도 퇴근하지 않는다', () => {
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

test('세션이 끝나면 모두 휴게실에 모였다가 5분 뒤 다 같이 퇴근한다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: 'x' }));
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'Explore' }));
  e.handleEvent(ev('SubagentStart', { agent_id: 'x2', agent_type: 'executor' }));
  run(e, 5000);
  e.endSession(SID);
  run(e, 5 * MIN - 1000, 250);
  const crew = [...e.agents.values()];
  assert.equal(crew.length, 3);
  for (const a of crew) {
    assert.notEqual(a.status, 'leaving', `${a.label} 는 5분 전에 떠나지 않는다`);
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
  run(e, 7 * MIN, 250);
  e.handleEvent(ev('SubagentStart', { agent_id: 'x2', agent_type: 'executor' }));
  assert.equal(e.agents.size, 0);
});

test('끝난 세션도 다시 시작(SessionStart)하면 정상으로 돌아온다', () => {
  const { e } = mk();
  e.handleEvent(ev('Stop'));
  e.endSession(SID);
  run(e, 7 * MIN, 250);
  e.handleEvent(ev('SessionStart', { source: 'resume' }));
  assert.ok(agent(e, 'lead'));
  run(e, 7 * MIN, 250);
  assert.ok(agent(e, 'lead'), '다시 시작한 세션은 5분 뒤 퇴근 예약이 남지 않는다');
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

test('신호가 끊긴 작업 중 하위 에이전트는 20분 뒤 휴게실, 40분 뒤 퇴근한다', () => {
  const { e } = mk();
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  run(e, 21 * MIN, 250);
  const a = agent(e, 'x1');
  assert.equal(a.status, 'resting');
  assert.equal(e.roomAt(a.x, a.y), 'rest');
  run(e, 18 * MIN, 250);
  assert.ok(agent(e, 'x1'), '휴게실로 간 뒤 20분 전에는 남는다');
  run(e, 3 * MIN, 250);
  assert.equal(agent(e, 'x1'), undefined);
});

test('신호가 끊긴 작업 중 팀장도 20분 뒤 휴게실, 40분 뒤 퇴근한다', () => {
  const { e } = mk();
  e.handleEvent(ev('UserPromptSubmit', { prompt: '오래 걸리는 일' }));
  run(e, 21 * MIN, 250);
  const lead = agent(e, 'lead');
  assert.equal(lead.status, 'away');
  assert.equal(e.roomAt(lead.x, lead.y), 'rest');
  run(e, 18 * MIN, 250);
  assert.ok(agent(e, 'lead'));
  run(e, 3 * MIN, 250);
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
  // 창이 돌아오면 멈춰 있던 보고를 마저 하고, 이미 20분이 지났으므로 곧바로 퇴근한다.
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

test('세션 종료 시각도 실제 시계로 잰다 (창이 멈춘 뒤 종료돼도 5분을 기다린다)', () => {
  let clock = 0;
  const e = new OfficeEngine(layout, { random: seeded(), now: () => clock });
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }), { label: 'proj' });
  clock += 10 * MIN; // 창이 최소화된 동안 claude 가 종료됨
  e.endSession(SID);
  const tick = (ms) => { for (let t = 0; t < ms; t += 50) { clock += 50; e.update(50); } };
  tick(4 * MIN);
  assert.notEqual(agent(e, 'x1').status, 'leaving');
  tick(2 * MIN);
  assert.ok(!agent(e, 'x1') || agent(e, 'x1').status === 'leaving', '5분이 지나면 퇴근한다');
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
