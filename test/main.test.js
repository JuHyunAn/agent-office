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
