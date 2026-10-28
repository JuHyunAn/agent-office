import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliWidthFor, CLI_MIN_RATIO, OFFICE_MIN } from '../src/renderer/layout.js';

test('오른쪽 영역 너비: 기본 너비가 최소, 사무실이 너무 좁아지지 않을 만큼만 넓힌다', () => {
  const total = 2000;
  const min = total * CLI_MIN_RATIO;
  assert.equal(cliWidthFor(0, total), null, '조절하지 않았으면 기본 배치');
  assert.equal(cliWidthFor(min - 50, total), null, '기본보다 좁게는 줄지 않는다');
  assert.equal(cliWidthFor(900, total), 900);
  assert.equal(cliWidthFor(1900, total), total - OFFICE_MIN, '사무실 최소 너비는 남긴다');
  assert.equal(cliWidthFor(340, 1000), null, '창이 작으면 최소 350px 기준');
  assert.equal(cliWidthFor(450, 1000), 450);
  assert.equal(cliWidthFor(900.6, total), 901, '정수 픽셀');
});
