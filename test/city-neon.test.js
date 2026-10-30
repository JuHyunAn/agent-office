import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CITY_BLOCKS, drawCityscape } from '../src/renderer/themes/pixel-office/cityscape.js';
import { NEON_SIGNS, NEON_FLICKERS, neonIsOff, neonPlacement } from '../src/renderer/themes/pixel-office/city-neon.js';

test('시티팝 간판은 건물의 사선과 가림 순서에 맞춰 배치된다', () => {
  const order = [];
  drawCityscape({ fillRect() {} }, { width: 1600, height: 1000 }, (_, block) => order.push(block));
  assert.equal(order.length, CITY_BLOCKS.length);
  assert.ok(order.every((block, i) => !i || block.y + (block.a + block.b) * block.slope >= order[i - 1].y + (order[i - 1].a + order[i - 1].b) * order[i - 1].slope));
  assert.equal(Object.values(NEON_SIGNS).flat().length, 10);
  for (const block of order) for (const sign of NEON_SIGNS[block.seed] || []) {
    const p = neonPlacement(block, sign);
    assert.equal(p.slope, sign.side ? -block.slope : block.slope);
    assert.ok([p.left, p.top, p.width, p.height].every(Number.isInteger));
    assert.ok(p.width > sign.w && p.height > sign.h);
    assert.ok(p.x >= p.left && p.y >= p.top && p.x + sign.w <= p.left + p.width);
  }
});

test('일부 간판만 서로 다른 주기로 짧게 소등되고 경계에서 정확히 복귀한다', () => {
  for (const f of NEON_FLICKERS) {
    assert.ok(NEON_SIGNS[f.seed].some(s => s.kind === f.kind));
    assert.ok(f.period >= 20000 && f.duration / f.period < .03);
    for (const cycle of [0, 1, 100]) {
      const start = f.period * cycle + f.start;
      assert.equal(neonIsOff(start - 1, f), false);
      assert.equal(neonIsOff(start, f), true);
      assert.equal(neonIsOff(start + f.duration - 1, f), true);
      assert.equal(neonIsOff(start + f.duration, f), false);
    }
    for (const t of [0, -1, NaN, Infinity]) assert.equal(neonIsOff(t, f), false);
  }
  assert.equal(new Set(NEON_FLICKERS.map(f => f.start)).size, NEON_FLICKERS.length);
});

test('소등 패치는 서로 겹치지 않아 다른 간판의 점멸 상태를 덮지 않는다', () => {
  const bounds = NEON_FLICKERS.map(f => {
    const block = CITY_BLOCKS.find(b => b.seed === f.seed);
    return neonPlacement(block, NEON_SIGNS[f.seed].find(s => s.kind === f.kind));
  });
  for (let i = 0; i < bounds.length; i++) for (const b of bounds.slice(i + 1)) {
    const a = bounds[i];
    assert.ok(a.left + a.width <= b.left || b.left + b.width <= a.left || a.top + a.height <= b.top || b.top + b.height <= a.top);
  }
});
