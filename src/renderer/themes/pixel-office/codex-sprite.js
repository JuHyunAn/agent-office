import { drawDrinkImage } from './drink-images.js';

const SIZE = .85;
const BLUE = '#5887d8', LIGHT = '#80a9ee', SHADE = '#3c62aa', INK = '#25385f', CYAN = '#b4eee9';
const ACCENTS = ['#719c9b', '#ad8bb3', '#7f9c74', '#ca8274', '#d0aa64', '#7496b0', '#a2937e', '#8d93b8'];
const px = value => Math.round(value * SIZE);

// 승인된 85% 시안. 축소 좌표를 정수 격자로 맞춰 흐릿한 가장자리를 만들지 않는다.
export function drawCodexCharacter(ctx, a, t, x, y) {
  const tick = Math.floor(t / 130), walking = a.pose === 'walk';
  // 뒤로 이동할 때만 뒷모습을 사용한다. 정지·착석 중에는 얼굴을 카메라 쪽으로 돌린다.
  const back = a.facing === 'up' && walking;
  const seated = ['sit', 'type', 'read', 'run'].includes(a.pose);
  const coffee = a.action === 'drink' || a.pose === 'drink';
  const sleepy = ['resting', 'away'].includes(a.status) && ['sit', 'stand'].includes(a.pose) && !a.heldItem;
  const { accessory = 'none' } = a.appearance || {};
  const accent = a.isLead ? '#d6ac5b' : ACCENTS[Math.max(0, a.colorIndex || 0) % ACCENTS.length];
  ctx.save(); ctx.translate(Math.round(x), Math.round(y));
  const r = (x, y, w, h, color) => {
    const sx = px(x), sy = px(y);
    ctx.fillStyle = color; ctx.fillRect(sx, sy, Math.max(1, px(x + w) - sx), Math.max(1, px(y + h) - sy));
  };
  r(-12, 0, 24, 2, '#b8ae9c');
  const bob = walking ? [0, -1, 0, 1][tick % 4] : a.pose === 'type' ? tick % 2 : 0;
  // 짧은 몸통을 의자 높이에 맞춰 모니터 위로 얼굴, 책상 위로 손이 오게 한다.
  ctx.translate(0, px(bob) - (seated ? 12 : 0));

  // 구름 머리와 짧은 몸통은 시안의 실루엣을 유지한다.
  r(-7, -29, 8, 2, LIGHT); r(3, -28, 6, 2, LIGHT);
  r(-10, -27, 22, 4, BLUE); r(-13, -24, 27, 13, BLUE);
  r(-11, -26, 5, 3, LIGHT); r(-6, -28, 6, 3, LIGHT);
  r(-14, -21, 2, 7, SHADE); r(-12, -12, 24, 3, BLUE);
  r(-9, -10, 18, 2, SHADE); r(12, -21, 2, 8, SHADE);
  r(-6, -8, 12, 6, BLUE); r(-6, -7, 2, 5, SHADE); r(-4, -8, 8, 1, LIGHT);
  const step = walking ? [0, 2, 0, -1][tick % 4] : 0;
  r(-6, -2 + step, 4, (seated ? 2 : 3) - step, SHADE);
  r(2, -2 - step, 4, (seated ? 2 : 3) + step, BLUE);
  r(-10, -7 + (walking ? step : 0), 4, 5, BLUE); r(6, -7 - (walking ? step : 0), 4, 5, SHADE);

  if (back) {
    r(-7, -22, 14, 1, LIGHT); r(-4, -18, 8, 3, SHADE);
  } else {
    const shift = a.facing === 'left' || a.facing === 'up' ? -1 : a.facing === 'right' ? 1 : 0;
    r(-10, -24, 20, 14, SHADE); r(-9, -23, 18, 12, INK);
    const blink = (tick + Math.max(0, a.colorIndex || 0) * 9) % 57 >= 54;
    if (sleepy || blink) {
      r(-5, -17, 4, 1, CYAN); r(3, -17, 4, 1, CYAN);
    } else if (a.pose === 'alert') {
      r(-1, -20, 2, 4, CYAN); r(-1, -14, 2, 1, CYAN);
    } else {
      r(-6 + shift, -21, 3, 2, CYAN); r(-4 + shift, -19, 3, 2, CYAN); r(-6 + shift, -17, 3, 2, CYAN);
      if (a.pose !== 'type' || tick % 4 < 3) r(2 + shift, -16, 6, 2, CYAN);
    }
    r(-1, -6, 1, 1, CYAN); r(0, -5, 1, 1, CYAN); r(2, -4, 2, 1, CYAN);
  }
  if (accessory === 'headset') {
    r(-11, -27, 21, 2, '#343744'); r(-14, -23, 3, 9, '#343744'); r(11, -23, 3, 9, '#343744');
    r(-14, -20, 2, 5, accent); r(12, -20, 2, 5, accent); r(10, -14, 3, 1, '#343744');
  } else if (accessory === 'glasses' || accessory === 'round-glasses') {
    if (!back) {
      const inset = accessory === 'round-glasses' ? 1 : 0;
      for (const [x, w] of [[-9, 10], [1, 8]]) {
        r(x + inset, -23, w - inset * 2, 1, '#ded7bc'); r(x + inset, -12, w - inset * 2, 1, '#ded7bc');
        r(x, -22, 1, 10, '#ded7bc'); r(x + w - 1, -22, 1, 10, '#ded7bc');
      }
      r(0, -19, 2, 1, '#ded7bc');
    }
  } else if (accessory === 'cap') {
    r(-9, -30, 18, 4, accent); r(-6, -32, 12, 2, accent); r(6, -27, 8, 2, accent); r(-2, -29, 3, 2, '#eee5c6');
  } else if (accessory === 'beanie') {
    r(-10, -30, 20, 4, accent); r(-7, -33, 14, 3, accent); r(-2, -35, 4, 2, '#e9d5ac'); r(-10, -27, 20, 2, '#e0cdb1');
  } else if (accessory === 'bow') {
    r(3, -31, 4, 4, '#d88da7'); r(9, -31, 4, 4, '#d88da7'); r(7, -30, 2, 2, '#f0bdc8');
  }
  if (a.isLead) { r(-3, -40, 6, 2, '#e3b55c'); r(-1, -42, 2, 6, '#e3b55c'); }
  if (a.isPlayer) { r(-4, -40, 8, 2, '#6ca7a1'); r(-2, -42, 4, 2, '#8bc4ba'); }

  if (a.pose === 'type') {
    r(-8, -3, 17, 3, '#656568'); r(-6, -3, 13, 1, '#d4d0c5');
    r(-7, -6 + tick % 2, 4, 3, BLUE); r(3, -5 - tick % 2, 4, 3, LIGHT);
  }
  if (a.pose === 'read' || a.status === 'reporting') {
    ctx.save(); ctx.translate(0, tick % 2);
    r(9, -15, 9, 13, '#6c645b'); r(10, -16, 9, 12, '#fff3d9');
    for (let y = -13; y < -6; y += 3) r(12, y, 5, 1, '#8b9687');
    r(7, -8, 5, 3, BLUE); ctx.restore();
  }
  if (a.pose === 'run') {
    r(7, -12, 13, 10, '#363b3d'); r(8, -11, 11, 7, '#253f3d');
    r(10, -9, 2, 1, '#91c4a0'); r(12, -8, 2, 1, '#91c4a0');
    if (tick % 2) r(15, -6, 3, 1, '#e8d39c');
  }
  if (a.status === 'sharing') {
    ctx.save(); ctx.translate(0, tick % 2);
    r(9, -14, 14, 10, '#ac7838'); r(10, -13, 12, 8, '#eac06b'); r(13, -11, 6, 1, '#b68d4c');
    ctx.restore();
  }
  if (a.pose === 'talk') { r(9, tick % 2 ? -13 : -11, 3, 4, LIGHT); r(10, tick % 2 ? -15 : -13, 3, 3, LIGHT); }
  if (a.pose === 'alert') { r(18, -35 + tick % 2, 3, 6, '#b95447'); r(18, -27, 3, 2, '#b95447'); }
  if (a.heldItem || coffee) {
    const cup = a.heldItem || { color: '#fff4db', liquid: '#795b44', iced: false };
    const sip = coffee ? (tick % 6 < 3 ? 0 : -3) : 3;
    r(9, -9 + sip, 4, 3, BLUE);
    if (!drawDrinkImage(ctx, cup.id || 'americano', px(11), px(-20 + sip), px(16), px(17))) {
      r(11, -13 + sip, 7, 8, cup.color); r(12, -14 + sip, 5, 2, cup.liquid);
    }
    if (!cup.iced) { r(12 + tick % 2, -20 + sip, 1, 3, '#dfd5be'); r(15 - tick % 2, -24 + sip, 1, 3, '#dfd5be'); }
  }
  if (a.pose === 'brew') { r(9, -10, 7, 4, BLUE); r(16, -10, 5, 7, '#f0dec0'); r(17 + tick % 2, -17, 1, 3, '#e7dfcb'); }
  if (a.pose === 'play') {
    r(-9, -10, 20, 6, '#46576a'); r(-6, -9, 5, 1, '#d5d9bc'); r(-4, -11, 1, 5, '#d5d9bc');
    r(5, -9 + tick % 2, 2, 2, '#e1a17e'); r(8, -8 - tick % 2, 2, 2, '#b0d4b5');
  }
  if (a.pose === 'water') {
    r(10, -14, 10, 8, '#7daec1'); r(19, -12, 6, 2, '#7daec1'); r(10, -16, 6, 2, '#a8d0d8');
    for (let i = 0; i < 3; i++) r(24 + i * 2, -8 + (tick + i * 2) % 8, 1, 2, '#9fd9e7');
  }
  if (a.pose === 'stretch') {
    const lift = tick % 4 < 2 ? 0 : 2;
    r(-11, -16 + lift, 3, 12, BLUE); r(8, -16 + lift, 3, 12, BLUE);
    r(-11, -18 + lift, 6, 3, LIGHT); r(5, -18 + lift, 6, 3, LIGHT);
  }
  if (sleepy) { r(10, -29 - tick % 4, 3, 1, '#7b869b'); r(12, -28 - tick % 4, 1, 1, '#7b869b'); r(10, -27 - tick % 4, 3, 1, '#7b869b'); }
  ctx.restore();
}
