import pixelOffice from '../pixel-office/theme.js';
import { VIEW, scenery, releaseScenery } from './scenery.js';

export default {
  ...pixelOffice,
  id: 'pixel-office-japan',
  name: '일본',
  viewport: { width: VIEW.width, height: VIEW.height },
  agentHead: pixelOffice.agentHead * VIEW.scale,
  agentHitRadius: pixelOffice.agentHitRadius * VIEW.scale,
  sceneBackground(env) { return env?.night ? '#404f54' : '#c3cbb6'; },
  project(x, y) {
    const p = pixelOffice.project(x, y);
    return { x: p.x * VIEW.scale + VIEW.x, y: p.y * VIEW.scale + VIEW.y };
  },
  unproject(x, y) { return pixelOffice.unproject((x - VIEW.x) / VIEW.scale, (y - VIEW.y) / VIEW.scale); },
  hitTest(x, y) { return pixelOffice.hitTest((x - VIEW.x) / VIEW.scale, (y - VIEW.y) / VIEW.scale); },
  unmount(next) { releaseScenery(); pixelOffice.unmount(next); },
  drawScene(ctx, agents, t, state = {}) {
    const environment = { ...state.environment, sunset: false, neon: false };
    const layers = scenery(environment, t);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(layers.town, 0, 0);
    ctx.translate(VIEW.x, VIEW.y);
    // 완성된 사무실을 다시 축소하지 않고 처음부터 최종 도트 격자로 그린다.
    pixelOffice.drawScene.call(this, ctx, agents, t, { ...state, environment, windowBackdrop: layers.windows, rasterScale: VIEW.scale });
    ctx.restore();
    layers.drawForeground(ctx);
  },
};
