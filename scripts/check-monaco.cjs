'use strict';
// 설치 파일에 코드 편집기(모나코 AMD 빌드)가 빠지지 않게 하는 검사. npm 이 dist 앞뒤로 자동 실행한다.
//   pre  : node_modules 에 모나코 로더가 있는지 — 없으면 빌드를 멈춘다 (electron-builder 는 설치된 의존성만 묶는다).
//   post : 만든 app.asar 에 로더·편집기 본체가 들어갔고 쓰지 않는 esm·dev 빌드는 빠졌는지.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const NEED = ['min/vs/loader.js', 'min/vs/editor/editor.main.js'];
const fail = (msg) => { console.error(`[check-monaco] ${msg}`); process.exit(1); };

if (process.argv[2] === 'pre') {
  const base = path.join(ROOT, 'node_modules', 'monaco-editor');
  const missing = NEED.filter(f => !fs.existsSync(path.join(base, f)));
  if (missing.length) fail(`모나코가 설치되어 있지 않습니다 (${missing.join(', ')}). 먼저 npm install 을 실행하세요.`);
  console.log('[check-monaco] 빌드 전: 모나코 설치 확인');
} else if (process.argv[2] === 'post') {
  const asarPath = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) fail(`${asarPath} 가 없습니다`);
  const entries = new Set(require('@electron/asar').listPackage(asarPath, { isPack: false }).map(p => p.split(path.sep).join('/')));
  const missing = NEED.filter(f => !entries.has(`/node_modules/monaco-editor/${f}`));
  if (missing.length) fail(`설치 파일에 모나코가 빠졌습니다 (${missing.join(', ')})`);
  const extra = [...entries].filter(p => /^\/node_modules\/monaco-editor\/(esm|dev)\//.test(p));
  if (extra.length) fail(`쓰지 않는 모나코 빌드가 들어갔습니다 (${extra.length}개, 예: ${extra[0]})`);
  console.log('[check-monaco] 빌드 후: 설치 파일에 모나코 포함 확인');
} else fail('사용법: node scripts/check-monaco.cjs pre|post');
