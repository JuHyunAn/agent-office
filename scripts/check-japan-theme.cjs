'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 기존 UI 검증에서 실제 테마 선택기를 통해 호출한다. 외부 AI는 실행하지 않는다.
module.exports = async function checkJapanTheme(win, selectTheme, out) {
  const switched = await selectTheme('pixel-office-japan');
  const result = await win.webContents.executeJavaScript(`(${async function () {
    const { default: theme } = await import('./themes/japan/theme.js');
    const { scenery, releaseScenery } = await import('./themes/japan/scenery.js');
    const { OfficeView } = await import('./office/view.js');
    const { OfficeEngine } = await import('./office/engine.js');
    const { OfficeLife } = await import('./office/life.js');
    const v = window.__view, options = [...document.querySelector('#theme-select').options].map(o => [o.value, o.textContent]);
    const canvas = document.createElement('canvas'); Object.assign(canvas, theme.viewport);
    const c = canvas.getContext('2d', { willReadFrequently: true });
    const agents = [...v.engine.snapshot(), ...v.life.snapshot()], assets = {};
    const draw = (condition = 'clear', t = 0, night = true, actors = []) => {
      theme.drawScene(c, actors, t, { environment: { night, condition }, doors: v.life.doors });
    };
    for (const [name, night] of [['day', false], ['night', true]]) {
      draw('clear', 0, night, agents); assets[name] = canvas.toDataURL().split(',')[1];
    }
    const sample = (x, y, size = 16) => c.getImageData(x - size / 2, y - size / 2, size, size).data;
    const outdoors = () => c.getImageData(0, 0, canvas.width, 220).data;
    const changed = (a, b) => a.some((value, i) => value !== b[i]);
    const indoor = theme.project(350, 900), weather = [];
    for (const condition of ['rain', 'snow']) {
      draw(condition, 0); const inside = sample(indoor.x, indoor.y), outside = outdoors();
      draw(condition, 390);
      weather.push({ condition, indoorStable: !changed(inside, sample(indoor.x, indoor.y)), moving: changed(outside, outdoors()) });
    }
    // 강수가 멎은 뒤 같은 흐림 캐시를 재사용해도 창문에 입자가 남지 않아야 한다.
    draw('rain', 390); draw('cloudy'); const cleared = c.getImageData(0, 0, canvas.width, canvas.height).data;
    releaseScenery(); draw('cloudy'); const rebuilt = c.getImageData(0, 0, canvas.width, canvas.height).data;
    const weatherCleared = !changed(cleared, rebuilt);
    draw('clear');
    let allocations = 0;
    const create = document.createElement;
    document.createElement = function (tag, ...args) { if (tag === 'canvas') allocations++; return create.call(this, tag, ...args); };
    const start = performance.now();
    try { for (let i = 0; i < 20; i++) draw('clear', i * 130); }
    finally { document.createElement = create; }
    const meanDrawMs = Math.round((performance.now() - start) / 20 * 100) / 100;
    let interiorRaster = null;
    const paint = c.drawImage.bind(c);
    c.drawImage = function (source, ...args) {
      if (source.width === 2624 && source.height === 1640) {
        const transform = this.getTransform();
        interiorRaster = { width: source.width, height: source.height, scaleX: transform.a, scaleY: transform.d };
      }
      return paint(source, ...args);
    };
    try { draw('clear'); } finally { c.drawImage = paint; }
    const front = scenery({ night: true, condition: 'clear' }).foreground.getContext('2d'), foregroundSamples = [];
    for (const [x, y] of [[150, 1890], [1030, 1890], [2140, 810]]) {
      const p = theme.project(x, y), left = Math.round(p.x - 8), top = Math.round(p.y + 156 * .82 * 2 - 65);
      const expected = front.getImageData(left, top, 16, 20).data, actual = c.getImageData(left, top, 16, 20).data;
      let samples = 0, visible = 0;
      for (let i = 0; i < expected.length; i += 4) if (expected[i + 3] === 255) {
        samples++; if ([0, 1, 2, 3].every(k => expected[i + k] === actual[i + k])) visible++;
      }
      foregroundSamples.push({ x, y, samples, visible });
    }

    // 별도 생활 상태에서 화면 좌표 클릭 → 커피 선택 → 소지, 바닥 클릭 → 이동을 실측한다.
    const view = Object.create(OfficeView.prototype), engine = new OfficeEngine(theme.layout);
    Object.assign(view, { theme, engine, life: new OfficeLife(theme.layout, engine), view: { dpr: 1 },
      canvas: { style: {}, parentElement: { clientWidth: 1000, clientHeight: 720 } } });
    view.resize();
    const coffee = theme.layout.interactions.find(i => i.id === 'lounge-coffee');
    Object.assign(view.life.player, coffee.stand);
    const click = point => view.clickAt(point.x * view.camera.scale + view.camera.ox, point.y * view.camera.scale + view.camera.oy);
    const point = theme.project(coffee.x + coffee.w / 2, coffee.y + coffee.d / 2); point.y -= coffee.height * .82;
    click(point);
    for (let i = 0; i < 80 && !view.life.menu; i++) view.life.update(50);
    const menuOpened = view.life.menu?.itemId === coffee.id;
    const chosen = menuOpened && view.life.chooseDrink(view.life.menu.choices[0].id);
    for (let i = 0; i < 180; i++) view.life.update(50);
    const heldDrink = !!view.life.player.heldItem;
    click(theme.project(1000, 576));
    for (let i = 0; i < 400 && view.life.destination; i++) view.life.update(50);
    const moved = Math.hypot(view.life.player.x - 1000, view.life.player.y - 576) < 10;
    return { options, weather, weatherCleared, allocations, meanDrawMs, interiorRaster, foregroundSamples, menuOpened, chosen, heldDrink, moved, assets };
  }.toString()})()`);
  assert.deepEqual(result.options.at(-1), ['pixel-office-japan', '일본']);
  assert.ok(result.weather.every(w => w.moving && w.indoorStable), JSON.stringify(result.weather));
  assert.ok(result.weatherCleared); assert.equal(result.allocations, 0);
  assert.deepEqual(result.interiorRaster, { width: 2624, height: 1640, scaleX: 1, scaleY: 1 });
  assert.ok(result.foregroundSamples.every(s => s.samples > 10 && s.visible === s.samples), JSON.stringify(result.foregroundSamples));
  assert.ok(result.menuOpened && result.chosen && result.heldDrink && result.moved, JSON.stringify({ ...result, assets: undefined }));
  for (const [name, png] of Object.entries(result.assets)) fs.writeFileSync(path.join(out, `office-japan-${name}.png`), Buffer.from(png, 'base64'));
  await win.webContents.executeJavaScript('window.__view.fit();window.__view.draw(0);');
  fs.writeFileSync(path.join(out, 'office-japan-application.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript('window.__view.zoomBy(1.5);window.__view.draw(0);new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));');
  fs.writeFileSync(path.join(out, 'office-japan-zoom.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript('window.__view.fit();');
  await selectTheme('pixel-office');
  const report = { ...result, switched, assets: undefined };
  fs.writeFileSync(path.join(out, 'japan-theme-verification.json'), JSON.stringify(report, null, 2));
  return report;
};
