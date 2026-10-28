import { test } from 'node:test';
import assert from 'node:assert/strict';
import layout from '../src/renderer/themes/pixel-office/layout.js';
import { OfficeCamera } from '../src/renderer/office/camera.js';
import { OfficeLife, COFFEE_MENU } from '../src/renderer/office/life.js';
import { OfficeEngine } from '../src/renderer/office/engine.js';
import { createAppearance, HAIR_STYLES, ACCESSORIES } from '../src/renderer/office/appearance.js';

const advance = (life, ms) => { for (let i = 0; i < ms; i += 50) life.update(50); };
const makeLife = () => new OfficeLife(layout, new OfficeEngine(layout), () => 0.2);
function arrive(life, id) {
  assert.equal(life.interact(id), true);
  for (let i = 0; i < 1600 && !life.player.action && !life.menu; i++) life.update(50);
}

test('전체 보기에서는 고정되고 확대 후에도 화면 가장자리를 벗어나지 않는다', () => {
  const camera = new OfficeCamera(); camera.resize(1000, 700, 3200, 2000);
  const fit = { x: camera.ox, y: camera.oy };
  camera.pan(5000, -5000); assert.deepEqual({ x: camera.ox, y: camera.oy }, fit);
  camera.zoomAt(0.1); assert.equal(camera.zoom, 1); assert.deepEqual({ x: camera.ox, y: camera.oy }, fit);
  camera.zoomAt(2); const before = camera.ox; camera.pan(70, 50); assert.notEqual(camera.ox, before);
  camera.pan(5000, -5000); assert.equal(camera.ox, 0); assert.equal(camera.oy, camera.ch - camera.height * camera.scale);
  camera.fit(); camera.resize(800, 900, 3200, 2000); camera.pan(0, 500);
  assert.equal(camera.oy, (900 - 2000 * camera.scale) / 2);
});

test('축소 하한을 낮추면 100% 아래로 줄어들고 가운데에 고정되며, 되돌리면 다시 100% 가 하한이다', () => {
  const camera = new OfficeCamera(); camera.resize(1120, 680, 3200, 2000);
  camera.zoomAt(0.1); assert.equal(camera.zoom, 1);
  camera.minZoom = 0.4; camera.zoomAt(0.1); assert.equal(camera.zoom, 0.4);
  assert.equal(camera.ox, (1120 - 3200 * camera.scale) / 2); assert.equal(camera.oy, (680 - 2000 * camera.scale) / 2);
  camera.pan(300, 300); assert.equal(camera.ox, (1120 - 3200 * camera.scale) / 2);
  camera.minZoom = 1; camera.zoomAt(0.5); assert.equal(camera.zoom, 1);
});

test('전체 보기(100%)는 양옆 빈 공간 없이 가로를 채우되 세로 맞춤의 116%까지만 확대한다', () => {
  const camera = new OfficeCamera();
  camera.resize(1120, 680, 3200, 2000); // 가로가 남는 화면: 가로에 맞춘다
  assert.equal(camera.scale, 1120 / 3200); assert.equal(camera.ox, 0);
  camera.pan(0, -500); assert.equal(camera.oy, 0); // 넘치면 사무실 위쪽을 맞추고 아래 외벽만 잘리며, 100% 에서는 고정
  camera.zoomAt(2); camera.fit(); assert.equal(camera.oy, 0);
  camera.resize(1600, 600, 3200, 2000); // 아주 넓은 화면: 116% 에서 멈춘다
  assert.equal(camera.scale, (600 / 2000) * 1.16);
  camera.resize(800, 900, 3200, 2000); // 세로로 긴 화면은 지금처럼 가로 맞춤
  assert.equal(camera.scale, 800 / 3200);
});

test('외형은 머리·악세서리 조합으로 다양해지고 작업 이벤트 후에도 유지된다', () => {
  let seed = 1234;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const looks = Array.from({ length: 80 }, () => createAppearance(random));
  assert.ok(looks.every(a => HAIR_STYLES.includes(a.hair) && ACCESSORIES.includes(a.accessory)));
  assert.ok(new Set(looks.map(a => `${a.hair}:${a.accessory}`)).size > 20);
  assert.ok(looks.some(a => a.accessory === 'headset') && looks.some(a => a.accessory === 'glasses'));
  const engine = new OfficeEngine(layout, { random });
  engine.handleEvent({ session_id: 's', hook_event_name: 'UserPromptSubmit', prompt: '작업' });
  const before = { ...engine.snapshot()[0].appearance };
  engine.handleEvent({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'README.md' } });
  engine.update(250); assert.deepEqual(engine.snapshot()[0].appearance, before);
});

test('커피는 도착 후 선택·제조하며 이동 중에도 유지되고 45초 후 사라진다', () => {
  for (const drink of COFFEE_MENU) {
    const life = makeLife();
    assert.equal(life.chooseDrink(drink.id), false);
    arrive(life, 'lounge-coffee'); assert.equal(life.menu.choices.length, COFFEE_MENU.length);
    assert.equal(life.player.heldItem, null);
    assert.equal(life.chooseDrink('missing'), false); assert.ok(life.menu);
    assert.equal(life.chooseDrink(drink.id), true); life.update(50);
    assert.equal(life.player.action, 'brew'); assert.equal(life.player.heldItem, null);
    advance(life, 2400); assert.equal(life.player.action, 'drink'); assert.equal(life.player.heldItem.id, drink.id);
    assert.equal(life.player.heldItem.image, drink.image);
    const expires = life.player.heldItem.until;
    assert.equal(life.moveTo({ x: 1450, y: 576 }), true);
    advance(life, 1000); assert.ok(life.player.path.length); assert.equal(life.player.heldItem.id, drink.id);
    advance(life, expires - life.time - 50); assert.equal(life.player.heldItem.id, drink.id);
    life.update(50); assert.equal(life.player.heldItem, null);
  }
});

test('커피 선택 닫기·다른 곳으로 이동·제조 취소가 뒤늦은 컵 생성을 막는다', () => {
  const life = makeLife(); arrive(life, 'lounge-coffee');
  life.closeMenu(); assert.equal(life.menu, null); assert.equal(life.player.currentItem, null);
  arrive(life, 'lounge-coffee'); assert.equal(life.moveTo({ x: 1450, y: 576 }), true);
  assert.equal(life.menu, null); assert.equal(life.chooseDrink('latte'), false);
  arrive(life, 'lounge-coffee'); life.chooseDrink('latte'); life.update(50);
  assert.equal(life.player.action, 'brew'); life.moveTo({ x: 1450, y: 576 });
  advance(life, 10000); assert.equal(life.player.heldItem, null);
});

test('게임·물주기·독서·스트레칭은 도착 후 실행되고 효과와 점수도 종료된다', () => {
  for (const id of ['arcade', 'plant', 'reading', 'stretch']) {
    const life = makeLife(); arrive(life, id);
    assert.equal(life.player.action, layout.interactions.find(i => i.id === id).action);
    advance(life, 8500); assert.equal(life.player.action, null);
    if (id === 'arcade') { assert.ok(life.bestScore >= 100); assert.match(life.player.bubble.text, /점/); }
    advance(life, 5000); assert.equal(life.player.bubble, null);
    assert.ok(life.effects.every(e => e.until > life.time));
  }
});
