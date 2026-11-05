import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, getTheme } from '../src/renderer/themes/index.js';
import japan from '../src/renderer/themes/japan/theme.js';
import base from '../src/renderer/themes/pixel-office/theme.js';
import { OfficeView } from '../src/renderer/office/view.js';
import { isOfficeForeground } from '../src/renderer/themes/japan/scenery.js';

test('일본 테마의 앞쪽 나무·가로등·편의점은 사무실보다 나중에 그린다', () => {
  for (const point of [{ x: 150, y: 1890 }, { x: 1030, y: 1890 }, { x: 2140, y: 810 }, { x: 520, y: 2310, w: 520, d: 330 }]) {
    assert.equal(isOfficeForeground(point), true, JSON.stringify(point));
  }
  for (const point of [{ x: 1360, y: -610 }, { x: 500, y: -800, w: 300, d: 300 }]) {
    assert.equal(isOfficeForeground(point), false, JSON.stringify(point));
  }
});

test('기존 네 테마의 순서와 배치도를 유지하고 일본 테마를 추가한다', () => {
  assert.deepEqual(THEMES.map(t => t.id), ['pixel-office', 'pixel-office-plain', 'pixel-office-citypop', 'custom-office', 'pixel-office-japan']);
  assert.strictEqual(getTheme(japan.id), japan);
  assert.equal(japan.name, '일본');
  assert.strictEqual(japan.layout, base.layout);
});

test('일본 테마의 모든 좌석과 상호작용 지점은 동일한 월드 좌표로 역변환된다', () => {
  const points = [...Object.values(japan.layout.rooms).flatMap(r => r.seats), ...japan.layout.interactions];
  for (const { x, y } of points) {
    const p = japan.project(x, y), actual = japan.unproject(p.x, p.y);
    assert.ok(Math.abs(actual.x - x) < 1.5 && Math.abs(actual.y - y) < 1.5, JSON.stringify({ x, y, actual }));
    assert.ok(p.x > 0 && p.x < japan.viewport.width && p.y > 0 && p.y < japan.viewport.height);
  }
  let hits = 0;
  for (let x = 200; x < 2800; x += 31) for (let y = 200; y < 1800; y += 29) {
    const px = x + .125, py = y + .125, item = base.hitTest(px, py);
    assert.strictEqual(japan.hitTest(px * .82 + 200, py * .82 + 280), item);
    if (item) hits++;
  }
  assert.ok(hits > 20);
});

test('일본 테마를 오가도 생활 상태·소지 음료·카메라는 유지한다', async () => {
  const prior = globalThis.window; globalThis.window = { devicePixelRatio: 1 };
  try {
    const view = Object.create(OfficeView.prototype);
    view.canvas = { style: {}, parentElement: { clientWidth: 1000, clientHeight: 720 } };
    view.view = { dpr: 1 }; view.theme = base; view.engine = { setLayout() { assert.fail('공유 배치를 재생성하면 안 됩니다.'); } };
    view.life = { player: { heldItem: { id: 'latte' } }, menu: { id: 'lounge-coffee' } };
    view.resize(); view.camera.zoomAt(1.5);
    const { life, camera } = view;
    for (const t of [japan, base]) {
      await view.setTheme({ ...t, load: null });
      assert.strictEqual(view.life, life); assert.strictEqual(view.camera, camera);
      assert.equal(camera.zoom, 1.5); assert.equal(view.life.player.heldItem.id, 'latte');
      assert.equal(view.life.menu.id, 'lounge-coffee');
    }
  } finally { if (prior === undefined) delete globalThis.window; else globalThis.window = prior; }
});
