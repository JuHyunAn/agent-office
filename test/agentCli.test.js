import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AGENT_IDS, agentById } from '../src/shared/agents.js';
import { setLang } from '../src/shared/i18n.js';

const agentCli = createRequire(import.meta.url)('../src/main/agentCli.cjs');

const out = (stdout, { code = 0, stderr = '' } = {}) => ({ code, stdout, stderr });

test('ADAPTERS: 새 AI 3종만 있고 레지스트리의 id 와 맞는다', () => {
  assert.deepEqual(Object.keys(agentCli.ADAPTERS), ['grok', 'muse', 'antigravity']);
  for (const id of Object.keys(agentCli.ADAPTERS)) assert.ok(AGENT_IDS.includes(id), id);
  assert.ok(agentCli.has('grok') && agentCli.has('muse') && agentCli.has('antigravity'));
  assert.ok(!agentCli.has('claude') && !agentCli.has('codex') && !agentCli.has('toString') && !agentCli.has('nope'));
  assert.deepEqual(agentCli.loginArgs('grok'), ['login']);
  assert.deepEqual(agentCli.loginArgs('antigravity'), []);
  assert.deepEqual(agentCli.loginArgs('muse'), ['login']); // 1.4.14 실측 도움말
  assert.deepEqual(agentCli.tabArgs('muse'), []);
});

test('locate: Windows 는 고정 설치 위치를 where 보다 먼저 본다 (where 는 부르지도 않는다)', async () => {
  const grok = agentCli.ADAPTERS.grok.paths()[0];
  let asked = 0;
  const loc = await agentCli.locate('grok', { platform: 'win32', exists: (p) => p === grok, where: async () => { asked++; return out(''); } });
  assert.deepEqual(loc, { file: grok, prefixArgs: [], display: grok });
  assert.equal(asked, 0);
});

test('locate: 고정 위치에 없으면 where 첫 줄들 중 실제 있는 .exe 를 쓴다', async () => {
  const exe = 'C:\\tools\\agy.exe';
  const loc = await agentCli.locate('antigravity', {
    platform: 'win32',
    exists: (p) => p === exe,
    where: async (bin) => { assert.equal(bin, 'agy'); return out('C:\\gone\\agy.exe\r\nC:\\tools\\agy.exe\r\n'); },
  });
  assert.equal(loc.file, exe);
  assert.equal(loc.display, exe);
  assert.equal(loc.cmdShim, undefined);
});

test('locate: .cmd 는 cmd.exe 경유(cmdShim)로 표시한다 — muse 런처 shim', async () => {
  const cmd = agentCli.ADAPTERS.muse.paths()[0];
  assert.match(cmd, /muse\.cmd$/);
  const loc = await agentCli.locate('muse', { platform: 'win32', exists: (p) => p === cmd, where: async () => out(''), museExe: () => null }); // 실행 파일이 없을 때의 폴백
  assert.deepEqual(loc, { file: 'cmd.exe', prefixArgs: [], cmdShim: cmd, display: cmd });
});

test('locate: 어디에도 없으면 null · where 가 던져도 null · 모르는 id 는 null', async () => {
  assert.equal(await agentCli.locate('grok', { platform: 'win32', exists: () => false, where: async () => out('INFO: Could not find files') }), null);
  assert.equal(await agentCli.locate('grok', { platform: 'win32', exists: () => false, where: async () => { throw new Error('x'); } }), null);
  assert.equal(await agentCli.locate('claude', { platform: 'win32', exists: () => true, where: async () => out('C:\\claude.exe') }), null);
});

test('locate: Windows 가 아니면 which 첫 줄 (있을 때만)', async () => {
  const where = async () => out('/usr/local/bin/grok\n/other/grok\n');
  const loc = await agentCli.locate('grok', { platform: 'linux', exists: (p) => p === '/usr/local/bin/grok', where });
  assert.deepEqual(loc, { file: '/usr/local/bin/grok', prefixArgs: [], display: '/usr/local/bin/grok' });
  assert.equal(await agentCli.locate('grok', { platform: 'linux', exists: () => false, where }), null);
});

test('version: 「grok 1.0.70 (해시)」 → 1.0.70, 「1.4.12」 → 1.4.12, 숫자가 없으면 null', async () => {
  const v = (stdout) => agentCli.version({}, { runner: async (l, a) => { assert.deepEqual(a, ['--version']); return out(stdout); } });
  assert.equal(await v('grok 1.0.70 (f50904eaee6c)\n'), '1.0.70');
  assert.equal(await v('1.4.12\n'), '1.4.12');
  assert.equal(await v('muse 0.3.1-beta.2\n'), '0.3.1-beta.2');
  assert.equal(await v('오류'), null);
});

test('authStatus: grok 미로그인은 exit 0 이어도 false (실측 문구)', async () => {
  const seen = [];
  const r = await agentCli.authStatus('grok', { file: 'x' }, { runner: async (l, a) => { seen.push(a); return out('You are not authenticated.\n'); } });
  assert.deepEqual(r, { loggedIn: false });
  assert.deepEqual(seen, [['models']]);
});

test('authStatus: agy 미로그인은 exit 1 이어도 오류가 아니라 false (실측 문구)', async () => {
  const r = await agentCli.authStatus('antigravity', {}, { runner: async () => out('Please sign in to view available models.\n', { code: 1 }) });
  assert.deepEqual(r, { loggedIn: false });
});

test('authStatus: 미로그인 문구가 stderr 에 있어도 잡는다 · muse 는 usage 를 부른다', async () => {
  const seen = [];
  const r = await agentCli.authStatus('muse', {}, { runner: async (l, a) => { seen.push(a); return out('', { code: 1, stderr: 'muse usage: not logged in: run `muse login` first' }); } });
  assert.deepEqual(r, { loggedIn: false });
  assert.deepEqual(seen, [['usage']]);
});

test('authStatus: 문구 없이 exit 0 이면 로그인', async () => {
  const r = await agentCli.authStatus('grok', {}, { runner: async () => out('grok-4  grok-code-fast\n') });
  assert.deepEqual(r, { loggedIn: true });
});

test('authStatus: 그 밖의 실패(오류 코드·시간 초과)는 error 문자열 — 첫 줄 120자', async () => {
  const a = await agentCli.authStatus('grok', {}, { runner: async () => out('', { code: 2, stderr: '\nconnect ECONNREFUSED\nmore' }) });
  assert.deepEqual(a, { loggedIn: false, error: '로그인 상태를 확인하지 못했습니다: connect ECONNREFUSED' });
  const t = await agentCli.authStatus('grok', {}, { runner: async () => out('', { code: 1 }) });
  assert.equal(t.loggedIn, false);
  assert.match(t.error, /^로그인 상태를 확인하지 못했습니다: .+/);
  const long = await agentCli.authStatus('grok', {}, { runner: async () => out('x'.repeat(500), { code: 1 }) });
  assert.equal(long.error, '로그인 상태를 확인하지 못했습니다: ' + 'x'.repeat(120));
});

test('authStatus: 영어 설정이면 실패 안내도 영어 (메인이 만드는 문구)', async () => {
  setLang('en');
  try {
    const a = await agentCli.authStatus('grok', {}, { runner: async () => out('', { code: 2, stderr: 'connect ECONNREFUSED' }) });
    assert.deepEqual(a, { loggedIn: false, error: 'Could not check sign-in status: connect ECONNREFUSED' });
    const b = await agentCli.authStatus('grok', {}, { runner: async () => out('', { code: 1 }) });
    assert.equal(b.error, 'Could not check sign-in status: No response');
  } finally { setLang('ko'); }
});

test('authStatus: timeoutMs 를 러너에 넘기고(기본 10초), 출력 없는 실패(시간 초과)만 timedOut 을 단다', async () => {
  const seen = [];
  const runner = async (l, a, ms) => { seen.push(ms); return out('', { code: 1 }); };
  const def = await agentCli.authStatus('antigravity', {}, { runner });
  const wide = await agentCli.authStatus('antigravity', {}, { runner, timeoutMs: 15000 });
  assert.deepEqual(seen, [10000, 15000]);
  assert.equal(def.timedOut, true);
  assert.equal(wide.timedOut, true);
  const failed = await agentCli.authStatus('antigravity', {}, { runner: async () => out('', { code: 2, stderr: 'connect ECONNREFUSED' }) });
  assert.equal(failed.timedOut, undefined);
  const loggedOut = await agentCli.authStatus('antigravity', {}, { runner: async () => out('Please sign in to view available models.\n', { code: 1 }) });
  assert.deepEqual(loggedOut, { loggedIn: false });
});

test('INSTALL_ENV: codex 만 비대화 환경 변수를 받는다', () => {
  assert.deepEqual(agentCli.INSTALL_ENV, { codex: { CODEX_NON_INTERACTIVE: '1' } });
});

test('installCommand: Windows 는 PowerShell 절대 경로 + -EncodedCommand(utf16le) 로 레지스트리 명령과 같다 (모든 AI)', () => {
  for (const id of AGENT_IDS) {
    const c = agentCli.installCommand(id, { platform: 'win32', systemRoot: 'C:\\Windows' });
    assert.equal(c.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', id);
    assert.deepEqual(c.args.slice(0, 4), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'], id);
    assert.equal(c.args.length, 5);
    assert.equal(Buffer.from(c.args[4], 'base64').toString('utf16le'), agentById(id).install.cmd, id);
  }
});

test('installCommand: Windows 가 아니면 null · 모르는 id 는 null (화면이 보낸 값으로 명령을 만들지 않는다)', () => {
  assert.equal(agentCli.installCommand('grok', { platform: 'linux' }), null);
  assert.equal(agentCli.installCommand('grok', { platform: 'darwin' }), null);
  assert.equal(agentCli.installCommand('nope', { platform: 'win32' }), null);
  assert.equal(agentCli.installCommand('toString', { platform: 'win32' }), null);
  assert.equal(agentCli.installCommand(undefined, { platform: 'win32' }), null);
});
