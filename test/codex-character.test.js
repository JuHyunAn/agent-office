import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfficeEngine } from '../src/renderer/office/engine.js';
import layout from '../src/renderer/themes/pixel-office/layout.js';

test('같은 협업 탭의 Claude·Codex와 각 하위 에이전트는 CLI 외형을 독립적으로 유지한다', () => {
  const e = new OfficeEngine(layout, { random: () => .3 });
  for (const cli of ['claude', 'codex']) {
    const ev = { session_id: `room-${cli}`, _tab: 'same-room', _cli: cli };
    e.handleEvent({ ...ev, hook_event_name: 'SessionStart' }, { label: cli });
    e.handleEvent({ ...ev, hook_event_name: 'SubagentStart', agent_id: 'worker', agent_type: 'executor' });
    // CLI 정보가 없는 후속 이벤트도 이미 정해진 외형을 바꾸지 않는다.
    e.handleEvent({ session_id: ev.session_id, hook_event_name: 'PreToolUse', agent_id: 'worker', tool_name: 'Read', tool_input: { file_path: 'a.js' } });
  }
  const before = e.snapshot();
  assert.equal(before.length, 4);
  for (const a of before) assert.equal(a.cli, a.id.startsWith('room-codex:') ? 'codex' : 'claude');
  const looks = new Map(before.map(a => [a.id, a.appearance]));
  e.setLayout(layout);
  e.endSession('room-codex');
  // 세션 기록이 먼저 정리돼도 퇴근하는 캐릭터가 Claude로 변하지 않는다.
  e.time += e.timing.sessionEndGraceMs + 1;
  e.expire();
  assert.equal(e.sessions.has('room-codex'), false);
  for (const a of e.snapshot()) {
    assert.equal(a.cli, a.id.startsWith('room-codex:') ? 'codex' : 'claude');
    assert.deepEqual(a.appearance, looks.get(a.id));
  }
});

test('초기 이벤트에 CLI가 없어도 이후 Codex 식별을 받으면 기존 팀장·직원까지 갱신한다', () => {
  const e = new OfficeEngine(layout, { random: () => .3 });
  const ev = { session_id: 'late-cli' };
  e.handleEvent({ ...ev, hook_event_name: 'SubagentStart', agent_id: 'worker', agent_type: 'verifier' });
  assert.ok(e.snapshot().every(a => a.cli === 'claude'));
  e.handleEvent({ ...ev, _cli: 'codex', hook_event_name: 'UserPromptSubmit', prompt: '검토 계속' });
  assert.equal(e.sessions.get(ev.session_id).cli, 'codex');
  assert.equal(e.snapshot().length, 2);
  assert.ok(e.snapshot().every(a => a.cli === 'codex'));
});
