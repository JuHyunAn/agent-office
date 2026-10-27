import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOWER_FACES } from '../src/renderer/themes/pixel-office/exterior.js';
import { WINDOWS, windowPoints } from '../src/renderer/themes/pixel-office/atmosphere.js';
import theme, { projectPoint } from '../src/renderer/themes/pixel-office/theme.js';

test('공통 통창은 후면 네 곳에만 있고 왼쪽 외벽에는 창문이 없다', () => {
  assert.equal(WINDOWS.length, 4);
  assert.ok(WINDOWS.every(p => p.axis === 'x'));
  for (const pane of WINDOWS) {
    const points = windowPoints(pane, projectPoint);
    assert.equal(points.length, 4);
    assert.ok(points.every(p => p.x > 0 && p.x < 1600 && p.y >= 0 && p.y < 1000));
    assert.deepEqual(points[3], projectPoint(pane.x, pane.y, pane.top));
    assert.equal(points[0].y - points[3].y, pane.top - pane.bottom);
    const dx = points[1].x - points[0].x;
    assert.ok(pane.axis === 'x' ? dx > 0 : dx < 0);
  }
});

test('아래층 외벽은 본관과 두 별채의 바닥 끝에서 시작한다', () => {
  for (const key of ['ceo', 'restroom']) {
    const room = theme.layout.rooms[key];
    assert.ok(TOWER_FACES.some(face => face.x1 === room.x && face.y1 === room.y + room.h && face.x2 === room.x + room.w && face.y2 === room.y + room.h));
  }
  assert.ok(TOWER_FACES.some(face => face.y1 === 1200 && face.y2 === 1200));
});
