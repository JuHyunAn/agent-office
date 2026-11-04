import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shellCommand, shellLaunch } = require('../src/main/shellCmd.cjs');
const { createCodeRoots } = require('../src/main/codeRepo.cjs');

test('PowerShell: SystemRoot 의 절대 경로로 띄우고, 파이프 출력이 UTF-8 이 되게 한다', () => {
  const r = shellCommand('powershell', { platform: 'win32', systemRoot: 'D:\\Win' });
  assert.equal(r.file, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(r.args.slice(0, 3), ['-NoLogo', '-NoExit', '-Command']);
  assert.match(r.args[3], /\[Console\]::OutputEncoding=\[Text\.Encoding\]::UTF8/);
  assert.match(r.args[3], /\$OutputEncoding=\[Text\.Encoding\]::UTF8/);
  assert.ok(!r.args.includes('-NoProfile'), '사용자 셸 설정은 그대로 쓴다');
});

test('PowerShell: SystemRoot 가 없으면 C:\\Windows, 상대 경로 파일명은 쓰지 않는다', () => {
  const r = shellCommand('powershell', { platform: 'win32' });
  assert.equal(r.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.ok(/^[A-Za-z]:\\/.test(r.file));
});

test('Git Bash: 찾은 경로로 로그인 대화형 셸', () => {
  const r = shellCommand('bash', { platform: 'win32', bashPath: 'C:\\Program Files\\Git\\bin\\bash.exe' });
  assert.deepEqual(r, { file: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'] });
});

test('Git Bash 를 못 찾으면 알린다', () => {
  assert.throws(() => shellCommand('bash', { platform: 'win32', bashPath: null }), /Git Bash 를 찾지 못했습니다/);
  assert.throws(() => shellCommand('bash', { platform: 'win32' }), /Git Bash 를 찾지 못했습니다/);
});

test('셸 종류는 powershell·bash 만 받는다', () => {
  for (const bad of ['cmd', 'sh', 'powershell.exe', '', null, undefined, 1, {}, ['bash'], 'PowerShell', '__proto__', 'constructor'])
    assert.throws(() => shellCommand(bad, { platform: 'win32', bashPath: 'C:\\b.exe' }), /지원하지 않는 셸/, String(bad));
});

test('Windows 가 아니면 지원하지 않는다', () => {
  for (const kind of ['powershell', 'bash'])
    assert.throws(() => shellCommand(kind, { platform: 'linux', bashPath: '/bin/bash' }), /이 운영체제에서는 지원하지 않습니다/);
  assert.throws(() => shellCommand('powershell', { platform: 'darwin' }), /이 운영체제에서는 지원하지 않습니다/);
});

// pty:create 의 mode:'shell' 검사 — 등록된 폴더만, 있는 폴더만, 셸 종류는 고정 두 값만.
const checkFolder = (d) => { if (!d || !fs.existsSync(d) || !fs.statSync(d).isDirectory()) throw new Error(`폴더가 없습니다: ${d}`); };
const BASH = 'C:\\Git\\bin\\bash.exe';
const launch = (over) => shellLaunch({ platform: 'win32', systemRoot: 'C:\\Windows', checkFolder, findBash: async () => BASH, ...over });
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ao-shell-'));

test('shellLaunch: 등록되지 않은 폴더는 거부하고 Git Bash 도 찾지 않는다', async () => {
  const dir = tmpDir();
  try {
    const roots = createCodeRoots();
    let looked = 0;
    const findBash = async () => { looked++; return BASH; };
    for (const cwd of [dir, '', null, undefined, 42, os.homedir()])
      await assert.rejects(launch({ shell: 'bash', cwd, roots, findBash }), /등록되지 않은 폴더/, String(cwd));
    assert.equal(looked, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('shellLaunch: 등록된 폴더에서 PowerShell·Git Bash 를 돌려주고, 셸 종류가 틀리거나 폴더가 없어졌으면 거부한다', async () => {
  const dir = tmpDir();
  try {
    const roots = createCodeRoots();
    roots.add(dir);
    let looked = 0;
    const findBash = async () => { looked++; return BASH; };
    const ps = await launch({ shell: 'powershell', cwd: dir, roots, findBash });
    assert.equal(ps.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(looked, 0, 'PowerShell 은 Git Bash 를 찾지 않는다');
    assert.deepEqual(await launch({ shell: 'bash', cwd: dir, roots, findBash }), { file: BASH, args: ['--login', '-i'] });
    assert.equal(looked, 1);
    await assert.rejects(launch({ shell: 'bash', cwd: dir, roots, findBash: async () => null }), /Git Bash 를 찾지 못했습니다/);
    for (const shell of ['cmd', 'powershell.exe', '', undefined, '; calc'])
      await assert.rejects(launch({ shell, cwd: dir, roots, findBash }), /지원하지 않는 셸/, String(shell));
    await assert.rejects(launch({ shell: 'bash', cwd: dir, roots, findBash, platform: 'linux' }), /이 운영체제에서는 지원하지 않습니다/);
    assert.equal(looked, 1, '지원하지 않는 운영체제에서는 Git Bash 를 찾지 않는다');
    fs.rmSync(dir, { recursive: true, force: true });
    await assert.rejects(launch({ shell: 'powershell', cwd: dir, roots, findBash }), /폴더가 없습니다/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// startShellPty: 검사(shellLaunch) 뒤 ptys.create 까지. 실패하면 ptys.create 를 부르지 않는다.
const { startShellPty } = require('../src/main/shellCmd.cjs');
const { cleanEnv } = require('../src/main/env.cjs');

function fakePtys() {
  const calls = [];
  return { calls, create: (o) => { calls.push(o); return 1; } };
}

test('startShellPty: kind:shell·전달한 env(AGENT_OFFICE_TAB 없음)로 ptys.create 를 부른다', async () => {
  const dir = tmpDir();
  const before = process.env.AGENT_OFFICE_TAB;
  process.env.AGENT_OFFICE_TAB = 'leak';
  try {
    const roots = createCodeRoots();
    roots.add(dir);
    const ptys = fakePtys();
    const env = cleanEnv();
    await startShellPty({ ptys, env, tabId: 'code-term-1', cwd: dir, cols: 90, rows: 20, shell: 'powershell', roots, checkFolder, platform: 'win32', systemRoot: 'C:\\Windows', findBash: async () => BASH });
    assert.equal(ptys.calls.length, 1);
    const c = ptys.calls[0];
    assert.equal(c.kind, 'shell');
    assert.equal(c.tabId, 'code-term-1');
    assert.equal(c.cwd, dir);
    assert.equal(c.cols, 90);
    assert.equal(c.rows, 20);
    assert.equal(c.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(c.env, env);
    assert.ok(!('AGENT_OFFICE_TAB' in c.env), '셸 환경에 탭 ID 가 실리면 안 된다');
    await startShellPty({ ptys, env, tabId: 'code-term-2', cwd: dir, shell: 'bash', roots, checkFolder, platform: 'win32', findBash: async () => BASH });
    assert.deepEqual([ptys.calls[1].file, ptys.calls[1].args, ptys.calls[1].kind], [BASH, ['--login', '-i'], 'shell']);
  } finally {
    if (before === undefined) delete process.env.AGENT_OFFICE_TAB; else process.env.AGENT_OFFICE_TAB = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startShellPty: 거부되면 ptys.create 를 부르지 않는다 (등록 안 된 폴더·잘못된 셸·Git Bash 없음)', async () => {
  const dir = tmpDir();
  try {
    const roots = createCodeRoots();
    const ptys = fakePtys();
    const base = { ptys, env: {}, tabId: 'code-term-1', cwd: dir, roots, checkFolder, platform: 'win32', findBash: async () => BASH };
    await assert.rejects(startShellPty({ ...base, shell: 'powershell' }), /등록되지 않은 폴더/);
    roots.add(dir);
    await assert.rejects(startShellPty({ ...base, shell: 'cmd' }), /지원하지 않는 셸/);
    await assert.rejects(startShellPty({ ...base, shell: 'bash', findBash: async () => null }), /Git Bash 를 찾지 못했습니다/);
    assert.equal(ptys.calls.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('터미널 ID(code-term-N)는 main.cjs 의 TAB_RE 형식에 맞는다', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '../src/main/main.cjs'), 'utf8');
  const m = /const TAB_RE = (\/.+\/);/.exec(src);
  assert.ok(m, 'main.cjs 에서 TAB_RE 를 찾지 못함');
  const re = new Function(`return ${m[1]}`)();
  for (const n of [1, 9, 10, 12345]) assert.ok(re.test(`code-term-${n}`), `code-term-${n}`);
});
