'use strict';

// 코드 화면의 메인 쪽: 허용된 폴더(깃 저장소) 안에서만 git 조회와 파일 읽기를 한다 (electron 에 기대지 않아 테스트할 수 있다).
// 렌더러는 폴더·상대 경로만 보내고, 여기서 등록 여부·경로 안쪽 여부를 모두 다시 검사한다.

const { execFile, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const claudeCli = require('./claudeCli.cjs');
const { cleanEnv } = require('./env.cjs');

const MAX_TREE = 20000; // 트리에 올리는 파일 수 상한
const MAX_READ = 2 * 1024 * 1024; // 읽는 파일 크기 상한
const SNIFF_BYTES = 8000; // 앞부분에 NUL 이 있으면 바이너리로 본다
const GIT_TIMEOUT_MS = 10000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const WIN = process.platform === 'win32';
const ERR_PATH = '허용되지 않는 경로입니다';
const ERR_ROOT = '허용되지 않는 폴더입니다';
const ERR_BAD = '잘못된 요청입니다';

// ---------- 경로 ----------

// 폴더 비교용 키: 절대 경로(끝 구분자 제거), 윈도우는 대소문자 무시
function rootKey(dir) {
  const k = path.resolve(dir);
  return WIN ? k.toLowerCase() : k;
}

function toGitPath(rel) {
  return String(rel).replace(/\\/g, '/');
}

// parent 의 엄격한 안쪽이면 그 상대 경로, 아니면 null (같은 폴더·바깥·다른 드라이브 모두 null).
// win32 의 path.relative 는 대소문자를 무시하고, 다른 드라이브면 절대 경로를 돌려주므로 함께 거른다.
function relWithin(parent, child) {
  const out = path.relative(parent, child);
  if (out === '' || out === '..' || out.startsWith(`..${path.sep}`) || path.isAbsolute(out)) return null;
  return out;
}

// 조각 중 `..`, `.git`(끝 점·공백을 윈도우가 떼므로 `.git.` 도 같은 곳, 8.3 이름 `GIT~1` 포함) 이 있으면 true
function hasForbiddenPiece(rel) {
  for (const piece of rel.split(/[\\/]/)) {
    if (piece === '' || piece === '.') continue;
    if (piece === '..') return true;
    const t = piece.replace(/[. ]+$/, '');
    if (!t || t.toLowerCase() === '.git' || /^git~\d+$/i.test(t)) return true;
  }
  return false;
}

// root 안쪽의 절대 경로를 돌려준다. 바깥·위험 경로는 던진다. (대상이 없어도 통과 — 읽을 때 missing 으로 처리)
function resolveInside(root, rel) {
  const deny = () => new Error(ERR_PATH);
  // ':' 는 드라이브 상대(C:x)·대체 데이터 스트림(a.js:stream) 을 함께 막는다
  if (typeof rel !== 'string' || !rel || rel.includes(':') || rel.includes('\0') || path.isAbsolute(rel)) throw deny();
  if (hasForbiddenPiece(rel)) throw deny();
  const abs = path.resolve(root, rel);
  if (relWithin(root, abs) === null) throw deny();
  let real = null;
  try { real = fs.realpathSync.native(abs); } catch { /* 없는 경로 */ }
  if (real !== null) {
    // 정션·심볼릭 링크로 바깥을 가리키는 경우, 또는 링크로 .git 을 가리키는 경우
    const inner = relWithin(fs.realpathSync.native(root), real);
    if (inner === null || hasForbiddenPiece(inner)) throw deny();
  }
  return abs;
}

// 허용 폴더 목록. 키는 rootKey, 목록에는 처음 넣은 표기를 그대로 둔다.
function createCodeRoots() {
  const map = new Map();
  return {
    add(dir) { const k = rootKey(dir); if (!map.has(k)) map.set(k, dir); },
    has(dir) { return typeof dir === 'string' && dir !== '' && map.has(rootKey(dir)); },
    list() { return [...map.values()]; },
  };
}

// ---------- git 실행 ----------

let gitPathPromise = null;

// git 실행 파일은 처음 한 번 찾아 기억한다. PATH 를 매번 훑거나 저장소 폴더의 git.exe 를 잡지 않도록
// 앱 프로세스 cwd 에서 `where git` 의 첫 .exe 줄, 없으면 Program Files 의 Git. 못 찾으면 null (다음에 다시 시도).
function findGit() {
  if (!gitPathPromise) {
    gitPathPromise = (async () => {
      let lines = [];
      try {
        const r = await claudeCli.run(WIN ? 'where' : 'which', ['git']);
        lines = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      } catch { /* 못 찾음 — 고정 위치로 */ }
      if (!WIN) return lines[0] || null;
      const found = lines.find((l) => /\.exe$/i.test(l) && fs.existsSync(l));
      if (found) return found;
      const fixed = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd', 'git.exe');
      return fs.existsSync(fixed) ? fixed : null;
    })();
    gitPathPromise.then((p) => { if (!p) gitPathPromise = null; });
  }
  return gitPathPromise;
}

function gitError(kind, message) {
  const e = new Error(message);
  e.kind = kind;
  return e;
}

// 자식 git 을 프로세스 트리째 끝낸다. 호출하는 쪽이 「아직 살아 있음」을 확인한 뒤에만 부른다
// (끝난 자식의 pid 는 다른 프로세스가 물려받았을 수 있다 — codexCli.cjs 참고).
function killTree(child) {
  if (WIN) {
    if (!child.pid) return;
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }); } catch { /* 이미 종료 */ }
    return;
  }
  try { child.kill(); } catch { /* 이미 종료 */ }
}
const isAlive = (child) => child.exitCode === null && child.signalCode === null;

// git(root, args, { buffer }) → stdout (buffer 면 Buffer, 아니면 문자열). 실패는 kind 가 붙은 Error:
// 'no-git'(실행 파일 없음) · 'unsafe'(dubious ownership) · 'nodir'(폴더 없음) · 'timeout'(시간 초과) · 'fail'(그 밖의 실패).
// --no-optional-locks: 에이전트의 git add·commit 과 .git/index.lock 을 다투거나 인덱스를 다시 쓰지 않는다.
// core.fsmonitor=false: 저장소 설정에 적힌 fsmonitor 명령이 조회 때마다 실행되는 것을 막는다.
// 시간 초과는 execFile 의 timeout 옵션(최상위 프로세스만 끝낸다) 대신 직접 걸어 자식 트리를 정리한다.
async function git(root, args, { buffer = false, maxBuffer = GIT_MAX_BUFFER, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const file = await findGit();
  if (!file) throw gitError('no-git', 'git 을 찾지 못했습니다');
  const env = cleanEnv({ LC_ALL: 'C' });
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  const argv = ['--no-optional-locks', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', ...args];
  return new Promise((resolve, reject) => {
    let timer = null;
    let timedOut = false;
    const child = execFile(file, argv, { cwd: root, env, windowsHide: true, maxBuffer, encoding: 'buffer' },
      (err, stdout, stderr) => {
        clearTimeout(timer);
        if (timedOut) return; // 이미 시간 초과로 거부했다
        if (!err) return resolve(buffer ? stdout : stdout.toString('utf8'));
        const text = (stderr || Buffer.alloc(0)).toString('utf8').trim();
        // cwd 가 없어도 spawn 은 ENOENT 를 내므로 폴더부터 확인한다
        if (err.code === 'ENOENT') {
          if (!fs.existsSync(root)) return reject(gitError('nodir', `폴더가 없습니다: ${root}`));
          gitPathPromise = null;
          return reject(gitError('no-git', 'git 을 찾지 못했습니다'));
        }
        if (/dubious ownership/i.test(text)) return reject(gitError('unsafe', 'git 이 이 폴더를 안전하지 않은 저장소로 봅니다'));
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          if (isAlive(child)) killTree(child);
          return reject(gitError('fail', 'git 출력이 너무 큽니다'));
        }
        return reject(gitError('fail', `git 실행 실패: ${text.slice(0, 200) || err.message}`));
      });
    timer = setTimeout(() => {
      timedOut = true;
      if (isAlive(child)) killTree(child);
      reject(gitError('timeout', 'git 조회 시간이 초과되었습니다'));
    }, timeoutMs);
  });
}

const isBinary = (buf) => buf.subarray(0, SNIFF_BYTES).includes(0);
// 편집기에는 BOM 없이 넘긴다 (읽기와 HEAD 쪽을 같은 규칙으로 맞춰 비교에서 첫 줄이 어긋나지 않게)
const decode = (buf) => { const s = buf.toString('utf8'); return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s; };
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// 중첩 저장소는 `dir/` 로 나온다 — 트리·상태가 같은 경로로 맞도록 끝 `/` 를 뗀다
const noSlash = (p) => p.replace(/\/+$/, '');

// ---------- 깃 조회 ----------

// prefix: 저장소 루트에서 이 폴더까지의 경로 ('sub/' 형식, 루트면 '')
// 첫 줄이 true 가 아니면 작업 트리 안이 아니다 (예: .git 폴더 자체). 시간 초과는 not-repo 로 바꾸지 않고 그대로 던진다.
async function repoInfo(root) {
  try {
    const out = await git(root, ['rev-parse', '--is-inside-work-tree', '--show-prefix']);
    const lines = out.split(/\r?\n/);
    if (lines[0] !== 'true') return { git: false, reason: 'not-repo' };
    return { git: true, prefix: lines[1] || '' };
  } catch (e) {
    if (e.kind === 'no-git' || e.kind === 'unsafe') return { git: false, reason: e.kind };
    if (e.kind === 'nodir' || e.kind === 'timeout') throw e;
    return { git: false, reason: 'not-repo' };
  }
}

const nulList = (buf) => buf.toString('utf8').split('\0').filter(Boolean);

// 추적 파일을 먼저, 남은 자리에 미추적(무시 대상 제외) 파일. 경로는 이 폴더 기준.
async function listFiles(root, limit = MAX_TREE) {
  const tracked = [...new Set(nulList(await git(root, ['ls-files', '-c', '-z'], { buffer: true })))];
  if (tracked.length > limit) return { files: tracked.slice(0, limit).sort(byCodeUnit), truncated: true };
  const room = limit - tracked.length;
  const others = [...new Set(nulList(await git(root, ['ls-files', '-o', '--exclude-standard', '-z'], { buffer: true })).map(noSlash))];
  const files = [...tracked, ...others.slice(0, room)].sort(byCodeUnit);
  return { files, truncated: others.length > room };
}

// 이 폴더 안의 변경만, 접두어를 뗀 경로로. 항목 형식: `XY path`, 이름 변경·복사(R·C)는 뒤에 원래 경로 토큰이 하나 더 붙는다.
async function statusOf(root, prefix) {
  const parts = (await git(root, ['status', '--porcelain=v1', '-z', '-uall', '--', '.'], { buffer: true })).toString('utf8').split('\0');
  const norm = (s) => (WIN ? s.toLowerCase() : s);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const tok = parts[i];
    if (tok.length < 4) continue;
    const code = tok.slice(0, 2);
    if (/[RC]/.test(code)) i++;
    const p = noSlash(tok.slice(3));
    if (norm(p.slice(0, prefix.length)) !== norm(prefix)) continue; // 이 폴더 밖
    const rel = p.slice(prefix.length);
    if (rel) out.push({ path: rel, code });
  }
  return out;
}

// ---------- 파일 ----------

const isGone = (e) => e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');

async function readText(root, rel, maxBytes = MAX_READ) {
  const abs = resolveInside(root, rel);
  let st;
  try { st = await fs.promises.stat(abs); } catch (e) {
    if (isGone(e)) return { kind: 'missing' };
    throw e;
  }
  if (st.isDirectory()) return { kind: 'dir' }; // 서브모듈은 작업 폴더에서 폴더로 보인다
  if (!st.isFile()) throw new Error('일반 파일이 아닙니다');
  if (st.size > maxBytes) return { kind: 'large', size: st.size };
  let buf;
  try { buf = await fs.promises.readFile(abs); } catch (e) {
    if (isGone(e)) return { kind: 'missing' };
    throw e;
  }
  if (buf.length > maxBytes) return { kind: 'large', size: buf.length }; // 읽는 사이 커진 경우
  if (isBinary(buf)) return { kind: 'binary' };
  return { kind: 'text', text: decode(buf), mtimeMs: st.mtimeMs };
}

async function statMtime(root, rel) {
  const abs = resolveInside(root, rel);
  try { return (await fs.promises.stat(abs)).mtimeMs; } catch (e) {
    if (isGone(e)) return null;
    throw e;
  }
}

// HEAD 에 커밋된 내용. 없는 파일·폴더·바이너리·상한 초과·git 실패는 모두 null.
// cat-file blob: 파일 내용(blob)만 원본 그대로 받는다 (show 는 범위 문법을 풀거나 폴더 목록을 돌려줄 수 있다).
async function headText(root, rel, maxBytes = MAX_READ) {
  const gitRel = toGitPath(path.relative(root, resolveInside(root, rel)));
  try {
    const buf = await git(root, ['cat-file', 'blob', `HEAD:./${gitRel}`], { buffer: true, maxBuffer: maxBytes + 1 });
    if (buf.length > maxBytes || isBinary(buf)) return null;
    return decode(buf);
  } catch {
    return null;
  }
}

// ---------- 서비스·IPC ----------

// 모든 메서드는 등록된 폴더인지 먼저 본다. 깃 여부는 폴더별로 기억하되, tree 는 매번 다시 확인한다
// (나중에 git init 한 폴더를 ⟳ 로 열 수 있게). 경로 검사는 readText·statMtime·headText 가 resolveInside 로 한다.
function createCodeService({ roots }) {
  const infos = new Map();
  const need = (root) => { if (!roots.has(root)) throw new Error(ERR_ROOT); };
  const infoOf = async (root, fresh = false) => {
    const k = rootKey(root);
    if (fresh || !infos.has(k)) infos.set(k, await repoInfo(root));
    return infos.get(k);
  };
  const repo = async (root) => {
    need(root);
    const info = await infoOf(root);
    if (!info.git) throw new Error('깃 저장소가 아닙니다');
    return info;
  };
  return {
    async tree(root) {
      need(root);
      const info = await infoOf(root, true);
      if (!info.git) return info;
      return { git: true, ...await listFiles(root) };
    },
    async poll(root, rel) {
      const { prefix } = await repo(root);
      const changes = await statusOf(root, prefix);
      // 열린 파일 경로가 거부되거나 읽기 실패여도 변경 목록은 돌려준다 (시각만 없음)
      let mtimeMs = null;
      if (rel) { try { mtimeMs = await statMtime(root, rel); } catch { /* 경로 거부·읽기 실패 */ } }
      return { changes, mtimeMs };
    },
    async read(root, rel) {
      await repo(root);
      return readText(root, rel);
    },
    async base(root, rel) {
      await repo(root);
      return { text: await headText(root, rel) };
    },
  };
}

// handleMain: 보낸 쪽 검사를 마치고 이벤트를 뗀 인자만 넘기는 ipcGuard 의 handleMain.
// 폴더 등록(code:allow)은 렌더러가 탭을 열 때 알린다 — 허용 폴더는 실수 방지 장치이고, 신뢰 경계는 pty:create 와 같다.
function registerCodeIpc(handleMain, { roots, service, pickFolder, checkFolder }) {
  const req = (v, key = 'root') => {
    if (!v || typeof v !== 'object' || typeof v[key] !== 'string') throw new Error(ERR_BAD);
    return v;
  };
  handleMain('code:allow', async (v) => {
    const { cwd } = req(v, 'cwd');
    checkFolder(cwd);
    roots.add(cwd);
    return true;
  });
  handleMain('code:pick', async () => {
    const dir = await pickFolder();
    if (typeof dir !== 'string' || !dir) return null;
    roots.add(dir);
    return dir;
  });
  handleMain('code:tree', async (v) => service.tree(req(v).root));
  handleMain('code:poll', async (v) => service.poll(req(v).root, v.rel ?? null));
  handleMain('code:read', async (v) => service.read(req(v).root, v.rel));
  handleMain('code:base', async (v) => service.base(req(v).root, v.rel));
}

module.exports = {
  resolveInside, toGitPath, createCodeRoots, repoInfo, listFiles, statusOf,
  readText, statMtime, headText, createCodeService, registerCodeIpc, git,
};
