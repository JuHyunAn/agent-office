import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { visiblePets, petState, bubbleOf, cardOf, cardPreview as cardPreviewUi, usageRowText, updatedText, refreshButton, sessionText, ROWS, SLEEP_AFTER_MS, SLEEP_SHEET, SHEET, SHEETS, gazeCell } from '../src/renderer/pet/model.js';

const require = createRequire(import.meta.url);
const rules = require('../src/main/petRules.cjs');
const { normalizePetConfig, normalizeSprite, sanitizeUsage, shouldShow, hasAttention, displayFor, placeBounds, anchorOf, readPet, answerableIds, permsToRelease, cardPreview } = rules;
const { createPetController, sanitizeKinds } = require('../src/main/pet.cjs');

const item = (kind, extra = {}) => ({ key: 'k', tabId: 't1', label: 'proj', reason: kind === 'done' ? 'done' : 'permission', kind, text: kind === 'done' ? '✅ 답변 완료' : '❓ 권한 확인', at: 1, ...extra });

test('펫 모델: 보일 펫', () => {
  const kinds = { claude: { attention: [] }, codex: { attention: [item('alert')] } };
  assert.deepEqual(visiblePets({ mode: 'always', codex: false, kinds }), ['claude']);
  assert.deepEqual(visiblePets({ mode: 'always', codex: true, kinds }), ['claude', 'codex']);
  assert.deepEqual(visiblePets({ mode: 'alerts', codex: true, kinds }), ['codex']);
  assert.deepEqual(visiblePets({ mode: 'alerts', codex: true, kinds: { claude: { attention: [item('done')] }, codex: { attention: [item('alert')] } } }), ['claude', 'codex']);
  assert.deepEqual(visiblePets({ mode: 'alerts', codex: true, kinds: {} }), []);
  assert.deepEqual(visiblePets({ mode: 'off', codex: true, kinds }), []);
});

test('펫 모델: 상태 우선순위', () => {
  assert.equal(petState({ working: true, attention: [item('alert', { reason: 'collab-error' })] }, 'left'), 'running-left');
  assert.equal(petState({}, 'right'), 'running-right');
  assert.equal(petState({ working: true, attention: [item('done'), item('alert'), item('alert', { reason: 'collab-error' })] }), 'failed');
  assert.equal(petState({ working: true, attention: [item('done'), item('alert')] }), 'waiting');
  assert.equal(petState({ working: true, attention: [item('done')] }), 'waving');
  assert.equal(petState({ working: true, attention: [] }), 'running');
  assert.equal(petState({ working: false, attention: [] }), 'idle');
  assert.equal(petState(), 'idle');
  for (const name of ['failed', 'waiting', 'waving', 'running', 'idle', 'running-left', 'running-right']) assert.ok(ROWS[name], name);
});

test('펫 모델: 5분 넘게 가만히 있으면 잔다', () => {
  assert.equal(SLEEP_AFTER_MS, 5 * 60000);
  assert.equal(petState({ attention: [] }, null, { idleFor: SLEEP_AFTER_MS - 1 }), 'idle');
  assert.equal(petState({ attention: [] }, null, { idleFor: SLEEP_AFTER_MS }), 'sleeping');
  assert.equal(petState({}, null, { idleFor: 99 * 60000 }), 'sleeping');
  assert.equal(petState({ working: true }, null, { idleFor: SLEEP_AFTER_MS }), 'running'); // 작업이 시작되면 깬다
  assert.equal(petState({ attention: [item('done')] }, null, { idleFor: SLEEP_AFTER_MS }), 'waving'); // 알림이 오면 깬다
  assert.equal(petState({ attention: [item('alert')] }, null, { idleFor: SLEEP_AFTER_MS }), 'waiting');
  assert.equal(petState({}, 'left', { idleFor: SLEEP_AFTER_MS }), 'running-left'); // 드래그하면 깬다
  assert.equal(petState({}, null, { idleFor: SLEEP_AFTER_MS, collab: { active: true, speaker: 'claude' }, kind: 'codex' }), 'review'); // 협업 중에는 자지 않는다
  assert.deepEqual(ROWS.sleeping.ms.length, 6);
  assert.equal(ROWS.sleeping.row, null);
  assert.deepEqual(SLEEP_SHEET, { width: 1536, height: 208 });
});

test('펫 모델: 시트 크기는 버전 1(9줄)·2(11줄)', () => {
  assert.deepEqual(SHEETS, { 1: { width: 1536, height: 1872 }, 2: { width: 1536, height: 2288 } });
  assert.deepEqual(SHEET, SHEETS[1], '예전 이름 SHEET 는 버전 1');
});

test('gazeCell: 위쪽 0° 에서 시계 방향 22.5° 마다 한 칸, 9·10행의 16칸', () => {
  // 각도(°) → dx, dy (화면 y 는 아래로 +, 위쪽이 0°, 시계 방향)
  const at = (deg, r = 100) => gazeCell(r * Math.sin(deg * Math.PI / 180), -r * Math.cos(deg * Math.PI / 180));
  assert.deepEqual(at(0), { row: 9, col: 0 });
  assert.deepEqual(at(11.2), { row: 9, col: 0 }, '0° 칸의 경계 바로 안');
  assert.deepEqual(at(11.3), { row: 9, col: 1 }, '경계 바로 밖');
  assert.deepEqual(at(22.5), { row: 9, col: 1 });
  assert.deepEqual(at(90), { row: 9, col: 4 });
  assert.deepEqual(at(157.5), { row: 9, col: 7 });
  assert.deepEqual(at(180), { row: 10, col: 0 }, 'o=8 → 10행 첫 칸');
  assert.deepEqual(at(202.5), { row: 10, col: 1 });
  assert.deepEqual(at(270), { row: 10, col: 4 });
  assert.deepEqual(at(337.5), { row: 10, col: 7 });
  assert.deepEqual(at(348.7), { row: 10, col: 7 }, '348.75° 경계 바로 안');
  assert.deepEqual(at(348.8), { row: 9, col: 0 }, '경계를 넘으면 처음으로 돌아온다');
  assert.deepEqual(at(359.9), { row: 9, col: 0 });
  // 16방향이 모두 나오고 서로 다른 칸이다
  const cells = Array.from({ length: 16 }, (_, i) => at(i * 22.5));
  assert.equal(new Set(cells.map((c) => `${c.row}:${c.col}`)).size, 16);
  assert.deepEqual(cells.map((c) => c.row), [...Array(8).fill(9), ...Array(8).fill(10)]);
  assert.deepEqual(cells.map((c) => c.col), [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7]);
  // 중심 1px 이내는 null (바라보는 방향이 없다)
  assert.equal(gazeCell(0, 0), null);
  assert.equal(gazeCell(1, 0), null);
  assert.equal(gazeCell(0, -1), null);
  assert.equal(gazeCell(0.7, 0.7), null);
  assert.deepEqual(gazeCell(1.01, 0), { row: 9, col: 4 });
  // 거리와 상관없이 방향만 본다
  assert.deepEqual(gazeCell(0, -1000), { row: 9, col: 0 });
  assert.deepEqual(gazeCell(-3, 3), { row: 10, col: 2 }, '왼쪽 아래 (225°)');
});

test('펫 모델: 협업 대화 중에는 둘 다 보인다', () => {
  const collab = { active: true, speaker: 'claude', turn: 1, prev: null };
  const kinds = { claude: { attention: [] }, codex: { attention: [] } };
  assert.deepEqual(visiblePets({ mode: 'alerts', codex: true, kinds, collab }), ['claude', 'codex']);
  assert.deepEqual(visiblePets({ mode: 'always', codex: false, kinds, collab }), ['claude', 'codex']);
  assert.deepEqual(visiblePets({ mode: 'off', codex: true, kinds, collab }), []);
  assert.deepEqual(visiblePets({ mode: 'alerts', codex: true, kinds, collab: { active: false } }), []);
  assert.deepEqual(visiblePets({ mode: 'alerts', codex: true, kinds, collab: null }), []);
});

test('펫 모델: 협업 대화의 상태 (말하는 쪽 running · 듣는 쪽 review)', () => {
  const collab = { active: true, speaker: 'claude', turn: 3, prev: 'codex' };
  assert.equal(petState({ working: true }, null, { collab, kind: 'claude' }), 'running');
  assert.equal(petState({ working: true }, null, { collab, kind: 'codex' }), 'review');
  assert.equal(petState({}, null, { collab: { ...collab, speaker: null }, kind: 'claude' }), 'review'); // 아무도 안 말하는 사이: 직전에 말한 쪽(codex)만 running
  assert.equal(petState({}, null, { collab: { ...collab, speaker: null }, kind: 'codex' }), 'running');
  assert.equal(petState({}, null, { collab: { ...collab, speaker: null, prev: null }, kind: 'codex' }), 'review'); // 직전도 없으면 둘 다 review
  assert.equal(petState({}, null, { collab: { ...collab, speaker: null, prev: null }, kind: 'claude' }), 'review');
  assert.equal(petState({ attention: [item('alert')] }, null, { collab, kind: 'codex' }), 'waiting'); // 질문한 쪽
  assert.equal(petState({ attention: [item('alert', { reason: 'collab-error' })] }, null, { collab, kind: 'claude' }), 'failed');
  assert.equal(petState({ attention: [item('done')] }, null, { collab, kind: 'codex' }), 'waving');
  assert.equal(petState({}, 'right', { collab, kind: 'claude' }), 'running-right');
  assert.equal(petState({ working: true }, null, { collab: { active: false }, kind: 'codex' }), 'running'); // 협업이 아니면 예전 그대로
  assert.ok(ROWS.review && ROWS.jumping);
});

test('펫 모델: 말풍선은 가장 최근 알림', () => {
  assert.equal(bubbleOf({ attention: [] }), null);
  assert.equal(bubbleOf(), null);
  const b = bubbleOf({ attention: [item('done', { key: 'a', label: 'old' }), item('alert', { key: 'b', tabId: 't2', label: 'new' })] });
  assert.deepEqual(b, { text: '❓ 권한 확인 · new', key: 'b', tabId: 't2' });
  assert.equal(bubbleOf({ attention: [item('done', { label: '' })] }).text, '✅ 답변 완료');
  assert.equal(bubbleOf({ attention: [item('done', { label: null, tabId: null })] }).tabId, null);
});

test('펫 설정 정리', () => {
  assert.deepEqual(normalizePetConfig(undefined), { mode: 'always', anchor: null, sprites: { claude: null, codex: null }, usage: { expanded: true } });
  assert.deepEqual(normalizePetConfig({ mode: 'alerts', anchor: { right: 100, bottom: 200 }, sprites: { claude: 'user:my-pet_1', codex: 'builtin:office-codex' } }),
    { mode: 'alerts', anchor: { right: 100, bottom: 200 }, sprites: { claude: 'user:my-pet_1', codex: 'builtin:office-codex' }, usage: { expanded: true } });
  // 예전 맨 id 는 user: 로 옮기고, 'none' 은 그대로, 그 밖은 null
  assert.deepEqual(normalizePetConfig({ sprites: { claude: 'my-pet_1', codex: 'none' } }).sprites, { claude: 'user:my-pet_1', codex: 'none' });
  assert.deepEqual(normalizePetConfig({ sprites: { claude: 'user:../x', codex: 'builtin:a b' } }).sprites, { claude: null, codex: null });
  assert.deepEqual(normalizePetConfig({ sprites: { claude: 'other:abc', codex: 'user:' } }).sprites, { claude: null, codex: null });
  assert.deepEqual(normalizePetConfig({ sprites: { claude: 'user:-bad', codex: 'builtin:x\n' } }).sprites, { claude: null, codex: null });
  assert.deepEqual(normalizePetConfig({ sprites: { claude: 'None', codex: '' } }).sprites, { claude: 'user:none', codex: null }, '맨 id 는 소문자로 user: 로');
  assert.deepEqual(normalizePetConfig({ sprites: { claude: 'User:Mine', codex: 'builtin:Office-Codex' } }).sprites, { claude: null, codex: 'builtin:office-codex' }, '접두는 소문자만 인정, id 는 소문자로');
  assert.equal(normalizeSprite('user:MyPet_1'), 'user:mypet_1');
  assert.equal(normalizeSprite('MyPet'), 'user:mypet');
  assert.equal(normalizeSprite('user:a'), 'user:a');
  assert.equal(normalizeSprite(null), null);
  assert.equal(normalizePetConfig({ usage: { expanded: false } }).usage.expanded, false, '접은 상태가 보존된다');
  assert.equal(normalizePetConfig({ usage: { expanded: true } }).usage.expanded, true);
  assert.equal(normalizePetConfig({ usage: { expanded: 'no' } }).usage.expanded, true, 'false 가 아니면 펼침');
  assert.equal(normalizePetConfig({ usage: 5 }).usage.expanded, true);
  assert.equal(normalizePetConfig({ usage: null }).usage.expanded, true);
  assert.equal(normalizePetConfig({ mode: 'sometimes' }).mode, 'always');
  assert.equal(normalizePetConfig({ anchor: { right: NaN, bottom: 5 } }).anchor, null);
  assert.equal(normalizePetConfig({ anchor: { right: 5 } }).anchor, null);
  assert.equal(normalizePetConfig({ anchor: { right: '5', bottom: 5 } }).anchor, null);
  const s = normalizePetConfig({ sprites: { claude: '../evil', codex: 42 } }).sprites;
  assert.deepEqual(s, { claude: null, codex: null });
  assert.equal(normalizePetConfig({ sprites: { claude: '-bad' } }).sprites.claude, null);
  assert.equal(normalizePetConfig('x').mode, 'always');
});

test('펫 표시 여부', () => {
  const none = { kinds: { claude: { attention: [] }, codex: { attention: [] } } };
  const some = { kinds: { claude: { attention: [] }, codex: { attention: [item('alert')] } } };
  assert.equal(hasAttention(none), false);
  assert.equal(hasAttention(some), true);
  assert.equal(hasAttention({}), false);
  assert.equal(shouldShow('off', some), false);
  assert.equal(shouldShow('alerts', none), false);
  assert.equal(shouldShow('alerts', some), true);
  assert.equal(shouldShow('always', none), true);
});

test('펫 표시 여부: 협업 대화 중에는 알림만 모드에서도 보인다', () => {
  const none = { kinds: { claude: { attention: [] }, codex: { attention: [] } } };
  const collab = { active: true, speaker: 'codex', turn: 2, prev: 'claude' };
  assert.equal(shouldShow('alerts', { ...none, collab }), true);
  assert.equal(shouldShow('alerts', { ...none, collab: { active: false } }), false);
  assert.equal(shouldShow('alerts', { ...none, collab: null }), false);
  assert.equal(shouldShow('off', { ...none, collab }), false);
  assert.equal(shouldShow('always', { ...none, collab }), true);
  assert.equal(hasAttention({ ...none, collab }), false); // 알림 판단은 협업과 별개
});

const main = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const second = { workArea: { x: 1920, y: 0, width: 1280, height: 1000 } };

test('펫 위치: 기본은 주 모니터 오른쪽 아래 16px', () => {
  assert.deepEqual(placeBounds(null, { width: 220, height: 170 }, [main], main), { x: 1920 - 16 - 220, y: 1040 - 16 - 170, width: 220, height: 170 });
});

test('펫 위치: anchor 유지, 화면 밖이면 보정', () => {
  const size = { width: 200, height: 100 };
  assert.deepEqual(placeBounds({ right: 1000, bottom: 600 }, size, [main], main), { x: 800, y: 500, width: 200, height: 100 });
  assert.deepEqual(placeBounds({ right: 5000, bottom: 5000 }, size, [main], main), { x: 1720, y: 940, width: 200, height: 100 });
  assert.deepEqual(placeBounds({ right: -300, bottom: -300 }, size, [main], main), { x: 0, y: 0, width: 200, height: 100 });
  assert.deepEqual(placeBounds({ right: 100, bottom: 50 }, size, [main], main), { x: 0, y: 0, width: 200, height: 100 }); // 왼쪽 위 모서리를 넘는 경우
  assert.deepEqual(placeBounds({ right: 1000, bottom: 600 }, { width: 3000, height: 2000 }, [main], main), { x: 0, y: 0, width: 3000, height: 2000 }); // 창이 작업 영역보다 크다
});

test('펫 위치: 다른 모니터', () => {
  assert.equal(displayFor({ x: 2000, y: 10 }, [main, second], main), second);
  assert.equal(displayFor({ x: 10, y: 10 }, [main, second], main), main);
  assert.equal(displayFor({ x: 3500, y: 10 }, [main, second], main), second); // 어디에도 없으면 가까운 쪽
  assert.equal(displayFor({ x: -500, y: 10 }, [main, second], main), main);
  assert.equal(displayFor({ x: 1, y: 1 }, [], main), main);
  assert.deepEqual(placeBounds({ right: 3000, bottom: 500 }, { width: 200, height: 100 }, [main, second], main), { x: 2800, y: 400, width: 200, height: 100 });
  // 모니터가 빠져 anchor 가 사라진 화면을 가리키면 가까운 모니터 안으로 들어온다
  assert.deepEqual(placeBounds({ right: 3300, bottom: 500 }, { width: 200, height: 100 }, [main], main), { x: 1720, y: 400, width: 200, height: 100 });
});

test('anchorOf', () => {
  assert.deepEqual(anchorOf({ x: 10, y: 20, width: 30, height: 40 }), { right: 40, bottom: 60 });
});

function petDir(setup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pets-'));
  setup(dir);
  return dir;
}
const write = (dir, rel, data) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), data); };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
// 머리글만 있는 png (가로·세로만 맞다): 목록(scanPets)은 시트 앞부분의 크기로 1536x1872 를 가린다
const pngOf = (w, h) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const SHEET_PNG = pngOf(1536, 1872);

test('readPet: 정상 png 와 webp', () => {
  const dir = petDir((d) => {
    write(d, 'good/pet.json', JSON.stringify({ displayName: 'Good', spritesheetPath: 'sheet.png' }));
    write(d, 'good/sheet.png', PNG);
    write(d, 'sub/pet.json', JSON.stringify({ spritesheetPath: 'img/SHEET.WEBP' }));
    write(d, 'sub/img/SHEET.WEBP', PNG);
    write(d, 'long/pet.json', JSON.stringify({ displayName: 'x'.repeat(100), spritesheetPath: 'a.png' }));
    write(d, 'long/a.png', PNG);
  });
  const r = readPet(dir, 'good');
  assert.equal(r.id, 'good');
  assert.equal(r.displayName, 'Good');
  assert.equal(r.type, 'image/png');
  assert.deepEqual(r.bytes, PNG);
  const w = readPet(dir, 'sub');
  assert.equal(w.type, 'image/webp');
  assert.equal(w.displayName, 'sub'); // displayName 이 없으면 id
  assert.equal(readPet(dir, 'long').displayName.length, 40);
});

test('readPet: 위험하거나 잘못된 입력은 null', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-outside-'));
  fs.writeFileSync(path.join(outside, 'x.png'), PNG);
  const dir = petDir((d) => {
    const pet = (id, meta, sheet = 'sheet.png') => { write(d, `${id}/pet.json`, typeof meta === 'string' ? meta : JSON.stringify(meta)); if (sheet) write(d, `${id}/${sheet}`, PNG); };
    pet('dotdot', { spritesheetPath: '../good/sheet.png' });
    pet('dotdot2', { spritesheetPath: 'a\\..\\sheet.png' });
    pet('abs', { spritesheetPath: path.join(outside, 'x.png') });
    pet('gif', { spritesheetPath: 'sheet.gif' }, 'sheet.gif');
    pet('badjson', '{ nope');
    pet('nopath', { displayName: 'x' });
    pet('nonstring', { spritesheetPath: 5 });
    pet('missing', { spritesheetPath: 'none.png' }, null);
    pet('bigjson', { spritesheetPath: 'sheet.png', pad: 'x'.repeat(70 * 1024) });
    pet('dirsheet', { spritesheetPath: 'folder.png' }, null);
    fs.mkdirSync(path.join(d, 'dirsheet', 'folder.png'));
    write(d, 'nojson/sheet.png', PNG);
    write(d, 'big/pet.json', JSON.stringify({ spritesheetPath: 'big.png' }));
    write(d, 'big/big.png', Buffer.alloc(8 * 1024 * 1024 + 1));
    write(d, 'edge/pet.json', JSON.stringify({ spritesheetPath: 'big.png' }));
    write(d, 'edge/big.png', Buffer.alloc(8 * 1024 * 1024));
    pet('linked', { spritesheetPath: 'link/x.png' }, null);
    try { fs.symlinkSync(outside, path.join(d, 'linked', 'link'), 'junction'); } catch { /* 연결을 만들 수 없는 환경 */ }
  });
  for (const id of ['dotdot', 'dotdot2', 'abs', 'gif', 'badjson', 'nopath', 'nonstring', 'missing', 'bigjson', 'dirsheet', 'nojson', 'big', 'nope']) {
    assert.equal(readPet(dir, id), null, id);
  }
  for (const id of ['', '..', '../x', 'a/b', 'a\\b', '.hidden', 'x'.repeat(65), null, undefined, 5]) assert.equal(readPet(dir, id), null, String(id));
  assert.equal(readPet(dir, 'edge').bytes.length, 8 * 1024 * 1024); // 정확히 8MB 는 허용
  if (fs.existsSync(path.join(dir, 'linked', 'link'))) assert.equal(readPet(dir, 'linked'), null, '폴더 밖을 가리키는 연결');
});

test('readPet: 폴더 밖을 가리키는 pet.json 연결은 null', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-outside-'));
  fs.writeFileSync(path.join(outside, 'pet.json'), JSON.stringify({ spritesheetPath: 'sheet.png' }));
  const dir = petDir((d) => { write(d, 'jl/sheet.png', PNG); });
  try { fs.symlinkSync(path.join(outside, 'pet.json'), path.join(dir, 'jl', 'pet.json'), 'file'); } catch { return; } // 연결을 만들 수 없는 환경
  assert.equal(readPet(dir, 'jl'), null);
});

test('readPet: 자는 동작 줄(agentOffice.sleepSheetPath)', () => {
  const SLEEP = Buffer.from([0x52, 0x49, 0x46, 0x46, 9, 9]);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-outside-'));
  fs.writeFileSync(path.join(outside, 'z.png'), PNG);
  const dir = petDir((d) => {
    const pet = (id, agentOffice, sleepFile = 'sleep.webp', sleepData = SLEEP) => {
      write(d, `${id}/pet.json`, JSON.stringify({ spritesheetPath: 'sheet.png', ...(agentOffice === undefined ? {} : { agentOffice }) }));
      write(d, `${id}/sheet.png`, PNG);
      if (sleepFile) write(d, `${id}/${sleepFile}`, sleepData);
    };
    pet('ok', { sleepSheetPath: 'sleep.webp' });
    pet('okpng', { sleepSheetPath: 'sub/Sleep.PNG' }, 'sub/Sleep.PNG');
    pet('none');
    pet('emptyobj', {});
    pet('dotdot', { sleepSheetPath: '../ok/sleep.webp' });
    pet('abs', { sleepSheetPath: path.join(outside, 'z.png') });
    pet('gif', { sleepSheetPath: 'sleep.gif' }, 'sleep.gif');
    pet('missing', { sleepSheetPath: 'nope.webp' }, null);
    pet('nonstring', { sleepSheetPath: 7 });
    pet('notobj', 'sleep.webp');
    pet('big', { sleepSheetPath: 'sleep.webp' }, 'sleep.webp', Buffer.alloc(8 * 1024 * 1024 + 1));
    pet('linked', { sleepSheetPath: 'link/z.png' }, null);
    try { fs.symlinkSync(outside, path.join(d, 'linked', 'link'), 'junction'); } catch { /* 연결을 만들 수 없는 환경 */ }
  });
  const ok = readPet(dir, 'ok');
  assert.deepEqual(ok.bytes, PNG);
  assert.deepEqual(ok.sleepBytes, SLEEP);
  assert.equal(ok.sleepType, 'image/webp');
  const okpng = readPet(dir, 'okpng');
  assert.equal(okpng.sleepType, 'image/png');
  assert.deepEqual(okpng.sleepBytes, SLEEP);
  // 자는 그림이 없거나 잘못돼도 본 그림은 그대로 — sleep 쪽만 빠진다
  for (const id of ['none', 'emptyobj', 'dotdot', 'abs', 'gif', 'missing', 'nonstring', 'notobj', 'big']) {
    const r = readPet(dir, id);
    assert.ok(r, id);
    assert.deepEqual(r.bytes, PNG, id);
    assert.equal(r.sleepBytes, undefined, id);
    assert.equal(r.sleepType, undefined, id);
  }
  if (fs.existsSync(path.join(dir, 'linked', 'link'))) {
    const r = readPet(dir, 'linked');
    assert.ok(r);
    assert.equal(r.sleepBytes, undefined, '폴더 밖을 가리키는 연결');
  }
});

test('readPet: 파일 시스템 오류는 밖으로 던지지 않는다', () => {
  const broken = { statSync() { throw new Error('boom'); }, readFileSync() { throw new Error('boom'); }, realpathSync() { throw new Error('boom'); } };
  assert.equal(readPet('C:\\nowhere', 'abc', broken), null);
});

// ───────────────────────── 권한 카드 (허용·거부) ─────────────────────────

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';
const perm = (permId, at, extra = {}) => ({ key: `k${at}`, tabId: `t${at}`, label: `탭${at}`, reason: 'permission', kind: 'alert', text: '❓ 권한 확인', at,
  permId, tool: 'Bash', preview: 'npm test', canAnswer: !!permId, ...extra });

const HELD = { tool: 'Bash', input: { command: 'npm test' } }; // 서버가 보류할 때 받은 도구·입력

// 카드 미리보기 규칙: main(petRules)과 renderer(model.js)가 같은 입력에 같은 결과를 내야 한다.
const edge160 = 'x'.repeat(160);
const ch = (n) => String.fromCharCode(n);
const PREVIEW_TABLE = [
  ['Bash', { command: 'npm test' }, 'npm test'],
  ['PowerShell', { command: 'Get-ChildItem' }, 'Get-ChildItem'],
  ['Read', { file_path: 'C:\\a\\b.txt' }, 'C:\\a\\b.txt'],
  ['Glob', { pattern: '**/*.js' }, null], // 검색 위치(path)가 카드에 안 보여 안내만
  ['Grep', { pattern: 'foo.*bar' }, null],
  ['Grep', { pattern: 'foo', path: 'C:\\secret' }, null],
  ['Bash', { command: 'npm test', dangerouslyDisableSandbox: true }, null], // 허용 밖 키
  ['Bash', { command: 'npm test', description: 'd', timeout: 5, run_in_background: false }, 'npm test'],
  ['Bash', { command: 'npm test', description: '테스트' }, 'npm test'], // Codex 권한 요청 tool_input
  ['PowerShell', { command: 'ls', description: 'd', timeout: 5, run_in_background: true }, 'ls'],
  ['PowerShell', { command: 'ls', cwd: 'C:\\' }, null],
  ['Read', { file_path: 'a.txt', offset: 1, limit: 10 }, 'a.txt'],
  ['Read', { file_path: 'a.txt', pages: '1' }, null],
  ['LS', { path: 'C:\\proj', ignore: ['x'] }, null],
  ['WebFetch', { url: 'https://example.com', prompt: 'p' }, 'https://example.com'],
  ['WebFetch', { url: 'https://example.com', extra: 1 }, null],
  ['WebSearch', { query: 'q', allowed_domains: ['a'] }, null],
  ['WebFetch', { url: 'https://example.com/x' }, 'https://example.com/x'],
  ['WebSearch', { query: '펫 카드' }, '펫 카드'],
  ['LS', { path: 'C:\\proj' }, 'C:\\proj'],
  ['Bash', { command: edge160 }, edge160], // 160자는 허용
  ['Bash', { command: edge160 + 'x' }, null], // 161자
  ['Bash', { command: 'a\nb\nc\nd' }, 'a\nb\nc\nd'], // 줄바꿈 3개까지
  ['Bash', { command: 'a\nb\nc\nd\ne' }, null],
  ['Bash', { command: 'a\r\nb\r\nc\r\nd\r\ne' }, null],
  ['Bash', { command: 'rm -rf x…' }, null], // 잘림 표시
  ['Bash', { command: '' }, null],
  ['Bash', { command: '   ' }, null],
  ['Bash', { command: 5 }, null],
  ['Bash', { command: ['ls'] }, null],
  ['Bash', { description: 'npm test' }, null], // 실행 필드가 아님
  ['Bash', { file_path: 'x', command: undefined }, null],
  ['Read', { command: 'x' }, null], // 도구마다 정해진 필드만
  ['Bash', 'npm test', null],
  ['Bash', null, null],
  ['Bash', undefined, null],
  ['Write', { file_path: 'a.txt', content: 'x' }, null],
  ['Edit', { file_path: 'a.txt' }, null],
  ['MultiEdit', { file_path: 'a.txt' }, null],
  ['NotebookEdit', { notebook_path: 'a.ipynb' }, null],
  ['apply_patch', { command: '*** Begin Patch' }, null],
  ['mcp__x__y', { command: 'x' }, null],
  ['AskUserQuestion', { question: 'q', command: 'x' }, null],
  ['ExitPlanMode', { plan: 'p' }, null],
  ['toString', { command: 'x' }, null], // 프로토타입 속성 이름
  ['__proto__', {}, null],
  [undefined, { command: 'x' }, null],
  [5, { command: 'x' }, null],
  ['Bash', { command: 'ls\u202Ersuoh' }, null], // 양방향 제어 문자
  ['Bash', { command: 'a\u200Bb' }, null], // 폭 0 공백
  ['Bash', { command: 'a\u2066b' }, null],
  ['Bash', { command: 'a\u200Fb' }, null],
  // \uC81C\uC5B4\u00B7\uBCF4\uC774\uC9C0 \uC54A\uB294 \uBB38\uC790 \uACBD\uACC4 (\uBB38\uC790 \uCF54\uB4DC\uB85C \uB9CC\uB4E0\uB2E4)
  ['Bash', { command: `a${ch(0x200C)}b` }, null],
  ['Bash', { command: `a${ch(0x202B)}b` }, null],
  ['Bash', { command: `a${ch(0x2067)}b` }, null],
  ['Bash', { command: `a${ch(0x2028)}b` }, null],
  ['Bash', { command: `a${ch(0x2029)}b` }, null],
  ['Bash', { command: `a${ch(0xFEFF)}b` }, null],
  ['Bash', { command: `a${ch(0x00AD)}b` }, null],
  ['Bash', { command: `a${ch(0x0085)}b` }, null],
  ['Bash', { command: 'a\x1bb' }, null],
  ['Bash', { command: 'a\x00b' }, null],
  ['Bash', { command: 'a\x7fb' }, null],
  ['Bash', { command: `a${ch(0x200A)}b` }, `a${ch(0x200A)}b`], // \uACBD\uACC4 \uBC14\uB85C \uBC16\uC740 \uD5C8\uC6A9
  ['Bash', { command: `a${ch(0x202F)}b` }, `a${ch(0x202F)}b`],
  ['Bash', { command: 'a\tb' }, 'a\tb'],
];

test('cardPreview: 허용 목록 도구의 실행 필드 전체만 — 길이·줄 수·잘림·제어 문자 조건', () => {
  for (const [tool, input, want] of PREVIEW_TABLE) assert.equal(cardPreview(tool, input), want, `${String(tool)} ${JSON.stringify(input)}`);
});

test('cardPreview: main(petRules)과 renderer(model.js)의 결과가 같다', () => {
  for (const [tool, input] of PREVIEW_TABLE) assert.equal(cardPreviewUi(tool, input), cardPreview(tool, input), `${String(tool)} ${JSON.stringify(input)}`);
});

test('answerableIds: claude·codex 에서 canAnswer 이고 permId 가 있는 항목만', () => {
  const kinds = {
    claude: { attention: [perm(ID1, 1), perm(ID2, 2, { canAnswer: false }), perm(null, 3, { canAnswer: true }), item('done')] },
    codex: { attention: [perm(ID3, 4)] },
    other: { attention: [perm('44444444-4444-4444-8444-444444444444', 5)] },
  };
  assert.deepEqual([...answerableIds(kinds)].sort(), [ID1, ID3]);
  assert.equal(answerableIds(undefined).size, 0);
  assert.equal(answerableIds({ claude: { attention: 'x' }, codex: null }).size, 0);
});

test('answerableIds(kinds, pending): 서버가 보류한 도구·입력으로 만든 미리보기와 정확히 같을 때만', () => {
  const kinds = (extra) => ({ claude: { attention: [perm(ID1, 1, extra)] } });
  const pend = (o = {}) => [{ id: ID1, at: 1, ...HELD, ...o }];
  assert.deepEqual([...answerableIds(kinds(), pend())], [ID1]);
  assert.equal(answerableIds(kinds(), []).size, 0, '서버에 보류 중이 아니면');
  assert.equal(answerableIds(kinds(), [{ id: ID2, at: 1, ...HELD }]).size, 0, '다른 permId');
  assert.equal(answerableIds(kinds({ preview: 'rm -rf /' }), pend()).size, 0, '카드의 미리보기가 서버 입력과 다르면');
  assert.equal(answerableIds(kinds(), pend({ tool: 'Write' })).size, 0, '서버의 도구가 허용 목록 밖');
  assert.equal(answerableIds(kinds(), pend({ tool: 'PowerShell' })).size, 0, '서버의 도구가 항목의 도구와 다르면');
  assert.equal(answerableIds(kinds(), pend({ input: { command: 'npm test', description: 'd' } })).size, 1, '허용 키(description)가 더 있어도');
  assert.equal(answerableIds(kinds(), pend({ input: { command: 'npm test', extra: 1 } })).size, 0, '허용 밖 키가 있으면');
  assert.equal(answerableIds(kinds(), pend({ input: { command: 'x'.repeat(200) } })).size, 0, '서버 입력이 길면');
  assert.equal(answerableIds(kinds(), pend({ input: undefined })).size, 0);
  assert.equal(answerableIds(kinds({ canAnswer: false }), pend()).size, 0);
});

test('permsToRelease: 2초 유예 · 한 번 나타났다 빠지면 바로 · 답할 수 있으면 유지', () => {
  const seen = new Set();
  const pending = [{ id: ID1, at: 1000 }, { id: ID2, at: 1000 }];
  // 유예 안: 아직 나타나지 않았어도 풀지 않는다
  assert.deepEqual(permsToRelease(pending, new Set(), seen, 1500), []);
  assert.equal(seen.size, 0);
  // ID1 이 나타남 → 유지하고 seen 에 기록
  assert.deepEqual(permsToRelease(pending, new Set([ID1]), seen, 1600), []);
  assert.deepEqual([...seen], [ID1]);
  // 나타났다가 빠지면 유예와 상관없이 즉시
  assert.deepEqual(permsToRelease(pending, new Set(), seen, 1700), [ID1]);
  // 끝내 나타나지 않은 ID2 는 2초가 지나면 푼다 (딱 2초부터)
  assert.deepEqual(permsToRelease([pending[1]], new Set(), seen, 2999), []);
  assert.deepEqual(permsToRelease([pending[1]], new Set(), seen, 3000), [ID2]);
  assert.deepEqual(permsToRelease([pending[1]], new Set([ID2]), seen, 99999), []); // 계속 답할 수 있으면 오래돼도 유지
  assert.deepEqual(permsToRelease(undefined, new Set(), seen, 1), []);
  assert.deepEqual(permsToRelease([{ id: ID1, at: 0 }], new Set(), new Set(), 100, 50), [ID1]); // graceMs 지정
});

test('펫 상태 정리: permId 형식·길이 제한·canAnswer 재확인', () => {
  const big = 'x'.repeat(500);
  const kinds = sanitizeKinds({ claude: { attention: [
    perm(ID1, 1), perm('not-a-uuid', 2), perm(ID2, 3, { tool: 'T'.repeat(100), preview: big }),
    perm(ID3, 4, { preview: `${'y'.repeat(300)}…` }), perm(ID1, 5, { preview: '' }), perm(ID2, 6, { tool: 'AskUserQuestion' }),
    perm(ID2, 7, { tool: 'ExitPlanMode' }), perm(ID2, 8, { canAnswer: 'yes' }), perm('../../x', 9), perm(5, 10),
  ] } });
  const a = kinds.claude.attention;
  assert.equal(a[0].permId, ID1);
  assert.equal(a[0].canAnswer, true);
  assert.equal(a[0].tool, 'Bash');
  assert.equal(a[0].preview, 'npm test');
  assert.equal(a[1].permId, null);
  assert.equal(a[1].canAnswer, false, 'permId 형식이 틀리면 canAnswer 도 거짓');
  assert.equal(a[2].tool.length, 60);
  assert.equal(a[2].preview.length, 300);
  assert.equal(a[2].canAnswer, false, '300자를 넘어 잘린 명령은 허용할 수 없다');
  assert.equal(a[3].canAnswer, false, '… 로 끝나는(잘린) 명령');
  assert.equal(a[4].canAnswer, false, '미리보기가 비어 있으면');
  assert.equal(a[5].canAnswer, false, 'AskUserQuestion');
  assert.equal(a[6].canAnswer, false, 'ExitPlanMode');
  assert.equal(a[7].canAnswer, false, 'boolean true 가 아니면');
  assert.equal(a[8].permId, null);
  assert.equal(a[9].permId, null);
  assert.deepEqual(kinds.codex, { working: false, attention: [] });
  const more = sanitizeKinds({ claude: { attention: [
    perm(ID1, 1, { tool: 'Write' }), perm(ID1, 2, { preview: 'x'.repeat(161) }), perm(ID1, 3, { preview: 'x'.repeat(160) }),
    perm(ID1, 4, { preview: 'a\nb\nc\nd\ne' }), perm(ID1, 5, { preview: 'a\u202Eb' }), perm(ID1, 6, { tool: 'Read', preview: 'C:\\a.txt' }),
  ] } }).claude.attention;
  assert.deepEqual(more.map((x) => x.canAnswer), [false, false, true, false, false, true]);
  const plain = sanitizeKinds({ claude: { attention: [item('done')] } }).claude.attention[0];
  assert.deepEqual([plain.permId, plain.tool, plain.preview, plain.canAnswer], [null, '', '', false]);
});

test('cardOf: 답할 수 있는 가장 오래된 권한 요청 우선 · 없으면 가장 최근 · 외 n건', () => {
  assert.equal(cardOf(), null);
  assert.equal(cardOf({ attention: [] }), null);
  assert.equal(cardOf({ attention: [item('done')] }), null);
  assert.equal(cardOf({ attention: [item('alert', { reason: 'question' })] }), null);
  const c = cardOf({ attention: [perm(ID2, 5), perm(ID1, 2), perm(ID3, 9), item('done')] });
  assert.deepEqual(c, { permId: ID1, tool: 'Bash', preview: 'npm test', canAnswer: true, label: '탭2', key: 'k2', tabId: 't2', more: 2 });
  // 새 항목이 더 와도 가장 오래된 것이 유지된다
  assert.equal(cardOf({ attention: [perm(ID1, 2), perm(ID3, 9), perm(ID2, 12)] }).permId, ID1);
  // 답할 수 없는 항목은 건너뛴다
  assert.equal(cardOf({ attention: [perm(ID1, 2, { canAnswer: false }), perm(ID2, 5)] }).permId, ID2);
  // 하나도 없으면 가장 최근 것 (안내용)
  const hint = cardOf({ attention: [perm(null, 2, { label: '오래된' }), perm(null, 7, { label: '최근' })] });
  assert.deepEqual(hint, { permId: null, tool: 'Bash', preview: 'npm test', canAnswer: false, label: '최근', key: 'k7', tabId: 't7', more: 1 });
  assert.equal(cardOf({ attention: [perm(ID1, 2, { permId: null, canAnswer: true })] }).canAnswer, false, 'permId 없으면 답할 수 없다');
  assert.equal(cardOf({ attention: [{ reason: 'permission', at: 1 }] }).tool, '');
});

// 펫 컨트롤러의 권한 보류 연결: electron 없이 가짜 창·IPC 로 점검한다.
function petFixture({ mode = 'always', onUsageRefresh, sprites, builtinPetsDir, userDataDir = os.tmpdir() } = {}) {
  const handlers = new Map();
  const ipcMain = { on: (ch, fn) => handlers.set(ch, fn), handle: (ch, fn) => handlers.set(ch, fn) };
  const wins = [];
  class FakeWindow {
    constructor() {
      this.gone = false; this.visible = false; this.listeners = {}; this.sent = [];
      this.wc = { handlers: {}, on: (n, f) => { this.wc.handlers[n] = f; }, send: (ch, payload) => { this.sent.push([ch, payload]); }, setWindowOpenHandler() {} };
      this.webContents = this.wc; wins.push(this);
    }
    loadURL() {} isDestroyed() { return this.gone; } on(n, f) { this.listeners[n] = f; } setIgnoreMouseEvents() {}
    showInactive() { this.visible = true; } isVisible() { return this.visible; } hide() { this.visible = false; }
    destroy() { this.gone = true; this.listeners.closed?.(); } setBounds() {} getBounds() { return { x: 0, y: 0, width: 1, height: 1 }; }
  }
  const main = { isDestroyed: () => false, webContents: {} };
  const screen = { getAllDisplays: () => [], getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }), on() {} };
  const pendingList = [];
  const log = { resolved: [], releaseAll: 0 };
  const permissions = {
    pending: () => pendingList.map((p) => ({ ...p })),
    resolve: (id, d) => { const i = pendingList.findIndex((p) => p.id === id); if (i < 0) return false; pendingList.splice(i, 1); log.resolved.push([id, d]); return true; },
    releaseAll: () => { log.releaseAll++; pendingList.splice(0).forEach((p) => log.resolved.push([p.id, null])); },
  };
  const config = { pet: { mode, ...(sprites ? { sprites } : {}) } };
  const saved = [];
  const pet = createPetController({
    ipcMain, screen, BrowserWindow: FakeWindow, getMainWindow: () => main, showMainWindow() {}, sendMain() {},
    config, saveConfig: (c) => saved.push(JSON.stringify(c.pet)), isCodexAvailable: () => true, userDataDir, permissions, onUsageRefresh, builtinPetsDir,
  });
  const push = (kinds) => handlers.get('pet:state')({ sender: main.webContents }, { kinds });
  const perm$ = (sender, p) => handlers.get('pet:perm')({ sender }, p);
  return { pet, wins, handlers, main, pendingList, log, permissions, push, perm$, config, saved };
}

test('펫 컨트롤러: 창이 다 불러와지기 전·펫 끄기에서는 카드로 답할 수 없다', () => {
  const f = petFixture();
  try {
    assert.equal(f.pet.canAnswer(), false, '창이 아직 없다');
    f.pet.refresh();
    assert.equal(f.pet.canAnswer(), false, '창은 있지만 아직 불러오는 중');
    f.wins[0].wc.handlers['did-finish-load']();
    assert.equal(f.pet.canAnswer(), true);
    f.pet.setMode('off');
    assert.equal(f.pet.canAnswer(), false);
  } finally { f.pet.shutdown(); }
  assert.equal(f.pet.canAnswer(), false, '종료 뒤');
  const none = createPetController({ ipcMain: { on() {}, handle() {} }, screen: { on() {} }, BrowserWindow: class {}, getMainWindow: () => null, showMainWindow() {}, sendMain() {},
    config: { pet: { mode: 'off' } }, saveConfig() {}, isCodexAvailable: () => false, userDataDir: os.tmpdir() });
  none.setState({ kinds: {} }); none.watchPermissions(); none.shutdown(); // permissions 가 없으면 기능이 꺼져 있을 뿐 오류가 없다
});

test('펫 컨트롤러: pet:perm 은 펫 창에서 온 것 · 답할 수 있는 permId · 허용/거부일 때만 전달', () => {
  const f = petFixture();
  try {
    f.pet.refresh();
    f.wins[0].wc.handlers['did-finish-load']();
    const petWc = f.wins[0].wc;
    f.pendingList.push({ ...HELD, id: ID1, at: Date.now() }, { ...HELD, id: ID2, at: Date.now() });
    f.push({ claude: { attention: [perm(ID1, 1), perm(ID2, 2, { canAnswer: false })] } });
    f.perm$(f.main.webContents, { permId: ID1, decision: 'allow' }); // 메인 창에서 온 것
    f.perm$({}, { permId: ID1, decision: 'allow' }); // 모르는 보낸 쪽
    f.perm$(petWc, { permId: ID2, decision: 'allow' }); // 답할 수 없는 항목
    f.perm$(petWc, { permId: ID3, decision: 'allow' }); // 상태에 없는 permId
    f.perm$(petWc, { permId: ID1, decision: 'always' }); // 허용/거부가 아닌 값
    f.perm$(petWc, { permId: ID1, decision: undefined });
    f.perm$(petWc, { permId: 5, decision: 'allow' });
    f.perm$(petWc, null);
    f.perm$(petWc, 'allow');
    assert.deepEqual(f.log.resolved, []);
    f.perm$(petWc, { permId: ID1, decision: 'deny' });
    assert.deepEqual(f.log.resolved, [[ID1, 'deny']]);
    f.perm$(petWc, { permId: ID1, decision: 'allow' }); // 이미 풀린 요청에는 서버가 거절한다
    assert.deepEqual(f.log.resolved, [[ID1, 'deny']]);
  } finally { f.pet.shutdown(); }
});

test('펫 컨트롤러: 펫에 보내는 canAnswer 는 서버가 보류한 요청과 대조한 결과다', () => {
  const f = petFixture();
  try {
    f.pet.refresh();
    f.wins[0].wc.handlers['did-finish-load']();
    f.pendingList.push({ ...HELD, id: ID1, at: Date.now() }, { ...HELD, tool: 'Bash', input: { command: 'npm test', dangerouslyDisableSandbox: true }, id: ID2, at: Date.now() });
    f.push({ claude: { attention: [perm(ID1, 1), perm(ID2, 2), perm(ID3, 3)] } }); // ID2: 서버 입력에 허용 밖 키, ID3: 서버에 보류 중이 아님
    const sent = f.wins[0].sent.filter(([ch]) => ch === 'pet:state').at(-1)[1];
    assert.deepEqual(sent.kinds.claude.attention.map((x) => x.canAnswer), [true, false, false]);
  } finally { f.pet.shutdown(); }
});

test('펫 컨트롤러: 펫 상태와 대조해 — 유예 안에는 유지, 나타났다 빠지면 즉시, 끝내 안 나타나면 2초 뒤 {} 로 푼다', () => {
  const f = petFixture();
  try {
    f.pet.refresh();
    f.wins[0].wc.handlers['did-finish-load']();
    const now = Date.now();
    f.pendingList.push({ ...HELD, id: ID1, at: now }, { ...HELD, id: ID2, at: now - 5000 });
    f.push({ claude: { attention: [] } });
    assert.deepEqual(f.log.resolved, [[ID2, null]], '2초 넘게 안 나타난 요청만 푼다');
    f.push({ claude: { attention: [perm(ID1, 1)] } });
    assert.deepEqual(f.log.resolved, [[ID2, null]]);
    f.push({ claude: { attention: [perm(ID1, 1)] }, codex: { attention: [] } });
    assert.equal(f.pendingList.length, 1, '답할 수 있는 동안은 유지');
    f.push({ claude: { attention: [perm(ID1, 1, { canAnswer: false, permId: null })] } }); // 렌더러가 안내로 바꿈
    assert.deepEqual(f.log.resolved, [[ID2, null], [ID1, null]], '나타났다가 빠지면 즉시 푼다');
    assert.equal(f.pendingList.length, 0);
  } finally { f.pet.shutdown(); }
});

test('펫 컨트롤러: 서버가 보류한 도구·입력이 카드의 미리보기와 다르면 답할 수 없고 대조에서 풀린다', () => {
  const f = petFixture();
  try {
    f.pet.refresh();
    f.wins[0].wc.handlers['did-finish-load']();
    const petWc = f.wins[0].wc;
    f.pendingList.push({ id: ID1, at: Date.now(), tool: 'Write', input: { file_path: 'a.txt' } }, { ...HELD, id: ID2, at: Date.now() });
    f.push({ claude: { attention: [perm(ID1, 1), perm(ID2, 2, { preview: 'rm -rf /' })] } });
    f.perm$(petWc, { permId: ID1, decision: 'allow' });
    f.perm$(petWc, { permId: ID2, decision: 'allow' });
    assert.ok(f.log.resolved.every(([, d]) => d !== 'allow'), '불일치 요청은 허용으로 전달되지 않는다');
    f.pendingList.length = 0;
    f.pendingList.push({ ...HELD, id: ID1, at: Date.now() - 5000, tool: 'Write', input: {} });
    f.push({ claude: { attention: [perm(ID1, 1)] } });
    assert.deepEqual(f.log.resolved.at(-1), [ID1, null], '불일치면 유예 뒤 {} 로 풀린다');
  } finally { f.pet.shutdown(); }
});

test('펫 컨트롤러: 감시 타이머가 상태 변화 없이도 유예가 지난 요청을 푼다', async () => {
  const f = petFixture();
  try {
    f.pet.refresh();
    f.wins[0].wc.handlers['did-finish-load']();
    f.pendingList.push({ ...HELD, id: ID1, at: Date.now() - 1500 });
    f.pet.watchPermissions();
    f.pet.watchPermissions(); // 타이머는 하나
    await sleep(2200);
    assert.deepEqual(f.log.resolved, [[ID1, null]]);
  } finally { f.pet.shutdown(); }
});

test('펫 컨트롤러: 펫이 답할 수 없게 되면(끄기·창 닫힘·화면 사망·종료) 붙잡은 요청을 모두 푼다', () => {
  const cases = {
    끄기: (f) => f.pet.setMode('off'),
    종료: (f) => f.pet.shutdown(),
    destroy: (f) => f.pet.destroy(),
    '화면 사망': (f) => f.wins[0].wc.handlers['render-process-gone'](),
    '창 닫힘': (f) => f.wins[0].listeners.closed(),
  };
  for (const [name, act] of Object.entries(cases)) {
    const f = petFixture();
    try {
      f.pet.refresh();
      f.wins[0].wc.handlers['did-finish-load']();
      f.pendingList.push({ ...HELD, id: ID1, at: Date.now() });
      f.push({ claude: { attention: [perm(ID1, 1)] } });
      assert.equal(f.pendingList.length, 1, name);
      act(f);
      assert.equal(f.pendingList.length, 0, `${name}: 풀려야 함`);
      assert.deepEqual(f.log.resolved, [[ID1, null]], name);
    } finally { f.pet.shutdown(); }
  }
});

test('펫 컨트롤러: 연결이 끊긴 탭의 상태가 지워지면(clearState) 답할 수 없어 요청을 푼다', () => {
  const f = petFixture();
  try {
    f.pet.refresh();
    f.wins[0].wc.handlers['did-finish-load']();
    f.pendingList.push({ ...HELD, id: ID1, at: Date.now() });
    f.push({ claude: { attention: [perm(ID1, 1)] } });
    f.pet.clearState();
    assert.deepEqual(f.log.resolved, [[ID1, null]]);
  } finally { f.pet.shutdown(); }
});

// ───────────────────────── 사용량 패널 ─────────────────────────

const usageRow = (extra = {}) => ({ id: 'session', label: '세션', percent: 58, resetsAt: 1000, resetsText: null, observedAt: 500, ...extra });

test('sanitizeUsage: 알려진 필드만 · 줄 수·글 길이·숫자 범위를 제한한다', () => {
  const empty = { claude: { rows: [], error: null, updatedAt: null }, codex: { rows: [], error: null, updatedAt: null }, session: null, refresh: { busy: false, nextAllowedAt: null, lastRunAt: null } };
  for (const bad of [undefined, null, 5, 'x', []]) assert.deepEqual(sanitizeUsage(bad), empty, String(bad));
  const snap = sanitizeUsage({
    claude: { rows: Array.from({ length: 9 }, (_, i) => usageRow({ id: `model:${i}`, label: 'L'.repeat(50), percent: 150.6, resetsText: 'T'.repeat(80), extra: 'x' })), error: 'E'.repeat(200), updatedAt: 7, junk: 1 },
    codex: { rows: [usageRow({ percent: -3 }), usageRow({ percent: null }), usageRow({ percent: NaN }), usageRow({ percent: '5' }), usageRow({ resetsAt: Infinity, observedAt: 'x' }), null, 'row'], error: null, updatedAt: '5' },
    session: { kind: 'codex', label: 'S'.repeat(90), requests: 3.9, contextPercent: 130, extra: 1 },
    refresh: { busy: true, nextAllowedAt: 123, lastRunAt: NaN, extra: 1 },
    extra: { evil: true },
  });
  assert.equal(snap.claude.rows.length, 6);
  assert.equal(snap.claude.rows[0].label.length, 40);
  assert.equal(snap.claude.rows[0].resetsText.length, 60);
  assert.equal(snap.claude.rows[0].percent, 100);
  assert.deepEqual(Object.keys(snap.claude.rows[0]).sort(), ['id', 'label', 'observedAt', 'percent', 'resetsAt', 'resetsText']);
  assert.equal(snap.claude.error.length, 120);
  assert.deepEqual([snap.claude.updatedAt, snap.codex.updatedAt], [7, null]);
  assert.deepEqual(snap.codex.rows.map((r) => r.percent), [0, null, null, null, 58]);
  assert.deepEqual([snap.codex.rows[4].resetsAt, snap.codex.rows[4].observedAt], [null, null]);
  assert.deepEqual(snap.session, { kind: 'codex', label: 'S'.repeat(60), requests: 3, contextPercent: 100 });
  assert.deepEqual(snap.refresh, { busy: true, nextAllowedAt: 123, lastRunAt: null });
  assert.equal('extra' in snap, false);
  assert.deepEqual(sanitizeUsage({ session: { kind: 'collab', label: 'x', requests: 1 } }).session, null, '협업은 세션 줄이 없다');
  assert.deepEqual(sanitizeUsage({ session: { kind: 'claude', label: 'x', requests: -4, contextPercent: null } }).session, { kind: 'claude', label: 'x', requests: 0, contextPercent: null });
  assert.equal(sanitizeUsage({ refresh: { busy: 'yes' } }).refresh.busy, false);
});

test('usageRowText: 리셋까지 24시간 안이면 남은 시간 · 넘으면 요일과 시각', () => {
  const now = new Date(2026, 9, 29, 12, 0, 0).getTime();
  const min = 60000;
  const at = (ms, extra = {}) => usageRowText(usageRow({ resetsAt: now + ms, ...extra }), now);
  assert.deepEqual(at(133 * min), { pct: '58% 사용', reset: '리셋 2시간 13분 후' });
  assert.equal(at(13 * min).reset, '리셋 13분 후');
  assert.equal(at(120 * min).reset, '리셋 2시간 후');
  assert.equal(at(59 * 1000).reset, '곧 리셋');
  assert.equal(at(24 * 60 * min).reset, '리셋 24시간 후');
  const far = at(24 * 60 * min + min).reset;
  assert.match(far, /^\([일월화수목금토]\) (오전|오후) \d{1,2}:\d{2} 재설정$/);
  // 정확한 요일·시각 (실행 환경 시간대와 상관없이 지역 시각으로 만든 값이라 항상 같다): 2026-10-31 토요일 07:00
  assert.equal(usageRowText(usageRow({ resetsAt: new Date(2026, 9, 31, 7, 0).getTime() }), now).reset, '(토) 오전 7:00 재설정');
  // 리셋 시각이 지났으면 값은 지난 창의 것 — 퍼센트가 남아 있어도 「리셋됨」
  assert.deepEqual(at(-1), { pct: '리셋됨', reset: '리셋됨' });
  assert.deepEqual(at(0), { pct: '리셋됨', reset: '리셋됨' });
  assert.deepEqual(at(-5 * min, { percent: null }), { pct: '리셋됨', reset: '리셋됨' });
  // 리셋 시각이 없는 줄
  assert.deepEqual(usageRowText(usageRow({ percent: null, resetsAt: null }), now), { pct: '알 수 없음', reset: '' });
  assert.deepEqual(usageRowText(usageRow({ percent: 0, resetsAt: null }), now), { pct: '0% 사용', reset: '' });
  assert.deepEqual(usageRowText(usageRow({ resetsAt: null, resetsText: 'Nov 1, 7am (Asia/Seoul)' }), now), { pct: '58% 사용', reset: 'Nov 1, 7am (Asia/Seoul) 재설정' });
  assert.deepEqual(usageRowText(usageRow({ percent: null, resetsAt: now + 30 * min }), now), { pct: '알 수 없음', reset: '리셋 30분 후' });
  assert.deepEqual(usageRowText(undefined, now), { pct: '알 수 없음', reset: '' });
});

test('updatedText: 방금 · n분 전 · n시간 전 · 갱신 전', () => {
  const now = 10 * 3600000;
  const min = 60000;
  assert.equal(updatedText(null, now), '갱신 전');
  assert.equal(updatedText(undefined, now), '갱신 전');
  assert.equal(updatedText(NaN, now), '갱신 전');
  assert.equal(updatedText(now, now), '방금 갱신');
  assert.equal(updatedText(now - 59 * 1000, now), '방금 갱신');
  assert.equal(updatedText(now + 5 * min, now), '방금 갱신', '시계가 어긋나도 음수가 나오지 않는다');
  assert.equal(updatedText(now - min, now), '1분 전 갱신');
  assert.equal(updatedText(now - 59 * min, now), '59분 전 갱신');
  assert.equal(updatedText(now - 60 * min, now), '1시간 전 갱신');
  assert.equal(updatedText(now - 150 * min, now), '2시간 전 갱신');
});

test('refreshButton · sessionText', () => {
  const now = 1000000;
  assert.deepEqual(refreshButton({ busy: false, nextAllowedAt: null }, now), { disabled: false, title: '사용량 다시 읽기' });
  assert.deepEqual(refreshButton(undefined, now), { disabled: false, title: '사용량 다시 읽기' });
  assert.equal(refreshButton({ busy: true, nextAllowedAt: null }, now).disabled, true);
  assert.deepEqual(refreshButton({ busy: false, nextAllowedAt: now + 4 * 60000 + 1 }, now), { disabled: true, title: '5분 뒤 다시 갱신할 수 있어요' });
  assert.equal(refreshButton({ busy: false, nextAllowedAt: now }, now).disabled, false, '허용 시각이 되면 열린다');
  assert.equal(refreshButton({ busy: false, nextAllowedAt: now - 1 }, now).disabled, false);
  assert.equal(sessionText({ kind: 'claude', label: 'proj', requests: 3, contextPercent: 41 }), 'proj · 요청 3회 · 컨텍스트 41%');
  assert.equal(sessionText({ kind: 'codex', label: 'proj', requests: 0, contextPercent: null }), 'proj · 요청 0회 · 컨텍스트 —');
});

test('펫 컨트롤러: setUsage 는 정리해서 pet:usage 로 보내고, 창이 새로 뜨면 다시 보낸다', () => {
  const f = petFixture();
  try {
    f.pet.setUsage({ claude: { rows: [usageRow()], error: null, updatedAt: 9 }, extra: 1 }); // 창이 아직 없다
    f.pet.refresh();
    assert.equal(f.wins[0].sent.filter(([ch]) => ch === 'pet:usage').length, 0, '다 불러오기 전에는 보내지 않는다');
    f.wins[0].wc.handlers['did-finish-load']();
    const first = f.wins[0].sent.filter(([ch]) => ch === 'pet:usage');
    assert.equal(first.length, 1);
    assert.equal(first[0][1].expanded, true);
    assert.equal(first[0][1].claude.rows[0].percent, 58);
    assert.equal('extra' in first[0][1], false);
    f.pet.setUsage({ claude: { rows: [usageRow({ percent: 70 })], error: null, updatedAt: 10 } });
    const sent = f.wins[0].sent.filter(([ch]) => ch === 'pet:usage');
    assert.equal(sent.length, 2);
    assert.equal(sent[1][1].claude.rows[0].percent, 70);
    // 화면이 죽어 새 창이 뜨면 마지막 스냅샷을 다시 보낸다
    f.wins[0].wc.handlers['render-process-gone']();
    assert.equal(f.wins.length, 2);
    f.wins[1].wc.handlers['did-finish-load']();
    assert.equal(f.wins[1].sent.filter(([ch]) => ch === 'pet:usage').at(-1)[1].claude.rows[0].percent, 70);
  } finally { f.pet.shutdown(); }
  const none = petFixture();
  try { none.pet.refresh(); none.wins[0].wc.handlers['did-finish-load'](); assert.equal(none.wins[0].sent.filter(([ch]) => ch === 'pet:usage').length, 0, '스냅샷이 없으면 보내지 않는다'); } finally { none.pet.shutdown(); }
});

test('펫 컨트롤러: pet:usage:toggle 은 펫 창의 boolean 만 — 저장하고 다시 보낸다 · pet:usage:refresh 는 펫 창에서만', () => {
  let refreshed = 0;
  const f = petFixture({ onUsageRefresh: () => { refreshed++; } });
  try {
    f.pet.refresh();
    f.wins[0].wc.handlers['did-finish-load']();
    f.pet.setUsage({});
    const petWc = f.wins[0].wc;
    const saves = f.saved.length;
    const pushes = () => f.wins[0].sent.filter(([ch]) => ch === 'pet:usage');
    const before = pushes().length;
    f.handlers.get('pet:usage:toggle')({ sender: f.main.webContents }, false); // 메인 창에서 온 것
    f.handlers.get('pet:usage:toggle')({ sender: {} }, false);
    f.handlers.get('pet:usage:toggle')({ sender: petWc }, 'false'); // boolean 이 아님
    f.handlers.get('pet:usage:toggle')({ sender: petWc }, undefined);
    assert.equal(f.config.pet.usage.expanded, true);
    assert.equal(f.saved.length, saves);
    f.handlers.get('pet:usage:toggle')({ sender: petWc }, false);
    assert.equal(f.config.pet.usage.expanded, false);
    assert.equal(f.saved.length, saves + 1);
    assert.equal(JSON.parse(f.saved.at(-1)).usage.expanded, false);
    const after = pushes();
    assert.equal(after.length, before + 1, '토글마다 한 번 다시 보낸다');
    assert.equal(after.at(-1)[1].expanded, false);
    f.handlers.get('pet:usage:refresh')({ sender: f.main.webContents });
    f.handlers.get('pet:usage:refresh')({ sender: {} });
    assert.equal(refreshed, 0);
    f.handlers.get('pet:usage:refresh')({ sender: petWc });
    assert.equal(refreshed, 1);
  } finally { f.pet.shutdown(); }
  // onUsageRefresh 가 없어도 오류가 없다
  const bare = petFixture();
  try { bare.pet.refresh(); bare.handlers.get('pet:usage:refresh')({ sender: bare.wins[0].wc }); } finally { bare.pet.shutdown(); }
});

// ───────────────────────── 펫 그림 선택 (내장·가져온 펫) ─────────────────────────

// 내장 펫 폴더와 userData(pets 폴더 포함)를 임시로 만든다. 내용은 readPet 검사만 통과하면 된다 (크기 검사는 가져올 때·펫 화면에서).
function artFixture({ builtin = ['office-claude'], user = ['mine'] } = {}) {
  const builtinPetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-builtin-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-userdata-'));
  const SLEEP = Buffer.from([0x52, 0x49, 0x46, 0x46, 7, 7]);
  for (const [dir, ids] of [[builtinPetsDir, builtin], [path.join(userDataDir, 'pets'), user]]) {
    for (const id of ids) {
      write(dir, `${id}/pet.json`, JSON.stringify({ displayName: `이름 ${id}`, spritesheetPath: 'spritesheet.png', agentOffice: { sleepSheetPath: 'sleep.png' } }));
      write(dir, `${id}/spritesheet.png`, Buffer.concat([SHEET_PNG, Buffer.from(id)]));
      write(dir, `${id}/sleep.png`, SLEEP);
    }
  }
  write(builtinPetsDir, 'broken/pet.json', '{ nope'); // 검사를 통과하지 못하면 목록에 없다
  write(builtinPetsDir, 'not-a-pet/readme.txt', 'x');
  return { builtinPetsDir, userDataDir, SLEEP };
}
const lastState = (f) => f.wins[0].sent.filter(([ch]) => ch === 'pet:state').at(-1)[1];
const open = (f) => { f.pet.refresh(); f.wins[0].wc.handlers['did-finish-load'](); return f.wins[0].wc; };

test('펫 그림 해석: 기본 · 아이콘만 · 내장 · 가져온 펫 · 없는 펫 → pushState 의 sprites', () => {
  const { builtinPetsDir, userDataDir } = artFixture({ builtin: ['office-claude', 'other'], user: ['mine'] });
  const table = [
    // [설정 claude, 설정 codex, 해석 claude, 해석 codex]
    [null, null, 'builtin:office-claude', 'none'], // 기본: office-<종류> 가 있으면 그것, 없으면 아이콘
    ['none', 'none', 'none', 'none'],
    ['builtin:other', 'builtin:office-claude', 'builtin:other', 'builtin:office-claude'],
    ['builtin:gone', 'builtin:gone', 'builtin:office-claude', 'none'], // 없는 내장 펫은 기본으로
    ['user:mine', 'user:mine', 'user:mine', 'user:mine'],
    ['user:gone', 'user:gone', 'none', 'none'], // 없는 가져온 펫은 아이콘
    ['mine', null, 'user:mine', 'none'], // 예전 맨 id
  ];
  for (const [c, x, rc, rx] of table) {
    const f = petFixture({ builtinPetsDir, userDataDir, sprites: { claude: c, codex: x } });
    try {
      open(f);
      assert.deepEqual(lastState(f).sprites, { claude: rc, codex: rx }, JSON.stringify([c, x]));
    } finally { f.pet.shutdown(); }
  }
  // 내장 폴더가 없거나 인자가 없어도 기본은 아이콘
  for (const dir of [undefined, path.join(os.tmpdir(), 'ao-no-such-dir')]) {
    const f = petFixture({ builtinPetsDir: dir, userDataDir });
    try { open(f); assert.deepEqual(lastState(f).sprites, { claude: 'none', codex: 'none' }); } finally { f.pet.shutdown(); }
  }
});

test('펫 그림: pushState 는 파일에 접근하지 않고 보관한 목록만 쓴다 · 가져온 펫은 목록을 새로 읽을 때 반영', () => {
  const { builtinPetsDir, userDataDir } = artFixture({ user: [] });
  const f = petFixture({ builtinPetsDir, userDataDir, sprites: { claude: 'user:late', codex: null } });
  try {
    open(f);
    assert.equal(lastState(f).sprites.claude, 'none');
    write(path.join(userDataDir, 'pets'), 'late/pet.json', JSON.stringify({ spritesheetPath: 's.png' }));
    write(path.join(userDataDir, 'pets'), 'late/s.png', SHEET_PNG);
    f.pet.setState({ kinds: {} }); // 파일이 생겼어도 목록을 다시 읽기 전에는 그대로
    assert.equal(lastState(f).sprites.claude, 'none');
    f.pet.refreshUserPets();
    assert.equal(lastState(f).sprites.claude, 'user:late', '목록을 다시 읽으면 펫 화면에 알린다');
    fs.rmSync(path.join(userDataDir, 'pets', 'late'), { recursive: true });
    f.pet.refreshUserPets();
    assert.equal(lastState(f).sprites.claude, 'none');
  } finally { f.pet.shutdown(); }
});

test('pet:sprite: 펫 창에서만 · key 가 지금 해석값과 같을 때만 읽어 준다 · 아니면 none', () => {
  const { builtinPetsDir, userDataDir, SLEEP } = artFixture();
  const f = petFixture({ builtinPetsDir, userDataDir, sprites: { claude: 'user:mine', codex: null } });
  try {
    const petWc = open(f);
    const ask = (sender, p) => f.handlers.get('pet:sprite')({ sender }, p);
    const ok = ask(petWc, { kind: 'claude', key: 'user:mine' });
    assert.equal(ok.key, 'user:mine');
    assert.equal(ok.displayName, '이름 mine');
    assert.equal(ok.type, 'image/png');
    assert.ok(ok.bytes.equals(Buffer.concat([SHEET_PNG, Buffer.from('mine')])));
    assert.equal(ok.sleepType, 'image/png');
    assert.ok(ok.sleepBytes.equals(SLEEP));
    assert.deepEqual(ask(petWc, { kind: 'claude', key: 'builtin:office-claude' }), { key: 'builtin:office-claude', none: true }, '지금 해석값과 다른 key');
    assert.deepEqual(ask(petWc, { kind: 'claude', key: 'none' }), { key: 'none', none: true });
    assert.deepEqual(ask(petWc, { kind: 'codex', key: 'user:mine' }), { key: 'user:mine', none: true }, '종류가 다르면 그 종류의 해석값(none)과 비교');
    assert.equal(ask(petWc, { kind: 'codex', key: 'none' }).none, true);
    assert.ok(ask(petWc, { kind: 'claude', key: 'user:mine' }).bytes, '기본 펫이 없는 codex 와 무관하게 claude 는 읽힌다');
    for (const bad of [undefined, null, 'claude', 5, { kind: 'other', key: 'user:mine' }, { kind: 'claude' }, { kind: 'claude', key: 5 }, { kind: 'claude', key: 'x'.repeat(101) }]) {
      assert.equal(ask(petWc, bad), null, JSON.stringify(bad));
    }
    assert.equal(ask(f.main.webContents, { kind: 'claude', key: 'user:mine' }), null, '메인 창에서 온 것');
    assert.equal(ask({}, { kind: 'claude', key: 'user:mine' }), null);
    // 펫 폴더가 사라지면 (목록을 다시 읽기 전) 읽기 실패 → none
    fs.rmSync(path.join(userDataDir, 'pets', 'mine'), { recursive: true });
    assert.deepEqual(ask(petWc, { kind: 'claude', key: 'user:mine' }), { key: 'user:mine', none: true });
  } finally { f.pet.shutdown(); }
});

test('selectPet: 정규화하고 목록에 있는 키 · null · none 만 저장', () => {
  const { builtinPetsDir, userDataDir } = artFixture({ builtin: ['office-claude'], user: ['mine'] });
  const f = petFixture({ builtinPetsDir, userDataDir });
  try {
    open(f);
    const saves = f.saved.length;
    for (const [kind, value] of [['other', null], ['claude', 'user:gone'], ['claude', 'builtin:gone'], ['claude', '../x'], ['claude', 'user:../x'], ['claude', 5], ['claude', undefined], ['claude', ''], ['claude', 'None'], ['claude', 'bad:key']]) {
      assert.deepEqual(f.pet.selectPet(kind, value), { ok: false }, JSON.stringify([kind, value]));
    }
    assert.equal(f.saved.length, saves, '거부된 값은 저장하지 않는다');
    assert.equal(f.config.pet.sprites.claude, null);
    assert.deepEqual(f.pet.selectPet('claude', 'user:mine'), { ok: true, selected: 'user:mine' });
    assert.equal(f.config.pet.sprites.claude, 'user:mine');
    assert.equal(JSON.parse(f.saved.at(-1)).sprites.claude, 'user:mine');
    assert.equal(lastState(f).sprites.claude, 'user:mine', '선택하면 펫 화면에 알린다');
    assert.equal(f.pet.selectPet('codex', 'mine').ok, true, '예전 맨 id 도 정규화해 받는다');
    assert.equal(f.config.pet.sprites.codex, 'user:mine');
    assert.equal(f.pet.selectPet('claude', 'builtin:office-claude').ok, true);
    assert.equal(f.pet.selectPet('claude', 'none').ok, true);
    assert.equal(lastState(f).sprites.claude, 'none');
    assert.equal(f.pet.selectPet('claude', null).ok, true);
    assert.equal(f.config.pet.sprites.claude, null);
    assert.equal(lastState(f).sprites.claude, 'builtin:office-claude', '기본으로 돌아가면 내장 기본 펫');
    // 새로 가져온 펫도 목록을 다시 읽어 받아들인다
    write(path.join(userDataDir, 'pets'), 'fresh/pet.json', JSON.stringify({ spritesheetPath: 's.png' }));
    write(path.join(userDataDir, 'pets'), 'fresh/s.png', SHEET_PNG);
    assert.equal(f.pet.selectPet('claude', 'user:fresh').ok, true);
  } finally { f.pet.shutdown(); }
});

test('listPets: 내장 → 가져온 순 · 설정 원값과 해석값 · 검사를 통과하지 못한 폴더는 빠진다', () => {
  const { builtinPetsDir, userDataDir } = artFixture({ builtin: ['office-claude', 'office-codex'], user: ['mine', 'zzz'] });
  write(path.join(userDataDir, 'pets'), 'bad/pet.json', '{}');
  write(path.join(userDataDir, 'pets'), '.tmp-x/pet.json', '{}');
  const f = petFixture({ builtinPetsDir, userDataDir, sprites: { claude: 'user:mine', codex: 'user:gone' } });
  try {
    const list = f.pet.listPets();
    assert.deepEqual(list.pets.map((p) => [p.key, p.source, p.id]), [
      ['builtin:office-claude', 'builtin', 'office-claude'], ['builtin:office-codex', 'builtin', 'office-codex'],
      ['user:mine', 'user', 'mine'], ['user:zzz', 'user', 'zzz'],
    ]);
    assert.equal(list.pets[0].displayName, '이름 office-claude');
    assert.deepEqual(list.selected, { claude: 'user:mine', codex: 'user:gone' });
    assert.deepEqual(list.resolved, { claude: 'user:mine', codex: 'none' });
    assert.deepEqual([...f.pet.builtinIds].sort(), ['office-claude', 'office-codex']);
    assert.ok(f.pet.readPetByKey('user:mine').bytes, '목록에 있는 키만 읽는다');
    for (const key of ['user:gone', 'builtin:gone', 'user:bad', '../x', 'user:../mine', 5, undefined, 'mine']) assert.equal(f.pet.readPetByKey(key), null, String(key));
  } finally { f.pet.shutdown(); }
});

test('목록(scanPets): 대문자 폴더 · 허용 밖 크기의 시트 · 잘린 시트는 제외, 앞부분만 읽는다', () => {
  const { builtinPetsDir, userDataDir } = artFixture({ builtin: ['office-claude'], user: ['mine'] });
  const pets = path.join(userDataDir, 'pets');
  const add = (name, sheet, extra = {}) => { write(pets, `${name}/pet.json`, JSON.stringify({ spritesheetPath: 's.png', ...extra })); write(pets, `${name}/s.png`, sheet); };
  add('Upper', SHEET_PNG); // 대문자 폴더
  add('small', pngOf(100, 100)); // 크기가 다름
  add('stub', PNG); // 머리글이 짧아 크기를 알 수 없음
  add('huge', Buffer.concat([SHEET_PNG, Buffer.alloc(3 * 1024 * 1024)])); // 큰 시트도 앞부분만 읽어 통과
  add('almost', pngOf(1536, 2287)); // 11줄에서 1px 모자람
  const f = petFixture({ builtinPetsDir, userDataDir });
  try {
    assert.deepEqual(f.pet.listPets().pets.map((p) => p.key), ['builtin:office-claude', 'user:huge', 'user:mine']);
  } finally { f.pet.shutdown(); }
});

test('목록(scanPets): 버전 2(1536x2288) 시트는 목록에 version 2 로 들어가고, 선언이 어긋나거나 1·2 가 아니면 제외', () => {
  const { builtinPetsDir, userDataDir } = artFixture({ builtin: ['office-claude'], user: ['mine'] });
  const pets = path.join(userDataDir, 'pets');
  const add = (name, sheet, extra = {}) => { write(pets, `${name}/pet.json`, JSON.stringify({ spritesheetPath: 's.png', ...extra })); write(pets, `${name}/s.png`, sheet); };
  const SHEET2_PNG = pngOf(1536, 2288);
  add('wide', SHEET2_PNG); // 선언 없음 → 그림 높이로 버전 2
  add('wide-ok', SHEET2_PNG, { spriteVersionNumber: 2 });
  add('wide-bad1', SHEET2_PNG, { spriteVersionNumber: 1 }); // 선언 1 인데 그림은 11줄
  add('tall-bad2', SHEET_PNG, { spriteVersionNumber: 2 }); // 선언 2 인데 그림은 9줄
  add('wide-three', SHEET2_PNG, { spriteVersionNumber: 3 });
  add('wide-str', SHEET2_PNG, { spriteVersionNumber: '2' });
  add('tall-ok', SHEET_PNG, { spriteVersionNumber: 1 });
  add('tall-null', SHEET_PNG, { spriteVersionNumber: null });
  const f = petFixture({ builtinPetsDir, userDataDir });
  try {
    const list = f.pet.listPets().pets;
    assert.deepEqual(list.map((p) => [p.key, p.version]), [
      ['builtin:office-claude', 1], ['user:mine', 1], ['user:tall-null', 1], ['user:tall-ok', 1], ['user:wide', 2], ['user:wide-ok', 2],
    ]);
  } finally { f.pet.shutdown(); }
  assert.equal(readPet(pets, 'wide-three').spriteVersionNumber, 'invalid', 'readPet 은 1·2 밖의 선언을 거부 표시로 돌려준다');
  assert.equal(readPet(pets, 'wide-ok').spriteVersionNumber, 2);
  assert.equal(readPet(pets, 'wide').spriteVersionNumber, null);
});

test('pet:sprite: 응답에 그림 버전(version) · 크기가 1536x1872/2288 이 아니거나 선언이 어긋나면 none', () => {
  const { builtinPetsDir, userDataDir } = artFixture({ builtin: ['office-claude'], user: ['mine'] });
  const pets = path.join(userDataDir, 'pets');
  const add = (name, sheet, extra = {}) => { write(pets, `${name}/pet.json`, JSON.stringify({ spritesheetPath: 's.png', ...extra })); write(pets, `${name}/s.png`, sheet); };
  add('wide', pngOf(1536, 2288));
  const f = petFixture({ builtinPetsDir, userDataDir, sprites: { claude: 'user:wide', codex: 'user:mine' } });
  try {
    const petWc = open(f);
    const ask = (p) => f.handlers.get('pet:sprite')({ sender: petWc }, p);
    assert.equal(ask({ kind: 'claude', key: 'user:wide' }).version, 2);
    assert.equal(ask({ kind: 'codex', key: 'user:mine' }).version, 1);
    // 목록을 다시 읽기 전에 파일이 바뀐 경우도 응답의 version 은 보내는 바이트의 크기로 정한다
    write(pets, 'wide/s.png', pngOf(1536, 1872));
    assert.equal(ask({ kind: 'claude', key: 'user:wide' }).version, 1);
    write(pets, 'wide/s.png', pngOf(1536, 2000));
    assert.deepEqual(ask({ kind: 'claude', key: 'user:wide' }), { key: 'user:wide', none: true });
    write(pets, 'wide/s.png', PNG); // 크기를 읽을 수 없음
    assert.deepEqual(ask({ kind: 'claude', key: 'user:wide' }), { key: 'user:wide', none: true });
    write(pets, 'wide/s.png', pngOf(1536, 2288));
    write(pets, 'wide/pet.json', JSON.stringify({ spritesheetPath: 's.png', spriteVersionNumber: 1 })); // 선언 불일치
    assert.deepEqual(ask({ kind: 'claude', key: 'user:wide' }), { key: 'user:wide', none: true });
  } finally { f.pet.shutdown(); }
});

test('readPet: 앞의 BOM 이 붙은 pet.json 도 읽는다', () => {
  const dir = petDir((d) => {
    write(d, 'bom/pet.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ displayName: 'Bom', spritesheetPath: 'sheet.png' }))]));
    write(d, 'bom/sheet.png', PNG);
  });
  assert.equal(readPet(dir, 'bom').displayName, 'Bom');
});
