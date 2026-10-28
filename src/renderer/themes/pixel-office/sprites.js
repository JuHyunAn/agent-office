import { drawDrinkImage } from './drink-images.js';
import { drawCodexCharacter } from './codex-sprite.js';

const ORANGE = '#d77b57';
const SHADE = '#b85e43';
const INK = '#302f31';
const ACCENTS = ['#719c9b', '#ad8bb3', '#7f9c74', '#ca8274', '#d0aa64', '#7496b0', '#a2937e', '#8d93b8'];

// All coordinates are integer pixels. Each frame keeps the reference silhouette:
// one wide body, short side arms, two rectangular eyes, four short legs.
export function drawCharacter(ctx, a, t, x, y) {
  if (a.cli === 'codex') return drawCodexCharacter(ctx, a, t, x, y);
  const tick = Math.floor(t / 130);
  const phase = tick + Math.max(0, a.colorIndex) * 9;
  const walking = a.pose === 'walk';
  const seated = ['sit', 'type', 'read', 'run'].includes(a.pose);
  const resting = a.status === 'resting' || a.status === 'away';
  const coffee = a.action === 'drink' || a.pose === 'drink';
  const sleepy = resting && ['sit', 'stand'].includes(a.pose) && !a.heldItem;
  const bob = walking ? [0, -1, 0, 1][tick % 4] : a.pose === 'type' ? tick % 2 : 0;
  const accent = a.isLead ? '#d6ac5b' : ACCENTS[Math.max(0, a.colorIndex) % ACCENTS.length];
  const { hair = 'none', accessory = 'none', hairColor = '#493d3b' } = a.appearance || {};
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  const r = (px, py, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(px, py, w, h); };

  r(-10, -1, 20, 3, '#b8ae9c');
  r(-14, 0, 28, 1, '#c8bda9');
  ctx.translate(0, bob - (seated ? 7 : 0));
  const top = seated ? -19 : -22;
  const bottom = top + 16;
  for (const [i, lx] of [-8, -4, 4, 8].entries()) {
    const step = walking ? [[0, 2, 0, -1], [2, 0, -1, 0], [0, -1, 0, 2], [-1, 0, 2, 0]][tick % 4][i] : 0;
    r(lx, bottom, 2, (seated ? 3 : 6) + step, i < 2 ? SHADE : ORANGE);
  }
  r(-11, top, 22, 16, ORANGE);
  r(-11, top, 22, 1, '#ed9a73');
  r(a.facing === 'left' ? 8 : -11, top + 1, 3, 15, SHADE);
  r(-15, top + 8, 4, 4, ORANGE);
  r(11, top + 8, 4, 4, ORANGE);

  if (hair === 'crop') {
    r(-10, top - 3, 20, 4, hairColor); r(-10, top, 4, 3, hairColor);
    for (let i = 0; i < 4; i++) r(-8 + i * 5, top - 4 - i % 2, 3, 2, hairColor);
  } else if (hair === 'sidepart') {
    r(-11, top - 3, 22, 4, hairColor); r(-11, top, 5, 6, hairColor);
    r(-5, top, 7, 2, hairColor); r(7, top, 4, 3, hairColor);
  } else if (hair === 'curly') {
    for (let i = 0; i < 5; i++) { r(-12 + i * 5, top - 4 - i % 2, 5, 5, hairColor); r(-11 + i * 5, top - 5 - i % 2, 3, 1, hairColor); }
    r(-12, top, 3, 6, hairColor); r(10, top, 3, 4, hairColor);
  } else if (hair === 'spiky') {
    r(-10, top - 2, 20, 3, hairColor);
    for (let i = 0; i < 4; i++) r(-8 + i * 5, top - 6 + i % 2, 3, 5, hairColor);
  } else if (hair === 'bun') {
    r(-10, top - 2, 20, 3, hairColor); r(6, top - 7, 7, 5, hairColor); r(8, top - 8, 3, 1, hairColor);
    r(-10, top + 1, 3, 6, hairColor); r(8, top - 3, 4, 2, accent);
  }
  if (accessory === 'headset') {
    r(-11, top - 4, 22, 2, INK); r(-13, top - 2, 3, 8, INK); r(10, top - 2, 3, 8, INK);
    r(-15, top + 4, 5, 8, INK); r(10, top + 4, 5, 8, INK);
    r(-14, top + 5, 2, 5, accent); r(12, top + 5, 2, 5, accent);
    r(12, top + 11, 1, 4, INK); r(7, top + 14, 6, 1, INK);
  } else if (accessory === 'cap') {
    r(-10, top - 5, 20, 5, accent); r(-7, top - 7, 14, 2, accent); r(6, top - 1, 10, 2, accent);
    r(-3, top - 4, 4, 2, '#eee5c6');
  } else if (accessory === 'beanie') {
    r(-11, top - 4, 22, 5, accent); r(-8, top - 7, 16, 3, accent); r(-2, top - 10, 4, 3, '#e9d5ac');
    r(-11, top, 22, 2, '#e0cdb1');
  } else if (accessory === 'bow') {
    r(4, top - 4, 4, 4, '#d88da7'); r(10, top - 4, 4, 4, '#d88da7'); r(8, top - 3, 2, 2, '#f0bdc8');
  }

  if (a.facing !== 'up') {
    const shift = a.facing === 'left' ? -2 : a.facing === 'right' ? 2 : 0;
    const blink = phase % 57 >= 54;
    const focus = a.pose === 'type' || a.pose === 'run' || a.pose === 'read';
    for (const ex of [-6, 5]) {
      if (sleepy || blink) r(ex + shift - 1, top + 8, 4, 1, INK);
      else if (coffee || a.pose === 'talk') {
        r(ex + shift - 1, top + 7, 4, 1, INK);
        r(ex + shift - 1, top + 8, 1, 1, INK);
        r(ex + shift + 2, top + 8, 1, 1, INK);
      } else r(ex + shift, top + (focus ? 7 : 6), 2, focus ? 3 : 5, INK);
    }
    if (accessory === 'glasses' || accessory === 'round-glasses') {
      const inset = accessory === 'round-glasses' ? 1 : 0;
      for (const ex of [-8, 3]) {
        r(ex + shift + inset, top + 5, 7 - inset * 2, 1, INK); r(ex + shift + inset, top + 11, 7 - inset * 2, 1, INK);
        r(ex + shift, top + 6, 1, 5, INK); r(ex + shift + 6, top + 6, 1, 5, INK);
      }
      r(-2 + shift, top + 7, 6, 1, INK);
    }
    if (a.pose === 'talk') r(0, top + 12, 3, tick % 2 ? 2 : 1, INK);
  } else {
    r(-5, top + 4, 10, 2, '#c86f50');
  }
  if (a.isLead) { r(-3, top - 14, 6, 2, '#e3b55c'); r(-1, top - 16, 2, 6, '#e3b55c'); }
  if (a.isPlayer) { r(-4, top - 14, 8, 2, '#6ca7a1'); r(-2, top - 16, 4, 2, '#8bc4ba'); }

  if (a.pose === 'type') {
    r(-11, -4, 20, 3, '#656568'); r(-9, -4, 15, 1, '#d4d0c5');
    r(-9, -7 + tick % 2, 5, 3, ORANGE); r(3, -6 - tick % 2, 5, 3, ORANGE);
  }
  if (a.pose === 'read' || a.status === 'reporting') {
    ctx.save(); ctx.translate(0, tick % 2);
    r(9, -15, 9, 13, '#6c645b'); r(10, -16, 9, 12, '#fff3d9');
    for (let py = -13; py < -6; py += 3) r(12, py, 5, 1, '#8b9687');
    r(7, -8, 5, 3, ORANGE);
    ctx.restore();
  }
  if (a.pose === 'run') {
    r(7, -12, 13, 10, '#363b3d'); r(8, -11, 11, 7, '#253f3d');
    r(10, -9, 2, 1, '#91c4a0'); r(12, -8, 2, 1, '#91c4a0');
    if (tick % 2) r(15, -6, 3, 1, '#e8d39c');
  }
  if (a.status === 'sharing') {
    ctx.save(); ctx.translate(0, tick % 2);
    r(9, -14, 14, 10, '#ac7838'); r(10, -13, 12, 8, '#eac06b');
    r(11, -12, 2, 2, '#b68d4c'); r(13, -10, 2, 2, '#b68d4c');
    r(15, -8, 2, 1, '#b68d4c'); r(17, -10, 2, 2, '#b68d4c'); r(19, -12, 2, 2, '#b68d4c');
    ctx.restore();
  }
  if (a.pose === 'talk') r(13, top + (tick % 2 ? 2 : 5), 5, 3, ORANGE);
  if (a.pose === 'alert') {
    r(18, top - 8 + tick % 2, 3, 6, '#b95447'); r(18, top, 3, 2, '#b95447');
    r(-17, top + 3, 3, 6, ORANGE);
  }
  if (a.heldItem || coffee) {
    const cup = a.heldItem || { color: '#fff4db', liquid: '#795b44', iced: false };
    const sip = coffee ? (tick % 6 < 3 ? 0 : -3) : 3;
    r(9, -9 + sip, 4, 3, ORANGE);
    if (!drawDrinkImage(ctx, cup.id || 'americano', 11, -20 + sip)) {
      r(11, -13 + sip, 7, 8, cup.color); r(12, -14 + sip, 5, 2, cup.liquid);
    }
    if (!cup.iced) {
      r(12 + tick % 2, -20 + sip, 1, 3, '#dfd5be'); r(15 - tick % 2, -24 + sip, 1, 3, '#dfd5be');
    }
  }
  if (a.pose === 'brew') {
    r(11, -11, 7, 4, ORANGE); r(18, -11, 5, 7, '#f0dec0');
    r(19 + tick % 2, -18, 1, 3, '#e7dfcb');
  }
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
    r(-15, top - 3 + lift, 3, 12, ORANGE); r(12, top - 3 + lift, 3, 12, ORANGE);
    r(-15, top - 5 + lift, 7, 3, ORANGE); r(8, top - 5 + lift, 7, 3, ORANGE);
  }
  if (sleepy) { ctx.fillStyle = '#8b8e83'; ctx.font = '7px monospace'; ctx.fillText('z', 16, top - tick % 4); }
  ctx.restore();
}
