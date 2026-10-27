import pixelOffice from './theme.js';

export default {
  ...pixelOffice,
  id: 'pixel-office-citypop',
  name: '픽셀 오피스 · 시티팝 새벽',
  sceneBackground() { return '#242241'; },
  drawScene(ctx, agents, t, state = {}) {
    // 실제 시각·날씨 정보는 유지하면서 이 테마의 그림만 새벽 조명으로 고정한다.
    const environment = { ...state.environment, night: true, neon: true, cityStyle: 'citypop' };
    pixelOffice.drawScene.call(this, ctx, agents, t, { ...state, environment });
  },
};
