import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// node-pty 자리에 가짜를 끼운다 — 실제 터미널 없이 데이터·종료 콜백만 직접 부른다.
const spawned = [];
const fakePty = {
  spawn: () => {
    const p = {
      pid: spawned.length + 1, killed: false, data: null, exit: null,
      onData(cb) { p.data = cb; }, onExit(cb) { p.exit = cb; }, kill() { p.killed = true; }, write() {}, resize() {},
    };
    spawned.push(p);
    return p;
  },
};
const ptyPath = require.resolve('node-pty');
require.cache[ptyPath] = { id: ptyPath, filename: ptyPath, loaded: true, exports: fakePty };
const { PtyManager } = require('../src/main/ptyManager.cjs');

test('같은 탭 ID 로 다시 만들면 이전 프로세스의 늦은 출력·종료는 새 프로세스로 가지 않는다', () => {
  const got = [];
  const m = new PtyManager({ onData: (id, d) => got.push(['data', id, d]), onExit: (id, c) => got.push(['exit', id, c]) });
  m.create({ tabId: 't1', file: 'x', args: [] });
  const [first] = spawned.slice(-1);
  m.create({ tabId: 't1', file: 'x', args: [] });
  const second = spawned[spawned.length - 1];
  assert.ok(first.killed, '이전 프로세스는 종료 요청을 받는다');
  first.data('옛 출력');
  first.exit({ exitCode: 1 });
  assert.deepEqual(got, [], '이전 프로세스의 이벤트는 버린다');
  assert.equal(m.count(), 1, '새 프로세스가 맵에 남아 있다');
  second.data('새 출력');
  second.exit({ exitCode: 0 });
  assert.deepEqual(got, [['data', 't1', '새 출력'], ['exit', 't1', 0]]);
  assert.equal(m.count(), 0);
});

test('kill 한 프로세스의 늦은 종료도 알리지 않는다', () => {
  const got = [];
  const m = new PtyManager({ onData: (id, d) => got.push(d), onExit: (id, c) => got.push(c) });
  m.create({ tabId: 't2', file: 'x', args: [] });
  const p = spawned[spawned.length - 1];
  m.kill('t2');
  p.data('늦은 출력');
  p.exit({ exitCode: 0 });
  assert.deepEqual(got, []);
});
