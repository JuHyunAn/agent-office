import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setLang } from '../src/shared/i18n.js';

// 사용자·시스템 git 설정이 결과를 흔들지 않게 격리한다 (codeRepo.test.js 와 같은 방식).
// useConfigOnly: 사용자 정보가 없는 저장소에서 컴퓨터 이름으로 추측하지 않고 확실히 실패하게 한다.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-gitops-')));
const emptyConfig = path.join(base, 'gitconfig');
fs.writeFileSync(emptyConfig, '[user]\n\tuseConfigOnly = true\n');
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GCM_INTERACTIVE = 'never'; // 안전장치: 혹시 GCM 이 불려도 로그인 창을 띄우지 않는다 (아래 realGit 도 GCM 인자를 막는다)
for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[k];

const require = createRequire(import.meta.url);
const codeGit = require('../src/main/codeGit.cjs');
const {
  STATUS_ARGS, WRITE_ENV, NET_ENV, NET_TIMEOUT_MS, GCM_ARGS, GCM_ENV, parseStatusV2, statusLists, pathSet, topPathspec, pathspecInput, parseLog,
  errorOf, isAuthFailure, createGitOps,
} = codeGit;
const { createCodeRoots, rootKey, git: spawnGit } = require('../src/main/codeRepo.cjs');

// 실제 GCM(Git Credential Manager)을 부르면 사용자 화면에 로그인 창이 뜬다. 시험의 진짜 git 은 GCM 인자가 오면 던진다.
// 재시도 인자를 받는 가짜 git 이 진짜 git 으로 그대로 넘기는 실수도 여기서 막는다.
const guardGcm = (args) => { if (args.includes('credential.helper=manager')) throw new Error(`시험에서 실제 GCM 호출 금지: ${args.join(' ')}`); };
const realGit = async (root, args, opts) => { guardGcm(args); return spawnGit(root, args, opts); };

after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }));

let hasGit = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { hasGit = false; }
const skip = hasGit ? false : '실행 파일 없음';

// ---------- 도우미 ----------

let seq = 0;
const mkdir = (name) => { const d = path.join(base, `${name}-${seq++}`); fs.mkdirSync(d, { recursive: true }); return d; };
const put = (root, rel, data) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tryGit = (cwd, ...args) => { try { return git(cwd, ...args); } catch (e) { return `ERR:${e.stderr || e.message}`; } };

// 저장소 만들기 (main 브랜치, 사용자 정보 설정 가능)
function mkRepo(name, { identity = true } = {}) {
  const d = mkdir(name);
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'core.autocrlf', 'false');
  if (identity) { git(d, 'config', 'user.name', 't'); git(d, 'config', 'user.email', 't@t'); }
  return d;
}
// 파일을 쓰고 한 번 커밋
function commitFile(repo, rel, data, msg = 'init') {
  put(repo, rel, data);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', msg);
}
const mkBare = () => { const d = mkdir('bare'); git(d, 'init', '-q', '--bare', '-b', 'main'); return d; };

// 원격(bare) 에 첫 커밋까지 올려 둔 저장소
function seedRemote(files = { 'seed.txt': 'seed\n' }) {
  const bare = mkBare();
  const repo = mkRepo('local');
  git(repo, 'remote', 'add', 'origin', bare);
  for (const [rel, data] of Object.entries(files)) put(repo, rel, data);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'seed');
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  // 다른 사람이 원격에 커밋을 올린다
  const remoteCommit = (rel, data, msg = 'remote') => {
    const other = mkdir('other');
    git(base, 'clone', '-q', bare, other);
    git(other, 'config', 'user.name', 'o');
    git(other, 'config', 'user.email', 'o@o');
    git(other, 'config', 'core.autocrlf', 'false');
    put(other, rel, data);
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', msg);
    git(other, 'push', '-q', 'origin', 'main');
  };
  return { bare, repo, remoteCommit };
}

// 기록용 git 을 끼운 Ops. 대기 없는 가짜 sleep.
function makeOps(dirs, { git: inner = realGit, sleep } = {}) {
  const roots = createCodeRoots();
  for (const d of [].concat(dirs)) roots.add(d);
  const calls = [];
  const callOpts = []; // calls 와 같은 순서의 옵션 (env·timeoutMs·track)
  const sleeps = [];
  const rec = (root, args, opts) => {
    if (inner === realGit) guardGcm(args); // 진짜 git 에는 GCM 인자를 보내지 않는다
    calls.push(args);
    callOpts.push(opts);
    return inner(root, args, opts);
  };
  const ops = createGitOps({ git: rec, rootKey, roots, sleep: sleep || (async (ms) => { sleeps.push(ms); }) });
  return { ops, roots, calls, callOpts, sleeps };
}

const sortedPaths = (list) => list.map((e) => e.path).sort();
const headOf = (repo) => git(repo, 'rev-parse', 'HEAD').trim();

// ---------- 1. parseStatusV2 ----------

const NUL = (...toks) => `${toks.join('\0')}\0`;

test('parseStatusV2: 머리글·일반·이름 변경·충돌·미추적 항목, 경로의 공백·한글 보존', () => {
  const r = parseStatusV2(NUL(
    '# branch.oid abc123', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 h1 h2 sub/한글 파일 x.js',
    '2 R. N... 100644 100644 100644 h1 h2 R100 new name.txt', 'old name.txt',
    'u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict file.txt',
    '? untracked 파일.txt',
    '! ignored.log',
    '1 A. N... 000000 100644 100644 h1 h2 added.txt',
  ));
  assert.deepEqual({ ...r, entries: undefined }, {
    oid: 'abc123', initial: false, head: 'main', detached: false, upstream: 'origin/main', ahead: 2, behind: 1, entries: undefined,
  });
  assert.deepEqual(r.entries, [
    { kind: 'ordinary', x: '.', y: 'M', sub: 'N...', path: 'sub/한글 파일 x.js' },
    { kind: 'rename', x: 'R', y: '.', sub: 'N...', path: 'new name.txt', orig: 'old name.txt' },
    { kind: 'unmerged', x: 'U', y: 'U', sub: 'N...', path: 'conflict file.txt' },
    { kind: 'untracked', x: '?', y: '?', path: 'untracked 파일.txt' },
    { kind: 'ordinary', x: 'A', y: '.', sub: 'N...', path: 'added.txt' },
  ]);
});

test('parseStatusV2: 중첩 저장소·서브모듈 경로의 끝 / 를 뗀다', () => {
  const r = parseStatusV2(NUL(
    '? nested/',
    '1 .M S.M. 160000 160000 160000 h1 h2 mod/',
    '2 R. N... 100644 100644 100644 h1 h2 R100 new dir/', 'old dir/',
  ));
  assert.deepEqual(r.entries, [
    { kind: 'untracked', x: '?', y: '?', path: 'nested', nested: true },
    { kind: 'ordinary', x: '.', y: 'M', sub: 'S.M.', path: 'mod' },
    { kind: 'rename', x: 'R', y: '.', sub: 'N...', path: 'new dir', orig: 'old dir' },
  ]);
});

test('parseStatusV2: 빈 저장소·분리된 HEAD·upstream 없음, 알 수 없는 토큰은 건너뜀', () => {
  const empty = parseStatusV2(NUL('# branch.oid (initial)', '# branch.head main'));
  assert.deepEqual(empty, { oid: null, initial: true, head: 'main', detached: false, upstream: null, ahead: null, behind: null, entries: [] });
  const det = parseStatusV2(NUL('# branch.oid deadbeef', '# branch.head (detached)', '9 weird token', '? a.txt'));
  assert.equal(det.detached, true);
  assert.equal(det.head, null);
  assert.equal(det.oid, 'deadbeef');
  assert.deepEqual(det.entries.map((e) => e.path), ['a.txt'], '알 수 없는 토큰 뒤로도 계속 읽는다');
  assert.deepEqual(parseStatusV2('').entries, []);
});

// ---------- 2. statusLists ----------

test('statusLists: 양쪽 변경은 두 목록에, 이름 변경의 orig, 미추적 U, 충돌', () => {
  const l = statusLists([
    { kind: 'ordinary', x: 'M', y: 'M', path: 'm.txt' },
    { kind: 'ordinary', x: '.', y: 'D', path: 'd.txt' },
    { kind: 'rename', x: 'R', y: '.', path: 'new.txt', orig: 'old.txt' },
    { kind: 'rename', x: '.', y: 'R', path: 'n2.txt', orig: 'o2.txt' },
    { kind: 'untracked', x: '?', y: '?', path: 'u.txt' },
    { kind: 'unmerged', x: 'U', y: 'U', path: 'c.txt' },
  ]);
  assert.deepEqual(l.staged, [
    { path: 'm.txt', code: 'M' },
    { path: 'new.txt', orig: 'old.txt', code: 'R' },
  ]);
  assert.deepEqual(l.changes, [
    { path: 'm.txt', code: 'M' },
    { path: 'd.txt', code: 'D' },
    { path: 'n2.txt', orig: 'o2.txt', code: 'R' },
    { path: 'u.txt', code: 'U' },
  ]);
  assert.deepEqual(l.conflicts, [{ path: 'c.txt' }]);
});

test('statusLists: 서브모듈 내용만 더러우면(S.M.) stageable:false, 커밋이 바뀐 서브모듈은 보통 항목', () => {
  const l = statusLists([
    { kind: 'ordinary', x: '.', y: 'M', sub: 'S.M.', path: 'dirty' },
    { kind: 'ordinary', x: '.', y: 'M', sub: 'S..U', path: 'untracked-inside' },
    { kind: 'ordinary', x: '.', y: 'M', sub: 'SCM.', path: 'moved' },
    { kind: 'ordinary', x: '.', y: 'M', sub: 'N...', path: 'plain' },
  ]);
  assert.deepEqual(l.changes, [
    { path: 'dirty', code: 'M', stageable: false },
    { path: 'untracked-inside', code: 'M', stageable: false },
    { path: 'moved', code: 'M' },
    { path: 'plain', code: 'M' },
  ]);
});

test('pathSet·topPathspec·pathspecInput (sameSet 은 더 이상 없다)', () => {
  assert.equal(codeGit.sameSet, undefined);
  assert.deepEqual([...pathSet([{ path: 'A.txt', orig: 'o.txt' }, { path: 'a.txt' }])].sort(), ['A.txt', 'a.txt', 'o.txt'], '대소문자를 합치지 않는다');
  assert.equal(topPathspec('a[1].txt'), ':(top,literal)a[1].txt');
  assert.equal(pathspecInput(['x', 'y z']), 'x\0y z\0');
  assert.deepEqual(STATUS_ARGS, ['status', '--porcelain=v2', '--branch', '-z', '-uall', '--', ':/']);
});

// ---------- 3. parseLog ----------

test('parseLog: 레코드 구분·꼬리 줄바꿈·칸 부족 레코드 버림·parents·refs 분리', () => {
  const rec = (...f) => f.join('\0');
  const text = `${rec('h2', 'h1 h0', 'HEAD -> main, origin/main, tag: v1', '작성자', '1700000000', '두 번째 제목')}\x1e\n`
    + `${rec('bad', 'only', 'three')}\x1e\n`
    + `${rec('h1', '', '', 'a', '1600000000', '첫 제목')}\x1e\n`;
  const commits = parseLog(text);
  assert.deepEqual(commits, [
    { hash: 'h2', parents: ['h1', 'h0'], refs: ['HEAD -> main', 'origin/main', 'tag: v1'], author: '작성자', at: 1700000000000, subject: '두 번째 제목' },
    { hash: 'h1', parents: [], refs: [], author: 'a', at: 1600000000000, subject: '첫 제목' },
  ]);
  assert.deepEqual(parseLog(''), []);
});

// ---------- 4. errorOf ----------

test('errorOf: 문구별 code', () => {
  const fail = (stderr, extra = {}) => ({ kind: 'fail', message: 'git 실행 실패', stderr, stdout: '', ...extra });
  const table = [
    [fail("fatal: Unable to create '/r/.git/index.lock': File exists."), 'lock'],
    [fail('fatal: Another git process seems to be running in this repository'), 'lock'],
    [fail("error: could not lock config file /r/.git/config.lock': File exists"), 'lock'],
    [fail('*** Please tell me who you are.'), 'no-identity'],
    [fail('Author identity unknown'), 'no-identity'],
    [fail('fatal: unable to auto-detect email address'), 'no-identity'],
    [fail('fatal: no email was given and auto-detection is disabled'), 'no-identity'],
    [fail('Aborting commit due to empty commit message.'), 'empty'],
    [fail('nothing added to commit but untracked files present'), 'nothing'],
    [fail('no changes added to commit'), 'nothing'],
    [fail('error: Committing is not possible because you have unmerged files.'), 'unmerged'],
    [fail('error: gpg failed to sign the data'), 'sign'],
    [fail('error: failed to write commit object'), 'sign'],
    [fail('! [rejected]        main -> main (fetch first)'), 'rejected'],
    [fail('error: failed to push some refs to x'), 'fail'],
    [fail('error: src refspec main does not match any\nerror: failed to push some refs to x'), 'no-src'],
    [fail('error: failed to push some refs to x', { stdout: '!\trefs/heads/main:refs/heads/main\t[remote rejected] (pre-receive hook declined)' }), 'remote-rejected'],
    [fail('Updates were rejected because the remote contains work'), 'rejected'],
    [fail('fatal: could not read Username for https://x: terminal prompts disabled'), 'auth'],
    [fail('remote: Authentication failed'), 'auth'],
    [fail('git@x: Permission denied (publickey).'), 'auth'],
    [fail("fatal: couldn't find remote ref main"), 'no-remote-ref'],
    [fail("fatal: 'origin' does not appear to be a git repository"), 'no-remote'],
    [fail('fatal: Could not read from remote repository.'), 'no-remote'],
    [fail('fatal: unable to access https://x: Could not resolve host: x'), 'no-remote'],
    [fail("error: src refspec main does not match any"), 'no-src'],
    [fail('error: The following untracked working tree files would be overwritten by merge:'), 'overwrite'],
    [fail('CONFLICT (content): Merge conflict in f.txt'), 'conflict'],
    [fail('something odd'), 'fail'],
  ];
  for (const [e, code] of table) assert.equal(errorOf(e).code, code, e.stderr);
  assert.equal(errorOf(fail('x')).error, 'git 실행 실패:\nx');
  assert.equal(errorOf(fail('x'.repeat(500))).error.length, 'git 실행 실패:\n'.length + 200);
  assert.equal(errorOf(fail('! [rejected] main -> main')).error, '원격이 앞서 있어 푸시가 거절되었습니다.\nPull 또는 Commit & Sync 를 써 주세요.');
  assert.equal(errorOf(fail('Author identity unknown')).error, 'git 사용자 이름·이메일이 없습니다.\n터미널에서 git config 로 설정해 주세요.');
});

test('errorOf: stdout 에만 있는 문구, 시간 초과, 실행 파일 없음, hook', () => {
  assert.equal(errorOf({ kind: 'fail', message: 'm', stderr: '', stdout: 'nothing to commit, working tree clean' }).code, 'nothing');
  assert.equal(errorOf({ kind: 'fail', message: 'm', stderr: 'error: failed to push', stdout: '! refs/heads/main:refs/heads/main\t[rejected] (fetch first)' }).code, 'rejected');
  const t = errorOf({ kind: 'timeout', message: 'git 조회 시간이 초과되었습니다' });
  assert.equal(t.code, 'timeout');
  assert.equal(t.error, 'git 작업 시간이 초과되었습니다.\n잠금 파일이나 스테이징이 남았을 수 있으니\n터미널에서 git status 로 확인해 주세요.');
  assert.deepEqual(errorOf({ kind: 'no-git', message: 'git 을 찾지 못했습니다' }), { code: 'no-git', error: 'git 을 찾지 못했습니다' });
  assert.equal(errorOf({ kind: 'unsafe', message: 'u' }).code, 'unsafe');
  assert.equal(errorOf({ kind: 'nodir', message: 'n' }).code, 'nodir');

  const hook = errorOf({ kind: 'fail', exitCode: 1, message: 'm', stderr: 'lint 실패 ' + 'z'.repeat(500) }, 'commit');
  assert.equal(hook.code, 'hook');
  assert.ok(hook.error.startsWith('커밋 전 검사(hook)가 실패했습니다:\nlint 실패'), '600자 이하는 그대로');
  assert.equal(hook.error.length, '커밋 전 검사(hook)가 실패했습니다:\n'.length + 'lint 실패 '.length + 500);
  const long = errorOf({ kind: 'fail', exitCode: 1, message: 'm', stderr: 'a'.repeat(700) + 'END' }, 'commit');
  assert.ok(long.error.startsWith('커밋 전 검사(hook)가 실패했습니다:\n…\n'), '600자 초과는 앞을 줄인다');
  assert.ok(long.error.endsWith('aaaEND'), '끝 글자가 남는다');
  assert.ok(long.error.length <= '커밋 전 검사(hook)가 실패했습니다:\n…\n'.length + 600);
  const lines = errorOf({ kind: 'fail', exitCode: 1, message: 'm', stderr: Array.from({ length: 60 }, (_, i) => 'line-' + i + ' ' + 'x'.repeat(20)).join('\n') }, 'commit');
  assert.ok(lines.error.includes('\nline-59 '), '끝 줄이 남는다');
  assert.ok(/:\n…\nline-[0-9]+ /.test(lines.error), '줄 경계에서 자른다');
  assert.equal(errorOf({ kind: 'fail', exitCode: 1, message: 'm', stderr: '' }, 'commit').error, '커밋 전 검사(hook)가 실패했습니다.');
  assert.equal(errorOf({ kind: 'fail', exitCode: 1, message: 'm', stderr: '\u001b[31mred\u001b[0m 실패' }, 'commit').error, '커밋 전 검사(hook)가 실패했습니다:\nred 실패', '색 코드는 지운다');
  assert.equal(errorOf({ kind: 'fail', exitCode: 1, message: 'm', stderr: 'lint' }, 'push').code, 'fail', '커밋 단계가 아니면 hook 이 아니다');
  assert.equal(errorOf({ kind: 'fail', exitCode: 1, message: 'm', stderr: 'nothing to commit' }, 'commit').code, 'hook', 'hook 출력의 글자로 가르지 않는다');
  assert.equal(errorOf({ kind: 'fail', exitCode: 1, message: 'm', stderr: '', stdout: 'nothing to commit, working tree clean' }, 'commit').code, 'nothing', 'git 자신의 「변경 없음」은 stdout');
  assert.equal(errorOf({ kind: 'fail', exitCode: 1, message: 'm', stderr: 'hint: x\nAborting commit due to empty commit message.\n', stdout: '' }, 'commit').code, 'empty', 'git 자신의 「빈 메시지」는 stderr 끝 줄');
  assert.equal(errorOf({ kind: 'fail', exitCode: 1, message: 'm', stderr: 'Aborting commit due to empty commit message.\nhook: 이어서 출력', stdout: '' }, 'commit').code, 'hook', '끝 줄이 아니면 hook');
  assert.equal(errorOf(new Error('plain')).code, 'fail');
});

// ---------- 5. state ----------

test('state: main 깨끗 → canWrite true', { skip }, async () => {
  const repo = mkRepo('st');
  commitFile(repo, 'a.txt', 'a\n');
  const { ops } = makeOps(repo);
  const st = await ops.state(repo);
  assert.equal(st.ok, true);
  assert.equal(st.branch, 'main');
  assert.equal(st.canWrite, true);
  assert.equal(st.reason, null);
  assert.equal(st.detached, false);
  assert.equal(st.initial, false);
  assert.equal(st.merging, false);
  assert.equal(st.hasRemote, false);
  assert.equal(st.upstream, null);
  assert.equal(st.ahead, null);
  assert.equal(st.behind, null);
  assert.deepEqual([st.staged, st.changes, st.conflicts], [[], [], []]);
  assert.equal(st.prefix, '');
});

test('state: 다른 브랜치 → not-main, 분리된 HEAD → detached', { skip }, async () => {
  const repo = mkRepo('st');
  commitFile(repo, 'a.txt', 'a\n');
  git(repo, 'checkout', '-q', '-b', 'feat');
  const { ops } = makeOps(repo);
  const st = await ops.state(repo);
  assert.equal(st.branch, 'feat');
  assert.equal(st.canWrite, false);
  assert.equal(st.reason, 'not-main');

  git(repo, 'checkout', '-q', '--detach');
  const d = await ops.state(repo);
  assert.equal(d.detached, true);
  assert.equal(d.branch, null);
  assert.equal(d.canWrite, false);
  assert.equal(d.reason, 'detached');
});

test('state: 병합 충돌 → merging, conflicts', { skip }, async () => {
  const repo = mkRepo('st');
  commitFile(repo, 'f.txt', 'base\n');
  git(repo, 'checkout', '-q', '-b', 'other');
  commitFile(repo, 'f.txt', 'other\n', 'other');
  git(repo, 'checkout', '-q', 'main');
  commitFile(repo, 'f.txt', 'main\n', 'main');
  tryGit(repo, 'merge', 'other');
  const { ops } = makeOps(repo);
  const st = await ops.state(repo);
  assert.equal(st.branch, 'main');
  assert.equal(st.merging, true);
  assert.equal(st.canWrite, false);
  assert.equal(st.reason, 'merging');
  assert.deepEqual(st.conflicts, [{ path: 'f.txt' }]);
});

test('state: 빈 저장소 → initial, canWrite true', { skip }, async () => {
  const repo = mkRepo('st');
  put(repo, 'a.txt', 'a\n');
  const { ops } = makeOps(repo);
  const st = await ops.state(repo);
  assert.equal(st.ok, true);
  assert.equal(st.initial, true);
  assert.equal(st.branch, 'main');
  assert.equal(st.canWrite, true);
  assert.deepEqual(st.changes, [{ path: 'a.txt', code: 'U' }]);
});

test('state: 하위 폴더 root → 경로는 저장소 루트 기준, prefix', { skip }, async () => {
  const repo = mkRepo('st');
  commitFile(repo, 'sub/in.txt', 'in\n');
  put(repo, 'sub/in.txt', 'changed\n');
  put(repo, 'outside.txt', 'o\n');
  const sub = path.join(repo, 'sub');
  const { ops } = makeOps(sub);
  const st = await ops.state(sub);
  assert.equal(st.ok, true);
  assert.equal(st.prefix, 'sub/');
  assert.deepEqual(sortedPaths(st.changes), ['outside.txt', 'sub/in.txt']);
});

test('state: 등록 안 된 폴더 → root, 깃 아님 → not-repo', { skip }, async () => {
  const repo = mkRepo('st');
  const plain = mkdir('plain');
  const { ops } = makeOps(plain);
  assert.deepEqual(await ops.state(repo), { ok: false, code: 'root', error: '허용되지 않는 폴더입니다' });
  assert.deepEqual(await ops.state(plain), { ok: false, code: 'not-repo', error: '깃 저장소가 아닙니다' });
  assert.deepEqual(await ops.stage(repo, ['a']), { ok: false, code: 'root', error: '허용되지 않는 폴더입니다' });
  assert.deepEqual(await ops.log(repo), { ok: false, code: 'root', error: '허용되지 않는 폴더입니다' });
});

test('state: upstream·ahead·behind (bare 원격)', { skip }, async () => {
  const { repo, remoteCommit } = seedRemote();
  const { ops } = makeOps(repo);
  const st0 = await ops.state(repo);
  assert.equal(st0.hasRemote, true);
  assert.equal(st0.upstream, 'origin/main');
  assert.deepEqual([st0.ahead, st0.behind], [0, 0]);
  commitFile(repo, 'l.txt', 'l\n', 'local');
  remoteCommit('r.txt', 'r\n');
  git(repo, 'fetch', '-q', 'origin');
  const st = await ops.state(repo);
  assert.deepEqual([st.ahead, st.behind], [1, 1]);

  // 연결(upstream) 기록이 없어도 origin/main 이 있으면 rev-list 로 센다
  git(repo, 'branch', '--unset-upstream');
  const st2 = await ops.state(repo);
  assert.equal(st2.upstream, null);
  assert.deepEqual([st2.ahead, st2.behind], [1, 1]);
});

// ---------- 6. stage / unstage ----------

test('stage: 공백·한글·a[1].txt·-dash.txt 를 문자 그대로 스테이징한다', { skip }, async () => {
  const repo = mkRepo('sg');
  commitFile(repo, 'base.txt', 'b\n');
  const names = ['with space.txt', '한글.txt', 'a[1].txt', '-dash.txt', 'sub/deep.txt'];
  for (const n of names) put(repo, n, `${n}\n`);
  put(repo, 'a1.txt', 'glob 에 걸리면 안 된다\n');
  const { ops } = makeOps(repo);
  const r = await ops.stage(repo, names);
  assert.deepEqual(r, { ok: true });
  const st = await ops.state(repo);
  assert.deepEqual(sortedPaths(st.staged), [...names].sort());
  assert.deepEqual(st.changes, [{ path: 'a1.txt', code: 'U' }], 'a1.txt 는 그대로');
});

test('stage: 삭제된 파일도 스테이징된다', { skip }, async () => {
  const repo = mkRepo('sg');
  commitFile(repo, 'del.txt', 'x\n');
  fs.rmSync(path.join(repo, 'del.txt'));
  const { ops } = makeOps(repo);
  assert.deepEqual((await ops.state(repo)).changes, [{ path: 'del.txt', code: 'D' }]);
  assert.deepEqual(await ops.stage(repo, ['del.txt']), { ok: true });
  assert.deepEqual((await ops.state(repo)).staged, [{ path: 'del.txt', code: 'D' }]);
});

test('stage: 하위 폴더 root 에서 폴더 밖 파일도 (루트 기준 경로로)', { skip }, async () => {
  const repo = mkRepo('sg');
  commitFile(repo, 'sub/in.txt', 'in\n');
  put(repo, 'outside.txt', 'o\n');
  const sub = path.join(repo, 'sub');
  const { ops } = makeOps(sub);
  assert.deepEqual(await ops.stage(sub, ['outside.txt']), { ok: true });
  assert.deepEqual((await ops.state(sub)).staged, [{ path: 'outside.txt', code: 'A' }]);
  assert.deepEqual(await ops.unstage(sub, ['outside.txt']), { ok: true });
  assert.deepEqual((await ops.state(sub)).staged, []);
});

test('stage·unstage: 목록에 없는 경로·잘못된 인자는 거부한다', { skip }, async () => {
  const repo = mkRepo('sg');
  commitFile(repo, 'a.txt', 'a\n');
  put(repo, 'new.txt', 'n\n');
  const { ops } = makeOps(repo);
  const bad = { ok: false, code: 'changed', error: '변경 목록이 바뀌었습니다.\n다시 확인해 주세요.' };
  assert.deepEqual(await ops.stage(repo, ['new.txt', 'nope.txt']), bad);
  assert.deepEqual((await ops.state(repo)).staged, [], '하나라도 없으면 아무것도 하지 않는다');
  assert.deepEqual(await ops.unstage(repo, ['new.txt']), bad, '스테이징 안 된 경로는 해제할 수 없다');
  assert.deepEqual(await ops.stage(repo, ['../x']), bad);
  for (const v of [[], 'a.txt', null, [5], [''], undefined]) {
    const r = await ops.stage(repo, v);
    assert.equal(r.ok, false, JSON.stringify(v));
    assert.equal(r.code, 'bad', JSON.stringify(v));
    assert.equal(r.error, '잘못된 요청입니다');
    assert.equal((await ops.unstage(repo, v)).code, 'bad');
  }
});

test('unstage: 이름 변경은 두 경로 모두 해제된다', { skip }, async () => {
  const repo = mkRepo('sg');
  commitFile(repo, 'old.txt', 'same content here\n');
  git(repo, 'mv', 'old.txt', 'new.txt');
  const { ops } = makeOps(repo);
  const st = await ops.state(repo);
  assert.deepEqual(st.staged, [{ path: 'new.txt', orig: 'old.txt', code: 'R' }]);
  assert.deepEqual(await ops.unstage(repo, ['new.txt']), { ok: true });
  const after2 = await ops.state(repo);
  assert.deepEqual(after2.staged, []);
  assert.deepEqual(sortedPaths(after2.changes), ['new.txt', 'old.txt']);
  assert.equal(fs.readFileSync(path.join(repo, 'new.txt'), 'utf8'), 'same content here\n');
});

test('unstage: 빈 저장소의 AM 파일은 rm --cached 로 해제하고 작업 파일은 그대로', { skip }, async () => {
  const repo = mkRepo('sg');
  put(repo, 'a.txt', 'one\n');
  git(repo, 'add', 'a.txt');
  put(repo, 'a.txt', 'two\n');
  const { ops, calls } = makeOps(repo);
  const st = await ops.state(repo);
  assert.equal(st.initial, true);
  assert.deepEqual(st.staged, [{ path: 'a.txt', code: 'A' }]);
  assert.deepEqual(await ops.unstage(repo, ['a.txt']), { ok: true });
  const after2 = await ops.state(repo);
  assert.deepEqual(after2.staged, []);
  assert.deepEqual(after2.changes, [{ path: 'a.txt', code: 'U' }]);
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'two\n');
  assert.ok(calls.some((a) => a[0] === 'rm' && a.includes('--cached')));
  assert.ok(!calls.some((a) => a[0] === 'restore'));
});

test('stage·unstage: main 이 아니면 not-main, 병합 중이면 merging 으로 거부', { skip }, async () => {
  const repo = mkRepo('sg');
  commitFile(repo, 'a.txt', 'a\n');
  git(repo, 'checkout', '-q', '-b', 'feat');
  put(repo, 'n.txt', 'n\n');
  const { ops } = makeOps(repo);
  const r = await ops.stage(repo, ['n.txt']);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not-main');
  assert.equal(r.error, 'main 브랜치에서만 커밋·푸시합니다. (현재: feat)\n다른 작업은 아래 터미널에서');
  assert.equal((await ops.unstage(repo, ['n.txt'])).code, 'not-main');
  assert.deepEqual((await ops.state(repo)).staged, []);

  const m = mkRepo('sg');
  commitFile(m, 'f.txt', 'base\n');
  git(m, 'checkout', '-q', '-b', 'other');
  commitFile(m, 'f.txt', 'other\n', 'other');
  git(m, 'checkout', '-q', 'main');
  commitFile(m, 'f.txt', 'main\n', 'main');
  tryGit(m, 'merge', 'other');
  const mo = makeOps(m);
  const mr = await mo.ops.stage(m, ['f.txt']);
  assert.equal(mr.code, 'merging');
  assert.equal(mr.error, '병합 등 다른 git 작업이 진행 중입니다.\n터미널에서 마무리해 주세요.');
});

// ---------- 7. commit ----------

test('commit: 스테이징한 내용만 커밋한다 (MM 파일의 작업 폴더 줄은 안 들어감)', { skip }, async () => {
  const repo = mkRepo('cm');
  commitFile(repo, 'm.txt', 'v1\n');
  put(repo, 'm.txt', 'v2\n');
  git(repo, 'add', 'm.txt');
  put(repo, 'm.txt', 'v3\n');
  put(repo, 'other.txt', 'untouched\n');
  const { ops } = makeOps(repo);
  const before = headOf(repo);
  const r = await ops.commit(repo, { message: '두 번째', expected: ['m.txt'] });
  assert.equal(r.ok, true);
  assert.equal(r.committed, true);
  assert.equal(r.oid, headOf(repo));
  assert.notEqual(r.oid, before);
  assert.equal(git(repo, 'show', 'HEAD:m.txt'), 'v2\n');
  assert.equal(fs.readFileSync(path.join(repo, 'm.txt'), 'utf8'), 'v3\n');
  const st = await ops.state(repo);
  assert.deepEqual(st.staged, []);
  assert.deepEqual(sortedPaths(st.changes), ['m.txt', 'other.txt']);
});

test('commit: 그 사이 다른 환경이 스테이징하면 staged-changed 로 거부하고 커밋하지 않는다', { skip }, async () => {
  const repo = mkRepo('cm');
  commitFile(repo, 'a.txt', 'a\n');
  put(repo, 'a.txt', 'a2\n');
  put(repo, 'b.txt', 'b\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'add', 'b.txt'); // 렌더러는 a.txt 만 보았다
  const { ops } = makeOps(repo);
  const before = headOf(repo);
  const r = await ops.commit(repo, { message: 'x', expected: ['a.txt'] });
  assert.deepEqual(r, { ok: false, code: 'staged-changed', error: '스테이징 목록이 바뀌었습니다.\n확인한 뒤 다시 눌러 주세요.' });
  assert.equal(headOf(repo), before);
  assert.deepEqual(sortedPaths((await ops.state(repo)).staged), ['a.txt', 'b.txt']);
  const fewer = await ops.commit(repo, { message: 'x', expected: ['a.txt', 'b.txt', 'c.txt'] });
  assert.equal(fewer.code, 'staged-changed', '렌더러가 본 것보다 적어도 거부');
});

test('commit: stage 옵션으로 스테이징한 뒤 비교한다 (삭제+새 파일이 R 로 합쳐져도 통과)', { skip }, async () => {
  const repo = mkRepo('cm');
  commitFile(repo, 'old.txt', 'rename me please\n');
  fs.renameSync(path.join(repo, 'old.txt'), path.join(repo, 'new.txt'));
  const { ops } = makeOps(repo);
  const st = await ops.state(repo);
  assert.deepEqual(sortedPaths(st.changes), ['new.txt', 'old.txt']);
  const r = await ops.commit(repo, { message: '이름 변경', expected: [], stage: ['old.txt', 'new.txt'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(git(repo, 'show', '--stat', '--format=%s', 'HEAD'), /old\.txt => new\.txt|new\.txt/);
  assert.deepEqual((await ops.state(repo)).changes, []);

  // 목록에 없는 경로는 stage 로도 올릴 수 없다
  const bad = await ops.commit(repo, { message: 'x', expected: [], stage: ['nope.txt'] });
  assert.equal(bad.code, 'changed');
});

test('commit: 빈 메시지·잘못된 인자는 커밋 전에 거부한다', { skip }, async () => {
  const repo = mkRepo('cm');
  commitFile(repo, 'a.txt', 'a\n');
  put(repo, 'a.txt', 'a2\n');
  git(repo, 'add', 'a.txt');
  const { ops } = makeOps(repo);
  const before = headOf(repo);
  const msgBad = { ok: false, code: 'bad', error: '커밋 메시지를 입력해 주세요.' };
  for (const message of ['', '   \n', 5, null, undefined, 'a\0b', 'x'.repeat(20001)]) {
    assert.deepEqual(await ops.commit(repo, { message, expected: ['a.txt'] }), msgBad, String(message).slice(0, 10));
  }
  const reqBad = { ok: false, code: 'bad', error: '잘못된 요청입니다' };
  assert.deepEqual(await ops.commit(repo, { message: 'x', expected: 'a.txt' }), reqBad);
  assert.deepEqual(await ops.commit(repo, { message: 'x', expected: [5] }), reqBad);
  assert.deepEqual(await ops.commit(repo, { message: 'x', expected: ['a.txt'], stage: 'a' }), reqBad);
  assert.deepEqual(await ops.commit(repo, { message: 'x', expected: ['a.txt'], then: 'force' }), reqBad);
  assert.deepEqual(await ops.commit(repo, null), reqBad);
  assert.equal(headOf(repo), before);
  assert.equal((await ops.commit(repo, { message: 'x'.repeat(20000), expected: ['a.txt'] })).ok, true, '20000자는 허용');
});

test('commit: 한글 메시지와 # 로 시작하는 줄이 그대로 남는다', { skip }, async () => {
  const repo = mkRepo('cm');
  put(repo, 'a.txt', 'a\n');
  git(repo, 'add', 'a.txt');
  const { ops } = makeOps(repo);
  const message = '한글 제목\n\n# 이건 주석이 아닙니다\n본문 줄';
  const r = await ops.commit(repo, { message, expected: ['a.txt'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(git(repo, 'log', '-1', '--format=%B').trim(), message);
});

test('commit: 스테이징이 없으면 nothing', { skip }, async () => {
  const repo = mkRepo('cm');
  commitFile(repo, 'a.txt', 'a\n');
  put(repo, 'a.txt', 'a2\n');
  const { ops } = makeOps(repo);
  const before = headOf(repo);
  assert.deepEqual(await ops.commit(repo, { message: 'x', expected: [] }), { ok: false, code: 'nothing', error: '커밋할 변경이 없습니다' });
  assert.equal(headOf(repo), before);
});

test('commit: pre-commit hook 이 실패하면 hook 오류', { skip }, async () => {
  const repo = mkRepo('cm');
  commitFile(repo, 'a.txt', 'a\n');
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho "린트 실패 hook says no" >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  put(repo, 'a.txt', 'a2\n');
  git(repo, 'add', 'a.txt');
  const { ops } = makeOps(repo);
  const before = headOf(repo);
  const r = await ops.commit(repo, { message: 'x', expected: ['a.txt'] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'hook');
  assert.match(r.error, /^커밋 전 검사\(hook\)가 실패했습니다:\n.*hook says no/);
  assert.equal(r.committed, undefined);
  assert.equal(headOf(repo), before);
});

test('commit: main 이 아니면 not-main, 사용자 정보가 없으면 no-identity', { skip }, async () => {
  const repo = mkRepo('cm');
  commitFile(repo, 'a.txt', 'a\n');
  git(repo, 'checkout', '-q', '-b', 'feat');
  put(repo, 'n.txt', 'n\n');
  git(repo, 'add', 'n.txt');
  const { ops } = makeOps(repo);
  const before = headOf(repo);
  const r = await ops.commit(repo, { message: 'x', expected: ['n.txt'] });
  assert.equal(r.code, 'not-main');
  assert.equal(headOf(repo), before);

  const anon = mkRepo('cm', { identity: false });
  put(anon, 'a.txt', 'a\n');
  git(anon, 'add', 'a.txt');
  const a = makeOps(anon);
  const ar = await a.ops.commit(anon, { message: 'x', expected: ['a.txt'] });
  assert.equal(ar.ok, false);
  assert.equal(ar.code, 'no-identity');
  assert.equal(ar.error, 'git 사용자 이름·이메일이 없습니다.\n터미널에서 git config 로 설정해 주세요.');
});

// ---------- 8. 잠금 ----------

test('잠금: index.lock 이 있으면 재시도 뒤 lock 오류, 값으로 돌아온다 (프로세스가 죽지 않음)', { skip }, async () => {
  const repo = mkRepo('lk');
  commitFile(repo, 'a.txt', 'a\n');
  put(repo, 'n.txt', 'n\n');
  const lock = path.join(repo, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  const { ops, sleeps } = makeOps(repo);
  const r = await ops.stage(repo, ['n.txt']);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'lock');
  assert.equal(r.error, '다른 git 작업이 저장소를 잠그고 있습니다.\n잠시 뒤 다시 시도해 주세요.\n실행 중인 git 이 없는데 계속되면 .git 폴더의 index.lock 을 확인해 주세요.');
  assert.deepEqual(sleeps, [300, 700, 1500], '재시도 3번, 간격');
  fs.rmSync(lock);
  assert.deepEqual(await ops.stage(repo, ['n.txt']), { ok: true }, '잠금이 풀리면 다시 쓸 수 있다');
});

test('잠금: 재시도 중에 잠금이 사라지면 성공한다', { skip }, async () => {
  const repo = mkRepo('lk');
  commitFile(repo, 'a.txt', 'a\n');
  put(repo, 'n.txt', 'n\n');
  const lock = path.join(repo, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  const sleeps = [];
  const { ops } = makeOps(repo, { sleep: async (ms) => { sleeps.push(ms); fs.rmSync(lock, { force: true }); } });
  assert.deepEqual(await ops.stage(repo, ['n.txt']), { ok: true });
  assert.deepEqual(sleeps, [300], '한 번 기다리고 성공');
  assert.deepEqual((await ops.state(repo)).staged, [{ path: 'n.txt', code: 'A' }]);
});

// ---------- 9. 푸시·싱크 ----------

test('commit then:push: 원격이 비어 있으면 -u 로 첫 푸시', { skip }, async () => {
  const bare = mkBare();
  const repo = mkRepo('ps');
  git(repo, 'remote', 'add', 'origin', bare);
  put(repo, 'a.txt', 'a\n');
  git(repo, 'add', 'a.txt');
  const { ops, calls } = makeOps(repo);
  const r = await ops.commit(repo, { message: '첫 커밋', expected: ['a.txt'], then: 'push' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.committed, true);
  assert.equal(r.pushed, true);
  assert.equal(git(bare, 'rev-parse', 'main').trim(), headOf(repo));
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'main@{upstream}').trim(), 'origin/main');
  const push = calls.find((a) => a[0] === 'push');
  assert.deepEqual(push, ['push', '--porcelain', '-u', 'origin', 'main:main']);
});

test('commit then:push: 원격이 앞서 있으면 committed:true, ok:false, rejected', { skip }, async () => {
  const { repo, remoteCommit } = seedRemote();
  remoteCommit('r.txt', 'r\n');
  put(repo, 'l.txt', 'l\n');
  git(repo, 'add', 'l.txt');
  const { ops } = makeOps(repo);
  const r = await ops.commit(repo, { message: 'local', expected: ['l.txt'], then: 'push' });
  assert.equal(r.ok, false);
  assert.equal(r.committed, true);
  assert.equal(r.code, 'rejected');
  assert.equal(r.oid, headOf(repo));
  assert.equal(git(repo, 'log', '-1', '--format=%s').trim(), 'local');
});

test('commit then:sync: 분기된 원격을 병합한 뒤 푸시한다', { skip }, async () => {
  const { bare, repo, remoteCommit } = seedRemote();
  remoteCommit('r.txt', 'r\n');
  put(repo, 'l.txt', 'l\n');
  git(repo, 'add', 'l.txt');
  const { ops } = makeOps(repo);
  const r = await ops.commit(repo, { message: 'local', expected: ['l.txt'], then: 'sync' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.committed, true);
  assert.equal(r.pushed, true);
  assert.equal(git(bare, 'rev-parse', 'main').trim(), headOf(repo));
  assert.equal(git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').length, 3, '병합 커밋(부모 둘)');
  assert.ok(fs.existsSync(path.join(repo, 'r.txt')));
});

test('commit then:sync: 같은 줄 충돌이면 conflict, 병합은 취소되고 로컬 커밋은 남는다', { skip }, async () => {
  const { repo, remoteCommit } = seedRemote({ 'f.txt': 'base\n' });
  remoteCommit('f.txt', 'remote\n');
  put(repo, 'f.txt', 'local\n');
  const { ops } = makeOps(repo);
  const r = await ops.commit(repo, { message: 'local', expected: [], stage: ['f.txt'], then: 'sync' });
  assert.equal(r.ok, false);
  assert.equal(r.committed, true);
  assert.equal(r.code, 'conflict');
  assert.equal(r.error, '충돌이 있어 병합을 취소했습니다.\n하단 터미널에서 git pull 로 해결해 주세요.');
  assert.equal(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')), false);
  assert.equal(git(repo, 'log', '-1', '--format=%s').trim(), 'local');
  assert.equal(git(repo, 'status', '--porcelain').trim(), '');
  assert.equal(fs.readFileSync(path.join(repo, 'f.txt'), 'utf8'), 'local\n');
});

test('commit then:sync: 미추적 파일과 겹치면 overwrite', { skip }, async () => {
  const { repo, remoteCommit } = seedRemote();
  remoteCommit('x.txt', 'remote x\n');
  put(repo, 'x.txt', 'mine\n');
  put(repo, 'y.txt', 'y\n');
  git(repo, 'add', 'y.txt');
  const { ops } = makeOps(repo);
  const r = await ops.commit(repo, { message: 'y', expected: ['y.txt'], then: 'sync' });
  assert.equal(r.ok, false);
  assert.equal(r.committed, true);
  assert.equal(r.code, 'overwrite');
  assert.equal(fs.readFileSync(path.join(repo, 'x.txt'), 'utf8'), 'mine\n');
  assert.equal(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')), false);
});

test('commit then:sync: 빈 원격이면 pull 이 실패해도 푸시로 이어진다', { skip }, async () => {
  const bare = mkBare();
  const repo = mkRepo('ps');
  git(repo, 'remote', 'add', 'origin', bare);
  put(repo, 'a.txt', 'a\n');
  git(repo, 'add', 'a.txt');
  const { ops } = makeOps(repo);
  const r = await ops.commit(repo, { message: 'first', expected: ['a.txt'], then: 'sync' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.pushed, true);
  assert.equal(git(bare, 'rev-parse', 'main').trim(), headOf(repo));
});

test('commit then: 원격(origin)이 없으면 커밋 전에 거부한다', { skip }, async () => {
  const repo = mkRepo('ps');
  put(repo, 'a.txt', 'a\n');
  git(repo, 'add', 'a.txt');
  const { ops } = makeOps(repo);
  for (const then of ['push', 'sync']) {
    assert.deepEqual(await ops.commit(repo, { message: 'x', expected: ['a.txt'], then }), { ok: false, code: 'no-remote', error: 'origin 원격이 없습니다' });
  }
  assert.match(tryGit(repo, 'rev-parse', '--verify', '-q', 'HEAD'), /^ERR:/, '커밋되지 않았다');
});

test('commit then:sync: pre-merge-commit hook 이 실패하면 merge-failed 로 취소한다', { skip }, async () => {
  const { repo, remoteCommit } = seedRemote();
  remoteCommit('r.txt', 'r\n');
  const hook = path.join(repo, '.git', 'hooks', 'pre-merge-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho "merge hook no" >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  put(repo, 'l.txt', 'l\n');
  git(repo, 'add', 'l.txt');
  const { ops } = makeOps(repo);
  const r = await ops.commit(repo, { message: 'local', expected: ['l.txt'], then: 'sync' });
  assert.equal(r.ok, false);
  assert.equal(r.committed, true);
  assert.equal(r.code, 'merge-failed');
  assert.match(r.error, /^병합을 끝내지 못해 취소했습니다:\n/);
  assert.equal(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')), false);
  assert.equal(git(repo, 'status', '--porcelain').trim(), '');
});

test('강제 푸시·브랜치 전환 인자가 어디에도 없다', { skip }, async () => {
  const { repo, remoteCommit } = seedRemote({ 'f.txt': 'base\n' });
  const { ops, calls } = makeOps(repo);
  put(repo, 'a.txt', 'a\n');
  await ops.stage(repo, ['a.txt']);
  await ops.unstage(repo, ['a.txt']);
  await ops.stage(repo, ['a.txt']);
  assert.equal((await ops.commit(repo, { message: 'a', expected: ['a.txt'], then: 'push' })).ok, true);
  remoteCommit('r.txt', 'r\n');
  put(repo, 'b.txt', 'b\n');
  await ops.stage(repo, ['b.txt']);
  assert.equal((await ops.commit(repo, { message: 'b', expected: ['b.txt'], then: 'sync' })).ok, true);
  remoteCommit('f.txt', 'remote\n', 'conflict maker');
  put(repo, 'f.txt', 'local\n');
  await ops.commit(repo, { message: 'c', expected: [], stage: ['f.txt'], then: 'sync' });
  await ops.fetch(repo);
  await ops.pull(repo);
  await ops.push(repo);
  await ops.log(repo);
  await ops.state(repo);

  assert.ok(calls.some((a) => a[0] === 'push'));
  for (const a of calls) {
    if (a[0] === 'push') {
      assert.ok(!a.some((x) => x === '--force' || x === '-f' || x.startsWith('--force-') || x === '--mirror' || x === '--delete'), a.join(' '));
      assert.ok(!a.some((x) => x.startsWith('+')), `+refspec: ${a.join(' ')}`);
    }
    for (const bad of ['checkout', 'switch', 'reset', 'clean']) assert.ok(!a.includes(bad), `${bad}: ${a.join(' ')}`);
  }
});

// ---------- 10. fetch / pull ----------

test('fetch: ahead/behind 가 갱신되고 다른 브랜치에서도 동작한다', { skip }, async () => {
  const { repo, remoteCommit } = seedRemote();
  const { ops } = makeOps(repo);
  remoteCommit('r.txt', 'r\n');
  assert.equal((await ops.state(repo)).behind, 0, '가져오기 전');
  assert.deepEqual(await ops.fetch(repo), { ok: true });
  assert.equal((await ops.state(repo)).behind, 1);

  git(repo, 'checkout', '-q', '-b', 'feat');
  remoteCommit('r2.txt', 'r2\n');
  assert.deepEqual(await ops.fetch(repo), { ok: true });
  git(repo, 'checkout', '-q', 'main');
  assert.equal((await ops.state(repo)).behind, 2);
});

test('fetch: 원격이 없으면 no-remote', { skip }, async () => {
  const repo = mkRepo('fp');
  commitFile(repo, 'a.txt', 'a\n');
  const { ops } = makeOps(repo);
  assert.equal((await ops.fetch(repo)).code, 'no-remote');
});

test('pull: 원격 변경을 가져온다, main 이 아니면 거부한다', { skip }, async () => {
  const { repo, remoteCommit } = seedRemote();
  const { ops } = makeOps(repo);
  remoteCommit('r.txt', 'r\n');
  assert.deepEqual(await ops.pull(repo), { ok: true });
  assert.ok(fs.existsSync(path.join(repo, 'r.txt')));

  git(repo, 'checkout', '-q', '-b', 'feat');
  const r = await ops.pull(repo);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not-main');
  assert.equal((await ops.push(repo)).code, 'not-main');
});

// ---------- 11. 쓰기 잠금 ----------

test('쓰기 잠금: 같은 저장소의 다른 하위 폴더에서 동시에 쓰면 하나는 busy', { skip }, async () => {
  const repo = mkRepo('bz');
  commitFile(repo, 'base.txt', 'b\n');
  put(repo, 'sub1/a.txt', 'a\n');
  put(repo, 'sub2/b.txt', 'b\n');
  const sub1 = path.join(repo, 'sub1');
  const sub2 = path.join(repo, 'sub2');
  let enter;
  const entered = new Promise((r) => { enter = r; });
  let open;
  const gate = new Promise((r) => { open = r; });
  const slow = async (root, args, opts) => {
    if (args[0] === 'add') { enter(); await gate; }
    return realGit(root, args, opts);
  };
  const { ops } = makeOps([sub1, sub2], { git: slow });
  const first = ops.stage(sub1, ['sub1/a.txt']);
  await entered;
  const second = await ops.stage(sub2, ['sub2/b.txt']);
  assert.deepEqual(second, { ok: false, code: 'busy', error: '다른 Git 작업이 진행 중입니다' });
  open();
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await ops.stage(sub2, ['sub2/b.txt']), { ok: true }, '끝난 뒤에는 가능');
});

// ---------- 12. log ----------

test('log: 커밋 순서·parents·refs, 빈 저장소는 [], stash 는 제외', { skip }, async () => {
  const repo = mkRepo('lg');
  const { ops } = makeOps(repo);
  assert.deepEqual(await ops.log(repo), { ok: true, commits: [] });
  commitFile(repo, 'a.txt', '1\n', 'one');
  const h1 = headOf(repo);
  commitFile(repo, 'a.txt', '2\n', 'two');
  const h2 = headOf(repo);
  commitFile(repo, 'a.txt', '3\n', '세 번째');
  put(repo, 'a.txt', 'dirty\n');
  git(repo, 'stash', '-q');

  const r = await ops.log(repo);
  assert.equal(r.ok, true);
  assert.deepEqual(r.commits.map((c) => c.subject), ['세 번째', 'two', 'one'], 'stash 의 WIP 커밋은 없다');
  assert.deepEqual(r.commits[1].parents, [h1]);
  assert.deepEqual(r.commits[2].parents, []);
  assert.equal(r.commits[1].hash, h2);
  assert.ok(r.commits[0].refs.includes('HEAD -> main'), r.commits[0].refs.join('|'));
  assert.equal(r.commits[0].author, 't');
  assert.ok(r.commits[0].at > 1.6e12);
});

// ---------- LOOP 2회차: 리뷰 지적 회귀 테스트 ----------

const hasMergeHead = (repo) => fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'));

// main·other 가 f.txt 를 서로 다르게 고쳐, other 를 병합하면 충돌하는 원격 연결 저장소
function divergedRemote() {
  const s = seedRemote({ 'f.txt': 'base\n' });
  git(s.repo, 'checkout', '-q', '-b', 'other');
  commitFile(s.repo, 'f.txt', 'other\n', 'other');
  git(s.repo, 'checkout', '-q', 'main');
  commitFile(s.repo, 'f.txt', 'main\n', 'main');
  s.remoteCommit('r.txt', 'r\n');
  return s;
}

test('errorOf: 푸시 실패는 git 의 상태 줄·오류 줄로만 가르고, pre-push hook 은 stdout 까지 원문을 보인다', () => {
  const f = (stderr, stdout = '') => ({ kind: 'fail', exitCode: 1, message: 'm', stderr, stdout });
  const refs = "error: failed to push some refs to 'x'";
  const out = errorOf(f(refs, 'tests failed: 3 errors'), 'push');
  assert.equal(out.code, 'fail');
  assert.match(out.error, /tests failed: 3 errors/);
  assert.equal(errorOf(f(`hook check: src refspec feature does not match any\n${refs}`), 'push').code, 'fail', 'hook 의 src refspec 글자');
  assert.equal(errorOf(f(refs, 'policy [rejected] by lint'), 'push').code, 'fail', 'hook stdout 의 [rejected] 글자');
  assert.equal(errorOf(f(`error: src refspec main does not match any\n${refs}`), 'push').code, 'no-src');
  assert.equal(errorOf(f(refs, 'To x\n!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)\nDone'), 'push').code, 'rejected');
  assert.equal(errorOf(f(refs, 'To x\n!\trefs/heads/main:refs/heads/main\t[remote rejected] (declined)\nDone'), 'push').code, 'remote-rejected');
});

test('errorOf: lock 문구는 종료 코드 1(hook 출력 등)이면 lock 으로 보지 않는다, remote-rejected·꼬리 문구', () => {
  const hookOut = { kind: 'fail', exitCode: 1, message: 'm', stderr: 'hook: index.lock 을 검사합니다', stdout: '' };
  assert.equal(errorOf(hookOut, 'commit').code, 'hook');
  assert.equal(errorOf(hookOut, 'push').code, 'fail');
  assert.equal(errorOf({ kind: 'fail', exitCode: 128, message: 'm', stderr: "Unable to create '/r/.git/index.lock': File exists." }).code, 'lock');
  const rr = errorOf({ kind: 'fail', exitCode: 1, message: 'm', stderr: `remote: pre-receive says no\n${'z'.repeat(300)}`, stdout: '!\tx\t[remote rejected] (declined)' }, 'push');
  assert.equal(rr.code, 'remote-rejected');
  assert.ok(rr.error.startsWith('원격이 푸시를 거부했습니다:\n'));
  assert.equal(rr.error.length, '원격이 푸시를 거부했습니다:\n'.length + 200, 'stderr 뒤 200자');
  const tail = errorOf({ kind: 'fail', message: 'm', stderr: `${'a'.repeat(300)}끝 문구` });
  assert.ok(tail.error.endsWith('끝 문구') && tail.error.length === 'git 실행 실패:\n'.length + 200, 'fail 문구도 stderr 뒤쪽');
});

// ----- C1: pull 실패 뒤 다른 환경이 시작한 병합을 지우지 않는다 -----

test('pull: guard 뒤 다른 환경이 병합을 시작하면 abort 하지 않고 merging', { skip }, async () => {
  const { repo } = divergedRemote();
  let started = false;
  const wrap = async (root, args, opts) => {
    if (args[0] === 'pull' && !started) { started = true; tryGit(repo, 'merge', 'other'); }
    return realGit(root, args, opts);
  };
  const { ops, calls } = makeOps(repo, { git: wrap });
  const r = await ops.pull(repo);
  assert.deepEqual(r, { ok: false, code: 'merging', error: '다른 작업의 병합이 진행 중이라 건드리지 않았습니다.\n터미널에서 확인해 주세요.' });
  assert.equal(hasMergeHead(repo), true, '남이 시작한 병합이 그대로');
  assert.match(fs.readFileSync(path.join(repo, 'f.txt'), 'utf8'), /<<<<<<</, '충돌 표시가 그대로');
  assert.ok(!calls.some((a) => a[0] === 'merge'), 'merge --abort 를 부르지 않았다');
});

test('commit then:sync: pull 직전에 다른 환경이 병합을 시작해도 abort 하지 않는다', { skip }, async () => {
  const { repo } = divergedRemote();
  put(repo, 'l.txt', 'l\n');
  git(repo, 'add', 'l.txt');
  let started = false;
  const wrap = async (root, args, opts) => {
    if (args[0] === 'pull' && !started) { started = true; tryGit(repo, 'merge', 'other'); }
    return realGit(root, args, opts);
  };
  const { ops, calls } = makeOps(repo, { git: wrap });
  const r = await ops.commit(repo, { message: 'local', expected: ['l.txt'], then: 'sync' });
  assert.equal(r.ok, false);
  assert.equal(r.committed, true);
  assert.equal(r.code, 'merging');
  assert.equal(r.error, '다른 작업의 병합이 진행 중이라 건드리지 않았습니다.\n터미널에서 확인해 주세요.');
  assert.equal(hasMergeHead(repo), true);
  assert.ok(!calls.some((a) => a[0] === 'merge'));
});

test('commit then:sync: 커밋 뒤 pull 전에 병합이 시작되면 다시 읽어 guard 로 멈춘다 (pull 을 부르지 않음)', { skip }, async () => {
  const { repo } = divergedRemote();
  put(repo, 'l.txt', 'l\n');
  git(repo, 'add', 'l.txt');
  let committed = false;
  let started = false;
  const wrap = async (root, args, opts) => {
    const out = await realGit(root, args, opts);
    if (args[0] === 'commit') committed = true;
    if (committed && !started && args[0] === 'rev-parse' && args[1] === 'HEAD') { started = true; tryGit(repo, 'merge', 'other'); }
    return out;
  };
  const { ops, calls } = makeOps(repo, { git: wrap });
  const r = await ops.commit(repo, { message: 'local', expected: ['l.txt'], then: 'sync' });
  assert.equal(r.ok, false);
  assert.equal(r.committed, true);
  assert.equal(r.code, 'merging');
  assert.equal(r.error, '병합 등 다른 git 작업이 진행 중입니다.\n터미널에서 마무리해 주세요.');
  assert.ok(!calls.some((a) => a[0] === 'pull'), 'pull 을 부르지 않았다');
  assert.equal(hasMergeHead(repo), true);
});

// ----- M1: 잠금 재시도마다 스테이징 목록을 다시 비교한다 -----

test('commit: 잠금 재시도 사이에 다른 환경이 스테이징하면 staged-changed, 그 파일은 커밋되지 않는다', { skip }, async () => {
  const repo = mkRepo('m1');
  commitFile(repo, 'a.txt', 'a\n');
  put(repo, 'a.txt', 'a2\n');
  git(repo, 'add', 'a.txt');
  put(repo, 'other.txt', 'o\n');
  const lock = path.join(repo, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  const sleeps = [];
  const { ops } = makeOps(repo, { sleep: async (ms) => { sleeps.push(ms); fs.rmSync(lock, { force: true }); git(repo, 'add', 'other.txt'); } });
  const before = headOf(repo);
  const r = await ops.commit(repo, { message: 'x', expected: ['a.txt'] });
  assert.deepEqual(r, { ok: false, code: 'staged-changed', error: '스테이징 목록이 바뀌었습니다.\n확인한 뒤 다시 눌러 주세요.' });
  assert.deepEqual(sleeps, [300]);
  assert.equal(headOf(repo), before, '커밋되지 않았다');
  assert.deepEqual(sortedPaths((await ops.state(repo)).staged), ['a.txt', 'other.txt']);
});

// ----- M3: 푸시 오류 분류는 실제 git 으로 -----

test('push 오류: 커밋 없는 main(no-src), pre-push hook 실패(fail+출력), pre-receive 거부(remote-rejected), 원격 앞섬(rejected)', { skip }, async () => {
  const bare0 = mkBare();
  const empty = mkRepo('m3');
  git(empty, 'remote', 'add', 'origin', bare0);
  const e = makeOps(empty);
  const noSrc = await e.ops.push(empty);
  assert.equal(noSrc.code, 'no-src');
  assert.equal(noSrc.error, '로컬 main 브랜치가 없습니다');

  const { bare, repo, remoteCommit } = seedRemote();
  const hook = path.join(repo, '.git', 'hooks', 'pre-push');
  fs.writeFileSync(hook, '#!/bin/sh\necho "prepush-no" >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  put(repo, 'p.txt', 'p\n');
  git(repo, 'add', 'p.txt');
  const { ops } = makeOps(repo);
  const h = await ops.commit(repo, { message: 'p', expected: ['p.txt'], then: 'push' });
  assert.equal(h.ok, false);
  assert.equal(h.committed, true);
  assert.equal(h.code, 'fail');
  assert.match(h.error, /prepush-no/);
  fs.rmSync(hook);

  const recv = path.join(bare, 'hooks', 'pre-receive');
  fs.writeFileSync(recv, '#!/bin/sh\necho "receive-no" >&2\nexit 1\n');
  fs.chmodSync(recv, 0o755);
  const rr = await ops.push(repo);
  assert.equal(rr.code, 'remote-rejected', JSON.stringify(rr));
  assert.match(rr.error, /^원격이 푸시를 거부했습니다:\n/);
  assert.match(rr.error, /receive-no/);
  fs.rmSync(recv);

  remoteCommit('r.txt', 'r\n');
  const ahead = await ops.push(repo);
  assert.equal(ahead.code, 'rejected');
});

// ----- M4: 커밋 성공 뒤의 단계가 던져도 committed:true 를 유지한다 -----

test('commit: 커밋 뒤 rev-parse·read 가 실패해도 committed:true (rev-parse 실패면 oid 는 null)', { skip }, async () => {
  const mk = (failOn) => {
    let committed = false;
    return async (root, args, opts) => {
      if (committed && failOn(args)) throw Object.assign(new Error('git 실행 실패: boom'), { kind: 'fail', stderr: 'boom', exitCode: 128 });
      const out = await realGit(root, args, opts);
      if (args[0] === 'commit') committed = true;
      return out;
    };
  };
  const repo = mkRepo('m4');
  commitFile(repo, 'a.txt', 'a\n');
  put(repo, 'n.txt', 'n\n');
  git(repo, 'add', 'n.txt');
  const a = makeOps(repo, { git: mk((args) => args[0] === 'rev-parse' && args[1] === 'HEAD') });
  const r = await a.ops.commit(repo, { message: 'n', expected: ['n.txt'] });
  assert.deepEqual(r, { ok: true, committed: true, oid: null });
  assert.equal(git(repo, 'log', '-1', '--format=%s').trim(), 'n');

  const bare = mkBare();
  git(repo, 'remote', 'add', 'origin', bare);
  put(repo, 'm.txt', 'm\n');
  git(repo, 'add', 'm.txt');
  const b = makeOps(repo, { git: mk((args) => args[0] === 'status') });
  const s = await b.ops.commit(repo, { message: 'm', expected: ['m.txt'], then: 'sync' });
  assert.equal(s.ok, false);
  assert.equal(s.committed, true, '읽기 실패여도 커밋은 됐다고 알린다');
  assert.equal(s.code, 'fail');
  assert.equal(s.oid, headOf(repo));
  assert.equal(git(repo, 'log', '-1', '--format=%s').trim(), 'm');
});

// ----- M5: 서브모듈 내용만 더러운 항목, 비교 완화 -----

test('stage·commit: 내용만 더러운 서브모듈은 스테이징 대상이 아니다', { skip }, async () => {
  const src = mkRepo('subsrc');
  commitFile(src, 's.txt', 's\n');
  const repo = mkRepo('m5');
  commitFile(repo, 'a.txt', 'a\n');
  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', src, 'mod');
  git(repo, 'commit', '-q', '-m', 'add mod');
  put(repo, 'mod/s.txt', 'dirty\n');
  put(repo, 'n.txt', 'n\n');
  const { ops } = makeOps(repo);
  const st = await ops.state(repo);
  assert.deepEqual(st.changes.find((c) => c.path === 'mod'), { path: 'mod', code: 'M', stageable: false });
  assert.equal(st.changes.find((c) => c.path === 'n.txt').stageable, undefined);
  const changed = { ok: false, code: 'changed', error: '변경 목록이 바뀌었습니다.\n다시 확인해 주세요.' };
  assert.deepEqual(await ops.stage(repo, ['mod']), changed);
  const before = headOf(repo);
  assert.deepEqual(await ops.commit(repo, { message: 'x', expected: [], stage: ['mod', 'n.txt'] }), changed);
  assert.equal(headOf(repo), before);
  assert.deepEqual((await ops.state(repo)).staged, [], '아무것도 스테이징하지 않았다');
  const ok = await ops.commit(repo, { message: 'n', expected: [], stage: ['n.txt'] });
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test('commit: stage 한 파일이 HEAD 와 같아져 스테이징에서 빠져도 나머지는 커밋된다', { skip }, async () => {
  const repo = mkRepo('m5');
  commitFile(repo, 'm.txt', 'v1\n');
  put(repo, 'm.txt', 'v2\n');
  git(repo, 'add', 'm.txt');
  put(repo, 'm.txt', 'v1\n'); // 작업 파일이 HEAD 와 같아진 MM
  put(repo, 'x.txt', 'x\n');
  git(repo, 'add', 'x.txt');
  const { ops } = makeOps(repo);
  const st = await ops.state(repo);
  assert.deepEqual(sortedPaths(st.staged), ['m.txt', 'x.txt']);
  const r = await ops.commit(repo, { message: 'x', expected: ['m.txt', 'x.txt'], stage: ['m.txt'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(git(repo, 'show', '--name-only', '--format=', 'HEAD').trim(), 'x.txt');
  assert.deepEqual((await ops.state(repo)).changes, []);
});

// ----- Minor 4: 병합 외 진행 중 작업 -----

test('state: 충돌을 해결한 cherry-pick 진행 중이어도 canWrite false (merging)', { skip }, async () => {
  const repo = mkRepo('mn4');
  commitFile(repo, 'f.txt', 'base\n');
  git(repo, 'checkout', '-q', '-b', 'other');
  commitFile(repo, 'f.txt', 'other\n', 'other');
  git(repo, 'checkout', '-q', 'main');
  commitFile(repo, 'f.txt', 'main\n', 'main');
  tryGit(repo, 'cherry-pick', 'other');
  put(repo, 'f.txt', 'resolved\n');
  git(repo, 'add', 'f.txt');
  const { ops } = makeOps(repo);
  const st = await ops.state(repo);
  assert.deepEqual(st.conflicts, [], '충돌은 이미 해결됐다');
  assert.equal(st.merging, true);
  assert.equal(st.canWrite, false);
  assert.equal(st.reason, 'merging');
  assert.equal((await ops.stage(repo, ['f.txt'])).code, 'merging');
});

test('state: 하위 폴더 root 에서도 병합 상태가 보인다', { skip }, async () => {
  const repo = mkRepo('mn4');
  commitFile(repo, 'sub/f.txt', 'base\n');
  git(repo, 'checkout', '-q', '-b', 'other');
  commitFile(repo, 'sub/f.txt', 'other\n', 'other');
  git(repo, 'checkout', '-q', 'main');
  commitFile(repo, 'sub/f.txt', 'main\n', 'main');
  tryGit(repo, 'merge', 'other');
  const sub = path.join(repo, 'sub');
  const { ops } = makeOps(sub);
  const st = await ops.state(sub);
  assert.equal(st.merging, true);
  assert.equal(st.reason, 'merging');
  assert.deepEqual(st.conflicts, [{ path: 'sub/f.txt' }]);
});

// ----- 테스트 공백 -----

test('pull: 충돌이면 conflict, 병합은 취소돼 작업 폴더가 깨끗하다 (pull 직접 호출)', { skip }, async () => {
  const { repo, remoteCommit } = seedRemote({ 'f.txt': 'base\n' });
  remoteCommit('f.txt', 'remote\n');
  commitFile(repo, 'f.txt', 'local\n', 'local');
  const { ops } = makeOps(repo);
  const r = await ops.pull(repo);
  assert.deepEqual(r, { ok: false, code: 'conflict', error: '충돌이 있어 병합을 취소했습니다.\n하단 터미널에서 git pull 로 해결해 주세요.' });
  assert.equal(hasMergeHead(repo), false);
  assert.equal(git(repo, 'status', '--porcelain').trim(), '');
  assert.equal(fs.readFileSync(path.join(repo, 'f.txt'), 'utf8'), 'local\n');
});

test('pull: merge --abort 가 실패하면 abort-failed', { skip }, async () => {
  const { repo, remoteCommit } = seedRemote({ 'f.txt': 'base\n' });
  remoteCommit('f.txt', 'remote\n');
  commitFile(repo, 'f.txt', 'local\n', 'local');
  const wrap = async (root, args, opts) => {
    if (args[0] === 'merge' && args.includes('--abort')) throw Object.assign(new Error('git 실행 실패: no'), { kind: 'fail', stderr: 'no', exitCode: 128 });
    return realGit(root, args, opts);
  };
  const { ops } = makeOps(repo, { git: wrap });
  const r = await ops.pull(repo);
  assert.deepEqual(r, { ok: false, code: 'abort-failed', error: '병합 취소에 실패했습니다.\n터미널에서 git merge --abort 를 실행해 주세요.' });
  assert.equal(hasMergeHead(repo), true, '취소하지 못했으니 병합 상태가 남아 있다');
});

test('pull: 가져오는 사이 브랜치가 바뀌면 branch-changed', { skip }, async () => {
  const { repo, remoteCommit } = seedRemote();
  remoteCommit('r.txt', 'r\n');
  const wrap = async (root, args, opts) => {
    const out = await realGit(root, args, opts);
    if (args[0] === 'pull') git(repo, 'checkout', '-q', '-b', 'feat');
    return out;
  };
  const { ops } = makeOps(repo, { git: wrap });
  const r = await ops.pull(repo);
  assert.deepEqual(r, { ok: false, code: 'branch-changed', error: '작업 중 브랜치가 바뀌었습니다.\n터미널에서 확인해 주세요.' });
});

test('timeout: git 이 kind:timeout 을 던지면 값으로 돌아온다 (스테이징·커밋)', { skip }, async () => {
  const repo = mkRepo('to');
  commitFile(repo, 'a.txt', 'a\n');
  put(repo, 'n.txt', 'n\n');
  const err = () => Object.assign(new Error('git 조회 시간이 초과되었습니다'), { kind: 'timeout' });
  const addT = makeOps(repo, { git: async (root, args, opts) => { if (args[0] === 'add') throw err(); return realGit(root, args, opts); } });
  const expectMsg = 'git 작업 시간이 초과되었습니다.\n잠금 파일이나 스테이징이 남았을 수 있으니\n터미널에서 git status 로 확인해 주세요.';
  assert.deepEqual(await addT.ops.stage(repo, ['n.txt']), { ok: false, code: 'timeout', error: expectMsg });
  git(repo, 'add', 'n.txt');
  const comT = makeOps(repo, { git: async (root, args, opts) => { if (args[0] === 'commit') throw err(); return realGit(root, args, opts); } });
  const r = await comT.ops.commit(repo, { message: 'n', expected: ['n.txt'] });
  assert.deepEqual(r, { ok: false, code: 'timeout', error: expectMsg });
  assert.equal(comT.sleeps.length, 0, '시간 초과는 재시도하지 않는다');
});

test('commit: hook 출력에 index.lock 글자가 있어도 재시도하지 않고 hook 오류', { skip }, async () => {
  const repo = mkRepo('mn6');
  commitFile(repo, 'a.txt', 'a\n');
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho "index.lock 을 검사하다 실패" >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  put(repo, 'a.txt', 'a2\n');
  git(repo, 'add', 'a.txt');
  const { ops, sleeps } = makeOps(repo);
  const r = await ops.commit(repo, { message: 'x', expected: ['a.txt'] });
  assert.equal(r.code, 'hook');
  assert.deepEqual(sleeps, []);
});

// ---------- LOOP 3회차: 재검토 지적 회귀 테스트 ----------

test('statusLists: 서브모듈 폴더 삭제(.D S...)는 스테이징할 수 있다', () => {
  const l = statusLists([
    { kind: 'ordinary', x: '.', y: 'D', sub: 'S...', path: 'dep' },
    { kind: 'ordinary', x: '.', y: 'M', sub: 'S.M.', path: 'dirty' },
  ]);
  assert.deepEqual(l.changes, [{ path: 'dep', code: 'D' }, { path: 'dirty', code: 'M', stageable: false }]);
});

test('stage: 서브모듈 폴더를 지우면 삭제를 스테이징할 수 있다', { skip }, async () => {
  const src = mkRepo('subsrc');
  commitFile(src, 's.txt', 's\n');
  const repo = mkRepo('mb');
  commitFile(repo, 'a.txt', 'a\n');
  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', src, 'dep');
  git(repo, 'commit', '-q', '-m', 'add dep');
  fs.rmSync(path.join(repo, 'dep'), { recursive: true, force: true });
  const { ops } = makeOps(repo);
  const st = await ops.state(repo);
  assert.deepEqual(st.changes.find((c) => c.path === 'dep'), { path: 'dep', code: 'D' });
  assert.deepEqual(await ops.stage(repo, ['dep']), { ok: true });
  assert.deepEqual((await ops.state(repo)).staged, [{ path: 'dep', code: 'D' }]);
});

test('commit: 커밋이 HEAD 를 옮긴 뒤 시간 초과가 나면 committed:true 로 알린다', { skip }, async () => {
  const repo = mkRepo('ma');
  commitFile(repo, 'a.txt', 'a\n');
  put(repo, 'n.txt', 'n\n');
  git(repo, 'add', 'n.txt');
  const before = headOf(repo);
  const wrap = async (root, args, opts) => {
    const out = await realGit(root, args, opts);
    if (args[0] === 'commit') throw Object.assign(new Error('git 조회 시간이 초과되었습니다'), { kind: 'timeout' }); // post-commit hook 이 오래 걸린 경우
    return out;
  };
  const { ops, sleeps } = makeOps(repo, { git: wrap });
  const r = await ops.commit(repo, { message: 'n', expected: ['n.txt'] });
  assert.equal(r.ok, false);
  assert.equal(r.committed, true);
  assert.equal(r.code, 'timeout');
  assert.equal(r.oid, headOf(repo));
  assert.notEqual(r.oid, before);
  assert.match(r.error, /^git 작업 시간이 초과되었습니다/);
  assert.equal(sleeps.length, 0);
});

// 다른 환경이 같은 원격 커밋을 병합하다 충돌로 멈춰 있고 사용자가 그 파일을 고치는 중 (MERGE_HEAD === FETCH_HEAD)
function sameCommitMergeInProgress() {
  const s = seedRemote({ 'f.txt': 'base\n' });
  s.remoteCommit('f.txt', 'remote\n');
  commitFile(s.repo, 'f.txt', 'local\n', 'local');
  const startExternal = () => {
    tryGit(s.repo, 'pull', '--no-rebase', '--no-edit', s.bare, 'main');
    put(s.repo, 'f.txt', 'user edit in progress\n');
  };
  return { ...s, startExternal };
}

test('pull: 외부가 같은 원격 커밋을 병합 중이어도(MERGE_HEAD===FETCH_HEAD) 우리가 시작한 병합이 아니면 abort 하지 않는다', { skip }, async () => {
  const { repo, startExternal } = sameCommitMergeInProgress();
  let started = false;
  const wrap = async (root, args, opts) => {
    if (args[0] === 'pull' && !started) { started = true; startExternal(); }
    return realGit(root, args, opts);
  };
  const { ops, calls } = makeOps(repo, { git: wrap });
  const r = await ops.pull(repo);
  assert.deepEqual(r, { ok: false, code: 'merging', error: '다른 작업의 병합이 진행 중이라 건드리지 않았습니다.\n터미널에서 확인해 주세요.' });
  assert.equal(hasMergeHead(repo), true);
  assert.equal(fs.readFileSync(path.join(repo, 'f.txt'), 'utf8'), 'user edit in progress\n', '사용자가 고친 내용이 남아 있다');
  assert.ok(!calls.some((a) => a[0] === 'merge'), 'merge --abort 를 부르지 않았다');
});

test('pull: 우리 fetch 가 실패해 외부가 남긴 FETCH_HEAD 만 있으면 abort 하지 않는다', { skip }, async () => {
  const { repo, startExternal } = sameCommitMergeInProgress();
  let started = false;
  const wrap = async (root, args, opts) => {
    if (args[0] === 'pull' && !started) {
      started = true;
      startExternal();
      throw Object.assign(new Error('git 실행 실패: fatal: unable to access remote'), { kind: 'fail', stderr: 'fatal: unable to access remote', stdout: '', exitCode: 1 });
    }
    return realGit(root, args, opts);
  };
  const { ops, calls } = makeOps(repo, { git: wrap });
  const r = await ops.pull(repo);
  assert.equal(r.code, 'merging');
  assert.equal(hasMergeHead(repo), true);
  assert.equal(fs.readFileSync(path.join(repo, 'f.txt'), 'utf8'), 'user edit in progress\n');
  assert.ok(!calls.some((a) => a[0] === 'merge'));
});

// ---------- 로그인 창(GCM) 재시도 ----------
// 네트워크 명령(push·fetch·pull)은 가짜가 steps 대로 답한다 — 실제 원격·GCM 은 절대 부르지 않는다. 나머지(상태·커밋 등)는 임시 저장소의 진짜 git.

const HTTPS = 'https://example.invalid/r.git';
const GH = "!'C:/Program Files/GitHub CLI/gh.exe' auth git-credential"; // gh 가 넣는 도우미 설정값 모양
const failErr = (stderr, extra) => Object.assign(new Error(`git 실행 실패: ${stderr}`), { kind: 'fail', exitCode: 128, stderr, stdout: '', ...extra });
const NO_READ = () => failErr("fatal: could not read Username for 'https://example.invalid': terminal prompts disabled");
const REJECT = () => failErr("remote: Invalid username or token.\nfatal: Authentication failed for 'https://example.invalid/r.git/'");
const throws = (mk) => () => { throw mk(); };
const NET_CMDS = new Set(['push', 'fetch', 'pull']);

// net: { push|fetch|pull: [단계...] }. 단계는 'ok'(빈 출력) · 'real'(GCM 인자를 떼고 진짜 git) · 함수(root, args, opts, real) — 던지거나 값을 돌려준다.
// helper: get-urlmatch 가 돌려줄 값, 또는 { exit } 로 그 종료 코드의 실패. url: remote get-url 값.
function netFake({ url = HTTPS, helper = GH, net = {} } = {}) {
  const queues = Object.fromEntries(Object.entries(net).map(([k, v]) => [k, [...v]]));
  const netCalls = []; // { cmd, args, opts }
  const lookups = []; // 재시도 판단용 조회
  const fake = async (root, args, opts) => {
    let i = 0;
    while (args[i] === '-c') i += 2;
    const cmd = args[i];
    if (cmd === 'remote' && args[i + 1] === 'get-url') { lookups.push('get-url'); return `${url}\n`; }
    if (cmd === 'config' && args[i + 1] === '--get-urlmatch') {
      lookups.push('get-urlmatch');
      if (typeof helper === 'object') throw failErr('config', { exitCode: helper.exit });
      return `${helper}\n`;
    }
    if (!NET_CMDS.has(cmd)) return realGit(root, args, opts);
    netCalls.push({ cmd, args, opts });
    const step = (queues[cmd] || []).shift();
    if (step === undefined) throw new Error(`시나리오에 없는 ${cmd} 호출: ${args.join(' ')}`);
    if (step === 'ok') return '';
    const real = () => realGit(root, args.slice(i), opts);
    if (step === 'real') return real();
    return step(root, args, opts, real);
  };
  return { fake, netCalls, lookups, of: (cmd) => netCalls.filter((c) => c.cmd === cmd) };
}
const hasGcm = (args) => GCM_ARGS.every((x, k) => args[k] === x);
const startsWithCommand = (args, cmd) => args[0] === cmd;

test('isAuthFailure: 마지막 줄이 진짜 인증 실패 문구일 때만 참', () => {
  const f = (stderr, stdout = '') => ({ kind: 'fail', stderr, stdout });
  assert.equal(isAuthFailure(f("fatal: could not read Username for 'https://github.com': terminal prompts disabled")), true);
  assert.equal(isAuthFailure(f("fatal: could not read Password for 'https://u@github.com': terminal prompts disabled")), true);
  assert.equal(isAuthFailure(f("remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/o/r.git/'\n")), true);
  // 마지막 줄이 아닌 글자·다른 끝 줄에는 속지 않는다
  assert.equal(isAuthFailure(f('error: Your local changes to the following files would be overwritten by merge:\n\tAuthentication failed.txt\nAborting')), false, '파일 이름');
  assert.equal(isAuthFailure(f("remote: hook says Authentication failed for 'x'\nerror: failed to push some refs to 'https://example.invalid/r.git'")), false, 'hook 출력 뒤 끝 줄');
  assert.equal(isAuthFailure(f("remote: Authentication failed for 'x'\nfatal: something else")), false, '다른 끝 줄');
  assert.equal(isAuthFailure(f("fatal: Authentication failed for 'https://example.invalid/sub.git/'\nfatal: Fetched in submodule path 'sub', but it did not contain abc. Direct fetching of that commit failed.")), false, '서브모듈 끝 줄');
  assert.equal(isAuthFailure(f("fatal: Authentication failed for 'https://example.invalid/r.git/'", 'CONFLICT (content): Merge conflict in f.txt')), false, 'stdout 의 CONFLICT');
  assert.equal(isAuthFailure(f("fatal: Authentication failed for 'https://example.invalid/r.git/'\nAutomatic merge failed; fix conflicts")), false);
  assert.equal(isAuthFailure({ kind: 'timeout', stderr: "fatal: Authentication failed for 'https://example.invalid/r.git/'" }), false, 'kind 가 fail 이 아님');
  assert.equal(isAuthFailure(null), false);
});

test('errorOf: 네트워크 시간 초과(net)는 로그인 창 안내, 그 밖의 시간 초과 문구는 그대로', () => {
  const net = errorOf({ kind: 'timeout', net: true }, 'push');
  assert.equal(net.code, 'timeout');
  assert.equal(net.error, '원격 작업 시간이 초과되었습니다.\n로그인 창이 열려 있었다면 다시 시도해 주세요.');
  assert.equal(errorOf({ kind: 'timeout' }, 'commit').error, 'git 작업 시간이 초과되었습니다.\n잠금 파일이나 스테이징이 남았을 수 있으니\n터미널에서 git status 로 확인해 주세요.');
  // 인증 문구: gh 로 로그인한 원격이면 gh auth login, 아니면 git push
  const stderr = "fatal: could not read Username for 'https://example.invalid': terminal prompts disabled";
  assert.equal(errorOf({ kind: 'fail', stderr, viaGh: true }, 'push').error, '원격 인증에 실패했습니다.\n하단 터미널에서 gh auth login 으로 로그인해 주세요.');
  assert.equal(errorOf({ kind: 'fail', stderr }, 'push').error, '원격 인증에 실패했습니다.\n하단 터미널에서 git push 로 로그인해 주세요.');
  assert.equal(errorOf({ kind: 'fail', stderr }, 'push').code, 'auth');
});

test('환경: 네트워크 명령은 로그인 창 허용(터미널 입력만 끔), 로컬 쓰기는 창도 끈다', () => {
  assert.deepEqual(NET_ENV, { GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', GIT_TERMINAL_PROMPT: '0' });
  assert.equal('GCM_INTERACTIVE' in NET_ENV, false);
  assert.deepEqual(WRITE_ENV, { GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
  assert.equal(NET_TIMEOUT_MS, 300000);
  // 저장 공간은 -c 가 아니라 환경 변수로: GCM_NAMESPACE 는 사용자의 URL 전용 설정까지 이기고, -c credential.namespace 는 진다 (실측)
  assert.deepEqual(GCM_ARGS, ['-c', 'credential.helper=', '-c', 'credential.helper=manager']);
  assert.deepEqual(GCM_ENV, { ...NET_ENV, GCM_NAMESPACE: 'agent-office' });
});

test('시험 안전장치: 진짜 git 에 GCM 인자를 보내면 던진다', async () => {
  const repo = mkRepo('guard');
  await assert.rejects(realGit(repo, ['-c', 'credential.helper=manager', 'status']), /실제 GCM 호출 금지/);
  const { ops } = makeOps(repo, { git: undefined });
  // 기본 git(realGit) 으로 만든 Ops 도 rec 에서 막힌다 (ops 는 GCM 인자를 만들지 않으므로 상태 조회는 정상)
  assert.equal((await ops.state(repo)).ok, true);
});

test('push: 인증 실패 + gh → GCM 전용 인자로 한 번 더, 두 호출 모두 네트워크 옵션', { skip }, async () => {
  const { repo } = seedRemote();
  const fk = netFake({ net: { push: [throws(NO_READ), 'ok'] } });
  const { ops } = makeOps(repo, { git: fk.fake });
  assert.deepEqual(await ops.push(repo), { ok: true });
  const pushes = fk.of('push');
  assert.equal(pushes.length, 2);
  assert.equal(startsWithCommand(pushes[0].args, 'push'), true, '첫 시도는 그대로');
  assert.equal(hasGcm(pushes[1].args), true);
  assert.deepEqual(pushes[1].args.slice(GCM_ARGS.length), pushes[0].args, '둘째는 GCM 인자 + 같은 명령');
  for (const p of pushes) {
    assert.equal(p.opts.timeoutMs, NET_TIMEOUT_MS);
    assert.equal(p.opts.track, true);
    assert.ok(!p.args.some((x) => x.includes('credential.namespace')), '저장 공간은 인자가 아니라 환경 변수');
  }
  assert.equal(pushes[0].opts.env, NET_ENV, '첫 시도: 사용자 기본 설정 그대로');
  assert.equal('GCM_NAMESPACE' in pushes[0].opts.env, false);
  assert.deepEqual(pushes[1].opts.env, { ...NET_ENV, GCM_NAMESPACE: 'agent-office' }, '재시도: 앱 전용 저장 공간');
});

test('push: 재시도도 could not read(창을 닫음) + gh → 네트워크 2회로 끝, auth, gh auth login 안내', { skip }, async () => {
  const { repo } = seedRemote();
  const fk = netFake({ net: { push: [throws(NO_READ), throws(NO_READ)] } });
  const { ops } = makeOps(repo, { git: fk.fake });
  const r = await ops.push(repo);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'auth');
  assert.match(r.error, /gh auth login/);
  assert.equal(fk.of('push').length, 2);
});

test('push: 재시도가 Authentication failed(전용 항목 거부) + gh → 한 번 더, 그래도 실패하면 auth', { skip }, async () => {
  const { repo } = seedRemote();
  const ok = netFake({ net: { push: [throws(NO_READ), throws(REJECT), 'ok'] } });
  assert.deepEqual(await makeOps(repo, { git: ok.fake }).ops.push(repo), { ok: true });
  assert.equal(ok.of('push').length, 3);
  assert.equal(hasGcm(ok.of('push')[2].args), true);
  const bad = netFake({ net: { push: [throws(NO_READ), throws(REJECT), throws(REJECT)] } });
  const r = await makeOps(repo, { git: bad.fake }).ops.push(repo);
  assert.equal(r.code, 'auth');
  assert.equal(bad.of('push').length, 3, '최대 3번');
});

test('push: 도우미가 manager — could not read 는 재시도 없음, Authentication failed 는 접두어 없이 한 번 더', { skip }, async () => {
  const { repo } = seedRemote();
  const one = netFake({ helper: 'manager', net: { push: [throws(NO_READ)] } });
  const r1 = await makeOps(repo, { git: one.fake }).ops.push(repo);
  assert.equal(r1.code, 'auth');
  assert.match(r1.error, /git push/);
  assert.doesNotMatch(r1.error, /gh auth login/);
  assert.equal(one.of('push').length, 1);

  const again = netFake({ helper: 'manager', net: { push: [throws(REJECT), 'ok'] } });
  assert.deepEqual(await makeOps(repo, { git: again.fake }).ops.push(repo), { ok: true });
  assert.equal(again.of('push').length, 2);
  assert.equal(startsWithCommand(again.of('push')[1].args, 'push'), true, '접두어 없이 그대로');

  const twice = netFake({ helper: 'manager', net: { push: [throws(REJECT), throws(REJECT)] } });
  assert.equal((await makeOps(repo, { git: twice.fake }).ops.push(repo)).code, 'auth');
  assert.equal(twice.of('push').length, 2, '또 실패하면 끝');
});

test('push: 도우미 설정이 없으면(exit 1) GCM 재시도, 그 밖의 config 실패는 재시도 없음', { skip }, async () => {
  const { repo } = seedRemote();
  const none = netFake({ helper: { exit: 1 }, net: { push: [throws(NO_READ), 'ok'] } });
  assert.deepEqual(await makeOps(repo, { git: none.fake }).ops.push(repo), { ok: true });
  assert.equal(hasGcm(none.of('push')[1].args), true);
  const noneFail = netFake({ helper: { exit: 1 }, net: { push: [throws(NO_READ), throws(NO_READ)] } });
  const r = await makeOps(repo, { git: noneFail.fake }).ops.push(repo);
  assert.equal(r.code, 'auth');
  assert.match(r.error, /git push/);

  const broken = netFake({ helper: { exit: 128 }, net: { push: [throws(NO_READ)] } });
  assert.equal((await makeOps(repo, { git: broken.fake }).ops.push(repo)).code, 'auth');
  assert.equal(broken.of('push').length, 1, 'config 실패면 재시도하지 않는다');
});

test('push: SSH·http·URL 에 자격이 든 원격과 그 밖의 도우미(aws)는 재시도 없음, https://u@host 는 재시도', { skip }, async () => {
  const { repo } = seedRemote();
  for (const url of ['git@example.invalid:o/r.git', 'ssh://git@example.invalid/o/r.git', 'http://example.invalid/r.git', 'https://u:tok@example.invalid/r.git']) {
    const fk = netFake({ url, net: { push: [throws(NO_READ)] } });
    assert.equal((await makeOps(repo, { git: fk.fake }).ops.push(repo)).code, 'auth', url);
    assert.equal(fk.of('push').length, 1, url);
    assert.deepEqual(fk.lookups, ['get-url'], `${url}: get-urlmatch 를 부르지 않는다`);
  }
  const user = netFake({ url: 'https://u@example.invalid/r.git', net: { push: [throws(NO_READ), 'ok'] } });
  assert.deepEqual(await makeOps(repo, { git: user.fake }).ops.push(repo), { ok: true });
  assert.equal(hasGcm(user.of('push')[1].args), true);

  const aws = netFake({ helper: '!aws codecommit credential-helper $@', net: { push: [throws(NO_READ)] } });
  assert.equal((await makeOps(repo, { git: aws.fake }).ops.push(repo)).code, 'auth');
  assert.equal(aws.of('push').length, 1);
});

test('push·fetch: 인증이 아닌 실패(거절·호스트 없음·시간 초과)는 재시도도 조회도 없다, 네트워크 시간 초과는 로그인 창 안내', { skip }, async () => {
  const { repo } = seedRemote();
  const rejected = netFake({ net: { push: [throws(() => failErr("error: failed to push some refs to 'https://example.invalid/r.git'", { exitCode: 1, stdout: '!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)' }))] } });
  assert.equal((await makeOps(repo, { git: rejected.fake }).ops.push(repo)).code, 'rejected');
  const noHost = netFake({ net: { fetch: [throws(() => failErr('fatal: unable to access \'https://example.invalid/r.git/\': Could not resolve host: example.invalid'))] } });
  assert.equal((await makeOps(repo, { git: noHost.fake }).ops.fetch(repo)).code, 'no-remote');
  const timeout = () => Object.assign(new Error('git 조회 시간이 초과되었습니다'), { kind: 'timeout' });
  const slow = netFake({ net: { push: [throws(timeout)], fetch: [throws(timeout)] } });
  const { ops } = makeOps(repo, { git: slow.fake });
  const t1 = await ops.push(repo);
  const t2 = await ops.fetch(repo);
  for (const t of [t1, t2]) {
    assert.equal(t.code, 'timeout');
    assert.match(t.error, /로그인 창/);
  }
  for (const fk of [rejected, noHost, slow]) {
    assert.equal(fk.of('push').length + fk.of('fetch').length, fk === slow ? 2 : 1);
    assert.deepEqual(fk.lookups, [], '인증 실패가 아니면 get-url 도 부르지 않는다');
  }
});

test('pull: fetch → 다시 읽기 → pull 순서, 로그인 없이 성공하면 접두어도 없다', { skip }, async () => {
  const { repo } = seedRemote();
  const fk = netFake({ net: { fetch: ['ok'], pull: ['ok'] } });
  const { ops, calls } = makeOps(repo, { git: fk.fake });
  assert.deepEqual(await ops.pull(repo), { ok: true, upToDate: true });
  const at = (cmd) => calls.findIndex((a) => a[0] === cmd);
  const readBetween = calls.slice(at('fetch') + 1, at('pull')).some((a) => a[0] === 'status');
  assert.ok(at('fetch') >= 0 && at('fetch') < at('pull'), 'fetch 가 pull 보다 먼저');
  assert.equal(readBetween, true, '둘 사이에 상태를 다시 읽는다');
  assert.equal(startsWithCommand(fk.of('pull')[0].args, 'pull'), true);
  assert.deepEqual(fk.of('pull')[0].args, ['pull', '--no-rebase', '--no-edit', 'origin', 'main']);
  assert.deepEqual(fk.of('fetch')[0].args, ['fetch', 'origin', 'main']);
  const f0 = fk.of('fetch')[0].opts;
  assert.deepEqual([f0.env, f0.timeoutMs, f0.track], [NET_ENV, NET_TIMEOUT_MS, true]);
  // pull 단계: 로그인은 fetch 에서 끝났으니 창을 띄우지 않고(GCM_INTERACTIVE never), 앱을 꺼도 끝까지 가도록 추적하지 않는다
  const p0 = fk.of('pull')[0].opts;
  assert.deepEqual(p0.env, { ...NET_ENV, GCM_INTERACTIVE: 'never' });
  assert.equal('GCM_NAMESPACE' in p0.env, false, '인증이 그대로면 전용 저장 공간 없음');
  assert.equal(p0.timeoutMs, NET_TIMEOUT_MS);
  assert.equal(p0.track, undefined);
});

test('pull: fetch 가 재시도로 성공하면 pull 도 같은 GCM 인자로', { skip }, async () => {
  const { repo } = seedRemote();
  const fk = netFake({ net: { fetch: [throws(NO_READ), 'ok'], pull: ['ok'] } });
  assert.deepEqual(await makeOps(repo, { git: fk.fake }).ops.pull(repo), { ok: true, upToDate: true });
  const pull = fk.of('pull')[0].args;
  assert.equal(hasGcm(pull), true);
  assert.deepEqual(pull.slice(GCM_ARGS.length), ['pull', '--no-rebase', '--no-edit', 'origin', 'main']);
  const o = fk.of('pull')[0].opts;
  assert.deepEqual(o.env, { ...NET_ENV, GCM_NAMESPACE: 'agent-office', GCM_INTERACTIVE: 'never' }, '같은 전용 저장 공간, 창은 띄우지 않는다');
  assert.equal(o.track, undefined);
  assert.ok(!pull.some((x) => x.includes('credential.namespace')));
});

test('pull: fetch 재시도 중 브랜치가 바뀌면 pull·merge 를 부르지 않고 not-main', { skip }, async () => {
  const { repo } = seedRemote();
  const fk = netFake({ net: { fetch: [throws(NO_READ), () => { git(repo, 'checkout', '-q', '-b', 'feat'); return ''; }] } });
  const { ops, calls } = makeOps(repo, { git: fk.fake });
  const r = await ops.pull(repo);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not-main');
  assert.equal(fk.of('pull').length, 0);
  assert.ok(!calls.some((a) => a[0] === 'merge'));
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feat');
});

test('pull: fetch 인증 실패 뒤 재시도도 실패하면 pull·merge 를 부르지 않는다', { skip }, async () => {
  const { repo } = seedRemote();
  const fk = netFake({ net: { fetch: [throws(NO_READ), throws(NO_READ)] } });
  const { ops, calls } = makeOps(repo, { git: fk.fake });
  const r = await ops.pull(repo);
  assert.equal(r.code, 'auth');
  assert.equal(fk.of('pull').length, 0);
  assert.ok(!calls.some((a) => a[0] === 'merge'));
});

test('pull: 재시도로 받은 뒤 둘째 단계 pull 이 충돌이면 merge --abort 한 번, conflict', { skip }, async () => {
  const { repo, remoteCommit } = seedRemote({ 'f.txt': 'base\n' });
  remoteCommit('f.txt', 'remote\n');
  commitFile(repo, 'f.txt', 'local\n', 'local');
  const fk = netFake({ net: { fetch: [throws(NO_READ), 'real'], pull: ['real'] } });
  const { ops, calls } = makeOps(repo, { git: fk.fake });
  const r = await ops.pull(repo);
  assert.equal(r.code, 'conflict');
  assert.equal(hasMergeHead(repo), false, '병합은 취소됐다');
  assert.equal(calls.filter((a) => a[0] === 'merge').length, 1);
  assert.deepEqual(calls.find((a) => a[0] === 'merge'), ['merge', '--abort']);
  assert.equal(hasGcm(fk.of('pull')[0].args), true, '둘째 단계도 GCM 인자');
  assert.equal(git(repo, 'status', '--porcelain').trim(), '');
});

test('pull: 재시도 둘째 단계 중 다른 세션이 병합을 시작하면 merging, abort 하지 않는다', { skip }, async () => {
  const { repo } = divergedRemote();
  const external = (root, args, opts, real) => { tryGit(repo, 'merge', 'other'); return real(); };
  const fk = netFake({ net: { fetch: [throws(NO_READ), 'real'], pull: [external] } });
  const { ops, calls } = makeOps(repo, { git: fk.fake });
  const r = await ops.pull(repo);
  assert.equal(r.code, 'merging');
  assert.equal(hasMergeHead(repo), true, '남이 시작한 병합이 그대로');
  assert.ok(!calls.some((a) => a[0] === 'merge'));
});

test('commit then:sync: fetch 도 push 도 인증 실패 뒤 재시도로 성공한다', { skip }, async () => {
  const { repo } = seedRemote();
  put(repo, 'l.txt', 'l\n');
  git(repo, 'add', 'l.txt');
  const fk = netFake({ net: { fetch: [throws(NO_READ), 'ok'], pull: ['ok'], push: [throws(NO_READ), 'ok'] } });
  const { ops } = makeOps(repo, { git: fk.fake });
  const r = await ops.commit(repo, { message: 'local', expected: ['l.txt'], then: 'sync' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.pushed, true);
  assert.equal(fk.of('fetch').length, 2);
  assert.equal(hasGcm(fk.of('push')[1].args), true);
  assert.equal(hasGcm(fk.of('pull')[0].args), true);
});

test('commit then: fetch·push 최종 실패여도 committed:true 를 유지하고, fetch 가 실패하면 push 를 부르지 않는다', { skip }, async () => {
  const { repo } = seedRemote();
  put(repo, 'l.txt', 'l\n');
  git(repo, 'add', 'l.txt');
  const sync = netFake({ net: { fetch: [throws(NO_READ), throws(NO_READ)] } });
  const r = await makeOps(repo, { git: sync.fake }).ops.commit(repo, { message: 'one', expected: ['l.txt'], then: 'sync' });
  assert.equal(r.ok, false);
  assert.equal(r.committed, true);
  assert.equal(r.code, 'auth');
  assert.equal(sync.of('push').length, 0, 'fetch 최종 실패 뒤에는 push 하지 않는다');
  assert.equal(git(repo, 'log', '-1', '--format=%s').trim(), 'one');

  put(repo, 'm.txt', 'm\n');
  git(repo, 'add', 'm.txt');
  const push = netFake({ net: { push: [throws(NO_READ), throws(NO_READ)] } });
  const p = await makeOps(repo, { git: push.fake }).ops.commit(repo, { message: 'two', expected: ['m.txt'], then: 'push' });
  assert.equal(p.ok, false);
  assert.equal(p.committed, true);
  assert.equal(p.code, 'auth');
  assert.equal(push.of('push').length, 2);
});

test('재시도 중에도 같은 저장소의 다른 호출은 busy', { skip }, async () => {
  const { repo } = seedRemote();
  let enter;
  const entered = new Promise((r) => { enter = r; });
  let open;
  const gate = new Promise((r) => { open = r; });
  const fk = netFake({ net: { push: [throws(NO_READ), async () => { enter(); await gate; return ''; }] } });
  const { ops } = makeOps(repo, { git: fk.fake });
  const first = ops.push(repo);
  await entered;
  assert.deepEqual(await ops.fetch(repo), { ok: false, code: 'busy', error: '다른 Git 작업이 진행 중입니다' });
  open();
  assert.deepEqual(await first, { ok: true });
});

test('env: 스테이징·커밋·merge --abort 는 WRITE_ENV(track 없음), fetch·pull 은 네트워크 옵션 (진짜 git, 로컬 bare 원격)', { skip }, async () => {
  const { repo, remoteCommit } = seedRemote({ 'f.txt': 'base\n' });
  remoteCommit('f.txt', 'remote\n');
  commitFile(repo, 'f.txt', 'local\n', 'local');
  const { ops, calls, callOpts } = makeOps(repo);
  assert.equal((await ops.pull(repo)).code, 'conflict'); // fetch → pull → merge --abort
  put(repo, 'n.txt', 'n\n');
  assert.deepEqual(await ops.stage(repo, ['n.txt']), { ok: true });
  assert.equal((await ops.commit(repo, { message: 'n', expected: ['n.txt'] })).ok, true);
  const seen = new Set();
  calls.forEach((a, i) => {
    const o = callOpts[i] || {};
    if (['add', 'commit', 'merge'].includes(a[0])) {
      seen.add(a[0]);
      assert.deepEqual(o.env, WRITE_ENV, a.join(' '));
      assert.equal(o.track, undefined, `${a.join(' ')}: 로컬 쓰기는 추적하지 않는다`);
    }
    if (['fetch', 'pull'].includes(a[0])) {
      seen.add(a[0]);
      if (a[0] === 'fetch') assert.deepEqual([o.env, o.timeoutMs, o.track], [NET_ENV, NET_TIMEOUT_MS, true], a.join(' '));
      else assert.deepEqual([o.env, o.timeoutMs, o.track, o.refuseClosing], [{ ...NET_ENV, GCM_INTERACTIVE: 'never' }, NET_TIMEOUT_MS, undefined, true], a.join(' '));
    }
  });
  assert.deepEqual([...seen].sort(), ['add', 'commit', 'fetch', 'merge', 'pull']);
});

// ---------- 완료 리뷰 반영: pull 단계·저장 공간 환경 변수·도우미 판별 ----------

const timeoutErr = () => Object.assign(new Error('git 조회 시간이 초과되었습니다'), { kind: 'timeout' });
const remoteConflictFail = () => failErr("remote: CONFLICT with maintenance window\nfatal: unable to access 'https://example.invalid/r.git/': Could not resolve host: example.invalid");

test('pull: fetch 가 remote: 줄의 CONFLICT 와 함께 실패하는 동안 외부 병합이 시작돼도 abort 하지 않고 고친 내용을 지킨다', { skip }, async () => {
  const { repo, startExternal } = sameCommitMergeInProgress();
  const fk = netFake({ net: { fetch: [() => { startExternal(); throw remoteConflictFail(); }] } });
  const { ops, calls } = makeOps(repo, { git: fk.fake });
  const r = await ops.pull(repo);
  assert.equal(r.code, 'merging');
  assert.equal(hasMergeHead(repo), true, '남이 시작한 병합이 그대로');
  assert.equal(fs.readFileSync(path.join(repo, 'f.txt'), 'utf8'), 'user edit in progress\n', '사용자가 고친 내용이 남아 있다');
  assert.ok(!calls.some((a) => a[0] === 'merge'), 'merge --abort 를 부르지 않았다');
  assert.equal(fk.of('pull').length, 0);
});

test('pull: pull 단계의 remote: 줄만 CONFLICT 인 실패도 우리 병합의 증거가 아니다 (abort 없음)', { skip }, async () => {
  const { repo, startExternal } = sameCommitMergeInProgress();
  const fk = netFake({ net: { fetch: ['ok'], pull: [() => { startExternal(); throw failErr("remote: CONFLICT notice\nfatal: unable to access 'https://example.invalid/r.git/'"); }] } });
  const { ops, calls } = makeOps(repo, { git: fk.fake });
  const r = await ops.pull(repo);
  assert.equal(r.code, 'merging');
  assert.equal(hasMergeHead(repo), true);
  assert.equal(fs.readFileSync(path.join(repo, 'f.txt'), 'utf8'), 'user edit in progress\n');
  assert.ok(!calls.some((a) => a[0] === 'merge'));
});

test('pull: fetch 인증 실패(재시도 포함) 중 외부 병합이 시작되면 auth 가 아니라 merging, abort 없음', { skip }, async () => {
  const { repo } = divergedRemote();
  const fk = netFake({ net: { fetch: [throws(NO_READ), () => { tryGit(repo, 'merge', 'other'); throw NO_READ(); }] } });
  const { ops, calls } = makeOps(repo, { git: fk.fake });
  const r = await ops.pull(repo);
  assert.equal(r.code, 'merging');
  assert.equal(hasMergeHead(repo), true);
  assert.ok(!calls.some((a) => a[0] === 'merge'));
  assert.equal(fk.of('pull').length, 0);
});

test('pull 단계: 시간 초과는 기존 git status 안내(로그인 창 안내 아님), fetch 시간 초과는 로그인 창 안내', { skip }, async () => {
  const { repo } = seedRemote();
  const pullT = netFake({ net: { fetch: ['ok'], pull: [throws(timeoutErr)] } });
  const a = await makeOps(repo, { git: pullT.fake }).ops.pull(repo);
  assert.equal(a.code, 'timeout');
  assert.match(a.error, /git status/);
  assert.doesNotMatch(a.error, /로그인 창/);
  const fetchT = netFake({ net: { fetch: [throws(timeoutErr)] } });
  const b = await makeOps(repo, { git: fetchT.fake }).ops.pull(repo);
  assert.equal(b.code, 'timeout');
  assert.match(b.error, /로그인 창/);
});

test('pull 단계: 인증 실패는 도우미에 맞는 안내 (gh → gh auth login, manager → git push)', { skip }, async () => {
  const { repo } = seedRemote();
  const gh = netFake({ net: { fetch: ['ok'], pull: [throws(NO_READ)] } });
  const a = await makeOps(repo, { git: gh.fake }).ops.pull(repo);
  assert.equal(a.code, 'auth');
  assert.match(a.error, /gh auth login/);
  assert.equal(gh.of('pull').length, 1, 'pull 단계는 재시도하지 않는다');
  const gcm = netFake({ helper: 'manager', net: { fetch: ['ok'], pull: [throws(NO_READ)] } });
  const b = await makeOps(repo, { git: gcm.fake }).ops.pull(repo);
  assert.equal(b.code, 'auth');
  assert.match(b.error, /git push/);
});

test('pull: 도우미가 manager 이고 fetch 가 거부되면 접두어 없이 한 번 더, pull 도 빈 접두어·전용 저장 공간 없음', { skip }, async () => {
  const { repo } = seedRemote();
  const fk = netFake({ helper: 'manager', net: { fetch: [throws(REJECT), 'ok'], pull: ['ok'] } });
  assert.deepEqual(await makeOps(repo, { git: fk.fake }).ops.pull(repo), { ok: true, upToDate: true });
  assert.equal(fk.of('fetch').length, 2);
  assert.equal(startsWithCommand(fk.of('fetch')[1].args, 'fetch'), true);
  assert.equal(fk.of('fetch')[1].opts.env, NET_ENV);
  const p = fk.of('pull')[0];
  assert.equal(startsWithCommand(p.args, 'pull'), true, '빈 접두어');
  assert.deepEqual(p.opts.env, { ...NET_ENV, GCM_INTERACTIVE: 'never' });
});

test('도우미 판별: gh 의 여러 표기는 GCM 재시도, glab 은 재시도 없음', { skip }, async () => {
  const { repo } = seedRemote();
  for (const helper of [GH, "!'C:\\Program Files\\GitHub CLI\\gh.exe' auth git-credential", '!gh auth git-credential', '!/usr/bin/gh auth git-credential']) {
    const fk = netFake({ helper, net: { push: [throws(NO_READ), 'ok'] } });
    assert.deepEqual(await makeOps(repo, { git: fk.fake }).ops.push(repo), { ok: true }, helper);
    assert.equal(hasGcm(fk.of('push')[1].args), true, helper);
  }
  const glab = netFake({ helper: '!glab auth git-credential', net: { push: [throws(NO_READ)] } });
  assert.equal((await makeOps(repo, { git: glab.fake }).ops.push(repo)).code, 'auth');
  assert.equal(glab.of('push').length, 1, 'glab 은 gh 가 아니다');
});

test('도우미 판별: manager 의 여러 표기는 접두어 없이 한 번 더(전용 저장 공간 없음), 이름만 닮은 것은 재시도 없음', { skip }, async () => {
  const { repo } = seedRemote();
  for (const helper of ['manager', 'manager-core', 'C:/x/git-credential-manager.exe', "!'C:\\x\\git-credential-manager.exe' --y"]) {
    const fk = netFake({ helper, net: { push: [throws(REJECT), 'ok'] } });
    assert.deepEqual(await makeOps(repo, { git: fk.fake }).ops.push(repo), { ok: true }, helper);
    const second = fk.of('push')[1];
    assert.equal(startsWithCommand(second.args, 'push'), true, helper);
    assert.equal(second.opts.env, NET_ENV, `${helper}: 전용 저장 공간 없음`);
    assert.equal('GCM_NAMESPACE' in second.opts.env, false, helper);
  }
  for (const helper of ['!1password-manager-helper', 'C:\\Users\\manager\\foo.exe']) {
    const fk = netFake({ helper, net: { push: [throws(REJECT)] } });
    assert.equal((await makeOps(repo, { git: fk.fake }).ops.push(repo)).code, 'auth', helper);
    assert.equal(fk.of('push').length, 1, `${helper}: manager 가 아니다`);
  }
});

// ---------- sync (커밋 없이 가져온 뒤 푸시) ----------

const noCommit = (calls) => assert.equal(calls.some((a) => a[0] === 'commit'), false, '커밋 호출이 없다');

test('sync: 거절된 Commit & Push 뒤 sync 하면 내 커밋과 원격 커밋이 모두 원격 main 에 있고 ahead 0', { skip }, async () => {
  const { bare, repo, remoteCommit } = seedRemote();
  remoteCommit('r.txt', 'r\n', 'remote');
  put(repo, 'l.txt', 'l\n');
  git(repo, 'add', 'l.txt');
  const { ops, calls } = makeOps(repo);
  const first = await ops.commit(repo, { message: 'local', expected: ['l.txt'], then: 'push' });
  assert.equal(first.code, 'rejected');
  const before = calls.length;
  assert.deepEqual(await ops.sync(repo), { ok: true, pushed: true, left: 0 });
  noCommit(calls.slice(before));
  const subjects = git(bare, 'log', 'main', '--format=%s').split('\n');
  assert.ok(subjects.includes('local') && subjects.includes('remote'), subjects.join(','));
  assert.equal(git(bare, 'rev-parse', 'main').trim(), headOf(repo));
  const st = await ops.state(repo);
  assert.equal(st.ahead, 0);
  assert.equal(st.behind, 0);
});

test('sync: 받을 것만 있으면(ahead 0) 가져오기만 하고 푸시를 부르지 않는다 (pushed:false)', { skip }, async () => {
  const { repo, remoteCommit } = seedRemote();
  remoteCommit('r.txt', 'r\n');
  const { ops, calls } = makeOps(repo);
  assert.deepEqual(await ops.sync(repo), { ok: true, pushed: false, left: 0 });
  assert.ok(fs.existsSync(path.join(repo, 'r.txt')));
  assert.equal(calls.some((a) => a[0] === 'push'), false, '푸시 호출 없음');
  noCommit(calls);
});

test('sync: 올릴 커밋이 있으면 푸시한다 (pushed:true, 원격 반영)', { skip }, async () => {
  const { bare, repo } = seedRemote();
  commitFile(repo, 'l.txt', 'l\n', 'local');
  const { ops, calls } = makeOps(repo);
  assert.deepEqual(await ops.sync(repo), { ok: true, pushed: true, left: 0 });
  assert.equal(git(bare, 'rev-parse', 'main').trim(), headOf(repo));
  assert.equal(calls.filter((a) => a[0] === 'push').length, 1);
});

test('sync: 스테이징하지 않은 파일이 있어도 진행하고, 파일은 그대로이며 스테이징되지 않는다', { skip }, async () => {
  const { bare, repo, remoteCommit } = seedRemote({ 'seed.txt': 'seed\n', 'other.txt': 'o\n' });
  remoteCommit('r.txt', 'r\n');
  commitFile(repo, 'l.txt', 'l\n', 'local');
  put(repo, 'seed.txt', 'edited\n'); // 추적 파일의 작업 폴더 수정
  put(repo, 'wip.txt', 'wip\n'); // 미추적
  const { ops, calls } = makeOps(repo);
  const r = await ops.sync(repo);
  assert.deepEqual(r, { ok: true, pushed: true, left: 2 }, JSON.stringify(r));
  noCommit(calls);
  assert.equal(fs.readFileSync(path.join(repo, 'seed.txt'), 'utf8'), 'edited\n');
  assert.equal(fs.readFileSync(path.join(repo, 'wip.txt'), 'utf8'), 'wip\n');
  assert.equal(git(repo, 'status', '--porcelain').split('\n').filter(Boolean).sort().join('|'), ' M seed.txt|?? wip.txt', '스테이징된 것이 없다');
  assert.equal(git(bare, 'rev-parse', 'main').trim(), headOf(repo));
});

test('sync: 받을 파일이 작업 폴더 파일과 겹치면 overwrite, 푸시를 부르지 않는다', { skip }, async () => {
  const { repo, remoteCommit } = seedRemote();
  remoteCommit('x.txt', 'remote x\n');
  commitFile(repo, 'y.txt', 'y\n', 'local');
  put(repo, 'x.txt', 'mine\n');
  const { ops, calls } = makeOps(repo);
  const r = await ops.sync(repo);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'overwrite');
  assert.equal(calls.some((a) => a[0] === 'push'), false, '푸시 호출 없음');
  noCommit(calls);
  assert.equal(fs.readFileSync(path.join(repo, 'x.txt'), 'utf8'), 'mine\n');
  assert.equal(hasMergeHead(repo), false);
});

test('sync: 충돌이면 conflict, merge --abort 한 번, 푸시 없이 내 커밋을 지킨다', { skip }, async () => {
  const { repo, remoteCommit } = seedRemote({ 'f.txt': 'base\n' });
  remoteCommit('f.txt', 'remote\n');
  commitFile(repo, 'f.txt', 'local\n', 'local');
  const mine = headOf(repo);
  const { ops, calls } = makeOps(repo);
  const r = await ops.sync(repo);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'conflict');
  assert.equal(calls.filter((a) => a[0] === 'merge').length, 1);
  assert.deepEqual(calls.find((a) => a[0] === 'merge'), ['merge', '--abort']);
  assert.equal(calls.some((a) => a[0] === 'push'), false, '푸시 호출 없음');
  noCommit(calls);
  assert.equal(hasMergeHead(repo), false);
  assert.equal(headOf(repo), mine, '내 커밋 유지');
  assert.equal(git(repo, 'status', '--porcelain').trim(), '');
});

test('sync: main 이 아니면 not-main, 병합 중이면 merging, 원격이 없으면 no-remote (네트워크 호출 없음)', { skip }, async () => {
  const feat = seedRemote();
  git(feat.repo, 'checkout', '-q', '-b', 'feat');
  const f = makeOps(feat.repo);
  assert.equal((await f.ops.sync(feat.repo)).code, 'not-main');

  const mid = divergedRemote();
  tryGit(mid.repo, 'merge', 'other'); // 충돌 상태로 병합 중
  assert.equal(hasMergeHead(mid.repo), true);
  const m = makeOps(mid.repo);
  assert.equal((await m.ops.sync(mid.repo)).code, 'merging');
  assert.equal(hasMergeHead(mid.repo), true, '남의 병합을 건드리지 않는다');

  const lone = mkRepo('lone');
  commitFile(lone, 'a.txt', 'a\n');
  const l = makeOps(lone);
  assert.deepEqual(await l.ops.sync(lone), { ok: false, code: 'no-remote', error: 'origin 원격이 없습니다' });

  for (const o of [f, m, l]) assert.equal(o.calls.some((a) => ['fetch', 'pull', 'push', 'merge'].includes(a[0])), false, '네트워크·병합 호출 없음');
});

test('sync: 허용되지 않은 폴더는 root, 같은 저장소에서 진행 중이면 busy', { skip }, async () => {
  const { repo } = seedRemote();
  const { ops } = makeOps(repo);
  assert.equal((await ops.sync(path.join(base, 'nope'))).code, 'root');

  let enter;
  const entered = new Promise((r) => { enter = r; });
  let open;
  const gate = new Promise((r) => { open = r; });
  const fk = netFake({ net: { fetch: [async () => { enter(); await gate; return ''; }], pull: ['ok'], push: ['ok'] } });
  const busy = makeOps(repo, { git: fk.fake });
  const first = busy.ops.sync(repo);
  await entered;
  assert.deepEqual(await busy.ops.sync(repo), { ok: false, code: 'busy', error: '다른 Git 작업이 진행 중입니다' });
  open();
  assert.deepEqual(await first, { ok: true, pushed: false, left: 0 });
});

test('sync: fetch·push 인증 실패는 각각 GCM 전용 인자로 한 번 더 (가짜 git), 커밋 호출은 없다', { skip }, async () => {
  const { repo } = seedRemote();
  commitFile(repo, 'l.txt', 'l\n', 'local');
  const fk = netFake({ net: { fetch: [throws(NO_READ), 'ok'], pull: ['ok'], push: [throws(NO_READ), 'ok'] } });
  const { ops, calls } = makeOps(repo, { git: fk.fake });
  const r = await ops.sync(repo);
  assert.deepEqual(r, { ok: true, pushed: true, left: 0 }, JSON.stringify(r));
  assert.equal(fk.of('fetch').length, 2);
  assert.equal(hasGcm(fk.of('fetch')[1].args), true);
  assert.equal(hasGcm(fk.of('pull')[0].args), true, 'pull 도 같은 인자');
  assert.equal(fk.of('push').length, 2);
  assert.equal(hasGcm(fk.of('push')[1].args), true);
  noCommit(calls);
});

const netCalled = (calls) => calls.some((a) => ['fetch', 'pull', 'push', 'merge'].includes(a[0]));

test('sync 옛 상태 검사: 스테이징이 있으면 staged-changed, fetch·pull·push 를 부르지 않는다', { skip }, async () => {
  const { repo } = seedRemote();
  commitFile(repo, 'l.txt', 'l\n', 'local');
  put(repo, 'n.txt', 'n\n');
  git(repo, 'add', 'n.txt');
  const { ops, calls } = makeOps(repo);
  for (const req of [undefined, { hasMessage: false }, { hasMessage: true }]) {
    assert.deepEqual(await ops.sync(repo, req), { ok: false, code: 'staged-changed', error: '스테이징 목록이 바뀌었습니다.\n확인한 뒤 다시 눌러 주세요.' });
  }
  assert.equal(netCalled(calls), false);
  noCommit(calls);
});

test('sync 옛 상태 검사: 메시지가 있는데 스테이징 안 한 변경이 있으면 changed, 호출 없음. 메시지가 없으면 진행하고 파일은 그대로, left 는 변경 개수', { skip }, async () => {
  const { repo } = seedRemote({ 'seed.txt': 'seed\n', 'old.txt': 'a\nb\nc\nd\ne\n' });
  commitFile(repo, 'l.txt', 'l\n', 'local');
  put(repo, 'wip.txt', 'wip\n');
  const msg = makeOps(repo);
  assert.deepEqual(await msg.ops.sync(repo, { hasMessage: true }), { ok: false, code: 'changed', error: '변경 목록이 바뀌었습니다.\n다시 확인해 주세요.' });
  assert.equal(netCalled(msg.calls), false);
  // 메시지가 없으면: 미추적 1 + 이름 변경 1 (경로는 둘이지만 한 항목) = left 2
  fs.renameSync(path.join(repo, 'old.txt'), path.join(repo, 'new.txt'));
  git(repo, 'add', '-N', 'new.txt');
  const { ops, calls } = makeOps(repo);
  const st = await ops.state(repo);
  assert.deepEqual(st.changes.map((c) => c.code).sort(), ['R', 'U'], JSON.stringify(st.changes));
  assert.equal(st.staged.length, 0);
  const r = await ops.sync(repo, { hasMessage: false });
  assert.deepEqual(r, { ok: true, pushed: true, left: 2 }, JSON.stringify(r));
  assert.equal(fs.readFileSync(path.join(repo, 'wip.txt'), 'utf8'), 'wip\n');
  assert.equal(fs.existsSync(path.join(repo, 'new.txt')), true);
  noCommit(calls);
});

test('sync: 이름 변경 한 항목만 있으면 left 는 1', { skip }, async () => {
  const { repo } = seedRemote({ 'old.txt': 'a\nb\nc\nd\ne\n' });
  fs.renameSync(path.join(repo, 'old.txt'), path.join(repo, 'new.txt'));
  git(repo, 'add', '-N', 'new.txt');
  const { ops } = makeOps(repo);
  assert.deepEqual(await ops.sync(repo, { hasMessage: false }), { ok: true, pushed: false, left: 1 });
});

test('sync: 잘못된 req 는 bad (아무것도 부르지 않는다)', { skip }, async () => {
  const { repo, remoteCommit } = seedRemote();
  remoteCommit('r.txt', 'r\n');
  const { ops, calls } = makeOps(repo);
  const bad = { ok: false, code: 'bad', error: '잘못된 요청입니다' };
  for (const req of ['x', 5, true, {}, { hasMessage: 'yes' }, { hasMessage: 1 }, { hasMessage: null }]) assert.deepEqual(await ops.sync(repo, req), bad, JSON.stringify(req));
  assert.equal(calls.length, 0, 'git 호출 없음');
  assert.equal((await ops.sync(repo, null)).ok, true, 'null 은 req 없음과 같다');
});

test('sync: 더러운 폴더에서 충돌이면 conflict, abort 한 번, 스테이징 안 한 파일·미추적 파일·내 커밋이 그대로', { skip }, async () => {
  const { repo, remoteCommit } = seedRemote({ 'f.txt': 'base\n', 'g.txt': 'g\n' });
  remoteCommit('f.txt', 'remote\n');
  commitFile(repo, 'f.txt', 'local\n', 'local');
  const mine = headOf(repo);
  put(repo, 'g.txt', 'g edited\n');
  put(repo, 'wip.txt', 'wip\n');
  const { ops, calls } = makeOps(repo);
  const r = await ops.sync(repo, { hasMessage: false });
  assert.equal(r.code, 'conflict');
  assert.equal(calls.filter((a) => a[0] === 'merge').length, 1);
  assert.deepEqual(calls.find((a) => a[0] === 'merge'), ['merge', '--abort']);
  assert.equal(calls.some((a) => a[0] === 'push'), false);
  assert.equal(hasMergeHead(repo), false);
  assert.equal(headOf(repo), mine, '내 커밋 유지');
  assert.equal(fs.readFileSync(path.join(repo, 'g.txt'), 'utf8'), 'g edited\n');
  assert.equal(fs.readFileSync(path.join(repo, 'wip.txt'), 'utf8'), 'wip\n');
  assert.equal(git(repo, 'status', '--porcelain').split('\n').filter(Boolean).sort().join('|'), ' M g.txt|?? wip.txt');
  noCommit(calls);
});

test('sync: 가져온 뒤 푸시가 실패하면 그 사실을 밝히고, 병합은 남아 다시 sync 하면 성공한다', { skip }, async () => {
  const { bare, repo, remoteCommit } = seedRemote();
  remoteCommit('r.txt', 'r\n');
  commitFile(repo, 'l.txt', 'l\n', 'local');
  const rejected = () => failErr("error: failed to push some refs to 'https://example.invalid/r.git'", { exitCode: 1, stdout: '!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)' });
  const fk = netFake({ net: { fetch: ['real'], pull: ['real'], push: [throws(rejected)] } });
  const { ops, calls } = makeOps(repo, { git: fk.fake });
  const r = await ops.sync(repo);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'rejected');
  assert.equal(r.error, '가져왔지만 푸시하지 못했습니다.\n원격이 앞서 있어 푸시가 거절되었습니다.\nPull 또는 Commit & Sync 를 써 주세요.');
  noCommit(calls);
  assert.ok(fs.existsSync(path.join(repo, 'r.txt')), '가져온 것은 남는다');
  assert.equal(git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').length, 3, '병합 커밋이 남는다');
  const again = netFake({ net: { fetch: ['real'], pull: ['real'], push: ['real'] } });
  const second = makeOps(repo, { git: again.fake });
  assert.deepEqual(await second.ops.sync(repo), { ok: true, pushed: true, left: 0 });
  assert.equal(git(bare, 'rev-parse', 'main').trim(), headOf(repo));
});

test('sync: 추적 upstream 이 없고 origin/main 만 있으면 -u 로 연결해 푸시한다', { skip }, async () => {
  const { bare, repo } = seedRemote();
  git(repo, 'branch', '--unset-upstream');
  commitFile(repo, 'l.txt', 'l\n', 'local');
  const { ops, calls } = makeOps(repo);
  assert.equal((await ops.state(repo)).upstream, null);
  assert.deepEqual(await ops.sync(repo), { ok: true, pushed: true, left: 0 });
  assert.deepEqual(calls.find((a) => a[0] === 'push'), ['push', '--porcelain', '-u', 'origin', 'main:main']);
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'main@{upstream}').trim(), 'origin/main');
  assert.equal(git(bare, 'rev-parse', 'main').trim(), headOf(repo));
});

test('sync: fetch 가 끝내 인증 실패면 auth, 푸시를 부르지 않는다', { skip }, async () => {
  const { repo } = seedRemote();
  commitFile(repo, 'l.txt', 'l\n', 'local');
  const fk = netFake({ net: { fetch: [throws(NO_READ), throws(NO_READ)] } });
  const { ops, calls } = makeOps(repo, { git: fk.fake });
  const r = await ops.sync(repo);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'auth');
  assert.equal(fk.of('push').length, 0);
  noCommit(calls);
});

// ---------- 안내 문구 규칙 ----------

test('errorOf: 문장이 끝나는 곳에서 줄을 바꾸고 「주세요」 뒤에는 마침표', () => {
  const fail = (stderr, extra = {}) => ({ kind: 'fail', message: 'git 실행 실패', stderr, stdout: '', ...extra });
  assert.equal(errorOf(fail('Aborting commit due to empty commit message.')).error, '커밋 메시지를 입력해 주세요.');
  assert.equal(errorOf(fail('error: Committing is not possible because you have unmerged files.')).error, '충돌이 해결되지 않았습니다.\n터미널에서 마무리해 주세요.');
  assert.equal(errorOf(fail('error: gpg failed to sign the data')).error, '커밋 서명에 실패했습니다.\n터미널에서 확인해 주세요.');
  assert.equal(errorOf(fail('error: The following untracked working tree files would be overwritten by merge:')).error,
    '가져오는 변경이 커밋하지 않은 파일과 겹쳐 중단했습니다.\n터미널에서 확인해 주세요.');
  assert.equal(errorOf(fail('x'), 'push').error, 'git 실행 실패:\nx');
  assert.equal(errorOf({ kind: 'fail', message: 'git 실행 실패:\nboom', stderr: '', stdout: '' }).error, 'git 실행 실패:\nboom', 'stderr 가 비면 message 의 접두어를 떼고 다시 붙인다');
  assert.equal(errorOf({ kind: 'fail', message: 'git 실행 실패: boom', stderr: '', stdout: '' }).error, 'git 실행 실패:\nboom', '옛 한 줄 접두어도 뗀다');
  assert.equal(errorOf({ kind: 'timeout', net: true }).error, '원격 작업 시간이 초과되었습니다.\n로그인 창이 열려 있었다면 다시 시도해 주세요.');
});

test('문구 규칙: 소스의 문구에서 「주세요」 뒤에는 항상 마침표가 온다 (주석 제외)', () => {
  for (const rel of ['src/main/codeGit.cjs', 'src/main/codeAnalysis.cjs', 'src/renderer/code/gitModel.js', 'src/renderer/code/gitPanel.js', 'src/shared/i18n/ko/code.js']) {
    const text = fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    const bad = text.split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => /주세요(?!\.)/.test(l.replace(/(^|\s)\/\/ .*$/, '')));
    assert.deepEqual(bad, [], `${rel}: 「주세요」 뒤에 마침표가 없다`);
  }
});

// ---------- 전용 오류 안내: unrelated · no-access · repo-not-found · ff-only (stderr 마지막 줄로만 가른다) ----------

const MSG_UNRELATED = '로컬과 원격의 커밋 기록이 서로 이어져 있지 않아 병합하지 않았습니다.\n같은 프로젝트가 맞다면 터미널에서 아래 명령으로 합쳐 주세요.\ngit pull --no-rebase --no-edit --ff --allow-unrelated-histories origin main';
// 403: 원격이 보낸 remote: 줄이 있으면 접두어째 「원격 메시지」로 덧붙는다 (앱 안내로 보이지 않게)
const msgNoAccess = (remote) => `원격이 접근을 거부했습니다. (403)\n저장소 권한·로그인 계정·토큰 범위·조직 SSO 를 확인해 주세요.${remote ? `\n원격 메시지:\n${remote}` : ''}`;
const MSG_NOT_FOUND = '원격 저장소를 찾을 수 없습니다.\n저장소 주소나 로그인한 계정의 권한을 확인해 주세요.';
const MSG_FF_ONLY = '빨리 감기만 허용하는 설정 때문에 병합하지 않았습니다.\n터미널에서 아래 명령으로 병합해 주세요.\ngit pull --no-rebase --no-edit --ff origin main';

test('errorOf: 전용 안내 4종 — 실제 git 출력(앞줄·CRLF 포함)은 code 와 문구가 정확히 맞는다', () => {
  const fail = (stderr, exitCode = 128) => ({ kind: 'fail', exitCode, message: 'git 실행 실패', stderr, stdout: '' });
  const url = "'http://127.0.0.1:64819/x/y.git/'";
  const table = [
    [fail('From /tmp/bare\n * branch            main       -> FETCH_HEAD\nfatal: refusing to merge unrelated histories\n'), 'unrelated', MSG_UNRELATED],
    [fail('From /tmp/bare\r\n * branch            main       -> FETCH_HEAD\r\nfatal: refusing to merge unrelated histories\r\n'), 'unrelated', MSG_UNRELATED],
    [fail(`fatal: unable to access ${url}: The requested URL returned error: 403\n`), 'no-access', msgNoAccess('')],
    [fail(`fatal: unable to access ${url}: The requested URL returned error: 403\r\n`, 1), 'no-access', msgNoAccess('')],
    [fail("remote: Permission to x/y.git denied to z.\nfatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 403\n"), 'no-access', msgNoAccess('remote: Permission to x/y.git denied to z.')],
    [fail("remote: Permission to x/y.git denied to z.\r\nfatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 403\r\n", 1), 'no-access', msgNoAccess('remote: Permission to x/y.git denied to z.')],
    [fail(`fatal: repository ${url} not found\n`), 'repo-not-found', MSG_NOT_FOUND],
    [fail(`fatal: repository ${url} not found\r\n`, 1), 'repo-not-found', MSG_NOT_FOUND],
    [fail("remote: Repository not found.\nfatal: repository 'https://github.com/x/y.git/' not found\n"), 'repo-not-found', MSG_NOT_FOUND],
    [fail("remote: Repository not found.\r\nfatal: repository 'https://github.com/x/y.git/' not found\r\n", 1), 'repo-not-found', MSG_NOT_FOUND],
    [fail('hint: Diverging branches can\'t be fast-forwarded, you need to either:\nhint:\nhint: \tgit merge --no-ff\nfatal: Not possible to fast-forward, aborting.\n'), 'ff-only', MSG_FF_ONLY],
    [fail('hint: Diverging branches can\'t be fast-forwarded, you need to either:\r\nhint:\r\nfatal: Not possible to fast-forward, aborting.\r\n'), 'ff-only', MSG_FF_ONLY],
  ];
  for (const [e, code, error] of table) assert.deepEqual(errorOf(e, 'pull'), { code, error }, e.stderr);
});

test('errorOf: 전용 안내 오판 방지 — 500, 끝 줄이 다른 경우, stdout 에만 있는 경우', () => {
  const fail = (stderr, stdout = '', exitCode = 128) => ({ kind: 'fail', exitCode, message: 'git 실행 실패', stderr, stdout });
  // 500 은 같은 형식이어도 기존 no-remote
  const r500 = errorOf(fail("fatal: unable to access 'http://127.0.0.1:64819/x/y.git/': The requested URL returned error: 500\n"), 'pull');
  assert.deepEqual(r500, { code: 'no-remote', error: '원격 저장소에 연결하지 못했습니다' });
  // 같은 글자가 중간에만 있고 끝 줄이 다르면 전용 안내가 아니다
  const mid = errorOf(fail('error: Your local changes to the following files would be overwritten by merge:\n\tfatal: refusing to merge unrelated histories.txt\nAborting\n'), 'pull');
  assert.equal(mid.code, 'overwrite');
  const dotted = errorOf(fail('fatal: refusing to merge unrelated histories.txt\n'), 'pull');
  assert.equal(dotted.code, 'fail', '끝에 글자가 더 붙은 줄');
  const midForbidden = errorOf(fail("fatal: unable to access 'https://x/y.git/': The requested URL returned error: 403\nhook: 후처리 실패\n"), 'push');
  assert.equal(midForbidden.code, 'no-remote', '403 줄이 끝이 아니면 기존 분류');
  const midFf = errorOf(fail('fatal: Not possible to fast-forward, aborting.\nextra line\n'), 'pull');
  assert.equal(midFf.code, 'fail');
  const midNf = errorOf(fail("fatal: repository 'https://x/y.git/' not found\nexit\n"), 'fetch');
  assert.equal(midNf.code, 'fail');
  // stdout 에만 있으면 전용 안내가 아니다
  for (const line of [
    'fatal: refusing to merge unrelated histories',
    "fatal: unable to access 'https://x/y.git/': The requested URL returned error: 403",
    "fatal: repository 'https://x/y.git/' not found",
    'fatal: Not possible to fast-forward, aborting.',
  ]) {
    const out = errorOf(fail('', line), 'pull');
    assert.ok(!['unrelated', 'no-access', 'repo-not-found', 'ff-only'].includes(out.code), `stdout 만: ${line} → ${out.code}`);
  }
});

// 원격(bare)과 커밋 기록이 이어지지 않은 저장소: 원격에는 seed, 로컬은 따로 시작한 mine.txt
function unrelatedRepo() {
  const { bare } = seedRemote();
  const mine = mkRepo('unrelated');
  commitFile(mine, 'mine.txt', 'mine\n', 'mine');
  git(mine, 'remote', 'add', 'origin', bare);
  return { bare, repo: mine };
}

// 원격과 갈라졌고 merge.ff=only 인 저장소
function ffOnlyRepo(configure = ['merge.ff', 'only']) {
  const s = seedRemote();
  git(s.repo, 'config', ...configure);
  commitFile(s.repo, 'l.txt', 'l\n', 'local');
  s.remoteCommit('r.txt', 'r\n');
  return s;
}

// 문구 3번째 줄 명령을 인자로 나눠 임시 저장소에서 실행한다
const runHint = (repo, message) => {
  const [bin, ...args] = message.split('\n')[2].split(' ');
  assert.equal(bin, 'git');
  return git(repo, ...args);
};

test('pull·sync: 기록이 이어지지 않은 저장소는 unrelated, HEAD 그대로 · MERGE_HEAD 없음 · abort 호출 없음 · 작업 폴더 깨끗', { skip }, async () => {
  for (const op of ['pull', 'sync']) {
    const { repo } = unrelatedRepo();
    const before = headOf(repo);
    const { ops, calls } = makeOps(repo);
    const r = await ops[op](repo);
    assert.deepEqual(r, { ok: false, code: 'unrelated', error: MSG_UNRELATED }, op);
    assert.equal(headOf(repo), before, `${op}: HEAD 그대로`);
    assert.equal(hasMergeHead(repo), false, `${op}: MERGE_HEAD 없음`);
    assert.ok(!calls.some((a) => a[0] === 'merge'), `${op}: merge --abort 를 부르지 않았다`);
    assert.equal(git(repo, 'status', '--porcelain'), '', `${op}: 작업 폴더 깨끗`);
  }
});

test('pull: merge.ff=only 로 갈라진 저장소는 ff-only, HEAD 그대로 · abort 호출 없음', { skip }, async () => {
  const { repo } = ffOnlyRepo();
  const before = headOf(repo);
  const { ops, calls } = makeOps(repo);
  const r = await ops.pull(repo);
  assert.deepEqual(r, { ok: false, code: 'ff-only', error: MSG_FF_ONLY });
  assert.equal(headOf(repo), before, 'HEAD 그대로');
  assert.equal(hasMergeHead(repo), false);
  assert.ok(!calls.some((a) => a[0] === 'merge'), 'merge --abort 를 부르지 않았다');
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('commit then:sync: 커밋 뒤 unrelated 면 committed:true 를 유지하고 문구는 그대로', { skip }, async () => {
  const { repo } = unrelatedRepo();
  put(repo, 'l.txt', 'l\n');
  git(repo, 'add', 'l.txt');
  const { ops } = makeOps(repo);
  const r = await ops.commit(repo, { message: 'local', expected: ['l.txt'], then: 'sync' });
  assert.deepEqual(r, { ok: false, committed: true, oid: headOf(repo), code: 'unrelated', error: MSG_UNRELATED });
  assert.equal(hasMergeHead(repo), false);
  assert.equal(git(repo, 'log', '-1', '--format=%s').trim(), 'local', '커밋은 남아 있다');
});

test('안내 문구의 명령: unrelated — 3번째 줄을 실행하면 합쳐지고 이어서 push 가 성공한다 (임시 저장소)', { skip }, async () => {
  const { bare, repo } = unrelatedRepo();
  runHint(repo, MSG_UNRELATED);
  assert.equal(hasMergeHead(repo), false, '병합이 끝났다');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  const { ops } = makeOps(repo);
  const r = await ops.push(repo);
  assert.deepEqual(r, { ok: true });
  assert.equal(git(bare, 'rev-parse', 'main').trim(), headOf(repo), '원격이 합친 커밋으로 갱신됐다');
});

test('안내 문구의 명령: ff-only — 3번째 줄을 실행하면 병합되고 이어서 push 가 성공한다 (임시 저장소)', { skip }, async () => {
  const { bare, repo } = ffOnlyRepo();
  runHint(repo, MSG_FF_ONLY);
  assert.equal(hasMergeHead(repo), false, '병합이 끝났다');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  const { ops } = makeOps(repo);
  const r = await ops.push(repo);
  assert.deepEqual(r, { ok: true });
  assert.equal(git(bare, 'rev-parse', 'main').trim(), headOf(repo), '원격이 합친 커밋으로 갱신됐다');
});

// ----- 리뷰 지적: 커밋 단계 제외 · 재시도 없음 · 403 원격 안내 · 앵커 · 설정이 달라도 도는 안내 명령 -----

const L_UNRELATED = 'fatal: refusing to merge unrelated histories';
const L_403 = "fatal: unable to access 'https://example.invalid/r.git/': The requested URL returned error: 403";
const L_404 = "fatal: repository 'https://example.invalid/r.git/' not found";
const L_FF = 'fatal: Not possible to fast-forward, aborting.';

test('errorOf: 커밋 단계에서는 hook 이 같은 문장을 끝 줄로 내도 전용 안내가 아니라 hook 원문', () => {
  for (const line of [L_UNRELATED, L_403, L_404, L_FF]) {
    const stderr = `hook: 검사 결과\n${line}\n`;
    const r = errorOf({ kind: 'fail', exitCode: 1, message: 'm', stderr, stdout: '' }, 'commit');
    assert.equal(r.code, 'hook', line);
    assert.equal(r.error, '커밋 전 검사(hook)가 실패했습니다:\n' + stderr.trim(), line + ': 원문 유지');
  }
});

test('commit: pre-commit hook 이 「refusing to merge unrelated histories」를 끝 줄로 내고 exit 1 이면 hook, 커밋 없음', { skip }, async () => {
  const repo = mkRepo('cm-unrelated');
  commitFile(repo, 'a.txt', 'a\n');
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho "fatal: refusing to merge unrelated histories" >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  put(repo, 'a.txt', 'a2\n');
  git(repo, 'add', 'a.txt');
  const { ops } = makeOps(repo);
  const before = headOf(repo);
  const r = await ops.commit(repo, { message: 'x', expected: ['a.txt'] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'hook');
  assert.match(r.error, /^커밋 전 검사\(hook\)가 실패했습니다:\nfatal: refusing to merge unrelated histories/);
  assert.equal(r.committed, undefined);
  assert.equal(headOf(repo), before, '커밋되지 않았다');
});

test('403·404: fetch·push·pull 모두 재시도 없이 네트워크 1회 · 조회 0회 · GCM 인자 없음', { skip }, async () => {
  const cases = [
    ['403', L_403, 'no-access', msgNoAccess('')],
    ['404', L_404, 'repo-not-found', MSG_NOT_FOUND],
  ];
  const scenarios = [
    ['fetch', (stderr, exitCode) => ({ fetch: [throws(() => failErr(stderr, { exitCode }))] }), (ops, repo) => ops.fetch(repo), { fetch: 1 }, 128],
    ['push', (stderr, exitCode) => ({ push: [throws(() => failErr(stderr, { exitCode }))] }), (ops, repo) => ops.push(repo), { push: 1 }, 128],
    ['pull(fetch 단계)', (stderr, exitCode) => ({ fetch: [throws(() => failErr(stderr, { exitCode }))] }), (ops, repo) => ops.pull(repo), { fetch: 1, pull: 0 }, 128],
    ['pull(pull 단계)', (stderr, exitCode) => ({ fetch: ['ok'], pull: [throws(() => failErr(stderr, { exitCode }))] }), (ops, repo) => ops.pull(repo), { fetch: 1, pull: 1 }, 1],
  ];
  for (const [label, stderr, code, error] of cases) {
    for (const [name, net, run, counts, exitCode] of scenarios) {
      const { repo } = seedRemote();
      const fk = netFake({ net: net(stderr, exitCode) });
      const r = await run(makeOps(repo, { git: fk.fake }).ops, repo);
      assert.deepEqual(r, { ok: false, code, error }, `${label} ${name}`);
      for (const [cmd, n] of Object.entries(counts)) assert.equal(fk.of(cmd).length, n, `${label} ${name}: ${cmd} 호출 수`);
      assert.equal(fk.lookups.filter((x) => x === 'get-urlmatch').length, 0, `${label} ${name}: get-urlmatch 조회 없음`);
      assert.ok(!fk.netCalls.some((c) => c.args.includes('credential.helper=manager')), `${label} ${name}: GCM 인자 없음`);
    }
  }
});

test('push: 인증 실패 뒤 GCM 재시도에서 403 을 받으면 네트워크 2회로 끝, no-access', { skip }, async () => {
  const { repo } = seedRemote();
  const fk = netFake({ net: { push: [throws(NO_READ), throws(() => failErr(L_403))] } });
  const r = await makeOps(repo, { git: fk.fake }).ops.push(repo);
  assert.deepEqual(r, { ok: false, code: 'no-access', error: msgNoAccess('') });
  assert.equal(fk.of('push').length, 2);
  assert.equal(hasGcm(fk.of('push')[1].args), true, '둘째는 GCM 재시도(가짜 git)');
});

test('errorOf: 403 원격 메시지 — remote: 줄을 접두어째 「원격 메시지」 뒤에, 없으면 그 부분이 없다', () => {
  const fail = (stderr) => ({ kind: 'fail', exitCode: 128, message: 'm', stderr, stdout: '' });
  const one = errorOf(fail(`remote: Re-authorize at https://example.test/x\n${L_403}\n`), 'push');
  assert.equal(one.code, 'no-access');
  assert.equal(one.error, msgNoAccess('remote: Re-authorize at https://example.test/x'));
  // 여러 줄·CRLF·앞뒤 공백·빈 remote: 줄 제외·remote: 가 아닌 줄 제외
  const multi = errorOf(fail(`From x\r\nremote:   첫째 줄  \r\nremote:\r\nremote: 둘째 줄\r\nhint: 무시\r\n${L_403}\r\n`), 'fetch');
  assert.equal(multi.error, msgNoAccess('remote:   첫째 줄\nremote: 둘째 줄'));
  // 없으면 안내 부분이 없다
  assert.equal(errorOf(fail(`${L_403}\n`), 'push').error.includes('원격 메시지'), false);
  assert.equal(errorOf(fail(`hint: x\n${L_403}\n`), 'push').error.includes('원격 메시지'), false);
});

test('errorOf: 403 원격 메시지 길이 — 긴 주소는 잘리지 않고, 넘치면 앞 줄부터 버린다', () => {
  const fail = (stderr) => ({ kind: 'fail', exitCode: 128, message: 'm', stderr, stdout: '' });
  const url = `https://example.test/${'A'.repeat(300)}`;
  assert.equal(errorOf(fail(`remote: Visit\nremote: ${url}\n${L_403}\n`), 'push').error, msgNoAccess(`remote: Visit\nremote: ${url}`), '주소 앞이 잘림');
  const b = 'B'.repeat(600);
  assert.equal(errorOf(fail(`remote: ${'A'.repeat(600)}\nremote: ${b}\n${L_403}\n`), 'push').error, msgNoAccess(`remote: ${b}`), '넘치면 앞 줄부터');
  const c = errorOf(fail(`remote: ${'C'.repeat(1200)}\n${L_403}\n`), 'push').error;
  assert.equal(c, msgNoAccess(`remote: ${'C'.repeat(1200)}`.slice(0, 1000)), '한 줄이 넘치면 앞쪽을 남긴다');
});

test('errorOf: 403 원격 메시지의 제어 문자는 지운다', () => {
  const fail = (stderr) => ({ kind: 'fail', exitCode: 128, message: 'm', stderr, stdout: '' });
  const r = errorOf(fail(`remote: \u001b[31m경고\u001b[0m\u0007 끝\n${L_403}\n`), 'push');
  assert.equal(r.error, msgNoAccess('remote: 경고 끝'));
});

test('errorOf: 전용 안내 앵커 — remote: 가 붙은 줄·401·뒤에 글자가 붙은 줄은 전용 안내가 아니다', () => {
  const fail = (stderr) => ({ kind: 'fail', exitCode: 128, message: 'm', stderr, stdout: '' });
  const dedicated = ['unrelated', 'no-access', 'repo-not-found', 'ff-only'];
  for (const line of [L_UNRELATED, L_403, L_404, L_FF]) {
    for (const end of ['', '\n']) {
      const r = errorOf(fail(`remote: ${line}${end}`), 'pull');
      assert.ok(!dedicated.includes(r.code), `remote: ${line} → ${r.code}`);
    }
  }
  const c = errorOf(fail("fatal: unable to access 'https://example.invalid/r.git/': The requested URL returned error: 401\n"), 'push');
  assert.notEqual(c.code, 'no-access');
  assert.equal(c.code, 'no-remote');
  const d = errorOf(fail("fatal: repository 'x' not found.txt\n"), 'fetch');
  assert.ok(!dedicated.includes(d.code), `not found.txt → ${d.code}`);
});

test('fetch: 원격 메시지의 「not a git repository」 글자에 속지 않는다, 끝 줄이 그 오류면 not-repo', { skip }, async () => {
  const { repo } = seedRemote();
  const failFetch = (stderr) => (root, args, opts) => (args.includes('fetch')
    ? Promise.reject(Object.assign(new Error('git 실행 실패'), { kind: 'fail', exitCode: 128, stderr, stdout: '' }))
    : realGit(root, args, opts));
  const spoof = makeOps(repo, { git: failFetch(`remote: this is not a git repository\n${L_403}`) });
  assert.equal((await spoof.ops.fetch(repo)).code, 'no-access');
  const real = makeOps(repo, { git: failFetch('fatal: not a git repository (or any of the parent directories): .git') });
  assert.deepEqual(await real.ops.fetch(repo), { ok: false, code: 'not-repo', error: '깃 저장소가 아닙니다' });
});

test('안내 명령: merge.ff=only 이면서 기록이 이어지지 않은 저장소에서도 unrelated 명령이 성공하고 설정은 그대로', { skip }, async () => {
  const { bare, repo } = unrelatedRepo();
  git(repo, 'config', 'merge.ff', 'only');
  const { ops } = makeOps(repo);
  const r = await ops.pull(repo);
  assert.equal(r.code, 'unrelated', '이 설정에서도 unrelated 안내가 나온다');
  runHint(repo, r.error);
  assert.equal(hasMergeHead(repo), false, '병합이 끝났다');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(git(repo, 'config', '--get', 'merge.ff').trim(), 'only', '설정이 그대로');
  assert.deepEqual(await ops.push(repo), { ok: true });
  assert.equal(git(bare, 'rev-parse', 'main').trim(), headOf(repo));
});

test('안내 명령: branch.main.mergeoptions=--ff-only 로도 ff-only 가 나오고 안내 명령이 성공한다', { skip }, async () => {
  const { bare, repo } = ffOnlyRepo(['branch.main.mergeoptions', '--ff-only']);
  const before = headOf(repo);
  const { ops } = makeOps(repo);
  const r = await ops.pull(repo);
  assert.deepEqual(r, { ok: false, code: 'ff-only', error: MSG_FF_ONLY });
  assert.equal(headOf(repo), before, 'HEAD 그대로');
  runHint(repo, r.error);
  assert.equal(hasMergeHead(repo), false, '병합이 끝났다');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(git(repo, 'config', '--get', 'branch.main.mergeoptions').trim(), '--ff-only', '설정이 그대로');
  assert.deepEqual(await ops.push(repo), { ok: true });
  assert.equal(git(bare, 'rev-parse', 'main').trim(), headOf(repo));
});

// ---------- Git 패널 개선 (D-083~085) ----------

test('errorOf 표: 커밋 종료 코드 1 은 hook 출력의 글자와 상관없이 hook, 종료 코드 128 은 기존 코드', () => {
  const f = (stderr, exitCode, stdout = '') => ({ kind: 'fail', exitCode, message: 'm', stderr, stdout });
  for (const text of ['fatal: unable to access x: Could not resolve host: x', 'CONFLICT (content): Merge conflict in f.txt', "fatal: Authentication failed for 'https://x'",
    'error: failed to write commit object', 'error: unresolved conflict 입니다']) {
    const r = errorOf(f(text, 1), 'commit');
    assert.equal(r.code, 'hook', text);
    assert.ok(r.error.includes(text), `${text}: 원문 포함`);
  }
  const codes128 = [
    ["fatal: Unable to create '/r/.git/index.lock': File exists.", 'lock'],
    ['error: gpg failed to sign the data', 'sign'],
    ['*** Please tell me who you are.', 'no-identity'],
    ['error: Committing is not possible because you have unmerged files.', 'unmerged'],
  ];
  for (const [text, code] of codes128) assert.equal(errorOf(f(text, 128), 'commit').code, code, text);
});

test('errorOf 표: 푸시 종료 코드 1 은 거절·원격 거부·로컬 main 없음 외에는 pre-push hook(fail+원문), 128 은 기존 코드, 색 코드는 지운다', () => {
  const f = (stderr, exitCode, stdout = '') => ({ kind: 'fail', exitCode, message: 'm', stderr, stdout });
  for (const text of ['fatal: unable to access x: Could not resolve host: x', '! [rejected]        main -> main (fetch first)']) {
    const r = errorOf(f(text, 1), 'push');
    assert.equal(r.code, 'fail', text);
    assert.ok(r.error.includes(text), `${text}: 원문 포함`);
  }
  assert.equal(errorOf(f('error: failed to push some refs', 1, '!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)'), 'push').code, 'rejected');
  assert.equal(errorOf(f('error: failed to push some refs', 1, '!\trefs/heads/main:refs/heads/main\t[remote rejected] (declined)'), 'push').code, 'remote-rejected');
  assert.equal(errorOf(f('error: src refspec main does not match any', 1), 'push').code, 'no-src');
  assert.equal(errorOf(f("fatal: Authentication failed for 'https://x'", 128), 'push').code, 'auth');
  assert.equal(errorOf(f('fatal: unable to access x: Could not resolve host: x', 128), 'push').code, 'no-remote');
  const colored = errorOf(f('\u001b[31mpre-push 실패\u001b[0m', 1), 'push');
  assert.equal(colored.error, 'git 실행 실패:\npre-push 실패');
});

test('실제 git: pre-commit hook 이 「Could not resolve host」를 내도 hook, 원문 포함 · 긴 출력은 끝 줄이 남는다', { skip }, async () => {
  const repo = mkRepo('hk-real');
  commitFile(repo, 'a.txt', 'a\n');
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
  const { ops } = makeOps(repo);
  fs.writeFileSync(hook, '#!/bin/sh\necho "fatal: unable to access x: Could not resolve host: x" >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  put(repo, 'a.txt', 'a2\n');
  git(repo, 'add', 'a.txt');
  const r = await ops.commit(repo, { message: 'x', expected: ['a.txt'] });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'hook');
  assert.match(r.error, /Could not resolve host: x/);

  fs.writeFileSync(hook, '#!/bin/sh\ni=0\nwhile [ $i -lt 60 ]; do echo "noise-line-$i xxxxxxxxxxxxxxxx" >&2; i=$((i+1)); done\necho "FINAL-CAUSE" >&2\nexit 1\n');
  const long = await ops.commit(repo, { message: 'x', expected: ['a.txt'] });
  assert.equal(long.code, 'hook');
  assert.ok(long.error.startsWith('커밋 전 검사(hook)가 실패했습니다:\n…\n'));
  assert.ok(long.error.endsWith('FINAL-CAUSE'), long.error);
  assert.ok(!long.error.includes('noise-line-0 '), '앞부분은 줄인다');
});

test('실제 git: pre-push hook 이 「Could not resolve host」를 내면 fail, 원문 포함', { skip }, async () => {
  const { repo } = seedRemote();
  const hook = path.join(repo, '.git', 'hooks', 'pre-push');
  fs.writeFileSync(hook, '#!/bin/sh\necho "fatal: unable to access x: Could not resolve host: pp" >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  commitFile(repo, 'p.txt', 'p\n', 'p');
  const r = await makeOps(repo).ops.push(repo);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'fail');
  assert.match(r.error, /Could not resolve host: pp/);
});

test('중첩 저장소: stageable:false·nested:true, 다른 파일과 함께 커밋하면 다른 파일만 들어가고, 스테이징 요청은 changed', { skip }, async () => {
  for (const [outerCommit, innerCommit] of [[true, true], [true, false], [false, true], [false, false]]) {
    const repo = mkRepo('nest');
    if (outerCommit) commitFile(repo, 'a.txt', 'a\n');
    const inner = path.join(repo, 'inner');
    fs.mkdirSync(inner);
    git(inner, 'init', '-q', '-b', 'main');
    git(inner, 'config', 'user.name', 't');
    git(inner, 'config', 'user.email', 't@t');
    put(inner, 'x.txt', 'x\n');
    if (innerCommit) { git(inner, 'add', '-A'); git(inner, 'commit', '-q', '-m', 'in'); }
    put(repo, 'b.txt', 'b\n');
    const label = `outer ${outerCommit} inner ${innerCommit}`;
    const { ops } = makeOps(repo);
    const st = await ops.state(repo);
    assert.deepEqual(st.changes.find((c) => c.path === 'inner'), { path: 'inner', code: 'U', stageable: false, nested: true }, label);
    assert.deepEqual(st.changes.find((c) => c.path === 'b.txt'), { path: 'b.txt', code: 'U' }, label);
    assert.equal((await ops.stage(repo, ['inner'])).code, 'changed', label);
    const r = await ops.commit(repo, { message: 'b', expected: [], stage: ['b.txt'] });
    assert.equal(r.ok, true, `${label}: ${JSON.stringify(r)}`);
    const tree = git(repo, 'ls-tree', '-r', 'HEAD');
    assert.ok(tree.includes('b.txt'), label);
    assert.ok(!tree.includes('160000') && !tree.includes('inner'), `${label}: gitlink 없음`);
  }
});

test('state: 다른 브랜치·분리된 HEAD 의 ahead/behind 는 자기 upstream 기준(없으면 null), main 은 기존과 같다', { skip }, async () => {
  const { repo } = seedRemote();
  const { ops } = makeOps(repo);
  git(repo, 'checkout', '-q', '-b', 'dev');
  commitFile(repo, 'd1.txt', 'd1\n', 'dev1');
  git(repo, 'push', '-q', '-u', 'origin', 'dev');
  commitFile(repo, 'd2.txt', 'd2\n', 'dev2');
  let st = await ops.state(repo);
  assert.deepEqual([st.branch, st.upstream, st.ahead, st.behind], ['dev', 'origin/dev', 1, 0], 'origin/main 기준(2)이 아니다');
  git(repo, 'checkout', '-q', '-b', 'nouplink');
  st = await ops.state(repo);
  assert.deepEqual([st.branch, st.upstream, st.ahead, st.behind], ['nouplink', null, null, null]);
  git(repo, 'checkout', '-q', '--detach');
  st = await ops.state(repo);
  assert.deepEqual([st.detached, st.ahead, st.behind], [true, null, null]);
  git(repo, 'checkout', '-q', 'main');
  st = await ops.state(repo);
  assert.deepEqual([st.branch, st.upstream, st.ahead, st.behind], ['main', 'origin/main', 0, 0]);
});

test('state: git 이 시간 초과를 던지면 timeout 코드와 조회 문구', async () => {
  const repo = mkdir('st-timeout');
  const { ops } = makeOps(repo, { git: async () => { throw Object.assign(new Error('git 조회 시간이 초과되었습니다'), { kind: 'timeout' }); } });
  assert.deepEqual(await ops.state(repo), { ok: false, code: 'timeout', error: 'git 상태 조회 시간이 초과되었습니다.\n잠시 뒤 다시 확인합니다.' });
});

test('pull: 받을 것이 없으면 upToDate:true, 받으면 upToDate 없음', { skip }, async () => {
  const { repo, remoteCommit } = seedRemote();
  const { ops } = makeOps(repo);
  assert.deepEqual(await ops.pull(repo), { ok: true, upToDate: true });
  remoteCommit('r.txt', 'r\n');
  assert.deepEqual(await ops.pull(repo), { ok: true });
  assert.deepEqual(await ops.pull(repo), { ok: true, upToDate: true });
});

test('언어: 영어 모드에서는 오류 문구만 영어가 되고 판별(code)은 그대로다', () => {
  setLang('en');
  try {
    const fail = (stderr, extra = {}) => ({ kind: 'fail', message: 'git failed', stderr, stdout: '', ...extra });
    const auth = errorOf(fail("fatal: Authentication failed for 'https://example.com/a.git'"));
    assert.equal(auth.code, 'auth');
    assert.equal(auth.error, 'Remote authentication failed.\nLog in with git push in the terminal below.');
    assert.equal(errorOf(fail("fatal: Authentication failed for 'https://example.com/a.git'"), 'push').code, 'auth');
    assert.equal(errorOf({ kind: 'timeout', net: true }).error, 'The remote operation timed out.\nIf a login window was open, please try again.');
    // 번역 전 원인 글(raw)이 있으면 문구의 접두어를 떼지 않고 그것을 쓴다
    assert.equal(errorOf({ kind: 'fail', message: 'git failed:\nboom', raw: 'boom', stderr: '', stdout: '' }).error, 'git failed:\nboom');
  } finally {
    setLang('ko');
  }
  assert.equal(errorOf({ kind: 'timeout', net: true }).error, '원격 작업 시간이 초과되었습니다.\n로그인 창이 열려 있었다면 다시 시도해 주세요.');
});
