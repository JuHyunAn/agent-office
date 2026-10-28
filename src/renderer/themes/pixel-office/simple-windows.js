import { polygon, line } from './raster.js';

function windowSpace(pane, project) {
  const origin = project(pane.x, pane.y, pane.top);
  return {
    width: pane.w * 0.36, height: pane.top - pane.bottom,
    point: (u, v) => ({ x: origin.x + u, y: origin.y + u * 0.5 + v }),
  };
}

// 초기 사무실처럼 창틀의 사선에 맞춘 작은 픽셀 도시를 그린다.
export function drawSimpleWindow(ctx, pane, project, env) {
  const { width, height, point } = windowSpace(pane, project);
  const rect = (x, y, w, h, color) => polygon(ctx, [point(x, y), point(x + w, y), point(x + w, y + h), point(x, y + h)], color);
  const night = env.night, cloudy = ['rain', 'snow', 'fog', 'cloudy'].includes(env.condition);
  const sunset = !night && env.sunset;
  const sky = night ? ['#243650', '#2d4260', '#38516b'] : sunset ? cloudy ? ['#ae929b', '#c9a29b', '#dfbd9f'] : ['#e79b87', '#f3ba89', '#f9d69e'] : cloudy ? ['#8daebd', '#9bbbc6', '#afccd0'] : ['#89bfd4', '#9dcddd', '#b8dfdf'];
  for (let band = 0; band < 3; band++) rect(0, band * height / 3, width, height / 3, sky[band]);
  if (night) {
    rect(width - 29, 12, 8, 8, '#e9dfb0'); rect(width - 25, 10, 6, 7, sky[0]);
    for (let i = 0; i < 10; i++) rect(8 + i * 17 % (width - 16), 8 + i * 11 % 28, 1, 1, '#bbd3d9');
  } else {
    for (let i = 0; i < 3; i++) {
      const x = 10 + i * 53 % (width - 34), y = 14 + i % 2 * 12;
      rect(x, y, 25, 5, sunset ? '#ffe1b6' : '#e6f2e7'); rect(x + 7, y - 4, 11, 4, sunset ? '#ffe1b6' : '#e6f2e7');
    }
  }
  const seed = Math.floor(pane.x / 52);
  for (let layer = 0; layer < 2; layer++) {
    for (let i = 0, x = -3; x < width; i++) {
      const w = 13 + (i * 7 + seed) % 14, h = 25 + (i * 19 + seed * 3 + layer * 11) % 39;
      const top = height - h + (layer ? 0 : -10);
      const color = night ? layer ? '#304658' : '#496279' : sunset ? layer ? '#767b95' : '#b09b9e' : layer ? '#6295ab' : '#83b2c2';
      rect(x, top, w, height - top, color);
      rect(x + w - 3, top, 3, height - top, night ? '#273e52' : sunset ? '#d3a389' : '#54879f');
      for (let row = 0; row < h / 8 - 1; row++) for (let col = 0; col < (w - 5) / 6; col++) {
        const lit = (i * 3 + row * 5 + col + seed) % 7 < 3;
        rect(x + 3 + col * 6, top + 5 + row * 8, 2, 3, night ? lit ? '#e3cc93' : '#527082' : sunset ? lit ? '#f4cc91' : '#a5adb6' : '#b6dae1');
      }
      x += w + 3;
    }
  }
  rect(0, height - 3, width, 3, night ? '#344c53' : sunset ? '#b3a393' : '#8bb2a9');
}

export function drawSimpleWindowWeather(ctx, pane, project, t, env) {
  const { width, height, point } = windowSpace(pane, project);
  if (env.condition === 'rain') {
    for (let i = 0; i < 36; i++) {
      const x = ((i * 29 - t / 40) % width + width) % width, y = (i * 17 + t / 6) % (height + 12) - 6;
      line(ctx, point(x, y), point(x - 2, y + 8), env.night ? '#b3ccda80' : '#eff8f1b0');
    }
  } else if (env.condition === 'snow') {
    ctx.fillStyle = '#f1f5ecd9';
    for (let i = 0; i < 22; i++) {
      const p = point((i * 31 + Math.sin(t / 1600 + i) * 5 + width) % width, (i * 19 + t / 50) % height);
      ctx.fillRect(Math.round(p.x * 2) / 2, Math.round(p.y * 2) / 2, i % 4 ? 1 : 2, i % 4 ? 1 : 2);
    }
  }
}
