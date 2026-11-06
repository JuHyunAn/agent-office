// 언어 사전 모음 — 영역 파일을 합친다. 영역 사이 키가 겹치면 test/i18n.test.js 가 잡는다.
import app from './en/app.js';
import collab from './en/collab.js';
import code from './en/code.js';
import office from './en/office.js';
import theme from './en/theme.js';
import main from './en/main.js';
import pet from './en/pet.js';
import run from './en/run.js';
export default Object.freeze({ ...app, ...collab, ...code, ...office, ...theme, ...main, ...pet, ...run });
