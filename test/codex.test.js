import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const codexCli = require('../src/main/codexCli.cjs');
const collab = require('../src/main/collabAgents.cjs');
const { toEvent } = require('../src/main/hookServer.cjs');

test('Codex hook 은 curl 로 앱 서버에 보내며, PowerShell·cmd 어디서든 해석되도록 인자를 따옴표로 감싼다', () => {
  const cmd = codexCli.hookCommand({ port: 47821, token: 'abc', tab: 't1' });
  assert.match(cmd, /^curl\.exe /);
  assert.ok(cmd.includes('--data-binary "@-"'), 'PowerShell 에서 @- 가 스플래팅으로 해석되지 않게');
  assert.ok(cmd.includes('--noproxy "*"'));
  assert.ok(cmd.includes('"http://127.0.0.1:47821/hook?k=abc&src=session&cli=codex&tab=t1"'));
  const args = codexCli.hookArgs({ port: 47821, token: 'abc', tab: 't1' });
  const events = args.filter((a, i) => args[i - 1] === '-c').map((a) => a.match(/^hooks\.(\w+)=/)[1]);
  assert.deepEqual(events, codexCli.HOOK_EVENTS);
  assert.ok(events.includes('SubagentStart') && events.includes('PermissionRequest') && events.includes('Stop'));
  assert.ok(args[1].includes(`command=${JSON.stringify(cmd)}`), 'TOML 문자열 안의 따옴표는 이스케이프');
});

test('Codex 탭은 앱 hook 을 주입하고, 그 hook 만 신뢰 검토 없이 실행한다', () => {
  const hooks = codexCli.hookArgs({ port: 1, token: 'k', tab: 't9' });
  const args = codexCli.tabArgs({ hooks });
  assert.deepEqual(args.slice(0, hooks.length), hooks);
  assert.ok(args.includes('--dangerously-bypass-hook-trust'));
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'), '탭은 기본 승인 모드로 시작');
});

test('협업용 Codex 실행 인자: 첫 턴은 새 세션, 이후는 같은 세션을 이어 가며 Bypass·모델·추론 단계를 지정', () => {
  const first = codexCli.execArgs({ model: 'gpt-6.1-sol', effort: 'high', hooks: ['-c', 'x'] });
  assert.equal(first[0], 'exec'); assert.notEqual(first[1], 'resume');
  assert.ok(first.includes('--json') && first.includes('--dangerously-bypass-approvals-and-sandbox') && first.includes('--skip-git-repo-check'));
  assert.deepEqual(first.slice(first.indexOf('-m'), first.indexOf('-m') + 2), ['-m', 'gpt-6.1-sol']);
  assert.ok(first.includes('model_reasoning_effort="high"'));
  assert.equal(first.at(-1), '-', '프롬프트는 표준 입력으로 (긴 한글·따옴표 안전)');
  const next = codexCli.execArgs({ resumeId: '01a18070-6827-7c63-b528-860f52987e0a', model: 'gpt-6-astra', effort: 'xhigh', hooks: [] });
  assert.deepEqual(next.slice(0, 3), ['exec', 'resume', '01a18070-6827-7c63-b528-860f52987e0a']);
  assert.ok(next.includes('model_reasoning_effort="xhigh"'));
  assert.throws(() => codexCli.execArgs({ resumeId: '../x', model: 'm', effort: 'high' }));
  assert.throws(() => codexCli.execArgs({ model: 'gpt;rm', effort: 'high' }));
  assert.ok(codexCli.execArgs({ model: 'gpt-6.1-sol', effort: 'ultra' }).includes('model_reasoning_effort="ultra"'), 'Codex 가 알려 준 단계는 모두 쓸 수 있다');
  assert.ok(!codexCli.execArgs({ model: 'gpt-6.1-sol', effort: null }).some((a) => a.startsWith('model_reasoning_effort')), '단계가 없으면 Codex 기본값');
  assert.throws(() => codexCli.execArgs({ model: 'gpt-6.1-sol', effort: 'x"; rm' }));
});

test('Codex 모델 목록: debug models 출력에서 목록에 보이는 모델과 지원 추론 단계를 꺼낸다', () => {
  const list = codexCli.parseModels({ models: [
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', description: '기본', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'xhigh' }, { effort: 'ultra' }] },
    { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', supported_reasoning_levels: [{ effort: 'high' }] },
    { slug: 'bad slug', display_name: 'x', visibility: 'list', supported_reasoning_levels: [] },
  ] });
  assert.deepEqual(list, [{ value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', description: '기본', efforts: ['low', 'xhigh', 'ultra'] }]);
  assert.deepEqual(codexCli.parseModels(null), []);
});

test('Codex 위치: npm 설치본(codex.cmd)은 cmd.exe 를 거치지 않고 패키지 안의 실제 codex.exe 를 쓴다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-codex-npm-'));
  const cmd = path.join(dir, 'codex.cmd'); fs.writeFileSync(cmd, '@node "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*');
  const vendored = path.join(dir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe');
  fs.mkdirSync(path.dirname(vendored), { recursive: true }); fs.writeFileSync(vendored, '');
  assert.equal(codexCli.pickCodex([cmd], path.join(dir, 'none')).file, vendored);
  assert.equal(codexCli.pickCodex([cmd], path.join(dir, 'none')).cmdShim, undefined, '따옴표가 지워지는 cmd.exe 경유는 쓰지 않는다');
  fs.rmSync(path.join(dir, 'node_modules'), { recursive: true });
  assert.equal(codexCli.pickCodex([cmd], path.join(dir, 'none')), null);
});

test('출력 줄 읽기: 한글이 조각 경계에서 잘려 와도 깨지지 않는다', () => {
  const got = []; const read = collab.lineReader((j) => got.push(j));
  const bytes = Buffer.from(JSON.stringify({ text: '협업 대화 [완료]' }) + '\n');
  const cut = bytes.indexOf(Buffer.from('업')) + 1; // 3바이트 글자 한가운데
  read(bytes.subarray(0, cut)); read(bytes.subarray(cut));
  assert.deepEqual(got, [{ text: '협업 대화 [완료]' }]);
});

test('Codex 위치: PATH 의 exe 우선, 없으면 데스크톱 앱에 포함된 최신 codex.exe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-codex-'));
  const old = path.join(dir, 'OpenAI', 'Codex', 'bin', 'aaa'); const fresh = path.join(dir, 'OpenAI', 'Codex', 'bin', 'bbb');
  fs.mkdirSync(old, { recursive: true }); fs.mkdirSync(fresh, { recursive: true });
  fs.writeFileSync(path.join(old, 'codex.exe'), ''); fs.writeFileSync(path.join(fresh, 'codex.exe'), '');
  fs.utimesSync(path.join(old, 'codex.exe'), new Date(2020, 1, 1), new Date(2020, 1, 1));
  assert.equal(codexCli.bundledCodex(dir), path.join(fresh, 'codex.exe'));
  assert.equal(codexCli.pickCodex([], dir).file, path.join(fresh, 'codex.exe'));
  const onPath = path.join(dir, 'codex.exe'); fs.writeFileSync(onPath, '');
  assert.equal(codexCli.pickCodex([onPath], dir).file, onPath);
  assert.equal(codexCli.pickCodex([], path.join(dir, 'none')), null);
});

test('Codex 의 apply_patch 는 패치 본문에서 파일 이름을 찾아 「수정 중」으로 보여 준다', async () => {
  const { toolPhrase, activitySummary, toolPose } = await import('../src/renderer/office/phrases.js');
  const command = '*** Begin Patch\n*** Update File: src/app.js\n@@\n-a\n+b\n*** End Patch';
  assert.equal(toolPhrase('apply_patch', { command }), '⌨ 수정 중: app.js');
  assert.equal(activitySummary('apply_patch', { command }), 'app.js 수정 중');
  assert.equal(toolPhrase('apply_patch', { file_path: 'C:\\p\\b.js' }), '⌨ 수정 중: b.js');
  assert.equal(toolPose('apply_patch'), 'type');
});

test('hook 서버: Codex 는 탭·CLI 종류를 주소로 알린다', () => {
  const ev = toEvent({ hook_event_name: 'Stop', session_id: 's' }, {}, 'session', 1, { tab: 't1', cli: 'codex' });
  assert.equal(ev._tab, 't1'); assert.equal(ev._cli, 'codex');
  const claude = toEvent({ hook_event_name: 'Stop', session_id: 's' }, { 'x-office-tab': 't2' }, 'session', 1, {});
  assert.equal(claude._tab, 't2'); assert.equal(claude._cli, 'claude');
  assert.equal(toEvent({ hook_event_name: 'Stop' }, {}, null, 1, { tab: '<bad>' })._tab, null);
});

test('협업용 Claude 실행 인자: 화면 없는 실시간 대화 · Bypass · 모델/노력 · 세션 이어 가기', () => {
  const a = collab.claudeChatArgs({ settingsPath: 's.json', sessionId: 'id1', resume: false, model: 'opus', effort: 'high', systemPrompt: '규칙' });
  for (const f of ['-p', '--verbose', '--include-partial-messages', '--dangerously-skip-permissions']) assert.ok(a.includes(f), f);
  assert.deepEqual(a.slice(a.indexOf('--input-format'), a.indexOf('--input-format') + 2), ['--input-format', 'stream-json']);
  assert.deepEqual(a.slice(a.indexOf('--model'), a.indexOf('--model') + 2), ['--model', 'opus']);
  assert.deepEqual(a.slice(a.indexOf('--effort'), a.indexOf('--effort') + 2), ['--effort', 'high']);
  assert.deepEqual(a.slice(a.indexOf('--session-id'), a.indexOf('--session-id') + 2), ['--session-id', 'id1']);
  const b = collab.claudeChatArgs({ settingsPath: 's.json', sessionId: 'id1', resume: true, model: 'fable', effort: 'xhigh', systemPrompt: '규칙' });
  assert.deepEqual(b.slice(b.indexOf('--resume'), b.indexOf('--resume') + 2), ['--resume', 'id1']);
  assert.ok(!b.includes('--session-id'));
  const c = collab.claudeChatArgs({ settingsPath: 's', sessionId: 'i', model: 'opus', effort: 'max' });
  assert.deepEqual(c.slice(c.indexOf('--effort'), c.indexOf('--effort') + 2), ['--effort', 'max'], 'Claude 가 알려 준 단계는 모두 쓸 수 있다');
  assert.ok(!collab.claudeChatArgs({ settingsPath: 's', sessionId: 'i', model: 'claude-haiku-4-5-20251001', effort: null }).includes('--effort'), '노력 단계가 없는 모델');
  assert.throws(() => collab.claudeChatArgs({ settingsPath: 's', sessionId: 'i', model: 'opus', effort: 'max --x' }));
});

test('Claude 모델 목록: 시작 응답의 모델과 모델별 노력 단계를 꺼낸다 (기본값 항목은 뺀다)', () => {
  const list = collab.parseClaudeModels([
    { value: 'default', displayName: 'Default (recommended)', supportsEffort: true, supportedEffortLevels: ['high'] },
    { value: 'opus', displayName: 'Opus 5.5', description: '복잡한 작업', supportsEffort: true, supportedEffortLevels: ['low', 'high', 'xhigh', 'max'] },
    { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: '빠름' },
    { value: 'bad value', displayName: 'x' },
  ]);
  assert.deepEqual(list, [
    { value: 'opus', label: 'Opus 5.5', description: '복잡한 작업', efforts: ['low', 'high', 'xhigh', 'max'] },
    { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', description: '빠름', efforts: [] },
  ]);
  assert.deepEqual(collab.parseClaudeModels(undefined), []);
});

test('Claude 모델 목록 조회: hook 없이 띄워 시작 요청만 보내고, 응답을 받으면 바로 끝낸다', async () => {
  const { spawn, calls } = fakeSpawn(); const killed = [];
  const got = collab.claudeModels({ loc: { file: 'claude.exe', prefixArgs: [] }, settingsPath: 'no-hooks.json', cwd: 'C:\\u', env: {}, spawn, kill: (p) => killed.push(p.pid) });
  const { args, p } = calls[0];
  assert.deepEqual(args.slice(args.indexOf('--settings'), args.indexOf('--settings') + 2), ['--settings', 'no-hooks.json']);
  assert.ok(args.includes('--no-session-persistence'));
  const req = JSON.parse(p.written[0]);
  assert.equal(req.type, 'control_request'); assert.equal(req.request.subtype, 'initialize');
  p.out({ type: 'system', subtype: 'hook_started' });
  p.out({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: { models: [{ value: 'fable', displayName: 'Fable 5.1', supportsEffort: true, supportedEffortLevels: ['high'] }] } } });
  assert.deepEqual(await got, [{ value: 'fable', label: 'Fable 5.1', description: '', efforts: ['high'] }]);
  assert.deepEqual(killed, [p.pid]);
  // 응답 없이 끝나면 목록 없음 (화면은 기본 선택지를 쓴다)
  const reasons = [];
  const fail = collab.claudeModels({ loc: { file: 'claude.exe', prefixArgs: [] }, settingsPath: 's', cwd: 'C:\\u', env: {}, spawn, kill: () => {}, onError: (r) => reasons.push(r) });
  calls[1].p.stderr.emit('data', 'not logged in\n');
  calls[1].p.emit('exit', 1);
  assert.equal(await fail, null);
  assert.deepEqual(reasons, ['응답 전에 종료 (코드 1): not logged in'], '실패 이유를 화면에 알릴 수 있게');
});

test('Claude 스트림 해석: 세션·실시간 글자·도구·턴 종료', () => {
  assert.deepEqual(collab.parseClaudeLine({ type: 'system', subtype: 'init', session_id: 'sid', model: 'claude-fable-5-1' }), [{ type: 'session', sessionId: 'sid', model: 'claude-fable-5-1' }]);
  assert.deepEqual(collab.parseClaudeLine({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '안' } } }), [{ type: 'text', text: '안' }]);
  assert.deepEqual(collab.parseClaudeLine({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }, { type: 'tool_use', name: 'Edit', input: { file_path: 'a.js', old_string: 'big' } }] } }),
    [{ type: 'tool', name: 'Edit', input: { file_path: 'a.js' } }]);
  assert.deepEqual(collab.parseClaudeLine({ type: 'result', subtype: 'success', result: '끝' }), [{ type: 'done', ok: true }]);
  assert.deepEqual(collab.parseClaudeLine({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '실패' }), [{ type: 'done', ok: false, error: '실패' }]);
  assert.deepEqual(collab.parseClaudeLine({ type: 'system', subtype: 'hook_started' }), []);
  // 새 글 블록은 문단을 나눠 [질문]·[완료] 줄이 앞 문장에 붙지 않게 한다
  assert.deepEqual(collab.parseClaudeLine({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } }), [{ type: 'text', text: '', block: true }]);
  // 하위 에이전트의 글은 대화창에 섞지 않는다
  assert.deepEqual(collab.parseClaudeLine({ type: 'stream_event', parent_tool_use_id: 'tu1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '하위' } } }), []);
  assert.deepEqual(collab.parseClaudeLine({ type: 'assistant', parent_tool_use_id: 'tu1', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } }), []);
});

test('Codex 이벤트 해석: 세션·답변·명령·파일 수정·안내 경고 거르기·턴 종료', () => {
  assert.deepEqual(collab.parseCodexLine({ type: 'thread.started', thread_id: 't' }), [{ type: 'session', sessionId: 't' }]);
  assert.deepEqual(collab.parseCodexLine({ type: 'item.completed', item: { type: 'agent_message', text: '안녕' } }), [{ type: 'text', text: '안녕', block: true }]);
  assert.deepEqual(collab.parseCodexLine({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } }), [{ type: 'tool', name: 'Bash', input: { command: 'ls' } }]);
  assert.deepEqual(collab.parseCodexLine({ type: 'item.completed', item: { type: 'command_execution', command: 'ls' } }), []);
  assert.deepEqual(collab.parseCodexLine({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'C:\\p\\a.js', kind: 'update' }] } }), [{ type: 'tool', name: 'apply_patch', input: { file_path: 'C:\\p\\a.js' } }]);
  assert.deepEqual(collab.parseCodexLine({ type: 'item.completed', item: { type: 'error', message: 'Under-development features enabled: x' } }), []);
  assert.deepEqual(collab.parseCodexLine({ type: 'item.completed', item: { type: 'error', message: 'This session was recorded with model `a` but is resuming with `b`.' } }), []);
  assert.deepEqual(collab.parseCodexLine({ type: 'item.completed', item: { type: 'error', message: '진짜 오류' } }), [{ type: 'notice', text: '진짜 오류' }]);
  assert.deepEqual(collab.parseCodexLine({ type: 'turn.completed', usage: {} }), [{ type: 'done', ok: true }]);
  assert.deepEqual(collab.parseCodexLine({ type: 'turn.failed', error: { message: '한도' } }), [{ type: 'done', ok: false, error: '한도' }]);
});

// 실제 프로세스 대신 가짜 spawn 으로 실행 순서만 검증한다.
function fakeSpawn() {
  const calls = [];
  const spawn = (file, args, opts) => {
    const p = new EventEmitter();
    p.pid = 100 + calls.length;
    p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    p.written = [];
    p.stdin = { write: (s) => p.written.push(s), end: (s) => { if (s) p.written.push(s); p.ended = true; } };
    p.out = (obj) => p.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));
    calls.push({ file, args, opts, p });
    return p;
  };
  return { spawn, calls };
}

test('협업 Claude: 한 프로세스에서 이어 말하고, 모델·노력이 바뀌면 같은 세션으로 다시 띄운다', () => {
  const { spawn, calls } = fakeSpawn(); const events = []; const killed = [];
  const agent = new collab.ClaudeChat({ loc: { file: 'claude.exe', prefixArgs: [] }, cwd: 'C:\\w', settingsPath: 's', systemPrompt: '규칙', env: {}, spawn, kill: (p) => { killed.push(p.pid); p.emit('exit', 1); }, onEvent: (e) => events.push(e) });
  agent.send('첫 질문', { model: 'opus', effort: 'high' });
  assert.equal(calls.length, 1); assert.ok(calls[0].args.includes('--session-id'));
  assert.equal(JSON.parse(calls[0].p.written[0]).message.content[0].text, '첫 질문');
  calls[0].p.out({ type: 'system', subtype: 'init', session_id: agent.sessionId });
  calls[0].p.out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '답' } } });
  calls[0].p.out({ type: 'result', subtype: 'success', result: '답' });
  assert.deepEqual(events.map((e) => e.type), ['session', 'text', 'done']);
  agent.send('두 번째', { model: 'opus', effort: 'high' });
  assert.equal(calls.length, 1, '같은 설정이면 프로세스 재사용'); assert.equal(calls[0].p.written.length, 2);
  calls[0].p.out({ type: 'result', subtype: 'success', result: '' });
  agent.send('어려운 질문', { model: 'fable', effort: 'xhigh' });
  assert.deepEqual(killed, [100]); assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args.slice(calls[1].args.indexOf('--resume'), calls[1].args.indexOf('--resume') + 2), ['--resume', agent.sessionId]);
  assert.ok(calls[1].args.includes('fable') && calls[1].args.includes('xhigh'));
});

test('협업 Claude: 중단하면 진행 중 턴을 「중단됨」으로 끝내고 다음 메시지는 이어서 보낸다', () => {
  const { spawn, calls } = fakeSpawn(); const events = [];
  const agent = new collab.ClaudeChat({ loc: { file: 'claude.exe', prefixArgs: [] }, cwd: 'C:\\w', settingsPath: 's', systemPrompt: '', env: {}, spawn, kill: (p) => p.emit('exit', 1), onEvent: (e) => events.push(e) });
  agent.send('작업', { model: 'opus', effort: 'high' });
  calls[0].p.out({ type: 'system', subtype: 'init', session_id: agent.sessionId });
  agent.stop();
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, stopped: true });
  agent.send('다시', { model: 'opus', effort: 'high' });
  assert.equal(calls.length, 2); assert.ok(calls[1].args.includes('--resume'));
});

test('협업 Claude: 중단 후 바로 다시 보내도, 끝내는 중인 옛 프로세스의 늦은 출력은 새 턴에 섞이지 않는다', () => {
  const { spawn, calls } = fakeSpawn(); const events = [];
  const agent = new collab.ClaudeChat({ loc: { file: 'claude.exe', prefixArgs: [] }, cwd: 'C:\\w', settingsPath: 's', systemPrompt: '', env: {}, spawn, kill: () => {}, onEvent: (e) => events.push(e) });
  agent.send('작업', { model: 'opus', effort: 'high' });
  calls[0].p.out({ type: 'system', subtype: 'init', session_id: agent.sessionId });
  agent.stop(); // kill 은 비동기 — 옛 프로세스가 아직 출력할 수 있다
  agent.send('다음', { model: 'opus', effort: 'high' });
  const before = events.length;
  calls[0].p.out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '늦은 글' } } });
  calls[0].p.out({ type: 'result', subtype: 'success', result: '' });
  calls[0].p.emit('exit', 1);
  assert.equal(events.length, before, '옛 프로세스의 출력·종료는 무시');
  calls[1].p.out({ type: 'result', subtype: 'success', result: '' });
  assert.deepEqual(events.at(-1), { type: 'done', ok: true });
});

test('협업 Claude: 첫 응답 전에 끝난 세션은 같은 ID 를 다시 쓰지 않고 새 ID 로 시작한다', () => {
  const { spawn, calls } = fakeSpawn();
  const agent = new collab.ClaudeChat({ loc: { file: 'claude.exe', prefixArgs: [] }, cwd: 'C:\\w', settingsPath: 's', systemPrompt: '', env: {}, spawn, kill: () => {}, onEvent: () => {} });
  agent.send('a', { model: 'opus', effort: 'high' });
  const first = agent.sessionId;
  agent.stop();
  agent.send('b', { model: 'opus', effort: 'high' });
  assert.notEqual(agent.sessionId, first);
  assert.ok(calls[1].args.includes('--session-id') && calls[1].args.includes(agent.sessionId));
});

test('협업 Codex: 중단한 실행의 늦은 출력·종료는 새 턴을 끝내지 않고, 새 턴 시작이 「중단됨」을 보내지 않는다', () => {
  const { spawn, calls } = fakeSpawn(); const events = [];
  const agent = new collab.CodexChat({ loc: { file: 'codex.exe', prefixArgs: [] }, cwd: 'C:\\w', systemPrompt: '', hooks: [], env: {}, spawn, kill: () => {}, onEvent: (e) => events.push(e) });
  agent.send('1', { model: 'gpt-6.1-sol', effort: 'high' });
  calls[0].p.out({ type: 'thread.started', thread_id: 'th1' });
  agent.stop();
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, stopped: true });
  agent.send('2', { model: 'gpt-6.1-sol', effort: 'high' });
  const before = events.length;
  calls[0].p.out({ type: 'item.completed', item: { type: 'agent_message', text: '늦은 답' } });
  calls[0].p.out({ type: 'turn.completed' });
  calls[0].p.emit('exit', 0);
  assert.equal(events.length, before);
  // 진행 중에 다시 send 해도 이전 실행은 조용히 정리된다
  agent.send('3', { model: 'gpt-6.1-sol', effort: 'high' });
  assert.equal(events.length, before, '새 턴 시작이 done 을 보내지 않는다');
  calls[2].p.out({ type: 'turn.completed' });
  assert.deepEqual(events.at(-1), { type: 'done', ok: true });
});

test('협업 종료: 턴이 끝났지만 아직 살아 있는 프로세스까지 모두 끝낸다', () => {
  const { spawn, calls } = fakeSpawn(); const killed = [];
  const agent = new collab.CodexChat({ loc: { file: 'codex.exe', prefixArgs: [] }, cwd: 'C:\\w', systemPrompt: '', hooks: [], env: {}, spawn, kill: (p) => killed.push(p.pid), onEvent: () => {} });
  agent.send('1', { model: 'gpt-6.1-sol', effort: 'high' });
  calls[0].p.out({ type: 'turn.completed' }); // hook 등으로 아직 종료 전
  agent.close();
  assert.deepEqual(killed, [calls[0].p.pid]);
});

test('협업 Codex: 턴마다 실행하고, 첫 턴에만 규칙을 붙이며 이후는 같은 세션을 이어 간다', () => {
  const { spawn, calls } = fakeSpawn(); const events = [];
  const agent = new collab.CodexChat({ loc: { file: 'codex.exe', prefixArgs: [] }, cwd: 'C:\\w', systemPrompt: '규칙', hooks: ['-c', 'h'], env: {}, spawn, kill: (p) => p.emit('exit', 1), onEvent: (e) => events.push(e) });
  agent.send('질문', { model: 'gpt-6.1-sol', effort: 'high' });
  assert.equal(calls[0].opts.cwd, 'C:\\w'); assert.ok(calls[0].p.ended);
  assert.ok(calls[0].p.written[0].startsWith('규칙') && calls[0].p.written[0].includes('질문'));
  calls[0].p.out({ type: 'thread.started', thread_id: 'th1' });
  calls[0].p.out({ type: 'item.completed', item: { type: 'agent_message', text: '답' } });
  calls[0].p.out({ type: 'turn.completed', usage: {} });
  calls[0].p.emit('exit', 0);
  assert.deepEqual(events.map((e) => e.type), ['session', 'text', 'done'], '종료 후 done 을 두 번 보내지 않는다');
  agent.send('다음', { model: 'gpt-6-astra', effort: 'xhigh' });
  assert.deepEqual(calls[1].args.slice(0, 3), ['exec', 'resume', 'th1']);
  assert.equal(calls[1].p.written[0], '다음');
  calls[1].p.emit('exit', 1);
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, error: 'Codex 가 응답 없이 종료되었습니다 (코드 1)' });
});
