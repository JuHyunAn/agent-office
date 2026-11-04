import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// node-pty 자리에 가짜를 끼운다 — 실제 터미널 없이 데이터·종료 콜백만 직접 부른다.
const spawned = [];
let failSpawn = false;
const fakePty = {
  spawn: () => {
    if (failSpawn) throw new Error('실행 실패');
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

test('count(kind) 는 종류별로 센다 — 인자가 없으면 전체, kill·종료·교체 때 지운다', () => {
  const m = new PtyManager({ onData() {}, onExit() {} });
  m.create({ tabId: 'a', file: 'x', args: [] });
  m.create({ tabId: 'b', file: 'x', args: [], kind: 'session' });
  m.create({ tabId: 'code-term-1', file: 'x', args: [], kind: 'shell' });
  assert.equal(m.count(), 3, '인자가 없으면 전체');
  assert.equal(m.count('session'), 2, 'kind 를 안 주면 세션');
  assert.equal(m.count('shell'), 1);
  const shell = spawned[spawned.length - 1];
  m.create({ tabId: 'code-term-1', file: 'x', args: [], kind: 'session' });
  assert.equal(m.count('shell'), 0, '같은 ID 로 다시 만들면 종류도 새로 기억한다');
  assert.equal(m.count('session'), 3);
  m.create({ tabId: 'code-term-1', file: 'x', args: [], kind: 'shell' });
  assert.equal(m.count('session'), 2);
  m.kill('code-term-1');
  assert.equal(m.count('shell'), 0, 'kill 하면 종류도 지운다');
  assert.equal(m.kinds.size, m.map.size, '종류 맵이 프로세스 맵과 같은 크기');
  m.create({ tabId: 'code-term-2', file: 'x', args: [], kind: 'shell' });
  spawned[spawned.length - 1].exit({ exitCode: 0 });
  assert.equal(m.count('shell'), 0, '종료하면 종류도 지운다');
  assert.equal(m.kinds.size, m.map.size);
  assert.ok(shell.killed);
  m.killAll();
  assert.equal(m.count(), 0);
  assert.equal(m.kinds.size, 0);
});

test('새 프로세스를 띄우지 못하면 이전 프로세스는 그대로 살아 있다', () => {
  const got = [];
  const m = new PtyManager({ onData: (id, d) => got.push(d), onExit: () => {} });
  m.create({ tabId: 't3', file: 'x', args: [], kind: 'shell' });
  const old = spawned[spawned.length - 1];
  failSpawn = true;
  try {
    assert.throws(() => m.create({ tabId: 't3', file: 'x', args: [], kind: 'session' }), /실행 실패/);
  } finally {
    failSpawn = false;
  }
  assert.equal(old.killed, false, '실패했는데 이전 프로세스를 끝냈다');
  assert.equal(m.count('shell'), 1, '종류도 그대로');
  old.data('계속 출력');
  assert.deepEqual(got, ['계속 출력'], '이전 프로세스의 출력이 계속 전달된다');
  m.kill('t3');
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
