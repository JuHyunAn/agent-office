'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'output/design/agent-pixel-office-20261102');
if (!process.versions.electron) {
  const { spawn } = require('node:child_process'), { cleanEnv } = require('../src/main/env.cjs');
  const child = spawn(require('electron'), [__filename], { env: cleanEnv(), stdio: 'inherit', windowsHide: true });
  child.on('error', e => { console.error(e); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, protocol, net, ipcMain } = require('electron');
  const { pathToFileURL } = require('node:url'), assert = require('node:assert/strict');
  const { readPet } = require('../src/main/petRules.cjs');
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const errors = [], requests = [], sizes = [], ids = ['claude', 'codex', 'grok', 'muse', 'antigravity'];
  app.disableHardwareAcceleration(); app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'ao-art-check-')));
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  const timer = setTimeout(() => { console.error('캐릭터 검증 시간 초과'); app.exit(1); }, 60000);
  app.whenReady().then(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    protocol.handle('app', req => {
      if (new URL(req.url).pathname === '/art-check.html') return new Response('<!doctype html><meta charset="utf-8">', { headers: { 'content-type': 'text/html' } });
      const target = path.resolve(ROOT, '.' + decodeURIComponent(new URL(req.url).pathname));
      return target.startsWith(ROOT + path.sep) ? net.fetch(pathToFileURL(target).toString()) : new Response('', { status: 403 });
    });
    const watch = win => win.webContents.on('console-message', e => { if (e.level === 'error' || e.level === 3) errors.push(e.message); });
    const board = new BrowserWindow({ show: false, webPreferences: { sandbox: true, backgroundThrottling: false } }); watch(board);
    await board.loadURL('app://office/art-check.html');
    const result = await board.webContents.executeJavaScript(`(${inspectOffice.toString()})()`);
    for (const [name, data] of Object.entries(result.assets)) fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data.split(',')[1], 'base64'));
    for (const [kind, states] of Object.entries(result.metrics.frames)) for (const [state, frames] of Object.entries(states)) {
      for (const f of frames) assert.ok(f.pixels > 200 && !f.clipped, `${kind}/${state}/${f.index}: ${JSON.stringify(f)}`);
      assert.ok(new Set(frames.map(f => f.hash)).size >= 3, `${kind}/${state} 반복 컷`);
    }
    assert.equal(result.metrics.residents.length, 6);
    assert.ok(result.metrics.residents.every(a => a.walkable));
    for (const kind of ['grok', 'muse', 'antigravity']) {
      const sprite = result.metrics.officeSprites[kind];
      assert.ok(sprite.colors <= 15 && sprite.height <= 30 && !sprite.translucent, `${kind} 사무실 픽셀 규격`);
    }
    ipcMain.handle('pet:sprite', (_e, p) => {
      requests.push(p); const art = readPet(path.join(ROOT, 'src/renderer/assets/pets'), p.key.replace(/^builtin:/, ''));
      return art ? { ...art, key: p.key, version: 1 } : { key: p.key, none: true };
    });
    for (const ch of ['size', 'hover', 'drag', 'open', 'perm', 'usage:refresh', 'usage:toggle']) ipcMain.on('pet:' + ch, (_e, v) => { if (ch === 'size') sizes.push(v); });
    const pet = new BrowserWindow({ width: 680, height: 200, show: false, webPreferences: {
      preload: path.join(ROOT, 'src/main/preload-pet.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true,
    } }); watch(pet);
    await pet.loadURL('app://office/src/renderer/pet/index.html'); await pause(100);
    await pet.webContents.executeJavaScript("window.__petNow=()=>0;document.body.style.background='#edf1f6'");
    const names = ['클로드', '코덱스', '그록', '뮤즈', '제미나이'];
    const state = { mode: 'always', codex: true, inUse: ids, sprites: Object.fromEntries(ids.map(k => [k, 'builtin:office-' + k])),
      kinds: Object.fromEntries(ids.map((k, i) => [k, { working: false, attention: [{ kind: 'info', text: names[i], at: 0 }] }])) };
    const read = () => pet.webContents.executeJavaScript(`[...document.querySelectorAll('.pet')].map(p=>({kind:p.dataset.kind,state:p.dataset.state,
      canvas:(()=>{const c=p.querySelector('canvas'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let count=0,edge=0,hash=0;const colors=new Set();for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const i=(y*c.width+x)*4;if(d[i+3]>64){count++;colors.add((d[i]<<16)|(d[i+1]<<8)|d[i+2]);if(!x||!y||x===c.width-1||y===c.height-1)edge++;hash=(Math.imul(hash,31)+d[i]+d[i+1]+d[i+2])|0;}}return {count,edge,hash,colors:colors.size};})()}))`);
    const send = async kinds => { pet.webContents.send('pet:state', { ...state, kinds }); await pause(350); return read(); };
    await send(state.kinds); await pause(700);
    if (sizes.length) pet.setSize(sizes.at(-1).width, sizes.at(-1).height); await pause(100);
    const initial = await read(); assert.equal(initial.length, 5); assert.equal(requests.length, 5);
    assert.ok(initial.every(p => p.canvas.count > 200 && !p.canvas.edge));
    fs.writeFileSync(path.join(OUT, 'desktop-row.png'), (await pet.webContents.capturePage()).toPNG());
    const transitions = {};
    for (const [name, kinds] of [
      ['running', Object.fromEntries(ids.map(k => [k, { working: true }]))],
      ['waiting', Object.fromEntries(ids.map(k => [k, { attention: [{ kind: 'alert', text: '권한 확인', reason: 'permission' }] }]))],
      ['failed', Object.fromEntries(ids.map(k => [k, { attention: [{ kind: 'alert', text: '오류', reason: 'collab-error' }] }]))],
      ['waving', Object.fromEntries(ids.map(k => [k, { attention: [{ kind: 'done', text: '완료' }] }]))],
    ]) {
      transitions[name] = await send(kinds);
      assert.ok(transitions[name].every(p => p.state === name && p.canvas.count > 200 && !p.canvas.edge), name);
    }
    await send(Object.fromEntries(ids.map(k => [k, {}])));
    await pet.webContents.executeJavaScript('void(window.__petNow=()=>360000)');
    transitions.sleeping = await send(Object.fromEntries(ids.map(k => [k, {}])));
    assert.ok(transitions.sleeping.every(p => p.state === 'sleeping' && p.canvas.count > 200 && !p.canvas.edge));
    assert.equal(requests.length, 5, '상태가 바뀌어도 같은 그림을 다시 요청하지 않는다');
    // 아이콘 선택 시의 대체 그림도 사무실 도트로 바뀌지 않았는지 확인한다.
    await pet.webContents.executeJavaScript('void(window.__petNow=()=>0)');
    pet.webContents.send('pet:state', { ...state, sprites: Object.fromEntries(ids.map(k => [k, 'none'])), kinds: Object.fromEntries(ids.map(k => [k, {}])) });
    await pause(900);
    const fallback = await read();
    assert.ok(fallback.filter(p => ['grok', 'muse', 'antigravity'].includes(p.kind)).every(p => p.canvas.colors > 100 && !p.canvas.edge), '바탕화면 대체 그림의 세밀한 질감 유지');
    const row = fs.readFileSync(path.join(OUT, 'desktop-row.png')).toString('base64');
    const combined = await board.webContents.executeJavaScript(`(async()=>{const i=new Image();i.src='data:image/png;base64,${row}';await i.decode();const c=document.createElement('canvas');c.width=2240;c.height=2200;const q=c.getContext('2d');q.fillStyle='#edf1f6';q.fillRect(0,0,c.width,c.height);q.drawImage(window.artBoard,0,0);q.fillStyle='#304456';q.font='bold 28px "Malgun Gothic"';q.fillText('바탕화면 · 실제 전용 펫 5종',48,1865);q.imageSmoothingEnabled=false;q.drawImage(i,(2240-i.width*2)/2,1880,i.width*2,i.height*2);return c.toDataURL();})()`);
    fs.writeFileSync(path.join(OUT, 'actual.png'), Buffer.from(combined.split(',')[1], 'base64'));
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify({ ...result.metrics, desktop: initial, fallback, transitions, spriteRequests: requests.length, errors }, null, 2));
    console.log(JSON.stringify({ result: '3종 189프레임·사무실 6명·바탕화면 5종·상태 전환·잘림·캐시 검증 통과', output: OUT, errors }));
    clearTimeout(timer); app.exit(0);
  }).catch(e => { console.error(e.stack || e); console.error(errors); clearTimeout(timer); app.exit(1); });
}

async function inspectOffice() {
  const { getTheme, THEMES } = await import('/src/renderer/themes/index.js');
  const { OfficeEngine } = await import('/src/renderer/office/engine.js');
  const { OfficeLife } = await import('/src/renderer/office/life.js');
  const { drawCharacter } = await import('/src/renderer/themes/pixel-office/sprites.js');
  const { ROWS } = await import('/src/renderer/pet/model.js');
  const make = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const load = async src => { const i = new Image(); i.src = src; await i.decode(); return i; };
  const metrics = { frames: {}, themes: [], officeSprites: {} }, assets = {};
  const style = make(1800, 750), s = style.getContext('2d'); s.fillStyle = '#edf2eb'; s.fillRect(0, 0, 1800, 750);
  s.fillStyle = '#4a4741'; s.font = 'bold 34px "Malgun Gothic"'; s.fillText('사무실 전용 · 같은 도트 격자로 통일', 38, 55);
  s.font = '23px "Malgun Gothic"'; s.fillText('기존 클로드·코덱스와 크기·명암·동작을 비교한 실제 코드 렌더링', 38, 96);
  const kinds = ['claude', 'codex', 'grok', 'muse', 'antigravity'], labels = ['클로드', '코덱스', '유니', '루프', '코코'];
  for (let n = 0; n < kinds.length; n++) {
    const kind = kinds[n], sprite = make(80, 80), c = sprite.getContext('2d', { willReadFrequently: true });
    const actor = { cli: kind, pose: 'stand', status: 'idle', facing: 'down', colorIndex: 0, appearance: {} };
    drawCharacter(c, actor, 0, 40, 60);
    const d = c.getImageData(0, 0, 80, 80).data, colors = new Set(); let top = 80, bottom = 0, translucent = false;
    for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) {
      const i = (y * 80 + x) * 4; if (!d[i + 3]) continue;
      colors.add(`${d[i]},${d[i + 1]},${d[i + 2]}`); top = Math.min(top, y); bottom = Math.max(bottom, y);
      if (d[i + 3] !== 255) translucent = true;
    }
    metrics.officeSprites[kind] = { colors: colors.size, height: bottom - top + 1, translucent };
    const x = 185 + n * 355; s.fillStyle = '#4a4741'; s.font = 'bold 27px "Malgun Gothic"'; s.textAlign = 'center'; s.fillText(labels[n], x, 148);
    s.save(); s.translate(x, 350); s.scale(6, 6); drawCharacter(s, actor, 0, 0, 0); s.restore();
    s.save(); s.translate(x, 640); s.scale(6, 6); drawCharacter(s, { ...actor, pose: 'type', status: 'working' }, 130, 0, 0); s.restore();
    s.font = '21px "Malgun Gothic"'; s.fillText(`${colors.size}색 · 높이 ${bottom - top + 1}도트`, x, 715);
  }
  assets.officeStyle = style.toDataURL();
  for (const kind of ['grok', 'muse', 'antigravity']) {
    const sheet = await load('/src/renderer/assets/pets/office-' + kind + '/spritesheet.png');
    const sleep = await load('/src/renderer/assets/pets/office-' + kind + '/sleep.png');
    metrics.frames[kind] = {};
    for (const [state, def] of Object.entries(ROWS)) {
      metrics.frames[kind][state] = def.ms.map((_, index) => {
        const c = make(192, 208), q = c.getContext('2d', { willReadFrequently: true });
        q.drawImage(state === 'sleeping' ? sleep : sheet, index * 192, (def.row || 0) * 208, 192, 208, 0, 0, 192, 208);
        const d = q.getImageData(0, 0, 192, 208).data; let pixels = 0, clipped = false, hash = 0;
        for (let y = 0; y < 208; y++) for (let x = 0; x < 192; x++) {
          const i = (y * 192 + x) * 4;
          if (d[i + 3] > 64) { pixels++; if (x < 2 || y < 2 || x > 189 || y > 205) clipped = true; }
          hash = (Math.imul(hash, 31) + d[i] + d[i + 1] + d[i + 2] + d[i + 3]) | 0;
        }
        return { index, pixels, clipped, hash };
      });
    }
  }
  const theme = getTheme('pixel-office-plain'); await theme.load();
  const engine = new OfficeEngine(theme.layout), life = new OfficeLife(theme.layout, engine, () => .42);
  for (let n = 0; n < 200; n++) life.update(50);
  metrics.residents = life.snapshot().map(a => ({ id: a.id, label: a.label, cli: a.cli, walkable: life.navigation.isWalkable(a) }));
  const scene = make(3200, 2000), environment = { night: false, condition: 'clear', hour: 12 };
  theme.drawScene(scene.getContext('2d'), life.snapshot(), 10000, { environment, doors: life.doors }); assets.office = scene.toDataURL();
  for (const candidate of THEMES) {
    await candidate.load();
    const e = new OfficeEngine(candidate.layout), l = candidate.createLife ? candidate.createLife(candidate.layout, e) : new OfficeLife(candidate.layout, e);
    const c = make(candidate.viewport.width, candidate.viewport.height);
    candidate.drawScene(c.getContext('2d'), l.snapshot(), 800, { environment, doors: l.doors });
    metrics.themes.push({ id: candidate.id, actors: l.snapshot().length });
  }
  const board = make(2240, 1800), q = board.getContext('2d'); q.fillStyle = '#edf1f6'; q.fillRect(0, 0, 2240, 1800);
  q.fillStyle = '#304456'; q.font = 'bold 36px "Malgun Gothic"'; q.fillText('사무실 · 승인한 디자인 적용', 48, 54);
  q.font = '24px "Malgun Gothic"'; q.fillText('나 · 모카 · 덱스 · 유니 · 루프 · 코코  |  생활 캐릭터 6명', 48, 94);
  q.imageSmoothingEnabled = false; q.drawImage(scene, 0, 110, 2240, 1400);
  q.fillStyle = '#edf1f6'; q.fillRect(0, 1520, 2240, 280);
  const names = ['유니', '루프', '코코'];
  ['grok', 'muse', 'antigravity'].forEach((kind, col) => {
    const x = 290 + col * 720; q.fillStyle = '#304456'; q.font = 'bold 27px "Malgun Gothic"'; q.fillText(names[col], x - 60, 1565);
    for (let j = 0; j < 3; j++) {
      q.save(); q.translate(x - 120 + j * 150, 1755); q.scale(4, 4);
      drawCharacter(q, { cli: kind, pose: ['stand', 'type', 'read'][j], status: 'idle', facing: 'down', colorIndex: 0 }, 0, 0, j ? 12 : 0); q.restore();
    }
  });
  window.artBoard = board; assets.officeBoard = board.toDataURL();
  return { assets, metrics };
}
