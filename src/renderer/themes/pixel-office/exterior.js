import { drawPixelBuilding } from './building.js';
import { drawCityscape } from './cityscape.js';
import { createCityNeon, neonIsOff } from './city-neon.js';
import { PIXEL_DETAIL } from './raster.js';

// 최초 시안의 도시와 유리 외벽을 실제 바닥 외곽선에 맞춰 합성한다.
const PLATES = {
  day: { url: new URL('../../assets/city/day-v2.png', import.meta.url), anchors: [[756, 137], [355, 334], [1463, 493]] },
  sunset: { url: new URL('../../assets/city/sunset-v1.png', import.meta.url), anchors: [[739, 133], [346, 326], [1434, 484]] },
  night: { url: new URL('../../assets/city/night-v2.png', import.meta.url), anchors: [[740, 132], [349, 326], [1433, 482]] },
  neon: { url: new URL('../../assets/city/neon-v2.png', import.meta.url), anchors: [[754, 137], [353, 334], [1462, 493]] },
};
const images = new Map();
let loading;

function loadImage(key) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => { images.set(key, image); resolve(); };
    image.onerror = () => reject(new Error(`도시 배경을 불러오지 못했습니다: ${key}`));
    image.src = PLATES[key].url;
  });
}

export function loadCityImages() {
  return loading ||= Promise.all(['day', 'sunset', 'night', 'neon'].map(loadImage)).catch(error => { loading = null; throw error; });
}

export const TOWER_FACES = [
  [2088, 64, 2088, 1200], [32, 1200, 2088, 1200],
  [704, 1360, 704, 1800], [32, 1800, 704, 1800],
  [2088, 1360, 2088, 1760], [1592, 1760, 2088, 1760],
].map(([x1, y1, x2, y2]) => ({ x1, y1, x2, y2 }));

// 세 지점을 맞춰 시간대별 이미지의 미세한 원근 차이를 보정한다.
function drawAligned(ctx, image, anchors, target) {
  const [o, u, v] = anchors, [p, q, r] = target;
  const ux = u[0] - o[0], uy = u[1] - o[1], vx = v[0] - o[0], vy = v[1] - o[1];
  const determinant = ux * vy - uy * vx;
  const a = ((q.x - p.x) * vy - (r.x - p.x) * uy) / determinant;
  const b = ((q.y - p.y) * vy - (r.y - p.y) * uy) / determinant;
  const c = ((r.x - p.x) * ux - (q.x - p.x) * vx) / determinant;
  const d = ((r.y - p.y) * ux - (q.y - p.y) * vx) / determinant;
  ctx.save(); ctx.transform(a, b, c, d, p.x - a * o[0] - c * o[1], p.y - b * o[0] - d * o[1]);
  ctx.drawImage(image, 0, 0); ctx.restore();
}

export function createExterior({ width, height, project }) {
  // 지금 시간대·날씨의 배경 하나만 둔다 — 조합마다 쌓아 두면 오래 켜 둘수록 GPU 메모리가 차오른다.
  let cached = null;
  let frame;
  const neon = createCityNeon();
  const layer = (detail = 1) => {
    const canvas = document.createElement('canvas'); canvas.width = width * detail; canvas.height = height * detail; return canvas;
  };
  const target = [project(32, 64), project(32, 1200), project(2088, 64)];
  function facadePath(c) {
    c.beginPath();
    for (const wall of TOWER_FACES) {
      const points = [project(wall.x1, wall.y1, -16), project(wall.x2, wall.y2, -16), project(wall.x2, wall.y2, -1800), project(wall.x1, wall.y1, -1800)];
      // 서로 겹친 외벽의 클리핑 영역이 상쇄되지 않도록 면의 방향을 통일한다.
      if (wall.x1 === wall.x2) points.reverse();
      points.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); c.closePath();
    }
  }
  function city(env) {
    const variant = env.cityStyle === 'citypop' ? 'citypop' : env.night ? env.neon && env.condition !== 'rain' ? 'neon' : 'night' : env.sunset ? 'sunset' : 'day';
    const overcast = ['rain', 'snow', 'fog', 'cloudy'].includes(env.condition);
    const key = `${variant}:${overcast}`;
    if (cached?.key !== key) {
      for (const old of [cached?.canvas, ...(cached?.patches || []).map(p => p.canvas)]) if (old) old.width = old.height = 0;
      const detail = variant === 'citypop' ? PIXEL_DETAIL : 1;
      const paint = (canvas, unlit = false) => {
        const c = canvas.getContext('2d'), image = images.get(variant);
        c.scale(detail, detail);
        if (variant === 'citypop') {
          drawCityscape(c, { width, height }, (ctx, block) => neon.draw(ctx, block, unlit));
          drawPixelBuilding(c, { faces: TOWER_FACES, project, width, height });
        } else {
          if (!image) throw new Error('도시 배경 준비가 완료되지 않았습니다');
          c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
          c.drawImage(image, 0, 0, width, height);
          drawAligned(c, image, PLATES[variant].anchors, target);
        }
        // 배경의 대비를 낮춰 실제 사무실과 캐릭터가 먼저 보이도록 한다.
        c.fillStyle = variant === 'citypop' ? '#2c124c35' : env.night ? variant === 'neon' ? '#11152c38' : '#14223830' : env.sunset ? '#e9bd9610' : '#e1e9e51a';
        c.fillRect(0, 0, width, height);
        if (overcast) { c.fillStyle = env.night ? '#0d1b2a20' : '#40566a38'; c.fillRect(0, 0, width, height); }
        // 아래층 외벽은 화면 끝 아래로 이어지고, 멀어질수록 어둡게 물러난다.
        c.save(); facadePath(c); c.clip();
        const depth = c.createLinearGradient(0, height * 0.5, 0, height);
        depth.addColorStop(0, '#101d3000'); depth.addColorStop(1, env.night ? '#101b3566' : '#35445626');
        c.fillStyle = depth; c.fillRect(0, 0, width, height); c.restore();
      };
      const canvas = layer(detail); paint(canvas);
      let patches = [];
      if (variant === 'citypop') {
        // 전체 소등 장면은 한 번만 만들고 작은 패치로 잘라 즉시 해제한다.
        // 따라서 점멸할 때 도시 재생성·필터 계산 없이 가림 순서도 그대로 유지된다.
        const unlit = layer(detail); paint(unlit, true);
        patches = neon.patches(unlit, width, height);
        unlit.width = unlit.height = 0;
      }
      cached = { key, canvas, patches };
    }
    return cached.canvas;
  }

  return {
    drawBackground(ctx, t, env, visible = true) {
      const detail = env.cityStyle === 'citypop' ? PIXEL_DETAIL : 1;
      if (!frame || frame.width !== width * detail) {
        if (frame) frame.width = frame.height = 0;
        frame = layer(detail);
      }
      const c = frame.getContext('2d'); c.setTransform(detail, 0, 0, detail, 0, 0);
      c.imageSmoothingEnabled = false; c.drawImage(city(env), 0, 0, width, height);
      for (const patch of cached.patches) if (patch.w && patch.h && neonIsOff(t, patch.flicker)) {
        c.drawImage(patch.canvas, patch.x, patch.y, patch.w, patch.h);
      }
      // 도시 위에 실제 날씨 입자를 합성하고 실내는 이후 바닥 레이어로 가린다.
      if (env.condition === 'rain') {
        c.strokeStyle = env.night ? '#b8cddd60' : '#eef9fa92'; c.lineWidth = 1; c.beginPath();
        for (let i = 0; i < 240; i++) {
          const x = ((i * 193 - t / 30) % width + width) % width, y = (i * 131 + t / 5) % (height + 30) - 20;
          c.moveTo(x, y); c.lineTo(x - 4, y + 13);
        }
        c.stroke();
      } else if (env.condition === 'snow') {
        c.fillStyle = '#eef5f3d9';
        for (let i = 0; i < 160; i++) {
          const x = (i * 173 + Math.sin(t / 1800 + i) * 14 + width) % width, y = (i * 113 + t / (38 + i % 4 * 14)) % (height + 12) - 6;
          c.fillRect(Math.round(x), Math.round(y), i % 4 ? 1.5 : 3, i % 4 ? 1.5 : 3);
        }
      }
      if (visible) { ctx.save(); ctx.imageSmoothingEnabled = false; ctx.drawImage(frame, 0, 0, width, height); ctx.restore(); }
      return frame;
    },
    release() {
      for (const c of [cached?.canvas, frame, ...(cached?.patches || []).map(p => p.canvas)]) if (c) c.width = c.height = 0;
      neon.release();
      cached = frame = null;
    },
  };
}
