import pixelOffice from './theme.js';

// 공통 사무실에 초기 스타일의 단순한 픽셀 창밖 풍경을 사용한다.
export default {
  ...pixelOffice,
  id: 'pixel-office-plain',
  name: '픽셀 오피스 · 배경 없음',
  exteriorVisible: false,
  windowStyle: 'simple',
  sceneBackground(env) { return env?.night ? '#25313f' : env?.sunset ? '#f8eddd' : '#edf2eb'; },
};
