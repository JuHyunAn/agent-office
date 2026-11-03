import { drawDrinkImage } from './drink-images.js';

// Codex와 같은 85% 크기·정수 격자. 사무실에는 원본 펫 이미지나 연속 명암을 사용하지 않는다.
const SIZE = .85;
const px = value => Math.round(value * SIZE);
const COLORS = {
  grok: { body: '#30343e', light: '#555e70', shade: '#242833', eye: '#edece2' },
  muse: { body: '#d9c6a5', light: '#eadcc0', shade: '#b9a183', face: '#f0d7b6', ink: '#51473f', cheek: '#d6a296' },
  antigravity: { body: '#80aec5', light: '#a6c8d4', shade: '#57879f', ink: '#385969', eye: '#eeeccc',
    green: '#96b6a2', yellow: '#d2bd88', pink: '#c89ba4' },
};

function grok(r, a, tick, back, sleepy) {
  const c = COLORS.grok, shift = a.facing === 'left' ? -1 : a.facing === 'right' ? 1 : 0;
  const top = sleepy ? -19 : -26;
  // 둥근 실루엣을 계단 모양의 띠로 표현한다. 팔다리는 붙이지 않는다.
  r(-5, top, 10, 1, c.light); r(-9, top + 1, 18, 2, c.light);
  r(-11, top + 3, 22, 3, c.body); r(-12, top + 6, 24, -top - 12, c.body);
  r(-11, -6, 22, 3, c.shade); r(-9, -3, 18, 2, c.shade); r(-5, -1, 10, 1, c.shade);
  r(-11, top + 6, 2, 7, c.light); r(-7, top + 3, 5, 1, c.light);
  r(10, top + 7, 2, -top - 14, c.shade);
  if (back) { r(-4, top + 5, 8, 1, c.light); return; }
  const blink = (tick + (a.colorIndex || 0) * 9) % 57 >= 54;
  for (const ex of [-6, 3]) {
    if (sleepy || blink) r(ex + shift, top + 12, 5, 1, c.eye);
    else if (a.pose === 'talk' || a.pose === 'drink') {
      r(ex + shift, top + 9, 4, 1, c.eye); r(ex - 1 + shift, top + 10, 1, 2, c.eye); r(ex + 4 + shift, top + 10, 1, 2, c.eye);
    } else {
      const tilt = ex < 0 ? 0 : -1;
      r(ex + shift, top + 7 + tilt, 3, 6, c.eye); r(ex + 1 + shift, top + 8 + tilt, 3, 6, c.eye);
    }
  }
}

function muse(r, a, tick, back, sleepy) {
  const c = COLORS.muse, walking = a.pose === 'walk', step = walking ? [0, 2, 0, -1][tick % 4] : 0;
  const raised = a.pose === 'stretch' ? -9 : a.pose === 'talk' ? -4 - tick % 2 : 0;
  r(-7, -4 + step, 5, 4 - step, c.shade); r(3, -4 - step, 5, 4 + step, c.body);
  r(-9, -17, 18, 13, c.body); r(-7, -21, 14, 17, c.body);
  r(-9, -15, 2, 10, c.shade); r(-7, -5, 14, 2, c.shade);
  r(-12, -16 - step + (a.pose === 'stretch' ? -9 : 0), 3, 10, c.shade); r(9, -16 + step + raised, 3, 10, c.body);
  r(-5, -29, 10, 1, c.light); r(-8, -28, 16, 3, c.light);
  r(-10, -25, 20, 10, c.body); r(-8, -15, 16, 2, c.shade);
  r(-9, -25, 2, 9, c.light); r(-5, -11, 2, 1, c.light); r(3, -8, 2, 1, c.light);
  if (!back) {
    const shift = a.facing === 'left' ? -1 : a.facing === 'right' ? 1 : 0;
    r(-6 + shift, -25, 12, 1, c.shade); r(-7 + shift, -24, 14, 8, c.face); r(-5 + shift, -16, 10, 1, c.face);
    r(-6 + shift, -19, 2, 1, c.cheek); r(5 + shift, -19, 2, 1, c.cheek);
    const blink = (tick + (a.colorIndex || 0) * 9) % 57 >= 54;
    if (sleepy || blink) { r(-5 + shift, -21, 3, 1, c.ink); r(3 + shift, -21, 3, 1, c.ink); }
    else { r(-5 + shift, -23, 2, 3, c.ink); r(4 + shift, -23, 2, 3, c.ink); }
    r(-2 + shift, -18, 1, 1, c.ink); r(-1 + shift, -17, 3, 1, c.ink); r(2 + shift, -18, 1, 1, c.ink);
  } else r(-5, -25, 10, 1, c.light);
  // 뮤즈는 업무·검토 중에만 헤드셋을 착용한다.
  if (['type', 'run', 'read'].includes(a.pose)) {
    r(-7, -30, 14, 2, '#585b60'); r(-10, -28, 3, 3, '#585b60'); r(7, -28, 3, 3, '#585b60');
    r(-12, -25, 3, 8, '#484c53'); r(10, -25, 3, 8, '#484c53');
    r(-12, -23, 1, 4, '#81868a'); r(11, -23, 1, 4, '#81868a');
    if (!back) { r(8, -18, 3, 1, '#484c53'); r(6, -17, 3, 1, '#484c53'); }
  }
}

function gemini(r, a, tick, back, sleepy) {
  const c = COLORS.antigravity, step = a.pose === 'walk' ? [0, 2, 0, -1][tick % 4] : 0;
  // 짧고 바깥으로 굽은 뿔은 계단 윤곽으로, 끝과 밑동의 폭을 다르게 그린다.
  r(-11, -33, 2, 2, c.shade); r(-12, -31, 3, 3, c.shade); r(-12, -28, 5, 3, c.shade); r(-10, -25, 4, 2, c.shade);
  r(9, -33, 2, 2, c.shade); r(9, -31, 3, 3, c.shade); r(7, -28, 5, 3, c.shade); r(6, -25, 4, 2, c.shade);
  r(-11, -30, 1, 3, c.body); r(-10, -27, 3, 1, c.body); r(10, -30, 1, 3, c.body); r(7, -27, 3, 1, c.body);
  r(-7, -27, 14, 2, c.light); r(-10, -25, 20, 3, c.body);
  r(-11, -22, 22, 7, c.body); r(-12, -15, 24, 10, c.body);
  // 무지개는 사무실의 파스텔 색에 맞춘 네 개의 넓은 띠로 단순화한다.
  r(-12, -14, 24, 4, c.green); r(-11, -10, 22, 3, c.yellow);
  r(-10, -7, 20, 3, c.pink); r(-7, -4, 14, 1, c.pink);
  r(-12, -21, 2, 8, c.shade); r(-10, -24, 2, 8, c.light);
  const raised = a.pose === 'stretch' ? -8 : a.pose === 'talk' ? -4 - tick % 2 : 0;
  r(-14, -14 - step + (a.pose === 'stretch' ? -8 : 0), 3, 7, c.green); r(11, -14 + step + raised, 3, 7, c.green);
  r(-8, -3 + step, 5, 3 - step, c.shade); r(4, -3 - step, 5, 3 + step, c.shade);
  if (back) { r(-4, -24, 8, 1, c.light); return; }
  const shift = a.facing === 'left' ? -1 : a.facing === 'right' ? 1 : 0;
  const blink = (tick + (a.colorIndex || 0) * 9) % 57 >= 54;
  for (const ex of [-8, 3]) {
    if (sleepy || blink) { r(ex + shift, -19, 6, 1, c.ink); continue; }
    r(ex + 1 + shift, -24, 4, 1, c.shade); r(ex + shift, -23, 6, 6, c.eye); r(ex + 1 + shift, -17, 4, 1, c.shade);
    r(ex + 1 + shift, -23, 4, 6, c.ink);
    r(ex + 1 + shift, -23, 2, 2, c.pink); r(ex + 3 + shift, -20, 2, 2, c.green);
    // 작은 십자형 별빛 눈: 한 도트 단위에서 읽히는 크기를 유지한다.
    r(ex + 2 + shift, -22, 1, 4, c.eye); r(ex + 1 + shift, -21, 3, 1, c.eye);
  }
  r(-3, -14, 2, 1, c.ink); r(-1, -13, 3, 1, c.ink); r(2, -14, 2, 1, c.ink);
  r(-3, -13, 1, 2, c.eye); r(3, -13, 1, 2, c.eye);
}

const DRAW = { grok, muse, antigravity: gemini };

export function drawOfficeCompanion(ctx, a, t, x, y) {
  if (!Object.hasOwn(DRAW, a.cli)) return false;
  const tick = Math.floor(t / 130), walking = a.pose === 'walk';
  const seated = ['sit', 'type', 'read', 'run'].includes(a.pose);
  const coffee = a.action === 'drink' || a.pose === 'drink';
  const sleepy = a.pose === 'sleep' || ['resting', 'away'].includes(a.status) && ['sit', 'stand'].includes(a.pose) && !a.heldItem;
  const back = walking && a.facing === 'up', body = COLORS[a.cli].body;
  ctx.save(); ctx.translate(Math.round(x), Math.round(y));
  const r = (x, y, w, h, color) => {
    const sx = px(x), sy = px(y);
    ctx.fillStyle = color; ctx.fillRect(sx, sy, Math.max(1, px(x + w) - sx), Math.max(1, px(y + h) - sy));
  };
  r(-12, 0, 24, 2, '#b8ae9c');
  const bob = walking ? [0, -1, 0, 1][tick % 4] : ['type', 'talk'].includes(a.pose) ? tick % 2 : 0;
  ctx.translate(0, px(bob) - (seated ? 12 : 0));
  DRAW[a.cli](r, a, tick, back, sleepy);
  // 각 상태의 소품과 높이는 기존 Claude·Codex 사무실 표현에 맞춘다.
  if (a.pose === 'type') {
    r(-8, -3, 17, 3, '#656568'); r(-6, -3, 13, 1, '#d4d0c5');
    if (a.cli !== 'grok') { r(-7, -6 + tick % 2, 4, 3, body); r(3, -5 - tick % 2, 4, 3, body); }
  }
  if (a.pose === 'read' || a.status === 'reporting') {
    r(9, -15 + tick % 2, 9, 13, '#6c645b'); r(10, -16 + tick % 2, 9, 12, '#fff3d9');
    for (let y = -13; y < -6; y += 3) r(12, y + tick % 2, 5, 1, '#8b9687');
  }
  if (a.pose === 'run') {
    r(7, -12, 13, 10, '#363b3d'); r(8, -11, 11, 7, '#253f3d');
    r(10, -9, 2, 1, '#91c4a0'); r(12, -8, 2, 1, '#91c4a0');
    if (tick % 2) r(15, -6, 3, 1, '#e8d39c');
  }
  if (a.status === 'sharing') { r(9, -14 + tick % 2, 14, 10, '#ac7838'); r(10, -13 + tick % 2, 12, 8, '#eac06b'); r(13, -11 + tick % 2, 6, 1, '#b68d4c'); }
  if (a.pose === 'alert') { r(18, -35 + tick % 2, 3, 6, '#b95447'); r(18, -27, 3, 2, '#b95447'); }
  if (a.heldItem || coffee) {
    const cup = a.heldItem || { color: '#fff4db', liquid: '#795b44', iced: false };
    const sip = coffee ? (tick % 6 < 3 ? 0 : -3) : 3;
    if (a.cli !== 'grok') r(9, -9 + sip, 4, 3, body);
    if (!drawDrinkImage(ctx, cup.id || 'americano', px(11), px(-20 + sip), px(16), px(17))) {
      r(11, -13 + sip, 7, 8, cup.color); r(12, -14 + sip, 5, 2, cup.liquid);
    }
    if (!cup.iced) { r(12 + tick % 2, -20 + sip, 1, 3, '#dfd5be'); r(15 - tick % 2, -24 + sip, 1, 3, '#dfd5be'); }
  }
  if (a.pose === 'brew') { r(16, -10, 5, 7, '#f0dec0'); r(17 + tick % 2, -17, 1, 3, '#e7dfcb'); }
  if (a.pose === 'play') {
    r(-9, -10, 20, 6, '#46576a'); r(-6, -9, 5, 1, '#d5d9bc'); r(-4, -11, 1, 5, '#d5d9bc');
    r(5, -9 + tick % 2, 2, 2, '#e1a17e'); r(8, -8 - tick % 2, 2, 2, '#b0d4b5');
  }
  if (a.pose === 'water') {
    r(10, -14, 10, 8, '#7daec1'); r(19, -12, 6, 2, '#7daec1'); r(10, -16, 6, 2, '#a8d0d8');
    for (let i = 0; i < 3; i++) r(24 + i * 2, -8 + (tick + i * 2) % 8, 1, 2, '#9fd9e7');
  }
  if (a.pose === 'stretch' && a.cli === 'grok') { r(-17, -23 - tick % 2, 2, 5, '#d2bd88'); r(15, -29 + tick % 2, 2, 5, '#d2bd88'); }
  if (a.isLead) { r(-3, -40, 6, 2, '#e3b55c'); r(-1, -42, 2, 6, '#e3b55c'); }
  if (a.isPlayer) { r(-4, -40, 8, 2, '#6ca7a1'); r(-2, -42, 4, 2, '#8bc4ba'); }
  if (sleepy) { r(10, -29 - tick % 4, 3, 1, '#7b869b'); r(12, -28 - tick % 4, 1, 1, '#7b869b'); r(10, -27 - tick % 4, 3, 1, '#7b869b'); }
  ctx.restore(); return true;
}
