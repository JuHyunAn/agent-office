import { polygon, line } from '../pixel-office/raster.js';
import { MATERIALS, isFloor, isWall, ROLES } from './catalog.js';
import { footprint, localPoint, onFloor } from './model.js';
import { drawSimpleWindow, drawSimpleWindowWeather } from '../pixel-office/simple-windows.js';
import { drawCharacter } from '../pixel-office/sprites.js';
import { resolveEnvironment } from './environment.js';

const shade = (hex, delta) => '#' + hex.slice(1).match(/../g).map(v => Math.max(0, Math.min(255, parseInt(v, 16) + delta)).toString(16).padStart(2, '0')).join('');
export function createArt() {
  let origin = { x: 800, y: 150 }, bounds = { width: 1600, height: 1000 }, revision = null, floorCanvas, sunsetCanvas;
  const cache = new Map();
  const project = (x, y, z = 0) => ({ x: Math.round((origin.x + (x - y) * .36) * 2) / 2, y: Math.round((origin.y + (x + y) * .18 - z) * 2) / 2 });
  const plane = (c, item, x, y, w, d, z, color) => polygon(c, [[x, y], [x + w, y], [x + w, y + d], [x, y + d]].map(([u, v]) => { const p = localPoint(item, u, v); return project(p.x, p.y, z); }), color);
  function box(c, item, x, y, w, d, z, h, color) {
    const corners = [[x, y], [x + w, y + d]].map(([u, v]) => localPoint(item, u, v));
    const x0 = Math.min(...corners.map(p => p.x)), x1 = Math.max(...corners.map(p => p.x)), y0 = Math.min(...corners.map(p => p.y)), y1 = Math.max(...corners.map(p => p.y));
    polygon(c, [project(x0, y1, z), project(x1, y1, z), project(x1, y1, z + h), project(x0, y1, z + h)], shade(color, -24));
    polygon(c, [project(x1, y1, z), project(x1, y0, z), project(x1, y0, z + h), project(x1, y1, z + h)], shade(color, -42));
    polygon(c, [project(x0, y0, z + h), project(x1, y0, z + h), project(x1, y1, z + h), project(x0, y1, z + h)], color);
  }
  function face(c, item, x, y, w, z, h, color) {
    const a = localPoint(item, x, y), b = localPoint(item, x + w, y);
    polygon(c, [project(a.x, a.y, z), project(b.x, b.y, z), project(b.x, b.y, z + h), project(a.x, a.y, z + h)], color);
  }
  function plant(c, i) {
    box(c, i, 12, 12, 24, 24, 0, 20, '#c99f83');
    box(c, i, 9, 9, 30, 30, 18, 4, '#e4c39c');
    box(c, i, 23, 23, 3, 3, 20, 40, '#697d51');
    for (let n = 0; n < 6; n++) box(c, i, 4 + n % 3 * 10, 6 + n % 2 * 18, 16, 12, 28 + n * 5, 9, ['#77986b', '#91b37e', '#aac58b'][n % 3]);
  }
  function item(c, i, t = 0, env = {}, amount = 0, precipitation = true) {
    const m = MATERIALS[i.kind], { w, d } = m;
    if (isFloor(i)) {
      box(c, i, 0, 0, w, d, -12, 12, m.color);
      for (let k = 24; k < w; k += i.kind === 'floor-wood' ? 24 : 96) plane(c, i, k, 0, 1, d, .5, shade(m.color, -12));
      plane(c, i, 0, d - 1, w, 1, .5, shade(m.color, -10)); return;
    }
    if (isWall(i)) {
      if (!i.kind.startsWith('window') && i.kind !== 'door') { box(c, i, 0, 0, w, d, 0, m.h, m.color); box(c, i, 0, 0, w, d + 2, m.h, 3, '#e8e2cc'); return; }
      box(c, i, 0, 0, 12, d, 0, 118, m.color); box(c, i, w - 12, 0, 12, d, 0, 118, m.color);
      box(c, i, 0, 0, w, d, 108, 10, m.color);
      if (i.kind === 'door') {
        const visible = 84 * (1 - amount);
        face(c, i, 12, 7, 168, 0, 108, '#495c66');
        for (const x of [12, 180 - visible]) {
          box(c, i, x, 8, visible, 4, 1, 104, '#9eaaa9');
          if (visible > 8) face(c, i, x + 4, 13, visible - 8, 22, 68, '#b0d3d5');
        }
        box(c, i, 78, 13, 36, 2, 111, 4, amount ? '#b8e3aa' : '#e9cb93');
      } else {
        box(c, i, 0, 0, w, d + 4, 0, 14, m.color);
        const pane = { x: 12, y: 12, w: w - 24, bottom: 15, top: 107 };
        const projected = (x, y, z) => { const p = localPoint(i, x, y); return project(p.x, p.y, z); };
        // 풍경은 창 방향에 맞춰 같은 픽셀 원본을 매핑한다.
        const a = projected(12, 12, 107), b = projected(w - 12, 12, 107), width = (w - 24) * .36;
        c.save();
        polygon(c, [a, b, { x: b.x, y: b.y + 92 }, { x: a.x, y: a.y + 92 }], '#82acc1');
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.lineTo(b.x, b.y + 92); c.lineTo(a.x, a.y + 92); c.closePath(); c.clip();
        const sign = b.x > a.x ? 1 : -1, slope = (b.y - a.y) / width;
        c.transform(sign, slope - .5, 0, 1, a.x, a.y);
        const zeroProject = () => ({ x: 0, y: 0 });
        drawSimpleWindow(c, pane, zeroProject, env);
        if (precipitation) drawSimpleWindowWeather(c, pane, zeroProject, t, env);
        c.restore();
        face(c, i, 12, 13, w - 24, 15, 92, env.sunset ? '#ffe0aa2c' : '#d7eff018');
        for (const x of i.kind === 'window-grid' ? [48, 96, 144] : [96]) box(c, i, x, 13, 3, 2, 15, 92, '#e7dfca');
        if (i.kind === 'window-grid') face(c, i, 12, 14, 168, 59, 3, '#e7dfca');
        if (i.kind === 'window-round') for (let n = 0; n < 4; n++) for (const x of [12 + n * 6, 174 - n * 6]) face(c, i, x, 14, 6, 83 + n * 6, 24 - n * 6, m.color);
        face(c, i, 26, 15, 3, 22, 78, env.sunset ? '#fff0c77a' : '#ffffff55');
      }
      return;
    }
    if (i.kind === 'plant') { plant(c, i); return; }
    if (['rug', 'mat', 'entry'].includes(i.kind)) {
      plane(c, i, 0, 0, w, d, 1, m.color); plane(c, i, 5, 5, w - 10, d - 10, 1.5, shade(m.color, 15));
      if (i.kind === 'entry') { plane(c, i, 20, 10, 8, 28, 2, '#fff1ca'); plane(c, i, 12, 12, 24, 6, 2, '#fff1ca'); }
      else for (let x = 12; x < w; x += 24) plane(c, i, x, 9, 2, d - 18, 2, '#ead9c366'); return;
    }
    if (i.kind === 'lamp') {
      box(c, i, 7, 7, 34, 34, 0, 4, '#6d7a79'); box(c, i, 22, 22, 4, 4, 4, 72, '#879c94');
      box(c, i, 3, 3, 42, 42, 76, 14, '#e0c88d'); return;
    }
    if (i.kind === 'sofa' || i.kind === 'chair') {
      box(c, i, 4, 4, w - 8, d - 8, 3, 16, m.color); box(c, i, 0, 0, w, 12, 16, 24, shade(m.color, 8));
      for (const x of [0, w - 10]) box(c, i, x, 10, 10, d - 10, 16, 12, shade(m.color, 12));
      for (let x = 14; x < w - 12; x += 40) box(c, i, x, 16, Math.min(36, w - 14 - x), d - 22, 18, 4, shade(m.color, 28)); return;
    }
    if (i.kind === 'bookshelf') {
      box(c, i, 0, 0, w, d, 0, 64, m.color);
      for (const z of [6, 31]) { face(c, i, 5, d + 1, w - 10, z, 23, '#6d6255');
        for (let n = 0; n < 9; n++) box(c, i, 8 + n * 9, d - 7, 6, 10, z + 2, 12 + n % 3 * 3, ['#8cb2a2', '#d9ba82', '#b68fa1'][n % 3]); } return;
    }
    if (i.kind === 'desk' || i.kind === 'round-table') {
      for (const x of [8, w - 20]) box(c, i, x, 8, 12, d - 16, 0, 27, '#9b8975');
      box(c, i, 0, 0, w, d, 27, 5, m.color);
      plane(c, i, 8, 8, w - 16, d - 16, 32.5, i.kind === 'desk' ? '#759b9b' : '#dfd4b5');
      if (i.kind === 'desk') {
        box(c, i, 55, 18, 6, 6, 33, 12, '#536e78'); box(c, i, 32, 15, 64, 5, 42, 33, '#435d6d');
        face(c, i, 36, 21, 56, 46, 25, '#98d0d0'); face(c, i, 42, 22, 30, 63, 2, '#e2eac6'); face(c, i, 42, 22, 42, 56, 2, '#c1dfb5');
        plane(c, i, 38, 42, 55, 16, 33, '#e4d4b6');
        box(c, i, 117, 13, 4, 4, 33, 27, '#647e77'); box(c, i, 106, 7, 26, 16, 60, 6, '#e3cb8f');
        plane(c, i, 9, 28, 22, 31, 33, '#f7e6c8');
      } else {
        for (const [x, y] of [[20, 22], [85, 60], [30, 70]]) plane(c, i, x, y, 25, 28, 33, '#f8e9cb');
        box(c, i, 66, 45, 12, 12, 33, 10, '#ae8ca5');
      } return;
    }
    box(c, i, 0, 0, w, d, 0, i.kind === 'coffee' ? 29 : m.h, m.color);
    if (i.kind === 'coffee') {
      box(c, i, 10, 10, 52, 38, 29, 33, '#53666b'); face(c, i, 17, 49, 36, 35, 20, '#334950');
      face(c, i, 23, 50, 24, 49, 3, '#e1bd87'); box(c, i, 29, 47, 11, 11, 30, 10, '#f6e4c4');
      for (let n = 0; n < 3; n++) box(c, i, 73, 10 + n * 17, 12, 12, 29, 10, ['#f0d7af', '#cba1b5', '#99c5c2'][n]);
    } else {
      face(c, i, 7, d + 1, w - 14, 26, m.h - 34, '#344e66');
      if (i.kind === 'vending') for (let n = 0; n < 12; n++) face(c, i, 12 + n % 4 * 13, d + 2, 8, 32 + Math.floor(n / 4) * 17, 11, ['#d7ac6e', '#84b5ae', '#c58da5'][n % 3]);
      else { face(c, i, 12, d + 2, w - 24, 37, 29, '#89bfb4'); face(c, i, 28, d + 3, 10, 45, 10, '#f4d98d'); }
      face(c, i, 18, d + 2, w - 36, 10, 6, '#5a545a');
    }
  }
  function setDocument(doc) {
    if (revision === doc) return;
    revision = doc; cache.clear();
    const floors = doc.items.filter(isFloor), ext = floors.length ? floors : [{ x: 192, y: 192 }];
    const minX = Math.min(...ext.map(i => i.x)), maxX = Math.max(...ext.map(i => i.x + 192)), minY = Math.min(...ext.map(i => i.y)), maxY = Math.max(...ext.map(i => i.y + 192));
    origin = { x: 100 - (minX - maxY) * .36, y: 155 - (minX + minY) * .18 };
    bounds = { width: (maxX - minX + maxY - minY) * .36 + 200, height: (maxX - minX + maxY - minY) * .18 + 255 };
    floorCanvas = sunsetCanvas = null;
  }
  function paintCached(c, i, env) {
    const cloudy = ['rain', 'snow', 'fog', 'cloudy'].includes(env.condition);
    const key = `${i.id}:${!!env.citypop}:${!!env.sunset}` + (i.kind.startsWith('window') ? `:${!!env.night}:${cloudy}` : env.sunset ? `:${cloudy}` : '');
    let image = cache.get(key);
    if (!image) {
      const f = footprint(i), p = project(i.x + f.w / 2, i.y + f.h / 2);
      const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 360;
      const b = canvas.getContext('2d'); b.setTransform(2, 0, 0, 2, 200 - p.x * 2, 290 - p.y * 2);
      item(b, i, 0, env, 0, false);
      if (env.sunset && !i.kind.startsWith('window')) { b.save(); b.setTransform(1, 0, 0, 1, 0, 0); b.globalCompositeOperation = 'source-atop'; b.fillStyle = cloudy ? '#efb57910' : '#efb57926'; b.fillRect(0, 0, canvas.width, canvas.height); b.restore(); }
      if (env.citypop) { b.save(); b.setTransform(1, 0, 0, 1, 0, 0); b.globalCompositeOperation = 'source-atop'; b.fillStyle = i.kind.startsWith('window') ? '#a458d44d' : '#a96bdd23'; b.fillRect(0, 0, canvas.width, canvas.height); b.restore(); }
      image = { canvas, x: p.x - 100, y: p.y - 145 }; cache.set(key, image);
    }
    c.drawImage(image.canvas, image.x, image.y, 200, 180);
  }
  function windowWeather(c, i, t, env) {
    if (!['rain', 'snow'].includes(env.condition)) return;
    const a0 = localPoint(i, 12, 12), b0 = localPoint(i, 180, 12), a = project(a0.x, a0.y, 107), b = project(b0.x, b0.y, 107), width = 168 * .36;
    c.save(); c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.lineTo(b.x, b.y + 92); c.lineTo(a.x, a.y + 92); c.closePath(); c.clip();
    c.transform(b.x > a.x ? 1 : -1, (b.y - a.y) / width - .5, 0, 1, a.x, a.y);
    drawSimpleWindowWeather(c, { w: 168, top: 107, bottom: 15 }, () => ({ x: 0, y: 0 }), t, env);
    c.restore();
  }
  function outline(c, i, color) {
    const f = footprint(i), pts = [[f.x, f.y], [f.x + f.w, f.y], [f.x + f.w, f.y + f.h], [f.x, f.y + f.h]].map(([x, y]) => project(x, y, 2));
    polygon(c, pts, color + '35'); for (let n = 0; n < 4; n++) line(c, pts[n], pts[(n + 1) % 4], color);
  }
  function sunsetFloor(doc) {
    if (sunsetCanvas) return sunsetCanvas;
    sunsetCanvas = document.createElement('canvas'); sunsetCanvas.width = floorCanvas.width; sunsetCanvas.height = floorCanvas.height;
    const c = sunsetCanvas.getContext('2d'); c.scale(2, 2);
    for (const floor of doc.items.filter(isFloor)) plane(c, floor, 0, 0, 192, 192, 1, '#eda87228');
    for (const window of doc.items.filter(i => i.kind.startsWith('window'))) {
      const direction = onFloor(doc, localPoint(window, 96, 72)) ? 1 : -1;
      const point = (u, v) => { const p = localPoint(window, u, v * direction); return project(p.x, p.y, 1); };
      const a = point(96, 18), b = point(56, 500), gradient = c.createLinearGradient(a.x, a.y, b.x, b.y);
      gradient.addColorStop(0, '#ffd18d70'); gradient.addColorStop(.5, '#ffc18630'); gradient.addColorStop(1, '#ffc18600');
      for (let n = 0; n < 3; n++) { const u = 12 + n * 56; polygon(c, [point(u, 18), point(u + 48, 18), point(u + 8, 500), point(u - 40, 500)], gradient); }
    }
    c.globalCompositeOperation = 'destination-in'; c.drawImage(floorCanvas, 0, 0, bounds.width, bounds.height);
    return sunsetCanvas;
  }
  return {
    project, setDocument, item, outline,
    get viewport() { return { width: Math.ceil(bounds.width * 2), height: Math.ceil(bounds.height * 2) }; },
    unproject(x, y) { const dx = (x / 2 - origin.x) / .36, dy = (y / 2 - origin.y) / .18; return { x: (dx + dy) / 2, y: (dy - dx) / 2 }; },
    hit(doc, x, y, floors = false) {
      return [...doc.items].filter(i => floors || !isFloor(i)).sort((a, b) => b.x + b.y - a.x - a.y).find(i => {
        const f = footprint(i), z = MATERIALS[i.kind].h || 0;
        const p = [[f.x, f.y], [f.x + f.w, f.y], [f.x + f.w, f.y + f.h], [f.x, f.y + f.h]].map(([u, v]) => project(u, v));
        // 높이까지 검사하되 옆 빈 공간은 선택하지 않도록 다각형 내부를 판정한다.
        const shapes = [p, p.map(v => ({ x: v.x, y: v.y - z })), [p[2], p[1], { x: p[1].x, y: p[1].y - z }, { x: p[2].x, y: p[2].y - z }], [p[3], p[2], { x: p[2].x, y: p[2].y - z }, { x: p[3].x, y: p[3].y - z }]];
        return shapes.some(poly => { let inside = false; for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) if ((poly[a].y > y / 2) !== (poly[b].y > y / 2) && x / 2 < (poly[b].x - poly[a].x) * (y / 2 - poly[a].y) / (poly[b].y - poly[a].y) + poly[a].x) inside = !inside; return inside; });
      });
    },
    draw(c, doc, agents, t, state, editor, background) {
      setDocument(doc); const env = resolveEnvironment(doc, state.environment);
      c.save(); c.scale(2, 2); c.imageSmoothingEnabled = false;
      if (!state.backdropDrawn) {
        c.fillStyle = env.citypop ? env.night ? '#29223f' : '#e9e1ed' : env.night ? '#293342' : env.sunset ? '#f8eddd' : '#e9eee7'; c.fillRect(0, 0, bounds.width, bounds.height);
        if (background) { const scale = Math.max(bounds.width / background.width, bounds.height / background.height); c.drawImage(background, (bounds.width - background.width * scale) / 2, (bounds.height - background.height * scale) / 2, background.width * scale, background.height * scale); }
      }
      if (!floorCanvas) {
        floorCanvas = document.createElement('canvas'); floorCanvas.width = Math.ceil(bounds.width * 2); floorCanvas.height = Math.ceil(bounds.height * 2);
        const f = floorCanvas.getContext('2d'); f.scale(2, 2);
        for (const i of doc.items.filter(isFloor).sort((a, b) => a.x + a.y - b.x - b.y)) item(f, i);
        for (const i of doc.items.filter(i => ['rug', 'mat', 'entry'].includes(i.kind))) item(f, i);
      }
      c.drawImage(floorCanvas, 0, 0, bounds.width, bounds.height);
      if (env.sunset) { c.save(); c.globalAlpha = ['rain', 'snow', 'fog', 'cloudy'].includes(env.condition) ? .45 : 1; c.drawImage(sunsetFloor(doc), 0, 0, bounds.width, bounds.height); c.restore(); }
      if (env.night || env.citypop) {
        for (const i of doc.items.filter(isFloor)) plane(c, i, 0, 0, 192, 192, 1, env.citypop ? env.night ? '#35205780' : '#9467b12b' : '#14234065');
        const lights = doc.items.filter(i => ['lamp', 'desk'].includes(i.kind));
        for (const [index, i] of lights.entries()) {
          const f = footprint(i), p = project(i.x + f.w / 2, i.y + f.h / 2);
          const color = env.citypop ? index % 2 ? '#78d9f3' : '#e997ee' : '#ffe4a8';
          c.save(); c.translate(p.x, p.y); c.scale(1, .5); const g = c.createRadialGradient(0, 0, 2, 0, 0, 80); g.addColorStop(0, color + (env.citypop ? 'b0' : '6b')); g.addColorStop(1, color + '00'); c.fillStyle = g; c.fillRect(-80, -80, 160, 160); c.restore();
        }
      }
      const elements = doc.items.filter(i => !isFloor(i) && !['rug', 'mat', 'entry'].includes(i.kind)).map(i => ({ depth: i.x + i.y + (isWall(i) ? 0 : (footprint(i).w + footprint(i).h) / 2), draw() {
        if (i.kind === 'door') item(c, i, t, env, state.doors?.find(d => d.id === i.id)?.amount || 0);
        else { paintCached(c, i, env); if (i.kind.startsWith('window')) windowWeather(c, i, t, env); }
      } }));
      for (const a of agents) elements.push({ depth: a.x + a.y, draw() { const p = project(a.x, a.y); c.save(); c.translate(p.x, p.y); c.scale(1.25, 1.25); drawCharacter(c, a, t, 0, 0); c.restore(); } });
      elements.sort((a, b) => a.depth - b.depth).forEach(e => e.draw());
      if (env.citypop) {
        for (const i of doc.items.filter(i => i.kind.startsWith('window'))) { face(c, i, 12, 15, 168, 16, 2, '#db8ff1b0'); face(c, i, 12, 15, 168, 104, 1, '#83d5ed90'); }
        for (const i of doc.items.filter(i => i.kind === 'lamp' || i.kind === 'desk')) {
          const local = i.kind === 'desk' ? localPoint(i, 119, 15) : localPoint(i, 24, 24), p = project(local.x, local.y, i.kind === 'desk' ? 62 : 83);
          c.save(); const glow = c.createRadialGradient(p.x, p.y, 1, p.x, p.y, 18); glow.addColorStop(0, '#ffe0fa9e'); glow.addColorStop(1, '#d592f000'); c.fillStyle = glow; c.fillRect(p.x - 18, p.y - 18, 36, 36); c.restore();
        }
      }
      for (const i of doc.items.filter(i => i.kind === 'desk' || (isFloor(i) && i.name))) {
        const f = footprint(i), floor = isFloor(i), p = project(i.x + f.w / 2, i.y + f.h / 2, floor ? 4 : 84);
        const text = i.name || ROLES[i.role || 'dev']; c.font = `${floor ? 12 : 10}px "Malgun Gothic"`; c.textAlign = 'center';
        const width = c.measureText(text).width + 14;
        c.fillStyle = env.night ? '#303548e8' : '#fff7e8ed'; c.beginPath(); c.roundRect(p.x - width / 2, p.y - 12, width, 19, 4); c.fill();
        c.fillStyle = env.night ? '#f5e0cd' : '#405d60'; c.fillText(text, p.x, p.y + 1);
      }
      for (const a of agents) {
        const p = project(a.x, a.y); c.textAlign = 'center'; c.font = '9px "Malgun Gothic"'; c.fillStyle = '#fff8e9'; c.fillRect(p.x - 26, p.y + 5, 52, 14); c.fillStyle = '#4e686b'; c.fillText(a.isPlayer ? '나' : a.label.slice(0, 10), p.x, p.y + 15);
        if (a.bubble) { const words = a.bubble.text.split('\n').slice(0, 2).map(v => v.slice(0, 22)); const w = Math.max(...words.map(v => c.measureText(v).width)) + 16; c.fillStyle = '#fff9e9f5'; c.beginPath(); c.roundRect(p.x - w / 2, p.y - 62 - words.length * 12, w, words.length * 12 + 12, 6); c.fill(); c.fillStyle = '#53696b'; words.forEach((s, n) => c.fillText(s, p.x, p.y - 49 - (words.length - n) * 12)); }
      }
      if (editor?.editing) {
        for (const error of editor.errors || []) { const i = doc.items.find(i => i.id === error.id); if (i) outline(c, i, '#da6858'); }
        const selected = doc.items.find(i => i.id === editor.selected); if (selected) outline(c, selected, '#e9ae4e');
        if (editor.ghost) { c.globalAlpha = .62; item(c, editor.ghost, t, env); c.globalAlpha = 1; outline(c, editor.ghost, editor.ghostError ? '#d35c55' : '#4eac91'); }
      }
      c.restore();
    },
  };
}
