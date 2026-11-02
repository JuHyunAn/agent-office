import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { normalizeGrok, toEvent, startHookServer } = require('../src/main/hookServer.cjs');
const grokHooks = require('../src/main/grokHooks.cjs');
const { GROK_TOOL_NAMES, pickGrokInput, trackGrokSession, attachGrokRoom, dropGrokRoom } = require('../src/main/grokTools.cjs');
const agentCli = require('../src/main/agentCli.cjs');

// grok 1.0.70 실측 본문 모양 (camelCase + Claude 호환 snake_case, tool_input·tool_response 는 JSON 문자열)
const preTool = () => ({
  hookEventName: 'pre_tool_use', sessionId: 'sess-1', toolName: 'run_terminal_command', toolInput: '{"command":"ls"}',
  workspaceRoot: 'C:\\w', timestamp: '2026-11-02T01:00:00Z', toolUseId: 'call_1', durationMs: '829', isBackgrounded: 'false',
  hook_event_name: 'PreToolUse', session_id: 'sess-1', tool_name: 'run_terminal_command',
  tool_input: '{"command":"ls","description":"목록 보기"}', tool_use_id: 'call_1', cwd: 'C:\\w',
  tool_response: '{"output":"x"}', transcript_path: 'C:\\t.jsonl',
});

test('normalizeGrok: PreToolUse 는 Claude 모양으로 (도구 이름·입력 객체·camelCase 제거)', () => {
  const n = normalizeGrok(preTool());
  assert.equal(n.hook_event_name, 'PreToolUse');
  assert.equal(n.tool_name, 'Bash');
  assert.deepEqual(n.tool_input, { command: 'ls', description: '목록 보기' });
  assert.equal(n.session_id, 'sess-1');
  assert.equal(n._grok, true);
  for (const k of ['hookEventName', 'sessionId', 'toolName', 'toolInput', 'workspaceRoot', 'timestamp', 'toolUseId', 'durationMs', 'isBackgrounded', 'tool_response']) {
    assert.ok(!(k in n), k);
  }
});

test('normalizeGrok: read_file 은 Read + target_file 을 file_path 로, 표에 없는 도구·깨진 입력', () => {
  const read = normalizeGrok({ ...preTool(), tool_name: 'read_file', tool_input: '{"target_file":"C:\\\\a.txt","limit":5}' });
  assert.equal(read.tool_name, 'Read');
  assert.deepEqual(read.tool_input, { file_path: 'C:\\a.txt', limit: 5 });
  assert.equal(normalizeGrok({ ...preTool(), tool_name: 'kill_command_or_subagent' }).tool_name, 'kill_command_or_subagent');
  assert.deepEqual(normalizeGrok({ ...preTool(), tool_input: '{깨짐' }).tool_input, {});
});

test('normalizeGrok: 종료 직전 두 번째 Stop(shutdown)은 null, 첫 Stop 은 통과, Claude 본문은 그대로', () => {
  const stop = { hookEventName: 'stop', hook_event_name: 'Stop', session_id: 's', reason: 'end_turn', last_assistant_message: '끝' };
  assert.equal(normalizeGrok({ ...stop, reason: 'shutdown' }), null);
  assert.equal(normalizeGrok(stop).last_assistant_message, '끝');
  const claude = { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } };
  assert.equal(normalizeGrok(claude), claude);
  assert.equal(normalizeGrok(null), null);
});

test('toEvent: Grok 본문은 cli 쿼리가 없어도 _cli grok, 화면용으로 줄어든다', () => {
  const ev = toEvent(preTool(), {}, 'global', 1, {});
  assert.equal(ev._cli, 'grok');
  assert.equal(ev.tool_name, 'Bash');
  assert.deepEqual(ev.tool_input, { command: 'ls', description: '목록 보기' });
  assert.ok(!('_grok' in ev) && !('transcript_path' in ev) && !('tool_response' in ev));
  assert.equal(toEvent(preTool(), {}, 'global', 1, { cli: 'grok' })._cli, 'grok');
  assert.equal(toEvent({ hook_event_name: 'Stop', session_id: 's' }, {}, 'global', 1, {})._cli, 'claude');
  assert.equal(toEvent({ hookEventName: 'stop', hook_event_name: 'Stop', reason: 'shutdown' }, {}, 'global', 1, {}), null);
});

test('hookServer: 같은 Grok 이벤트가 두 경로로 와도 한 번만 전달하고, shutdown Stop 은 버린다', async () => {
  const got = [];
  const srv = await startHookServer({ port: 0, token: 'tok', onEvent: (ev) => got.push(ev) });
  const post = (body, qs = '') => fetch(`http://127.0.0.1:${srv.port}/hook?k=tok&src=global${qs}`, { method: 'POST', body: JSON.stringify(body) });
  try {
    const a = preTool();
    // 두 번째 경로(Claude 호환)는 본문이 조금 달라도(여분 키) 같은 이벤트 식별자면 중복이다
    const b = { zzz: 1, ...preTool() };
    assert.equal((await post(a, '&cli=grok&app=agent-office')).status, 200);
    assert.equal((await post(b)).status, 200);
    assert.equal(got.length, 1);
    assert.equal(got[0]._cli, 'grok');
    const stop = { hookEventName: 'stop', hook_event_name: 'Stop', session_id: 'sess-1', reason: 'shutdown', timestamp: 't9' };
    const r = await post(stop);
    assert.equal(await r.text(), '{}');
    assert.equal(got.length, 1);
    await post({ ...stop, reason: 'end_turn', timestamp: 't10' });
    assert.equal(got.length, 2);
  } finally {
    srv.server.close();
    srv.server.closeAllConnections?.();
  }
});

test('hookServer: Grok 중복 키는 agent_id 로 구분하고, timestamp 가 없으면 Grok 전용 키를 쓰지 않는다', async () => {
  const got = [];
  const srv = await startHookServer({ port: 0, token: 'tok', onEvent: (ev) => got.push(ev) });
  const post = (body) => fetch(`http://127.0.0.1:${srv.port}/hook?k=tok&src=global`, { method: 'POST', body: JSON.stringify(body) });
  try {
    // 같은 세션·이벤트·시각이라도 하위 에이전트(agent_id)가 다르면 다른 이벤트다
    const sub = (id, extra) => ({ hookEventName: 'subagent_start', hook_event_name: 'SubagentStart', session_id: 's2', timestamp: 't1', agent_id: id, ...extra });
    await post(sub('a1')); await post(sub('a2'));
    assert.equal(got.length, 2, 'agent_id 가 다르면 둘 다 전달');
    await post(sub('a1', { zzz: 1 })); // 본문이 달라도 같은 식별자면 중복
    assert.equal(got.length, 2);
    // timestamp 가 없으면 식별자 키를 만들지 않아 본문이 다른 이벤트는 모두 전달된다
    const noTs = (extra) => ({ hookEventName: 'stop', hook_event_name: 'Stop', session_id: 's3', reason: 'end_turn', ...extra });
    await post(noTs({ n: 1 })); await post(noTs({ n: 2 }));
    assert.equal(got.length, 4);
    await post(noTs({ n: 2 })); // 본문까지 같으면 기존 본문 중복 제거가 거른다
    assert.equal(got.length, 4);
  } finally {
    srv.server.close();
    srv.server.closeAllConnections?.();
  }
});

test('grok 세션 → 협업 방: session 이벤트로 연결하고, hook 이벤트의 _tab 을 채우고, 방을 닫으면 지운다', () => {
  const rooms = new Map();
  trackGrokSession(rooms, 'room-1', { type: 'text', text: 'x' });
  trackGrokSession(rooms, 'room-1', { type: 'session' });
  assert.equal(rooms.size, 0, 'session 이벤트가 아니거나 ID 가 없으면 무시');
  trackGrokSession(rooms, 'room-1', { type: 'session', sessionId: 'g1' });
  trackGrokSession(rooms, 'room-1', { type: 'session', sessionId: 'g2' }); // 첫 턴 실패 뒤 새 ID
  trackGrokSession(rooms, 'room-2', { type: 'session', sessionId: 'g3' });
  assert.equal(rooms.size, 3);
  assert.equal(attachGrokRoom(rooms, { _cli: 'grok', _tab: null, session_id: 'g2' })._tab, 'room-1');
  assert.equal(attachGrokRoom(rooms, { _cli: 'grok', _tab: 'tab-9', session_id: 'g2' })._tab, 'tab-9', '이미 탭이 있으면 그대로');
  assert.equal(attachGrokRoom(rooms, { _cli: 'grok', _tab: null, session_id: 'zz' })._tab, null, '모르는 세션');
  assert.equal(attachGrokRoom(rooms, { _cli: 'claude', _tab: null, session_id: 'g1' })._tab, null, 'Grok 이 아니면 건드리지 않음');
  assert.equal(attachGrokRoom(rooms, undefined), undefined);
  dropGrokRoom(rooms, 'room-1');
  assert.deepEqual([...rooms], [['g3', 'room-2']]);
  assert.equal(attachGrokRoom(rooms, { _cli: 'grok', _tab: null, session_id: 'g1' })._tab, null);
});

test('GROK_TOOL_NAMES·pickGrokInput', () => {
  assert.equal(GROK_TOOL_NAMES.run_terminal_command, 'Bash');
  assert.equal(GROK_TOOL_NAMES.read_file, 'Read');
  assert.equal(GROK_TOOL_NAMES.spawn_subagent, 'Task');
  assert.deepEqual(pickGrokInput({ target_file: 'a', limit: 1 }), { file_path: 'a', limit: 1 });
  assert.deepEqual(pickGrokInput('{"command":"ls"}'), { command: 'ls' });
  assert.deepEqual(pickGrokInput('{깨짐'), {});
  assert.deepEqual(pickGrokInput(null), {});
  assert.deepEqual(pickGrokInput('[1]'), {});
});

// ───────── grokHooks: 실제 ~/.grok 은 건드리지 않고 임시 폴더만 쓴다 ─────────

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-grokhooks-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('grokHooks.build: 이벤트 9개와 주소', () => {
  const b = grokHooks.build(47821, 'tok');
  assert.deepEqual(Object.keys(b.hooks), grokHooks.EVENTS);
  assert.equal(grokHooks.EVENTS.length, 9);
  assert.ok(!grokHooks.EVENTS.includes('PermissionRequest'));
  const h = b.hooks.PreToolUse[0];
  assert.equal(h.matcher, '*');
  assert.deepEqual(h.hooks[0], { type: 'http', url: 'http://127.0.0.1:47821/hook?k=tok&src=global&cli=grok&app=agent-office', timeout: 2 });
});

test('grokHooks.home·filePath: GROK_HOME 이 있으면 그 폴더', () => {
  assert.equal(grokHooks.home({ env: {}, homedir: path.join('x', 'h') }), path.resolve('x', 'h', '.grok'));
  assert.equal(grokHooks.home({ env: { GROK_HOME: 'G' }, homedir: 'h' }), path.resolve('G'), '상대 경로도 절대 경로로');
  assert.equal(grokHooks.filePath({ env: { GROK_HOME: 'G' } }), path.resolve('G', 'hooks', 'agent-office.json'));
});

test('grokHooks.status: 없음 · 우리 것(현재/옛 포트) · 깨진 JSON · 남의 파일', () => withTmp((dir) => {
  const opts = { env: { GROK_HOME: dir } };
  assert.deepEqual(grokHooks.status(1, 'a', opts), { installed: false, ours: false, current: false });
  grokHooks.enable(1, 'a', opts);
  assert.deepEqual(grokHooks.status(1, 'a', opts), { installed: true, ours: true, current: true });
  assert.deepEqual(grokHooks.status(2, 'a', opts), { installed: true, ours: true, current: false });
  assert.deepEqual(grokHooks.status(1, 'b', opts), { installed: true, ours: true, current: false });
  const file = grokHooks.filePath(opts);
  fs.writeFileSync(file, '{ 깨짐');
  assert.deepEqual(grokHooks.status(1, 'a', opts), { installed: true, ours: false, current: false });
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'http', url: 'http://other/' }] }] } }));
  assert.deepEqual(grokHooks.status(1, 'a', opts), { installed: true, ours: false, current: false });
}));

test('grokHooks.enable: 폴더를 만들고 LF 로 쓴다 · 다시 켜면 새 포트로 덮는다 · 남의 파일은 덮지 않는다', () => withTmp((dir) => {
  const opts = { env: { GROK_HOME: dir } };
  const file = grokHooks.enable(1, 'a', opts);
  assert.equal(file, path.join(dir, 'hooks', 'agent-office.json'));
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('\r') && text.endsWith('}\n') && text.includes('\n  "hooks"'));
  assert.deepEqual(JSON.parse(text), grokHooks.build(1, 'a'));
  grokHooks.enable(2, 'b', opts);
  assert.deepEqual(grokHooks.status(2, 'b', opts), { installed: true, ours: true, current: true });
  fs.writeFileSync(file, '{"hooks":{}}');
  assert.throws(() => grokHooks.enable(2, 'b', opts), /같은 이름의 다른 파일/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"hooks":{}}');
}));

test('grokHooks.disable: 우리 파일만 지운다 · 없으면 성공 · 폴더는 그대로', () => withTmp((dir) => {
  const opts = { env: { GROK_HOME: dir } };
  assert.equal(grokHooks.disable(opts), false); // 없음
  const file = grokHooks.enable(1, 'a', opts);
  assert.equal(grokHooks.disable(opts), true);
  assert.ok(!fs.existsSync(file) && fs.existsSync(path.dirname(file)));
  fs.writeFileSync(file, '{"hooks":{}}');
  assert.equal(grokHooks.disable(opts), false);
  assert.ok(fs.existsSync(file));
}));

test('grokHooks: 주입한 fs 만 쓴다 (실제 파일시스템을 건드리지 않는다)', () => {
  const files = new Map();
  const fake = {
    existsSync: (f) => files.has(f),
    readFileSync: (f) => files.get(f),
    writeFileSync: (f, t) => files.set(f, t),
    mkdirSync: () => {},
    rmSync: (f) => files.delete(f),
  };
  const opts = { fs: fake, env: { GROK_HOME: path.join('virtual', 'grok') } };
  grokHooks.enable(5, 'k', opts);
  assert.equal(grokHooks.status(5, 'k', opts).current, true);
  assert.equal(files.size, 1);
  assert.ok(!fs.existsSync(path.join('virtual', 'grok')));
  grokHooks.disable(opts);
  assert.equal(files.size, 0);
});

test('agentCli.tabArgs: Grok 만 UUID 세션 ID 를 -s 로 받는다', () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  assert.deepEqual(agentCli.tabArgs('grok', { sessionId: id }), ['-s', id]);
  assert.deepEqual(agentCli.tabArgs('grok'), []);
  assert.deepEqual(agentCli.tabArgs('grok', { sessionId: 'x; rm -rf' }), []);
  assert.deepEqual(agentCli.tabArgs('grok', { sessionId: null }), []);
  assert.deepEqual(agentCli.tabArgs('muse', { sessionId: id }), []);
  assert.deepEqual(agentCli.tabArgs('antigravity', { sessionId: id }), []);
});

test('Grok 사무실 hook 은 자동: 확인 창·켜기/끄기 IPC 가 메인·preload 에 없고, 탭·협업 생성 때 ensure 가 불린다', () => {
  const main = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'main.cjs'), 'utf8');
  const preload = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'preload.cjs'), 'utf8');
  assert.ok(!/setGrokHooks|hooks:grok:set/.test(main + preload));
  assert.ok(/function ensureGrokHooks\(/.test(main));
  assert.ok(/if \(cli === 'grok'\) ensureGrokHooks\(\)/.test(main), 'Grok 탭 생성');
  assert.ok(/ensureGrokHooks\(\);\s*\n\s*return new GrokChat/.test(main), 'Grok 협업 실행기 생성 직전');
});
