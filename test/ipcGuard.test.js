import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMainGuard } = require('../src/main/ipcGuard.cjs');

// 가짜 ipcMain: 등록된 처리기를 모아 둔다
function fakeIpc() {
  const handlers = new Map();
  const listeners = new Map();
  return { handlers, listeners, handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => listeners.set(ch, fn) };
}
const winOf = (destroyed = false) => ({ webContents: { id: 'main' }, isDestroyed: () => destroyed });

test('handleMain: 메인 창에서 온 요청만 처리하고 다른 보낸 쪽은 던진다', async () => {
  const ipc = fakeIpc();
  const win = winOf();
  const { handleMain } = createMainGuard(ipc, () => win);
  const calls = [];
  handleMain('x', (...a) => { calls.push(a); return 'ok'; });
  const fn = ipc.handlers.get('x');
  assert.equal(await fn({ sender: win.webContents }, 1, 2), 'ok');
  assert.deepEqual(calls, [[1, 2]], '이벤트를 뗀 인자만 전달');
  assert.throws(() => fn({ sender: { id: 'pet' } }, 1), { message: '허용되지 않는 요청입니다' });
  assert.throws(() => fn({}, 1), { message: '허용되지 않는 요청입니다' });
  assert.throws(() => fn(undefined, 1), { message: '허용되지 않는 요청입니다' });
  assert.equal(calls.length, 1, '거부된 요청은 처리기를 부르지 않는다');
});

test('onMain: 다른 보낸 쪽의 요청은 조용히 무시한다', () => {
  const ipc = fakeIpc();
  const win = winOf();
  const { onMain } = createMainGuard(ipc, () => win);
  const calls = [];
  onMain('y', (...a) => calls.push(a));
  const fn = ipc.listeners.get('y');
  fn({ sender: win.webContents }, 'a');
  fn({ sender: { id: 'pet' } }, 'b');
  fn({}, 'c');
  assert.deepEqual(calls, [['a']]);
});

test('메인 창이 없거나 닫혔으면 모두 거부한다', () => {
  const ipc = fakeIpc();
  let win = null;
  const { handleMain, onMain, fromMain } = createMainGuard(ipc, () => win);
  const calls = [];
  handleMain('h', () => calls.push('h'));
  onMain('o', () => calls.push('o'));
  const sender = { id: 'main' };
  assert.equal(fromMain({ sender }), false, '창이 없음');
  assert.throws(() => ipc.handlers.get('h')({ sender }), { message: '허용되지 않는 요청입니다' });
  ipc.listeners.get('o')({ sender });
  win = { webContents: sender, isDestroyed: () => true };
  assert.equal(fromMain({ sender }), false, '창이 닫힘');
  assert.throws(() => ipc.handlers.get('h')({ sender }), { message: '허용되지 않는 요청입니다' });
  ipc.listeners.get('o')({ sender });
  assert.deepEqual(calls, []);
  win = { webContents: sender, isDestroyed: () => false };
  assert.equal(fromMain({ sender }), true);
});
