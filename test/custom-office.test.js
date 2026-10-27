import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exampleDocument, validate, place, snap, footprint, approach, area, MAX_AREA, makeLayout, parseDocument, unionArea, walkable, normalizeName } from '../src/renderer/themes/custom/model.js';
import { TILE } from '../src/renderer/themes/custom/catalog.js';
import { Navigation } from '../src/renderer/office/navigation.js';
import { OfficeEngine } from '../src/renderer/office/engine.js';
import { CustomLife } from '../src/renderer/themes/custom/life.js';
import { saveOffice, readOffice, STORAGE_KEY } from '../src/renderer/themes/custom/storage.js';
import { OfficeEditor } from '../src/renderer/themes/custom/editor.js';
import { environmentSettings, resolveEnvironment } from '../src/renderer/themes/custom/environment.js';
const tick = (value, ms) => { for (let n = 0; n < ms; n += 50) value.update(50); };

test('제작 환경은 날씨·낮밤·조명을 독립 선택하고 자동 설정은 실제 환경을 따른다', () => {
  const actual = { night: false, condition: 'rain', label: '서울 낮 · 비' };
  const automatic = resolveEnvironment({}, actual); assert.equal(automatic.night, false); assert.equal(automatic.condition, 'rain'); assert.equal(automatic.citypop, false);
  const night = resolveEnvironment({ environment: { time: 'night', lighting: 'citypop' } }, actual);
  assert.equal(night.night, true); assert.equal(night.condition, 'rain'); assert.equal(night.citypop, true); assert.match(night.label, /밤.*비.*시티팝/);
  const snow = resolveEnvironment({ environment: { time: 'day', weather: 'snow' } }, { night: true, condition: 'clear' });
  assert.equal(snow.night, false); assert.equal(snow.condition, 'snow'); assert.equal(actual.condition, 'rain');
  assert.deepEqual(environmentSettings({ weather: '잘못된 값', time: '잘못된 값' }), { weather: 'auto', time: 'auto', lighting: 'standard' });
});

test('환경 선택은 배치와 함께 저장되며 이전 저장 형식도 읽을 수 있다', () => {
  const doc = exampleDocument(); assert.deepEqual(parseDocument(doc), doc);
  doc.environment = { weather: 'snow', time: 'night', lighting: 'citypop' };
  const values = new Map(), storage = { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) };
  saveOffice(storage, doc); assert.deepEqual(readOffice(storage), doc);
});

test('책상 복제는 작업 용도를 유지하고 한 번의 되돌리기로 취소된다', () => {
  const doc = exampleDocument(), editor = new OfficeEditor({ setDraft() {} }, doc);
  editor.selected = doc.items.find(i => i.role === 'lead').id;
  doc.items.find(i => i.id === editor.selected).name = '대표실';
  editor.duplicate();
  assert.equal(editor.doc.items.length, doc.items.length + 1);
  assert.equal(editor.doc.items.find(i => i.id === editor.selected).role, 'lead');
  assert.equal(editor.doc.items.find(i => i.id === editor.selected).name, '대표실');
  editor.undo(); assert.deepEqual(editor.doc, doc);
  editor.redo(); assert.equal(editor.doc.items.length, doc.items.length + 1);
});

test('공간·책상 이름은 역할과 동선을 유지하며 저장·되돌리기·재질 교체에 남는다', () => {
  const doc = exampleDocument(), editor = new OfficeEditor({ setDraft() {} }, doc), desk = doc.items.find(i => i.role === 'dev'), floor = doc.items.find(i => i.kind === 'floor-mint');
  editor.selected = desk.id; editor.renameSelected('  개발실  ');
  assert.equal(editor.doc.items.find(i => i.id === desk.id).name, '개발실');
  editor.undo(); assert.equal(editor.doc.items.find(i => i.id === desk.id).name, undefined); editor.redo();
  editor.selected = floor.id; editor.renameSelected('대표실');
  const layout = makeLayout(editor.doc);
  assert.equal(layout.rooms.dev.label, '개발실'); assert.equal(layout.interactions.find(i => i.id === desk.id).label, '개발실'); assert.equal(layout.rooms.dev.seats.length, 1);
  assert.deepEqual(validate(editor.doc), []); assert.deepEqual(parseDocument(editor.doc), editor.doc);
  const result = place(editor.doc, { id: 'new-floor', kind: 'floor-stone', x: floor.x, y: floor.y, rotation: 0 }); assert.equal(result.item.name, '대표실');
  editor.renameSelected(''); assert.equal(editor.doc.items.find(i => i.id === floor.id).name, undefined);
  assert.equal(normalizeName('  대표실\n  회의 공간  '), '대표실 회의 공간'); assert.equal(normalizeName('가'.repeat(30)).length, 20);
});

test('제작 예제의 모든 가구와 작업 좌석에 실제 이동 경로가 있다', () => {
  const doc = exampleDocument(); assert.deepEqual(validate(doc), []);
  const layout = makeLayout(doc), nav = new Navigation(layout);
  for (const i of layout.interactions) assert.ok(nav.findPath(layout.entrance, i.stand).length, i.label);
  for (const r of Object.values(layout.rooms)) for (const s of r.seats) assert.ok(nav.findPath(layout.entrance, s).length, r.key);
});
test('벽 끝점이 붙고 창문으로 교체해도 중복 벽이 남지 않는다', () => {
  const doc = exampleDocument(), wall = doc.items.find(i => i.kind === 'wall-blue' && i.rotation === 0);
  const result = place(doc, { ...wall, id: 'replacement', kind: 'window-grid', x: wall.x + 12 });
  assert.ok(result.doc); assert.equal(result.doc.items.length, doc.items.length);
  assert.equal(result.item.x, wall.x); assert.ok(!result.doc.items.some(i => i.id === wall.id));
  const next = snap({ items: [wall] }, { id: 'next', kind: 'wall', x: wall.x + TILE + 18, y: wall.y + 8, rotation: 0 });
  assert.equal(next.x, wall.x + TILE); assert.equal(next.y, wall.y);
  const corner = doc.items.find(i => i.kind === 'window');
  const changed = place(doc, { ...corner, kind: 'window-grid' });
  assert.equal(changed.item.rotation, corner.rotation);
  assert.equal(changed.doc.items.length, doc.items.length, '모서리 창문 교체로 직교하는 벽을 지우지 않는다');
});
test('회전은 가구 치수와 이용 위치를 함께 바꾼다', () => {
  const desk = { id: 'd', kind: 'desk', x: 480, y: 480, rotation: 0 };
  const positions = [];
  for (let r = 0; r < 4; r++) { const i = { ...desk, rotation: r }; positions.push(approach(i)); assert.equal(footprint(i).w, r % 2 ? 72 : 144); }
  assert.equal(new Set(positions.map(p => `${p.x},${p.y}`)).size, 4);
  assert.ok(positions[1].x < desk.x && positions[2].y < desk.y);
});
test('면적은 중복 바닥을 세지 않고 기본 면적 두 배를 초과할 수 없다', () => {
  assert.equal(unionArea([{ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 0, w: 10, h: 10 }]), 150);
  let doc = { version: 1, items: [], background: null };
  const cap = Math.floor(MAX_AREA / (TILE * TILE));
  for (let n = 0; n <= cap; n++) {
    const result = place(doc, { id: `f${n}`, kind: 'floor-wood', x: n % 16 * TILE, y: Math.floor(n / 16) * TILE, rotation: 0 });
    if (n === cap) assert.match(result.error, /두 배/); else doc = result.doc;
  }
  const before = area(doc), replaced = place(doc, { ...doc.items[0], id: 'new-floor', kind: 'floor-mint' });
  assert.equal(area(replaced.doc), before);
});
test('겹침·고립된 바닥·가구 앞 차단은 적용 전에 발견한다', () => {
  const doc = exampleDocument(), desk = doc.items.find(i => i.kind === 'desk');
  assert.match(place(doc, { ...desk, id: 'overlap' }).error, /겹쳐/);
  const isolated = place(doc, { id: 'island', kind: 'floor-wood', x: 2880, y: 2880, rotation: 0 }).doc;
  assert.ok(validate(isolated).some(e => e.id === 'island'));
  const p = approach(desk), blocked = { ...doc, items: [...doc.items, { id: 'block', kind: 'plant', x: p.x - 24, y: p.y - 12, rotation: 0 }] };
  assert.ok(validate(blocked).some(e => e.id === desk.id));
  const diagonal = { items: [{ id: 'a', kind: 'floor-wood', x: 0, y: 0, rotation: 0 }, { id: 'b', kind: 'floor-wood', x: 192, y: 192, rotation: 0 }] };
  assert.equal(walkable(diagonal, { x: 192, y: 192 }), false, '꼭짓점만 닿은 바닥으로 캐릭터가 건너갈 수 없다');
});
test('사무실 저장은 재로딩되며 잘못된 자료와 저장 실패를 조용히 무시하지 않는다', () => {
  const values = new Map(), storage = { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) };
  const doc = exampleDocument(); saveOffice(storage, doc); assert.deepEqual(readOffice(storage), doc);
  const bad = structuredClone(doc); bad.items[0].x = Infinity; assert.throws(() => parseDocument(bad));
  bad.items[0].x = -192; assert.throws(() => parseDocument(bad));
  assert.throws(() => saveOffice({ setItem() { throw new Error('용량 부족'); } }, doc), /용량/);
  values.set(STORAGE_KEY, '{'); assert.throws(() => readOffice(storage));
});
test('가변 사무실의 실제 에이전트와 커피·출입문 동작이 이어진다', () => {
  const layout = makeLayout(exampleDocument()), engine = new OfficeEngine(layout), life = new CustomLife(layout, engine, () => .3);
  engine.handleEvent({ session_id: 'custom', hook_event_name: 'SubagentStart', agent_id: 'dev', agent_type: 'executor' });
  tick(engine, 20000); const agent = engine.agents.get('custom:dev'); assert.equal(agent.seat.room, 'dev'); assert.ok(Math.hypot(agent.x - agent.seat.x, agent.y - agent.seat.y) < 3);
  const coffee = layout.interactions.find(i => i.menu === 'coffee'); assert.ok(life.interact(coffee.id));
  for (let n = 0; n < 1500 && !life.menu; n++) life.update(50);
  assert.ok(life.menu); assert.ok(life.chooseDrink('latte')); tick(life, 3000); assert.equal(life.player.heldItem.id, 'latte');
  assert.ok(life.moveTo(layout.entrance)); tick(life, 45000); assert.equal(life.player.heldItem, null);
  const door = life.doors[0]; assert.equal(door.amount, 1);
  assert.ok(life.moveTo(coffee.stand)); tick(life, 20000); assert.equal(door.amount, 0);
});
