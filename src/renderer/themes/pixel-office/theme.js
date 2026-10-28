import layout from './layout.js';
import { drawCharacter } from './sprites.js';
import { createAtmosphere } from './atmosphere.js';
import { loadDrinkImages } from './drink-images.js';
import { createExterior, loadCityImages } from './exterior.js';
import { polygon, line, PIXEL_DETAIL } from './raster.js';

const WIDTH = 1600;
const HEIGHT = 1000;
const DETAIL = PIXEL_DETAIL;
const PAPER = '#edf2eb';
const INK = '#4a4741';
const atmosphere = createAtmosphere({ width: WIDTH, height: HEIGHT, detail: DETAIL, project: projectPoint });
const exterior = createExterior({ width: WIDTH, height: HEIGHT, project: projectPoint });
const FLOOR = { analysis: '#a9d0be', planning: '#d0b7df', lead: '#e8c48a', skills: '#a3cbdc', dev: '#9ec9d0', review: '#edb8ac', rest: '#b5d399', cafe: '#efc78b', ceo: '#d4bddc', restroom: '#b2d8e1' };
const TITLES = { analysis: '분석 · 자료실', planning: '기획 · 아이디어실', lead: '팀장실', skills: '스킬 작업실', dev: '개발실', review: '검토실', rest: '그린 라운지', cafe: '카페 · 게임존', ceo: '대표실', restroom: '화장실' };
const ACCENTS = { analysis: '#438a76', planning: '#9d6eb1', lead: '#b88a4c', skills: '#517dbe', dev: '#427f9b', review: '#c77972' };
const BUBBLES = {
  work: ['#fffbef', '#8e9e8c'], info: ['#fffbef', '#afa18a'],
  share: ['#fff0bc', '#ba924b'], report: ['#e7f0ec', '#739b92'],
  done: ['#e7edda', '#829569'], alert: ['#fae1d6', '#c57761'], chat: ['#eee4ed', '#a38aa3'],
};

// Engine coordinates -> pixels in the low-resolution scene.
export function projectPoint(x, y, z = 0) {
  return { x: Math.round((780 + (x - y) * 0.36) * DETAIL) / DETAIL, y: Math.round((125 + (x + y) * 0.18 - z) * DETAIL) / DETAIL };
}

function plane(ctx, x, y, w, d, z, color) {
  polygon(ctx, [projectPoint(x, y, z), projectPoint(x + w, y, z), projectPoint(x + w, y + d, z), projectPoint(x, y + d, z)], color);
}

function box(ctx, x, y, w, d, z, height, top, left, right) {
  const a = projectPoint(x, y + d, z), b = projectPoint(x + w, y + d, z), c = projectPoint(x + w, y, z);
  const at = projectPoint(x, y + d, z + height), bt = projectPoint(x + w, y + d, z + height), ct = projectPoint(x + w, y, z + height);
  polygon(ctx, [a, b, bt, at], left);
  polygon(ctx, [b, c, ct, bt], right);
  plane(ctx, x, y, w, d, z + height, top);
}

function glassRail(ctx, x1, y1, x2, y2) {
  polygon(ctx, [projectPoint(x1, y1, 2), projectPoint(x2, y2, 2), projectPoint(x2, y2, 30), projectPoint(x1, y1, 30)], '#afcdd466');
  line(ctx, projectPoint(x1, y1, 31), projectPoint(x2, y2, 31), '#e0dfcb');
  const posts = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 180));
  for (let i = 0; i <= posts; i++) {
    const x = x1 + (x2 - x1) * i / posts, y = y1 + (y2 - y1) * i / posts;
    line(ctx, projectPoint(x, y, 1), projectPoint(x, y, 31), '#a5b6b6');
  }
}

function text(ctx, value, x, y, color = INK, font = '8px monospace') {
  ctx.font = font; ctx.fillStyle = color; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.fillText(value, Math.round(x), Math.round(y));
}

function plant(ctx, x, y, size = 1) {
  const p = projectPoint(x, y);
  const r = (dx, dy, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(p.x + dx * size, p.y + dy * size, w * size, h * size); };
  r(-5, -9, 10, 8, '#bc8766'); r(-4, -8, 3, 6, '#d9aa82'); r(-6, -11, 12, 3, '#e0b38a');
  r(0, -29, 2, 20, '#6f8054');
  r(-8, -24, 7, 6, '#7d9a65'); r(-10, -26, 5, 4, '#9bb37a');
  r(2, -29, 7, 6, '#66875a'); r(4, -31, 4, 4, '#8ba471');
  r(-3, -34, 6, 8, '#8fa875'); r(-3, -33, 2, 5, '#adc18a');
  r(2, -19, 9, 5, '#7a965f'); r(-7, -17, 7, 5, '#5f8058');
}

function oval(ctx, x, y, w, d, z, color) {
  const points = Array.from({ length: 32 }, (_, i) => {
    const angle = i / 32 * Math.PI * 2;
    return projectPoint(x + w / 2 + Math.cos(angle) * w / 2, y + d / 2 + Math.sin(angle) * d / 2, z);
  });
  polygon(ctx, points, color);
}

function softTabletop(ctx, x, y, w, d, color, side) {
  const r = Math.min(d / 3, 30);
  const corners = [[x + r, y], [x + w - r, y], [x + w, y + r], [x + w, y + d - r],
    [x + w - r, y + d], [x + r, y + d], [x, y + d - r], [x, y + r]];
  for (let i = 2; i < 6; i++) {
    const a = corners[i], b = corners[i + 1];
    polygon(ctx, [projectPoint(...a, 18), projectPoint(...b, 18), projectPoint(...b, 23), projectPoint(...a, 23)], side);
  }
  polygon(ctx, corners.map(p => projectPoint(...p, 23)), color);
}

function monitor(ctx, x, y, wide = false) {
  const p = projectPoint(x, y, 23), w = wide ? 27 : 17;
  ctx.fillStyle = '#667577'; ctx.fillRect(p.x - 1, p.y - 6, 3, 7); ctx.fillRect(p.x - 4, p.y, 8, 2);
  ctx.fillStyle = '#344955'; ctx.fillRect(p.x - w / 2, p.y - 21, w, 15);
  ctx.fillStyle = '#8dc5ce'; ctx.fillRect(p.x - w / 2 + 2, p.y - 19, w - 4, 11);
  ctx.fillStyle = '#d1e9c5'; ctx.fillRect(p.x - w / 2 + 3, p.y - 17, w - 9, 1); ctx.fillRect(p.x - w / 2 + 3, p.y - 13, w - 6, 1);
}

function workTable(ctx, table) {
  const { x, y, w, d, kind } = table;
  const top = { reading: '#d7ae7c', collaboration: '#efc79e', director: '#b98872', engineering: '#d8e9df', review: '#edc0ad', workshop: '#8dbbb6' }[kind];
  for (const dx of [18, w - 38]) box(ctx, x + dx, y + 12, 20, d - 24, 0, 19,
    kind === 'engineering' ? '#627e91' : '#ac8e77', '#927a67', '#7a6b61');
  if (['collaboration', 'review', 'workshop'].includes(kind)) softTabletop(ctx, x, y, w, d, top, '#a88f7a');
  else box(ctx, x, y, w, d, 18, 5, top, '#b79a7c', '#937e6d');
  for (const s of table.seats) {
    if (kind === 'reading') {
      plane(ctx, s.x - 22, y + 22, 48, 39, 24, '#f9edc9');
      line(ctx, projectPoint(s.x + 2, y + 23, 24), projectPoint(s.x + 2, y + 60, 24), '#bd9e76');
      for (let i = 0; i < 3; i++) plane(ctx, s.x + 29 + i * 2, y + 14 + i * 2, 20, 28, 24 + i * 2, ['#8aafa0', '#b27c79', '#d6bb78'][i]);
      box(ctx, x + w - 5, y + 3, 5, d - 6, 23, 12, '#c59c72', '#ac8567', '#96725d');
    } else if (kind === 'collaboration') {
      plane(ctx, s.x - 24, y + 28, 52, 50, 24, '#f7ebce');
      for (let i = 0; i < 3; i++) plane(ctx, s.x - 18 + i * 15, y + 35 + i % 2 * 12, 12, 12, 25, ['#db9ab2', '#89bfa3', '#e6c36b'][i]);
      if (s === table.seats[1]) monitor(ctx, s.x + 34, y + 14);
    } else {
      plane(ctx, s.x - 20, y + 12, 70, Math.min(52, d - 20), 24, ACCENTS[table.room]);
      if (kind === 'engineering') {
        monitor(ctx, s.x + 10, y + 25); monitor(ctx, s.x + 45, y + 25);
        const p = projectPoint(s.x + 13, y + 54, 25); ctx.fillStyle = '#566e7c'; ctx.fillRect(p.x - 8, p.y, 17, 3);
      } else if (kind === 'workshop') {
        plane(ctx, s.x + 9, y + 23, 37, 27, 25, '#385d70');
        plane(ctx, s.x + 13, y + 27, 29, 19, 25.5, '#92d9ce');
        box(ctx, s.x - 18, y + d - 24, 23, 15, 24, 7, '#e8b871', '#c59262', '#a67b59');
      } else monitor(ctx, s.x + 32, y + 26, true);
      if (kind === 'review') {
        plane(ctx, s.x - 31, y + 34, 31, 43, 25, '#fff0d8');
        for (let i = 0; i < 3; i++) plane(ctx, s.x - 27, y + 40 + i * 9, 20, 2, 25.5, '#8cac93');
      }
    }
    deskLamp(ctx, s.x - 40, s.y + 54);
  }
  if (kind === 'collaboration') {
    const p = projectPoint(x + w / 2 + 38, y + d - 22, 24);
    ctx.fillStyle = '#a282b3'; ctx.fillRect(p.x - 4, p.y - 8, 8, 8);
    ctx.fillStyle = '#ede1bb'; ctx.fillRect(p.x - 3, p.y - 9, 6, 2);
  }
}

function deskLamp(ctx, x, y) {
  const base = projectPoint(x, y, 24), head = projectPoint(x, y, 48);
  ctx.fillStyle = '#5d6864'; ctx.beginPath(); ctx.ellipse(base.x, base.y, 5, 2, 0, 0, Math.PI * 2); ctx.fill();
  line(ctx, base, { x: head.x - 5, y: head.y - 4 }, '#516366');
  line(ctx, { x: head.x - 5, y: head.y - 4 }, { x: head.x + 1, y: head.y - 6 }, '#8c9b91');
  polygon(ctx, [{ x: head.x - 2, y: head.y - 6 }, { x: head.x + 4, y: head.y - 6 },
    { x: head.x + 7, y: head.y }, { x: head.x - 5, y: head.y }], '#668b81');
  ctx.fillStyle = '#c7c4a3'; ctx.fillRect(head.x - 4, head.y, 10, 1);
}

function chair(ctx, x, y, room = 'dev') {
  box(ctx, x - 30, y - 32, 58, 38, 0, 12, ACCENTS[room] || '#548f8e', '#547b83', '#365c6e');
  const p = projectPoint(x - 4, y - 21, 8);
  ctx.fillStyle = '#718980'; ctx.fillRect(p.x - 9, p.y - 11, 17, 9); ctx.fillStyle = '#91a69a'; ctx.fillRect(p.x - 8, p.y - 10, 15, 2);
}

function sofa(ctx, x, y) {
  box(ctx, x, y, 175, 64, 0, 12, '#91a69a', '#688a7d', '#58766c');
  box(ctx, x, y, 175, 13, 12, 15, '#a1b1a2', '#7f9a8b', '#6b867a');
  box(ctx, x - 5, y + 6, 15, 61, 12, 10, '#a1b1a2', '#779487', '#627e74');
  box(ctx, x + 165, y + 6, 15, 61, 12, 10, '#a1b1a2', '#779487', '#627e74');
  for (let dx = 15; dx < 160; dx += 45) plane(ctx, x + dx, y + 16, 41, 44, 13, '#a9b8a7');
}

function coffeeStation(ctx, x, y) {
  box(ctx, x, y, 110, 40, 0, 23, '#d9bb90', '#b79c7b', '#968568');
  box(ctx, x + 10, y + 5, 44, 26, 23, 23, '#777d76', '#535d59', '#434d4b');
  const p = projectPoint(x + 38, y + 33, 34);
  ctx.fillStyle = '#c69b61'; ctx.fillRect(p.x - 3, p.y - 7, 5, 3);
  ctx.fillStyle = '#eee5cd'; ctx.fillRect(p.x - 2, p.y, 4, 4);
}

function bookshelf(ctx, x, y) {
  box(ctx, x, y, 100, 30, 0, 39, '#b29b7b', '#7d7562', '#6e6a59');
  const colors = ['#bd856c', '#d4bc87', '#8eaaa0', '#a595ae', '#a4b17c'];
  for (const z of [5, 23]) {
    for (let i = 0; i < 6; i++) box(ctx, x + 7 + i * 14, y + 17, 10, 12, z, 9 + i % 3, colors[i % colors.length], colors[i % colors.length], '#7a7767');
    plane(ctx, x, y, 100, 32, z - 1, '#c5ad88');
  }
}

function furnishing(ctx, item) {
  const { x, y, w, d, kind, room } = item;
  if (kind === 'bookcase') bookshelf(ctx, x, y);
  else if (kind === 'sofa') sofa(ctx, x, y);
  else if (kind === 'server') serverRack(ctx, x, y);
  else if (kind === 'ideaBoard') {
    box(ctx, x, y, w, d, 18, 44, '#c9b5a0', '#9e9791', '#8c8987');
    polygon(ctx, [projectPoint(x + 5, y + d + 1, 22), projectPoint(x + w - 5, y + d + 1, 22),
      projectPoint(x + w - 5, y + d + 1, 58), projectPoint(x + 5, y + d + 1, 58)], '#f7eace');
    for (let i = 0; i < Math.floor(w / 32); i++) {
      const left = x + 12 + i * 30, z = 27 + i % 2 * 13;
      polygon(ctx, [projectPoint(left, y + d + 2, z), projectPoint(left + 20, y + d + 2, z),
        projectPoint(left + 20, y + d + 2, z + 10), projectPoint(left, y + d + 2, z + 10)], ['#dda5ba', '#d6b863', '#8ebdae', '#a2aecf'][i % 4]);
    }
  } else if (kind === 'beanbag') {
    const color = room === 'planning' ? '#bc97c4' : '#d89b78';
    oval(ctx, x, y, w, d, 5, '#9b7f8c'); oval(ctx, x + 2, y + 2, w - 4, d - 4, 14, color);
    oval(ctx, x + 8, y + 6, w - 16, d * 0.5, 22, room === 'planning' ? '#d8b6d7' : '#f0bc91');
  } else if (kind === 'roundTable' || kind === 'sideTable') {
    const inset = kind === 'roundTable' ? 18 : 0, tw = w - inset * 2, td = d - inset * 2;
    box(ctx, x + w / 2 - 9, y + d / 2 - 9, 18, 18, 0, 21, '#b4a08a', '#958877', '#7d776b');
    oval(ctx, x + inset, y + inset, tw, td, 20, '#b89373');
    oval(ctx, x + inset, y + inset, tw, td, 24, room === 'lead' ? '#e2c39a' : '#f0d4b0');
    plane(ctx, x + w / 2 - 12, y + d / 2 - 10, 23, 30, 25, '#e3edd6');
    if (kind === 'roundTable') for (const dx of [2, w - 27]) {
      oval(ctx, x + dx, y + d - 28, 25, 25, 10, room === 'lead' ? '#6f9691' : '#bca0bb');
    }
  } else if (kind === 'returnDesk') {
    box(ctx, x, y, w, d, 0, 22, '#b98872', '#97715f', '#7d6155');
    plane(ctx, x + 7, y + 14, w - 14, 31, 23, '#f2e5c9');
  } else if (kind === 'toolShelf') {
    box(ctx, x, y, w, d, 0, 32, '#8aaba5', '#6f8d87', '#597b78');
    for (let i = 0; i < 3; i++) box(ctx, x + 8 + i * (w - 20) / 3, y + 8, 15, 18, 32, 9 + i * 3,
      ['#dc9d7e', '#dcca86', '#8aabca'][i], '#a88e7a', '#8c7b71');
  } else if (kind === 'display') {
    box(ctx, x, y, w, d, 0, 18, '#9b858b', '#806e7c', '#6f6173');
    const p = projectPoint(x + w / 2, y + d / 2, 20);
    ctx.fillStyle = '#3b5264'; ctx.fillRect(p.x - 20, p.y - 31, 40, 27);
    ctx.fillStyle = '#93c4c3'; ctx.fillRect(p.x - 17, p.y - 28, 34, 20);
    for (let i = 0; i < 3; i++) { ctx.fillStyle = ['#ecdcaa', '#b8d6ae', '#dbafab'][i]; ctx.fillRect(p.x - 14, p.y - 25 + i * 6, 4, 3); ctx.fillRect(p.x - 7, p.y - 24 + i * 6, 20 - i * 4, 1); }
  } else if (kind === 'prototype') {
    box(ctx, x, y, w, d, 0, 17, '#d4b57c', '#b19869', '#95855d');
    box(ctx, x + 8, y + 12, w - 16, d - 24, 17, 24, '#8ed4ce', '#66a9ae', '#4b8595');
    const p = projectPoint(x + w / 2, y + d / 2, 43);
    ctx.fillStyle = '#f2e0a4'; ctx.fillRect(p.x - 4, p.y - 8, 8, 8); ctx.fillStyle = '#436775'; ctx.fillRect(p.x - 2, p.y - 5, 1, 2); ctx.fillRect(p.x + 1, p.y - 5, 1, 2);
  }
}

function serverRack(ctx, x, y) {
  box(ctx, x, y, 60, 35, 0, 42, '#7f8982', '#4f605c', '#414f4d');
  for (let z = 8; z < 39; z += 9) {
    const p = projectPoint(x + 10, y + 36, z);
    ctx.fillStyle = '#94ac93'; ctx.fillRect(p.x, p.y, 2, 2);
    ctx.fillStyle = '#b3c5b1'; ctx.fillRect(p.x + 5, p.y + 2, 9, 1);
  }
}

function vending(ctx, item) {
  const { x, y, w, d } = item;
  box(ctx, x, y, w, d, 0, 68, '#e7a686', '#ca7d64', '#9d6253');
  const face = (dx, z, width, height, color) => polygon(ctx, [projectPoint(x + dx, y + d + 1, z), projectPoint(x + dx + width, y + d + 1, z), projectPoint(x + dx + width, y + d + 1, z + height), projectPoint(x + dx, y + d + 1, z + height)], color);
  face(8, 21, 56, 36, '#344e54'); face(11, 24, 49, 29, '#c3e0d7');
  for (let row = 0; row < 2; row++) for (let col = 0; col < 4; col++) face(15 + col * 11, 27 + row * 14, 6, 8, ['#df8c6b', '#d5bc65', '#7ca99a', '#a49aba'][col]);
  face(69, 37, 12, 14, '#475b5c'); face(73, 40, 4, 7, '#c9dfb4'); face(16, 8, 50, 7, '#684e44');
}

function laptop(ctx, item) {
  box(ctx, item.x, item.y, item.w, item.d, 0, 20, '#e0bd82', '#bc9967', '#a7855b');
  const p = projectPoint(item.x + 52, item.y + 26, 22);
  ctx.fillStyle = '#446b70'; ctx.fillRect(p.x - 15, p.y - 20, 29, 19);
  ctx.fillStyle = '#91c4bc'; ctx.fillRect(p.x - 12, p.y - 17, 23, 12);
  ctx.fillStyle = '#e2e7cb'; ctx.fillRect(p.x - 10, p.y - 15, 8, 2); ctx.fillRect(p.x - 10, p.y - 10, 16, 1);
  ctx.fillStyle = '#899d95'; ctx.fillRect(p.x - 17, p.y, 34, 4);
}

function rug(ctx, x, y, w, d, color, trim) {
  plane(ctx, x, y, w, d, 1, trim); plane(ctx, x + 7, y + 7, w - 14, d - 14, 2, color);
  for (let dx = 15; dx < w - 15; dx += 30) plane(ctx, x + dx, y + 10, 3, d - 20, 3, trim);
}

function arcade(ctx, x, y) {
  box(ctx, x, y, 58, 48, 0, 59, '#aca1c4', '#817c9f', '#65667e');
  const p = projectPoint(x + 28, y + 49, 38);
  ctx.fillStyle = '#30454b'; ctx.fillRect(p.x - 11, p.y - 16, 23, 20);
  ctx.fillStyle = '#7cbcb1'; ctx.fillRect(p.x - 8, p.y - 12, 17, 12);
  ctx.fillStyle = '#f2d18a'; ctx.fillRect(p.x - 2, p.y - 7, 5, 5);
  ctx.fillStyle = '#de9b85'; ctx.fillRect(p.x + 6, p.y + 8, 4, 3);
}

function doorPanel(ctx, item, amount) {
  if (item.id === 'elevator') { elevatorPanel(ctx, item, amount); return; }
  const tone = item.room === 'ceo' ? '#5b788b' : '#5c9eae';
  box(ctx, item.x - 6, item.y, 6, 12, 0, 74, '#d5d9c6', '#8c9b99', '#7e8b8c');
  box(ctx, item.x + item.w, item.y, 6, 12, 0, 74, '#d5d9c6', '#8c9b99', '#7e8b8c');
  box(ctx, item.x - 6, item.y, item.w + 12, 12, 70, 5, '#e3dcbd', '#a7afa3', '#82999a');
  for (const [x, shift] of [[item.x, -1], [item.x + item.w / 2, 1]]) {
    const left = x + shift * amount * 55;
    box(ctx, left, item.y + 3, item.w / 2 - 2, 4, 1, 67, tone, tone, '#4d6d7c');
    polygon(ctx, [projectPoint(left + 6, item.y + 8, 16), projectPoint(left + 51, item.y + 8, 16), projectPoint(left + 51, item.y + 8, 57), projectPoint(left + 6, item.y + 8, 57)], '#a6ccd2');
    line(ctx, projectPoint(left + 10, item.y + 9, 21), projectPoint(left + 44, item.y + 9, 51), '#d0e7e2');
  }
  plane(ctx, item.x - 2, item.y - 8, item.w + 4, 26, 1, '#d8c796');
}

function elevatorPanel(ctx, item, amount) {
  const x = item.x + item.w + 1, start = item.y + 8, end = item.y + item.d - 8;
  const face = (y, width, z, height, color) => polygon(ctx, [projectPoint(x, y, z), projectPoint(x, y + width, z),
    projectPoint(x, y + width, z + height), projectPoint(x, y, z + height)], color);
  face(start, end - start, 1, 111, '#303e46');
  face(start + 5, end - start - 10, 6, 101, '#657475');
  face(start + 10, end - start - 20, 10, 93, '#7e8b85');
  face(start + 8, end - start - 16, 40, 2, '#c2c8b6');
  // 문은 벽 속으로 수납되며, 열린 부분으로 엘리베이터 내부가 드러난다.
  const half = (end - start) / 2, remaining = half * (1 - amount);
  for (const y of [start, end - remaining]) {
    if (remaining <= 0) continue;
    face(y, remaining, 2, 109, '#9eafb0');
    face(y + 1, Math.max(0, remaining - 2), 4, 105, '#bdc9c4');
    for (let stripe = 7; stripe < remaining - 3; stripe += 14) face(y + stripe, 2, 5, 103, '#dae0ce');
  }
  for (const y of [item.y, end]) box(ctx, item.x, y, 12, 8, 0, 116, '#e4dfc6', '#8d9b96', '#849892');
  box(ctx, item.x, item.y, 12, item.d, 112, 6, '#ebe4c9', '#a3ada0', '#8b9e97');
  face(start, end - start, 109, 3, '#f3deb0');
  face(start + 45, 38, 121, 13, '#3e565c');
  face(start + 55, 5, 124, 7, amount > 0 ? '#b8e7bb' : '#e7ca8a');
  face(start + 66, 8, 124, 2, '#c5dbbe');
  face(item.y + item.d + 9, 11, 48, 20, '#657f82');
  face(item.y + item.d + 12, 5, 56, 5, amount > 0 ? '#b9e7bb' : '#e9d5a5');
  plane(ctx, 26, start, 18, end - start, 1, '#c2bfac');
}

function executiveDesk(ctx) {
  box(ctx, 400, 1480, 220, 100, 0, 22, '#ad7d72', '#7c5969', '#654d60');
  plane(ctx, 408, 1488, 204, 84, 23, '#e3b69d');
  plane(ctx, 460, 1502, 110, 58, 23.5, '#3c737b');
  const p = projectPoint(530, 1502, 24);
  ctx.fillStyle = '#395465'; ctx.fillRect(p.x - 17, p.y - 25, 35, 23);
  ctx.fillStyle = '#8dc5d7'; ctx.fillRect(p.x - 14, p.y - 22, 29, 17);
  ctx.fillStyle = '#e1cf83'; ctx.fillRect(p.x - 11, p.y - 19, 12, 1); ctx.fillRect(p.x - 11, p.y - 14, 21, 1);
  for (let i = 0; i < 3; i++) plane(ctx, 420 + i * 4, 1520 + i * 4, 34, 38, 24 + i, ['#f9e9bb', '#d6a5c3', '#a9d3c1'][i]);
  deskLamp(ctx, 432, 1510);
}

function washroom(ctx) {
  for (let i = 0; i < 2; i++) {
    const y = 1536 + i * 84;
    box(ctx, 1640, y, 105, 76, 0, 38, '#d4e9e6', '#9fc5cc', '#76a4b0');
    box(ctx, 1640, y, 105, 5, 38, 16, '#e8efdf', '#b8d6d4', '#8db6c0');
    const p = projectPoint(1690, y + 34, 40);
    ctx.fillStyle = '#f8f3df'; ctx.fillRect(p.x - 7, p.y - 6, 14, 10);
    ctx.fillStyle = '#9ec8d2'; ctx.fillRect(p.x - 4, p.y - 4, 8, 5);
  }
  box(ctx, 1960, 1480, 78, 220, 0, 24, '#e6edda', '#9ac4bc', '#74a7a5');
  for (const y of [1518, 1605]) {
    plane(ctx, 1974, y, 46, 52, 25, '#f6f3df');
    plane(ctx, 1981, y + 8, 32, 34, 25.5, '#96c6cc');
    box(ctx, 2005, y + 6, 6, 5, 25, 13, '#cbd5d1', '#93a9ad', '#6e8c99');
    const p = projectPoint(2034, y + 20, 52);
    ctx.fillStyle = '#5f8e9f'; ctx.fillRect(p.x - 10, p.y - 24, 20, 29);
    ctx.fillStyle = '#b2d8e0'; ctx.fillRect(p.x - 8, p.y - 22, 16, 25);
    ctx.fillStyle = '#deeeeb'; ctx.fillRect(p.x - 5, p.y - 18, 1, 16);
  }
}

let floorCache, shadedFloorCache, frameCanvas, objects;
// 다른 배치(커스터마이징)로 바꾸면 전체 화면 크기 캐시를 반납한다. 음료·도시 원화는 다른 테마도 쓰므로 남긴다.
function releaseCaches() {
  for (const c of [floorCache, shadedFloorCache, frameCanvas]) if (c) c.width = c.height = 0;
  floorCache = shadedFloorCache = frameCanvas = objects = null;
  atmosphere.release(); exterior.release();
}
// 배치도의 상호작용 목록은 바뀌지 않으므로 겹친 항목 우선순위를 한 번만 정한다.
const HIT_ORDER = [...layout.interactions].sort((a, b) => b.x + b.y - a.x - a.y);

function buildFloor() {
  const canvas = document.createElement('canvas'); canvas.width = WIDTH * DETAIL; canvas.height = HEIGHT * DETAIL;
  const ctx = canvas.getContext('2d');
  ctx.scale(DETAIL, DETAIL);
  box(ctx, 32, 64, 2056, 1136, -16, 16, '#e0ddc8', '#b5b69d', '#939e88');
  for (const bridge of layout.walkways) box(ctx, bridge.x, bridge.y, bridge.w, bridge.h, -16, 16, '#e5d0a3', '#b49b7d', '#918a79');
  for (const key of ['ceo', 'restroom']) {
    const r = layout.rooms[key];
    box(ctx, r.x, r.y, r.w, r.h, -16, 16, '#d5d4c0', '#a9a58d', '#888f80');
  }
  for (const [key, r] of Object.entries(layout.rooms)) {
    plane(ctx, r.x + 4, r.y + 4, r.w - 8, r.h - 8, 0, FLOOR[key]);
    const wood = ['analysis', 'lead'].includes(key);
    if (!wood) for (let x = r.x + 4; x < r.x + r.w - 8; x += 64) line(ctx, projectPoint(x, r.y + 5), projectPoint(x, r.y + r.h - 5), '#b8c4b5');
    for (let y = r.y + 4; y < r.y + r.h - 8; y += wood ? 28 : 64) line(ctx, projectPoint(r.x + 5, y), projectPoint(r.x + r.w - 5, y), wood ? '#95b4a0' : '#b8c4b5');
    if (key === 'analysis') {
      rug(ctx, r.x + 34, r.y + 140, 152, 282, '#b7bd91', '#e6d5ac');
      oval(ctx, r.x + 245, r.y + 290, 220, 124, 1, '#d7c99d');
    } else if (key === 'planning') {
      oval(ctx, r.x + 24, r.y + 145, 448, 260, 1, '#ad8daf');
      oval(ctx, r.x + 36, r.y + 157, 424, 236, 2, '#dfb5cd');
    } else if (key === 'lead') {
      rug(ctx, r.x + 220, r.y + 132, 230, 270, '#789d95', '#e8d3a4');
      oval(ctx, r.x + 24, r.y + 276, 190, 148, 1, '#e3d4b2');
    } else if (key === 'dev') {
      for (const [dx, dy, w] of [[24, 120, 316], [82, 330, 338]]) rug(ctx, r.x + dx, r.y + dy, w, 162, '#6f97ab', '#c4d3b9');
    } else if (key === 'review') {
      oval(ctx, r.x + 28, r.y + 158, 390, 220, 1, '#cf9687');
      oval(ctx, r.x + 42, r.y + 172, 362, 192, 2, '#eac3a2');
      oval(ctx, r.x + 42, r.y + 382, 190, 146, 1, '#c0a8c3');
    } else if (key === 'skills') {
      for (const [dx, dy, w] of [[28, 132, 324], [98, 268, 324]]) oval(ctx, r.x + dx, r.y + dy, w, 142, 1, '#619ca9');
      for (let i = 0; i < 4; i++) plane(ctx, r.x + 410, r.y + 338 + i * 15, 32, 6, 2, ['#e9c379', '#d9a5b7', '#a4d3bc', '#9db9d8'][i]);
    }
    if (key === 'restroom') for (let x = r.x + 8; x < r.x + r.w - 20; x += 32) for (let y = r.y + 8; y < r.y + r.h - 20; y += 32) {
      if ((Math.round((x - r.x - 8) / 32) + Math.round((y - r.y - 8) / 32)) % 2) plane(ctx, x, y, 30, 30, 1, '#e3efdf');
    }
  }
  rug(ctx, 90, 1430, 540, 300, '#b6a0c6', '#ead29d');
  for (const key of ['ceo', 'restroom']) {
    const r = layout.rooms[key], door = r.door;
    box(ctx, r.x, r.y - 8, door.x - 60 - r.x, 8, 0, 72, '#e8e0ca', '#bebcbd', '#a6adb0');
    box(ctx, door.x + 60, r.y - 8, r.x + r.w - door.x - 60, 8, 0, 72, '#e8e0ca', '#bebcbd', '#a6adb0');
    if (key === 'restroom') box(ctx, r.x - 8, r.y, 8, r.h, 0, 65, '#e9e4cf', '#c1c1b4', '#98aca9');
    box(ctx, r.x, r.y + r.h - 6, r.w, 6, 0, 12, '#d4d6c4', '#acb5a1', '#91a48f');
  }
  plane(ctx, 32, 510, 2056, 132, 1, '#b5c7b9');
  plane(ctx, 32, 536, 2056, 78, 2, '#d4decc');
  for (let x = 70; x < 2060; x += 84) plane(ctx, x, 572, 24, 4, 3, '#f3edcd');
  rug(ctx, 1110, 780, 420, 350, '#d6dcad', '#ecdfb1');
  const mat = layout.interactions.find(i => i.id === 'stretch');
  rug(ctx, mat.x, mat.y, mat.w, mat.d, '#94b7c9', '#d8e5d3');
  rug(ctx, 1638, 886, 390, 280, '#dba992', '#f2d5ad');
  box(ctx, 32, 56, 2056, 8, 0, 142, '#e3e1cb', '#c8ceba', '#9eafa0');
  box(ctx, 24, 64, 8, 440, 0, 142, '#e7e3cd', '#d4d8c4', '#a6b5a2');
  box(ctx, 24, 648, 8, 1152, 0, 142, '#e7e3cd', '#d4d8c4', '#a6b5a2');
  box(ctx, 24, 504, 8, 144, 118, 24, '#e7e3cd', '#d4d8c4', '#a6b5a2');
  box(ctx, 24, 1200, 8, 160, -16, 16, '#d5d4c0', '#a9a58d', '#888f80');
  for (const x of [32, 540, 1060, 1580, 2080]) box(ctx, x - 8, 54, 16, 18, 0, 150, '#eeead7', '#b6c3be', '#8da7ae');
  box(ctx, 32, 54, 2056, 12, 140, 10, '#ede9d5', '#c3cbbd', '#a6b7b4');
  for (const [x1, y1, x2, y2] of [[32, 1200, 216, 1200], [344, 1200, 1776, 1200], [1904, 1200, 2088, 1200],
    [32, 1800, 704, 1800], [704, 1360, 704, 1800], [1592, 1760, 2088, 1760], [2088, 648, 2088, 1200]]) glassRail(ctx, x1, y1, x2, y2);
  for (const bridge of layout.walkways) for (const x of [bridge.x, bridge.x + bridge.w]) glassRail(ctx, x, 1208, x, 1352);
  return canvas;
}

function buildObjects() {
  const list = [];
  const add = (x, y, draw) => list.push({ x, y, depth: x + y, draw });
  for (const [key, room] of Object.entries(layout.rooms)) {
    if (!['rest', 'cafe', 'ceo', 'restroom'].includes(key)) {
      for (const seat of room.seats) {
        add(seat.x, seat.y - 22, ctx => chair(ctx, seat.x, seat.y, key));
      }
    }
    for (const [dx, dy, size] of [[room.w - 40, 60, 1.5], [35, room.h - 60, 1.5], [room.w - 45, room.h - 50, 1.7]]) {
      add(room.x + dx, room.y + dy, ctx => plant(ctx, room.x + dx, room.y + dy, size));
    }
    const tx = room.x + room.w / 2, ty = room.y + 64;
    add(tx, ty, ctx => {
      const p = projectPoint(tx, ty, 68);
      ctx.font = 'bold 11px "Malgun Gothic", sans-serif';
      const w = Math.ceil(ctx.measureText(TITLES[key]).width) + 22;
      ctx.fillStyle = '#8a9b89'; ctx.fillRect(p.x - w / 2 + 2, p.y - 14, w, 22);
      ctx.fillStyle = key === 'skills' ? '#426b7a' : '#faf7e8'; ctx.fillRect(p.x - w / 2, p.y - 16, w, 22);
      text(ctx, TITLES[key], p.x - w / 2 + 11, p.y, key === 'skills' ? '#f1edc8' : '#617061', 'bold 11px "Malgun Gothic", sans-serif');
    });
    if (!['cafe', 'skills', 'ceo', 'restroom'].includes(key)) add(room.x + room.w, room.y + 270, ctx => box(ctx, room.x + room.w - 7, room.y + 85, 7, 190, 0, 28, '#c0d2bd', '#8eaa99', '#73978d'));
  }
  for (const table of layout.workTables) add(table.x + table.w / 2, table.y + table.d + 5, ctx => workTable(ctx, table));
  for (const item of layout.furnishings) add(item.x + item.w / 2, item.y + item.d, ctx => furnishing(ctx, item));
  const rest = layout.rooms.rest;
  add(1112, 982, ctx => sofa(ctx, 1112, 982));
  add(1360, 1064, ctx => sofa(ctx, 1360, 1064));
  add(1290, 924, ctx => {
    box(ctx, 1258, 900, 92, 76, 0, 16, '#e5cfa0', '#c4aa7e', '#aa946e');
    plane(ctx, 1275, 914, 32, 28, 17, '#f3edd3');
    const p = projectPoint(1320, 948, 17); ctx.fillStyle = '#84a58a'; ctx.fillRect(p.x, p.y - 7, 7, 7);
  });
  add(rest.x + 100, rest.y + 150, ctx => bookshelf(ctx, rest.x + 60, rest.y + 120));
  for (const item of layout.interactions) {
    if (item.id === 'sofa' || item.id === 'reading' || item.walkable || item.door) continue;
    add(item.x + item.w / 2, item.y + item.d, ctx => {
      if (item.id === 'vending') vending(ctx, item);
      else if (item.id === 'laptop') laptop(ctx, item);
      else if (item.id === 'arcade') arcade(ctx, item.x, item.y);
      else if (item.id === 'plant') plant(ctx, item.x + item.w / 2, item.y + item.d / 2, 1.5);
      else {
        coffeeStation(ctx, item.x, item.y);
        if (item.menu === 'coffee') {
          const p = projectPoint(item.x + 80, item.y + 22, 47);
          ctx.fillStyle = '#f6dfb3'; ctx.fillRect(p.x - 18, p.y - 15, 48, 10);
          text(ctx, '커피 · 음료', p.x - 15, p.y - 7, '#796f5d', '8px "Malgun Gothic", sans-serif');
        }
      }
    });
  }
  add(1650, 1140, ctx => arcade(ctx, 1620, 1100));
  add(510, 1580, executiveDesk);
  add(368, 1456, ctx => chair(ctx, 500, 1460, 'planning'));
  add(74, 1650, ctx => sofa(ctx, 74, 1650));
  add(550, 1710, ctx => bookshelf(ctx, 530, 1680));
  add(1800, 1640, washroom);
  return list;
}

// Static furniture is rasterized once at the detail resolution, then depth-sorted
// as small bitmaps with moving characters and doors on each frame.
function cacheObjects(items) {
  const scratch = document.createElement('canvas'); scratch.width = 440 * DETAIL; scratch.height = 320 * DETAIL;
  const c = scratch.getContext('2d', { willReadFrequently: true });
  return items.map(item => {
    const p = projectPoint(item.x, item.y);
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, scratch.width, scratch.height);
    c.setTransform(DETAIL, 0, 0, DETAIL, (220 - p.x) * DETAIL, (220 - p.y) * DETAIL);
    item.draw(c);
    const data = c.getImageData(0, 0, scratch.width, scratch.height).data;
    let minX = scratch.width, minY = scratch.height, maxX = -1, maxY = -1;
    for (let y = 0; y < scratch.height; y++) for (let x = 0; x < scratch.width; x++) {
      if (!data[(y * scratch.width + x) * 4 + 3]) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    if (maxX < 0) return item;
    if (minX === 0 || minY === 0 || maxX === scratch.width - 1 || maxY === scratch.height - 1) throw new Error('가구 캐시 영역을 벗어났습니다');
    const sprite = document.createElement('canvas'); sprite.width = maxX - minX + 1; sprite.height = maxY - minY + 1;
    sprite.getContext('2d').drawImage(scratch, minX, minY, sprite.width, sprite.height, 0, 0, sprite.width, sprite.height);
    const x = p.x - 220 + minX / DETAIL, y = p.y - 220 + minY / DETAIL;
    return { depth: item.depth, draw(ctx) { ctx.drawImage(sprite, x, y, sprite.width / DETAIL, sprite.height / DETAIL); } };
  });
}
function label(ctx, a, p) {
  const name = a.label.length > 13 ? a.label.slice(0, 12) + '…' : a.label;
  const value = a.isPlayer ? 'Me' : a.isAmbient ? `${name} · 상주` : name;
  ctx.font = '11px "Malgun Gothic", monospace';
  const w = Math.ceil(ctx.measureText(value).width) + 14;
  const x = Math.round(p.x - w / 2), y = p.y + 9;
  ctx.fillStyle = a.isPlayer ? '#5d8d8a' : a.isLead ? '#e1c58c' : '#c8c2af'; ctx.fillRect(x, y, w, 17);
  ctx.fillStyle = a.isPlayer ? '#719f9a' : a.isLead ? '#fcf0cc' : '#f7f2e5'; ctx.fillRect(x, y, w, 15);
  text(ctx, value, x + 7, y + 11, a.isPlayer ? '#fff9e8' : '#645e52', '11px "Malgun Gothic", monospace');
}

function bubble(ctx, a, p, t, occupied) {
  const [fill, border] = BUBBLES[a.bubble.kind] || BUBBLES.info;
  ctx.font = '13px "Malgun Gothic", sans-serif';
  const lines = a.bubble.text.split('\n').slice(0, 2).map(value => {
    const chars = [...value];
    while (ctx.measureText(chars.join('')).width > 220 && chars.length > 2) chars.splice(-2, 2, '…');
    return chars.join('');
  });
  const w = Math.ceil(Math.max(...lines.map(value => ctx.measureText(value).width))) + 18;
  const h = 12 + lines.length * 17;
  let x = Math.max(4, Math.min(WIDTH - w - 4, Math.round(p.x - w / 2)));
  const seatedCodex = a.cli === 'codex' && ['sit', 'type', 'read', 'run'].includes(a.pose);
  const head = seatedCodex ? (a.isLead ? 78 : 68) : 50;
  let y = Math.max(50, p.y - head - h);
  const overlaps = (x, y) => occupied.some(b => x < b.x + b.w + 4 && x + w + 4 > b.x && y < b.y + b.h + 4 && y + h + 4 > b.y);
  if (seatedCodex && overlaps(x, y)) {
    for (const side of [p.x - w - 34, p.x + 34]) {
      const candidate = Math.max(4, Math.min(WIDTH - w - 4, Math.round(side)));
      if (!overlaps(candidate, y)) { x = candidate; break; }
    }
  }
  for (let tries = 0; tries < 8 && overlaps(x, y); tries++) y -= h + 5;
  y = Math.max(4, y);
  occupied.push({ x, y, w, h });
  const tail = Math.min(x + w - 7, Math.max(x + 5, p.x));
  line(ctx, { x: tail, y: y + h }, { x: p.x, y: p.y - head + 10 }, border);
  ctx.beginPath(); ctx.roundRect(x + 1, y + 2, w, h, 8);
  ctx.fillStyle = '#bfb49e'; ctx.fill();
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 8);
  ctx.fillStyle = border; ctx.fill();
  ctx.beginPath(); ctx.roundRect(x + 1, y + 1, w - 2, h - 2, 7);
  ctx.fillStyle = fill; ctx.fill();
  lines.forEach((value, i) => text(ctx, value, x + 9, y + 18 + i * 17, i ? '#5a766d' : '#4f514a', '13px "Malgun Gothic", sans-serif'));
  if (a.bubble.kind === 'alert' && Math.floor(t / 450) % 2) { ctx.fillStyle = '#bf6c54'; ctx.fillRect(x - 3, y + 5, 2, 7); }
}

export default {
  id: 'pixel-office',
  name: '픽셀 오피스 · 도시 배경',
  exteriorVisible: true,
  layout,
  viewport: { width: WIDTH * 2, height: HEIGHT * 2 },
  agentHead: 44,
  agentHitRadius: 32,
  background: PAPER,
  sceneBackground(env) { return env?.night ? '#24384f' : env?.sunset ? '#e8b699' : '#b4cbd5'; },
  project(x, y) { const p = projectPoint(x, y); return { x: p.x * 2, y: p.y * 2 }; },
  unproject(x, y) {
    const dx = (x / 2 - 780) / 0.36, dy = (y / 2 - 125) / 0.18;
    return { x: (dx + dy) / 2, y: (dy - dx) / 2 };
  },
  hitTest(x, y) {
    return HIT_ORDER.find(item => {
      const points = [projectPoint(item.x, item.y, item.height), projectPoint(item.x + item.w, item.y), projectPoint(item.x, item.y + item.d), projectPoint(item.x + item.w, item.y + item.d)];
      return x / 2 >= Math.min(...points.map(p => p.x)) - 5 && x / 2 <= Math.max(...points.map(p => p.x)) + 5
        && y / 2 >= Math.min(...points.map(p => p.y)) - 5 && y / 2 <= Math.max(...points.map(p => p.y)) + 5;
    });
  },
  async load() {
    await Promise.all([loadDrinkImages(), loadCityImages()]);
    if (!floorCache) {
      floorCache = buildFloor(); atmosphere.load(floorCache);
      shadedFloorCache = document.createElement('canvas');
      shadedFloorCache.width = floorCache.width; shadedFloorCache.height = floorCache.height;
      const shaded = shadedFloorCache.getContext('2d');
      shaded.drawImage(floorCache, 0, 0); shaded.scale(DETAIL, DETAIL);
      atmosphere.drawFloor(shaded, { night: true });
      const day = floorCache.getContext('2d');
      atmosphere.drawFloor(day, { night: false, condition: 'clear' });
    }
    if (!objects) objects = cacheObjects(buildObjects());
    if (!frameCanvas) { frameCanvas = document.createElement('canvas'); frameCanvas.width = WIDTH * DETAIL; frameCanvas.height = HEIGHT * DETAIL; }
  },
  unmount(next) { if (next?.layout !== layout) releaseCaches(); },
  drawScene(ctx, agents, t, state = {}) {
    const pixel = frameCanvas.getContext('2d');
    pixel.setTransform(DETAIL, 0, 0, DETAIL, 0, 0);
    const environment = { ...(state.environment || { night: false, condition: 'clear' }), neon: this.id === 'pixel-office-citypop' && !!state.environment?.neon,
      sunset: ['pixel-office', 'pixel-office-plain'].includes(this.id) && !state.environment?.night && !!state.environment?.sunset };
    const sunny = !environment.night && !environment.sunset && ['clear', 'unknown'].includes(environment.condition);
    const showExterior = this.exteriorVisible !== false;
    if (!showExterior) { pixel.fillStyle = this.sceneBackground(environment); pixel.fillRect(0, 0, WIDTH, HEIGHT); }
    const backdrop = this.windowStyle === 'simple' ? null : exterior.drawBackground(pixel, t, environment, showExterior);
    pixel.drawImage(sunny ? floorCache : shadedFloorCache, 0, 0, WIDTH, HEIGHT);
    atmosphere.drawWindows(pixel, t, environment, backdrop, this.windowStyle);
    const hover = layout.interactions.find(p => p.id === state.hoveredItem);
    if (hover) plane(pixel, hover.x - 7, hover.y - 7, hover.w + 14, hover.d + 14, 3, '#f3d786');
    if (state.destination) {
      const p = projectPoint(state.destination.x, state.destination.y);
      const d = 9 + Math.floor(t / 180) % 3;
      line(pixel, { x: p.x - d, y: p.y }, { x: p.x, y: p.y - d / 2 | 0 }, '#5f9b92');
      line(pixel, { x: p.x, y: p.y - d / 2 | 0 }, { x: p.x + d, y: p.y }, '#5f9b92');
      line(pixel, { x: p.x + d, y: p.y }, { x: p.x, y: p.y + d / 2 | 0 }, '#5f9b92');
      line(pixel, { x: p.x, y: p.y + d / 2 | 0 }, { x: p.x - d, y: p.y }, '#5f9b92');
    }
    const skillWorkers = agents.filter(a => a.skill && a.status !== 'leaving');
    if (skillWorkers.length) {
      const r = layout.rooms.skills, p = projectPoint(r.x + 245, r.y + 240);
      const step = Math.floor(t / 160) % 4;
      pixel.fillStyle = '#e6dc9e'; pixel.fillRect(p.x - 12 + step * 7, p.y - 4, 4, 4);
      text(pixel, `${skillWorkers.length}명 스킬 협업 중`, p.x - 48, p.y - 20, '#f2edcb', '10px "Malgun Gothic", sans-serif');
    }
    const doors = layout.interactions.filter(i => i.door).map(item => ({ depth: item.x + item.w / 2 + item.y + (item.axis === 'y' ? item.d / 2 : 0), draw(c) {
      doorPanel(c, item, state.doors?.find(d => d.id === item.id)?.amount || 0);
    } }));
    const items = [...objects, ...doors, ...agents.map(a => ({ depth: a.x + a.y, draw(c) {
      const p = projectPoint(a.x, a.y); c.save(); c.translate(p.x, p.y); c.scale(1.5, 1.5); drawCharacter(c, a, t, 0, 0); c.restore();
    } }))];
    items.sort((a, b) => a.depth - b.depth);
    for (const item of items) item.draw(pixel);
    atmosphere.drawLighting(pixel, environment);
    for (const effect of state.effects || []) {
      const p = projectPoint(effect.x, effect.y), phase = t / 200;
      for (let i = 0; i < 7; i++) {
        const x = p.x + Math.sin(i * 2.4 + phase) * 18, y = p.y - 16 - (i * 8 + phase * 4) % 42;
        pixel.fillStyle = effect.kind === 'sparkle' ? '#e0f2aa' : ['#e7b0c6', '#f0d796', '#a6d4d0'][i % 3];
        pixel.fillRect(Math.round(x), Math.round(y), 2, effect.kind === 'sparkle' ? 2 : 4);
      }
    }
    for (const a of agents) label(pixel, a, projectPoint(a.x, a.y));
    const occupied = [];
    for (const a of agents) if (a.bubble) bubble(pixel, a, projectPoint(a.x, a.y), t, occupied);
    ctx.save(); ctx.imageSmoothingEnabled = false;
    ctx.drawImage(frameCanvas, 0, 0, WIDTH * 2, HEIGHT * 2); ctx.restore();
  },
};
