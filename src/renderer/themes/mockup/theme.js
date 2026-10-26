// 목업 테마 — Canvas 도형으로만 그린다. 실제 그림(스프라이트·배경)으로 바꿀 때는
// 같은 모양의 객체를 내보내는 새 테마를 만들면 된다 (THEME.md).

import layout from './layout.js';

const BODY = '#d97757';
const BODY_DARK = '#b45a3c';
const HAT = ['#1e88e5', '#8e24aa', '#43a047', '#e53935', '#fb8c00', '#00897b', '#6d4c41', '#3949ab'];
const FLOOR = {
  analysis: '#f2eee5', planning: '#f1eef8', lead: '#efe8fb', dev: '#edf4ee', review: '#f7eeee', rest: '#e7f3ea',
};
const BUBBLE = {
  info: ['#ffffff', '#555'], work: ['#ffffff', '#3c3c3c'], share: ['#fff3c4', '#c79a00'],
  report: ['#e3f0ff', '#2f6fb3'], alert: ['#ffe9e9', '#d32f2f'], done: ['#e7f6e9', '#2e7d32'], chat: ['#f4eafa', '#7b4fa0'],
};
const SEATED = new Set(['sit', 'type', 'read', 'run']);

let bgCache = null;

function rr(ctx, x, y, w, h, r, fill, stroke, lw = 1) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}

function plant(ctx, x, y, s = 1) {
  rr(ctx, x - 9 * s, y - 4 * s, 18 * s, 14 * s, 3, '#b9774a');
  ctx.fillStyle = '#3f8f4f';
  for (const [dx, dy, r] of [[0, -14, 10], [-8, -8, 8], [8, -8, 8], [0, -22, 7]]) {
    ctx.beginPath(); ctx.arc(x + dx * s, y + dy * s, r * s, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#5fb36d';
  ctx.beginPath(); ctx.arc(x - 3 * s, y - 17 * s, 4 * s, 0, Math.PI * 2); ctx.fill();
}

function drawWindows(ctx, L) {
  const g = ctx.createLinearGradient(0, 0, 0, 36);
  g.addColorStop(0, '#9fd3f5'); g.addColorStop(1, '#d8eefb');
  ctx.fillStyle = g; ctx.fillRect(0, 0, L.width, 36);
  ctx.fillStyle = '#b7c7d6';
  for (let x = 0; x < L.width; x += 23) {
    const h = 8 + ((x * 37) % 19);
    ctx.fillRect(x, 36 - h, 16, h);
  }
  ctx.strokeStyle = '#5f6b75'; ctx.lineWidth = 3;
  for (let x = 0; x <= L.width; x += 60) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 36); ctx.stroke(); }
  ctx.fillStyle = '#5f6b75'; ctx.fillRect(0, 33, L.width, 3);
}

function drawRoom(ctx, r) {
  ctx.fillStyle = FLOOR[r.key] || '#f3f0ea';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = 'rgba(0,0,0,0.05)'; ctx.lineWidth = 1;
  for (let x = r.x; x < r.x + r.w; x += 32) { ctx.beginPath(); ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); ctx.stroke(); }
  for (let y = r.y; y < r.y + r.h; y += 32) { ctx.beginPath(); ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y); ctx.stroke(); }

  // 벽 (문 자리는 비운다)
  ctx.strokeStyle = '#8a7c69'; ctx.lineWidth = 6; ctx.lineCap = 'square';
  const gap = 30;
  ctx.beginPath();
  ctx.moveTo(r.x, r.y); ctx.lineTo(r.x + r.w, r.y); ctx.lineTo(r.x + r.w, r.y + r.h);
  if (r.door.y === r.y + r.h) {
    ctx.lineTo(r.door.x + gap, r.y + r.h); ctx.moveTo(r.door.x - gap, r.y + r.h); ctx.lineTo(r.x, r.y + r.h); ctx.lineTo(r.x, r.y);
  } else {
    ctx.lineTo(r.x, r.y + r.h); ctx.lineTo(r.x, r.y); ctx.moveTo(r.x, r.y); ctx.lineTo(r.door.x - gap, r.y); ctx.moveTo(r.door.x + gap, r.y); ctx.lineTo(r.x + r.w, r.y);
  }
  ctx.stroke();

  // 방 이름표
  ctx.font = 'bold 13px "Malgun Gothic", sans-serif';
  const text = `${r.emoji} ${r.label}`;
  const w = ctx.measureText(text).width + 16;
  rr(ctx, r.x + 10, r.y + 10, w, 22, 11, 'rgba(255,255,255,0.9)', 'rgba(0,0,0,0.15)');
  ctx.fillStyle = '#4b4033'; ctx.textBaseline = 'middle';
  ctx.fillText(text, r.x + 18, r.y + 21);

  plant(ctx, r.x + r.w - 24, r.y + 40, 0.9);
  plant(ctx, r.x + 22, r.y + r.h - 18, 0.8);
}

function drawRestExtras(ctx, r) {
  rr(ctx, r.x + 34, r.y + 80, 230, 170, 14, '#d5ead9');
  rr(ctx, r.x + 40, r.y + 270, 210, 34, 10, '#2f8f8a', '#23706c', 2); // 소파
  rr(ctx, r.x + 40, r.y + 296, 210, 14, 6, '#257470');
  ctx.fillStyle = '#c8a97e'; ctx.beginPath(); ctx.arc(r.x + 340, r.y + 180, 22, 0, Math.PI * 2); ctx.fill();
  rr(ctx, r.x + 300, r.y + 54, 50, 40, 6, '#6d6d6d', '#444', 2); // 커피 머신
  ctx.fillStyle = '#d97757'; ctx.fillRect(r.x + 318, r.y + 64, 14, 10);
  ctx.font = '11px "Malgun Gothic", sans-serif'; ctx.fillStyle = '#fff'; ctx.fillText('☕', r.x + 316, r.y + 84);
}

function drawLeadExtras(ctx, r) {
  rr(ctx, r.x + 60, r.y + 190, r.w - 120, 70, 12, '#ddd0f3');
  rr(ctx, r.x + 120, r.y + 205, r.w - 240, 40, 8, '#b69a74', '#8c7253', 2); // 회의 탁자
}

function drawHall(ctx, L) {
  ctx.fillStyle = '#e4dfd5';
  ctx.fillRect(0, L.hallway.y0, L.width, L.hallway.y1 - L.hallway.y0);
  rr(ctx, 30, L.hallway.y - 14, L.width - 60, 28, 6, '#d3cbbd');
  ctx.font = '11px "Malgun Gothic", sans-serif'; ctx.fillStyle = '#7d7362'; ctx.textBaseline = 'middle';
  ctx.fillText('🚪 입구', 10, L.hallway.y - 24);
}

function buildBackground(L) {
  const c = document.createElement('canvas');
  const k = 2;
  c.width = L.width * k; c.height = L.height * k;
  const ctx = c.getContext('2d');
  ctx.scale(k, k);
  ctx.fillStyle = '#cfc6b6'; ctx.fillRect(0, 0, L.width, L.height);
  drawWindows(ctx, L);
  drawHall(ctx, L);
  for (const r of Object.values(L.rooms)) drawRoom(ctx, r);
  drawRestExtras(ctx, L.rooms.rest);
  drawLeadExtras(ctx, L.rooms.lead);
  return c;
}

function desk(ctx, x, y) {
  rr(ctx, x - 32, y - 4, 64, 22, 4, '#c8a97e', '#9c7f58', 1.5);
  ctx.fillStyle = '#d9bd94'; ctx.fillRect(x - 30, y - 2, 60, 5);
  rr(ctx, x + 12, y - 16, 16, 12, 2, '#2b2f36'); // 모니터 (옆으로 비켜 둬 얼굴을 가리지 않게)
  ctx.fillStyle = '#7fc8f8'; ctx.fillRect(x + 14, y - 14, 12, 8);
  ctx.fillStyle = '#2b2f36'; ctx.fillRect(x + 18, y - 4, 4, 3);
}

export default {
  id: 'mockup',
  name: '목업 (도형)',
  layout,

  async load() {
    bgCache = null;
  },

  drawBackground(ctx, L) {
    if (!bgCache) bgCache = buildBackground(L);
    ctx.drawImage(bgCache, 0, 0, L.width, L.height);
  },

  drawForeground(ctx, L) {
    for (const key of ['analysis', 'planning', 'dev', 'review', 'lead']) {
      for (const s of L.rooms[key].seats) desk(ctx, s.x, s.y + 2);
    }
  },

  drawAgent(ctx, a, t) {
    const scale = a.isLead ? 1.2 : 1;
    const walking = a.pose === 'walk';
    const seated = SEATED.has(a.pose);
    const bob = walking ? Math.sin(t / 85) * 1.6 : a.pose === 'type' ? Math.sin(t / 110) * 0.8 : 0;

    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.scale(scale, scale);

    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath(); ctx.ellipse(0, 0, 13, 4, 0, 0, Math.PI * 2); ctx.fill();

    const top = (seated ? -18 : -24) + bob;
    if (!seated) {
      ctx.fillStyle = BODY_DARK;
      [-9, -3, 3, 9].forEach((lx, i) => {
        const swing = walking ? Math.sin(t / 85 + i * Math.PI / 2) * 2 : 0;
        ctx.fillRect(lx - 1.5, top + 16, 3, 7 + swing);
      });
    }
    rr(ctx, -14, top, 28, 17, 4, BODY, BODY_DARK, 1.2);
    ctx.fillStyle = BODY;
    ctx.fillRect(-18, top + 6, 4, 5);
    ctx.fillRect(14, top + 6, 4, 5);

    if (a.facing !== 'up') {
      const shift = a.facing === 'left' ? -2 : a.facing === 'right' ? 2 : 0;
      ctx.fillStyle = '#1d1d1d';
      ctx.fillRect(-7 + shift, top + 5, 3, 4);
      ctx.fillRect(4 + shift, top + 5, 3, 4);
    }

    if (a.isLead) {
      ctx.fillStyle = '#f6c343';
      ctx.beginPath();
      ctx.moveTo(-9, top - 1); ctx.lineTo(-9, top - 8); ctx.lineTo(-4, top - 4); ctx.lineTo(0, top - 10);
      ctx.lineTo(4, top - 4); ctx.lineTo(9, top - 8); ctx.lineTo(9, top - 1); ctx.closePath(); ctx.fill();
    } else {
      ctx.fillStyle = HAT[(a.colorIndex % HAT.length + HAT.length) % HAT.length];
      rr(ctx, -11, top - 5, 22, 6, [3, 3, 0, 0]);
      ctx.fill();
    }

    if (a.pose === 'read') { rr(ctx, 8, top + 7, 9, 11, 1, '#fff', '#999'); }
    if (a.pose === 'run') { ctx.font = 'bold 9px Consolas, monospace'; ctx.fillStyle = '#1b5e20'; ctx.fillText('>_', 10, top + 2); }
    if (a.pose === 'alert') { ctx.font = 'bold 14px sans-serif'; ctx.fillStyle = '#d32f2f'; ctx.fillText('!', 15, top - 2); }
    ctx.restore();

    ctx.font = '10px "Malgun Gothic", sans-serif';
    const label = a.label.length > 16 ? a.label.slice(0, 15) + '…' : a.label;
    const w = ctx.measureText(label).width + 8;
    rr(ctx, a.x - w / 2, a.y + 4, w, 14, 3, a.isLead ? '#fff7d6' : 'rgba(255,255,255,0.92)', 'rgba(0,0,0,0.25)');
    ctx.fillStyle = '#333'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    ctx.fillText(label, a.x, a.y + 11);
    ctx.textAlign = 'start';
  },

  drawBubble(ctx, a, bubble, t) {
    const [bg, border] = BUBBLE[bubble.kind] || BUBBLE.info;
    ctx.font = '11px "Malgun Gothic", "Segoe UI Emoji", sans-serif';
    let text = bubble.text;
    const maxW = 190;
    while (ctx.measureText(text).width > maxW && text.length > 2) text = text.slice(0, -2) + '…';
    const w = ctx.measureText(text).width + 14;
    const h = 20;
    const head = a.isLead ? 40 : 34;
    const x = a.x - w / 2;
    const y = a.y - head - h;
    const pulse = bubble.kind === 'share' || bubble.kind === 'report' ? 1.5 + Math.sin(t / 180) * 0.8 : 1.2;
    rr(ctx, x, y, w, h, 9, bg, border, pulse);
    ctx.fillStyle = bg; ctx.strokeStyle = border; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(a.x - 5, y + h - 0.5); ctx.lineTo(a.x, y + h + 6); ctx.lineTo(a.x + 5, y + h - 0.5); ctx.fill();
    ctx.beginPath(); ctx.moveTo(a.x - 5, y + h); ctx.lineTo(a.x, y + h + 6); ctx.lineTo(a.x + 5, y + h); ctx.stroke();
    ctx.fillStyle = '#222'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 7, y + h / 2 + 0.5);
  },
};
