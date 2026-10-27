const CELL = 24;

// Four-direction A* in world coordinates; projected screen coordinates never affect paths.
export class Navigation {
  constructor(layout) {
    this.layout = layout;
    this.cols = Math.ceil(layout.width / CELL) + 1;
    this.rows = Math.ceil(layout.height / CELL) + 1;
    this.open = new Uint8Array(this.cols * this.rows);
    for (let y = 0; y < this.rows; y++) for (let x = 0; x < this.cols; x++) {
      this.open[y * this.cols + x] = this.isWalkable({ x: x * CELL, y: y * CELL }) ? 1 : 0;
    }
  }

  isWalkable(p) {
    if (this.layout.isWalkable) return this.layout.isWalkable(p);
    const b = this.layout.walkBounds;
    if (p.x < b.x || p.y < b.y || p.x > b.x + b.w || p.y > b.y + b.h) return false;
    const hall = this.layout.hallway;
    const inHall = p.y >= hall.y0 + 8 && p.y <= hall.y1 - 8;
    const inRoom = Object.values(this.layout.rooms).some(r =>
      (p.x >= r.x + 12 && p.x <= r.x + r.w - 12 && p.y >= r.y + 12 && p.y <= r.y + r.h - 12)
      || (r.doors || [r.door]).some(d => Math.abs(p.x - d.x) <= 62 && Math.abs(p.y - d.y) <= 24));
    const inWalkway = this.layout.walkways?.some(r => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);
    if (!inHall && !inRoom && !inWalkway) return false;
    return !this.layout.obstacles.some(r => p.x > r.x - 9 && p.x < r.x + r.w + 9 && p.y > r.y - 9 && p.y < r.y + r.h + 9);
  }

  nearest(p) {
    let best = -1, distance = Infinity;
    const gx = Math.round(p.x / CELL), gy = Math.round(p.y / CELL);
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = gx + dx, y = gy + dy;
      if (x < 0 || y < 0 || x >= this.cols || y >= this.rows || !this.open[y * this.cols + x]) continue;
      const d = Math.hypot(x * CELL - p.x, y * CELL - p.y);
      if (d < distance) { best = y * this.cols + x; distance = d; }
    }
    return best;
  }

  findPath(from, to) {
    const start = this.nearest(from), end = this.nearest(to);
    if (start < 0 || end < 0) return [];
    const point = n => ({ x: (n % this.cols) * CELL, y: Math.floor(n / this.cols) * CELL });
    const endPoint = point(end);
    const h = n => { const p = point(n); return (Math.abs(p.x - endPoint.x) + Math.abs(p.y - endPoint.y)) / CELL; };
    const scores = new Map([[start, 0]]), pending = new Map([[start, h(start)]]), previous = new Map();
    while (pending.size) {
      let current = -1, lowest = Infinity;
      for (const [n, score] of pending) if (score < lowest) { lowest = score; current = n; }
      pending.delete(current);
      if (current === end) {
        const nodes = [end];
        while (nodes[0] !== start) nodes.unshift(previous.get(nodes[0]));
        const path = nodes.map(point);
        if (this.isWalkable(to)) path.push({ x: to.x, y: to.y });
        return path;
      }
      const x = current % this.cols, y = Math.floor(current / this.cols);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, next = ny * this.cols + nx;
        if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows || !this.open[next]) continue;
        const score = scores.get(current) + 1;
        if (score >= (scores.get(next) ?? Infinity)) continue;
        previous.set(next, current); scores.set(next, score); pending.set(next, score + h(next));
      }
    }
    return [];
  }
}
