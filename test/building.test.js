import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawPixelBuilding } from '../src/renderer/themes/pixel-office/building.js';
import { TOWER_FACES } from '../src/renderer/themes/pixel-office/exterior.js';
import { projectPoint } from '../src/renderer/themes/pixel-office/theme.js';

test('건물은 원화 없이 사무실과 같은 반 픽셀 도형으로 그려지고 점등 배치가 일정하다', () => {
  function render() {
    let count = 0, hash = 2166136261;
    const colors = new Map();
    // 이미지·벡터 API 없이 픽셀 사각형만 허용한다.
    const ctx = { fillStyle: '', fillRect(x, y, w, h) {
      assert.ok([x, y, w, h].every(v => Number.isFinite(v) && Number.isInteger(v * 2)));
      assert.ok(w > 0 && h > 0);
      count++; colors.set(this.fillStyle, (colors.get(this.fillStyle) || 0) + 1);
      for (const value of [x, y, w, h]) hash = Math.imul(hash ^ value * 2, 16777619);
    } };
    drawPixelBuilding(ctx, { faces: TOWER_FACES, project: projectPoint, width: 1600, height: 1000 });
    return { count, hash, colors: [...colors].sort() };
  }
  const first = render();
  assert.ok(first.count > 10000);
  assert.ok(first.colors.length > 25);
  assert.ok(first.colors.some(([color]) => color === '#bba17d'));
  assert.deepEqual(render(), first);
});
