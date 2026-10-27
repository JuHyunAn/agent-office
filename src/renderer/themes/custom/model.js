import baseLayout from '../pixel-office/layout.js';
import { MATERIALS, TILE, GRID, ROLES, isFloor, isWall } from './catalog.js';
import { environmentSettings } from './environment.js';

// 기본 사무실의 본관·별채·연결 통로가 차지하는 바닥의 합집합 면적.
export function unionArea(rects) {
  const xs = [...new Set(rects.flatMap(r => [r.x, r.x + r.w]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 1; i < xs.length; i++) {
    const ranges = rects.filter(r => r.x < xs[i] && r.x + r.w > xs[i - 1]).map(r => [r.y, r.y + r.h]).sort((a, b) => a[0] - b[0]);
    let end = -Infinity, height = 0;
    for (const [a, b] of ranges) { height += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); }
    area += (xs[i] - xs[i - 1]) * height;
  }
  return area;
}
export const BASE_AREA = unionArea([{ x: 32, y: 64, w: 2056, h: 1136 }, baseLayout.rooms.ceo, baseLayout.rooms.restroom, ...baseLayout.walkways]);
export const MAX_AREA = BASE_AREA * 2;
export const LIMIT = 3456;
export const clone = value => JSON.parse(JSON.stringify(value));
export const normalizeName = value => typeof value === 'string' ? Array.from(value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 20).join('') : '';
export function footprint(item) {
  const m = MATERIALS[item.kind];
  return { x: item.x, y: item.y, w: item.rotation % 2 ? m.d : m.w, h: item.rotation % 2 ? m.w : m.d };
}
export function localPoint(item, x, y) {
  const { w, d } = MATERIALS[item.kind];
  const positions = [[x, y], [d - y, x], [w - x, d - y], [y, w - x]];
  const p = positions[item.rotation || 0]; return { x: item.x + p[0], y: item.y + p[1] };
}
export function approach(item) {
  const m = MATERIALS[item.kind];
  if (item.kind === 'door') return item.rotation % 2 ? { x: item.x + 48, y: item.y + TILE / 2 } : { x: item.x + TILE / 2, y: item.y + 48 };
  return localPoint(item, m.w / 2, m.d + 36);
}
const overlaps = (a, b, margin = 0) => a.x < b.x + b.w + margin && a.x + a.w > b.x - margin && a.y < b.y + b.h + margin && a.y + a.h > b.y - margin;
export function area(doc) { return doc.items.filter(isFloor).length * TILE * TILE; }
export function onFloor(doc, p) { return doc.items.some(i => isFloor(i) && p.x >= i.x && p.x <= i.x + TILE && p.y >= i.y && p.y <= i.y + TILE); }
export function snap(doc, item) {
  const next = { ...item, rotation: ((item.rotation || 0) % 4 + 4) % 4 };
  const unit = isFloor(next) ? TILE : GRID;
  next.x = Math.round(next.x / unit) * unit; next.y = Math.round(next.y / unit) * unit;
  if (isFloor(next)) next.rotation = 0;
  if (isWall(next)) {
    next.rotation %= 2;
    const existing = doc.items.some(i => i.id === next.id);
    const near = !existing && doc.items.filter(i => isWall(i) && Math.hypot(i.x - next.x, i.y - next.y) < 52)
      .sort((a, b) => Number(a.rotation !== next.rotation) - Number(b.rotation !== next.rotation) || Math.hypot(a.x - next.x, a.y - next.y) - Math.hypot(b.x - next.x, b.y - next.y))[0];
    if (near) { next.x = near.x; next.y = near.y; next.rotation = near.rotation; }
    const horizontal = next.rotation === 0;
    for (const other of doc.items.filter(i => i.id !== next.id && isWall(i))) {
      const f = footprint(other), endpoints = [{ x: other.x, y: other.y }, { x: other.x + (other.rotation % 2 ? 0 : f.w), y: other.y + (other.rotation % 2 ? f.h : 0) }];
      for (const p of endpoints) for (const offset of [0, TILE]) {
        const x = p.x - (horizontal ? offset : 0), y = p.y - (horizontal ? 0 : offset);
        if (Math.hypot(next.x - x, next.y - y) < 30) { next.x = x; next.y = y; return next; }
      }
    }
  }
  if (next.kind === 'chair') {
    for (const desk of doc.items.filter(i => i.kind === 'desk')) {
      const p = approach(desk), f = footprint(next);
      if (Math.hypot(next.x + f.w / 2 - p.x, next.y + f.h / 2 - p.y) < 60) {
        next.rotation = desk.rotation; next.x = p.x - 24; next.y = p.y - 24; break;
      }
    }
  }
  return next;
}
export function placementError(doc, item) {
  const f = footprint(item), m = MATERIALS[item.kind];
  if (f.x < 0 || f.y < 0 || f.x + f.w > LIMIT || f.y + f.h > LIMIT) return '제작 범위를 벗어났어요.';
  const others = doc.items.filter(i => i.id !== item.id);
  if (isFloor(item)) {
    if (others.some(i => isFloor(i) && i.x === item.x && i.y === item.y)) return '';
    if (area({ items: others }) + TILE * TILE > MAX_AREA) return '최대 면적은 기본 사무실의 두 배예요.';
    return '';
  }
  for (const p of [{ x: f.x + 6, y: f.y + 6 }, { x: f.x + f.w - 6, y: f.y + 6 }, { x: f.x + 6, y: f.y + f.h - 6 }, { x: f.x + f.w - 6, y: f.y + f.h - 6 }]) {
    if (!onFloor(doc, p)) return '먼저 이 위치에 바닥을 놓아 주세요.';
  }
  if (item.kind === 'entry' && others.some(i => i.kind === 'entry')) return '출입 위치는 하나예요. 기존 표시를 이동해 주세요.';
  if (m.walkable) return '';
  for (const other of others) {
    if (isFloor(other) || MATERIALS[other.kind].walkable) continue;
    const g = footprint(other);
    if (isWall(item) && isWall(other)) {
      if (item.x === other.x && item.y === other.y && item.rotation === other.rotation) continue;
      // 모서리에서 직교하는 벽의 기둥 겹침은 허용한다.
      if (item.rotation !== other.rotation && Math.min(f.x + f.w, g.x + g.w) - Math.max(f.x, g.x) <= 12 && Math.min(f.y + f.h, g.y + g.h) - Math.max(f.y, g.y) <= 12) continue;
    }
    if (overlaps(f, g)) return '다른 재료와 겹쳐요.';
  }
  return '';
}
export function place(doc, raw) {
  const item = snap(doc, raw), error = placementError(doc, item);
  if (error) return { error };
  const replaced = doc.items.find(i => i.id !== item.id && i.x === item.x && i.y === item.y && ((isFloor(item) && isFloor(i)) || (isWall(item) && isWall(i) && i.rotation === item.rotation)));
  if (item.name === undefined && replaced?.name) item.name = replaced.name;
  const items = doc.items.filter(i => i.id !== item.id && !(isFloor(item) && isFloor(i) && i.x === item.x && i.y === item.y)
    && !(isWall(item) && isWall(i) && i.x === item.x && i.y === item.y && i.rotation === item.rotation));
  return { doc: { ...doc, items: [...items, item] }, item };
}
export function walkable(doc, p) {
  if (![-8, 8].every(dx => [-8, 8].every(dy => onFloor(doc, { x: p.x + dx, y: p.y + dy })))) return false;
  return !doc.items.some(i => {
    const m = MATERIALS[i.kind];
    if (isFloor(i) || m.walkable || i.kind === 'chair') return false;
    const f = footprint(i);
    if (i.kind === 'door') {
      const middle = i.rotation % 2 ? p.y - i.y : p.x - i.x;
      if (middle > 42 && middle < TILE - 42) return false;
    }
    return p.x > f.x - 8 && p.x < f.x + f.w + 8 && p.y > f.y - 8 && p.y < f.y + f.h + 8;
  });
}
export function reachable(doc) {
  const entry = doc.items.find(i => i.kind === 'entry');
  if (!entry) return new Set();
  const start = { x: entry.x + 24, y: entry.y + 24 }, visited = new Set(), queue = [start];
  for (let index = 0; index < queue.length; index++) {
    const p = queue[index], key = `${p.x},${p.y}`;
    if (visited.has(key) || !walkable(doc, p)) continue;
    visited.add(key);
    for (const [dx, dy] of [[GRID, 0], [-GRID, 0], [0, GRID], [0, -GRID]]) {
      const next = { x: p.x + dx, y: p.y + dy };
      if (next.x >= 0 && next.y >= 0 && next.x <= LIMIT && next.y <= LIMIT && !visited.has(`${next.x},${next.y}`)) queue.push(next);
    }
  }
  return visited;
}
export function validate(doc) {
  const errors = [], floors = doc.items.filter(isFloor), entry = doc.items.find(i => i.kind === 'entry');
  if (!floors.length) errors.push({ text: '바닥이 필요해요.' });
  if (area(doc) > MAX_AREA) errors.push({ text: '바닥 면적이 최대치를 넘었어요.' });
  if (!entry) errors.push({ text: '출입 위치를 하나 놓아 주세요.' });
  if (!doc.items.some(i => i.kind === 'desk')) errors.push({ text: '업무 책상을 하나 이상 놓아 주세요.' });
  for (const item of doc.items) { const text = placementError(doc, item); if (text) errors.push({ id: item.id, text: `${MATERIALS[item.kind].label}: ${text}` }); }
  const cells = reachable(doc);
  if (entry && !cells.size) errors.push({ id: entry.id, text: '출입 위치가 막혀 있어요.' });
  const canReach = p => [...[0, -12, 12]].some(dx => [0, -12, 12].some(dy => cells.has(`${Math.round((p.x + dx) / GRID) * GRID},${Math.round((p.y + dy) / GRID) * GRID}`)));
  for (const floor of floors) if (![24, 96, 168].some(x => [24, 96, 168].some(y => cells.has(`${floor.x + x},${floor.y + y}`)))) errors.push({ id: floor.id, text: '출입구에서 갈 수 없는 바닥이 있어요. 통로나 문을 연결해 주세요.' });
  for (const item of doc.items.filter(i => MATERIALS[i.kind].action || i.kind === 'door')) {
    const p = item.kind === 'mat' ? localPoint(item, 48, 36) : approach(item);
    if (!walkable(doc, p) || !canReach(p)) errors.push({ id: item.id, text: `${MATERIALS[item.kind].label} 앞에 접근할 공간이 필요해요.` });
  }
  return errors;
}
export function makeLayout(doc) {
  const entry = doc.items.find(i => i.kind === 'entry'), start = entry ? { x: entry.x + 24, y: entry.y + 24 } : { x: 216, y: 216 };
  const floors = doc.items.filter(isFloor), xs = floors.map(i => i.x), ys = floors.map(i => i.y);
  const minX = Math.min(...xs, start.x), minY = Math.min(...ys, start.y), maxX = Math.max(...xs.map(x => x + TILE), start.x + GRID), maxY = Math.max(...ys.map(y => y + TILE), start.y + GRID);
  const rooms = {};
  for (const [role, label] of Object.entries(ROLES)) {
    const seats = doc.items.filter(i => i.kind === 'desk' && (i.role || 'dev') === role).map(i => ({ ...approach(i), facing: ['up', 'right', 'down', 'left'][i.rotation] }));
    const p = seats[0] || start;
    const name = doc.items.find(i => i.kind === 'desk' && (i.role || 'dev') === role && i.name)?.name;
    rooms[role] = { key: role, label: name || label, x: p.x - 24, y: p.y - 24, w: 48, h: 48, door: p, seats, wander: { x: start.x, y: start.y, w: 0, h: 0 } };
  }
  rooms.rest.seats = doc.items.filter(i => i.kind === 'sofa').map(approach);
  const interactions = doc.items.filter(i => MATERIALS[i.kind].action || i.kind === 'door').map(i => {
    const m = MATERIALS[i.kind], f = footprint(i), p = i.kind === 'mat' ? localPoint(i, 48, 36) : approach(i);
    return { id: i.id, label: i.name || m.label, room: i.role || 'rest', x: i.x, y: i.y, w: f.w, d: f.h, height: m.h,
      stand: p, action: i.kind === 'door' ? 'visit' : m.action, menu: m.menu, door: i.kind === 'door', axis: i.rotation % 2 ? 'y' : 'x', description: '가까이 다가가 이용해요.' };
  });
  return { width: maxX + 24, height: maxY + 24, rooms, entrance: start, playerStart: start, interactions, obstacles: [],
    hallway: { y: start.y, y0: start.y, y1: start.y }, walkBounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    isWalkable: p => walkable(doc, p), customDocument: doc };
}
export function parseDocument(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.items) || value.items.length > 800) throw new Error('저장된 사무실 형식이 올바르지 않아요.');
  const ids = new Set();
  const items = value.items.map(i => {
    if (!MATERIALS[i.kind] || typeof i.id !== 'string' || i.id.length > 80 || ids.has(i.id) || !Number.isFinite(i.x) || !Number.isFinite(i.y) || !Number.isInteger(i.rotation) || i.rotation < 0 || i.rotation > 3) throw new Error('저장된 재료 정보를 읽을 수 없어요.');
    const name = normalizeName(i.name);
    ids.add(i.id); return { id: i.id, kind: i.kind, x: i.x, y: i.y, rotation: i.rotation, ...(ROLES[i.role] ? { role: i.role } : {}), ...(name ? { name } : {}) };
  });
  const background = typeof value.background === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(value.background) && value.background.length < 2000000 ? value.background : null;
  const doc = { version: 1, items, background, ...(value.environment ? { environment: environmentSettings(value.environment) } : {}) };
  if (validate(doc).length) throw new Error('저장된 사무실의 배치나 동선을 확인해야 해요.');
  return doc;
}
export function exampleDocument() {
  const items = []; let n = 0;
  const add = (kind, x, y, rotation = 0, role) => items.push({ id: `sample-${++n}`, kind, x, y, rotation, ...(role ? { role } : {}) });
  for (let y = 192; y < 1344; y += TILE) for (let x = 192; x < 1728; x += TILE) add(x >= 1152 ? 'floor-mint' : y >= 960 ? 'floor-stone' : 'floor-wood', x, y);
  for (let x = 192; x < 1728; x += TILE) add(x === 960 ? 'wall-blue' : 'window', x, 192);
  for (let y = 192; y < 1344; y += TILE) add(y === 576 ? 'door' : 'wall-blue', 192, y, 1);
  add('entry', 264, 648);
  for (const [x, y, role] of [[432, 384, 'analysis'], [744, 384, 'planning'], [1056, 384, 'lead'], [432, 720, 'dev'], [744, 720, 'review'], [1056, 720, 'skills']]) {
    add('desk', x, y, 0, role); add('chair', x + 48, y + 84);
  }
  add('coffee', 1392, 384); add('plant', 1632, 288); add('bookshelf', 1344, 672);
  add('sofa', 1392, 960); add('round-table', 1056, 1104); add('arcade', 672, 1104);
  add('vending', 864, 1104); add('lamp', 1632, 1152); add('plant', 384, 1152);
  add('rug', 1320, 912); add('mat', 432, 1104);
  return { version: 1, items, background: null };
}
