import { test } from 'node:test';
import assert from 'node:assert/strict';
import layout from '../src/renderer/themes/pixel-office/layout.js';
import { Navigation } from '../src/renderer/office/navigation.js';
import { OfficeLife } from '../src/renderer/office/life.js';
import { OfficeEngine } from '../src/renderer/office/engine.js';
import { activitySummary } from '../src/renderer/office/phrases.js';
import { DESK_LIGHTS } from '../src/renderer/themes/pixel-office/atmosphere.js';

const event = (name, extra = {}) => ({ session_id: 's', hook_event_name: name, ...extra });
const advance = (object, ms) => { for (let i = 0; i < ms; i += 50) object.update(50); };

test('작업실 가구는 서로 겹치지 않으며 실제 좌석·통행·조명 위치가 일치한다', () => {
  const furniture = [...layout.workTables, ...layout.furnishings], nav = new Navigation(layout);
  for (const item of furniture) {
    const room = layout.rooms[item.room];
    assert.ok(item.x >= room.x + 12 && item.y >= room.y + 12 && item.x + item.w <= room.x + room.w - 12
      && item.y + item.d <= room.y + room.h - 12, `${item.room}:${item.kind} outside room`);
    assert.equal(nav.isWalkable({ x: item.x + item.w / 2, y: item.y + item.d / 2 }), false);
    for (const other of furniture) if (other !== item && other.room === item.room) {
      assert.ok(!(item.x < other.x + other.w && item.x + item.w > other.x && item.y < other.y + other.d && item.y + item.d > other.y), `${item.room}: ${item.kind}/${other.kind} overlap`);
    }
  }
  for (const table of layout.workTables) for (const seat of table.seats) {
    assert.equal(nav.isWalkable(seat), true, `${table.room}: blocked seat`);
    assert.deepEqual(nav.findPath(layout.entrance, seat).at(-1), { x: seat.x, y: seat.y });
    const lamp = DESK_LIGHTS.find(l => l.x === seat.x - 40 && l.y === seat.y + 54);
    assert.ok(lamp && lamp.x >= table.x && lamp.x <= table.x + table.w && lamp.y >= table.y && lamp.y <= table.y + table.d);
    assert.deepEqual(lamp.surface, { x: table.x, y: table.y, w: table.w, d: table.d, z: 23 });
  }
});

test('작업 요약은 파일·검색·테스트 등 관측한 활동을 짧게 표현한다', () => {
  assert.equal(activitySummary('Edit', { file_path: 'C:\\work\\theme.js' }), 'theme.js 수정 중');
  assert.equal(activitySummary('Bash', { command: 'npm test' }), '테스트 실행 중');
  assert.equal(activitySummary('Bash', { command: 'git diff' }), '변경 내역 확인 중');
  assert.match(activitySummary('Grep', { pattern: 'OfficeView' }), /OfficeView.*찾는 중/);
  assert.ok(activitySummary('Bash', { description: 'x'.repeat(1000) }).length <= 36);
});

test('작업 요약 말풍선은 시간 경과 후에도 유지되고 다음 도구 호출로 갱신된다', () => {
  const engine = new OfficeEngine(layout);
  engine.handleEvent(event('PreToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'executor', description: '화면 구성 개선' } }));
  engine.handleEvent(event('SubagentStart', { agent_id: 'a', agent_type: 'executor' }));
  engine.handleEvent(event('PreToolUse', { agent_id: 'a', tool_name: 'Edit', tool_input: { file_path: 'theme.js' } }));
  advance(engine, 45000);
  const snapshot = () => engine.snapshot().find(a => a.id === 's:a');
  assert.match(snapshot().bubble.text, /화면 구성 개선\ntheme.js 수정 중/);
  assert.equal(snapshot().bubble.summary, true);
  engine.handleEvent(event('PreToolUse', { agent_id: 'a', tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  assert.match(snapshot().bubble.text, /테스트 실행 중/);
  engine.handleEvent(event('PermissionRequest', { agent_id: 'a', tool_name: 'Bash' }));
  assert.equal(snapshot().bubble.kind, 'alert');
  engine.handleEvent(event('SubagentStop', { agent_id: 'a' }));
  assert.notEqual(snapshot().bubble?.summary, true);
});

test('별채는 연결 통로·출입문을 통해 접근하며 중앙 정원은 건물 바닥이 아니다', () => {
  const nav = new Navigation(layout);
  assert.equal(nav.isWalkable({ x: 1000, y: 1500 }), false);
  for (const id of ['ceo-door', 'restroom-door']) {
    const item = layout.interactions.find(i => i.id === id);
    const path = nav.findPath(layout.playerStart, item.stand);
    assert.ok(path.length > 0, id);
    assert.ok(path.every(p => nav.isWalkable(p)));
    assert.ok(path.some(p => Math.abs(p.y - 1200) < 25 && Math.abs(p.x - item.stand.x) < 63));
    assert.ok(path.some(p => Math.abs(p.y - 1360) < 25 && Math.abs(p.x - item.stand.x) < 63));
  }
});

test('대표실·화장실 문은 접근 시 열리고 입장·퇴장 후 다시 닫힌다', () => {
  for (const id of ['ceo-door', 'restroom-door']) {
    const engine = new OfficeEngine(layout), life = new OfficeLife(layout, engine, () => 0.2);
    assert.equal(life.doors.find(d => d.id === id).amount, 0);
    assert.equal(life.interact(id), true);
    let opened = false;
    for (let i = 0; i < 2000 && !life.player.action; i++) {
      life.update(50);
      if (life.doors.find(d => d.id === id).amount === 1) opened = true;
    }
    assert.ok(opened, id);
    assert.equal(life.player.action, 'visit');
    assert.equal(engine.roomAt(life.player.x, life.player.y), id === 'ceo-door' ? 'ceo' : 'restroom');
    life.moveTo(layout.playerStart);
    for (let i = 0; i < 2000 && life.player.path.length; i++) life.update(50);
    advance(life, 1000);
    assert.equal(life.doors.find(d => d.id === id).amount, 0);
  }
});
