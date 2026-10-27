import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawCityscape, CITY_BLOCKS } from '../src/renderer/themes/pixel-office/cityscape.js';

test('시티팝 도시는 이미지 없이 같은 픽셀 격자로 그려지고 다시 그려도 일정하다', () => {
  function render() {
    let count = 0, hash = 2166136261;
    const colors = new Set();
    const ctx = { fillStyle: '', fillRect(x, y, w, h) {
      assert.ok([x, y, w, h].every(v => Number.isFinite(v) && Number.isInteger(v * 2)));
      assert.ok(w > 0 && h > 0);
      colors.add(this.fillStyle); count++;
      for (const value of [x, y, w, h]) hash = Math.imul(hash ^ value * 2, 16777619);
    } };
    drawCityscape(ctx, { width: 1600, height: 1000 });
    return { count, hash, colors: [...colors] };
  }
  const first = render();
  assert.ok(first.count > 20000);
  assert.ok(first.colors.length > 200);
  assert.deepEqual(render(), first);
});

test('가까운 빌딩은 사무실과 같은 사선으로 화면 아래까지 이어지고 중경은 압축된다', () => {
  const near = CITY_BLOCKS.filter(b => b.slope === 0.5);
  const middle = CITY_BLOCKS.filter(b => b.slope < 0.5);
  assert.ok(near.length >= 4 && middle.length >= 3);
  assert.ok(near.every(b => b.y + b.h > 1000));
  assert.ok(Math.min(...near.map(b => b.a + b.b)) > Math.max(...middle.map(b => b.a + b.b)));
  assert.ok(new Set(CITY_BLOCKS.map(b => b.h)).size > 5);
});
