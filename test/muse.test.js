import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const museCli = require('../src/main/museCli.cjs');
const collab = require('../src/main/collabAgents.cjs');
const agentCli = require('../src/main/agentCli.cjs');
const { toEvent } = require('../src/main/hookServer.cjs');
const { collabRules } = require('../src/main/collabRules.cjs');

const UUID = '123e4567-e89b-42d3-a456-426614174000';

// 실측 줄 (muse 1.4.14 exec --json --provider echo, 2026-11-02) — 필요한 필드만 남겼다.
const LINES = {
  accepted: { schema_version: 1, stream: { kind: 'session', id: UUID }, payload_type: 'runtime.command.accepted', payload: { kind: 'command_accepted', command_kind: 'turn.submit' } },
  delta: { schema_version: 1, stream: { kind: 'session', id: UUID }, record_type: 'status', durability: 'ephemeral', payload_type: 'run.output.delta', payload: { kind: 'run_output_delta', text: 'echo: first turn apple' } },
  usage: { schema_version: 1, stream: { kind: 'exec.usage', id: UUID }, payload_type: 'run.usage', payload: { kind: 'run_usage', calls: 1, completed_calls: 1, failed_calls: 0 } },
  end: { schema_version: 1, stream: { kind: 'session', id: UUID }, record_type: 'event', durability: 'durable', payload_type: 'run.terminal.completed', payload: { kind: 'run_terminal', terminal: 'completed', text: 'echo: first turn apple', reason: null } },
  failed: { schema_version: 1, stream: { kind: 'session', id: UUID }, payload_type: 'run.terminal.completed', payload: { kind: 'run_terminal', terminal: 'failed', text: '', reason: '모델 호출 실패' } },
};
// 실측 hook 본문 (Claude 와 같은 snake_case)
const HOOK_STOP = { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'echo: hello all', session_id: '01a19b5f-026f-7a52-90c1-0dba08dbcbf5', turn_id: '01a19b5f-05ed-7cf3-96a2-b152ca102a76', cwd: 'C:\\w', transcript_path: null, model: 'unknown', permission_mode: 'default' };

test('museExe: muse-bin-*.exe 중 수정 시각이 가장 늦은 것, 다른 파일·없는 폴더는 null', () => {
  const times = { 'muse-bin-1.4.13-R1.exe': 100, 'muse-bin-1.4.14-R7309.1.exe': 300, 'muse-bin-1.4.12-R1.exe': 200, 'muse.cmd': 999, '.muse-launcher.ps1': 999, 'muse-bin-note.txt': 999 };
  const fake = { readdirSync: () => Object.keys(times), statSync: (f) => ({ mtimeMs: times[path.basename(f)] }) };
  assert.equal(museCli.museExe('D:\\muse', { fs: fake }), path.join('D:\\muse', 'muse-bin-1.4.14-R7309.1.exe'));
  assert.equal(museCli.museExe('D:\\muse', { fs: { readdirSync: () => ['muse.cmd'], statSync: () => ({ mtimeMs: 1 }) } }), null);
  assert.equal(museCli.museExe('D:\\없는', { fs: { readdirSync: () => { throw new Error('ENOENT'); } } }), null);
  // 한 파일의 stat 이 실패해도(런처가 막 지움) 나머지로 고른다
  const racy = { readdirSync: () => ['muse-bin-1.exe', 'muse-bin-2.exe'], statSync: (f) => { if (f.endsWith('muse-bin-2.exe')) throw new Error('gone'); return { mtimeMs: 5 }; } };
  assert.equal(path.basename(museCli.museExe('D:\\muse', { fs: racy })), 'muse-bin-1.exe');
});

test('hookCommand: 실측 명령 그대로 — 따옴표·& 없음, 포트는 정수, token·tab 은 안전한 글자만', () => {
  const cmd = museCli.hookCommand({ port: 47821, token: 'abc123', tab: 'collab-1' }, { systemRoot: 'C:\\Windows' });
  assert.equal(cmd, 'C:\\Windows\\System32\\curl.exe -sS --noproxy 127.0.0.1 -m 3 -H Content-Type:application/json --data-binary @- --url-query k=abc123 --url-query src=session --url-query cli=muse --url-query tab=collab-1 http://127.0.0.1:47821/hook');
  assert.ok(!/["'&|<>^%]/.test(cmd), '따옴표·& 등 셸 특수문자 없음');
  for (const bad of ['a b', 'a"b', 'a&b', '', 'x'.repeat(81), 'a;b']) {
    assert.throws(() => museCli.hookCommand({ port: 1, token: bad, tab: 't' }), /잘못된 hook 값/, `token ${bad}`);
    assert.throws(() => museCli.hookCommand({ port: 1, token: 't', tab: bad }), /잘못된 hook 값/, `tab ${bad}`);
  }
  for (const port of ['x', 0, 70000, 1.5, null]) assert.throws(() => museCli.hookCommand({ port, token: 't', tab: 't' }), /포트/, String(port));
});

test('hookArgs: 이벤트별 -c hooks.<이벤트>=<JSON 배열> — 비동기·timeout 5, PermissionRequest·StopFailure·SubagentStart 는 걸지 않는다', () => {
  assert.deepEqual(museCli.HOOK_EVENTS, ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionEnd']);
  const args = museCli.hookArgs({ port: 47821, token: 'tok', tab: 'room-1' }, { systemRoot: 'C:\\Windows' });
  assert.equal(args.length, museCli.HOOK_EVENTS.length * 2);
  const command = museCli.hookCommand({ port: 47821, token: 'tok', tab: 'room-1' }, { systemRoot: 'C:\\Windows' });
  museCli.HOOK_EVENTS.forEach((ev, i) => {
    assert.equal(args[i * 2], '-c');
    const v = args[i * 2 + 1];
    assert.ok(v.startsWith(`hooks.${ev}=`), ev);
    assert.deepEqual(JSON.parse(v.slice(`hooks.${ev}=`.length)), [{ hooks: [{ type: 'command', command, timeout: 5, async: true }] }]);
  });
  const all = args.join(' ');
  for (const no of ['PermissionRequest', 'StopFailure', 'SubagentStart', 'SubagentStop']) assert.ok(!all.includes(no), no);
  assert.throws(() => museCli.hookArgs({ port: 1, token: 'a b', tab: 't' }), /잘못된 hook 값/);
});

test('hookCommand: curl 은 SystemRoot\\System32 절대 경로 — 공백·cmd 특수문자 든 SystemRoot 면 null, hookArgs 는 [] (hook 없이 실행)', () => {
  const hook = { port: 47821, token: 'tok', tab: 'room-1' };
  assert.equal(museCli.curlPath('D:\\Win_10'), 'D:\\Win_10\\System32\\curl.exe');
  assert.ok(museCli.hookCommand(hook, { systemRoot: 'D:\\Win_10' }).startsWith('D:\\Win_10\\System32\\curl.exe -sS '));
  assert.ok(!museCli.hookCommand(hook, { systemRoot: 'C:\\Windows' }).startsWith('curl.exe'), '이름만 쓰지 않는다 (cmd 는 현재 폴더를 PATH 보다 먼저 찾는다)');
  for (const bad of ['C:\\Program Files\\Win', 'C:\\a&b', 'C:\\a"b', 'C:\\a^b', 'C:\\a%b%', '\\\\server\\share', 'Windows', '', 'C:\\한글']) {
    assert.equal(museCli.curlPath(bad), null, bad);
    assert.equal(museCli.hookCommand(hook, { systemRoot: bad }), null, bad);
    assert.deepEqual(museCli.hookArgs(hook, { systemRoot: bad }), [], bad);
  }
  // 포트·값 검사는 경로와 상관없이 먼저 던진다
  assert.throws(() => museCli.hookArgs({ port: 1, token: 'a b', tab: 't' }, { systemRoot: 'C:\\a b' }), /잘못된 hook 값/);
  assert.deepEqual(agentCli.tabArgs('muse', { hook }), museCli.hookArgs(hook), '탭 인자도 같은 hook 인자');
});

test('execArgs: 순서 고정 · 자동/안전하지 않은 모델·단계는 생략 · 세션 ID 는 UUID 만 · hooks 는 맨 끝', () => {
  const base = { promptFile: 'C:\\t\\p.txt', sessionId: UUID };
  assert.deepEqual(museCli.execArgs(base), ['exec', '--json', '--prompt-file', 'C:\\t\\p.txt', '--session-id', UUID, '--approval-mode', 'never']);
  assert.deepEqual(museCli.execArgs({ ...base, model: 'muse-spark-1.3', effort: 'xhigh', hooks: ['-c', 'hooks.Stop=[]'] }),
    ['exec', '--json', '--prompt-file', 'C:\\t\\p.txt', '--session-id', UUID, '--approval-mode', 'never', '--model', 'muse-spark-1.3', '--reasoning-effort', 'xhigh', '-c', 'hooks.Stop=[]']);
  const skipped = museCli.execArgs({ ...base, model: 'auto', effort: 'auto' });
  assert.ok(!skipped.includes('--model') && !skipped.includes('--reasoning-effort'));
  const unsafe = museCli.execArgs({ ...base, model: 'a b;c', effort: 'none' });
  assert.ok(!unsafe.includes('--model') && !unsafe.includes('--reasoning-effort'), '안전하지 않은 값은 넣지 않는다 (none 은 Meta 가 허용하지 않는다)');
  for (const e of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) assert.ok(museCli.execArgs({ ...base, effort: e }).includes(e), e);
  for (const bad of ['sid', '', null, `${UUID}x`, '../x']) assert.throws(() => museCli.execArgs({ ...base, sessionId: bad }), /잘못된 세션 ID/, String(bad));
});

test('parseMuseLine: 실측 줄 — 응답 조각은 text, 종료는 end(ok·최종 텍스트·reason), 그 밖은 null, 도구는 방어적으로', () => {
  assert.deepEqual(museCli.parseMuseLine(LINES.delta), { type: 'text', text: 'echo: first turn apple' });
  assert.deepEqual(museCli.parseMuseLine(LINES.end), { type: 'end', ok: true, text: 'echo: first turn apple', reason: '' });
  assert.deepEqual(museCli.parseMuseLine(LINES.failed), { type: 'end', ok: false, text: '', reason: '모델 호출 실패' });
  for (const k of ['accepted', 'usage']) assert.equal(museCli.parseMuseLine(LINES[k]), null, k);
  for (const bad of [null, undefined, 'x', 3, {}, { payload_type: 'run.output.delta' }, { payload_type: 'run.output.delta', payload: {} }, { payload_type: 7, payload: {} }]) assert.equal(museCli.parseMuseLine(bad), null);
  // 도구 기록 모양은 미확인 — payload_type 에 tool 이 들고 이름이 문자열일 때만
  assert.deepEqual(museCli.parseMuseLine({ payload_type: 'tool.call.started', payload: { tool_name: 'Bash', tool_input: { command: 'ls', secret: 'x' } } }), { type: 'tool', name: 'Bash', input: { command: 'ls' } });
  assert.deepEqual(museCli.parseMuseLine({ payload_type: 'run.tool.requested', payload: { name: 'read_file', arguments: '{"file_path":"a.js","limit":3}' } }), { type: 'tool', name: 'read_file', input: { file_path: 'a.js' } });
  assert.equal(museCli.parseMuseLine({ payload_type: 'tool.call.started', payload: { tool_name: 42 } }), null);
  assert.equal(museCli.parseMuseLine({ payload_type: 'run.usage', payload: { tool_name: 'Bash' } }), null, 'tool 이 없는 종류는 이름이 있어도 무시');
  assert.ok(museCli.LOGIN_HINT_RE.test('muse exec: missing meta credential in C:\\u\\auth.json: run `muse login` or set META_API_KEY'));
  assert.ok(museCli.LOGIN_HINT_RE.test('muse usage: not logged in: run `muse login` first'));
  assert.ok(!museCli.LOGIN_HINT_RE.test('boom'));
});

test('parseMuseLine: sessionId 를 주면 다른 세션 stream(하위 에이전트) 줄은 무시, stream 이 없거나 세션이 아니면 그대로, 종료는 run.terminal.* 모두', () => {
  const other = { ...LINES.delta, stream: { kind: 'session', id: 'aaaaaaaa-0000-4000-8000-000000000000' } };
  assert.equal(museCli.parseMuseLine(other, UUID), null);
  assert.deepEqual(museCli.parseMuseLine(other), { type: 'text', text: 'echo: first turn apple' }, 'sessionId 없으면 거르지 않는다');
  assert.deepEqual(museCli.parseMuseLine(LINES.delta, UUID), { type: 'text', text: 'echo: first turn apple' });
  assert.equal(museCli.parseMuseLine(LINES.end, UUID).ok, true);
  assert.equal(museCli.parseMuseLine({ ...LINES.end, stream: { kind: 'session', id: 'bbbbbbbb-0000-4000-8000-000000000000' } }, UUID), null, '다른 세션의 종료 줄이 우리 턴을 끝내면 안 된다');
  const { stream, ...noStream } = LINES.delta;
  assert.deepEqual(museCli.parseMuseLine(noStream, UUID), { type: 'text', text: 'echo: first turn apple' }, 'stream 이 없으면 지금처럼');
  assert.deepEqual(museCli.parseMuseLine({ ...LINES.delta, stream: { kind: 'exec.usage', id: 'x' } }, UUID), { type: 'text', text: 'echo: first turn apple' }, '세션 stream 이 아니면 거르지 않는다');
  assert.deepEqual(museCli.parseMuseLine({ ...LINES.delta, stream: { kind: 'session' } }, UUID), { type: 'text', text: 'echo: first turn apple' }, 'id 가 없으면 거르지 않는다');
  // 종료 판정은 run.terminal.* 전체 (completed 만 ok)
  assert.deepEqual(museCli.parseMuseLine({ stream: { kind: 'session', id: UUID }, payload_type: 'run.terminal.failed', payload: { terminal: 'failed', text: '', reason: '실패' } }, UUID), { type: 'end', ok: false, text: '', reason: '실패' });
  assert.deepEqual(museCli.parseMuseLine({ payload_type: 'run.terminal.cancelled', payload: { terminal: 'cancelled' } }), { type: 'end', ok: false, text: '', reason: '' });
  assert.equal(museCli.parseMuseLine({ payload_type: 'run.terminalx', payload: { terminal: 'completed' } }), null);
});

test('parseMuseLine: seen 을 주면 같은 도구 호출(tool_use_id 또는 id)은 한 번만, id 가 없으면 중복 제거하지 않는다', () => {
  const seen = new Set();
  const line = (extra) => ({ payload_type: 'tool.call.started', payload: { tool_name: 'Bash', tool_input: { command: 'ls' }, ...extra } });
  assert.equal(museCli.parseMuseLine(line({ tool_use_id: 't1' }), null, seen).type, 'tool');
  assert.equal(museCli.parseMuseLine(line({ tool_use_id: 't1' }), null, seen), null);
  assert.equal(museCli.parseMuseLine(line({ id: 't1' }), null, seen), null, 'tool_use_id 와 id 는 같은 표');
  assert.equal(museCli.parseMuseLine(line({ id: 't2' }), null, seen).type, 'tool');
  assert.equal(museCli.parseMuseLine(line({}), null, seen).type, 'tool');
  assert.equal(museCli.parseMuseLine(line({}), null, seen).type, 'tool');
  assert.equal(museCli.parseMuseLine(line({ tool_use_id: 't1' })).type, 'tool', 'seen 이 없으면 거르지 않는다');
});

// 가짜 spawn: 띄울 때 프롬프트 파일 내용을 읽어 둔다 (실제 프로세스는 만들지 않는다).
function fakeSpawn() {
  const calls = [];
  const spawn = (file, args, opts) => {
    const p = new EventEmitter();
    p.pid = 300 + calls.length;
    p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    p.out = (obj) => p.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));
    const promptFile = args[args.indexOf('--prompt-file') + 1];
    calls.push({ file, args, opts, p, promptFile, prompt: fs.existsSync(promptFile) ? fs.readFileSync(promptFile) : null });
    return p;
  };
  return { spawn, calls };
}

function setup(t, extra = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-muse-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const { spawn, calls } = fakeSpawn(); const events = []; const killed = [];
  const chat = new collab.MuseChat({
    loc: { file: 'muse-bin.exe', prefixArgs: [] }, cwd: 'C:\\w', systemPrompt: '규칙 문장', env: {}, tmpDir, spawn, hooks: ['-c', 'hooks.Stop=[]'],
    kill: (p) => killed.push(p.pid), onEvent: (e) => events.push(e), ...extra,
  });
  chat.sessionId = UUID; // 실측 줄(LINES)의 stream.id 와 맞춘다 — 해석기가 우리 세션 줄만 읽는다
  return { chat, calls, events, killed, tmpDir, files: () => fs.readdirSync(tmpDir) };
}
const finishOk = (c, text = 'ok') => { c.p.out({ ...LINES.delta, payload: { ...LINES.delta.payload, text } }); c.p.out(LINES.end); c.p.emit('close', 0); };

test('협업 Muse: 생성자는 프로세스를 띄우지 않고, 첫 턴은 규칙 포함 프롬프트 파일(BOM 없음) + exec 인자 + hooks, 끝나면 파일을 지운다', (t) => {
  const { chat, calls, events, files } = setup(t);
  assert.equal(calls.length, 0); assert.equal(chat.busy, false); assert.equal(chat.proc, null);
  chat.send('첫 질문 "따옴표" 100%', { model: 'auto', effort: 'auto' }, 7);
  assert.equal(calls.length, 1); assert.equal(chat.busy, true); assert.equal(chat.proc, calls[0].p);
  const { args, prompt, promptFile, opts } = calls[0];
  assert.equal(prompt.toString('utf8'), '규칙 문장\n\n첫 질문 "따옴표" 100%');
  assert.notDeepEqual([...prompt.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM 없음');
  assert.ok(path.basename(promptFile).startsWith(`ao-muse-${process.pid}-`) && promptFile.endsWith('.txt'));
  assert.deepEqual(args, ['exec', '--json', '--prompt-file', promptFile, '--session-id', chat.sessionId, '--approval-mode', 'never', '-c', 'hooks.Stop=[]']);
  assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe'], '표준 입력을 열어 두지 않는다 (열어 두면 exec 가 멈춘다)');
  assert.equal(opts.cwd, 'C:\\w');
  assert.equal(files().length, 1, '실행 중에는 프롬프트 파일이 있다');
  const p = calls[0].p;
  p.out(LINES.accepted); p.out(LINES.delta); p.out(LINES.usage);
  assert.equal(chat.busy, true, 'end 줄만으로는 끝나지 않고 프로세스 종료를 기다린다');
  p.out(LINES.end);
  assert.equal(events.at(-1).type, 'text', 'end 는 내보내지 않는다');
  p.emit('close', 0);
  assert.deepEqual(events.map((e) => e.type), ['session', 'text', 'done']);
  assert.deepEqual(events[0], { type: 'session', sessionId: chat.sessionId, turn: 7 });
  assert.deepEqual(events[1], { type: 'text', text: 'echo: first turn apple', turn: 7 });
  assert.deepEqual(events.at(-1), { type: 'done', ok: true, turn: 7 });
  assert.equal(chat.busy, false); assert.deepEqual(files(), [], '프롬프트 파일 삭제'); assert.equal(chat.started, true);
});

test('협업 Muse: 두 번째 턴도 같은 --session-id 로 이어 가며 규칙을 다시 붙이지 않고, session 은 한 번만 알린다 · 모델·단계 인자', (t) => {
  const { chat, calls, events, files } = setup(t);
  const sid = chat.sessionId;
  chat.send('하나', { model: 'muse-spark-1.3', effort: 'high' });
  finishOk(calls[0]);
  chat.send('둘', { model: 'muse-spark-1.3', effort: 'high' });
  assert.equal(calls.length, 2);
  const a = calls[1].args;
  assert.deepEqual(a.slice(a.indexOf('--session-id'), a.indexOf('--session-id') + 2), ['--session-id', sid]);
  assert.deepEqual(a.slice(a.indexOf('--model'), a.indexOf('--model') + 2), ['--model', 'muse-spark-1.3']);
  assert.deepEqual(a.slice(a.indexOf('--reasoning-effort'), a.indexOf('--reasoning-effort') + 2), ['--reasoning-effort', 'high']);
  assert.equal(calls[1].prompt.toString('utf8'), '둘');
  assert.notEqual(calls[0].promptFile, calls[1].promptFile);
  finishOk(calls[1]);
  assert.equal(chat.sessionId, sid);
  assert.equal(events.filter((e) => e.type === 'session').length, 1);
  assert.deepEqual(events.filter((e) => e.type === 'done'), [{ type: 'done', ok: true }, { type: 'done', ok: true }]);
  assert.deepEqual(files(), []);
});

test('협업 Muse: extraArgs 는 exec 인자 맨 끝에 붙는다 (점검에서 --provider echo)', (t) => {
  const { chat, calls } = setup(t, { extraArgs: ['--provider', 'echo'] });
  chat.send('하나', {});
  assert.deepEqual(calls[0].args.slice(-4), ['-c', 'hooks.Stop=[]', '--provider', 'echo']);
  const none = setup(t, { hooks: undefined });
  none.chat.send('하나', {});
  assert.deepEqual(none.calls[0].args.slice(-2), ['--approval-mode', 'never']);
});

test('협업 Muse: 진행 중에 보낸 send 는 무시하고 steer 는 지원하지 않는다', (t) => {
  const { chat, calls } = setup(t);
  chat.send('하나', {}); chat.send('둘', {});
  assert.equal(calls.length, 1);
  assert.equal(chat.steer('끼어들기', 1), false);
});

test('협업 Muse: 조각 출력 없이 최종 응답만 오면 그 텍스트를 내보낸다 (조각이 있었으면 중복하지 않는다)', (t) => {
  const { chat, calls, events } = setup(t);
  chat.send('하나', {});
  calls[0].p.out(LINES.end); calls[0].p.emit('close', 0);
  assert.deepEqual(events.map((e) => e.type), ['session', 'text', 'done']);
  assert.equal(events[1].text, 'echo: first turn apple');
  chat.send('둘', {});
  finishOk(calls[1], '조각');
  assert.deepEqual(events.slice(3).map((e) => e.type), ['text', 'done']);
});

test('협업 Muse: 로그인 오류(stderr) 로 끝나면 로그인 안내 문구, 첫 턴 실패라 새 세션 ID 와 규칙 재첨부', (t) => {
  const { chat, calls, events, files } = setup(t);
  const first = chat.sessionId;
  chat.send('하나', {});
  calls[0].p.stderr.emit('data', Buffer.from('muse exec: missing meta credential in C:\\Users\\u\\.config\\muse\\auth.json: run `muse login` or set META_API_KEY\n'));
  calls[0].p.emit('close', 1);
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, error: 'Muse 로그인이 필요합니다 (결제 수단·구독이 있는 Meta 계정)' });
  assert.equal(chat.started, false); assert.notEqual(chat.sessionId, first); assert.deepEqual(files(), []);
  chat.send('다시', {});
  assert.equal(calls[1].prompt.toString('utf8'), '규칙 문장\n\n다시');
  assert.deepEqual(events.filter((e) => e.type === 'session').map((e) => e.sessionId), [first, chat.sessionId], 'session 을 다시 알린다');
  assert.ok(calls[1].args.includes(chat.sessionId));
});

test('협업 Muse: 아무 출력 없이 끝나면 stderr 마지막 줄, 그것도 없으면 기본 문구로 실패한다', (t) => {
  const { chat, calls, events } = setup(t);
  chat.send('하나', {});
  calls[0].p.stderr.emit('data', Buffer.from('warn\nboom: 실행 실패\n'));
  calls[0].p.emit('close', 3);
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, error: 'boom: 실행 실패' });
  chat.send('둘', {});
  calls[1].p.emit('close', 0);
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, error: 'Muse 가 응답 없이 끝났습니다' });
});

test('협업 Muse: 종료 줄이 실패(terminal 이 completed 가 아님)면 reason 으로 실패하고, reason 이 없으면 기본 문구', (t) => {
  const { chat, calls, events, files } = setup(t);
  chat.send('하나', {});
  calls[0].p.out(LINES.failed); calls[0].p.emit('close', 0);
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, error: '모델 호출 실패' });
  assert.equal(chat.started, false); assert.deepEqual(files(), []);
  chat.send('둘', {});
  calls[1].p.out({ ...LINES.failed, stream: { kind: 'session', id: chat.sessionId }, payload: { terminal: 'cancelled', text: '', reason: null } }); calls[1].p.emit('close', 0); // 첫 턴 실패로 세션 ID 가 바뀌었다
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, error: 'Muse 가 오류로 끝났습니다' });
});

test('협업 Muse: 실행 실패(error 이벤트)와 spawn 예외도 실패로 끝내고 파일을 남기지 않는다', (t) => {
  const { chat, calls, events, files } = setup(t);
  chat.send('하나', {});
  calls[0].p.emit('error', new Error('ENOENT'));
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, error: 'Muse 를 실행하지 못했습니다: ENOENT' });
  assert.equal(chat.busy, false); assert.deepEqual(files(), []);
  const bad = setup(t, { spawn: () => { throw new Error('spawn 불가'); } });
  bad.chat.send('둘', {}, 3);
  assert.deepEqual(bad.events, [{ type: 'done', ok: false, error: 'Muse 를 실행하지 못했습니다: spawn 불가', turn: 3 }]);
  assert.equal(bad.chat.busy, false); assert.deepEqual(bad.files(), []);
});

test('협업 Muse: 도구 줄(미확인 모양 방어)은 tool 이벤트로, 한글이 바이트 중간에서 끊겨도 이어 읽는다', (t) => {
  const { chat, calls, events } = setup(t);
  chat.send('하나', {});
  calls[0].p.out({ payload_type: 'tool.call.started', payload: { tool_name: 'Bash', tool_input: { command: 'ls' } } });
  const bytes = Buffer.from(JSON.stringify({ ...LINES.delta, payload: { text: '안녕하세요' } }) + '\n');
  calls[0].p.stdout.emit('data', bytes.subarray(0, bytes.indexOf('안') + 4));
  calls[0].p.stdout.emit('data', bytes.subarray(bytes.indexOf('안') + 4));
  assert.deepEqual(events.find((e) => e.type === 'tool'), { type: 'tool', name: 'Bash', input: { command: 'ls' } });
  assert.deepEqual(events.find((e) => e.type === 'text'), { type: 'text', text: '안녕하세요' });
});

test('협업 Muse: 다른 세션 stream 의 줄은 무시하고(하위 에이전트), 같은 도구 호출은 턴 안에서 한 번만 · 다음 턴에는 다시 센다', (t) => {
  const { chat, calls, events } = setup(t);
  chat.send('하나', {});
  const p = calls[0].p;
  const alien = { stream: { kind: 'session', id: 'aaaaaaaa-0000-4000-8000-000000000000' } };
  p.out({ ...LINES.delta, ...alien, payload: { text: '남의 응답' } });
  p.out({ ...LINES.end, ...alien });
  assert.equal(chat.busy, true); assert.deepEqual(events.map((e) => e.type), ['session'], '남의 줄은 아무것도 내지 않는다');
  const mine = () => ({ kind: 'session', id: chat.sessionId });
  const tool = () => ({ stream: mine(), payload_type: 'tool.call.started', payload: { tool_name: 'Bash', tool_use_id: 'u1', tool_input: { command: 'ls' } } });
  p.out(tool()); p.out(tool());
  p.out({ ...LINES.delta, stream: mine() }); p.out({ ...LINES.end, stream: mine() }); p.emit('close', 0);
  assert.deepEqual(events.map((e) => e.type), ['session', 'tool', 'text', 'done']);
  chat.send('둘', {});
  calls[1].p.out(tool());
  assert.equal(events.filter((e) => e.type === 'tool').length, 2, '다음 턴에서는 같은 id 도 다시 나온다');
  // 진행 중에 들어온 send 는 무시되고 중복 제거 표도 건드리지 않는다
  chat.send('셋', {});
  calls[1].p.out(tool());
  assert.equal(events.filter((e) => e.type === 'tool').length, 2);
});

test('협업 Muse: end 줄이 두 번 와도 유예 타이머는 하나만 살아 있다 (앞 타이머를 남기지 않는다)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { chat, calls, events, killed } = setup(t);
  chat.send('하나', {});
  calls[0].p.out(LINES.end);
  t.mock.timers.tick(2000);
  calls[0].p.out(LINES.end); // 두 번째 end — 유예가 여기서부터 다시 3초
  t.mock.timers.tick(2000);
  assert.equal(chat.busy, true); assert.deepEqual(killed, []);
  t.mock.timers.tick(1000);
  assert.deepEqual(killed, [calls[0].p.pid]);
  assert.equal(events.filter((e) => e.type === 'done').length, 1);
});

test('협업 Muse: 중단하면 프로세스를 끝내고 바로 「중단됨」, 늦은 출력은 무시, 첫 턴 중단은 새 세션 ID', (t) => {
  const { chat, calls, events, killed, files } = setup(t);
  const first = chat.sessionId;
  chat.send('작업', {}, 2);
  calls[0].p.out(LINES.delta);
  chat.stop();
  assert.deepEqual(killed, [calls[0].p.pid]);
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, stopped: true, turn: 2 });
  assert.equal(chat.busy, false); assert.equal(chat.started, false); assert.notEqual(chat.sessionId, first);
  const before = events.length;
  calls[0].p.out(LINES.delta); calls[0].p.out(LINES.end); calls[0].p.emit('close', 1);
  assert.equal(events.length, before, '옛 프로세스의 늦은 출력·종료는 무시');
  assert.deepEqual(files(), []);
  chat.stop();
  assert.equal(events.length, before);
  chat.send('다음', {});
  assert.equal(calls.length, 2);
  assert.equal(calls[1].prompt.toString('utf8'), '규칙 문장\n\n다음');
  assert.deepEqual(events.filter((e) => e.type === 'session').map((e) => e.sessionId), [first, chat.sessionId]);
});

test('협업 Muse: 닫으면 프로세스를 끝내고 이벤트 없이 파일을 지우며, 이후 send 는 무시한다', (t) => {
  const { chat, calls, events, killed, files } = setup(t);
  chat.send('작업', {});
  chat.close();
  assert.deepEqual(killed, [calls[0].p.pid]);
  calls[0].p.out(LINES.delta); calls[0].p.emit('close', 1);
  assert.deepEqual(events.map((e) => e.type), ['session']);
  assert.deepEqual(files(), []);
  chat.send('또', {});
  assert.equal(calls.length, 1);
  chat.close();
});

test('협업 Muse: end 줄을 받은 뒤 프로세스가 3초 안에 끝나지 않으면 정상으로 끝내고 죽인다 · 유예 중 중단돼도 세션 ID 유지', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { chat, calls, events, killed, files } = setup(t);
  chat.send('하나', {}, 4);
  const p = calls[0].p;
  p.out(LINES.delta); p.out(LINES.end);
  t.mock.timers.tick(2999);
  assert.equal(chat.busy, true); assert.deepEqual(killed, []);
  t.mock.timers.tick(1);
  assert.deepEqual(killed, [p.pid]);
  assert.deepEqual(events.at(-1), { type: 'done', ok: true, turn: 4 });
  assert.equal(chat.started, true); assert.deepEqual(files(), []);
  p.emit('close', 0);
  assert.equal(events.filter((e) => e.type === 'done').length, 1);
  // 유예 중 중단: 첫 턴은 이미 성공이라 같은 세션을 이어 간다
  const b = setup(t);
  const sid = b.chat.sessionId;
  b.chat.send('하나', {});
  b.calls[0].p.out(LINES.end);
  b.chat.stop();
  assert.deepEqual(b.events.at(-1), { type: 'done', ok: false, stopped: true });
  assert.equal(b.chat.started, true); assert.equal(b.chat.sessionId, sid);
  t.mock.timers.tick(5000);
  assert.equal(b.events.filter((e) => e.type === 'done').length, 1, '중단 뒤 유예 타이머는 아무것도 하지 않는다');
  b.chat.send('둘', {});
  assert.equal(b.calls[1].prompt.toString('utf8'), '둘'); // 규칙은 이미 전달됨
  assert.ok(b.calls[1].args.includes(sid));
  assert.equal(b.events.filter((e) => e.type === 'session').length, 1, 'session 을 다시 알리지 않는다');
});

test('협업 Muse: 프롬프트 파일은 wx 로 써서 이미 있는 파일을 덮어쓰지도 지우지도 않는다', (t) => {
  const { chat, calls, events, tmpDir, files } = setup(t);
  chat.send('하나', {});
  const m = path.basename(calls[0].promptFile).match(/^ao-muse-(\d+)-(\d+)\.txt$/);
  finishOk(calls[0]);
  const taken = path.join(tmpDir, `ao-muse-${m[1]}-${Number(m[2]) + 1}.txt`);
  fs.writeFileSync(taken, '남의 내용');
  chat.send('둘', {}, 5);
  assert.equal(calls.length, 1, '프로세스를 띄우지 않는다');
  const done = events.at(-1);
  assert.equal(done.ok, false); assert.equal(done.turn, 5); assert.match(done.error, /EEXIST/);
  assert.equal(fs.readFileSync(taken, 'utf8'), '남의 내용');
  assert.deepEqual(files(), [path.basename(taken)]);
});

test('협업 Muse: cmd.exe 경유(cmdShim) 위치는 만들 때 거절한다 — JSON 인자가 깨진다', () => {
  assert.throws(() => new collab.MuseChat({ loc: { file: 'cmd.exe', prefixArgs: [], cmdShim: 'C:\\m\\muse.cmd' }, cwd: 'C:\\w', onEvent: () => {} }), /muse-bin-\*\.exe.*다시 설치/);
});

test('앱 시작 정리: Muse 프롬프트 파일(ao-muse-*)도 1시간 넘은 것만 지운다', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-muse-clean-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  const make = (name, ageMs) => { const f = path.join(dir, name); fs.writeFileSync(f, 'x'); const at = new Date(now - ageMs); fs.utimesSync(f, at, at); };
  make('ao-muse-123-1.txt', 2 * 3600000); make('ao-muse-123-2.txt', 60000); make('ao-grok-123-3.txt', 2 * 3600000); make('ao-muse-notes.txt', 2 * 3600000); make('ao-other-1-1.txt', 2 * 3600000);
  assert.equal(collab.cleanStalePromptFiles({ tmpDir: dir, now }), 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['ao-muse-123-2.txt', 'ao-muse-notes.txt', 'ao-other-1-1.txt']);
});

// ───── agentCli: 실행 파일 위치·shim 버전·탭 hook 인자 ─────
const out = (stdout, { code = 0, stderr = '' } = {}) => ({ code, stdout, stderr });

test('locate muse: 설치 폴더의 실행 파일을 직접 쓰고 muse.cmd 가 있으면 shim 으로 함께 기억한다', async () => {
  const cmd = agentCli.ADAPTERS.muse.paths()[0];
  const exe = 'C:\\Users\\u\\AppData\\Local\\Programs\\muse\\muse-bin-1.4.14-R7309.1.exe';
  const withShim = await agentCli.locate('muse', { platform: 'win32', exists: (p) => p === cmd, where: async () => { throw new Error('where 는 부르지 않는다'); }, museExe: () => exe });
  assert.deepEqual(withShim, { file: exe, prefixArgs: [], display: exe, shim: cmd });
  const noShim = await agentCli.locate('muse', { platform: 'win32', exists: () => false, where: async () => out(''), museExe: () => exe });
  assert.deepEqual(noShim, { file: exe, prefixArgs: [], display: exe });
  // 실행 파일이 없으면 지금처럼 muse.cmd (cmd 경유)
  const fallback = await agentCli.locate('muse', { platform: 'win32', exists: (p) => p === cmd, where: async () => out(''), museExe: () => null });
  assert.deepEqual(fallback, { file: 'cmd.exe', prefixArgs: [], cmdShim: cmd, display: cmd });
  // 다른 AI 는 museExe 를 보지 않는다
  const grok = agentCli.ADAPTERS.grok.paths()[0];
  assert.deepEqual(await agentCli.locate('grok', { platform: 'win32', exists: (p) => p === grok, where: async () => out(''), museExe: () => exe }), { file: grok, prefixArgs: [], display: grok });
});

test('version muse: shim 이 있으면 shim(cmd 경유)으로 --version 을 불러 런처 자동 업데이트를 돌린다 · 「Muse Code 1.4.14 (…)」→ 1.4.14', async () => {
  const seen = [];
  const runner = async (l, a) => { seen.push([l, a]); return out('Muse Code 1.4.14 (R7309.1)\n'); };
  const withShim = await agentCli.version({ file: 'C:\\m\\muse-bin-1.exe', prefixArgs: [], shim: 'C:\\m\\muse.cmd' }, { runner });
  assert.equal(withShim, '1.4.14');
  assert.deepEqual(seen[0], [{ file: 'cmd.exe', prefixArgs: [], cmdShim: 'C:\\m\\muse.cmd', display: 'C:\\m\\muse.cmd' }, ['--version']]);
  const direct = { file: 'C:\\m\\muse-bin-1.exe', prefixArgs: [] };
  assert.equal(await agentCli.version(direct, { runner }), '1.4.14');
  assert.equal(seen[1][0], direct, 'shim 이 없으면 위치 그대로');
});

test('version muse: shim 호출에는 AUTH_TIMEOUT_MS(10초) 시간 제한, 직접 호출에는 따로 주지 않는다', async () => {
  const seen = [];
  const runner = async (l, a, ms) => { seen.push(ms); return out('Muse Code 1.4.14 (R1)\n'); };
  await agentCli.version({ file: 'C:\\m\\muse-bin-1.exe', prefixArgs: [], shim: 'C:\\m\\muse.cmd' }, { runner });
  await agentCli.version({ file: 'C:\\m\\muse-bin-1.exe', prefixArgs: [] }, { runner });
  assert.deepEqual(seen, [10000, undefined]);
  // 시간 초과(출력 없음)면 버전 없음
  assert.equal(await agentCli.version({ file: 'x', prefixArgs: [], shim: 'C:\\m\\muse.cmd' }, { runner: async () => out('', { code: 1 }) }), null);
});

test('authStatus muse: 실행 파일로 usage (미로그인 문구는 false)', async () => {
  const seen = [];
  const loc = { file: 'C:\\m\\muse-bin-1.exe', prefixArgs: [], shim: 'C:\\m\\muse.cmd' };
  const r = await agentCli.authStatus('muse', loc, { runner: async (l, a) => { seen.push([l, a]); return out('', { code: 1, stderr: 'muse usage: not logged in: run `muse login` first' }); } });
  assert.deepEqual(r, { loggedIn: false });
  assert.deepEqual(seen, [[loc, ['usage']]]);
});

test('tabArgs muse: hook 이 있을 때만 세션 단위 hook 인자, cmd 경유 위치면 hook 없이 탭만 (JSON 인자가 깨진다)', () => {
  const hook = { port: 47821, token: 'tok', tab: 'tab-1' };
  assert.deepEqual(agentCli.tabArgs('muse', { hook }), museCli.hookArgs(hook));
  assert.deepEqual(agentCli.tabArgs('muse', { hook, cmdShim: true }), []);
  assert.deepEqual(agentCli.tabArgs('muse', {}), []);
  assert.deepEqual(agentCli.tabArgs('muse'), []);
  assert.deepEqual(agentCli.tabArgs('grok', { hook }), [], '다른 AI 는 hook 인자를 받지 않는다');
  assert.deepEqual(agentCli.tabArgs('antigravity', { hook }), []);
  assert.throws(() => agentCli.tabArgs('muse', { hook: { port: 1, token: 'a b', tab: 't' } }), /잘못된 hook 값/);
});

// ───── hookServer: Muse 본문 ─────
test('toEvent: Muse hook — 주소의 cli=muse·tab 으로 어느 탭인지 알고, 문자열 tool_input 은 JSON 으로 풀어 읽는다', () => {
  const ev = toEvent(HOOK_STOP, {}, 'session', 5, { cli: 'muse', tab: 'room-1' });
  assert.equal(ev._cli, 'muse'); assert.equal(ev._tab, 'room-1'); assert.equal(ev._src, 'session');
  assert.equal(ev.hook_event_name, 'Stop'); assert.equal(ev.transcript_path, undefined);
  const pre = (tool_input) => toEvent({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input }, {}, 'session', 1, { cli: 'muse', tab: 'room-1' }).tool_input;
  assert.deepEqual(pre('{"command":"ls","timeout":5,"other":"x"}'), { command: 'ls' }, '문자열 → 객체, 허용 키만');
  assert.deepEqual(pre({ command: 'ls', file_path: 'a.js' }), { command: 'ls', file_path: 'a.js' }, '객체(Claude·Codex)는 그대로');
  assert.equal(pre('not json'), undefined);
  assert.equal(pre('"just a string"'), undefined);
  assert.equal(pre('[1,2]') && Object.keys(pre('[1,2]')).length, 0);
  assert.equal(pre(undefined), undefined);
});

// ───── 협업 규칙 ─────
test('collabRules muse: 줄바꿈으로 잇고 추가 문장 없음, 참여자 표기는 Muse(Meta Muse Code)', () => {
  const muse = collabRules(['claude', 'muse'], 'muse');
  assert.equal(muse.split('\n').length, 11, '공통 문장 11개만');
  assert.ok(muse.startsWith('당신은 Agent Office 의 협업 대화에 참여하고 있습니다. 참여자는 사용자, Claude(Claude Code), Muse(Meta Muse Code) 셋이며'));
  assert.ok(muse.includes('[Claude] [Muse] [사용자]') && muse.includes('Claude 와 Muse 둘 다 만족하는'));
  assert.ok(!muse.includes('하위 에이전트'));
  assert.ok(!/"|%/.test(muse));
  assert.ok(!/[\r\n"%]/.test(collabRules(['claude', 'muse'], 'claude')), 'claude 규칙에는 줄바꿈·큰따옴표·% 가 없다');
});
