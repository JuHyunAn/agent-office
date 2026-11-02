'use strict';
// 승인된 대표 자세를 고정 크기로 정렬하고, 부분 변형으로 반복 동작을 미리 굽는다.
// 재생 중에는 그림을 가공하지 않고 기존 펫 규격의 프레임만 읽는다.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const ROOT = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const { cleanEnv } = require('../src/main/env.cjs');
  const child = spawn(require('electron'), [__filename], { env: cleanEnv(), stdio: 'inherit', windowsHide: true });
  child.on('error', e => { console.error(e); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, protocol, net } = require('electron');
  const { pathToFileURL } = require('node:url');
  app.disableHardwareAcceleration();
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'ao-build-art-')));
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  const timer = setTimeout(() => app.exit(1), 60000);
  app.whenReady().then(async () => {
    protocol.handle('app', req => {
      if (new URL(req.url).pathname === '/build.html') return new Response('<!doctype html><meta charset="utf-8">', { headers: { 'content-type': 'text/html' } });
      const target = path.resolve(ROOT, '.' + decodeURIComponent(new URL(req.url).pathname));
      return target.startsWith(ROOT + path.sep) ? net.fetch(pathToFileURL(target).toString()) : new Response('', { status: 403 });
    });
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, backgroundThrottling: false } });
    await win.loadURL('app://office/build.html');
    const result = await win.webContents.executeJavaScript(`(${build.toString()})()`);
    for (const [kind, assets] of Object.entries(result)) {
      const dir = path.join(ROOT, 'src/renderer/assets/pets', 'office-' + kind);
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, data] of Object.entries(assets)) fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from(data.split(',')[1], 'base64'));
      const names = { grok: '그록', muse: '뮤즈', antigravity: '제미나이 · 안티그래비티' };
      fs.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify({
        id: 'office-' + kind, displayName: names[kind], description: '승인된 전용 디자인 · 기본 9동작과 별도 수면',
        spritesheetPath: 'spritesheet.png', agentOffice: { sleepSheetPath: 'sleep.png' },
      }, null, 2) + '\n');
    }
    console.log('새 캐릭터 3종: 기본 57칸 + 수면 6칸 + 사무실 대표 자세 저장 완료');
    clearTimeout(timer); app.exit(0);
  }).catch(e => { console.error(e); clearTimeout(timer); app.exit(1); });
}

async function build() {
  const { ROWS } = await import('/src/renderer/pet/model.js');
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const load = src => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = src; });
  const cuts = { grok: [190, 490, 870, 1230], muse: [40, 445, 830, 1230], antigravity: [40, 420, 820, 1210] };
  const result = {};
  for (const kind of Object.keys(cuts)) {
    const image = await load('/art/agents/' + kind + '.png');
    const poses = Array.from({ length: 12 }, (_, index) => {
      const row = Math.floor(index / 4), d = image.naturalWidth / 1280;
      const margin = kind === 'antigravity' && [6, 10].includes(index) ? 12 * d : 0;
      const w = image.naturalWidth / 4 - margin * 2, h = (cuts[kind][row + 1] - cuts[kind][row]) * d;
      const cell = canvas(Math.round(w), Math.round(h)), c = cell.getContext('2d', { willReadFrequently: true });
      c.drawImage(image, index % 4 * image.naturalWidth / 4 + margin, cuts[kind][row] * d, w, h, 0, 0, cell.width, cell.height);
      const pixels = c.getImageData(0, 0, cell.width, cell.height).data;
      const xs = new Float64Array(cell.width), ys = new Float64Array(cell.height); let mass = 0;
      for (let y = 0; y < cell.height; y++) for (let x = 0; x < cell.width; x++) {
        const a = pixels[(y * cell.width + x) * 4 + 3]; if (a < 64) continue;
        xs[x] += a; ys[y] += a; mass += a;
      }
      const range = arr => {
        let lo = 0, hi = arr.length - 1, sum = 0;
        for (; lo < hi; lo++) { sum += arr[lo]; if (sum > mass * .001) break; }
        sum = 0; for (; hi > lo; hi--) { sum += arr[hi]; if (sum > mass * .001) break; }
        return [Math.max(0, lo - 2), Math.min(arr.length - 1, hi + 2)];
      };
      const [left, right] = range(xs), [top, bottom] = range(ys), bw = right - left + 1, bh = bottom - top + 1;
      // 자세별 키를 고정해 수면·착석 컷을 서 있는 키까지 늘리지 않는다.
      const heights = kind === 'grok' ? [156, 156, 154, 154, 166, 176, 153, 166, 173, 166, 113, 172]
        : [178, 178, 178, 178, 180, 176, 166, 170, 178, 178, 113, 180];
      const scale = Math.min(172 / bw, heights[index] / bh), dw = bw * scale, dh = bh * scale;
      const frame = canvas(192, 208), f = frame.getContext('2d');
      f.imageSmoothingEnabled = true; f.imageSmoothingQuality = 'high';
      f.drawImage(cell, left, top, bw, bh, (192 - dw) / 2, 194 - dh, dw, dh);
      return frame;
    });
    const sheet = canvas(1536, 1872), sleep = canvas(1536, 208), atlas = canvas(768, 624);
    poses.forEach((p, i) => atlas.getContext('2d').drawImage(p, i % 4 * 192, Math.floor(i / 4) * 208));
    for (const [state, def] of Object.entries(ROWS)) {
      const target = (state === 'sleeping' ? sleep : sheet).getContext('2d');
      for (let n = 0; n < def.ms.length; n++) {
        const frame = canvas(192, 208), c = frame.getContext('2d'), phase = n / def.ms.length * Math.PI * 2;
        let pose = { idle: n === 2 ? 1 : 0, 'running-right': 2, 'running-left': 3, waving: 4,
          jumping: 5, failed: 9, waiting: 8, running: 6, review: 7, sleeping: 10 }[state];
        const source = poses[pose], breathing = Math.sin(phase);
        c.save();
        let dy = 0, sx = 1, sy = 1, tilt = 0;
        if (state.startsWith('running-')) { dy = -Math.abs(Math.sin(phase)) * 3; tilt = breathing * .012; }
        else if (state === 'jumping') { dy = -[0, 4, 8, 4, 0][n]; sx = [1.03, .98, .96, .98, 1.03][n]; sy = 1 + (1 - sx) * .5; }
        else if (state === 'failed') tilt = breathing * .045;
        else if (state === 'waving') tilt = breathing * .025;
        else if (state === 'waiting') { tilt = breathing * .018; dy = -Math.max(0, breathing); }
        else { sy = 1 + breathing * (state === 'sleeping' ? .014 : .008); }
        c.translate(96, 194 + dy); c.rotate(tilt); c.scale(sx, sy); c.translate(-96, -194);
        // 부분 리깅: 이동 시 두 발의 높이를 반대로, 인사 시 바깥 팔을, 업무 시 손을 움직인다.
        // 구체는 팔다리를 만들지 않고 아랫면의 탄성만 표현한다.
        if (state.startsWith('running-') && kind !== 'grok') {
          c.drawImage(source, 0, 0, 192, 158, 0, 0, 192, 158);
          for (let side = 0; side < 2; side++) {
            const step = Math.max(0, Math.sin(phase + side * Math.PI)) * 4;
            c.drawImage(source, side * 96, 158, 96, 50, side * 96, 158 - step, 96, 50);
          }
        } else if (['waving', 'running', 'review'].includes(state)) {
          // 가로 띠를 조금씩 이동해 몸통은 고정하고 팔·고개에 움직임을 분산한다.
          for (let y = 0; y < 208; y += 2) {
            const weight = state === 'waving' ? Math.sin(y / 208 * Math.PI) : y > 115 && y < 165 ? 1 : 0;
            const dx = breathing * weight * (state === 'waving' ? 2 : 1.3);
            c.drawImage(source, 0, y, 192, 2, dx, y, 192, 2);
          }
        } else c.drawImage(source, 0, 0);
        c.restore();
        target.drawImage(frame, n * 192, (def.row || 0) * 208);
      }
    }
    result[kind] = { spritesheet: sheet.toDataURL(), sleep: sleep.toDataURL(), poses: atlas.toDataURL() };
  }
  return result;
}
