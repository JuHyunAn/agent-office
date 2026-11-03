import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const collab = require('../src/main/collabAgents.cjs');
const agentCli = require('../src/main/agentCli.cjs');

const CONV = '5b9d2c1e-0000-4000-8000-00000000a001';

// 실측 줄 (agy 1.4.12 --output-format stream-json) — 필요한 필드만 남겼다.
const step = (extra) => ({ event: 'step_update', step_update: { conversation_id: CONV, ...extra } });
const LINES = {
  init: { event: 'init', conversation_id: CONV, init: { cwd: 'C:\\w', tools: ['run_command'], permission_mode: 'request-review' } }, // 실측: ID 는 최상위
  user: step({ step_index: 0, state: 'DONE', step_type: 'user_input' }),
  text: (i, t) => step({ step_index: i, state: 'ACTIVE', step_type: 'agent_response', text_delta: t }),
  bash: (i) => step({ step_index: i, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'dir', Cwd: 'C:\\w' } } }),
  bashDone: (i) => step({ step_index: i, state: 'DONE', step_type: 'tool', tool_name: 'run_command' }),
  toolError: (i) => step({ step_index: i, state: 'ERROR', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: 'C:\\없음.txt' }, error: { type: 'x', message: '없는 파일' } } }),
  ok: { event: 'result', result: { conversation_id: CONV, status: 'SUCCESS', response: '최종 응답', duration_seconds: 9, num_turns: 1, usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 2, cache_read_tokens: 0, total_tokens: 17 } } },
  fail: { event: 'result', result: { conversation_id: CONV, status: 'ERROR', response: '모델 호출 실패' } },
};

// 가짜 spawn: 띄울 때 tmpDir 의 프롬프트 파일 내용을 읽어 둔다 (실제 프로세스는 만들지 않는다).
function setup(t, extra = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-agy-test-'));
  t.after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 이미 없음 */ } });
  const calls = []; const events = []; const killed = []; const usages = [];
  const spawn = (file, args, opts) => {
    const p = new EventEmitter();
    p.pid = 300 + calls.length;
    p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    p.out = (obj) => p.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));
    const names = fs.readdirSync(tmpDir);
    const promptFile = names.length ? path.join(tmpDir, names.sort().at(-1)) : null;
    calls.push({ file, args, opts, p, promptFile, prompt: promptFile ? fs.readFileSync(promptFile, 'utf8') : null });
    return p;
  };
  const chat = new collab.AgyChat({
    loc: { file: 'agy.exe', prefixArgs: [] }, cwd: 'C:\\w', systemPrompt: '규칙 문장', env: {}, tmpDir, spawn,
    kill: (p) => killed.push(p.pid), onEvent: (e) => events.push(e), onUsage: (u) => usages.push(u), ...extra,
  });
  return { chat, calls, events, killed, usages, tmpDir, files: () => fs.readdirSync(tmpDir) };
}

const after = (args, flag) => args[args.indexOf(flag) + 1];
const finish = (c, i = 0, code = 0) => { c[i].p.out(LINES.ok); c[i].p.emit('close', code); };

test('agyChatArgs: 첫 턴은 -p·stream-json·승인 우회, resume 이면 --conversation, 모델은 안전한 값만 (auto 는 생략), --effort 는 쓰지 않는다', () => {
  const a = collab.agyChatArgs({ prompt: '질문', conversationId: 'c1', resume: false });
  assert.deepEqual(a, ['-p', '질문', '--output-format', 'stream-json', '--dangerously-skip-permissions']);
  const b = collab.agyChatArgs({ prompt: '질문', conversationId: 'c1', resume: true, model: 'gemini-3.8-flash-high', effort: 'xhigh' });
  assert.deepEqual(b, ['-p', '질문', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--conversation', 'c1', '--model', 'gemini-3.8-flash-high']);
  const c = collab.agyChatArgs({ prompt: 'p', conversationId: 'c1', resume: true, model: 'auto', effort: 'auto' });
  assert.ok(!c.includes('--model') && !c.includes('--effort'));
  const d = collab.agyChatArgs({ prompt: 'p', conversationId: 'c1', resume: true, model: '-x', effort: 'turbo' });
  assert.ok(!d.includes('--model') && !d.includes('--effort'), '-로 시작하는 모델·모르는 단계는 거절');
  assert.ok(!collab.agyChatArgs({ prompt: 'p', model: 'a b;c' }).includes('--model'));
  for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) assert.ok(!collab.agyChatArgs({ prompt: 'p', effort: e }).includes('--effort'), `단계는 모델 이름에 들어 있다: ${e}`);
  assert.ok(!collab.agyChatArgs({ prompt: 'p', resume: true, conversationId: null }).includes('--conversation'), 'ID 가 없으면 이어받지 않는다');
});

test('협업 Agy: 생성자는 프로세스를 띄우지 않고, 첫 턴은 -p 에 규칙+글, 작업 폴더는 spawn cwd, 표준 입력은 열지 않는다', (t) => {
  const { chat, calls, events, files } = setup(t);
  assert.equal(calls.length, 0); assert.equal(chat.busy, false); assert.equal(chat.proc, null);
  chat.send('첫 질문', { model: 'auto', effort: 'auto' }, 7);
  assert.equal(calls.length, 1); assert.equal(chat.busy, true); assert.equal(chat.proc, calls[0].p);
  const { file, args, opts } = calls[0];
  assert.equal(file, 'agy.exe');
  assert.equal(after(args, '-p'), '규칙 문장\n\n첫 질문');
  assert.deepEqual(args.slice(2), ['--output-format', 'stream-json', '--dangerously-skip-permissions']);
  assert.equal(opts.cwd, 'C:\\w'); assert.ok(!args.includes('--cwd'));
  assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(files().length, 1, '실행 중에는 프롬프트 파일이 있다 (긴 프롬프트용)');
  assert.ok(path.basename(calls[0].promptFile).startsWith(`ao-agy-${process.pid}-`));
  const p = calls[0].p;
  p.out(LINES.init); p.out(LINES.user); p.out(LINES.text(1, '안녕')); p.out(LINES.ok);
  p.emit('close', 0);
  assert.deepEqual(events.at(-1), { type: 'done', ok: true, turn: 7 });
  assert.ok(events.every((e) => e.turn === 7));
  assert.deepEqual(files(), [], '끝나면 프롬프트 파일을 지운다');
  assert.equal(chat.started, true);
});

test('협업 Agy: 두 번째 턴은 규칙 없이 글만, --conversation 은 agy 가 init 으로 알려 준 ID, session 이벤트로 알린다', (t) => {
  const { chat, calls, events } = setup(t);
  chat.send('하나', { model: 'claude-sonnet-4-6', effort: 'high' });
  assert.ok(!calls[0].args.includes('--conversation'));
  assert.deepEqual(calls[0].args.slice(-2), ['--model', 'claude-sonnet-4-6']);
  assert.ok(!calls[0].args.includes('--effort'));
  calls[0].p.out(LINES.init);
  assert.deepEqual(events.filter((e) => e.type === 'session').at(-1), { type: 'session', sessionId: CONV });
  assert.equal(chat.sessionId, CONV);
  calls[0].p.out(LINES.text(1, '글'));
  assert.equal(events.filter((e) => e.type === 'session' && e.sessionId === CONV).length, 1, 'agy ID 는 한 번만 알린다');
  finish(calls);
  chat.send('둘', { model: 'claude-sonnet-4-6', effort: 'high' });
  const a = calls[1].args;
  assert.equal(after(a, '-p'), '둘');
  assert.equal(after(a, '--conversation'), CONV);
  assert.equal(after(a, '--model'), 'claude-sonnet-4-6');
  assert.ok(!a.includes('--effort'));
  calls[1].p.out(LINES.init); // 같은 ID 라 session 을 다시 알리지는 않는다
  finish(calls, 1);
  assert.equal(events.filter((e) => e.type === 'session' && e.sessionId === CONV).length, 1);
  assert.deepEqual(events.filter((e) => e.type === 'done'), [{ type: 'done', ok: true }, { type: 'done', ok: true }]);
});

test('협업 Agy: 한글·큰따옴표·작은따옴표·%PATH%·개행이 -p 인자에 그대로 들어간다', (t) => {
  const { chat, calls } = setup(t, { systemPrompt: '' });
  const text = '안녕 "큰" \'작은\' %PATH% 100%\n둘째 줄\r\n셋째 `줄` $HOME & | > <';
  chat.send(text, {});
  assert.equal(after(calls[0].args, '-p'), text);
});

test('협업 Agy: 규칙 문장이 없으면 첫 턴도 글만 보낸다', (t) => {
  const { chat, calls } = setup(t, { systemPrompt: '' });
  chat.send('글', {});
  assert.equal(after(calls[0].args, '-p'), '글');
});

test('협업 Agy: 이스케이프 후 24000자를 넘는 프롬프트는 -p 에 파일 안내 문장, 파일 내용이 전체 프롬프트', (t) => {
  const none = { systemPrompt: '' };
  // 경계: JSON.stringify 길이가 정확히 24000 이면 인자로, 하나 더 길면 파일로
  const edge = setup(t, none);
  edge.chat.send('a'.repeat(23998), {});
  assert.equal(after(edge.calls[0].args, '-p').length, 23998);
  const over = setup(t, none);
  over.chat.send('a'.repeat(23999), {});
  assert.match(after(over.calls[0].args, '-p'), /^다음 파일의 내용을 그대로 읽고, 그 안의 지시에 따라 답하세요: /);
  assert.ok(after(over.calls[0].args, '-p').endsWith(over.calls[0].promptFile));
  assert.equal(over.calls[0].prompt, 'a'.repeat(23999));
  // 큰따옴표·역슬래시는 이스케이프로 길어지므로 글자 수가 적어도 파일로 간다
  const quoted = setup(t, none);
  quoted.chat.send('"'.repeat(12001), {});
  assert.match(after(quoted.calls[0].args, '-p'), /^다음 파일의 내용을/);
  assert.equal(quoted.calls[0].prompt, '"'.repeat(12001), '파일에는 이스케이프 없이 원문');
  // 첫 턴이면 규칙 문장도 파일 안에 있다
  const first = setup(t);
  first.chat.send('b'.repeat(30000), {});
  assert.equal(first.calls[0].prompt, `규칙 문장\n\n${'b'.repeat(30000)}`);
  // 끝나면 파일을 지운다
  finish(first.calls);
  assert.deepEqual(first.files(), []);
});

test('협업 Agy: 글 조각은 이어 붙이고(한글이 바이트 중간에서 끊겨도), 답변 단계가 바뀌면 block, 도구는 Claude 이름·키로 한 번만', (t) => {
  const { chat, calls, events } = setup(t);
  chat.send('하나', {});
  const p = calls[0].p;
  p.out(LINES.init);
  const bytes = Buffer.from(JSON.stringify(LINES.text(1, '안녕')) + '\n');
  p.stdout.emit('data', bytes.subarray(0, 100));
  p.stdout.emit('data', bytes.subarray(100));
  p.out(LINES.text(1, '하세요'));
  p.out(LINES.bash(2)); p.out(LINES.bash(2)); p.out(LINES.bashDone(2)); // 같은 단계의 ACTIVE 는 한 번만
  p.out(LINES.text(3, '다시'));
  p.out(LINES.toolError(4)); // 도구 오류는 대화창에 띄우지 않는다
  p.out(LINES.text(5, '끝')); p.out(LINES.text(5, '!'));
  p.out(LINES.ok); p.emit('close', 0);
  assert.deepEqual(events.filter((e) => e.type === 'text'), [
    { type: 'text', text: '안녕', block: true }, { type: 'text', text: '하세요' },
    { type: 'text', text: '다시', block: true }, { type: 'text', text: '끝', block: true }, { type: 'text', text: '!' },
  ]);
  assert.deepEqual(events.filter((e) => e.type === 'tool'), [{ type: 'tool', name: 'Bash', input: { command: 'dir' } }]);
  assert.ok(!events.some((e) => e.type === 'notice' || e.type === 'end'));
  assert.deepEqual(events.at(-1), { type: 'done', ok: true });
});

test('협업 Agy: 도구 중복 거르기와 단락 표는 턴마다 새로 시작한다', (t) => {
  const { chat, calls, events } = setup(t);
  chat.send('하나', {});
  calls[0].p.out(LINES.init); calls[0].p.out(LINES.bash(2)); calls[0].p.out(LINES.text(3, 'a'));
  finish(calls);
  chat.send('둘', {});
  calls[1].p.out(LINES.bash(2)); calls[1].p.out(LINES.text(3, 'b'));
  finish(calls, 1);
  assert.equal(events.filter((e) => e.type === 'tool').length, 2);
  assert.deepEqual(events.filter((e) => e.type === 'text'), [{ type: 'text', text: 'a', block: true }, { type: 'text', text: 'b', block: true }]);
});

test('parseAgyLine: 순수 해석 — init·글·도구(ACTIVE 만)·끝, 그 밖은 null', () => {
  const P = collab.parseAgyLine;
  assert.deepEqual(P(LINES.init), { type: 'session', sessionId: CONV });
  assert.deepEqual(P({ event: 'init', init: { conversation_id: 'nested' } }), { type: 'session', sessionId: 'nested' }, '안쪽 모양도 읽는다');
  assert.equal(P({ event: 'init', init: {} }), null);
  assert.deepEqual(P(LINES.text(1, '글')), { type: 'text', text: '글' });
  assert.equal(P(LINES.text(1, '')), null, '빈 조각');
  assert.equal(P(step({ step_type: 'agent_response', state: 'DONE' })), null);
  assert.deepEqual(P(LINES.bash(2)), { type: 'tool', name: 'Bash', input: { command: 'dir' } });
  assert.deepEqual(P(step({ state: 'ACTIVE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { parameters: { TargetFile: 'C:\\a.js', CodeContent: '큰 본문' } } })), { type: 'tool', name: 'Write', input: { file_path: 'C:\\a.js' } });
  assert.deepEqual(P(step({ state: 'ACTIVE', step_type: 'tool', tool_name: 'new_tool' })), { type: 'tool', name: 'new_tool', input: {} }, '표에 없는 이름은 그대로');
  assert.equal(P(LINES.bashDone(2)), null); assert.equal(P(LINES.toolError(3)), null); assert.equal(P(LINES.user), null);
  assert.deepEqual(P(LINES.ok), { type: 'end', ok: true, text: '최종 응답', reason: '' });
  assert.deepEqual(P(LINES.fail), { type: 'end', ok: false, text: '모델 호출 실패', reason: '모델 호출 실패' });
  assert.deepEqual(P({ event: 'result', result: { status: 'CANCELLED' } }), { type: 'end', ok: false, text: '', reason: 'CANCELLED' });
  for (const v of [null, undefined, 'x', 3, {}, { event: 'other' }, { event: 'step_update' }]) assert.equal(P(v), null);
});

test('협업 Agy: 글 조각 없이 result.response 만 오면 text 한 번, 조각이 있었으면 되풀이하지 않는다', (t) => {
  const { chat, calls, events } = setup(t);
  chat.send('하나', {});
  calls[0].p.out(LINES.init); calls[0].p.out(LINES.ok); calls[0].p.emit('close', 0);
  assert.deepEqual(events.filter((e) => e.type === 'text'), [{ type: 'text', text: '최종 응답' }]);
  chat.send('둘', {});
  calls[1].p.out(LINES.text(1, '조각')); calls[1].p.out(LINES.ok); calls[1].p.emit('close', 0);
  assert.deepEqual(events.filter((e) => e.type === 'text').slice(1), [{ type: 'text', text: '조각', block: true }]);
});

test('협업 Agy: result 가 실패면 done ok:false 와 오류 문구, 첫 턴 실패라 다음 턴은 이어받지 않고 규칙을 다시 붙인다', (t) => {
  const { chat, calls, events, files } = setup(t);
  chat.send('하나', {}, 3);
  calls[0].p.out(LINES.init); calls[0].p.out(LINES.fail); calls[0].p.emit('close', 1);
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, error: '모델 호출 실패', turn: 3 });
  assert.equal(chat.started, false); assert.deepEqual(files(), []);
  chat.send('다시', {});
  assert.ok(!calls[1].args.includes('--conversation'), '실패한 첫 턴의 ID 는 이어받지 않는다');
  assert.equal(after(calls[1].args, '-p'), '규칙 문장\n\n다시');
  // 응답이 비어도 상태 문구로 실패
  calls[1].p.out({ event: 'result', result: { status: 'TIMEOUT' } }); calls[1].p.emit('close', 1);
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, error: 'TIMEOUT' });
});

test('협업 Agy: 대화 ID 가 알린 값과 다르게 오면 조용히 덮어쓰지 않고 session 이벤트로 다시 알린다 (턴 번호 포함)', (t) => {
  const { chat, calls, events } = setup(t);
  chat.send('하나', {}, 4);
  calls[0].p.out(LINES.init);
  calls[0].p.out({ event: 'step_update', step_update: { conversation_id: 'conv-2', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '글' } });
  assert.deepEqual(events.filter((e) => e.type === 'session').slice(-2), [{ type: 'session', sessionId: CONV, turn: 4 }, { type: 'session', sessionId: 'conv-2', turn: 4 }]);
  assert.equal(events.at(-1).type, 'text', '글 이벤트도 그대로 나간다');
  assert.equal(chat.sessionId, 'conv-2');
  calls[0].p.out({ event: 'result', result: { conversation_id: 'conv-2', status: 'SUCCESS', response: 'x' } });
  calls[0].p.emit('close', 0);
  chat.send('둘', {});
  assert.equal(after(calls[1].args, '--conversation'), 'conv-2');
});

test('협업 Agy: init 이 없어도 step_update·result 의 conversation_id 로 이어 가고, 어디에도 ID 가 없으면 이어받지 않는다', (t) => {
  const a = setup(t);
  a.chat.send('하나', {});
  a.calls[0].p.out(LINES.text(1, '글')); // init 없음 — step_update 에만 ID
  finish(a.calls);
  a.chat.send('둘', {});
  assert.equal(after(a.calls[1].args, '--conversation'), CONV);
  const b = setup(t);
  b.chat.send('하나', {});
  b.calls[0].p.out({ event: 'result', result: { conversation_id: 'only-result', status: 'SUCCESS', response: 'x' } });
  b.calls[0].p.emit('close', 0);
  b.chat.send('둘', {});
  assert.equal(after(b.calls[1].args, '--conversation'), 'only-result');
  const c = setup(t);
  c.chat.send('하나', {});
  c.calls[0].p.out({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '글' } });
  c.calls[0].p.out({ event: 'result', result: { status: 'SUCCESS', response: 'x' } });
  c.calls[0].p.emit('close', 0);
  assert.equal(c.chat.started, true);
  c.chat.send('둘', {});
  assert.ok(!c.calls[1].args.includes('--conversation'), 'agy 가 준 ID 가 없으면 이어받지 않는다');
  assert.equal(after(c.calls[1].args, '-p'), '둘');
});

test('협업 Agy: result.usage 객체가 있을 때만 onUsage 를 부른다 (옵션이 없어도 안전)', (t) => {
  const { chat, calls, usages } = setup(t);
  chat.send('하나', {});
  calls[0].p.out(LINES.ok);
  assert.deepEqual(usages, [LINES.ok.result.usage]);
  calls[0].p.emit('close', 0);
  chat.send('둘', {});
  calls[1].p.out({ event: 'result', result: { status: 'SUCCESS', response: 'x', usage: '없음' } });
  calls[1].p.out({ event: 'result', result: { status: 'SUCCESS', response: 'x' } });
  assert.equal(usages.length, 1);
  const bare = setup(t, { onUsage: undefined });
  bare.chat.send('하나', {});
  assert.doesNotThrow(() => bare.calls[0].p.out(LINES.ok));
});

test('협업 Agy failText: 로그인 문구 · AGY_ERROR short_error(잘린 JSON 포함) · stderr 마지막 줄 · 빈 출력', (t) => {
  const { chat } = setup(t);
  const login = 'Gemini 로그인이 필요합니다 (진입 화면에서 로그인)';
  assert.equal(chat.failText('', 'Error: Please sign in to continue'), login);
  assert.equal(chat.failText('You are not signed in', ''), login);
  assert.equal(chat.failText('', 'authentication required'), login);
  assert.equal(chat.failText('x', 'AGY_ERROR: {"short_error":"모델 한도 초과","detail":"긴 설명'), '모델 한도 초과', '잘려도 short_error 는 읽는다');
  assert.equal(chat.failText('x', 'AGY_ERROR: {"short_error":"say \\"hi\\" 끝"}'), 'say "hi" 끝');
  assert.equal(chat.failText('', `AGY_ERROR: {"short_error":"${'가'.repeat(300)}"}`).length, 200);
  assert.equal(chat.failText('boom: 실행 실패', 'warn\nboom: 실행 실패'), 'boom: 실행 실패');
  assert.equal(chat.failText('', ''), 'Gemini 가 응답 없이 끝났습니다');
  // 실제 흐름: 출력 없이 stderr 만 남기고 끝나면 그 문구로 실패
  const { chat: c2, calls, events } = setup(t);
  c2.send('하나', {});
  calls[0].p.stderr.emit('data', Buffer.from('AGY_ERROR: {"short_error":"서버 점검 중"}\n'));
  calls[0].p.emit('close', 3);
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, error: '서버 점검 중' });
});

test('협업 Agy: 실행 실패(error 이벤트)와 spawn 예외도 실패로 끝내고 파일을 남기지 않는다', (t) => {
  const { chat, calls, events, files } = setup(t);
  chat.send('하나', {});
  calls[0].p.emit('error', new Error('ENOENT'));
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, error: 'Gemini 를 실행하지 못했습니다: ENOENT' });
  assert.equal(chat.busy, false); assert.deepEqual(files(), []);
  const bad = setup(t, { spawn: () => { throw new Error('spawn 불가'); } });
  bad.chat.send('둘', {}, 3);
  assert.deepEqual(bad.events, [{ type: 'done', ok: false, error: 'Gemini 를 실행하지 못했습니다: spawn 불가', turn: 3 }]);
  assert.deepEqual(bad.files(), []);
});

test('협업 Agy: 진행 중에 보낸 send 는 무시하고(규칙·프롬프트도 바뀌지 않는다) steer 는 지원하지 않는다', (t) => {
  const { chat, calls } = setup(t);
  chat.send('하나', {});
  chat.send('둘', {});
  assert.equal(calls.length, 1);
  assert.equal(chat.promptText, '규칙 문장\n\n하나');
  assert.equal(chat.steer('끼어들기', 1), false);
});

test('협업 Agy: 중단하면 프로세스를 끝내고 「중단됨」으로 끝내며 늦은 출력은 무시하고, 파일은 지운다', (t) => {
  const { chat, calls, events, killed, files } = setup(t);
  chat.send('작업', {}, 2);
  calls[0].p.out(LINES.init);
  chat.stop();
  assert.deepEqual(killed, [calls[0].p.pid]);
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, stopped: true, turn: 2 });
  assert.equal(chat.busy, false); assert.equal(chat.started, false);
  const before = events.length;
  calls[0].p.out(LINES.text(1, '늦은 글')); calls[0].p.out(LINES.ok); calls[0].p.emit('close', 1);
  assert.equal(events.length, before);
  assert.deepEqual(files(), []);
  chat.send('다음', {});
  assert.ok(!calls[1].args.includes('--conversation'), '중단된 첫 턴의 대화는 이어받지 않는다');
  assert.equal(after(calls[1].args, '-p'), '규칙 문장\n\n다음');
});

test('협업 Agy: 닫으면 프로세스를 끝내고 이벤트 없이 파일을 지우며 이후 send 는 무시한다', (t) => {
  const { chat, calls, events, killed, files } = setup(t);
  chat.send('작업', {});
  chat.close();
  assert.deepEqual(killed, [calls[0].p.pid]);
  calls[0].p.out(LINES.text(1, '글')); calls[0].p.emit('close', 1);
  assert.ok(!events.some((e) => e.type === 'done' || e.type === 'text'));
  assert.deepEqual(files(), []);
  chat.send('또', {});
  assert.equal(calls.length, 1);
  chat.close();
});

test('협업 Agy: cmd.exe 경유(cmdShim) 위치는 만들 때 거절한다', (t) => {
  assert.throws(() => new collab.AgyChat({ loc: { file: 'cmd.exe', prefixArgs: [], cmdShim: 'C:\\x\\agy.cmd' }, cwd: 'C:\\w', env: {}, onEvent: () => {} }), /agy\.exe/);
  assert.doesNotThrow(() => new collab.AgyChat({ loc: { file: 'agy.exe', prefixArgs: [] }, cwd: 'C:\\w', env: {}, onEvent: () => {}, tmpDir: os.tmpdir() }));
});

test('cleanStalePromptFiles: 오래된 agy 프롬프트 파일도 지우고, 이름 규칙에 안 맞는 파일은 건드리지 않는다', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-agy-stale-'));
  t.after(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 이미 없음 */ } });
  for (const n of ['ao-agy-1-1.txt', 'ao-grok-1-2.txt', 'ao-muse-1-3.txt', 'ao-agy-x-1.txt', 'other.txt']) fs.writeFileSync(path.join(tmpDir, n), 'x');
  assert.equal(collab.cleanStalePromptFiles({ tmpDir, now: Date.now() + 7200000 }), 3);
  assert.deepEqual(fs.readdirSync(tmpDir).sort(), ['ao-agy-x-1.txt', 'other.txt']);
});

test('parseAgyModels: Gemini 모델만 · 실측 줄(탭 구분) · 안내 줄 · 중복 · 안전하지 않은 이름 · 색 코드 · 단계는 빈 배열', () => {
  const out = [
    'Fetching available models...',
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
    'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
    'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
    'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
    'gemini-3.8-flash-high\t중복',
    'bad name!\t이름에 공백',
    '-x\t옵션처럼 보이는 이름',
    'no-tab-line 표시 이름',
    'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
    '\x1b[1mgemini_x\tGemini X\x1b[0m',
    '',
  ].join('\r\n');
  const efforts = []; // 단계는 모델 이름(High·Medium·Low)에 들어 있어 따로 고르지 않는다
  assert.deepEqual(agentCli.parseAgyModels(out), [
    { value: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', description: '', efforts },
    { value: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', description: '', efforts },
    { value: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)', description: '', efforts },
    { value: 'gemini_x', label: 'Gemini X', description: '', efforts },
  ]);
  assert.deepEqual(agentCli.parseAgyModels('claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)'), [], 'Gemini 가 없으면 빈 목록');
  assert.deepEqual(agentCli.parseAgyModels('Please sign in to view available models.'), []);
  assert.deepEqual(agentCli.parseAgyModels(null), []);
  assert.deepEqual(agentCli.parseAgyModels(''), []);
});
