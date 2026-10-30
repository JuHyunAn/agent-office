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

test('Codex hook: 권한 요청만 카드 승인을 오래 기다린다 (curl -m 595 · timeout=600), 나머지는 -m 2 · timeout=3', () => {
  const args = codexCli.hookArgs({ port: 47821, token: 'abc', tab: 't1' });
  const byEvent = Object.fromEntries(args.filter((a, i) => args[i - 1] === '-c').map((a) => [a.match(/^hooks\.(\w+)=/)[1], a]));
  assert.deepEqual(Object.keys(byEvent), codexCli.HOOK_EVENTS);
  for (const [ev, a] of Object.entries(byEvent)) {
    const slow = ev === 'PermissionRequest';
    assert.ok(a.includes(slow ? '-m 595 ' : '-m 2 '), `${ev}: curl 대기`);
    assert.ok(a.endsWith(slow ? 'timeout=600}]}]' : 'timeout=3}]}]'), `${ev}: hook timeout`);
    assert.ok(slow ? !a.includes('-m 2 ') : !a.includes('-m 595'), ev);
  }
  assert.ok(codexCli.hookCommand({ port: 1, token: 'k', tab: 't' }).includes(' -m 2 '), '기본 대기는 2초');
  assert.ok(codexCli.hookCommand({ port: 1, token: 'k', tab: 't', maxSec: 595 }).includes(' -m 595 '));
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
  const agent = new collab.CodexChat({ loc: { file: 'codex.exe', prefixArgs: [] }, cwd: 'C:\\w', systemPrompt: '', hooks: [], env: {}, spawn, kill: (p) => p.emit('exit', 1), onEvent: (e) => events.push(e) });
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

// 협업 Codex 의 진행 중 메시지(steer): 안전 지점에서 끊고, 옛 프로세스가 끝난 뒤 같은 세션으로 이어 답한다.
const CXCFG = { model: 'gpt-6.1-sol', effort: 'high' };
const cxSleep = (ms) => new Promise((r) => setTimeout(r, ms));
function codexAgent(extra = {}) {
  const { spawn, calls } = fakeSpawn(); const events = []; const killed = [];
  const agent = new collab.CodexChat({ loc: { file: 'codex.exe', prefixArgs: [] }, cwd: 'C:\\w', systemPrompt: '', hooks: [], env: {}, spawn, kill: (p) => killed.push(p.pid), onEvent: (e) => events.push(e), ...extra });
  return { agent, calls, events, killed };
}
const cmdItem = (type, id = 'i1') => ({ type, item: { id, type: 'command_execution', command: 'ls' } });
const countOf = (events, type) => events.filter((e) => e.type === type).length;
const WARN = { type: 'item.completed', item: { id: 'w0', type: 'error', message: 'Under-development features enabled' } };
// 첫 실행을 띄우고 세션을 만든 뒤 명령 하나를 시작한 상태 (0.165 실측 순서: thread.started → 시작 경고 → turn.started → item…)
function runningCodex(extra) {
  const t = codexAgent(extra);
  t.agent.send('질문', CXCFG, 3);
  t.calls[0].p.out({ type: 'thread.started', thread_id: 'th1' });
  t.calls[0].p.out(WARN);
  t.calls[0].p.out({ type: 'turn.started' });
  t.calls[0].p.out(cmdItem('item.started'));
  return t;
}

test('협업 Codex steer: 명령이 끝난 지점에서 끊고, 옛 프로세스 종료 뒤 같은 세션으로 안내+메시지를 보낸다', () => {
  const { agent, calls, events, killed } = runningCodex();
  assert.equal(agent.steer('추가', 3), true);
  assert.deepEqual(killed, [], '명령이 열려 있는 동안은 끊지 않는다');
  calls[0].p.out(cmdItem('item.completed'));
  assert.deepEqual(killed, [calls[0].p.pid]);
  assert.equal(calls.length, 1, '옛 프로세스가 끝나기 전에는 띄우지 않는다');
  calls[0].p.emit('exit', 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args.slice(0, 3), ['exec', 'resume', 'th1']);
  assert.ok(calls[1].p.written[0].startsWith('[진행 중 추가 메시지]') && calls[1].p.written[0].endsWith('\n\n추가'));
  assert.equal(countOf(events, 'steered'), 0, '새 실행이 시작하기 전에는 받았다고 알리지 않는다');
  calls[1].p.out({ type: 'turn.started' });
  assert.deepEqual(events.filter((e) => e.type === 'steered'), [{ type: 'steered', turn: 3 }]);
  // 옛 실행의 늦은 출력·종료는 무시
  calls[0].p.out({ type: 'turn.completed' }); calls[0].p.emit('exit', 0);
  assert.equal(countOf(events, 'done'), 0);
  calls[1].p.out({ type: 'turn.completed' });
  assert.equal(countOf(events, 'done'), 1); assert.deepEqual(events.at(-1), { type: 'done', ok: true, turn: 3 });
  assert.equal(agent.busy, false);
});

test('협업 Codex steer: kill 이 바로 exit 를 내면 곧바로 이어 실행하고, 턴 시작 전의 시작 경고로는 받았다고 알리지 않는다', () => {
  const { agent, calls, events } = runningCodex({ kill: (p) => p.emit('exit', 1) });
  agent.steer('추가', 3);
  calls[0].p.out(cmdItem('item.completed'));
  assert.equal(calls.length, 2);
  calls[1].p.out({ type: 'thread.started', thread_id: 'th1' }); calls[1].p.out(WARN);
  assert.equal(countOf(events, 'steered'), 0, '시작 경고는 턴 시작 전에 온다');
  calls[1].p.out({ type: 'turn.started' });
  assert.equal(countOf(events, 'steered'), 1);
  calls[1].p.out({ type: 'turn.started' });
  assert.equal(countOf(events, 'steered'), 1, '한 번만 알린다');
});

test('협업 Codex steer: 턴 시작 전(시작 경고 직후)·생각 정리(reasoning)가 끝난 지점에서는 끊지 않는다', () => {
  const { agent, calls, killed } = codexAgent();
  agent.send('질문', CXCFG, 3);
  calls[0].p.out({ type: 'thread.started', thread_id: 'th1' });
  agent.steer('추가', 3);
  calls[0].p.out(WARN);
  calls[0].p.out({ type: 'item.completed', item: { id: 'm0', type: 'agent_message', text: '이른 글' } });
  assert.deepEqual(killed, [], '턴 시작 전에는 끊을 수 있는 종류가 끝나도 끊지 않는다 (원래 프롬프트를 처리하기 전)');
  calls[0].p.out({ type: 'turn.started' });
  calls[0].p.out({ type: 'item.started', item: { id: 'r', type: 'reasoning' } });
  calls[0].p.out({ type: 'item.completed', item: { id: 'r', type: 'reasoning' } });
  assert.deepEqual(killed, [], 'reasoning 직후');
  calls[0].p.out({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: '먼저 확인합니다' } });
  assert.deepEqual(killed, [calls[0].p.pid], '답변 글이 끝난 지점에서는 끊는다');
});

test('협업 Codex: 미뤄 띄울 때 실행 준비가 실패하면 던지지 않고 그 턴을 오류로 끝낸다', () => {
  const { agent, calls, events } = codexAgent();
  agent.send('1', CXCFG, 3);
  calls[0].p.out({ type: 'thread.started', thread_id: 'th1' });
  agent.stop();
  agent.send('2', { model: 'bad model;x', effort: 'high' }, 4); // 옛 프로세스가 남아 미뤄짐 → exit 때 execArgs 가 던진다
  assert.doesNotThrow(() => calls[0].p.emit('exit', 1));
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, error: 'Codex 를 실행하지 못했습니다: 잘못된 모델', turn: 4 });
  assert.equal(agent.busy, false);
});

test('협업 Codex steer: 안전 지점 없이 턴이 끝나면 done 을 내지 않고 끊지 않은 채 이어 실행한다', () => {
  const { agent, calls, events, killed } = codexAgent();
  agent.send('질문', CXCFG, 3);
  calls[0].p.out({ type: 'thread.started', thread_id: 'th1' });
  agent.steer('추가', 3);
  calls[0].p.out({ type: 'turn.completed' });
  assert.equal(countOf(events, 'done'), 0); assert.deepEqual(killed, []);
  assert.equal(agent.busy, true);
  assert.equal(calls.length, 1);
  calls[0].p.emit('exit', 0);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args.slice(0, 3), ['exec', 'resume', 'th1']);
  calls[1].p.out({ type: 'turn.started' });
  calls[1].p.out({ type: 'turn.completed' });
  assert.equal(countOf(events, 'done'), 1); assert.equal(countOf(events, 'steered'), 1);
});

test('협업 Codex steer: 두 번 넣으면 한 번에 이어 보내고 steered 도 두 번 알린다', () => {
  const { agent, calls, events } = runningCodex();
  agent.steer('가', 3); agent.steer('나', 3);
  calls[0].p.out(cmdItem('item.completed'));
  calls[0].p.emit('exit', 1);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].p.written[0].endsWith('\n\n가\n\n나'));
  calls[1].p.out({ type: 'turn.started' });
  assert.equal(countOf(events, 'steered'), 2);
});

test('협업 Codex steer: 하위 에이전트(collab_tool_call)를 쓴 실행은 중간에 끊지 않고 턴 끝에서 이어 답한다', () => {
  const { agent, calls, events, killed } = codexAgent();
  agent.send('질문', CXCFG, 3);
  calls[0].p.out({ type: 'thread.started', thread_id: 'th1' });
  calls[0].p.out({ type: 'item.started', item: { id: 'c1', type: 'collab_tool_call' } });
  agent.steer('추가', 3);
  calls[0].p.out({ type: 'item.completed', item: { id: 'c1', type: 'collab_tool_call' } });
  calls[0].p.out(cmdItem('item.started')); calls[0].p.out(cmdItem('item.completed'));
  assert.deepEqual(killed, []);
  calls[0].p.out({ type: 'turn.completed' });
  assert.equal(countOf(events, 'done'), 0);
  calls[0].p.emit('exit', 0);
  assert.equal(calls.length, 2);
});

test('협업 Codex steer: 열린 todo_list 는 열린 작업으로 보지 않는다', () => {
  const { agent, calls, killed } = codexAgent();
  agent.send('질문', CXCFG, 3);
  calls[0].p.out({ type: 'turn.started' });
  calls[0].p.out({ type: 'item.started', item: { id: 't1', type: 'todo_list' } });
  calls[0].p.out(cmdItem('item.started'));
  agent.steer('추가', 3);
  calls[0].p.out(cmdItem('item.completed'));
  assert.deepEqual(killed, [calls[0].p.pid]);
});

test('협업 Codex steer: 실패로 끝나면 남은 메시지를 버리고 이어 실행하지 않는다', () => {
  const { agent, calls, events, killed } = codexAgent();
  agent.send('질문', CXCFG, 3);
  agent.steer('추가', 3);
  calls[0].p.out({ type: 'turn.failed', error: { message: '실패' } });
  assert.equal(countOf(events, 'done'), 1); assert.equal(events.at(-1).ok, false);
  assert.equal(countOf(events, 'steered'), 0); assert.deepEqual(killed, []);
  calls[0].p.emit('exit', 1);
  assert.equal(calls.length, 1); assert.equal(countOf(events, 'done'), 1);
});

test('협업 Codex steer: 이어 실행을 기다리는 중에 넣은 메시지는 보낼 글에 합치고 steered 를 합산한다', () => {
  const { agent, calls, events } = runningCodex();
  agent.steer('가', 3);
  calls[0].p.out(cmdItem('item.completed'));
  assert.equal(calls.length, 1);
  assert.equal(agent.steer('나', 3), true);
  calls[0].p.emit('exit', 1);
  assert.ok(calls[1].p.written[0].endsWith('\n\n가\n\n나'));
  calls[1].p.out({ type: 'turn.started' });
  assert.equal(countOf(events, 'steered'), 2);
});

test('협업 Codex steer: 이어 실행을 기다리는 중 중단하면 띄우지 않고 중단됨 한 번으로 끝낸다', () => {
  const { agent, calls, events } = runningCodex();
  agent.steer('가', 3);
  calls[0].p.out(cmdItem('item.completed'));
  agent.stop();
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, stopped: true, turn: 3 });
  calls[0].p.emit('exit', 1);
  assert.equal(calls.length, 1);
  assert.equal(events.filter((e) => e.stopped).length, 1);
  assert.equal(agent.busy, false);
});

test('협업 Codex steer: 옛 프로세스가 끝나지 않아도 상한 시간 뒤에는 띄우고, 그 프로세스는 한 번 더 끝낸 뒤 다음 턴부터 기다리지 않으며 닫을 때 정리한다', async () => {
  const { agent, calls, killed } = runningCodex({ exitWaitMs: 30 });
  const old = calls[0].p.pid;
  agent.steer('가', 3);
  calls[0].p.out(cmdItem('item.completed'));
  assert.equal(calls.length, 1);
  await cxSleep(100);
  assert.equal(calls.length, 2);
  assert.equal(killed.filter((pid) => pid === old).length, 2, '상한에서 한 번 더 끝낸다');
  calls[1].p.out({ type: 'turn.started' }); calls[1].p.out({ type: 'turn.completed' }); calls[1].p.emit('exit', 0);
  agent.send('다음', CXCFG, 4);
  assert.equal(calls.length, 3, '안 끝난 옛 프로세스 때문에 다음 턴이 또 기다리지 않는다');
  agent.close();
  assert.equal(killed.filter((pid) => pid === old).length, 3, '닫을 때 그 프로세스도 정리한다');
});

test('협업 Codex: 중단 직후 다시 보내면 옛 프로세스 종료를 기다렸다가 띄운다', () => {
  const { agent, calls } = codexAgent();
  agent.send('1', CXCFG, 3);
  calls[0].p.out({ type: 'thread.started', thread_id: 'th1' });
  agent.stop();
  agent.send('2', CXCFG, 4);
  assert.equal(calls.length, 1); assert.equal(agent.busy, true);
  assert.equal(agent.steer('덧붙임', 4), true, '아직 띄우기 전이면 보낼 글에 합친다');
  calls[0].p.emit('exit', 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args.slice(0, 3), ['exec', 'resume', 'th1']);
  assert.equal(calls[1].p.written[0], '2\n\n덧붙임');
});

test('협업 Codex steer: 다른 턴·빈 글·끝난 뒤에는 거절한다', () => {
  const { agent, calls } = codexAgent();
  assert.equal(agent.steer('x', 1), false, '실행 없음');
  agent.send('질문', CXCFG, 5);
  assert.equal(agent.steer('x', 6), false);
  assert.equal(agent.steer('  ', 5), false);
  calls[0].p.out({ type: 'turn.completed' });
  calls[0].p.emit('exit', 0);
  assert.equal(agent.busy, false);
  assert.equal(agent.steer('x', 5), false);
});

// 협업 Claude 의 진행 중 메시지(steer): 되돌림(--replay-user-messages)으로 받았는지 확인한다.
const CFG = { model: 'opus', effort: 'high' };
const replay = (text) => ({ type: 'user', isReplay: true, uuid: 'u', message: { role: 'user', content: [{ type: 'text', text }] } });
const RESULT_OK = { type: 'result', subtype: 'success', result: '' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function steerAgent(extra = {}) {
  const { spawn, calls } = fakeSpawn(); const events = []; const killed = [];
  const agent = new collab.ClaudeChat({ loc: { file: 'claude.exe', prefixArgs: [] }, cwd: 'C:\\w', settingsPath: 's', systemPrompt: '', env: {}, spawn, kill: (p) => killed.push(p.pid), onEvent: (e) => events.push(e), ...extra });
  return { agent, calls, events, killed };
}

test('협업 Claude: 되돌림 옵션과 되돌림 글 해석', () => {
  const args = collab.claudeChatArgs({ settingsPath: 's', sessionId: 'id', model: 'opus', effort: 'high' });
  assert.ok(args.includes('--replay-user-messages'));
  assert.equal(args.indexOf('--replay-user-messages'), args.indexOf('--include-partial-messages') + 1);
  assert.equal(collab.replayText({ type: 'user', isReplay: true, message: { content: '문자열' } }), '문자열');
  assert.equal(collab.replayText({ type: 'user', isReplay: true, message: { content: [{ type: 'text', text: 'a' }, { type: 'tool_result' }, { type: 'text', text: 'b' }] } }), 'ab');
  assert.equal(collab.replayText({ type: 'user', message: { content: '문자열' } }), null, 'isReplay 없으면 되돌림이 아니다');
  assert.equal(collab.replayText({ type: 'assistant', isReplay: true, message: { content: 'x' } }), null);
});

test('협업 Claude: 넣은 메시지는 되돌림을 받아야 확인되고, 확인 전 result 로는 턴이 끝나지 않는다', () => {
  const { agent, calls, events } = steerAgent();
  agent.send('질문', CFG, 7);
  const p = calls[0].p;
  p.out(replay('질문')); // 턴 프롬프트의 되돌림은 무시
  assert.deepEqual(events, []);
  assert.equal(agent.steer('x', 7), true);
  assert.equal(p.written.length, 2); assert.equal(JSON.parse(p.written[1]).message.content[0].text, 'x');
  p.out(RESULT_OK);
  assert.deepEqual(events, [], '넣은 메시지가 남아 있으면 같은 턴이 이어진다');
  p.out(replay('x'));
  assert.deepEqual(events, [{ type: 'steered', turn: 7 }]);
  p.out(RESULT_OK);
  assert.deepEqual(events.map((e) => e.type), ['steered', 'done']); assert.equal(agent.busy, false);
  assert.equal(agent.hold, null, '끝나면 감시 타이머 해제');
});

test('협업 Claude: 되돌림이 result 보다 먼저 와도 done 은 한 번', () => {
  const { agent, calls, events } = steerAgent();
  agent.send('질문', CFG, 1);
  const p = calls[0].p;
  p.out(replay('질문'));
  agent.steer('x', 1);
  p.out(replay('x')); p.out(RESULT_OK);
  assert.deepEqual(events.map((e) => e.type), ['steered', 'done']);
});

test('협업 Claude: 넣은 글과 정확히 같은 되돌림만 확인으로 보고, 하위 에이전트 쪽 되돌림은 무시한다', () => {
  const { agent, calls, events } = steerAgent();
  agent.send('질문', CFG, 1);
  const p = calls[0].p;
  p.out(replay('질문'));
  agent.steer('a', 1); agent.steer('b', 1);
  p.out(replay('다르게 되돌아온 글'));
  p.out({ ...replay('a'), parent_tool_use_id: 'toolu_1' });
  assert.deepEqual(events, []); assert.deepEqual(agent.steered, ['a', 'b']);
  p.out(replay('b')); p.out(replay('a')); p.out(RESULT_OK);
  assert.deepEqual(events.map((e) => e.type), ['steered', 'steered', 'done']);
});

test('협업 Claude: 프롬프트 되돌림 글이 어긋나도 넣은 글이 되돌아오면 확인하고, 그것도 없으면 대기 시간 뒤 끝내고 다시 띄운다', async () => {
  const a = steerAgent();
  a.agent.send('질문', CFG, 1);
  a.agent.steer('x', 1);
  a.calls[0].p.out(replay('조금 다른 프롬프트')); a.calls[0].p.out(replay('x')); a.calls[0].p.out(RESULT_OK);
  assert.deepEqual(a.events.map((e) => e.type), ['steered', 'done']);
  const b = steerAgent({ steerWaitMs: 30 });
  b.agent.send('질문', CFG, 1);
  b.agent.steer('x', 1);
  b.calls[0].p.out(replay('조금 다른 프롬프트')); b.calls[0].p.out(RESULT_OK);
  await sleep(150);
  assert.deepEqual(b.events, [{ type: 'done', ok: true, unconfirmed: 1, turn: 1 }]); assert.deepEqual(b.killed, [b.calls[0].p.pid]);
});

test('협업 Claude: 두 메시지 중 하나만 받아도 감시 타이머를 끄고, 다음 ok result 에서 남은 것을 다시 기다린다', async () => {
  const { agent, calls, events } = steerAgent({ steerWaitMs: 30 });
  agent.send('질문', CFG, 1);
  const p = calls[0].p;
  p.out(replay('질문'));
  agent.steer('a', 1); agent.steer('b', 1);
  p.out(RESULT_OK); p.out(replay('a'));
  assert.equal(agent.hold, null);
  await sleep(150);
  assert.deepEqual(events.map((e) => e.type), ['steered'], 'a 에 대한 긴 도구 실행 중에도 끝나지 않는다');
  p.out(RESULT_OK);
  assert.ok(agent.hold, 'b 를 다시 기다린다');
  p.out(replay('b')); p.out(RESULT_OK);
  assert.deepEqual(events.map((e) => e.type), ['steered', 'steered', 'done']);
});

test('협업 Claude: 되돌림 없이 result 뒤 출력이 없으면 대기 시간 뒤 확인 못 한 채로 끝내고, 출력이 오면 타이머를 다시 시작한다', async () => {
  const a = steerAgent({ steerWaitMs: 20 });
  a.agent.send('질문', CFG, 1);
  a.calls[0].p.out(replay('질문'));
  a.agent.steer('x', 1); a.calls[0].p.out(RESULT_OK);
  assert.deepEqual(a.events, []);
  await sleep(80);
  assert.deepEqual(a.events, [{ type: 'done', ok: true, unconfirmed: 1, turn: 1 }]); assert.equal(a.agent.busy, false);
  const b = steerAgent({ steerWaitMs: 400 });
  b.agent.send('질문', CFG, 1);
  b.calls[0].p.out(replay('질문'));
  b.agent.steer('x', 1); b.calls[0].p.out(RESULT_OK);
  await sleep(250); b.calls[0].p.out({ type: 'system', subtype: 'status' }); // 출력이 오면 다시 시작
  await sleep(250);
  assert.deepEqual(b.events, [], '처음 시작 기준으로는 지났지만 다시 시작했으니 아직');
  await sleep(450);
  assert.deepEqual(b.events.map((e) => e.type), ['done']); assert.equal(b.events[0].unconfirmed, 1);
});

test('협업 Claude: 실패 result 에 넣은 메시지가 남았으면 done 실패를 한 번 보내고 프로세스를 다시 띄우도록 끝낸다', () => {
  const { agent, calls, events, killed } = steerAgent();
  agent.send('질문', CFG, 1);
  const p = calls[0].p;
  p.out(replay('질문'));
  agent.steer('x', 1);
  p.out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '오류' });
  assert.equal(events.filter((e) => e.type === 'done').length, 1); assert.equal(events.at(-1).ok, false);
  assert.deepEqual(killed, [p.pid]); assert.deepEqual(agent.steered, []); assert.equal(agent.proc, null); assert.equal(agent.hold, null);
});

test('협업 Claude: 답변 중이 아니거나 턴 번호가 다르거나 빈 글이면 넣지 않고, 중단하면 대기 상태를 비운다', () => {
  const { agent, calls, events } = steerAgent({ steerWaitMs: 5000 });
  assert.equal(agent.steer('x', 1), false, '아직 시작 전');
  agent.send('질문', CFG, 1);
  const p = calls[0].p;
  assert.equal(agent.steer('x', 2), false, '다른 턴');
  assert.equal(agent.steer('  \r\n ', 1), false, '빈 글');
  assert.equal(p.written.length, 1);
  assert.equal(agent.steer('x'), true, '턴 번호를 안 주면 현재 턴');
  p.out(RESULT_OK); // 타이머가 걸린다
  assert.ok(agent.hold);
  agent.stop();
  assert.deepEqual(agent.steered, []); assert.equal(agent.hold, null);
  assert.deepEqual(events.at(-1), { type: 'done', ok: false, stopped: true, turn: 1 });
  assert.equal(agent.steer('x', 1), false, '끝난 뒤');
});

test('협업 Claude: 넣은 메시지를 다 받은 뒤에는 감시 타이머가 꺼져, 이어지는 턴의 긴 무출력(도구)에도 끝나지 않는다', async () => {
  const { agent, calls, events } = steerAgent({ steerWaitMs: 20 });
  agent.send('질문', CFG, 1);
  const p = calls[0].p;
  p.out(replay('질문'));
  agent.steer('x', 1);
  p.out(RESULT_OK); // 글만 쓰던 턴이 먼저 끝남 → 타이머
  p.out(replay('x')); // 받음 → 타이머 해제
  assert.equal(agent.hold, null);
  await sleep(80);
  assert.deepEqual(events.map((e) => e.type), ['steered'], '긴 도구 실행 중에도 끝나지 않는다');
  p.out(RESULT_OK);
  assert.deepEqual(events.map((e) => e.type), ['steered', 'done']);
});

test('협업 Claude: 대기 시간 초과로 끝내면 프로세스를 다시 띄우도록 끝내, 남은 메시지의 늦은 답이 다음 턴에 섞이지 않는다', async () => {
  const { agent, calls, events, killed } = steerAgent({ steerWaitMs: 20 });
  agent.send('질문', CFG, 1);
  const p = calls[0].p;
  p.out(replay('질문'));
  agent.steer('x', 1); p.out(RESULT_OK);
  await sleep(80);
  assert.deepEqual(killed, [p.pid]); assert.equal(agent.proc, null);
  agent.send('다음', CFG, 2);
  assert.equal(calls.length, 2, '새 프로세스(--resume)');
  p.out(replay('x')); p.out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '늦은 답' } } }); p.out(RESULT_OK);
  assert.ok(!events.some((e) => e.turn === 2), '옛 프로세스 출력은 새 턴에 안 섞임');
});

test('협업 Claude: 프롬프트 되돌림 전에 온 다른 글(지난 기록 등)·글 없는 되돌림은 확인으로 보지 않는다', () => {
  const { agent, calls, events } = steerAgent();
  agent.send('질문', CFG, 1);
  const p = calls[0].p;
  agent.steer('x', 1);
  p.out(replay('지난 기록'));
  p.out({ type: 'user', isReplay: true, message: { content: [{ type: 'tool_result', content: 'r' }] } });
  assert.equal(collab.replayText({ type: 'user', isReplay: true, message: { content: [{ type: 'tool_result' }] } }), null);
  assert.deepEqual(events, []); assert.deepEqual(agent.steered, ['x']);
  p.out(replay('질문')); p.out(replay('x'));
  assert.deepEqual(events.map((e) => e.type), ['steered']);
});

test('협업 Claude: 답변 중이 아닐 때 나온 글·도구는 내보내지 않고 세션 알림만 낸다', () => {
  const { agent, calls, events } = steerAgent();
  agent.send('질문', CFG, 1);
  const p = calls[0].p;
  p.out(RESULT_OK);
  const before = events.length;
  p.out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '늦은 글' } } });
  p.out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } });
  assert.equal(events.length, before);
  p.out({ type: 'system', subtype: 'init', session_id: agent.sessionId });
  assert.equal(events.at(-1).type, 'session'); assert.equal(agent.hasHistory, true);
});
