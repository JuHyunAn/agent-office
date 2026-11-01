import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relInside, touchedFrom, TouchedList, buildTree, createRefresher } from '../src/renderer/code/model.js';

// 마이크로태스크(run 의 await 뒤 후속 처리)가 모두 돌도록 한 번 비운다 (setImmediate 는 mock 대상이 아님).
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('relInside: 대소문자·구분자를 무시하고 root 안이면 / 구분 상대 경로, 밖이면 null', () => {
  assert.equal(relInside('C:\\Repo', 'c:/repo/src/A.js'), 'src/A.js'); // 상대 경로의 대소문자는 그대로
  assert.equal(relInside('C:\\Repo', 'C:\\Repo2\\a.js'), null); // 접두어만 같은 형제 폴더
  assert.equal(relInside('C:\\Repo', 'src\\b.js', 'C:\\Repo'), 'src/b.js');
  assert.equal(relInside('C:\\Repo', 'src\\b.js'), 'src/b.js'); // cwd 가 없으면 root 기준
});

test('relInside: 끝 구분자·연속 구분자·. 와 .. 조각을 정리한다', () => {
  assert.equal(relInside('C:\\Repo\\', 'C:\\Repo\\a.js'), 'a.js');
  assert.equal(relInside('C:/Repo//', 'C://Repo//src//a.js'), 'src/a.js');
  assert.equal(relInside('C:\\Repo', 'C:\\Repo\\a\\..\\b.js'), 'b.js');
  assert.equal(relInside('C:\\Repo', 'C:\\Repo\\.\\src\\.\\c.js'), 'src/c.js');
  assert.equal(relInside('C:\\Repo', 'C:\\Repo\\..\\x.js'), null); // .. 로 root 를 벗어남
  assert.equal(relInside('C:\\Repo', '..\\top.js', 'C:\\Repo\\sub'), 'top.js'); // 상대 경로는 cwd 기준으로 풂
  assert.equal(relInside('C:\\Repo', '..\\..\\top.js', 'C:\\Repo\\sub'), null);
});

test('relInside: root 자신·빈 값·문자열 아님·기준 없는 상대 경로는 null, 한글 경로는 보존', () => {
  assert.equal(relInside('C:\\Repo', 'C:\\Repo'), null);
  assert.equal(relInside('C:\\Repo', 'c:/repo/'), null);
  assert.equal(relInside('C:\\Repo', ''), null);
  assert.equal(relInside('C:\\Repo', null), null);
  assert.equal(relInside('C:\\Repo', undefined), null);
  assert.equal(relInside('', 'a.js'), null);
  assert.equal(relInside(null, 'a.js'), null);
  assert.equal(relInside('Repo', 'a.js'), null); // 절대 경로가 아닌 root
  assert.equal(relInside('C:\\프로젝트', 'c:\\프로젝트\\src\\한글 파일.js'), 'src/한글 파일.js');
  assert.equal(relInside('C:\\Repo', 'D:\\Repo\\a.js'), null); // 다른 드라이브
});

test('touchedFrom: Claude Edit·Read 는 edit·read, 절대 경로를 root 기준 상대 경로로', () => {
  const root = 'C:\\Repo';
  const edit = { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'C:\\Repo\\src\\a.js' }, _at: 5 };
  assert.deepEqual(touchedFrom(edit, root), { rel: 'src/a.js', kind: 'edit', cli: 'claude', at: 5 });
  const read = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'c:/repo/src/a.js' }, _cli: 'claude', _at: 6 };
  assert.deepEqual(touchedFrom(read, root), { rel: 'src/a.js', kind: 'read', cli: 'claude', at: 6 });
  for (const tool_name of ['Edit', 'MultiEdit', 'Write']) {
    assert.equal(touchedFrom({ hook_event_name: 'PreToolUse', tool_name, tool_input: { file_path: 'C:\\Repo\\x.js' }, _at: 1 }, root).kind, 'edit');
  }
  const nb = { hook_event_name: 'PreToolUse', tool_name: 'NotebookEdit', tool_input: { notebook_path: 'C:\\Repo\\n.ipynb' }, _at: 1 };
  assert.deepEqual(touchedFrom(nb, root), { rel: 'n.ipynb', kind: 'edit', cli: 'claude', at: 1 });
});

test('touchedFrom: _at 이 없으면 현재 시각', () => {
  const before = Date.now();
  const r = touchedFrom({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'C:\\Repo\\a.js' } }, 'C:\\Repo');
  assert.ok(r.at >= before && r.at <= Date.now());
});

test('touchedFrom: Codex apply_patch 는 패치 본문의 파일을 ev.cwd 기준으로 푼다', () => {
  const root = 'C:\\Repo';
  const ev = {
    hook_event_name: 'PreToolUse', tool_name: 'apply_patch', _cli: 'codex', cwd: root, _at: 9,
    tool_input: { command: '*** Begin Patch\n*** Update File: src/b.js\n@@\n-a\n+b\n*** End Patch' },
  };
  assert.deepEqual(touchedFrom(ev, root), { rel: 'src/b.js', kind: 'edit', cli: 'codex', at: 9 });
  // 하위 폴더에서 실행 중이면 상대 경로가 그 폴더 기준
  assert.equal(touchedFrom({ ...ev, cwd: 'C:\\Repo\\sub' }, root).rel, 'sub/src/b.js');
  // Add·Delete 도 파일로 본다
  assert.equal(touchedFrom({ ...ev, tool_input: { command: '*** Begin Patch\n*** Add File: n.txt\n+x\n*** End Patch' } }, root).rel, 'n.txt');
});

test('touchedFrom: 대상이 아니면 null (tool_input 없음·root 밖·다른 이벤트·다른 도구)', () => {
  const root = 'C:\\Repo';
  assert.equal(touchedFrom({ hook_event_name: 'PreToolUse', tool_name: 'Edit' }, root), null); // 던지지 않음
  assert.equal(touchedFrom({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: null }, root), null);
  assert.equal(touchedFrom({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch' }, root), null);
  assert.equal(touchedFrom({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'C:\\Other\\a.js' } }, root), null);
  assert.equal(touchedFrom({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'C:\\Repo2\\a.js' } }, root), null);
  assert.equal(touchedFrom({ hook_event_name: 'Stop', tool_name: 'Edit', tool_input: { file_path: 'C:\\Repo\\a.js' } }, root), null);
  assert.equal(touchedFrom({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'C:\\Repo\\a.js' } }, root), null);
  assert.equal(touchedFrom({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, root), null);
  assert.equal(touchedFrom({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { file_path: 'C:\\Repo\\a.js' } }, root), null);
  assert.equal(touchedFrom(null, root), null);
  assert.equal(touchedFrom(undefined, root), null);
});

test('touchedFrom: .git 폴더 안 경로는 대소문자와 무관하게 null (.gitignore 같은 이름은 통과)', () => {
  const root = 'C:\\Repo';
  const of = (file_path) => touchedFrom({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path }, _at: 1 }, root);
  assert.equal(of('C:\\Repo\\.git\\config'), null);
  assert.equal(of('c:/repo/sub/.GIT/HEAD'), null);
  assert.equal(of('C:\\Repo\\.Git'), null);
  assert.equal(of('C:\\Repo\\a\\.git\\x\\y.js'), null);
  assert.equal(of('C:\\Repo\\.gitignore').rel, '.gitignore');
  assert.equal(of('C:\\Repo\\.github\\ci.yml').rel, '.github/ci.yml');
  assert.equal(of('C:\\Repo\\a.git\\x').rel, 'a.git/x');
});

test('TouchedList: 같은 파일은 하나로 합쳐 맨 앞, 한 번이라도 edit 이면 edit 유지', () => {
  const l = new TouchedList();
  assert.equal(l.add({ rel: 'a.js', kind: 'read', cli: 'claude', at: 1 }), true);
  assert.equal(l.add({ rel: 'a.js', kind: 'edit', cli: 'claude', at: 2 }), true);
  assert.deepEqual(l.items(), [{ rel: 'a.js', kind: 'edit', cli: 'claude', at: 2 }]);

  l.add({ rel: 'b.js', kind: 'edit', cli: 'codex', at: 3 });
  assert.deepEqual(l.items().map((x) => x.rel), ['b.js', 'a.js']);
  assert.equal(l.add({ rel: 'a.js', kind: 'read', cli: 'claude', at: 4 }), true); // 맨 앞으로 이동
  assert.deepEqual(l.items().map((x) => [x.rel, x.kind]), [['a.js', 'edit'], ['b.js', 'edit']]); // edit 유지
  assert.equal(l.items()[0].at, 4); // 시각은 최신
});

test('TouchedList: 대소문자만 다른 경로는 같은 파일로 합치고 표기는 최신 항목 것', () => {
  const l = new TouchedList();
  l.add({ rel: 'src/A.js', kind: 'read', cli: 'claude', at: 1 });
  l.add({ rel: 'SRC/a.js', kind: 'edit', cli: 'claude', at: 2 });
  assert.equal(l.items().length, 1);
  assert.deepEqual(l.items()[0], { rel: 'SRC/a.js', kind: 'edit', cli: 'claude', at: 2 });
  l.add({ rel: 'src/a.js', kind: 'read', cli: 'claude', at: 3 });
  assert.deepEqual(l.items().map((x) => [x.rel, x.kind]), [['src/a.js', 'edit']]);
});

test('TouchedList: 시각의 「분」이 바뀌면 add 가 true (표시 시각을 다시 그리게)', () => {
  const l = new TouchedList();
  l.add({ rel: 'a.js', kind: 'edit', cli: 'claude', at: 0 });
  assert.equal(l.add({ rel: 'a.js', kind: 'edit', cli: 'claude', at: 30000 }), false); // 같은 분
  assert.equal(l.add({ rel: 'a.js', kind: 'edit', cli: 'claude', at: 61000 }), true); // 분이 바뀜
  assert.equal(l.add({ rel: 'a.js', kind: 'edit', cli: 'claude', at: 61500 }), false);
  assert.equal(l.items()[0].at, 61500);
});

test('TouchedList: 최대 50개, 오래된 것부터 버림', () => {
  const l = new TouchedList();
  for (let i = 0; i < 51; i++) l.add({ rel: `f${i}.js`, kind: 'edit', cli: 'claude', at: i });
  assert.equal(l.items().length, 50);
  assert.equal(l.items()[0].rel, 'f50.js');
  assert.equal(l.items().at(-1).rel, 'f1.js'); // f0 은 밀려남
});

test('TouchedList: 바뀌지 않으면 add 가 false, clear 로 비움, items 는 복사본', () => {
  const l = new TouchedList();
  l.add({ rel: 'a.js', kind: 'edit', cli: 'claude', at: 1 });
  assert.equal(l.add({ rel: 'a.js', kind: 'edit', cli: 'claude', at: 2 }), false); // 이미 맨 앞·같은 종류
  assert.equal(l.add({ rel: 'a.js', kind: 'read', cli: 'claude', at: 3 }), false); // edit 가 read 로 낮아지지 않음
  l.add({ rel: 'b.js', kind: 'read', cli: 'claude', at: 4 });
  assert.equal(l.add({ rel: 'b.js', kind: 'read', cli: 'claude', at: 5 }), false);
  assert.equal(l.add({ rel: 'b.js', kind: 'read', cli: 'codex', at: 6 }), true); // 에이전트가 바뀜
  l.items().length = 0; // 바깥에서 비워도 목록은 그대로
  assert.equal(l.items().length, 2);
  l.clear();
  assert.deepEqual(l.items(), []);
});

test('buildTree: 폴더 먼저·이름순, 경로는 루트 기준', () => {
  const tree = buildTree(['b.js', 'a/x.js', 'a/b/y.js']);
  assert.equal(tree.dir, true);
  assert.deepEqual(tree.children.map((n) => n.name), ['a', 'b.js']);
  const a = tree.children[0];
  assert.equal(a.dir, true);
  assert.equal(a.path, 'a');
  assert.deepEqual(a.children.map((n) => n.name), ['b', 'x.js']);
  assert.equal(a.children[0].dir, true);
  assert.equal(a.children[1].dir, false);
  assert.equal(a.children[1].path, 'a/x.js');
  assert.equal(a.children[0].children[0].path, 'a/b/y.js');
  assert.equal(tree.children[1].children, undefined); // 파일은 children 없음
});

test('buildTree: 폴더가 파일보다 앞(이름이 늦어도), 한글·빈 입력·중복 처리', () => {
  const names = (t) => t.children.map((n) => n.name);
  // 한글과 영문의 상대 순서는 localeCompare(실행 환경 언어)에 달려 있으니, 같은 글자끼리만 순서를 확인한다.
  assert.deepEqual(names(buildTree(['a.js', 'z/q.js', 'z.js', 'b/q.js', 'c.js'])), ['b', 'z', 'a.js', 'c.js', 'z.js']);
  assert.deepEqual(names(buildTree(['다.js', '나/q.js', '가/나.js', '라.js'])), ['가', '나', '다.js', '라.js']);
  assert.deepEqual(buildTree([]).children, []);
  const dup = buildTree(['a/x.js', 'a/x.js', 'a/y.js']);
  assert.deepEqual(dup.children[0].children.map((n) => n.name), ['x.js', 'y.js']);
});

test('createRefresher: start 즉시 1회, 10초마다 반복, bump 는 3초 뒤로 당김', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let n = 0;
  const r = createRefresher({ run: async () => { n++; } });
  assert.equal(r.running, false);
  r.start();
  assert.equal(r.running, true);
  assert.equal(n, 1); // 즉시 1회
  await flush();
  t.mock.timers.tick(9999);
  await flush();
  assert.equal(n, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(n, 2); // 10초 뒤
  r.bump();
  t.mock.timers.tick(2999);
  await flush();
  assert.equal(n, 2);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(n, 3); // bump 뒤 3초
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(n, 4); // 이후 다시 10초 주기
  r.stop();
});

test('createRefresher: 꺼진 상태의 bump 는 무시 (시작 전·중지 후)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let n = 0;
  const r = createRefresher({ run: async () => { n++; } });
  r.bump();
  t.mock.timers.tick(30000);
  await flush();
  assert.equal(n, 0);
  r.start();
  await flush();
  r.stop();
  assert.equal(r.running, false);
  r.bump();
  t.mock.timers.tick(30000);
  await flush();
  assert.equal(n, 1); // start 때의 1회뿐
});

test('createRefresher: start 를 두 번 불러도 즉시 실행은 1회, 주기도 하나', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let n = 0;
  const r = createRefresher({ run: async () => { n++; } });
  r.start();
  r.start();
  await flush();
  assert.equal(n, 1);
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(n, 2); // 타이머가 둘이면 3
  r.stop();
});

test('createRefresher: run 이 던지거나 거부해도 onError 로 알리고 다음 주기를 예약', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let n = 0;
  const errors = [];
  const r = createRefresher({
    run: async () => { n++; if (n === 1) throw new Error('첫 실패'); },
    onError: (e) => errors.push(e.message),
  });
  r.start();
  await flush();
  assert.deepEqual(errors, ['첫 실패']);
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(n, 2);

  // 동기로 던지는 run 도 같다
  let m = 0;
  const s = createRefresher({ run: () => { m++; throw new Error('동기 실패'); }, onError: (e) => errors.push(e.message) });
  s.start();
  await flush();
  assert.equal(errors.at(-1), '동기 실패');
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(m, 2);

  // onError 가 던져도 주기는 이어진다
  let k = 0;
  const u = createRefresher({ run: async () => { k++; throw new Error('x'); }, onError: () => { throw new Error('onError 실패'); } });
  u.start();
  await flush();
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(k, 2);
  r.stop(); s.stop(); u.stop();
});

test('createRefresher: 실행 중 stop 이면 끝나도 다시 예약하지 않음, 대기 중 stop 은 예약 취소', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let n = 0;
  let release;
  const r = createRefresher({ run: () => { n++; return new Promise((resolve) => { release = resolve; }); } });
  r.start();
  assert.equal(n, 1);
  r.stop();
  release();
  await flush();
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(n, 1); // 재예약 없음

  // 대기 중 stop
  let m = 0;
  const s = createRefresher({ run: async () => { m++; } });
  s.start();
  await flush();
  s.stop();
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(m, 1);
});

test('createRefresher: 실행이 겹치지 않음 (실행 중 start·타이머·stop 후 재start 모두)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let active = 0, peak = 0, n = 0;
  const releases = [];
  const r = createRefresher({
    run: () => {
      n++; active++; peak = Math.max(peak, active);
      return new Promise((resolve) => releases.push(() => { active--; resolve(); }));
    },
  });
  r.start();
  r.start();
  t.mock.timers.tick(30000); // 실행 중에는 타이머가 없다
  await flush();
  assert.equal(n, 1);
  r.stop();
  r.start(); // 아직 이전 실행이 끝나지 않음
  await flush();
  assert.equal(n, 1);
  releases.shift()(); // 끝나면 곧바로 다시 실행 (start 의 즉시 실행)
  await flush();
  assert.equal(n, 2);
  assert.equal(peak, 1);
  r.stop();
  releases.shift()();
  await flush();
  assert.equal(peak, 1);
});

test('createRefresher: 실행 중 bump 는 끝난 뒤 bumpMs 로 예약', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let n = 0;
  let release;
  const r = createRefresher({ run: () => { n++; return new Promise((resolve) => { release = resolve; }); } });
  r.start();
  r.bump(); // 실행 중
  r.bump(); // 여러 번 와도 같다
  release();
  await flush();
  t.mock.timers.tick(2999);
  await flush();
  assert.equal(n, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(n, 2); // 10초가 아니라 3초 뒤
  // 그다음은 다시 10초 주기
  release();
  await flush();
  t.mock.timers.tick(9999);
  await flush();
  assert.equal(n, 2);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(n, 3);
  r.stop();
});

test('createRefresher: 대기 중 남은 시간이 bumpMs 이하면 당기지 않음', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let n = 0;
  const r = createRefresher({ run: async () => { n++; } });
  r.start();
  await flush();
  t.mock.timers.tick(8000); // 남은 2초
  r.bump();
  t.mock.timers.tick(1999);
  await flush();
  assert.equal(n, 1);
  t.mock.timers.tick(1); // 원래 예약(10초)대로 실행. 3초로 늦춰지지 않음
  await flush();
  assert.equal(n, 2);
  // 남은 시간이 정확히 bumpMs 여도 그대로
  t.mock.timers.tick(7000); // 남은 3초
  r.bump();
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(n, 3);
  r.stop();
});

test('createRefresher: 간격·timers 를 바꿀 수 있고, 호출 시점에 timers 의 함수를 쓴다', async () => {
  const calls = [];
  const fake = {
    setTimeout: (fn, ms) => { calls.push(['set', ms]); return calls.length; },
    clearTimeout: (id) => calls.push(['clear', id]),
  };
  let n = 0;
  const r = createRefresher({ run: async () => { n++; }, intervalMs: 500, bumpMs: 50, timers: fake });
  r.start();
  await flush();
  assert.equal(n, 1);
  assert.deepEqual(calls, [['set', 500]]);
  r.bump(); // 남은 500 > 50 이므로 당김: 기존 취소 후 50 으로 다시 예약
  assert.deepEqual(calls.slice(1), [['clear', 1], ['set', 50]]);
  r.stop();
  assert.deepEqual(calls.at(-1), ['clear', 3]);
});

test('createRefresher: 실행 중 stop 하면 끝난 뒤 타이머 자체를 걸지 않음', async () => {
  const calls = [];
  const fake = { setTimeout: (fn, ms) => { calls.push(ms); return 1; }, clearTimeout: () => {} };
  let release;
  const r = createRefresher({ run: () => new Promise((resolve) => { release = resolve; }), timers: fake });
  r.start();
  r.stop();
  release();
  await flush();
  assert.deepEqual(calls, []);
});
