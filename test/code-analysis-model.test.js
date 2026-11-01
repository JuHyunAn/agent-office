import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateNote, notesForFile, jumpLine, splitLines } from '../src/renderer/code/analysis.js';

const note = (file, line, anchor, title = '제목', text = '설명') => ({ file, line, anchor, title, text });

test('splitLines: LF·CRLF 를 모두 줄로 나눈다', () => {
  assert.deepEqual(splitLines('a\nb\r\nc'), ['a', 'b', 'c']);
  assert.deepEqual(splitLines(''), ['']);
});

test('locateNote: 줄 번호의 내용이 anchor 와 같으면 그대로(앞뒤 공백 무시)', () => {
  const lines = ['function a() {', '  const value = compute();', '}'];
  assert.deepEqual(locateNote(note('a.js', 2, 'const value = compute();'), lines), { line: 2, moved: false });
  assert.deepEqual(locateNote(note('a.js', 2, '   const value = compute();  '), lines), { line: 2, moved: false });
});

test('locateNote: 줄이 밀렸으면 같은 줄을 찾아 moved', () => {
  const lines = ['x', 'y', 'const value = compute();', 'z'];
  assert.deepEqual(locateNote(note('a.js', 2, 'const value = compute();'), lines), { line: 3, moved: true });
});

test('locateNote: 긴 줄이 여러 개면 note.line 에 가까운 쪽, 같은 거리면 위쪽', () => {
  const dup = 'return handleRequest(req);';
  const lines = [dup, 'a', 'b', 'c', 'd', dup, 'e', 'f', 'g', 'h', dup];
  assert.deepEqual(locateNote(note('a.js', 7, dup), lines), { line: 6, moved: true }); // 1·6·11 중 6 이 가장 가까움
  assert.deepEqual(locateNote(note('a.js', 9, dup), lines), { line: 11, moved: true }); // 거리 3(6) 대 2(11) → 11
  // 같은 거리: 3줄 사이(1, 3) 에서 2 를 가리키면 위쪽(1)
  assert.deepEqual(locateNote(note('a.js', 2, dup), [dup, 'x', dup]), { line: 1, moved: true });
});

test('locateNote: 짧고 흔한 줄(공백 제외 8자 미만)이 여러 개면 숨김', () => {
  const lines = ['if (a) {', '  x();', '}', '  y();', '}', '}'];
  assert.equal(locateNote(note('a.js', 1, '}'), lines), null);
  // 경계: 공백 제외 길이가 정확히 8자면 가까운 줄에 붙인다
  const seven = 'return 1'; // 공백 제외 7자
  assert.equal([...seven.replace(/\s+/g, '')].length, 7);
  assert.equal(locateNote(note('a.js', 9, seven), [seven, 'a', seven]), null);
  const nine = 'return 12'; // 공백 제외 8자
  assert.deepEqual(locateNote(note('a.js', 2, nine), [nine, 'a', 'b', nine]), { line: 1, moved: true });
});

test('locateNote: 후보가 하나면 짧아도 moved 로 붙인다', () => {
  const lines = ['a', 'b', '}', 'c'];
  assert.deepEqual(locateNote(note('a.js', 1, '}'), lines), { line: 3, moved: true });
});

test('locateNote: 일치하는 줄이 없으면 null', () => {
  assert.equal(locateNote(note('a.js', 1, 'nothing here'), ['a', 'b']), null);
});

test('locateNote: anchor 가 비었거나 공백뿐이면 null', () => {
  assert.equal(locateNote(note('a.js', 2, ''), ['a', '', 'c']), null);
  assert.equal(locateNote(note('a.js', 2, '   \t'), ['a', '   ', 'c']), null);
  assert.equal(locateNote(note('a.js', 2, undefined), ['a', 'b']), null);
});

test('locateNote: 줄 번호가 파일 밖이어도 anchor 로 찾는다', () => {
  const lines = ['a', 'const answer = 42;'];
  assert.deepEqual(locateNote(note('a.js', 99, 'const answer = 42;'), lines), { line: 2, moved: true });
  assert.deepEqual(locateNote(note('a.js', 0, 'const answer = 42;'), lines), { line: 2, moved: true });
  assert.equal(locateNote(note('a.js', 99, 'not in file'), lines), null);
});

test('locateNote: CRLF 파일도 splitLines 로 나누면 일치한다', () => {
  const lines = splitLines('first line\r\nconst x = 1;\r\nlast');
  assert.deepEqual(locateNote(note('a.js', 2, 'const x = 1;'), lines), { line: 2, moved: false });
});

test('notesForFile: 경로 대소문자를 무시하고 다른 파일은 제외, 줄 번호순으로 정렬', () => {
  const text = 'alpha line\nbeta line\ngamma line';
  const result = {
    annotations: [
      note('SRC/A.js', 3, 'gamma line', '셋째'),
      note('src/b.js', 1, 'alpha line', '다른 파일'),
      note('src/a.js', 1, 'alpha line', '첫째'),
    ],
  };
  const { shown, hidden } = notesForFile(result, 'Src/a.JS', text);
  assert.equal(hidden, 0);
  assert.deepEqual(shown.map((n) => [n.line, n.title, n.moved]), [[1, '첫째', false], [3, '셋째', false]]);
  assert.equal(shown[0].key, 'src/a.js|첫째|alpha line');
});

test('notesForFile: 밀린 주석은 새 줄 번호와 moved, 못 찾은 주석은 hidden 으로 센다', () => {
  const text = 'x\nalpha line\nbeta line';
  const result = { annotations: [note('a.js', 1, 'alpha line', 'T1'), note('a.js', 2, 'gone line', 'T2')] };
  const { shown, hidden } = notesForFile(result, 'a.js', text);
  assert.equal(hidden, 1);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].line, 2);
  assert.equal(shown[0].moved, true);
});

test('notesForFile: 같은 줄 주석은 입력 순서를 유지한다', () => {
  const text = 'only line here';
  const result = { annotations: [note('a.js', 1, 'only line here', 'B'), note('a.js', 1, 'only line here', 'A'), note('a.js', 1, 'only line here', 'C')] };
  const { shown } = notesForFile(result, 'a.js', text);
  assert.deepEqual(shown.map((n) => n.title), ['B', 'A', 'C']);
});

test('notesForFile: 줄이 밀린 주석도 줄 번호순으로 다시 정렬된다', () => {
  const text = 'one line\ntwo line\nthree line';
  const result = { annotations: [note('a.js', 2, 'three line', 'T'), note('a.js', 1, 'one line', 'O')] };
  const { shown } = notesForFile(result, 'a.js', text);
  assert.deepEqual(shown.map((n) => [n.line, n.title]), [[1, 'O'], [3, 'T']]);
});

test('notesForFile: result·annotations 가 없으면 빈 결과', () => {
  assert.deepEqual(notesForFile(null, 'a.js', 'x'), { shown: [], hidden: 0 });
  assert.deepEqual(notesForFile(undefined, 'a.js', 'x'), { shown: [], hidden: 0 });
  assert.deepEqual(notesForFile({}, 'a.js', 'x'), { shown: [], hidden: 0 });
});

test('notesForFile: 원본 주석 객체를 바꾸지 않는다', () => {
  const n = note('a.js', 1, 'later line');
  notesForFile({ annotations: [n] }, 'a.js', 'x\nlater line');
  assert.equal(n.line, 1);
  assert.equal('moved' in n, false);
});

test('jumpLine: 정확하면 그 줄, 밀렸으면 찾은 줄 moved', () => {
  const text = 'aaa\nconst target = 1;\nbbb';
  assert.deepEqual(jumpLine({ file: 'a.js', line: 2, anchor: 'const target = 1;' }, text), { line: 2, moved: false });
  assert.deepEqual(jumpLine({ file: 'a.js', line: 1, anchor: 'const target = 1;' }, text), { line: 2, moved: true });
});

test('jumpLine: 못 찾으면 원래 줄을 파일 줄 수로 잘라 moved', () => {
  const text = 'a\nb\nc';
  assert.deepEqual(jumpLine({ file: 'a.js', line: 99, anchor: 'missing' }, text), { line: 3, moved: true });
  assert.deepEqual(jumpLine({ file: 'a.js', line: 2, anchor: 'missing' }, text), { line: 2, moved: true });
  assert.deepEqual(jumpLine({ file: 'a.js', line: 0, anchor: 'missing' }, text), { line: 1, moved: true });
});

test('jumpLine: text 가 없으면 원래 줄 그대로', () => {
  assert.deepEqual(jumpLine({ file: 'a.js', line: 12, anchor: 'x' }), { line: 12, moved: false });
  assert.deepEqual(jumpLine({ file: 'a.js', line: 12, anchor: 'x' }, null), { line: 12, moved: false });
});
