import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setLang } from '../src/shared/i18n.js';

// 사용자·시스템 git 설정(autocrlf·safe.directory 등)이 결과를 흔들지 않게 격리한다.
// codeRepo 가 띄우는 git 도 cleanEnv() 로 이 값을 물려받는다.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-code-')));
const emptyConfig = path.join(base, 'gitconfig');
fs.writeFileSync(emptyConfig, '');
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';

const require = createRequire(import.meta.url);
const {
  resolveInside, toGitPath, createCodeRoots, folderProblem, repoInfo, listFiles, statusOf,
  readText, statMtime, headText, indexFile, createCodeService, registerCodeIpc, git: gitRun,
  rootKey, diffText, diffStat, searchText, hasHead, killTrackedGit, trackedGitCount,
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

test('indexFile: 스테이징된 내용(하위 폴더·한글·공백), 인덱스에 없으면 missing, 바이너리·상한 초과는 unshown, .git 거부', { skip }, async () => {
  const repo = initRepo('index');
  put(repo, '한글 폴더/파일 1.txt', 'v1\n');
  put(repo, 'gone.txt', 'gone\n');
  put(repo, 'bin.dat', Buffer.from([1, 2, 0, 3]));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  put(repo, '한글 폴더/파일 1.txt', 'v2 staged\n');
  git(repo, 'add', '한글 폴더/파일 1.txt');
  put(repo, '한글 폴더/파일 1.txt', 'v3 working\n');
  git(repo, 'rm', '-q', 'gone.txt');
  put(repo, 'untracked.txt', 'u\n');
  const sub = path.join(repo, '한글 폴더');
  assert.deepEqual(await indexFile(repo, '한글 폴더/파일 1.txt'), { kind: 'text', text: 'v2 staged\n' }, '작업 폴더가 아니라 인덱스');
  assert.deepEqual(await indexFile(sub, '파일 1.txt'), { kind: 'text', text: 'v2 staged\n' }, '하위 폴더 기준 경로');
  assert.deepEqual(await indexFile(repo, 'gone.txt'), { kind: 'missing' }, '삭제가 스테이징됨');
  assert.deepEqual(await indexFile(repo, 'untracked.txt'), { kind: 'missing' }, '인덱스에 없음');
  assert.deepEqual(await indexFile(repo, 'nope/none.txt'), { kind: 'missing' });
  assert.deepEqual(await indexFile(repo, 'bin.dat'), { kind: 'unshown' }, '바이너리');
  assert.deepEqual(await indexFile(repo, '한글 폴더/파일 1.txt', 3), { kind: 'unshown' }, '상한 초과');
  await assert.rejects(indexFile(repo, '.git/config'), DENIED);
  await assert.rejects(indexFile(sub, '../gone.txt'), DENIED);
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

test('folderProblem: 있는 폴더는 null, 없는 폴더·파일·열 수 없는 폴더는 안내 글', async (t) => {
  const dir = mkdir('fp');
  assert.equal(await folderProblem(dir), null);
  assert.match(await folderProblem(path.join(dir, '없는 폴더')), /^폴더가 없습니다/);
  const file = path.join(dir, 'f.txt');
  fs.writeFileSync(file, 'x');
  assert.match(await folderProblem(file), /^폴더가 아닙니다/);
  t.mock.method(fs.promises, 'opendir', async () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); });
  assert.match(await folderProblem(dir), /^폴더를 열 수 없습니다/);
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

test('registerCodeIpc: 17개 채널, 잘못된 요청 거부, 폴더 등록·선택', { skip }, async () => {
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

  assert.deepEqual([...handlers.keys()].sort(), [
    'code:allow', 'code:base', 'code:folder:check', 'code:git:commit', 'code:git:fetch', 'code:git:log', 'code:git:pull', 'code:git:push', 'code:git:stage',
    'code:git:state', 'code:git:sync', 'code:git:unstage', 'code:index', 'code:pick', 'code:poll', 'code:read', 'code:search', 'code:tree',
  ]);

  await assert.rejects(call('code:tree', { root: fx.sub }), { message: '허용되지 않는 폴더입니다' }, '등록 전');
  await assert.rejects(call('code:index', { root: fx.sub, rel: 'inner/y.js' }), { message: '허용되지 않는 폴더입니다' }, '등록 전 code:index');
  assert.equal(await call('code:allow', { cwd: fx.sub }), true);
  const tree = await call('code:tree', { root: fx.sub });
  assert.equal(tree.git, true);
  assert.equal((await call('code:poll', { root: fx.sub, rel: '한글 파일.js' })).changes.length, 3);
  assert.equal((await call('code:read', { root: fx.sub, rel: '한글 파일.js' })).kind, 'text');
  assert.deepEqual(await call('code:base', { root: fx.sub, rel: '한글 파일.js' }), { text: 'export const a = 1;\n' });
  assert.deepEqual(await call('code:index', { root: fx.sub, rel: 'inner/y.js' }), { kind: 'text', text: 'export const x = 1;\n' });
  await assert.rejects(call('code:read', { root: fx.sub, rel: '.git/config' }), DENIED);
  await assert.rejects(call('code:index', { root: fx.sub, rel: '.git/config' }), DENIED);
  const found = await call('code:search', { root: fx.sub, term: 'const a' });
  assert.deepEqual(found, { matches: [{ path: '한글 파일.js', line: 1, text: 'export const a = 2;' }], truncated: false });
  await assert.rejects(call('code:search', { root: fx.sub, term: '' }), { message: '잘못된 검색어입니다' });

  await assert.rejects(call('code:allow', { cwd: path.join(base, 'nope') }), { message: /^폴더가 없습니다/ });
  assert.equal(roots.has(path.join(base, 'nope')), false, '검사에 실패하면 등록하지 않는다');

  for (const ch of ['code:tree', 'code:poll', 'code:read', 'code:base', 'code:index', 'code:search',
    'code:git:state', 'code:git:stage', 'code:git:unstage', 'code:git:commit', 'code:git:fetch', 'code:git:pull', 'code:git:push', 'code:git:sync', 'code:git:log']) {
    for (const bad of ['문자열', null, undefined, 5, {}, { root: 5 }, []]) {
      await assert.rejects(call(ch, bad), { message: '잘못된 요청입니다' }, `${ch} ${JSON.stringify(bad)}`);
    }
  }

  // Git 채널: 등록된 폴더에서 상태·기록을 읽고, 인자 검사 결과는 던지지 않고 값으로 돌려준다
  const gst = await call('code:git:state', { root: fx.sub });
  assert.equal(gst.ok, true);
  assert.equal(typeof gst.canWrite, 'boolean');
  assert.equal((await call('code:git:log', { root: fx.sub })).commits.length, 1);
  assert.deepEqual(await call('code:git:stage', { root: fx.sub, paths: [] }), { ok: false, code: 'bad', error: '잘못된 요청입니다' });
  assert.equal((await call('code:git:commit', { root: fx.sub, message: ' ', expected: [], stage: undefined, then: null })).code, 'bad');
  assert.equal((await call('code:git:state', { root: path.join(base, 'nope') })).code, 'root', '등록 안 된 폴더는 값으로 거부');
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

test('killTrackedGit: track 으로 띄운 오래 도는 git 만 끝내고, 다시 불러도 안전하다', { skip }, async () => {
  const mark = `aotrack${process.pid}x${Date.now()}`;
  const markPlain = `aoplain${process.pid}x${Date.now()}`;
  // cat-file --batch 는 표준 입력을 기다리며 끝나지 않는다
  const tracked = gitRun(fx.sub, ['-c', `ao.marker=${mark}`, 'cat-file', '--batch'], { track: true, timeoutMs: 60000 });
  const plainRun = gitRun(fx.sub, ['-c', `ao.marker=${markPlain}`, 'cat-file', '--batch'], { timeoutMs: 10000 });
  const plainDone = assert.rejects(plainRun, (e) => e.kind === 'timeout');
  await sleep(700);
  const t0 = Date.now();
  killTrackedGit();
  await assert.rejects(tracked, (e) => e.kind === 'fail');
  assert.ok(Date.now() - t0 < 8000, '제때 끝남');
  await sleep(300);
  // aliveWithMarker 가 null(확인 불가)이면 실패한다 — 확인하지 못한 채 통과하지 않게
  assert.equal(aliveWithMarker(mark), false, '추적한 git 이 남아 있다');
  assert.equal(aliveWithMarker(markPlain), true, 'track 없는 git 은 끝내지 않는다');
  killTrackedGit(); // 비어 있어도 안전
  await plainDone; // track 없는 자식은 자기 시간 초과로만 끝난다
});

test('killTrackedGit: 추적 git 은 실행 중에만 목록에 있고 끝나면 빠진다', { skip }, async () => {
  const before = trackedGitCount();
  const run = gitRun(fx.sub, ['rev-parse', 'HEAD'], { track: true });
  const t0 = Date.now();
  while (trackedGitCount() === before && Date.now() - t0 < 3000) await sleep(1);
  assert.equal(trackedGitCount(), before + 1, '실행 중에는 목록에 있다');
  assert.match((await run).trim(), /^[0-9a-f]{40}$/);
  await sleep(50);
  assert.equal(trackedGitCount(), before, '끝난 자식은 목록에서 빠진다');
  await gitRun(fx.sub, ['rev-parse', 'HEAD']); // track 없는 실행은 목록에 들지 않는다
  assert.equal(trackedGitCount(), before);
  killTrackedGit(); // 끝난 자식뿐이어도 안전
  assert.match((await gitRun(fx.sub, ['rev-parse', 'HEAD'], { track: true })).trim(), /^[0-9a-f]{40}$/, '그 뒤에도 정상 동작');
});

test('git: 출력이 상한을 넘으면 fail 오류로 거부한다', { skip }, async () => {
  await assert.rejects(gitRun(fx.sub, ['ls-files', '-z'], { buffer: true, maxBuffer: 1 }),
    (e) => e.kind === 'fail' && /너무 큽니다/.test(e.message));
});

test('rootKey: 끝 구분자·표기 차이를 없앤 비교용 키', () => {
  assert.equal(rootKey('C:\\Repo\\'), rootKey('C:\\Repo'));
  assert.notEqual(rootKey('C:\\Repo'), rootKey('C:\\Repo2'));
  if (process.platform === 'win32') assert.equal(rootKey('C:\\REPO'), rootKey('c:\\repo'));
});

test('git: input 은 표준 입력으로, env 는 환경에 더해진다', { skip }, async () => {
  assert.equal((await gitRun(fx.sub, ['hash-object', '--stdin'], { input: 'hello\n' })).trim(), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal((await gitRun(fx.sub, ['var', 'GIT_EDITOR'], { env: { GIT_EDITOR: 'my-editor' } })).trim(), 'my-editor');
  assert.equal((await gitRun(fx.sub, ['hash-object', '--stdin'], { input: '' })).trim(), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', '빈 입력도 닫아 준다');
});

test('git: 입력을 읽지 않고 끝나는 명령에 큰 input 을 써도 프로세스가 죽지 않는다', { skip }, async () => {
  const out = await gitRun(fx.sub, ['rev-parse', 'HEAD'], { input: 'x'.repeat(8 * 1024 * 1024) });
  assert.match(out.trim(), /^[0-9a-f]{40}$/);
  await sleep(100); // 늦게 오는 EPIPE 가 처리되지 않은 오류가 되지 않는지
});

test('git: 실패 오류에 stderr·stdout 원문이 붙는다', { skip }, async () => {
  await assert.rejects(gitRun(fx.sub, ['rev-parse', '--verify', 'no-such-ref']),
    (e) => e.kind === 'fail' && typeof e.stderr === 'string' && e.stderr.length > 0 && typeof e.stdout === 'string' && /^git 실행 실패:\n/.test(e.message));
});

test('git: 실패 오류의 stderr 는 뒤쪽 4000자를 남긴다 (끝에 원인이 온다)', { skip }, async () => {
  // 별칭(셸 함수)으로 긴 stderr 를 내고 종료 코드 3 으로 끝낸다 — git 자신의 오류 문구는 4096자에서 잘려 시험에 쓸 수 없다
  const noisy = '!f() { i=0; while [ $i -lt 1000 ]; do echo errline-$i >&2; i=$((i+1)); done; echo END-MARK >&2; exit 3; }; f';
  await assert.rejects(gitRun(fx.sub, ['-c', `alias.noisy=${noisy}`, 'noisy']),
    (e) => e.kind === 'fail' && e.exitCode === 3 && e.stderr.length === 4000 && e.stderr.endsWith('END-MARK'));
});

test('git: 실패 오류에 종료 코드(숫자)가 붙는다', { skip }, async () => {
  await assert.rejects(gitRun(fx.sub, ['rev-parse', '--verify', '-q', 'no-such-ref']), (e) => e.kind === 'fail' && e.exitCode === 1);
  await assert.rejects(gitRun(fx.sub, ['no-such-subcommand']), (e) => e.kind === 'fail' && typeof e.exitCode === 'number' && e.exitCode !== 0);
});

test('diffText: 작업 폴더 안 변경만, 머리글 경로는 폴더 접두어 없이', { skip }, async () => {
  const d = await diffText(fx.sub);
  assert.ok(d.includes('+export const a = 2;'), '수정 내용 포함');
  assert.ok(d.includes('-export const a = 1;'));
  assert.ok(d.includes('diff --git a/한글 파일.js b/한글 파일.js'), '접두어 sub/ 없는 머리글');
  assert.ok(!d.includes('a/sub/'), '접두어가 붙지 않는다');
  assert.ok(d.includes('inner/y.js'), '이름 변경도 포함');
  assert.ok(!d.includes('top = 2') && !d.includes('top.js') && !d.includes('outside'), '폴더 밖 변경은 없다');
  assert.ok(!d.includes('new.txt'), '미추적 파일은 diff 에 나오지 않는다');
});

test('diffText: 파일을 지정하면 그 파일만, 위험 경로는 거부', { skip }, async () => {
  const d = await diffText(fx.sub, '한글 파일.js');
  assert.ok(d.includes('+export const a = 2;'));
  assert.ok(!d.includes('inner/y.js'));
  assert.equal((d.match(/^diff --git /gm) || []).length, 1);
  assert.equal(await diffText(fx.sub, 'inner\\y.js').then((t) => t.includes('inner/y.js')), true, '역슬래시 경로도 허용');
  for (const bad of ['.git/config', '../top.js', 'C:x']) await assert.rejects(diffText(fx.sub, bad), DENIED, bad);
});

test('diffText: 커밋이 없는 저장소·미추적 파일뿐이면 빈 문자열', { skip }, async () => {
  const fresh = initRepo('nocommit');
  put(fresh, 'a.js', 'a\n');
  assert.equal(await diffText(fresh), '');
  assert.equal(await diffStat(fresh), '');
  git(fresh, 'add', '-A');
  git(fresh, 'commit', '-q', '-m', 'init');
  put(fresh, 'untracked.js', 'u\n');
  assert.equal(await diffText(fresh), '');
  assert.equal(await diffStat(fresh), '');
});

test('diffText: textconv·외부 diff 명령을 실행하지 않는다', { skip }, async () => {
  const repo = initRepo('attr');
  const marker = path.join(repo, 'ran.txt');
  put(repo, '.gitattributes', '*.dat diff=evil\n');
  put(repo, 'a.dat', 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  put(repo, 'a.dat', 'two\n');
  const cmd = `node -e "require('fs').writeFileSync('ran.txt','x')"`;
  git(repo, 'config', 'diff.evil.textconv', cmd);
  git(repo, 'config', 'diff.external', cmd);
  const d = await diffText(repo);
  assert.ok(d.includes('+two'));
  assert.equal(fs.existsSync(marker), false, '변환 명령이 실행되었다');
});

test('diffStat: 파일명과 변경 요약', { skip }, async () => {
  const s = await diffStat(fx.sub);
  assert.ok(s.includes('한글 파일.js'));
  assert.ok(/changed/.test(s));
  assert.ok(!s.includes('top.js'), '폴더 밖 파일은 없다');
});

function searchFixture() {
  const repo = initRepo('search');
  put(repo, '.gitignore', '*.log\n');
  put(repo, 'sub/한글 파일.js', '// 안녕하세요 세계\r\nconst keyword = 1;\n');
  put(repo, 'sub/bin.dat', Buffer.from('keyword\0binary'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  put(repo, 'sub/untracked.txt', 'keyword in untracked\n-x marker\n--untracked marker\n');
  put(repo, 'sub/ignored.log', 'keyword ignored\n');
  put(repo, 'sub/binary-new.dat', Buffer.from('keyword\0binary2'));
  put(repo, 'outside.txt', 'keyword outside\n');
  return path.join(repo, 'sub');
}

test('searchText: 한글 내용·경로, 미추적 포함, 무시·바이너리·폴더 밖 제외', { skip }, async () => {
  const sub = searchFixture();
  const r = await searchText(sub, 'keyword');
  assert.equal(r.truncated, false);
  assert.deepEqual(sorted(r.matches), sorted([
    { path: '한글 파일.js', line: 2, text: 'const keyword = 1;' },
    { path: 'untracked.txt', line: 1, text: 'keyword in untracked' },
  ]));
  const kr = await searchText(sub, '안녕하세요');
  assert.deepEqual(kr.matches, [{ path: '한글 파일.js', line: 1, text: '// 안녕하세요 세계' }], '줄 끝 CR 은 제거된다');
  assert.deepEqual(await searchText(sub, '없는 말 zzz'), { matches: [], truncated: false });
});

test('searchText: 검색어는 고정 문자열이고 옵션으로 해석되지 않는다', { skip }, async () => {
  const sub = searchFixture();
  assert.deepEqual((await searchText(sub, '-x')).matches.map((m) => m.text), ['-x marker']);
  assert.deepEqual((await searchText(sub, '--untracked')).matches.map((m) => m.text), ['--untracked marker']);
  assert.deepEqual((await searchText(sub, '.*')).matches, [], '정규식이 아니다');
});

test('searchText: limit 을 넘으면 잘림 표시', { skip }, async () => {
  const sub = searchFixture();
  const one = await searchText(sub, 'keyword', 1);
  assert.equal(one.matches.length, 1);
  assert.equal(one.truncated, true);
  const two = await searchText(sub, 'keyword', 2);
  assert.equal(two.matches.length, 2);
  assert.equal(two.truncated, false, '딱 맞으면 잘린 것이 아니다');
});

test('searchText: 빈·긴 검색어, 줄바꿈·NUL, 문자열이 아닌 값은 거부', { skip }, async () => {
  const sub = searchFixture();
  for (const bad of ['', 'a\nb', 'a\rb', 'a\0b', 'x'.repeat(201), null, undefined, 5, {}]) {
    await assert.rejects(searchText(sub, bad), { message: '잘못된 검색어입니다' }, JSON.stringify(bad));
  }
  assert.equal((await searchText(sub, 'x'.repeat(200))).matches.length, 0, '200자는 허용');
});

test('diffText·diffStat: diff.noprefix·mnemonicPrefix 설정이 있어도 머리글은 a/ b/ 로 고정', { skip }, async () => {
  const repo = initRepo('prefix');
  put(repo, 'x.js', 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  put(repo, 'x.js', 'two\n');
  for (const [k, v] of [['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true']]) {
    git(repo, 'config', k, v);
    const d = await diffText(repo);
    assert.ok(d.includes('diff --git a/x.js b/x.js'), `${k}: ${d.split('\n')[0]}`);
    assert.ok(d.includes('--- a/x.js') && d.includes('+++ b/x.js'));
    assert.ok((await diffText(repo, 'x.js')).includes('diff --git a/x.js b/x.js'), `${k} 파일 지정`);
    assert.ok((await diffStat(repo)).includes('x.js'));
    git(repo, 'config', '--unset', k);
  }
});

test('hasHead: 커밋이 있으면 true, 없으면 false', { skip }, async () => {
  const fresh = initRepo('headless');
  assert.equal(await hasHead(fresh), false);
  put(fresh, 'a.js', 'a\n');
  git(fresh, 'add', '-A');
  git(fresh, 'commit', '-q', '-m', 'init');
  assert.equal(await hasHead(fresh), true);
});

test('searchText: grep.column·grep.fullName 설정이 있어도 하위 폴더에서 정상', { skip }, async () => {
  const sub = searchFixture();
  const repo = path.dirname(sub);
  git(repo, 'config', 'grep.column', 'true');
  git(repo, 'config', 'grep.fullName', 'true');
  const r = await searchText(sub, 'keyword');
  assert.deepEqual(sorted(r.matches), sorted([
    { path: '한글 파일.js', line: 2, text: 'const keyword = 1;' },
    { path: 'untracked.txt', line: 1, text: 'keyword in untracked' },
  ]));
});

test('searchText: 정션 너머(폴더 밖) 파일은 결과에서 뺀다', { skip }, async () => {
  const sub = searchFixture();
  const outside = mkdir('outside');
  put(outside, 'leak.txt', 'keyword leaked\n');
  try { fs.symlinkSync(outside, path.join(sub, 'link'), 'junction'); } catch { return; } // 연결을 만들 수 없는 환경
  const r = await searchText(sub, 'keyword');
  assert.ok(r.matches.length >= 2);
  assert.ok(!r.matches.some((m) => m.path.startsWith('link')), JSON.stringify(r.matches));
  assert.ok(!r.matches.some((m) => /leak/.test(m.text + m.path)));
});

test('createCodeService.search: 미등록 폴더·깃 아닌 폴더 거부, 등록 폴더는 검색', { skip }, async () => {
  const roots = createCodeRoots();
  const service = createCodeService({ roots });
  await assert.rejects(service.search(fx.sub, 'const'), { message: '허용되지 않는 폴더입니다' });
  roots.add(plain);
  await assert.rejects(service.search(plain, 'const'), { message: '깃 저장소가 아닙니다' });
  roots.add(fx.sub);
  assert.equal((await service.search(fx.sub, 'const a')).matches.length, 1);
});

test('code:git:sync: hasMessage 를 그대로 넘겨, 메인이 옛 화면의 동기화를 거부하고 잘못된 값도 가른다', async () => {
  const handlers = new Map();
  const got = [];
  const gitOps = { sync: async (root, r) => { got.push([root, r]); return { ok: true }; } };
  registerCodeIpc((ch, fn) => handlers.set(ch, fn), { roots: createCodeRoots(), service: {}, pickFolder: async () => null, checkFolder() {}, gitOps });
  await handlers.get('code:git:sync')({ root: 'R', hasMessage: true });
  await handlers.get('code:git:sync')({ root: 'R', hasMessage: false });
  await handlers.get('code:git:sync')({ root: 'R', hasMessage: 'true' });
  assert.deepEqual(got, [['R', { hasMessage: true }], ['R', { hasMessage: false }], ['R', { hasMessage: 'true' }]]);
});

// 반드시 이 파일의 맨 뒤 시험: closing 은 프로세스에 남는 상태라 한 번 켜면 이 프로세스에서 되돌릴 수 없다.
// 조회 중에 앱이 종료되면 다음 단계 재시도(track)가 뒤늦게 떠서 로그인 창이 남기 때문에, 종료 뒤의 track 실행은 띄우지 않고 거부한다.
test('killTrackedGit({ closing: true }): 그 뒤의 track 실행은 띄우지 않고 거부, track 없는 호출은 그대로', { skip }, async () => {
  const mark = `aoclose${process.pid}x${Date.now()}`;
  killTrackedGit({ closing: true });
  const t0 = Date.now();
  await assert.rejects(gitRun(fx.sub, ['-c', `ao.marker=${mark}`, 'cat-file', '--batch'], { track: true, timeoutMs: 10000 }),
    (e) => e.kind === 'fail' && /종료하는 중/.test(e.message));
  assert.ok(Date.now() - t0 < 5000, '띄우지 않고 바로 거부');
  assert.equal(trackedGitCount(), 0);
  assert.equal(aliveWithMarker(mark), false, 'git 이 떴다');
  assert.match((await gitRun(fx.sub, ['rev-parse', 'HEAD'])).trim(), /^[0-9a-f]{40}$/, 'track 없는 조회는 종료 중에도 동작');
  await assert.rejects(gitRun(fx.sub, ['rev-parse', 'HEAD'], { refuseClosing: true }), /종료하는 중/, 'refuseClosing: 추적하지 않아도 종료 뒤에는 새로 시작하지 않는다 (pull 병합 단계)');
});

test('언어: 영어 모드의 오류 문구, 출력 상한 초과는 문구가 아니라 표시(tooBig)로 가른다', { skip }, async () => {
  setLang('en');
  try {
    assert.throws(() => resolveInside(base, '../x'), { message: 'Path not allowed' });
    await assert.rejects(createCodeService({ roots: createCodeRoots() }).tree(base), { message: 'Folder not allowed' });
    assert.equal(await folderProblem(path.join(base, 'no-such-dir')), 'The folder does not exist.\nIt may have been deleted, renamed, or its drive may be disconnected.');
    // 출력이 상한을 넘으면 tooBig 표시가 붙고, 스테이징 보기(indexFile)는 문구가 아니라 이 표시로 「표시 안 함」을 가른다
    const err = await gitRun(base, ['--version'], { maxBuffer: 1 }).then(() => null, (e) => e);
    assert.ok(err && err.tooBig === true && err.message === 'Git output is too large', String(err && err.message));
  } finally {
    setLang('ko');
  }
  assert.throws(() => resolveInside(base, '../x'), DENIED);
});
