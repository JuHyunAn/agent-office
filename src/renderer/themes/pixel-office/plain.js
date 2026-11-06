import pixelOffice from './theme.js';
import { t } from '../../../shared/i18n.js';

// 공통 사무실에 초기 스타일의 단순한 픽셀 창밖 풍경을 사용한다.
export default {
  ...pixelOffice,
  id: 'pixel-office-plain',
  get name() { return t('theme.name.pixel-office-plain'); },
  exteriorVisible: false,
  windowStyle: 'simple',
  sceneBackground(env) { return env?.night ? '#25313f' : env?.sunset ? '#f8eddd' : '#edf2eb'; },
};
