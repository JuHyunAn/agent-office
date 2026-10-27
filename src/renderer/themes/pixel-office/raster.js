// 사무실과 건물 외벽이 함께 사용하는 반 픽셀 격자.
export const PIXEL_DETAIL = 2;

export function polygon(ctx, points, color) {
  ctx.fillStyle = color;
  const minY = Math.ceil(Math.min(...points.map(p => p.y)) * PIXEL_DETAIL) / PIXEL_DETAIL;
  const maxY = Math.ceil(Math.max(...points.map(p => p.y)) * PIXEL_DETAIL) / PIXEL_DETAIL;
  for (let y = minY; y < maxY; y += 1 / PIXEL_DETAIL) {
    const xs = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) xs.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) ctx.fillRect(Math.round(xs[i] * PIXEL_DETAIL) / PIXEL_DETAIL, y, Math.max(1 / PIXEL_DETAIL, (Math.round(xs[i + 1] * PIXEL_DETAIL) - Math.round(xs[i] * PIXEL_DETAIL)) / PIXEL_DETAIL), 1 / PIXEL_DETAIL);
  }
}

export function line(ctx, a, b, color) {
  let x = Math.round(a.x * PIXEL_DETAIL), y = Math.round(a.y * PIXEL_DETAIL);
  const bx = Math.round(b.x * PIXEL_DETAIL), by = Math.round(b.y * PIXEL_DETAIL);
  const dx = Math.abs(bx - x), dy = -Math.abs(by - y);
  const sx = x < bx ? 1 : -1, sy = y < by ? 1 : -1;
  let error = dx + dy;
  ctx.fillStyle = color;
  for (;;) {
    ctx.fillRect(x / PIXEL_DETAIL, y / PIXEL_DETAIL, 1 / PIXEL_DETAIL, 1 / PIXEL_DETAIL);
    if (x === bx && y === by) break;
    const e = error * 2;
    if (e >= dy) { error += dy; x += sx; }
    if (e <= dx) { error += dx; y += sy; }
  }
}
