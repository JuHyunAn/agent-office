import { polygon, line } from './raster.js';

const BOTTOM = -1400;
const FLOOR_HEIGHT = 102;

// 점등과 실내 배치는 매번 바뀌지 않도록 고정된 정수로 결정한다.
function variation(a, b, c = 0) {
  let n = Math.imul(a + 1, 73856093) ^ Math.imul(b + 7, 19349663) ^ Math.imul(c + 13, 83492791);
  n = Math.imul(n ^ n >>> 16, 2246822519);
  return ((n ^ n >>> 13) >>> 0) / 4294967296;
}

export function drawPixelBuilding(ctx, { faces, project, width, height }) {
  // 긴 벽을 나눠 별채와 본관이 겹칠 때 가까운 면부터 자연스럽게 가려지게 한다.
  const walls = faces.flatMap((wall, index) => {
    const length = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1), count = Math.ceil(length / 360);
    return Array.from({ length: count }, (_, i) => ({
      x1: wall.x1 + (wall.x2 - wall.x1) * i / count, y1: wall.y1 + (wall.y2 - wall.y1) * i / count,
      x2: wall.x1 + (wall.x2 - wall.x1) * (i + 1) / count, y2: wall.y1 + (wall.y2 - wall.y1) * (i + 1) / count,
      seed: index * 31 + i,
    }));
  }).sort((a, b) => a.x1 + a.y1 + a.x2 + a.y2 - b.x1 - b.y1 - b.x2 - b.y2);

  for (const wall of walls) {
    const { x1, y1, x2, y2, seed } = wall;
    const length = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / length, uy = (y2 - y1) / length;
    const side = x1 === x2;
    const p = (u, z) => project(x1 + ux * u, y1 + uy * u, z);
    const face = (a, b, bottom, top, color) => polygon(ctx, [p(a, bottom), p(b, bottom), p(b, top), p(a, top)], color);
    face(0, length, BOTTOM, -16, side ? '#263346' : '#34394e');

    for (let row = 0, top = -16; top > BOTTOM; row++, top -= FLOOR_HEIGHT) {
      if (Math.min(p(0, top).y, p(length, top).y) > height + 8) break;
      const columns = 2, bay = length / columns;
      const recessed = row % 4 === 2;
      for (let col = 0; col < columns; col++) {
        const start = col * bay + 9, end = (col + 1) * bay - 9;
        const z = top - 11, bottom = top - 84, glassWidth = (end - start) * 0.36;
        const origin = p(start, z);
        if (origin.x < -150 || origin.x > width + 150) continue;
        const lit = variation(seed, row, col) < (row > 4 ? 0.24 : 0.39);
        const warm = variation(seed + 2, row, col) > 0.25;
        const room = lit ? warm ? '#bba17d' : '#7d99a2' : side ? '#29394c' : '#3a4560';
        const edge = side ? '#192938' : '#242d43';
        face(start - 3, end + 3, bottom - 3, z + 3, edge);
        face(start, end, bottom, z, room);
        // 창 안의 사물도 유리 면과 같은 투영으로 작은 픽셀 도형을 그린다.
        const rect = (x, y, w, h, color) => face(start + x / 0.36, start + (x + w) / 0.36, z - y - h, z - y, color);
        const roomHeight = z - bottom;
        if (lit) {
          rect(1, roomHeight - 19, glassWidth - 2, 18, warm ? '#857a72' : '#536d79');
          rect(2, 4, glassWidth - 4, 2, warm ? '#f0d6a1' : '#c1d3cf');
          const kind = Math.floor(variation(seed + 4, row, col) * 3);
          if (kind === 0) {
            const desk = Math.min(24, glassWidth - 12);
            rect(6, 47, desk, 4, '#caa379'); rect(8, 51, 2, 11, '#4f4c56'); rect(desk + 2, 51, 2, 11, '#4f4c56');
            rect(11, 35, 10, 10, '#343f50'); rect(12, 36, 8, 6, '#80bfc0'); rect(15, 45, 2, 2, '#435360');
            rect(5, 42, 3, 5, '#e7cda0');
          } else if (kind === 1) {
            rect(5, 45, Math.min(26, glassWidth - 10), 10, '#706b85');
            rect(7, 42, Math.min(22, glassWidth - 14), 7, '#9b8a9e');
            rect(4, 46, 3, 13, '#555a71'); rect(Math.min(29, glassWidth - 6), 46, 3, 13, '#555a71');
            rect(10, 59, 14, 3, '#d4af8b');
          } else {
            const shelfX = glassWidth - 15;
            rect(shelfX, 17, 11, 43, '#665d63');
            for (let shelf = 0; shelf < 3; shelf++) {
              rect(shelfX + 1, 28 + shelf * 12, 9, 2, '#bf9e80');
              for (let book = 0; book < 3; book++) rect(shelfX + 2 + book * 2.5, 21 + shelf * 12, 1.5, 7, ['#aeb7a0', '#b48d97', '#8ba6b0'][book]);
            }
          }
          if (variation(seed + 8, row, col) < 0.55) {
            rect(glassWidth - 9, 56, 5, 5, '#a77b65'); rect(glassWidth - 8, 48, 3, 9, '#516f68');
            rect(glassWidth - 12, 47, 8, 3, '#779b7d'); rect(glassWidth - 9, 43, 6, 3, '#93b091');
          }
        }
        const blinds = variation(seed + 10, row, col);
        if (blinds < 0.38) {
          const h = Math.floor(14 + variation(seed, row + 20, col) * 33);
          rect(1, 1, glassWidth - 2, h, lit ? '#7c8090' : '#3c4c64');
          for (let y = 3; y < h; y += 4) rect(2, y, glassWidth - 4, 0.5, lit ? '#b4b0ad' : '#60718a');
        }
        // 반사광은 적은 색의 단계적인 띠와 가는 픽셀 선으로 표현한다.
        const reflection = (seed + row * 2 + col) % 7;
        if (reflection === 0 || reflection === 3) {
          const x = glassWidth * 0.56;
          rect(x, 2, 4, roomHeight - 4, '#b893cd28'); rect(x + 4, 9, 2, roomHeight - 14, '#dd9bce32');
          rect(x - 3, roomHeight * 0.4, 3, roomHeight * 0.4, '#9daed326');
        } else rect(glassWidth - 4, 1, 1, roomHeight - 2, '#a6becd2a');
        line(ctx, p(start, z), p(end, z), '#6b7990');
        line(ctx, p(end, bottom), p(end, z), '#516277');
        if (glassWidth > 42 && variation(seed + 12, row, col) < 0.6) {
          const middle = (start + end) / 2;
          face(middle - 1, middle + 1, bottom, z, '#26374b');
          line(ctx, p(middle + 1, bottom), p(middle + 1, z), '#64718a');
        }
      }
      face(0, length, top - 102, top - 88, recessed ? '#283347' : side ? '#303c50' : '#44485c');
      line(ctx, p(0, top - 88), p(length, top - 88), '#737789');
      line(ctx, p(0, top - 101), p(length, top - 101), '#202c40');
    }
    face(0, 7, BOTTOM, -16, side ? '#374353' : '#515366');
    line(ctx, p(7, BOTTOM), p(7, -16), '#75768a');
    face(length - 6, length, BOTTOM, -16, '#263246');
    line(ctx, p(0, -19), p(length, -19), '#aaa1b0');
    line(ctx, p(0, -22), p(length, -22), '#716480');
    if (seed % 4 === 0) line(ctx, p(0, -23), p(length, -23), '#c296bd');
  }
}
