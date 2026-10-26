import pixelOffice from './theme.js';

// 사무실과 창밖 날씨는 공유하고 외부 도시·아래층 외벽만 생략한다.
export default {
  ...pixelOffice,
  id: 'pixel-office-plain',
  name: '픽셀 오피스 · 배경 없음',
  exteriorVisible: false,
  sceneBackground(env) { return env?.night ? '#25313f' : '#edf2eb'; },
};
