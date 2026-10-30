import { polygon, line } from './raster.js';

// 가까운 건물은 사무실과 같은 2:1 사선, 먼 건물은 수평에 가까운 시점으로 그린다.
export const CITY_BLOCKS = [
  { x: 70, y: 468, a: 110, b: 138, h: 800, slope: 0.5, seed: 31, style: 'terrace' },
  { x: 204, y: 305, a: 72, b: 101, h: 740, slope: 0.5, seed: 41, style: 'stone' },
  { x: -40, y: 272, a: 96, b: 72, h: 820, slope: 0.5, seed: 55, style: 'glass' },
  { x: 368, y: 290, a: 67, b: 52, h: 380, slope: 0.38, seed: 19, style: 'glass' },
  { x: 514, y: 247, a: 51, b: 43, h: 330, slope: 0.32, seed: 8, style: 'stone' },
  { x: 1108, y: 253, a: 60, b: 49, h: 320, slope: 0.32, seed: 23, style: 'glass' },
  { x: 1277, y: 293, a: 71, b: 57, h: 460, slope: 0.38, seed: 61, style: 'terrace' },
  { x: 1458, y: 228, a: 76, b: 102, h: 840, slope: 0.5, seed: 13, style: 'glass' },
  { x: 1609, y: 375, a: 132, b: 130, h: 900, slope: 0.5, seed: 71, style: 'terrace' },
];

function random(a, b = 0, c = 0) {
  let n = Math.imul(a + 17, 73856093) ^ Math.imul(b + 29, 19349663) ^ Math.imul(c + 53, 83492791);
  n = Math.imul(n ^ n >>> 16, 2246822519);
  return ((n ^ n >>> 13) >>> 0) / 4294967296;
}

const snap = value => Math.round(value * 2) / 2;
function rect(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(snap(x), snap(y), Math.max(0.5, snap(w)), Math.max(0.5, snap(h)));
}
function mix(a, b, t) {
  const channels = [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t));
  return '#' + channels.map(v => v.toString(16).padStart(2, '0')).join('');
}

function sky(ctx, width, height) {
  const stops = [[0, '#171d3d'], [90, '#2c2c5c'], [170, '#755486'], [250, '#bc7f9f'], [390, '#b58caa'], [height, '#383b61']];
  for (let y = 0; y < height; y++) {
    const i = stops.findIndex(s => s[0] > y), [end, to] = stops[i < 0 ? stops.length - 1 : i], [start, from] = stops[Math.max(0, i - 1)];
    rect(ctx, 0, y, width, 1, mix(from, to, (y - start) / Math.max(1, end - start)));
  }
  // 길게 흐르는 구름의 윤곽과 얇은 밑빛을 작은 픽셀로 나눠 그린다.
  const clouds = [[-75, 88, 295, 17], [380, 44, 355, 13], [930, 80, 430, 22], [1330, 164, 350, 13],
    [110, 176, 350, 15], [595, 142, 285, 12], [910, 219, 335, 8], [-40, 239, 430, 7], [380, 259, 285, 6]];
  for (let cloud = 0; cloud < clouds.length; cloud++) {
    const [x, y, w, h] = clouds[cloud];
    for (let i = 0; i < w; i++) {
      const t = i / w, taper = Math.sin(t * Math.PI) ** 0.7;
      const wave = Math.sin(t * 19 + cloud) * 0.18 + Math.sin(t * 43) * 0.12;
      const size = h * taper * (0.6 + wave), py = y - t * 13 + Math.sin(t * 6) * 4;
      const ragged = random(cloud, Math.floor(i / 3), 9) * 2;
      rect(ctx, x + i, py - size, 1, size + ragged, cloud % 3 ? '#44456d85' : '#333d6280');
      rect(ctx, x + i, py - size * 0.25, 1, size * 0.25 + ragged, '#a474a45c');
      if (i % 5 < 3) rect(ctx, x + i, py + ragged, 1, 0.5, '#d19ab66a');
    }
  }
  for (let i = 0; i < 2600; i++) {
    rect(ctx, random(i, 5) * width, random(i, 6) * 290, 0.5, 0.5, i % 2 ? '#f1bed014' : '#101e3b12');
  }
  for (let i = 0; i < 135; i++) {
    const x = random(i, 12) * width, y = random(i, 13) * 220;
    rect(ctx, x, y, i % 19 ? 0.5 : 1, 0.5, i % 3 ? '#c8c4dc70' : '#d9e5ecb0');
  }
  // 초승달도 반 픽셀 행 단위로 그려 원화나 벡터 곡선을 사용하지 않는다.
  const mx = 296, my = 100, radius = 25;
  for (let y = -radius; y <= radius; y += 0.5) {
    const outer = Math.sqrt(Math.max(0, radius * radius - y * y));
    const inner = Math.abs(y + 8) < 24 ? Math.sqrt(24 * 24 - (y + 8) ** 2) : 0;
    const right = inner ? Math.min(outer, 9 - inner) : outer;
    if (right > -outer) rect(ctx, mx - outer, my + y, right + outer, 0.5, '#f2d6b5');
  }
}

function reflectedBuilding(ctx, x, base, w, h, color, seed) {
  // 윤곽은 아래로 압축하고 가로 잔물결마다 끊어 흐린 수면 반사로 표현한다.
  const depth = Math.min(88, h * 0.72);
  for (let y = 1; y < depth; y += 1.5) {
    if (random(seed, Math.floor(y), 71) < 0.16) continue;
    const fade = (1 - y / depth) ** 1.6;
    const drift = Math.sin(y * 0.47 + seed) * (1 + y * 0.035);
    const alpha = Math.max(1, Math.round(52 * fade)).toString(16).padStart(2, '0');
    rect(ctx, x + drift - 2, base + y, w + 4, 1, color + Math.max(1, Math.round(16 * fade)).toString(16).padStart(2, '0'));
    rect(ctx, x + drift, base + y, w, 1, color + alpha);
  }
}

function reflectedLight(ctx, x, y, base, color, seed) {
  const depth = (base - y) * 0.72;
  if (depth < 0) return;
  const drift = Math.sin(depth * 0.47 + seed) * (1 + depth * 0.035);
  const opacity = Math.max(9, 43 - depth * 0.3);
  for (let i = 0; i < 3; i++) {
    const alpha = Math.round(opacity * (1 - i * 0.24)).toString(16).padStart(2, '0');
    rect(ctx, x + drift - 1 - i, base + depth + i * 1.5, 3 + i * 2, 0.5, color + alpha);
  }
}

function distantCity(ctx, width) {
  // 강은 수평선으로 압축하고 먼 창문은 작은 불빛만 남긴다.
  for (let y = 202; y < 500; y++) rect(ctx, 0, y, width, 1, mix('#a78fae', '#303957', (y - 202) / 298));
  for (let i = 0; i < 1150; i++) {
    const y = 210 + random(i, 81) ** 1.9 * 230;
    const x = random(i, 82) * width;
    rect(ctx, x, y, 1 + (y - 202) / 30 * random(i, 83), 0.5, ['#b5a6c12b', '#cf9abd36', '#7298b338'][i % 3]);
  }
  for (let layer = 0; layer < 3; layer++) {
    let x = -15;
    for (let i = 0; x < width; i++) {
      const seed = i + layer * 100, w = 9 + random(seed, 1) * (15 + layer * 10);
      const base = 202 + layer * 14 + Math.sin(x / 220) * 3, h = 14 + random(seed, 2) ** 2 * (42 + layer * 30);
      const color = ['#9383a2', '#7a7398', '#5c6089'][layer], top = base - h;
      const crown = i % 5, setback = crown === 1 ? h * 0.24 : 0;
      reflectedBuilding(ctx, x, base, w, h, color, seed);
      rect(ctx, x, top + setback, w, h - setback, color);
      rect(ctx, x + w - 3, top + setback, 3, h - setback, ['#877c9c', '#706a91', '#50577f'][layer]);
      if (crown === 1) {
        rect(ctx, x + w * 0.16, top, w * 0.68, setback, color);
        rect(ctx, x + w * 0.32, top - 4, w * 0.36, 4, color);
      } else if (crown === 2) {
        polygon(ctx, [{ x, y: top + 6 }, { x: x + w - 3, y: top }, { x: x + w, y: top + 3 }, { x: x + w, y: top + 8 }, { x, y: top + 8 }], color);
      }
      if (i % 9 === 0) {
        rect(ctx, x + w / 2, top - 12, 0.5, 12, '#b89eb7');
        rect(ctx, x + w / 2, top - 13, 1, 0.5, '#e8b7c9');
      }
      for (let row = 0; row < (h - setback) / 4 - 1; row++) for (let col = 0; col < w / 3 - 1; col++) {
        const chance = random(seed, Math.floor(row / 3), Math.floor(col / 2)) < 0.4 ? 0.59 : 0.12;
        if (random(seed + 19, row, col) < chance) {
          const wx = x + 2 + col * 3, wy = top + setback + 3 + row * 4;
          const light = ['#d9b6bb', '#a8bec6', '#e5c6a1'][(row + col) % 3];
          rect(ctx, wx, wy, 1, 1, light);
          reflectedLight(ctx, wx, wy, base, light, seed);
        }
      }
      if (i % 3 === 0) for (let row = 1; row < h / 12; row++) rect(ctx, x, base - row * 12, w, 0.5, '#a9a0b92b');
      for (let ripple = 0; ripple < 3; ripple++) {
        rect(ctx, x - 3 + random(seed, ripple, 73) * w, base + 2 + ripple * 5, 4 + random(seed, ripple, 74) * 12, 0.5, '#c9aec138');
      }
      x += w + 2 + random(seed, 4) * 6;
    }
  }
  // 원경의 눈에 띄는 탑 두 개는 계단식 꼭대기와 작은 수직 불빛으로 구분한다.
  for (const [x, base, w, h] of [[332, 236, 33, 131], [1200, 233, 29, 112]]) {
    reflectedBuilding(ctx, x, base, w, h, '#62638b', x);
    rect(ctx, x, base - h + 22, w, h - 22, '#62638b');
    rect(ctx, x + 4, base - h + 9, w - 8, 13, '#6f6b94');
    rect(ctx, x + 9, base - h, w - 18, 9, '#7e729b');
    rect(ctx, x + w / 2, base - h - 14, 0.5, 14, '#bd9fb9');
    rect(ctx, x + w / 2, base - h - 15, 1, 0.5, '#f0bfd0');
    for (let row = 0; row < (h - 27) / 4; row++) for (let col = 0; col < (w - 6) / 3; col++) {
      if (random(x, row, col) > 0.57) {
        const wx = x + 3 + col * 3, wy = base - h + 26 + row * 4, color = col % 3 ? '#cbb6c9' : '#9fb6c6';
        rect(ctx, wx, wy, 1, 1, color);
        reflectedLight(ctx, wx, wy, base, color, x);
      }
    }
  }
  // 강 건너로 휘어지는 사장교의 도로·교각·반사를 같은 원근에 맞춘다.
  const route = [{ x: 740, y: 210 }, { x: 910, y: 225 }, { x: 1110, y: 254 }, { x: 1320, y: 284 }, { x: 1600, y: 300 }];
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i], b = route[i + 1], w = 3 + i * 1.5;
    polygon(ctx, [a, b, { x: b.x, y: b.y + w + 3 }, { x: a.x, y: a.y + w }], '#30334f');
    line(ctx, a, b, '#c99bb0');
    line(ctx, { x: a.x, y: a.y + 2 }, { x: b.x, y: b.y + 2 }, '#f4b9b0');
    line(ctx, { x: a.x, y: a.y + w + 1 }, { x: b.x, y: b.y + w + 2 }, '#d578a5');
    for (let j = 0; j < 5; j++) {
      const t = j / 5, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      rect(ctx, x, y + w + 4, 1 + i * 0.5, 11 + i * 5, '#525371');
      rect(ctx, x, y + 16 + i * 5, 2 + i, 0.5, '#d49daf54');
      for (let ripple = 0; ripple < 5; ripple++) {
        rect(ctx, x - 2 + Math.sin(ripple + j) * 2, y + w + 9 + ripple * 3, 5 + i + ripple, 0.5, '#d6a3c0' + (37 - ripple * 5).toString(16).padStart(2, '0'));
      }
      rect(ctx, x + 7, y + 1, 2, 0.5, j % 2 ? '#f4dfc1' : '#d18cb6');
    }
  }
  for (const [x, y, h] of [[1005, 239, 62], [1350, 286, 88]]) {
    rect(ctx, x - 1, y - h, 2, h + 5, '#b29bb3');
    rect(ctx, x - 2, y - h, 1, h, '#d9b3c1');
    for (let i = 1; i < 7; i++) {
      const dx = i * h * 0.27;
      line(ctx, { x, y: y - h + 9 }, { x: x - dx, y: y - dx * 0.14 }, '#b59bb470');
      line(ctx, { x, y: y - h + 9 }, { x: x + dx, y: y + dx * 0.1 }, '#c5aac070');
    }
  }
}

function tower(ctx, block, drawSigns) {
  const { x, y, a, b, h, slope, seed, style } = block;
  const far = slope < 0.5;
  const palette = style === 'glass'
    ? ['#403858', '#2e2b47', '#37314f', '#635b7b']
    : style === 'stone' ? ['#5a4c6d', '#403654', '#4c405f', '#82708d'] : ['#554566', '#3c324f', '#483b5c', '#7b6887'];
  const p = (u, v, z = 0) => ({ x: x + u - v, y: y + (u + v) * slope - z });
  const roof = (u, v, w, d, z, color) => polygon(ctx, [p(u, v, z), p(u + w, v, z), p(u + w, v + d, z), p(u, v + d, z)], color);
  const box = (u, v, w, d, z, height) => {
    polygon(ctx, [p(u, v + d, z), p(u + w, v + d, z), p(u + w, v + d, z + height), p(u, v + d, z + height)], palette[2]);
    polygon(ctx, [p(u + w, v, z), p(u + w, v + d, z), p(u + w, v + d, z + height), p(u + w, v, z + height)], palette[1]);
    roof(u, v, w, d, z + height, palette[0]);
  };
  const floor = far ? 20 : 76, bay = far ? 12 : 30;
  for (const side of [false, true]) {
    const length = side ? b : a;
    const at = (u, z) => side ? p(a, u, z) : p(u, b, z);
    const face = (u, v, bottom, top, color) => polygon(ctx, [at(u, bottom), at(v, bottom), at(v, top), at(u, top)], color);
    face(0, length, -h, 0, palette[side ? 1 : 2]);
    const columns = Math.max(2, Math.floor(length / bay)), spacing = length / columns;
    for (let row = 0; row < h / floor; row++) {
      const z = -row * floor, band = row % 5 === 4;
      for (let col = 0; col < columns; col++) {
        const u = col * spacing + 3, v = (col + 1) * spacing - 3;
        const lit = random(seed + (side ? 100 : 0), row, col) < (far ? 0.29 : 0.32);
        const warm = random(seed + 200, row, col) < 0.74;
        const glass = lit ? warm ? far ? '#a994a4' : '#b09b92' : '#74959f' : side ? '#303550' : '#45425f';
        face(u, v, z - floor + 5, z - 4, glass);
        if (lit) {
          face(u + 1, v - 1, z - 6, z - 4.5, warm ? '#ddc3a2' : '#afc5c4');
          // 일부 실내만 책상과 블라인드로 구분하고 나머지는 어두운 유리로 남긴다.
          if (!far && (row + col + seed) % 3 === 0) {
            face(u + 2, v - 1, z - floor + 8, z - floor + 10, '#706777');
            face(u + 5, Math.min(v - 1, u + 9), z - floor + 11, z - floor + 16, '#536d7c');
          }
          if (!far && (row + col + seed) % 4 === 1) {
            face(u + 3, v - 3, z - floor + 10, z - floor + 17, '#6a7081');
            face(u + 5, v - 5, z - floor + 17, z - floor + 21, '#9b8c99');
          }
        }
        if (random(seed + 300, row, col) < 0.3) {
          const bottom = z - 8 - random(seed, row + 80, col) * floor * 0.45;
          face(u, v, bottom, z - 4, lit ? '#777989' : '#49536b');
          if (!far) for (let z1 = z - 6; z1 > bottom; z1 -= 3) line(ctx, at(u, z1), at(v, z1), lit ? '#b4a6a6' : '#5b637c');
        }
        if (!far && (col + seed) % 3 === 0) face(v - 2, v - 1, z - floor + 5, z - 4, '#b298c32d');
        if (!far && style === 'glass') {
          const middle = (u + v) / 2;
          face(middle, middle + 0.5, z - floor + 5, z - 4, '#56637c');
          face(u, v, z - floor * 0.64, z - floor * 0.64 + 0.5, '#5f6780');
        }
        line(ctx, at(v, z - floor + 4), at(v, z - 3), side ? '#46526b' : '#637087');
      }
      face(0, length, z - floor, z - floor + (far ? 2 : band ? 9 : 6), palette[0]);
      if (style === 'stone' || band) line(ctx, at(0, z - floor + 4), at(length, z - floor + 4), palette[3]);
      if (band && style === 'terrace') face(0, length, z - floor + 4, z - floor + 5, '#be8eac');
    }
    face(0, 2, -h, 0, palette[0]); face(length - 2, length, -h, 0, palette[3]);
  }
  // 옥상 설비와 정원도 같은 시점으로 그리고 건물마다 배치를 다르게 한다.
  roof(0, 0, a, b, 0, palette[0]);
  roof(5, 5, a - 10, b - 10, 0.5, '#504360');
  line(ctx, p(0, b, 1), p(a, b, 1), '#8c8295'); line(ctx, p(a, 0, 1), p(a, b, 1), '#696a82');
  box(a * 0.2, b * 0.18, a * 0.38, b * 0.3, 1, far ? 9 : 16);
  for (let i = 0; i < (far ? 2 : 3); i++) {
    const u = 12 + i * (a - 25) / 3, v = b * 0.66;
    box(u, v, far ? 9 : 15, far ? 7 : 12, 1, far ? 5 : 9);
    for (let j = 0; j < 4; j++) line(ctx, p(u + 2, v + 1 + j * 2, far ? 6 : 10), p(u + (far ? 7 : 12), v + 1 + j * 2, far ? 6 : 10), '#7a7d8e');
  }
  box(a * 0.74, b * 0.17, 3, 3, 1, far ? 18 : 37);
  const beacon = p(a * 0.74, b * 0.17, far ? 21 : 40);
  rect(ctx, beacon.x, beacon.y, 1.5, 1, '#dc9ea9');
  if (style === 'terrace') {
    roof(6, 8, a * 0.12, b * 0.64, 2, '#515e65');
    for (let i = 0; i < 8; i++) {
      const q = p(11, 10 + i * b * 0.065, 4);
      rect(ctx, q.x - 3, q.y - 5, 7, 4, '#547b76');
      rect(ctx, q.x - 1, q.y - 7, 3, 3, i % 3 ? '#6c9384' : '#b184a1');
      for (let leaf = 0; leaf < 12; leaf++) {
        const dx = random(i, leaf, seed) * 10 - 5, dy = random(i, leaf + 20, seed) * 7 - 9;
        rect(ctx, q.x + dx, q.y + dy, 1.5, 1, ['#3e6264', '#63877d', '#8aa394', '#a9819b'][leaf % 4]);
      }
    }
  }
  if (!far && style !== 'glass') {
    // 네온은 얇은 외벽 간판과 빛 번짐 몇 단계로 절제한다.
    const q = p(3, b, -h * 0.28);
    rect(ctx, q.x - 1, q.y, 7, 38, '#c98bb724');
    rect(ctx, q.x + 1, q.y + 2, 3, 34, '#b985b2');
    for (let i = 0; i < 5; i++) rect(ctx, q.x + 1, q.y + 6 + i * 6, 2, 2, '#ebc1d3');
  }
  drawSigns?.(ctx, block);
  // 먼 건물일수록 대기 색을 겹쳐 가까운 사무실보다 흐리게 보이게 한다.
  if (far) {
    polygon(ctx, [p(0, b), p(a, b), p(a, 0), p(a, 0, -h), p(a, b, -h), p(0, b, -h)], '#9484af24');
  }
}

function riverbank(ctx, width, height) {
  const edge = [{ x: 0, y: 355 }, { x: 390, y: 363 }, { x: 670, y: 387 }, { x: 1050, y: 393 }, { x: 1350, y: 365 }, { x: width, y: 351 }];
  polygon(ctx, [...edge, { x: width, y: height }, { x: 0, y: height }], '#3c3453');
  for (let i = 0; i < edge.length - 1; i++) {
    line(ctx, edge[i], edge[i + 1], '#a390a4');
    line(ctx, { x: edge[i].x, y: edge[i].y + 2 }, { x: edge[i + 1].x, y: edge[i + 1].y + 2 }, '#65757f');
  }
  // 강변 산책로와 작은 가로수는 해안선을 따라 이어진다.
  for (let i = 0; i < 130; i++) {
    const x = i * width / 130, segment = edge.findIndex(p => p.x > x), a = edge[Math.max(0, segment - 1)], b = edge[segment < 0 ? edge.length - 1 : segment];
    const y = a.y + (b.y - a.y) * (x - a.x) / Math.max(1, b.x - a.x) + 6;
    rect(ctx, x, y, 1, 4, '#3b495e'); rect(ctx, x - 2, y - 3, 5, 3, '#566e75');
    if (i % 4 === 0) { rect(ctx, x + 5, y, 0.5, 4, '#9d91a4'); rect(ctx, x + 4.5, y - 1, 1.5, 1, '#d7bea9'); }
  }
  // 도로는 소실점을 향해 압축해 중경 건물의 발밑을 연결한다.
  for (const vanishing of [430, 1190]) for (let i = -2; i < 5; i++) {
    const from = { x: vanishing, y: 400 }, to = { x: vanishing + i * 255, y: height };
    polygon(ctx, [from, { x: to.x - 7, y: to.y }, { x: to.x + 7, y: to.y }], '#49405e');
    line(ctx, from, to, '#79778e48');
  }
  for (let i = 0; i < 900; i++) {
    const y = 409 + random(i, 66) * (height - 409), spread = (y - 390) / 4;
    const x = (i % 2 ? 1190 : 430) + (random(i, 67) - 0.5) * spread * 5;
    rect(ctx, x, y, 1.5, 0.5, ['#c7a4b18a', '#d5bda27a', '#8fa6b87a'][i % 3]);
  }
}

export function drawCityscape(ctx, { width, height }, drawSigns) {
  sky(ctx, width, height);
  distantCity(ctx, width);
  riverbank(ctx, width, height);
  // 중경의 낮은 주거 밀집지를 먼저 그리고 고층 빌딩 사이로 보이게 한다.
  const blocks = [];
  for (let i = 0; i < 29; i++) {
    const x = -60 + i * 61, h = 70 + random(i, 91) * 145;
    blocks.push({ x, y: 435 + random(i, 92) * 95 - h * 0.22, a: 24 + random(i, 93) * 34, b: 23 + random(i, 94) * 31,
      h, slope: 0.22, seed: 100 + i, style: i % 4 ? 'stone' : 'terrace' });
  }
  for (const block of blocks.sort((a, b) => a.y + a.h - b.y - b.h)) {
    const base = block.y + block.h;
    polygon(ctx, [{ x: block.x - block.b, y: base + block.b * block.slope },
      { x: block.x + block.a - block.b, y: base + (block.a + block.b) * block.slope },
      { x: block.x + block.a + 18, y: base + block.a * block.slope + 7 },
      { x: block.x + 18, y: base + 7 }], '#28213975');
    tower(ctx, block);
  }
  for (const block of [...CITY_BLOCKS].sort((a, b) => a.y + (a.a + a.b) * a.slope - b.y - (b.a + b.b) * b.slope)) tower(ctx, block, drawSigns);
}
