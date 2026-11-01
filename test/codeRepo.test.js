import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 사용자·시스템 git 설정(autocrlf·safe.directory 등)이 결과를 흔들지 않게 격리한다.
// codeRepo 가 띄우는 git 도 cleanEnv() 로 이 값을 물려받는다.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-code-')));
const emptyConfig = path.join(base, 'gitconfig');
fs.writeFileSync(emptyConfig, '');
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';

const require = createRequire(import.meta.url);
const {
  resolveInside, toGitPath, createCodeRoots, repoInfo, listFiles, statusOf,
  readText, statMtime, headText, createCodeService, registerCodeIpc, git: gitRun,
} = require('../src/main/codeRepo.cjs');

after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }));

let hasGit = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { hasGit = false; }
const skip = hasGit ? false : '실행 파일 없음';

const DENIED = { message: '허용되지 않는 경로입니다' };
const sorted = (list) => [...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

let seq = 0;
const mkdir = (name) => { const d = path.join(base, `${name}-${seq++}`); fs.mkdirSync(d, { recursive: true }); return d; };
const put = (root, rel, data) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
};
const git = (cwd, ...args) => execFileSync(
  'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args],
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);
const initRepo = (name) => { const d = mkdir(name); git(d, 'init', '-q'); return d; };

// 픽스처: 저장소 루트 아래 sub/ 가 탭 작업 폴더. 커밋 뒤 수정·생성·이동.
function makeFixture() {
  const repo = initRepo('repo');
  put(repo, 'sub/한글 파일.js', 'export const a = 1;\n');
  put(repo, 'sub/inner/x.js', 'export const x = 1;\n');
  put(repo, 'top.js', 'top = 1;\n');
  put(repo, '.gitignore', '*.log\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  put(repo, 'sub/한글 파일.js', 'export const a = 2;\n');
  put(repo, 'sub/new.txt', 'new\n');
  put(repo, 'sub/skip.log', 'ignored\n');
  git(repo, 'mv', 'sub/inner/x.js', 'sub/inner/y.js');
  // 작업 폴더 밖 변경: sub 기준 결과에서는 빠져야 한다
  put(repo, 'top.js', 'top = 2;\n');
  put(repo, 'outside.txt', 'outside\n');
  return { repo, sub: path.join(repo, 'sub') };
}

const fx = hasGit ? makeFixture() : null;
const plain = mkdir('plain'); // 깃 저장소가 아닌 폴더

test('resolveInside: 안쪽 경로는 절대 경로로, 바깥·위험 경로는 거부한다', () => {
  const root = mkdir('root');
  put(root, 'real.js', 'x');
  assert.equal(resolveInside(root, 'src/a.js'), path.join(root, 'src', 'a.js'));
  assert.equal(resolveInside(root, 'sub\\b.js'), path.resolve(root, 'sub\\b.js'));
  assert.equal(resolveInside(root, 'real.js'), path.join(root, 'real.js'), '있는 파일도 통과');
  for (const bad of [
    '../x', '..\\x', 'a/../../x', 'C:\\Windows\\win.ini', 'C:x', 'a.js:stream', '/etc/passwd', '\\\\srv\\share\\x',
    '.git/config', '.git', 'sub/.GIT/HEAD', 'sub\\.Git\\HEAD', '.git./config', '.git /config', 'GIT~1/config',
    '', 'a\0b', '...', null, undefined, 5, {},
  ]) {
    assert.throws(() => resolveInside(root, bad), DENIED, `거부: ${JSON.stringify(bad)}`);
  }
});

test('resolveInside: 폴더 안 정션으로 바깥(또는 .git)을 가리키면 거부한다', () => {
  const root = mkdir('root');
  const root2 = path.join(path.dirname(root), `${path.basename(root)}-2`);
  fs.mkdirSync(root2);
  put(root2, 'x.js', 'outside');
  fs.symlinkSync(root2, path.join(root, 'link'), 'junction');
  assert.throws(() => resolveInside(root, 'link/x.js'), DENIED);
  assert.throws(() => resolveInside(root, 'link'), DENIED);

  fs.mkdirSync(path.join(root, '.git'));
  put(root, '.git/config', 'secret');
  fs.symlinkSync(path.join(root, '.git'), path.join(root, 'gl'), 'junction');
  assert.throws(() => resolveInside(root, 'gl/config'), DENIED, '안쪽을 가리켜도 .git 은 거부');
});

test('toGitPath: 역슬래시를 슬래시로', () => {
  assert.equal(toGitPath('a\\b\\c.js'), 'a/b/c.js');
  assert.equal(toGitPath('a/b.js'), 'a/b.js');
});

test('createCodeRoots: 같은 폴더는 표기·끝 구분자와 무관하게 하나, 다른 폴더는 구분', () => {
  const roots = createCodeRoots();
  roots.add('C:\\Repo\\');
  assert.equal(roots.has('C:\\Repo2'), false);
  assert.equal(roots.has('C:\\Repo\\sub'), false);
  assert.equal(roots.has(''), false);
  assert.equal(roots.has(null), false);
  assert.equal(roots.has('C:\\Repo'), true, '끝 구분자는 무시');
  roots.add('C:\\Repo');
  assert.equal(roots.list().length, 1, '같은 폴더는 한 번만');
  assert.deepEqual(roots.list(), ['C:\\Repo\\'], '처음 넣은 표기 그대로');
});

test('createCodeRoots: 윈도우는 대소문자를 무시하고 처음 넣은 표기를 목록에 남긴다',
  { skip: process.platform === 'win32' ? false : '윈도우 전용' }, () => {
    const roots = createCodeRoots();
    roots.add('C:\\Repo\\');
    assert.equal(roots.has('c:\\repo'), true);
    roots.add('c:\\REPO');
    assert.deepEqual(roots.list(), ['C:\\Repo\\']);
  });

test('repoInfo: 하위 폴더는 prefix, 저장소가 아니면 not-repo', { skip }, async () => {
  assert.deepEqual(await repoInfo(fx.sub), { git: true, prefix: 'sub/' });
  assert.deepEqual(await repoInfo(fx.repo), { git: true, prefix: '' });
  assert.deepEqual(await repoInfo(plain), { git: false, reason: 'not-repo' });
});

test('repoInfo: .git 폴더 자체는 작업 트리가 아니므로 not-repo', { skip }, async () => {
  assert.deepEqual(await repoInfo(path.join(fx.repo, '.git')), { git: false, reason: 'not-repo' });
});

test('listFiles: 추적·미추적 파일을 현재 폴더 기준으로, 무시 파일은 뺀다', { skip }, async () => {
  const { files, truncated } = await listFiles(fx.sub);
  assert.ok(files.includes('한글 파일.js'));
  assert.ok(files.includes('new.txt'));
  assert.ok(files.includes('inner/y.js'));
  assert.ok(!files.includes('skip.log'));
  assert.ok(!files.includes('inner/x.js'), '이름이 바뀐 옛 경로는 없다');
  assert.ok(!files.some((f) => f.includes('top.js') || f.includes('outside')), '폴더 밖 파일은 없다');
  assert.deepEqual(files, [...files].sort(), '정렬되어 있다');
  assert.equal(truncated, false);
});

test('listFiles: 상한을 넘으면 추적 파일을 먼저 채우고 truncated 를 켠다', { skip }, async () => {
  const two = await listFiles(fx.sub, 2);
  assert.deepEqual(two, { files: ['inner/y.js', '한글 파일.js'], truncated: true }, '추적 2개로 가득 차면 미추적은 잘림');
  const one = await listFiles(fx.sub, 1);
  assert.equal(one.files.length, 1);
  assert.equal(one.truncated, true);
  const three = await listFiles(fx.sub, 3);
  assert.equal(three.files.length, 3);
  assert.equal(three.truncated, false, '딱 맞으면 잘린 것이 아니다');
});

test('statusOf: 작업 폴더 안 변경만 접두어를 떼고 돌려준다 (한글·공백·이름 변경)', { skip }, async () => {
  const st = await statusOf(fx.sub, 'sub/');
  assert.deepEqual(sorted(st), sorted([
    { path: '한글 파일.js', code: ' M' },
    { path: 'new.txt', code: '??' },
    { path: 'inner/y.js', code: 'R ' },
  ]));
  const all = await statusOf(fx.repo, '');
  assert.deepEqual(all.map((s) => s.path).sort(), ['outside.txt', 'sub/inner/y.js', 'sub/new.txt', 'sub/한글 파일.js', 'top.js']);
});

test('statusOf: 조회가 .git/index 를 다시 쓰지 않는다 (에이전트의 커밋과 index.lock 충돌 방지)', { skip }, async () => {
  const repo = initRepo('lock');
  put(repo, 'a.js', 'a\n');
  put(repo, 'b.js', 'b\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const index = path.join(repo, '.git', 'index');
  const before = fs.statSync(index).mtimeMs;
  // 내용은 그대로, 파일 시각만 바꿔 일반 git status 라면 인덱스를 갱신하게 만든다
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(repo, 'a.js'), old, old);
  assert.deepEqual(await statusOf(repo, ''), []);
  assert.equal(fs.statSync(index).mtimeMs, before);
  assert.ok(!fs.existsSync(path.join(repo, '.git', 'index.lock')));
});

test('readText: 텍스트·바이너리·큰 파일·폴더·없는 파일', async () => {
  put(plain, 'a.txt', '안녕\nhello\n');
  put(plain, 'bin.dat', Buffer.from([1, 2, 0, 3]));
  put(plain, 'eleven.txt', 'x'.repeat(11));
  put(plain, 'bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi')]));
  fs.mkdirSync(path.join(plain, 'd'), { recursive: true });

  const t = await readText(plain, 'a.txt');
  assert.equal(t.kind, 'text');
  assert.equal(t.text, '안녕\nhello\n');
  assert.equal(typeof t.mtimeMs, 'number');
  assert.deepEqual(await readText(plain, 'bin.dat'), { kind: 'binary' });
  assert.deepEqual(await readText(plain, 'eleven.txt', 10), { kind: 'large', size: 11 });
  assert.equal((await readText(plain, 'eleven.txt', 11)).kind, 'text', '딱 상한이면 읽는다');
  assert.deepEqual(await readText(plain, 'd'), { kind: 'dir' });
  assert.deepEqual(await readText(plain, 'nope.txt'), { kind: 'missing' });
  assert.deepEqual(await readText(plain, 'd/nope.txt'), { kind: 'missing' });
  assert.equal((await readText(plain, 'bom.txt')).text, 'hi', 'BOM 은 떼고 돌려준다');
  await assert.rejects(readText(plain, '../x'), DENIED);
  await assert.rejects(readText(plain, '.git/config'), DENIED);
});

test('statMtime: 있으면 숫자, 없으면 null', async () => {
  put(plain, 'm.txt', 'm');
  assert.equal(typeof (await statMtime(plain, 'm.txt')), 'number');
  assert.equal(await statMtime(plain, 'nope.txt'), null);
  await assert.rejects(statMtime(plain, '../m.txt'), DENIED);
});

test('headText: 커밋 당시 내용, 새 파일·큰 파일은 null', { skip }, async () => {
  assert.equal(await headText(fx.sub, '한글 파일.js'), 'export const a = 1;\n');
  assert.equal(await headText(fx.sub, 'new.txt'), null);
  assert.equal(await headText(fx.sub, 'inner/y.js'), null, '이름 바뀐 새 경로는 HEAD 에 없다');
  assert.equal(await headText(fx.sub, '한글 파일.js', 5), null, '상한 초과');
  await assert.rejects(headText(fx.sub, '../top.js'), DENIED);
});

test('headText: 범위 문법(a..b)·폴더 경로는 파일이 아니므로 null', { skip }, async () => {
  assert.equal(await headText(fx.sub, 'a.js..HEAD'), null, '범위처럼 보이는 이름');
  assert.equal(await headText(fx.sub, '한글 파일.js..HEAD'), null);
  assert.equal(await headText(fx.sub, 'inner'), null, '폴더는 트리 목록을 돌려주지 않는다');
  assert.equal(await headText(fx.sub, '한글 파일.js'), 'export const a = 1;\n', '정상 파일은 그대로');
});

test('createCodeService: 등록된 폴더·깃 저장소·안쪽 경로만 허용한다', { skip }, async () => {
  const roots = createCodeRoots();
  const service = createCodeService({ roots });
  await assert.rejects(service.tree(fx.sub), { message: '허용되지 않는 폴더입니다' });
  await assert.rejects(service.read(fx.sub, 'top.js'), { message: '허용되지 않는 폴더입니다' });
  await assert.rejects(service.tree(5), { message: '허용되지 않는 폴더입니다' });

  roots.add(plain);
  assert.deepEqual(await service.tree(plain), { git: false, reason: 'not-repo' });
  for (const call of [
    () => service.read(plain, 'a.txt'),
    () => service.poll(plain, null),
    () => service.base(plain, 'a.txt'),
  ]) await assert.rejects(call(), { message: '깃 저장소가 아닙니다' });

  roots.add(fx.sub);
  const tree = await service.tree(fx.sub);
  assert.equal(tree.git, true);
  assert.ok(tree.files.includes('한글 파일.js'));
  const polled = await service.poll(fx.sub, '한글 파일.js');
  assert.equal(polled.changes.length, 3);
  assert.equal(typeof polled.mtimeMs, 'number');
  assert.equal((await service.poll(fx.sub, null)).mtimeMs, null);
  assert.equal((await service.poll(fx.sub, 'nope.js')).mtimeMs, null);
  assert.equal((await service.read(fx.sub, '한글 파일.js')).kind, 'text');
  assert.deepEqual(await service.base(fx.sub, '한글 파일.js'), { text: 'export const a = 1;\n' });
  await assert.rejects(service.read(fx.sub, '../top.js'), DENIED);
  await assert.rejects(service.base(fx.sub, '.git/config'), DENIED);
  // 열린 파일 경로가 거부되어도 변경 목록은 돌려준다 (시각만 null)
  for (const bad of ['C:x', '.git/config', '../top.js']) {
    const r = await service.poll(fx.sub, bad);
    assert.equal(r.changes.length, 3, bad);
    assert.equal(r.mtimeMs, null, bad);
  }
});

test('createCodeService: 작업 트리가 아닌 .git 폴더를 등록하면 tree 는 not-repo, 나머지는 거부', { skip }, async () => {
  const roots = createCodeRoots();
  const service = createCodeService({ roots });
  const gitDir = path.join(fx.repo, '.git');
  roots.add(gitDir);
  assert.deepEqual(await service.tree(gitDir), { git: false, reason: 'not-repo' });
  await assert.rejects(service.read(gitDir, 'config'), { message: '깃 저장소가 아닙니다' });
});

test('createCodeService: 나중에 git init 한 폴더는 트리를 다시 받으면 열린다', { skip }, async () => {
  const roots = createCodeRoots();
  const service = createCodeService({ roots });
  const late = mkdir('late');
  roots.add(late);
  assert.deepEqual(await service.tree(late), { git: false, reason: 'not-repo' });
  git(late, 'init', '-q');
  put(late, 'a.txt', 'a');
  const tree = await service.tree(late);
  assert.deepEqual(tree, { git: true, files: ['a.txt'], truncated: false });
  assert.equal((await service.read(late, 'a.txt')).kind, 'text');
});

test('registerCodeIpc: 6개 채널, 잘못된 요청 거부, 폴더 등록·선택', { skip }, async () => {
  const handlers = new Map();
  const handleMain = (ch, fn) => handlers.set(ch, fn);
  const roots = createCodeRoots();
  const service = createCodeService({ roots });
  let picked = null;
  const checkFolder = (cwd) => {
    if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`폴더가 없습니다: ${cwd}`);
  };
  registerCodeIpc(handleMain, { roots, service, pickFolder: async () => picked, checkFolder });
  const call = (ch, payload) => handlers.get(ch)(payload);

  assert.deepEqual([...handlers.keys()].sort(), ['code:allow', 'code:base', 'code:pick', 'code:poll', 'code:read', 'code:tree']);

  await assert.rejects(call('code:tree', { root: fx.sub }), { message: '허용되지 않는 폴더입니다' }, '등록 전');
  assert.equal(await call('code:allow', { cwd: fx.sub }), true);
  const tree = await call('code:tree', { root: fx.sub });
  assert.equal(tree.git, true);
  assert.equal((await call('code:poll', { root: fx.sub, rel: '한글 파일.js' })).changes.length, 3);
  assert.equal((await call('code:read', { root: fx.sub, rel: '한글 파일.js' })).kind, 'text');
  assert.deepEqual(await call('code:base', { root: fx.sub, rel: '한글 파일.js' }), { text: 'export const a = 1;\n' });
  await assert.rejects(call('code:read', { root: fx.sub, rel: '.git/config' }), DENIED);

  await assert.rejects(call('code:allow', { cwd: path.join(base, 'nope') }), { message: /^폴더가 없습니다/ });
  assert.equal(roots.has(path.join(base, 'nope')), false, '검사에 실패하면 등록하지 않는다');

  for (const ch of ['code:tree', 'code:poll', 'code:read', 'code:base']) {
    for (const bad of ['문자열', null, undefined, 5, {}, { root: 5 }, []]) {
      await assert.rejects(call(ch, bad), { message: '잘못된 요청입니다' }, `${ch} ${JSON.stringify(bad)}`);
    }
  }
  for (const bad of ['문자열', null, {}, { cwd: 5 }]) {
    await assert.rejects(call('code:allow', bad), { message: '잘못된 요청입니다' });
  }

  assert.equal(await call('code:pick'), null, '취소하면 null');
  assert.equal(roots.has(plain), false);
  picked = plain;
  assert.equal(await call('code:pick'), plain);
  assert.equal(roots.has(plain), true, '고른 폴더는 등록된다');
  assert.deepEqual(await call('code:tree', { root: plain }), { git: false, reason: 'not-repo' });
});

// 같은 표식을 단 git 프로세스가 아직 살아 있는지 (프로세스 트리 정리 확인용)
function aliveWithMarker(marker) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "Name='git.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | Measure-Object).Count`],
      { encoding: 'utf8', windowsHide: true });
      return Number(out.trim()) > 0;
    }
    return execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8' }).split('\n').some((l) => l.includes(marker));
  } catch { return null; }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('git: 시간 초과면 timeout 오류로 거부하고 git 프로세스도 끝낸다', { skip }, async () => {
  const marker = `aomark${process.pid}x${Date.now()}`;
  const t0 = Date.now();
  // cat-file --batch 는 표준 입력을 기다리며 끝나지 않는다
  await assert.rejects(gitRun(fx.sub, ['-c', `ao.marker=${marker}`, 'cat-file', '--batch'], { timeoutMs: 400 }),
    (e) => e.kind === 'timeout' && /시간이 초과/.test(e.message));
  assert.ok(Date.now() - t0 < 8000, '제때 거부');
  await sleep(500);
  assert.notEqual(aliveWithMarker(marker), true, '시간이 지난 git 이 남아 있다');
});

test('git: 출력이 상한을 넘으면 fail 오류로 거부한다', { skip }, async () => {
  await assert.rejects(gitRun(fx.sub, ['ls-files', '-z'], { buffer: true, maxBuffer: 1 }),
    (e) => e.kind === 'fail' && /너무 큽니다/.test(e.message));
});
