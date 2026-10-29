import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { roleOf, displayType } from '../src/renderer/office/roles.js';
import { toolPhrase } from '../src/renderer/office/phrases.js';

const require = createRequire(import.meta.url);
const hs = require('../src/main/hookSettings.cjs');
const { startHookServer, createDeduper, toEvent } = require('../src/main/hookServer.cjs');
const { exeFromCmdShim, commandFor, tabArgs } = require('../src/main/claudeCli.cjs');
const { cleanEnv } = require('../src/main/env.cjs');

test('역할 분류', () => {
  assert.equal(displayType('oh-my-claudecode:executor'), 'executor');
  assert.equal(roleOf('Explore'), 'analysis');
  assert.equal(roleOf('oh-my-claudecode:analyst'), 'analysis');
  assert.equal(roleOf('oh-my-claudecode:planner'), 'planning');
  assert.equal(roleOf('oh-my-claudecode:architect'), 'planning');
  assert.equal(roleOf('oh-my-claudecode:verifier'), 'review');
  assert.equal(roleOf('oh-my-claudecode:security-reviewer'), 'review');
  assert.equal(roleOf('etl-engineer'), 'dev');
  assert.equal(roleOf('general-purpose'), 'dev');
  assert.equal(roleOf('something', { something: 'review' }), 'review');
});

test('도구 문구', () => {
  assert.equal(toolPhrase('Read', { file_path: 'C:\\x\\y\\Foo.kt' }), '📖 읽는 중: Foo.kt');
  assert.match(toolPhrase('Bash', { command: 'gradlew test', description: '테스트 실행' }), /테스트 실행/);
  assert.match(toolPhrase('mcp__rea__open_binary', {}), /open_binary/);
});

test('사용자 설정 hook: 기존 설정 보존 · 추가/제거 왕복', () => {
  const orig = {
    model: 'opus',
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
  };
  const added = hs.addOurs(orig, 47821, 'tok');
  assert.equal(added.hooks.PreToolUse.length, 2);
  assert.equal(added.hooks.Stop.length, 1);
  assert.deepEqual(hs.findOurs(added), { installed: true, port: 47821, token: 'tok' });
  const twice = hs.addOurs(added, 47822, 'tok');
  assert.equal(twice.hooks.PreToolUse.length, 2, '다시 켜도 중복되지 않는다');
  assert.equal(hs.findOurs(twice).port, 47822);
  assert.deepEqual(hs.removeOurs(twice), orig);
  assert.deepEqual(hs.removeOurs({ model: 'x' }), { model: 'x' });
});

test('사용자 설정 파일: 백업 후 쓰기, 깨진 JSON 은 건드리지 않음', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark' }));
  const backup = hs.installGlobal(47821, 'tok', file);
  assert.ok(fs.existsSync(backup));
  const st = hs.readGlobalStatus(47821, 'tok', file);
  assert.equal(st.installed, true);
  assert.equal(st.tokenMatches, true);
  assert.equal(st.token, undefined, '토큰 값은 화면으로 내보내지 않는다');
  assert.equal(hs.readGlobalStatus(47900, 'tok', file).portMatches, false);
  assert.equal(hs.readGlobalStatus(47821, 'other', file).tokenMatches, false);
  hs.uninstallGlobal(file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { theme: 'dark' });

  fs.writeFileSync(file, '{ broken');
  assert.throws(() => hs.installGlobal(47821, 'tok', file));
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');
  assert.ok(hs.readGlobalStatus(47821, 'tok', file).error);
});

test('cmd.exe 경유 명령줄: 전체 재인용 · 특수문자 무력화', () => {
  const c = commandFor({ cmdShim: 'C:\\Users\\John Smith\\npm\\claude.cmd' }, ['--settings', 'C:\\a b\\s.json', '-n', 'R&D %PATH% "x"']);
  assert.equal(c.file, 'cmd.exe');
  assert.equal(c.args, '/d /s /c ""C:\\Users\\John Smith\\npm\\claude.cmd" "--settings" "C:\\a b\\s.json" "-n" "R&D PATH x""');
  assert.deepEqual(commandFor({ file: 'C:\\c.exe', prefixArgs: [] }, ['--version']), { file: 'C:\\c.exe', args: ['--version'] });
});

test('앱 탭 claude 는 기본 모드로 시작하되 Bypass Permissions 를 선택지로 연다', () => {
  const fresh = tabArgs({ settingsPath: 'C:\\s.json', mode: 'new', sessionId: 'sid', label: 'proj' });
  assert.deepEqual(fresh, ['--settings', 'C:\\s.json', '--allow-dangerously-skip-permissions', '--session-id', 'sid', '-n', 'proj']);
  assert.ok(!fresh.includes('--dangerously-skip-permissions'), '처음부터 Bypass 로 켜지 않는다');
  const resumed = tabArgs({ settingsPath: 'C:\\s.json', mode: 'resume', resumeId: 'rid', label: 'x'.repeat(80) });
  assert.deepEqual(resumed.slice(0, 6), ['--settings', 'C:\\s.json', '--allow-dangerously-skip-permissions', '--resume', 'rid', '--fork-session']);
  assert.equal(resumed[7].length, 60);
});

test('tool_input 은 필요한 필드만 짧게 넘긴다', () => {
  const e = toEvent({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'a.txt', content: 'x'.repeat(5000) } }, {});
  assert.deepEqual(e.tool_input, { file_path: 'a.txt' });
});

test('중복 제거기', () => {
  const dup = createDeduper(1000);
  assert.equal(dup('a', 0), false);
  assert.equal(dup('a', 500), true);
  assert.equal(dup('a', 2000), false);
});

test('이벤트 정리: 긴 본문은 자르고 경로는 빼며, 치환 안 된 헤더는 무시', () => {
  const e = toEvent({ hook_event_name: 'Stop', last_assistant_message: 'x'.repeat(1000), transcript_path: 'p' }, { 'x-office-tab': '$AGENT_OFFICE_TAB' }, 'global', 1);
  assert.equal(e.last_assistant_message.length, 401);
  assert.equal(e.transcript_path, undefined);
  assert.equal(e._tab, null);
  assert.equal(toEvent({ hook_event_name: 'Stop' }, { 'x-office-tab': 't1' }).
    _tab, 't1');
});

test('hook 서버: 토큰 검사 · 중복 제거 · 즉시 응답', async () => {
  const got = [];
  const { server, port } = await startHookServer({ port: 0, token: 'tok', onEvent: (e) => got.push(e) });
  try {
    const body = JSON.stringify({ session_id: 's', hook_event_name: 'Stop' });
    const post = (k) => fetch(`http://127.0.0.1:${port}/hook?k=${k}&src=session`, { method: 'POST', body, headers: { 'X-Office-Tab': 't9' } });
    assert.equal((await post('bad')).status, 404);
    const r = await post('tok');
    assert.equal(r.status, 200);
    assert.equal(await r.text(), '{}');
    await post('tok');
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(got.length, 1);
    assert.equal(got[0]._tab, 't9');
    assert.equal(got[0]._src, 'session');
  } finally {
    server.close();
  }
});

test('hook 서버: onEvent 두 번째 인자로 transcriptPath 를 알리되 렌더러로 가는 이벤트에는 넣지 않는다', async () => {
  const got = [];
  const { server, port } = await startHookServer({ port: 0, token: 'tok', onEvent: (e, meta) => got.push({ e, meta }) });
  try {
    const post = (body, q = '') => fetch(`http://127.0.0.1:${port}/hook?k=tok&src=session${q}`, { method: 'POST', body: JSON.stringify(body) });
    await post({ session_id: 's', hook_event_name: 'Stop', transcript_path: 'C:\\t\\r.jsonl' });
    await post({ session_id: 's', hook_event_name: 'PreToolUse', transcript_path: 7 });
    await post({ session_id: 's', hook_event_name: 'SessionStart' });
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(got.map((x) => x.meta), [{ transcriptPath: 'C:\\t\\r.jsonl' }, { transcriptPath: null }, { transcriptPath: null }]);
    assert.ok(got.every((x) => x.e.transcript_path === undefined));
  } finally {
    server.close();
  }
});

test('hook 서버: 붙잡은 권한 요청의 onEvent 에도 transcriptPath 를 알린다', async () => {
  const got = [];
  const { server, port, releaseAll } = await startHookServer({ port: 0, token: 'tok', onEvent: (e, meta) => got.push(meta), canHold: () => true });
  try {
    const p = fetch(`http://127.0.0.1:${port}/hook?k=tok&src=session`, { method: 'POST', headers: { 'X-Office-Tab': 't1' }, body: JSON.stringify({ session_id: 's', hook_event_name: 'PermissionRequest', tool_name: 'Bash', transcript_path: 'C:\\t\\h.jsonl' }) });
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(got, [{ transcriptPath: 'C:\\t\\h.jsonl' }]);
    releaseAll();
    await p;
  } finally {
    server.close();
  }
});

test('hook 서버 /status: 즉시 {} 로 답하고 onStatus(본문, 탭) 을 부른다 · 토큰 검사 · 이벤트로 취급하지 않는다', async () => {
  const events = [];
  const statuses = [];
  const { server, port } = await startHookServer({ port: 0, token: 'tok', onEvent: (e) => events.push(e), onStatus: (p, tab) => statuses.push({ p, tab }) });
  try {
    const post = (q, body) => fetch(`http://127.0.0.1:${port}/status?${q}`, { method: 'POST', body });
    const input = JSON.stringify({ session_id: 's', hook_event_name: 'Stop', rate_limits: { five_hour: { used_percentage: 2 } } });
    assert.equal((await post('k=bad', input)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/status?k=tok`)).status, 404, 'POST 만');
    const r = await post('k=tok&tab=t3', input);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), '{}');
    await post('k=tok&tab=', input); // 같은 본문을 반복해도 중복 제거와 무관
    await post('k=tok&tab=%24AGENT_OFFICE_TAB', input); // 치환 안 된 값은 탭 없음
    assert.equal((await post('k=tok', '깨진 본문')).status, 200, '파싱 실패도 응답은 {}');
    assert.equal((await post('k=tok', '"문자열"')).status, 200);
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(statuses.map((s) => s.tab), ['t3', null, null]);
    assert.equal(statuses[0].p.rate_limits.five_hour.used_percentage, 2);
    assert.equal(events.length, 0);
    const { server: s2, port: p2 } = await startHookServer({ port: 0, token: 'tok', onEvent: () => {} }); // onStatus 를 안 줘도 오류 없음
    try { assert.equal((await fetch(`http://127.0.0.1:${p2}/status?k=tok`, { method: 'POST', body: input })).status, 200); } finally { s2.close(); }
  } finally {
    server.close();
  }
});

test('세션 설정: extra(상태 표시줄 중계)가 있으면 hooks 와 함께, 없으면 지금처럼 hooks 만', () => {
  const plain = hs.sessionSettings(47821, 'tok');
  assert.deepEqual(Object.keys(plain), ['hooks']);
  const statusLine = { type: 'command', command: 'node "C:/ud/statusline-relay.cjs"', padding: 1 };
  const withRelay = hs.sessionSettings(47821, 'tok', { statusLine });
  assert.deepEqual(Object.keys(withRelay), ['hooks', 'statusLine']);
  assert.deepEqual(withRelay.statusLine, statusLine);
  assert.deepEqual(withRelay.hooks, plain.hooks);
});

test('npm claude.cmd 에서 실제 exe 경로를 찾는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-'));
  const exe = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
  const cmd = path.join(dir, 'claude.cmd');
  fs.writeFileSync(cmd, '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n');
  assert.equal(exeFromCmdShim(cmd), exe);
});

test('IDE 세션 전용 환경변수는 넘기지 않는다', () => {
  process.env.CLAUDECODE = '1';
  process.env.VSCODE_PID = '1';
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
  const env = cleanEnv({ AGENT_OFFICE_TAB: 't1' });
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.VSCODE_PID, undefined);
  assert.equal(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '1');
  assert.equal(env.AGENT_OFFICE_TAB, 't1');
});

// ───────────────────────── 권한 요청 보류 (펫 카드 허용·거부) ─────────────────────────

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function holdFixture(opts = {}) {
  const got = [];
  const closed = [];
  const held = [];
  const srv = await startHookServer({
    port: 0, token: 'tok', onEvent: (e) => got.push(e), canHold: () => true, holdMs: 300,
    onHeld: (id) => held.push(id), onClosed: (id, how) => closed.push([id, how]), ...opts,
  });
  const post = (name, { src = 'session', tab = 't1', signal, extra = {} } = {}) => fetch(`http://127.0.0.1:${srv.port}/hook?k=tok&src=${src}`, {
    method: 'POST', signal, headers: tab ? { 'X-Office-Tab': tab } : {},
    body: JSON.stringify({ session_id: 's', hook_event_name: name, tool_name: 'Bash', tool_input: { command: 'npm test' }, ...extra }),
  });
  return { srv, got, closed, held, post };
}

test('권한 보류: 세션 PermissionRequest 는 응답을 붙잡고, 허용하면 allow 만 담아 응답한다', async () => {
  const { srv, got, closed, held, post } = await holdFixture({ holdMs: 5000 });
  try {
    let done = false;
    const p = post('PermissionRequest').then((r) => { done = true; return r; });
    await sleep(100);
    assert.equal(done, false, '결정 전에는 응답이 오지 않는다');
    assert.equal(got.length, 1);
    assert.match(got[0]._permId, UUID);
    assert.deepEqual(held, [got[0]._permId]);
    assert.equal(got[0]._dupHold, undefined);
    assert.deepEqual(srv.pending().map((x) => x.id), [got[0]._permId]);
    assert.ok(Number.isFinite(srv.pending()[0].at));
    assert.equal(srv.pending()[0].tool, 'Bash', '보류 시점의 도구');
    assert.deepEqual(srv.pending()[0].input, { command: 'npm test' }, '보류 시점의 입력 원본');
    assert.equal(srv.resolve(got[0]._permId, 'allow'), true);
    const r = await p;
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    assert.deepEqual(closed, [[got[0]._permId, 'decided']]);
    assert.equal(srv.pending().length, 0);
    assert.equal(srv.resolve(got[0]._permId, 'allow'), false, '이미 푼 요청에는 다시 답할 수 없다');
  } finally {
    srv.releaseAll();
    srv.server.close();
  }
});

test('권한 보류: 거부하면 message 만 담고 interrupt·updatedInput 은 없다', async () => {
  const { srv, got, closed, post } = await holdFixture({ holdMs: 5000 });
  try {
    const p = post('PermissionRequest');
    await sleep(100);
    srv.resolve(got[0]._permId, 'deny');
    const body = await (await p).json();
    const d = body.hookSpecificOutput.decision;
    assert.equal(body.hookSpecificOutput.hookEventName, 'PermissionRequest');
    assert.deepEqual(Object.keys(d).sort(), ['behavior', 'message']);
    assert.equal(d.behavior, 'deny');
    assert.ok(d.message.includes('Agent Office'));
    assert.deepEqual(closed, [[got[0]._permId, 'decided']]);
  } finally {
    srv.releaseAll();
    srv.server.close();
  }
});

test('권한 보류: 알 수 없는 결정 값은 허용으로 취급하지 않고 {} 로 푼다', async () => {
  const { srv, got, post } = await holdFixture({ holdMs: 5000 });
  try {
    const p = post('PermissionRequest');
    await sleep(100);
    srv.resolve(got[0]._permId, 'always');
    assert.equal(await (await p).text(), '{}');
  } finally {
    srv.releaseAll();
    srv.server.close();
  }
});

test('권한 보류: 시간이 지나면 {} 로 풀고 timeout 을 알린다', async () => {
  const { srv, got, closed, post } = await holdFixture({ holdMs: 200 });
  try {
    const r = await post('PermissionRequest');
    assert.equal(await r.text(), '{}');
    assert.deepEqual(closed, [[got[0]._permId, 'timeout']]);
    assert.equal(srv.pending().length, 0);
  } finally {
    srv.server.close();
  }
});

test('권한 보류: 전역 hook·탭 없음·canHold 거짓·다른 이벤트는 기존처럼 즉시 {}', async () => {
  const fx = await holdFixture({ holdMs: 5000 });
  try {
    const g = await fx.post('PermissionRequest', { src: 'global' });
    assert.equal(await g.text(), '{}');
    const noTab = await fx.post('PermissionRequest', { tab: null, extra: { n: 1 } });
    assert.equal(await noTab.text(), '{}');
    const stop = await fx.post('Stop', { extra: { n: 2 } });
    assert.equal(await stop.text(), '{}');
    assert.equal(fx.srv.pending().length, 0);
    assert.equal(fx.got.length, 3);
    assert.ok(fx.got.every((e) => e._permId === undefined && e._dupHold === undefined));
    assert.deepEqual(fx.closed, []);
  } finally {
    fx.srv.server.close();
  }
  for (const canHold of [() => false, () => { throw new Error('boom'); }]) {
    const f = await holdFixture({ canHold });
    try {
      assert.equal(await (await f.post('PermissionRequest')).text(), '{}');
      assert.equal(f.got.length, 1);
      assert.equal(f.got[0]._permId, undefined);
      assert.equal(f.srv.pending().length, 0);
    } finally {
      f.srv.server.close();
    }
  }
  const def = await startHookServer({ port: 0, token: 'tok', onEvent: () => {} }); // canHold 를 안 주면 붙잡지 않는다
  try {
    const r = await fetch(`http://127.0.0.1:${def.port}/hook?k=tok&src=session`, { method: 'POST', headers: { 'X-Office-Tab': 't1' }, body: JSON.stringify({ hook_event_name: 'PermissionRequest' }) });
    assert.equal(await r.text(), '{}');
  } finally {
    def.server.close();
  }
});

test('권한 보류: 깨진 본문은 붙잡지 않고 버린다', async () => {
  const fx = await holdFixture();
  try {
    const r = await fetch(`http://127.0.0.1:${fx.srv.port}/hook?k=tok&src=session`, { method: 'POST', headers: { 'X-Office-Tab': 't1' }, body: '{ nope' });
    assert.equal(await r.text(), '{}');
    const r2 = await fetch(`http://127.0.0.1:${fx.srv.port}/hook?k=tok&src=session`, { method: 'POST', headers: { 'X-Office-Tab': 't1' }, body: JSON.stringify({ tool_name: 'Bash' }) });
    assert.equal(await r2.text(), '{}');
    assert.equal(fx.got.length, 0);
    assert.equal(fx.srv.pending().length, 0);
  } finally {
    fx.srv.server.close();
  }
});

test('권한 보류: 전역 사본이 먼저 오고 세션 사본이 나중이면 둘 다 이벤트, 세션 쪽에 _dupHold', async () => {
  const fx = await holdFixture({ holdMs: 5000 });
  try {
    assert.equal(await (await fx.post('PermissionRequest', { src: 'global' })).text(), '{}');
    const p = fx.post('PermissionRequest');
    await sleep(100);
    assert.equal(fx.got.length, 2);
    assert.equal(fx.got[0]._src, 'global');
    assert.equal(fx.got[0]._permId, undefined);
    assert.equal(fx.got[1]._src, 'session');
    assert.equal(fx.got[1]._dupHold, true);
    assert.match(fx.got[1]._permId, UUID);
    assert.equal(fx.srv.pending().length, 1);
    fx.srv.releaseAll();
    await p;
  } finally {
    fx.srv.releaseAll();
    fx.srv.server.close();
  }
});

test('권한 보류: 세션 사본이 먼저 오면 뒤따르는 전역 사본은 버린다', async () => {
  const fx = await holdFixture({ holdMs: 5000 });
  try {
    const p = fx.post('PermissionRequest');
    await sleep(100);
    assert.equal(await (await fx.post('PermissionRequest', { src: 'global' })).text(), '{}');
    assert.equal(fx.got.length, 1);
    assert.equal(fx.got[0]._dupHold, undefined);
    fx.srv.releaseAll();
    await p;
  } finally {
    fx.srv.releaseAll();
    fx.srv.server.close();
  }
});

test('권한 보류: releaseAll 은 모두 {} 로 풀고 released 를 알린다', async () => {
  const fx = await holdFixture({ holdMs: 5000 });
  try {
    const a = fx.post('PermissionRequest', { extra: { n: 1 } });
    const b = fx.post('PermissionRequest', { extra: { n: 2 } });
    await sleep(100);
    assert.equal(fx.srv.pending().length, 2);
    fx.srv.releaseAll();
    assert.equal(await (await a).text(), '{}');
    assert.equal(await (await b).text(), '{}');
    assert.deepEqual(fx.closed.map((c) => c[1]), ['released', 'released']);
    assert.equal(fx.srv.pending().length, 0);
    fx.srv.releaseAll(); // 비어 있어도 안전
  } finally {
    fx.srv.server.close();
  }
});

test('권한 보류: resolve(id, null) 은 {} 로 풀고 released, 연결이 끊기면 close 로 정리', async () => {
  const fx = await holdFixture({ holdMs: 5000 });
  try {
    const p = fx.post('PermissionRequest', { extra: { n: 1 } });
    await sleep(100);
    assert.equal(fx.srv.resolve(fx.got[0]._permId, null), true);
    assert.equal(await (await p).text(), '{}');
    assert.deepEqual(fx.closed, [[fx.got[0]._permId, 'released']]);

    const ac = new AbortController();
    const q = fx.post('PermissionRequest', { extra: { n: 2 }, signal: ac.signal }).catch(() => null);
    await sleep(100);
    assert.equal(fx.srv.pending().length, 1);
    ac.abort();
    await q;
    await sleep(100);
    assert.equal(fx.srv.pending().length, 0);
    assert.deepEqual(fx.closed.at(-1), [fx.got[1]._permId, 'close']);
  } finally {
    fx.srv.releaseAll();
    fx.srv.server.close();
  }
});

test('권한 보류: 화면에 알리다 오류가 나면 붙잡지 않고 바로 푼다', async () => {
  const fx = await holdFixture({ holdMs: 5000, onEvent: () => { throw new Error('화면 오류'); } });
  try {
    assert.equal(await (await fx.post('PermissionRequest')).text(), '{}');
    assert.equal(fx.srv.pending().length, 0);
    assert.equal(fx.closed.length, 1);
  } finally {
    fx.srv.server.close();
  }
});

test('세션 hook 설정: 권한 요청만 대기 600초, 나머지와 전역 hook 은 2초', () => {
  const session = hs.sessionSettings(47821, 'tok').hooks;
  assert.equal(session.PermissionRequest[0].hooks[0].timeout, 600);
  for (const ev of hs.EVENTS.filter((e) => e !== 'PermissionRequest')) assert.equal(session[ev][0].hooks[0].timeout, 2, ev);
  const global = hs.addOurs({}, 47821, 'tok').hooks;
  for (const ev of hs.EVENTS) assert.equal(global[ev][0].hooks[0].timeout, 2, `전역 ${ev}`);
  assert.ok(session.PermissionRequest[0].hooks[0].url.includes('src=session'));
});
