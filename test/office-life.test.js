import { test } from 'node:test';
import assert from 'node:assert/strict';
import layout from '../src/renderer/themes/pixel-office/layout.js';
import theme from '../src/renderer/themes/pixel-office/theme.js';
import { Navigation } from '../src/renderer/office/navigation.js';
import { OfficeCamera } from '../src/renderer/office/camera.js';
import { OfficeLife } from '../src/renderer/office/life.js';
import { OfficeEngine } from '../src/renderer/office/engine.js';

const run = (object, ms) => { for (let i = 0; i < ms; i += 50) object.update(50); };
const ev = (name, extra = {}) => ({ session_id: 's', hook_event_name: name, ...extra });

test('중앙 엘리베이터는 내 캐릭터와 출입 에이전트에 반응하고 떠나면 닫힌다', () => {
  const engine = new OfficeEngine(layout), life = new OfficeLife(layout, engine);
  const door = life.doors.find(d => d.id === 'elevator');
  life.residents = [];
  run(life, 400); assert.equal(door.amount, 0);
  Object.assign(life.player, { x: 96, y: 576 });
  life.update(100); assert.ok(door.amount > 0 && door.amount < 1);
  run(life, 300); assert.equal(door.amount, 1);
  Object.assign(life.player, { x: 500, y: 576 });
  life.update(100); assert.ok(door.amount > 0 && door.amount < 1);
  run(life, 300); assert.equal(door.amount, 0);
  engine.agents.set('arrival', { ...layout.entrance });
  run(life, 400); assert.equal(door.amount, 1);
  engine.agents.clear(); run(life, 400); assert.equal(door.amount, 0);
});

test('확대는 포인터 아래 좌표를 유지하고 화면 이동은 범위 안으로 제한한다', () => {
  const camera = new OfficeCamera(); camera.resize(1000, 700, 2880, 1720);
  const point = camera.toScene(600, 350);
  camera.zoomAt(2, 600, 350);
  assert.deepEqual(camera.toScene(600, 350), point);
  camera.pan(-100, 60);
  assert.notDeepEqual(camera.toScene(600, 350), point);
  camera.zoomAt(100); assert.equal(camera.zoom, 4);
  camera.pan(100000, -100000);
  assert.ok(camera.ox <= camera.cw * 0.65);
  assert.ok(camera.oy >= camera.ch * 0.35 - camera.height * camera.scale);
  camera.fit(); assert.equal(camera.zoom, 1);
});

test('화면 투영을 역변환하여 클릭한 바닥의 월드 좌표를 찾는다', () => {
  for (const p of [layout.playerStart, ...Object.values(layout.rooms).map(r => r.door)]) {
    const screen = theme.project(p.x, p.y), back = theme.unproject(screen.x, screen.y);
    assert.ok(Math.hypot(back.x - p.x, back.y - p.y) < 4);
  }
  for (const item of layout.interactions) {
    const p = theme.project(item.x + item.w / 2, item.y + item.d / 2);
    assert.equal(theme.hitTest(p.x, p.y - item.height)?.id, item.id);
  }
});

test('입구에서 모든 작업 좌석·소파에 접근할 수 있고 가구는 통과하지 않는다', () => {
  const nav = new Navigation(layout);
  for (const room of Object.values(layout.rooms)) for (const seat of room.seats) {
    const path = nav.findPath(layout.entrance, seat);
    assert.ok(path.length > 0, `${room.key} ${seat.x},${seat.y}`);
    assert.ok(path.every(p => nav.isWalkable(p)));
  }
  for (const item of layout.interactions) {
    assert.equal(nav.isWalkable(item.stand), true, item.id);
    assert.ok(nav.findPath(layout.playerStart, item.stand).length);
  }
  assert.equal(nav.isWalkable({ x: layout.interactions[0].x + 20, y: layout.interactions[0].y + 20 }), false);
});

test('내 캐릭터는 도착 후에만 음료·노트북·소파 액션을 시작한다', () => {
  const engine = new OfficeEngine(layout);
  for (const item of layout.interactions) {
    const life = new OfficeLife(layout, engine, () => 0.2);
    assert.equal(life.interact(item.id), true);
    assert.equal(life.player.action, null);
    assert.ok(life.player.path.length);
    for (let i = 0; i < 1200 && !life.player.action && !life.menu; i++) life.update(50);
    if (item.menu === 'coffee') { assert.ok(life.menu); assert.equal(life.chooseDrink('latte'), true); life.update(50); }
    assert.equal(life.player.action, item.action, item.id);
    assert.equal(life.player.path.length, 0);
    assert.equal(life.snapshot()[0].isPlayer, true);
    run(life, 14000); assert.equal(life.player.action, null);
  }
  assert.equal(engine.agents.size, 0, '상주 캐릭터와 내 캐릭터는 실제 에이전트가 아니다');
});

test('막힌 바닥 클릭은 거부하고 새 이동은 이전 상호작용을 취소한다', () => {
  const life = new OfficeLife(layout, new OfficeEngine(layout));
  assert.equal(life.moveTo({ x: -500, y: -500 }), false);
  life.interact('vending');
  assert.equal(life.moveTo({ x: 1450, y: 576 }), true);
  run(life, 30000);
  assert.equal(life.player.action, null);
  assert.equal(life.player.interaction, null);
  assert.equal(life.player.x, 1450);
});

test('상주 캐릭터는 자율적으로 이동하고 스킬 작업 중에는 협업 공간에 모인다', () => {
  const engine = new OfficeEngine(layout), life = new OfficeLife(layout, engine, () => 0.2);
  const positions = life.residents.map(a => [a.x, a.y]);
  run(life, 5000);
  assert.ok(life.residents.some((a, i) => a.path.length || a.x !== positions[i][0] || a.y !== positions[i][1]));
  engine.handleEvent(ev('PreToolUse', { tool_name: 'Skill', tool_input: { skill: 'documents:documents' } }), { label: 'tab' });
  run(life, 120000);
  assert.ok(life.residents.some(a => a.action === 'collaborate'));
  assert.equal(engine.agents.size, 1);
});

test('실제 스킬명을 유지하고 작업 완료·새 요청에서 스킬 작업실을 정리한다', () => {
  const engine = new OfficeEngine(layout);
  engine.handleEvent(ev('PreToolUse', { tool_name: 'Skill', tool_input: { skill: 'spreadsheets:Spreadsheets' } }), { label: 'tab' });
  run(engine, 50000);
  const lead = engine.agents.get('s:lead');
  assert.equal(lead.seat.room, 'skills');
  assert.equal(engine.roomAt(lead.x, lead.y), 'skills');
  engine.handleEvent(ev('PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'data.csv' } }));
  assert.equal(engine.snapshot()[0].skill, 'spreadsheets:Spreadsheets');
  engine.handleEvent(ev('Stop')); assert.equal(lead.skill, null);
  run(engine, 50000); assert.equal(lead.seat.room, 'lead');
  engine.handleEvent(ev('PreToolUse', { tool_name: 'Skill', tool_input: { skill: 'pdf:pdf' } }));
  engine.handleEvent(ev('UserPromptSubmit', { prompt: '다음 요청' })); assert.equal(lead.skill, null);
});

test('하위 에이전트 스킬도 독립적으로 종료하고 기존 목업으로 전환할 수 있다', async () => {
  const engine = new OfficeEngine(layout);
  engine.handleEvent(ev('PreToolUse', { agent_id: 'a', agent_type: 'executor', tool_name: 'Skill', tool_input: { skill: 'imagegen' } }));
  assert.equal(engine.agents.get('s:a').skill, 'imagegen');
  engine.handleEvent(ev('SubagentStop', { agent_id: 'a' })); assert.equal(engine.agents.get('s:a').skill, null);
  engine.handleEvent(ev('PreToolUse', { tool_name: 'Skill', tool_input: { skill: 'pdf' } }));
  const { default: legacy } = await import('../src/renderer/themes/mockup/layout.js');
  engine.setLayout(legacy);
  assert.equal(engine.agents.get('s:lead').seat.room, 'lead');
  assert.equal(engine.agents.get('s:lead').skill, null);
});

test('하위 에이전트의 Stop은 팀장의 스킬을 종료하지 않는다', () => {
  const engine = new OfficeEngine(layout);
  engine.handleEvent(ev('PreToolUse', { tool_name: 'Skill', tool_input: { skill: 'main-skill' } }));
  engine.handleEvent(ev('PreToolUse', { agent_id: 'child', agent_type: 'executor', tool_name: 'Skill', tool_input: { skill: 'child-skill' } }));
  engine.handleEvent(ev('Stop', { agent_id: 'child' }));
  assert.equal(engine.agents.get('s:child').skill, null);
  assert.equal(engine.agents.get('s:lead').skill, 'main-skill');
  engine.handleEvent(ev('SessionEnd'));
  assert.ok(engine.snapshot().every(a => a.skill === null));
});

test('상주 캐릭터의 시설 예약은 겹치지 않고 내 캐릭터가 이용을 우선한다', () => {
  const life = new OfficeLife(layout, new OfficeEngine(layout), () => 0.2);
  run(life, 8000);
  const reservations = life.residents.map(a => a.currentItem || a.interaction?.id).filter(Boolean);
  assert.equal(new Set(reservations).size, reservations.length);
  const id = reservations[0]; assert.ok(id);
  life.interact(id);
  assert.equal(life.player.interaction.id, id);
  assert.ok(life.residents.every(a => a.currentItem !== id && a.interaction?.id !== id));
});
