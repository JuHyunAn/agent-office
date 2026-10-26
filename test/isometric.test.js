import { test } from 'node:test';
import assert from 'node:assert/strict';
import theme, { projectPoint } from '../src/renderer/themes/pixel-office/theme.js';
import { OfficeView } from '../src/renderer/office/view.js';
import baseLayout from '../src/renderer/themes/mockup/layout.js';
import plainTheme from '../src/renderer/themes/pixel-office/plain.js';

test('확장된 사선 테마의 10개 구역과 좌석이 투영 영역 안에 있다', () => {
  assert.equal(Object.keys(theme.layout.rooms).length, 10);
  assert.ok(theme.layout.width > baseLayout.width);
  for (const room of Object.values(theme.layout.rooms)) {
    for (const seat of room.seats) {
      const p = theme.project(seat.x, seat.y);
      assert.ok(p.x > 40 && p.x < theme.viewport.width - 40);
      assert.ok(p.y > 60 && p.y < theme.viewport.height - 60);
    }
  }
});

test('두 월드 축은 반대 가로 방향·같은 깊이 방향으로 투영된다', () => {
  const origin = projectPoint(0, 0);
  const xAxis = projectPoint(100, 0), yAxis = projectPoint(0, 100);
  assert.ok(xAxis.x > origin.x && yAxis.x < origin.x);
  assert.equal(xAxis.y, yAxis.y);
  assert.equal(projectPoint(100, 0, 20).y, xAxis.y - 20);
  assert.deepEqual(theme.project(100, 200), { x: projectPoint(100, 200).x * 2, y: projectPoint(100, 200).y * 2 });
});

function makeView(selectedTheme) {
  const view = Object.create(OfficeView.prototype);
  view.canvas = { width: 800, height: 600, style: {}, parentElement: { clientWidth: 800, clientHeight: 600 } };
  view.ctx = { setTransform() {}, fillRect() {} };
  view.theme = selectedTheme;
  view.engine = { snapshot: () => [{ id: 'a', x: 100, y: 200, pose: 'sit', label: 'agent', status: 'working', task: 'reading' }] };
  view.view = { scale: 1, ox: 0, oy: 0, dpr: 1 };
  return view;
}

test('사선 화면 크기는 월드 배치도가 아닌 투영 영역으로 계산한다', () => {
  const priorWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 2 };
  try {
    const view = makeView(theme);
    view.resize();
    assert.equal(view.view.scale, Math.min(800 / theme.viewport.width, 600 / theme.viewport.height));
    assert.equal(view.canvas.width, 1600);
    assert.equal(view.canvas.height, 1200);
  } finally {
    if (priorWindow === undefined) delete globalThis.window; else globalThis.window = priorWindow;
  }
});

test('사선 장면 렌더러에 원본 좌표를 전달하고 기존 테마 그리기도 유지한다', () => {
  const calls = [];
  const selected = { ...theme, drawScene(_ctx, agents) { calls.push(agents[0]); } };
  makeView(selected).draw(0);
  assert.equal(calls[0].x, 100);
  assert.equal(calls[0].y, 200);
  const legacy = makeView({ layout: baseLayout, drawBackground() { calls.push('background'); }, drawAgent() { calls.push('agent'); }, drawForeground() { calls.push('foreground'); } });
  legacy.draw(0);
  assert.deepEqual(calls.slice(1), ['background', 'agent', 'foreground']);
});

test('사선 캐릭터 툴팁은 화면 투영 위치에서 선택된다', () => {
  const view = makeView(theme);
  view.view = { scale: 0.6, ox: 20, oy: 30, dpr: 2 };
  const p = theme.project(100, 200);
  view.tooltip = { hidden: true, style: {} };
  view.hoverAt = { x: p.x * 0.6 + 20, y: (p.y - theme.agentHead) * 0.6 + 30, cx: 300, cy: 200 };
  view.updateTooltip(view.engine.snapshot());
  assert.equal(view.tooltip.hidden, false);
  assert.match(view.tooltip.textContent, /agent/);
  view.hoverAt.x = 0; view.hoverAt.y = 0;
  view.updateTooltip(view.engine.snapshot());
  assert.equal(view.tooltip.hidden, true);
});

test('도시·배경 없음 전환은 생활 상태·카메라·진행 중 상호작용을 유지한다', async () => {
  const priorWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  try {
    const view = makeView(theme);
    view.engine.setLayout = () => assert.fail('같은 배치도의 테마 전환은 엔진을 재배치하면 안 된다');
    view.life = { player: { x: 600, y: 700, heldItem: { id: 'latte', until: 45000 } }, menu: { id: 'lounge-coffee' } };
    view.resize(); view.zoomBy(2);
    const life = view.life, camera = view.camera;
    for (const next of [plainTheme, theme]) {
      await view.setTheme({ ...next, load: null });
      assert.equal(view.theme.id, next.id);
      assert.strictEqual(view.life, life); assert.strictEqual(view.camera, camera);
      assert.equal(view.camera.zoom, 2);
      assert.equal(view.life.player.heldItem.id, 'latte');
      assert.equal(view.life.menu.id, 'lounge-coffee');
    }
  } finally {
    if (priorWindow === undefined) delete globalThis.window; else globalThis.window = priorWindow;
  }
});
