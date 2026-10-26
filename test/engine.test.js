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

test('휴게실에서 오래 쉬면 퇴근해 사라진다', () => {
  const { e } = mk({ restBeforeLeaveMs: 10000 });
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'Explore' }));
  run(e, 15000);
  e.handleEvent(ev('SubagentStop', { agent_id: 'x1', agent_type: 'Explore' }));
  run(e, 120000);
  assert.equal(agent(e, 'x1'), undefined);
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

test('세션이 끝나면 모두 퇴근한다', () => {
  const { e } = mk();
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'Explore' }));
  run(e, 5000);
  e.endSession(SID);
  run(e, 60000);
  assert.equal(e.agents.size, 0);
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

test('끝 이벤트 없이 조용해진 외부 세션은 정리된다 (앱 탭 세션은 유지)', () => {
  const { e } = mk({ externalSessionIdleMs: 60000 });
  e.handleEvent(ev('Stop'));
  e.handleEvent({ ...ev('Stop'), session_id: 'tab-sess' }, { label: '내 탭' });
  run(e, 200000, 100);
  assert.equal(agent(e, 'lead'), undefined);
  assert.ok(e.agents.get('tab-sess:lead'));
});

test('SubagentStop 이 오지 않은 하위 에이전트는 휴게실로 보낸다', () => {
  const { e } = mk({ subagentSilentMs: 30000 });
  e.handleEvent(ev('SubagentStart', { agent_id: 'x1', agent_type: 'executor' }));
  run(e, 60000);
  const a = agent(e, 'x1');
  assert.equal(a.status, 'resting');
  assert.equal(e.roomAt(a.x, a.y), 'rest');
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
