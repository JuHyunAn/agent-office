import { test } from 'node:test';
import assert from 'node:assert/strict';

// 드링크 그림 로더가 Image 를 쓴다 — 읽히지 않은 채로 두는 가짜
globalThis.Image = class { constructor() { this.complete = false; this.naturalWidth = 0; } addEventListener() {} set src(v) { this._src = v; } };
const { drawCharacter, usesAgentSprite } = await import('../src/renderer/themes/pixel-office/sprites.js');
const { drawAgentCharacter } = await import('../src/renderer/themes/pixel-office/codex-sprite.js');
const { AGENT_LOOKS, MARKS, deriveLook, lookOf } = await import('../src/renderer/themes/pixel-office/agent-looks.js');
const { residentState } = await import('../src/renderer/themes/pixel-office/resident-sprite.js');

// fillStyle 지정과 fillRect 호출을 순서대로 적는 가짜 캔버스. 나머지 메서드는 아무것도 안 한다.
function recorder() {
  const fills = [], rects = [];
  let style = null;
  const ctx = new Proxy({}, {
    get(_, k) {
      if (k === 'canvas') return { width: 100, height: 100 };
      if (k === 'fillRect') return (...a) => { rects.push([style, ...a]); };
      return () => ({ width: 10 });
    },
    set(_, k, v) { if (k === 'fillStyle') { style = v; fills.push(v); } return true; },
  });
  return { ctx, fills, rects };
}

const base = { pose: 'stand', status: 'working', facing: 'down', colorIndex: 1 };

test('lookOf: Claude·미정의·미등록은 null (기존 Claude 그림)', () => {
  assert.equal(lookOf('claude'), null);
  assert.equal(lookOf(undefined), null);
  assert.equal(lookOf(null), null);
  assert.equal(lookOf(7), null);
  assert.equal(lookOf('zzz'), null);
});

test('lookOf: codex 는 표의 값 그대로', () => {
  assert.equal(lookOf('codex'), AGENT_LOOKS.codex);
});

test('deriveLook: 레지스트리 색에서 다섯 색을 만든다', () => {
  assert.deepEqual({ ...deriveLook('#6fa3c9') }, { body: '#6fa3c9', light: '#9abfd9', shade: '#4e728d', ink: '#21313c', eye: '#dbe8f2', mark: 'dots' });
  assert.deepEqual({ ...deriveLook('#6FA3C9') }, { ...deriveLook('#6fa3c9') });
  assert.ok(Object.isFrozen(deriveLook('#6fa3c9')));
});

test('deriveLook: #rrggbb 가 아니면 null', () => {
  for (const v of ['red', '#fff', '#12345g', '', null, undefined, 5]) assert.equal(deriveLook(v), null, String(v));
});

test('usesAgentSprite: codex·새 AI 는 true, Claude 는 false', () => {
  assert.equal(usesAgentSprite('codex'), true);
  assert.equal(usesAgentSprite('grok'), true);
  assert.equal(usesAgentSprite('claude'), false);
  assert.equal(usesAgentSprite(undefined), false);
});

test('새 캐릭터도 실제 이동·작업·알림·휴식 상태에 맞는 전용 자세를 고른다', () => {
  for (const [actor, expected] of [
    [{ pose: 'walk', facing: 'left' }, 'running-left'], [{ pose: 'walk', facing: 'right' }, 'running-right'],
    [{ pose: 'type' }, 'running'], [{ pose: 'read' }, 'review'], [{ pose: 'talk' }, 'waving'],
    [{ pose: 'alert' }, 'waiting'], [{ pose: 'alert', status: 'error' }, 'failed'],
    [{ status: 'away' }, 'sleeping'], [{ pose: 'stand' }, 'idle'],
  ]) assert.equal(residentState(actor), expected);
});

test('drawCharacter: grok 은 grok 몸 색을 쓰고 Claude 주황은 쓰지 않는다', () => {
  const { ctx, fills } = recorder();
  drawCharacter(ctx, { ...base, cli: 'grok' }, 0, 40, 60);
  assert.ok(fills.includes(AGENT_LOOKS.grok.body));
  assert.ok(!fills.includes('#d77b57'));
  const claude = recorder();
  drawCharacter(claude.ctx, { ...base, cli: 'claude' }, 0, 40, 60);
  assert.ok(claude.fills.includes('#d77b57'));
});

test('drawCharacter: muse·antigravity 도 각자 몸 색', () => {
  for (const cli of ['muse', 'antigravity']) {
    const { ctx, fills } = recorder();
    drawCharacter(ctx, { ...base, cli }, 0, 40, 60);
    assert.ok(fills.includes(AGENT_LOOKS[cli].body), cli);
    assert.ok(!fills.includes('#d77b57'), cli);
  }
});

test('가슴 표식 네 종류는 서로 다른 fillRect 묶음이다', () => {
  const sets = MARKS.map((mark) => {
    const { ctx, rects } = recorder();
    drawAgentCharacter(ctx, { ...base }, 0, 40, 60, { ...AGENT_LOOKS.grok, mark });
    return JSON.stringify(rects);
  });
  assert.equal(new Set(sets).size, MARKS.length);
});

test('알 수 없는 표식은 기본(dots)과 같게 그린다', () => {
  const draw = (mark) => { const { ctx, rects } = recorder(); drawAgentCharacter(ctx, { ...base }, 0, 40, 60, { ...AGENT_LOOKS.grok, mark }); return JSON.stringify(rects); };
  assert.equal(draw('???'), draw('dots'));
});

test('표의 모든 look 은 표식 목록 안의 값과 #rrggbb 색만 쓴다', () => {
  for (const look of Object.values(AGENT_LOOKS)) {
    assert.ok(MARKS.includes(look.mark));
    for (const k of ['body', 'light', 'shade', 'ink', 'eye']) assert.match(look[k], /^#[0-9a-f]{6}$/);
  }
});
