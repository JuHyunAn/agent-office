import layout from './layout.js';
import { drawSimpleWindow, drawSimpleWindowWeather } from './simple-windows.js';

// 후면 통창은 모든 픽셀 테마가 공유하고 왼쪽 외벽은 창문 없는 벽으로 둔다.
export const WINDOWS = ['analysis', 'planning', 'lead', 'skills'].map(key => {
  const r = layout.rooms[key];
  return { axis: 'x', x: r.x + 24, y: 63, w: r.w - 48, bottom: 16, top: 132 };
});

export function windowPoints(pane, project) {
  const x2 = pane.x + (pane.axis === 'x' ? pane.w : 0), y2 = pane.y + (pane.axis === 'y' ? pane.w : 0);
  return [project(pane.x, pane.y, pane.bottom), project(x2, y2, pane.bottom), project(x2, y2, pane.top), project(pane.x, pane.y, pane.top)];
}

function trace(ctx, points) {
  ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
}
export const DESK_LIGHTS = layout.workTables.flatMap(table => table.seats.map(s => ({ x: s.x - 40, y: s.y + 54,
  surface: { x: table.x, y: table.y, w: table.w, d: table.d, z: 23 } })));
DESK_LIGHTS.push({ x: 432, y: 1510, surface: { x: 408, y: 1488, w: 204, d: 84, z: 24 } });
const ROOM_LIGHTS = [
  { x: 1390, y: 758, color: '255,205,135' },
  { x: 1265, y: 940, color: '255,200,128' }, { x: 1440, y: 1110, color: '255,200,128' },
  { x: 1720, y: 800, color: '255,209,144' }, { x: 1860, y: 1040, color: '255,209,144' },
  { x: 1900, y: 1515, color: '180,225,255' }, { x: 1870, y: 1670, color: '180,225,255' },
  { x: 235, y: 1665, color: '255,202,153' },
];

function surfacePath(ctx, project, s) {
  const points = [project(s.x, s.y, s.z), project(s.x + s.w, s.y, s.z),
    project(s.x + s.w, s.y + s.d, s.z), project(s.x, s.y + s.d, s.z)];
  ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
}

function glow(ctx, x, y, rx, ry, rgb, strength) {
  ctx.save(); ctx.translate(x, y); ctx.scale(rx, ry);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, `rgba(${rgb},${strength})`);
  g.addColorStop(0.35, `rgba(${rgb},${strength * 0.65})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g; ctx.fillRect(-1, -1, 2, 2); ctx.restore();
}

export function createAtmosphere({ width, height, detail, project }) {
  let shade, warmLights, sunlight, sunsetLight, floorShadows, overcast;
  let simpleView = null; // 지금 날씨의 창밖 풍경 하나만 둔다 (조합마다 쌓지 않는다)
  const layer = draw => {
    const canvas = document.createElement('canvas'); canvas.width = width * detail; canvas.height = height * detail;
    const ctx = canvas.getContext('2d'); ctx.scale(detail, detail); draw(ctx); return canvas;
  };
  return {
    load(interior) {
      const mask = layer(ctx => {
        ctx.drawImage(interior, 0, 0, width, height);
        ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = '#000';
        for (const pane of WINDOWS) { trace(ctx, windowPoints(pane, project)); ctx.fill(); }
      });
      floorShadows = layer(ctx => {
        for (const r of Object.values(layout.rooms)) {
          const edge = { x: r.x + 4, y: r.y + 4, w: r.w - 8, d: 36, z: 1 };
          surfacePath(ctx, project, edge); ctx.fillStyle = '#263b4524'; ctx.fill();
        }
        for (const lamp of DESK_LIGHTS) {
          const s = lamp.surface, p = project(s.x + s.w / 2 + 15, s.y + s.d / 2 + 22);
          glow(ctx, p.x, p.y, 48, 18, '27,43,48', 0.32);
        }
        ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(mask, 0, 0, width, height);
      });
      sunlight = layer(ctx => {
        for (const pane of WINDOWS) {
          ctx.save();
          const side = pane.axis === 'y';
          const r = { x: pane.x + (side ? 5 : 0), y: pane.y + (side ? 0 : 5), w: side ? 240 : pane.w, d: side ? pane.w : 240, z: 1 };
          surfacePath(ctx, project, r); ctx.clip();
          const p = project(pane.x + (side ? 65 : pane.w / 2), pane.y + (side ? pane.w / 2 : 65));
          glow(ctx, p.x, p.y, 120, 65, '255,233,164', 0.26);
          ctx.restore();
        }
        ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(mask, 0, 0, width, height);
      });
      sunsetLight = layer(ctx => {
        ctx.fillStyle = '#e49b721b'; ctx.fillRect(0, 0, width, height);
        for (const pane of WINDOWS) {
          const near = project(pane.x + pane.w / 2, pane.y + 24), far = project(pane.x + pane.w / 2 - 110, pane.y + 660);
          const light = ctx.createLinearGradient(near.x, near.y, far.x, far.y);
          light.addColorStop(0, '#ffc46e8c'); light.addColorStop(.55, '#ffc48938'); light.addColorStop(1, '#ffc48900');
          for (let n = 0; n < 4; n++) {
            const x = pane.x + pane.w * n / 4, w = pane.w / 4 - 12;
            trace(ctx, [project(x, pane.y + 18, 2), project(x + w, pane.y + 18, 2), project(x + w - 110, pane.y + 660, 2), project(x - 110, pane.y + 660, 2)]);
            ctx.fillStyle = light; ctx.fill();
          }
          glow(ctx, near.x, near.y, pane.w * .45, 100, '255,189,105', .17);
        }
        for (const lamp of DESK_LIGHTS) {
          const p = project(lamp.x + 36, lamp.y + 14, 23);
          glow(ctx, p.x, p.y, 55, 24, '255,201,136', .12);
        }
        ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(mask, 0, 0, width, height);
      });
      shade = layer(ctx => {
        ctx.fillStyle = 'rgba(10,19,43,0.58)'; ctx.fillRect(0, 0, width, height);
        ctx.globalCompositeOperation = 'destination-out';
        for (const lamp of DESK_LIGHTS) {
          const p = project(lamp.x + 35, lamp.y + 12, 20);
          glow(ctx, p.x, p.y, 65, 44, '0,0,0', 0.85);
        }
        for (const lamp of ROOM_LIGHTS) {
          const p = project(lamp.x, lamp.y, 10);
          glow(ctx, p.x, p.y, 105, 72, '0,0,0', 0.62);
        }
      });
      warmLights = layer(ctx => {
        for (const lamp of DESK_LIGHTS) {
          const p = project(lamp.x, lamp.y, 48), focus = project(lamp.x + 38, lamp.y + 8, 23);
          ctx.save(); surfacePath(ctx, project, lamp.surface); ctx.clip();
          glow(ctx, focus.x, focus.y, 47, 26, '255,204,116', 0.40);
          // The lamp base casts a short shadow across its own lit tabletop.
          ctx.fillStyle = '#513d3b3b'; ctx.beginPath();
          ctx.ellipse(focus.x - 8, focus.y + 1, 9, 2.5, 0.45, 0, Math.PI * 2); ctx.fill(); ctx.restore();
          ctx.save(); ctx.globalCompositeOperation = 'screen';
          glow(ctx, p.x, p.y + 1, 16, 11, '255,192,96', 0.55);
          ctx.restore();
          ctx.fillStyle = '#ffe3a1'; ctx.beginPath(); ctx.ellipse(p.x + 1, p.y, 5.5, 2.3, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#fff4ce'; ctx.fillRect(p.x - 1, p.y - 1, 3, 1.5);
        }
        for (const lamp of ROOM_LIGHTS) {
          const p = project(lamp.x, lamp.y, 8);
          glow(ctx, p.x, p.y, 75, 38, lamp.color, 0.15);
        }
      });
      const nightContext = shade.getContext('2d');
      nightContext.setTransform(1, 0, 0, 1, 0, 0);
      nightContext.globalCompositeOperation = 'source-over';
      nightContext.drawImage(warmLights, 0, 0);
      nightContext.globalCompositeOperation = 'destination-in'; nightContext.drawImage(mask, 0, 0);
      warmLights = null;
      overcast = layer(ctx => {
        ctx.fillStyle = 'rgba(45,67,94,0.10)'; ctx.fillRect(0, 0, width, height);
        ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(mask, 0, 0, width, height);
      });
    },

    drawWindows(ctx, t, env, background, style) {
      if (style === 'simple') {
        const key = `${Boolean(env.night)}:${Boolean(env.sunset)}:${['rain', 'snow', 'fog', 'cloudy'].includes(env.condition)}`;
        if (simpleView?.key !== key) {
          simpleView = { key, canvas: layer(c => {
            for (const pane of WINDOWS) {
              c.save(); trace(c, windowPoints(pane, project)); c.clip();
              drawSimpleWindow(c, pane, project, env); c.restore();
            }
          }) };
        }
        background = simpleView.canvas;
      }
      for (const pane of WINDOWS) {
        const points = windowPoints(pane, project);
        ctx.save(); trace(ctx, points); ctx.clip();
        // 창문 안팎에 같은 도시 비트맵을 그려 풍경의 위치와 강수 움직임을 연결한다.
        ctx.imageSmoothingEnabled = false; ctx.drawImage(background, 0, 0, width, height);
        if (style === 'simple') drawSimpleWindowWeather(ctx, pane, project, t, env);
        const left = Math.min(...points.map(p => p.x)), right = Math.max(...points.map(p => p.x));
        const topY = Math.min(...points.map(p => p.y)), bottomY = Math.max(...points.map(p => p.y));
        const violet = env.neon && env.condition !== 'rain';
        const glass = ctx.createLinearGradient(left, topY, right, bottomY);
        glass.addColorStop(0, env.night ? violet ? '#b88fe41a' : '#b9d6ea14' : env.sunset ? '#ffc47d48' : '#edfff22b');
        glass.addColorStop(0.45, '#c3e2ee02');
        glass.addColorStop(0.7, env.night ? '#cad9e71c' : env.sunset ? '#ffe4b54a' : '#ffffff30');
        glass.addColorStop(1, '#9ebedc04');
        ctx.fillStyle = glass; ctx.fillRect(left, topY, right - left, bottomY - topY);
        // 실내의 따뜻한 등과 창밖의 차가운 빛이 유리에 옅게 겹친다.
        const center = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
        glow(ctx, center.x, center.y - 17, (right - left) * 0.42, 24, env.night ? '255,211,153' : env.sunset ? '255,192,112' : '255,247,207', env.sunset ? .22 : env.night ? 0.15 : 0.10);
        const shineX = left + (right - left) * 0.68;
        ctx.fillStyle = env.night ? '#e7dbbe12' : env.sunset ? '#ffe3a841' : '#ffffff25';
        ctx.fillRect(shineX, topY, 2, bottomY - topY); ctx.fillRect(shineX + 5, topY, 1, bottomY - topY);
        ctx.restore();
        ctx.strokeStyle = env.night ? '#344c60' : '#91aaa9'; ctx.lineWidth = 4;
        trace(ctx, points); ctx.stroke();
        ctx.strokeStyle = env.night ? '#89949d' : env.sunset ? '#f8d9a5' : '#f4edda'; ctx.lineWidth = 1.25;
        trace(ctx, points); ctx.stroke();
        const x = pane.x + (pane.axis === 'x' ? pane.w / 2 : 0), y = pane.y + (pane.axis === 'y' ? pane.w / 2 : 0);
        const top = project(x, y, pane.top), bottom = project(x, y, pane.bottom);
        ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(bottom.x, bottom.y); ctx.stroke();
      }
    },

    drawFloor(ctx, env) {
      ctx.drawImage(floorShadows, 0, 0, width, height);
      if (!env.night && ['clear', 'unknown'].includes(env.condition)) ctx.drawImage(sunlight, 0, 0, width, height);
    },

    drawLighting(ctx, env) {
      if (env.night) {
        ctx.drawImage(shade, 0, 0, width, height);
      } else {
        const cloudy = ['rain', 'snow', 'fog', 'cloudy'].includes(env.condition);
        if (env.sunset) { ctx.save(); ctx.globalAlpha = cloudy ? .45 : 1; ctx.drawImage(sunsetLight, 0, 0, width, height); ctx.restore(); }
        if (cloudy) ctx.drawImage(overcast, 0, 0, width, height);
      }
    },
  };
}
