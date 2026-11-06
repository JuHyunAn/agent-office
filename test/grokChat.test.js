import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setLang } from '../src/shared/i18n.js';

const require = createRequire(import.meta.url);
const collab = require('../src/main/collabAgents.cjs');
const agentCli = require('../src/main/agentCli.cjs');

// 실측 줄 (grok 1.0.70 streaming-json)
const LINES = {
  text: { type: 'text', data: '안녕하세요' },
  thought: { type: 'thought', data: '생각 중' },
  commands: { type: 'available_commands', commands: [] },
  usage: { type: 'usage', input: 1 },
  bash: { type: 'tool_call', toolCallId: 't1', title: 'run_terminal_command', kind: 'execute', status: 'pending', toolName: 'run_terminal_command', rawInput: { command: 'ls -la', description: '목록' } },
  read: { type: 'tool_call', toolCallId: 't2', title: 'read_file', kind: 'read', status: 'pending', toolName: 'read_file', rawInput: { target_file: 'C:\\w\\a.js', limit: 5 } },
  update: { type: 'tool_call_update', toolCallId: 't1', status: 'completed' },
  end: { type: 'end', stopReason: 'end_turn', sessionId: 'abc', usage: {}, num_turns: 2, total_cost_usd: 0.0257 },
  error: { type: 'error', message: 'Not signed in. Run grok login.' },
};

test('Grok 줄 해석: 글·도구(이름 표/입력 정리)·끝·오류, 그 밖은 null', () => {
  assert.deepEqual(collab.parseGrokLine(LINES.text), { type: 'text', text: '안녕하세요' });
  assert.deepEqual(collab.parseGrokLine(LINES.bash), { type: 'tool', name: 'Bash', input: { command: 'ls -la', description: '목록' } });
  assert.deepEqual(collab.parseGrokLine(LINES.read), { type: 'tool', name: 'Read', input: { file_path: 'C:\\w\\a.js' } }, 'target_file → file_path, 허용 키만');
  assert.deepEqual(collab.parseGrokLine({ type: 'tool_call', toolName: 'new_tool', rawInput: '{"query":"q"}' }), { type: 'tool', name: 'new_tool', input: { query: 'q' } }, '표에 없는 이름은 그대로, 문자열 입력도 풀어 읽는다');
  assert.deepEqual(collab.parseGrokLine(LINES.end), { type: 'end', stopReason: 'end_turn' });
  assert.deepEqual(collab.parseGrokLine(LINES.error), { type: 'notice', text: 'Not signed in. Run grok login.' });
  for (const k of ['thought', 'commands', 'usage', 'update']) assert.equal(collab.parseGrokLine(LINES[k]), null, k);
  assert.equal(collab.parseGrokLine(null), null);
  assert.equal(collab.parseGrokLine('text'), null);
});

test('grok models 해석: 기본 표시(*)·목록(-)·중복·안전하지 않은 이름·색 코드', () => {
  const out = [
    'You are logged in with grok.com.',
    'Default model: grok-4.7',
    'Available models:',
    '  * grok-4.7 (default)',
    '  - grok-4.5',
    '  - grok-4.5',
    '  - bad name!',
    '\x1b[1m  - grok-code\x1b[0m',
    '',
  ].join('\r\n');
  const efforts = ['low', 'medium', 'high', 'xhigh'];
  assert.deepEqual(agentCli.parseGrokModels(out), [
    { value: 'grok-4.7', label: 'grok-4.7', description: '기본', efforts },
    { value: 'grok-4.5', label: 'grok-4.5', description: '', efforts },
    { value: 'grok-code', label: 'grok-code', description: '', efforts },
  ]);
  assert.deepEqual(agentCli.parseGrokModels('Not authenticated'), []);
  assert.deepEqual(agentCli.parseGrokModels(null), []);
});

test('Grok 인자: 새 세션 -s · 이어받기 -r, 모델·노력은 안전한 값만 (자동은 생략)', () => {
  const base = { file: 'p.txt', cwd: 'C:\\내 폴더', sessionId: 'sid' };
  const a = collab.grokChatArgs({ ...base, resume: false, model: 'grok-4.7', effort: 'high' });
  assert.deepEqual(a, ['--prompt-file', 'p.txt', '--output-format', 'streaming-json', '--no-auto-update', '--always-approve', '--cwd', 'C:\\내 폴더', '-s', 'sid', '-m', 'grok-4.7', '--effort', 'high']);
  const b = collab.grokChatArgs({ ...base, resume: true, model: 'auto', effort: 'auto' });
  assert.deepEqual(b.slice(-2), ['-r', 'sid']); assert.ok(!b.includes('-m') && !b.includes('--effort'));
  const c = collab.grokChatArgs({ ...base, resume: true, model: 'a b;c', effort: 'max' });
  assert.ok(!c.includes('-m') && !c.includes('--effort'), '안전하지 않은 모델·단계는 넣지 않는다');
  const d = collab.grokChatArgs({ ...base, resume: true });
  assert.deepEqual(d.slice(-2), ['-r', 'sid']);
});

// 가짜 spawn: 띄울 때 프롬프트 파일 내용을 읽어 둔다 (실제 프로세스는 만들지 않는다).
function fakeSpawn() {
  const calls = [];
  const spawn = (file, args, opts) => {
    const p = new EventEmitter();
    p.pid = 200 + calls.length;
    p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    p.out = (obj) => p.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));
    const promptFile = args[args.indexOf('--prompt-file') + 1];
    calls.push({ file, args, opts, p, promptFile, prompt: fs.existsSync(promptFile) ? fs.readFileSync(promptFile) : null });
    return p;
  };
  return { spawn, calls };
}

function setup(t, extra = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-grok-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const { spawn, calls } = fakeSpawn(); const events = []; const killed = [];
  const chat = new collab.GrokChat({
    loc: { file: 'grok.exe', prefixArgs: [] }, cwd: 'C:\\w', systemPrompt: '규칙 문장', env: {}, tmpDir, spawn,
    kill: (p) => killed.push(p.pid), onEvent: (e) => events.push(e), ...extra,
  });
  return { chat, calls, events, killed, tmpDir, files: () => fs.readdirSync(tmpDir) };
}

test('협업 Grok: 생성자는 프로세스를 띄우지 않고, 첫 턴은 -s + 규칙 포함 프롬프트 파일(BOM 없음), 끝나면 파일을 지운다', (t) => {
  const { chat, calls, events, files } = setup(t);
  assert.equal(calls.length, 0); assert.equal(chat.busy, false); assert.equal(chat.proc, null);
  chat.send('첫 질문 "따옴표" 100%', { model: 'auto', effort: 'auto' }, 7);
  assert.equal(calls.length, 1); assert.equal(chat.busy, true); assert.equal(chat.proc, calls[0].p);
  const { args, prompt, promptFile } = calls[0];
  assert.equal(prompt.toString('utf8'), '규칙 문장\n\n첫 질문 "따옴표" 100%');
  assert.notDeepEqual([...prompt.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM 없음');
  assert.ok(path.basename(promptFile).startsWith(`ao-grok-${process.pid}-`) && promptFile.endsWith('.txt'));
  assert.deepEqual(args.slice(args.indexOf('-s'), args.indexOf('-s') + 2), ['-s', chat.sessionId]);
  assert.ok(!args.includes('-r') && !args.includes('-m') && !args.includes('--effort'));
  assert.deepEqual(args.slice(args.indexOf('--cwd'), args.indexOf('--cwd') + 2), ['--cwd', 'C:\\w']);
  assert.deepEqual(calls[0].opts.stdio, ['ignore', 'pipe', 'pipe'], '표준 입력을 열어 두지 않는다');
  assert.equal(files().length, 1, '실행 중에는 프롬프트 파일이 있다');
  const p = calls[0].p;
  p.out(LINES.commands); p.out(LINES.thought); p.out(LINES.text); p.out(LINES.bash); p.out(LINES.update); p.out(LINES.usage);
  assert.equal(chat.busy, true, 'end 줄만으로는 끝나지 않고 프로세스 종료를 기다린다');
  p.out(LINES.end);
  assert.equal(events.at(-1).type, 'tool', 'end 는 내보내지 않는다');
  p.emit('close', 0);
  assert.deepEqual(events.map((e) => e.type), ['session', 'text', 'tool', 'done']);
  assert.deepEqual(events[0], { type: 'session', sessionId: chat.sessionId, turn: 7 });
  assert.deepEqual(events.at(-1), { type: 'done', ok: true, turn: 7 });
  assert.ok(events.every((e) => e.turn === 7), '모든 이벤트에 턴 번호');
  assert.equal(chat.busy, false); assert.deepEqual(files(), [], '프롬프트 파일 삭제');
  assert.equal(chat.started, true);
});

test('협업 Grok: 두 번째 턴은 -r 로 이어 가며 규칙을 다시 붙이지 않고, session 은 한 번만 알린다', (t) => {
  const { chat, calls, events, files } = setup(t);
  chat.send('하나', { model: 'grok-4.7', effort: 'xhigh' });
  calls[0].p.out(LINES.end); calls[0].p.emit('close', 0);
  chat.send('둘', { model: 'grok-4.7', effort: 'xhigh' });
  assert.equal(calls.length, 2);
  const a = calls[1].args;
  assert.deepEqual(a.slice(a.indexOf('-r'), a.indexOf('-r') + 2), ['-r', chat.sessionId]);
  assert.ok(!a.includes('-s'));
  assert.deepEqual(a.slice(a.indexOf('-m'), a.indexOf('-m') + 2), ['-m', 'grok-4.7']);
  assert.deepEqual(a.slice(a.indexOf('--effort'), a.indexOf('--effort') + 2), ['--effort', 'xhigh']);
  assert.equal(calls[1].prompt.toString('utf8'), '둘');
  assert.notEqual(calls[0].promptFile, calls[1].promptFile);
  calls[1].p.out(LINES.end); calls[1].p.emit('close', 0);
  assert.equal(events.filter((e) => e.type === 'session').length, 1);
  assert.deepEqual(events.filter((e) => e.type === 'done'), [{ type: 'done', ok: true }, { type: 'done', ok: true }]);
  assert.deepEqual(files(), []);
});

test('협업 Grok: 진행 중에 보낸 send 는 무시하고 steer 는 지원하지 않는다', (t) => {
  const { chat, calls } = setup(t);
  chat.send('하나', {});
  chat.send('둘', {});
  assert.equal(calls.length, 1);
  assert.equal(chat.steer('끼어들기', 1), false);
});

test('협업 Grok: 오류 줄만 오고 끝나면 오류 문구로 실패하고, 같은 세션 ID 를 다시 쓰지 않으며 규칙을 다시 붙인다', (t) => {
  const { chat, calls, events, files } = setup(t);
  const first = chat.sessionId;
  chat.send('하나', {});
  calls[0].p.out(LINES.error);
  calls[0].p.emit('close', 1);
  assert.deepEqual(events.map((e) => e.type), ['session', 'notice', 'done']);
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, error: 'Not signed in. Run grok login.' });
  assert.equal(chat.started, false); assert.deepEqual(files(), []);
  assert.notEqual(chat.sessionId, first);
  chat.send('다시', {});
  assert.ok(calls[1].args.includes('-s') && calls[1].args.includes(chat.sessionId) && !calls[1].args.includes('-r'));
  assert.equal(calls[1].prompt.toString('utf8'), '규칙 문장\n\n다시');
});

test('협업 Grok: 아무 출력 없이 끝나면 stderr 마지막 줄, 그것도 없으면 기본 문구로 실패한다', (t) => {
  const { chat, calls, events } = setup(t);
  chat.send('하나', {});
  calls[0].p.stderr.emit('data', Buffer.from('warn\nboom: 실행 실패\n'));
  calls[0].p.emit('close', 3);
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, error: 'boom: 실행 실패' });
  chat.send('둘', {});
  calls[1].p.emit('close', 0);
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, error: 'Grok 이 응답 없이 끝났습니다' });
});

test('협업 Grok: 실행 실패(error 이벤트)와 spawn 예외도 실패로 끝내고 파일을 남기지 않는다', (t) => {
  const { chat, calls, events, files } = setup(t);
  chat.send('하나', {});
  calls[0].p.emit('error', new Error('ENOENT'));
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, error: 'Grok 을 실행하지 못했습니다: ENOENT' });
  assert.equal(chat.busy, false); assert.deepEqual(files(), []);
  const bad = setup(t, { spawn: () => { throw new Error('spawn 불가'); } });
  bad.chat.send('둘', {}, 3);
  assert.deepEqual(bad.events, [{ type: 'done', ok: false, error: 'Grok 을 실행하지 못했습니다: spawn 불가', turn: 3 }]);
  assert.equal(bad.chat.busy, false); assert.deepEqual(bad.files(), []);
});

test('협업 Grok: exit 가 close 보다 먼저 와도 마지막 출력(end)까지 읽은 뒤 한 번만 끝낸다', async (t) => {
  const { chat, calls, events, files } = setup(t);
  chat.send('하나', {});
  const p = calls[0].p;
  p.emit('exit', 0);
  p.out(LINES.text); p.out(LINES.end); // exit 뒤에 도착한 남은 출력
  p.emit('close', 0);
  assert.deepEqual(events.map((e) => e.type), ['session', 'text', 'done']);
  assert.equal(events.at(-1).ok, true);
  await new Promise((r) => setTimeout(r, 400)); // 예비 타이머가 돌아도 두 번 끝내지 않는다
  assert.equal(events.filter((e) => e.type === 'done').length, 1);
  assert.deepEqual(files(), []);
  // close 가 끝내 오지 않아도 exit 뒤 잠시 기다렸다가 끝낸다
  chat.send('둘', {});
  calls[1].p.out(LINES.end); calls[1].p.emit('exit', 0);
  assert.equal(chat.busy, true);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(chat.busy, false); assert.deepEqual(events.at(-1), { type: 'done', ok: true });
  assert.deepEqual(files(), []);
});

test('협업 Grok: 중단하면 프로세스를 끝내고 바로 「중단됨」으로 끝내며, 늦은 출력·종료는 무시하고 파일은 프로세스가 끝나면 지운다', (t) => {
  const { chat, calls, events, killed, files } = setup(t);
  chat.send('작업', {}, 2);
  calls[0].p.out(LINES.text);
  chat.stop();
  assert.deepEqual(killed, [calls[0].p.pid]);
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, stopped: true, turn: 2 });
  assert.equal(chat.busy, false); assert.equal(chat.started, false);
  const before = events.length;
  calls[0].p.out(LINES.text); calls[0].p.out(LINES.end); calls[0].p.emit('close', 1);
  assert.equal(events.length, before, '옛 프로세스의 늦은 출력·종료는 무시');
  assert.deepEqual(files(), []);
  chat.stop(); // 이미 끝났으면 아무 일도 없다
  assert.equal(events.length, before);
  chat.send('다음', {});
  assert.equal(calls.length, 2);
  assert.equal(calls[1].prompt.toString('utf8'), '규칙 문장\n\n다음');
});

test('협업 Grok: 닫으면 프로세스를 끝내고 이벤트 없이 파일을 지우며, 이후 send 는 무시한다', (t) => {
  const { chat, calls, events, killed, files } = setup(t);
  chat.send('작업', {});
  chat.close();
  assert.deepEqual(killed, [calls[0].p.pid]);
  calls[0].p.out(LINES.text); calls[0].p.emit('close', 1);
  assert.deepEqual(events.map((e) => e.type), ['session'], '닫은 뒤에는 done 도 내지 않는다');
  assert.deepEqual(files(), []);
  chat.send('또', {});
  assert.equal(calls.length, 1);
  chat.close(); // 두 번 닫아도 안전
});

test('협업 Grok: 한글이 바이트 중간에서 끊겨 와도 이어 붙여 읽는다', (t) => {
  const { chat, calls, events } = setup(t);
  chat.send('하나', {});
  const bytes = Buffer.from(JSON.stringify(LINES.text) + '\n');
  calls[0].p.stdout.emit('data', bytes.subarray(0, 25));
  calls[0].p.stdout.emit('data', bytes.subarray(25));
  assert.deepEqual(events.find((e) => e.type === 'text'), { type: 'text', text: '안녕하세요' });
});

test('Grok 인자: 모델 이름 첫 글자는 영숫자만 (-로 시작하면 옵션으로 읽힐 수 있다)', () => {
  const base = { file: 'p.txt', cwd: 'C:\\w', sessionId: 'sid', resume: true };
  assert.ok(!collab.grokChatArgs({ ...base, model: '-x' }).includes('-m'));
  assert.ok(!collab.grokChatArgs({ ...base, model: '.hidden' }).includes('-m'));
  assert.ok(!collab.grokChatArgs({ ...base, model: 'a'.repeat(81) }).includes('-m'));
  assert.ok(collab.grokChatArgs({ ...base, model: 'a'.repeat(80) }).includes('-m'));
  assert.ok(collab.grokChatArgs({ ...base, model: 'grok-4.7' }).includes('-m'));
  assert.deepEqual(agentCli.parseGrokModels('  - -bad\n  - ok-1\n').map((m) => m.value), ['ok-1'], '목록 해석도 같은 규칙');
});

test('협업 Grok: 첫 턴이 실패하면 다음 send 가 새 세션 ID 로 session 을 다시 알린다', (t) => {
  const { chat, calls, events } = setup(t);
  const first = chat.sessionId;
  chat.send('하나', {});
  calls[0].p.emit('close', 1); // 응답 없이 실패
  assert.notEqual(chat.sessionId, first);
  chat.send('둘', {});
  const sessions = events.filter((e) => e.type === 'session');
  assert.deepEqual(sessions.map((e) => e.sessionId), [first, chat.sessionId]);
  assert.ok(calls[1].args.includes(chat.sessionId));
  // 정상으로 끝난 뒤에는 같은 ID 라 다시 알리지 않는다
  calls[1].p.out(LINES.end); calls[1].p.emit('close', 0);
  chat.send('셋', {});
  assert.equal(events.filter((e) => e.type === 'session').length, 2);
});

test('협업 Grok: 첫 턴을 중단해도 새 세션 ID 를 만들고 session 을 다시 알린다 (끝난 뒤에는 유지)', (t) => {
  const { chat, calls, events } = setup(t);
  const first = chat.sessionId;
  chat.send('하나', {});
  chat.stop();
  assert.notEqual(chat.sessionId, first, '중단된 첫 턴의 ID 는 버린다');
  chat.send('둘', {});
  assert.deepEqual(events.filter((e) => e.type === 'session').map((e) => e.sessionId), [first, chat.sessionId]);
  calls[1].p.out(LINES.end); calls[1].p.emit('close', 0);
  const kept = chat.sessionId;
  chat.send('셋', {});
  chat.stop(); // 첫 턴이 끝난 뒤의 중단은 같은 세션을 이어 간다
  assert.equal(chat.sessionId, kept);
  chat.send('넷', {});
  assert.ok(calls[3].args.includes('-r') && calls[3].args.includes(kept));
});

test('협업 Grok: end 줄을 받은 뒤 프로세스가 3초 안에 끝나지 않으면 정상으로 끝내고 프로세스를 죽인다', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { chat, calls, events, killed, files } = setup(t);
  chat.send('하나', {}, 4);
  const p = calls[0].p;
  p.out(LINES.text); p.out(LINES.end);
  t.mock.timers.tick(2999);
  assert.equal(chat.busy, true); assert.deepEqual(killed, []);
  t.mock.timers.tick(1);
  assert.deepEqual(killed, [p.pid]);
  assert.deepEqual(events.at(-1), { type: 'done', ok: true, turn: 4 });
  assert.equal(chat.busy, false); assert.equal(chat.started, true);
  assert.deepEqual(files(), [], '프롬프트 파일도 지운다');
  p.emit('close', 0); // 뒤늦은 종료는 두 번째 done 을 내지 않는다
  assert.equal(events.filter((e) => e.type === 'done').length, 1);
});

test('협업 Grok: 유예 안에 프로세스가 끝나면 타이머는 아무것도 하지 않는다 (지연은 endGraceMs 로 바꿀 수 있다)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { chat, calls, events, killed } = setup(t, { endGraceMs: 50 });
  chat.send('하나', {});
  calls[0].p.out(LINES.end);
  calls[0].p.emit('close', 0);
  t.mock.timers.tick(5000);
  assert.deepEqual(killed, []);
  assert.equal(events.filter((e) => e.type === 'done').length, 1);
  chat.send('둘', {});
  calls[1].p.out(LINES.end);
  t.mock.timers.tick(50);
  assert.deepEqual(killed, [calls[1].p.pid]);
  assert.deepEqual(events.at(-1), { type: 'done', ok: true });
});

test('협업 Grok: 중단·닫기는 end 유예 타이머를 지운다', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = setup(t);
  a.chat.send('하나', {});
  a.calls[0].p.out(LINES.end);
  a.chat.stop();
  const doneCount = a.events.filter((e) => e.type === 'done').length;
  t.mock.timers.tick(5000);
  assert.equal(a.events.filter((e) => e.type === 'done').length, doneCount);
  assert.equal(a.killed.length, 1, '중단 때 한 번만 죽인다');
  const b = setup(t);
  b.chat.send('하나', {});
  b.calls[0].p.out(LINES.end);
  b.chat.close();
  t.mock.timers.tick(5000);
  assert.equal(b.killed.length, 1);
  assert.deepEqual(b.events.map((e) => e.type), ['session']);
});

test('협업 Grok: 프롬프트 파일은 wx 로 써서 이미 있는 파일을 덮어쓰지도 지우지도 않는다', (t) => {
  const { chat, calls, events, tmpDir, files } = setup(t);
  chat.send('하나', {});
  const m = path.basename(calls[0].promptFile).match(/^ao-grok-(\d+)-(\d+)\.txt$/);
  calls[0].p.out(LINES.end); calls[0].p.emit('close', 0);
  const taken = path.join(tmpDir, `ao-grok-${m[1]}-${Number(m[2]) + 1}.txt`); // 다음 send 가 쓸 이름을 미리 차지한다
  fs.writeFileSync(taken, '남의 내용');
  chat.send('둘', {}, 5);
  assert.equal(calls.length, 1, '프로세스를 띄우지 않는다');
  const done = events.at(-1);
  assert.equal(done.type, 'done'); assert.equal(done.ok, false); assert.equal(done.turn, 5);
  assert.match(done.error, /EEXIST/);
  assert.equal(fs.readFileSync(taken, 'utf8'), '남의 내용', '덮어쓰지 않았다');
  assert.deepEqual(files(), [path.basename(taken)], '지우지도 않았다');
  assert.equal(chat.busy, false);
});

test('앱 시작 정리: 이 앱의 프롬프트 파일 이름 규칙이고 1시간 넘은 것만 지운다', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-grok-clean-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  const make = (name, ageMs) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, 'x');
    const at = new Date(now - ageMs);
    fs.utimesSync(f, at, at);
  };
  make('ao-grok-123-1.txt', 2 * 3600000); // 오래됨 → 삭제
  make('ao-grok-123-2.txt', 3600000 + 5000); // 1시간 조금 넘음 → 삭제
  make('ao-grok-123-3.txt', 60000); // 최근 → 유지
  make('ao-grok-notes.txt', 2 * 3600000); // 이름 규칙 밖 → 유지
  make('other-123-1.txt', 2 * 3600000); // 남의 파일 → 유지
  fs.mkdirSync(path.join(dir, 'ao-grok-9-9.txt')); // 폴더는 건드리지 않는다
  assert.equal(collab.cleanStalePromptFiles({ tmpDir: dir, now }), 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['ao-grok-123-3.txt', 'ao-grok-9-9.txt', 'ao-grok-notes.txt', 'other-123-1.txt']);
  assert.equal(collab.cleanStalePromptFiles({ tmpDir: path.join(dir, '없는 폴더'), now }), 0, '폴더가 없어도 조용히 넘어간다');
});

test('협업 Grok: end 줄을 받은 뒤 유예 중 중단돼도 첫 턴은 이미 성공이라 세션 ID 를 유지하고 -r 로 이어 간다', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { chat, calls, events } = setup(t);
  const first = chat.sessionId;
  chat.send('하나', {});
  calls[0].p.out(LINES.end);
  chat.stop();
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, stopped: true });
  assert.equal(chat.started, true); assert.equal(chat.sessionId, first);
  chat.send('둘', {});
  assert.ok(calls[1].args.includes('-r') && calls[1].args.includes(first) && !calls[1].args.includes('-s'));
  assert.equal(calls[1].prompt.toString('utf8'), '둘', '규칙은 이미 전달됐다');
  assert.equal(events.filter((e) => e.type === 'session').length, 1, 'session 을 다시 알리지 않는다');
});

test('협업 Grok: 영어에서는 실행 실패·무응답 문구가 영어로 나온다', (t) => {
  setLang('en');
  try {
    const { chat, calls, events } = setup(t);
    chat.send('하나', {});
    calls[0].p.emit('error', new Error('ENOENT'));
    assert.deepEqual(events.at(-1), { type: 'done', ok: false, error: 'Could not run Grok: ENOENT' });
    const b = setup(t);
    b.chat.send('둘', {});
    b.calls[0].p.emit('close', 0);
    assert.deepEqual(b.events.at(-1), { type: 'done', ok: false, error: 'Grok ended without replying' });
  } finally { setLang('ko'); }
});
