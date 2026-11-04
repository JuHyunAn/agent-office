import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// 가짜 DOM·xterm·api 로 터미널 패널의 셸 수명(시작·다시 시작·실패·셸 종류)을 시험한다. 실제 화면은 점검(check-code-view)이 본다.
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.className = ''; }
  addEventListener() {}
  setAttribute(k, v) { this.attrs[k] = v; }
  append(...c) { this.children.push(...c); }
  replaceChildren(...c) { this.children = c; }
}
globalThis.Node = El;
globalThis.document = { createElement: (t) => new El(t) };
globalThis.ResizeObserver = class { observe() {} };
let frames = [];
globalThis.requestAnimationFrame = (cb) => { frames.push(cb); };
const flush = () => { const f = frames; frames = []; for (const cb of f) cb(); };
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); } };

const { createTerminalPanel } = await import('../src/renderer/code/terminalPanel.js');

let api, terms, creates, writes, pending, panel, shellChanges;
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  frames = [];
  store.clear();
  terms = [];
  creates = [];
  writes = [];
  shellChanges = 0;
  pending = null; // 값이 있으면 createPty 가 이 약속을 기다린다 ({ resolve, reject })
  api = {
    createPty: (o) => {
      creates.push(o);
      if (!pending) return Promise.resolve({ sessionId: null });
      return new Promise((resolve, reject) => { pending.resolve = resolve; pending.reject = reject; });
    },
    writePty: (id, data) => { writes.push([id, data]); },
    resizePty() {},
  };
  const newTerminal = () => {
    const t = { out: [], cols: 80, rows: 24, onData(cb) { t.data = cb; }, write(s) { t.out.push(s); }, open() {}, focus() {} };
    terms.push(t);
    return { term: t, fit: { fit() {} } };
  };
  panel = createTerminalPanel({ api, newTerminal, onShellChange: () => { shellChanges++; } });
});

const text = (t) => t.out.join('');
// 폴더를 정하고 보이게 해서 셸이 뜨기까지 진행한다
async function boot(root = 'C:\\a') {
  panel.setRoot(root);
  panel.activate();
  flush();
  await settle();
}

test('보이기 전에는 셸을 만들지 않고, 보이면 등록 폴더에서 PowerShell 을 mode:shell 로 연다', async () => {
  panel.setRoot('C:\\a');
  flush();
  assert.equal(creates.length, 0);
  panel.activate();
  flush();
  await settle();
  assert.equal(creates.length, 1);
  assert.deepEqual({ mode: creates[0].mode, shell: creates[0].shell, cwd: creates[0].cwd }, { mode: 'shell', shell: 'powershell', cwd: 'C:\\a' });
  assert.match(creates[0].tabId, /^code-term-\d+$/);
});

test('셸이 살아 있을 때 셸 종류를 바꾸면 재시작하지 않고 안내만 하고, 다시 시작이 새 값을 쓴다', async () => {
  await boot();
  panel.setShell('bash');
  await settle();
  assert.equal(creates.length, 1, '살아 있는 셸을 끊지 않는다');
  assert.equal(panel.getShell(), 'bash');
  assert.match(text(terms[0]), /다음 시작부터 Git Bash 을 씁니다 — 「다시 시작」을 누르세요/);
  panel.restart();
  await settle();
  assert.equal(creates.length, 2);
  assert.equal(creates[1].shell, 'bash');
  assert.equal(creates[1].tabId, creates[0].tabId);
});

test('끝난 셸·아직 안 연 터미널은 셸 종류를 바꾸면 곧바로 그 셸로 시작한다', async () => {
  await boot();
  panel.onPtyExit(creates[0].tabId, 0);
  panel.setShell('bash');
  await settle();
  assert.equal(creates.length, 2);
  assert.equal(creates[1].shell, 'bash');
  // 아직 안 열린 폴더
  panel.setRoot('C:\\b');
  flush();
  await settle();
  assert.equal(creates[2].cwd, 'C:\\b');
  assert.equal(creates[2].shell, 'bash', '저장값이 새 폴더의 기본값');
});

test('폴더마다 셸이 따로이고 getShell 은 지금 폴더의 것, 저장값은 새 폴더의 기본값일 뿐이다', async () => {
  await boot('C:\\a');
  panel.setRoot('C:\\b');
  flush();
  await settle();
  panel.onPtyExit(creates[1].tabId, 0);
  panel.setShell('bash'); // B 만 Git Bash (B 는 끝난 상태라 바로 시작)
  await settle();
  assert.equal(panel.getShell(), 'bash');
  panel.setRoot('C:\\a');
  assert.equal(panel.getShell(), 'powershell', 'A 는 그대로 PowerShell');
  panel.setRoot('C:\\b');
  assert.equal(panel.getShell(), 'bash');
  panel.setRoot('C:\\c');
  flush();
  await settle();
  assert.equal(creates[creates.length - 1].shell, 'bash', '새 폴더는 마지막 저장값으로 시작');
  panel.setRoot('C:\\a');
  flush();
  panel.restart();
  await settle();
  assert.equal(creates[creates.length - 1].cwd, 'C:\\a');
  assert.equal(creates[creates.length - 1].shell, 'powershell', 'A 의 다시 시작은 A 의 셸을 쓴다');
});

test('띄우는 중에 다시 시작을 눌러도 무시한다', async () => {
  await boot();
  pending = {};
  panel.restart();
  assert.equal(creates.length, 2);
  panel.restart();
  panel.restart();
  assert.equal(creates.length, 2, '진행 중 launch 가 있으면 무시');
  pending.resolve({ sessionId: null });
  await settle();
  pending = null;
  panel.restart();
  await settle();
  assert.equal(creates.length, 3);
});

test('살아 있던 셸을 다시 시작하다 실패하면 입력이 계속 가고 셸 종류·저장값이 되돌아간다', async () => {
  await boot();
  const id = creates[0].tabId;
  panel.setShell('bash');
  const changed = shellChanges;
  pending = {};
  panel.restart();
  pending.reject(new Error("Error invoking remote method 'pty:create': Error: Git Bash 를 찾지 못했습니다"));
  await settle();
  pending = null;
  assert.match(text(terms[0]), /⚠ Git Bash 를 찾지 못했습니다/);
  assert.ok(!/Error invoking/.test(text(terms[0])));
  terms[0].data('x');
  assert.deepEqual(writes.at(-1), [id, 'x'], '옛 셸이 살아 있으니 입력이 계속 간다');
  assert.equal(panel.getShell(), 'powershell');
  assert.equal(store.get('ao.termShell'), 'powershell');
  assert.ok(shellChanges > changed, '화면(select)에 알린다');
});

test('처음 띄우기에 실패하면 끝난 상태: 입력은 가지 않고 Enter 로 다시 시작한다', async () => {
  pending = {};
  panel.setRoot('C:\\a');
  panel.activate();
  flush();
  pending.reject(new Error('Git Bash 를 찾지 못했습니다'));
  await settle();
  pending = null;
  assert.match(text(terms[0]), /⚠ Git Bash/);
  terms[0].data('x');
  assert.equal(writes.length, 0);
  terms[0].data('\r');
  await settle();
  assert.equal(creates.length, 2);
});

test('종료 뒤 다시 시작하면 띄우기에 성공한 뒤에야 입력이 전달된다', async () => {
  await boot();
  const id = creates[0].tabId;
  panel.onPtyExit(id, 3);
  assert.match(text(terms[0]), /셸 종료 · 코드 3/);
  terms[0].data('x');
  assert.equal(writes.length, 0, '끝난 셸에는 입력하지 않는다');
  pending = {};
  panel.restart();
  terms[0].data('y');
  assert.equal(writes.length, 0, '띄우는 중에도 아직 끝난 상태');
  pending.resolve({ sessionId: null });
  await settle();
  pending = null;
  terms[0].data('z');
  assert.deepEqual(writes, [[id, 'z']]);
});

test('자기 터미널 ID 의 출력·종료만 처리한다', async () => {
  await boot();
  const id = creates[0].tabId;
  assert.equal(panel.onPtyData(id, 'hi'), true);
  assert.equal(panel.onPtyData('t123', 'hi'), false);
  assert.equal(panel.onPtyData('login', 'hi'), false);
  assert.equal(panel.onPtyExit('t123', 0), false);
  assert.equal(panel.onPtyExit(id, 0), true);
  assert.equal(text(terms[0]).includes('hi'), true);
});
