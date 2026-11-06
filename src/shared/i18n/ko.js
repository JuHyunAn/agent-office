// 언어 사전 모음 — 영역 파일을 합친다. 영역 사이 키가 겹치면 test/i18n.test.js 가 잡는다.
import app from './ko/app.js';
import collab from './ko/collab.js';
import code from './ko/code.js';
import office from './ko/office.js';
import theme from './ko/theme.js';
import main from './ko/main.js';
import pet from './ko/pet.js';
import run from './ko/run.js';
export default Object.freeze({ ...app, ...collab, ...code, ...office, ...theme, ...main, ...pet, ...run });
