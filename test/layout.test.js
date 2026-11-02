import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliWidthFor, CLI_MIN_RATIO, OFFICE_MIN, analysisHeightFor, EDITOR_MIN } from '../src/renderer/layout.js';

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

test('코드 화면 분석 패널 높이: 조절 전에는 기본, 편집기 최소 높이를 남기고 머리줄보다 작아지지 않는다', () => {
  assert.equal(analysisHeightFor(0, 800, 90), null, '조절하지 않았으면 기본 높이');
  assert.equal(analysisHeightFor(300, 800, 90), 300);
  assert.equal(analysisHeightFor(40, 800, 90), 90, '머리줄과 본문 몇 줄은 남긴다');
  assert.equal(analysisHeightFor(790, 800, 90), 800 - EDITOR_MIN, '편집기 최소 높이는 남긴다');
  assert.equal(analysisHeightFor(300, 150, 90), 90, '공간이 모자라면 패널 최소 높이가 우선');
  assert.equal(analysisHeightFor(300, 70, 90), 70, '그래도 나눠 쓰는 높이를 넘지는 않는다');
  assert.equal(analysisHeightFor(300.6, 800, 90), 301, '정수 픽셀');
});
