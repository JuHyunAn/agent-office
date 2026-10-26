// 테마 등록부. 새 테마는 themes/<이름>/theme.js 를 만들고 여기에 한 줄 추가한다 (THEME.md).
import mockup from './mockup/theme.js';
import pixelOffice from './pixel-office/theme.js';
import plainOffice from './pixel-office/plain.js';

export const THEMES = [pixelOffice, plainOffice, mockup];

export function getTheme(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}
