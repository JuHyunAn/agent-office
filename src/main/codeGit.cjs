'use strict';

// 코드 화면 Git 패널의 메인 쪽: 상태·스테이징·커밋·가져오기·푸시·기록 (electron 에 기대지 않아 테스트할 수 있다).
// 렌더러는 폴더·경로·메시지만 보내고 git 인자는 여기서 고정한다. 커밋·푸시는 main 브랜치만, 강제 푸시는 없다.
// git 실행(git)·폴더 키(rootKey)·허용 폴더(roots)는 codeRepo 에서 주입받는다 (codeRepo 를 require 하지 않는다).

const fs = require('node:fs');
const path = require('node:path');

const BRANCH = 'main';
const REMOTE = 'origin';
const WRITE_TIMEOUT_MS = 120000;
const LOG_TIMEOUT_MS = 30000;
const LOG_MAX = 200;
const MESSAGE_MAX = 20000;
const LOCK_RETRY = [300, 700, 1500]; // 다른 git 이 index.lock 을 쥐고 있을 때 로컬 쓰기를 다시 시도하는 간격
// 이 파일·폴더가 있으면 병합·cherry-pick·revert·rebase 가 진행 중이다 (첫째가 MERGE_HEAD — info().mergeHead)
const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];

// 모든 로컬 쓰기(add·restore·rm·commit·merge --abort)에 넘긴다: 편집기·병합 메시지 편집·로그인 입력을 기다리며 멈추지 않게.
const WRITE_ENV = { GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const NET_TIMEOUT_MS = 300000; // 네트워크 명령: 로그인 창에서 입력할 시간까지 5분
// 네트워크 명령: GCM 로그인 창은 허용하고 터미널 입력만 끈다 (패널에는 입력할 터미널이 없다)
const NET_ENV = { GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', GIT_TERMINAL_PROMPT: '0' };
// 인증 실패 뒤 재시도: 도우미 목록을 비우고 GCM 만, 앱 전용 저장 공간에서.
// 더하기만 하면 gh 토큰이 GCM 에 복사되고 만료된 gh 에 막히며, 전용 공간이 아니면 거부 때 사용자의 기존 항목이 지워진다 (실측)
const GCM_ARGS = ['-c', 'credential.helper=', '-c', 'credential.helper=manager'];
// 저장 공간은 -c credential.namespace 가 아니라 환경 변수로: GCM_NAMESPACE 는 사용자의 URL 전용 설정까지 이기고,
// -c 는 사용자의 환경 변수·URL 전용 설정에 진다 (실측) — 지면 사용자의 기존 항목을 읽고 지우게 된다.
const GCM_ENV = { ...NET_ENV, GCM_NAMESPACE: 'agent-office' };
const AUTH_LAST_LINE = /^fatal: (could not read (Username|Password) for '.+': terminal prompts disabled|Authentication failed for '.+')$/;
const AUTH_REJECTED = /^fatal: Authentication failed for /;
// 도우미 설정값의 모양: `!'C:/Program Files/GitHub CLI/gh.exe' auth git-credential` · `!gh auth git-credential` 은 gh, `manager` · `manager-core` · `…/git-credential-manager.exe` 는 GCM.
// 이름만 닮은 도우미(glab·1password-manager·사용자 폴더 이름 manager)는 맞지 않아야 한다.
const GH_HELPER = /\bgh(\.exe)?['"]?\s+auth git-credential/i;
const GCM_HELPER = /(^|[\\/\s'"!])(git-credential-)?manager(-core)?(\.exe)?(['"]|\s|$)/i;
const lastLine = (s) => String(s || '').trim().split(/\r?\n/).pop().trim();
// 하위 폴더에서 실행해도 `:/` 로 저장소 전체를 루트 기준 경로로 받는다 (실측)
const STATUS_ARGS = ['status', '--porcelain=v2', '--branch', '-z', '-uall', '--', ':/'];

const ERR_ROOT = '허용되지 않는 폴더입니다';
const ERR_BAD = '잘못된 요청입니다';
const ERR_NO_REMOTE = 'origin 원격이 없습니다';

// ---------- 순수 함수 ----------

// 앞 n개 칸(공백 구분)을 건너뛴 나머지. 경로의 공백은 그대로 둔다.
function afterFields(tok, n) {
  let pos = -1;
  for (let k = 0; k < n; k++) {
    pos = tok.indexOf(' ', pos + 1);
    if (pos < 0) return null;
  }
  return tok.slice(pos + 1);
}

// `status --porcelain=v2 --branch -z` 출력. 경로는 저장소 루트 기준.
function parseStatusV2(text) {
  const src = Buffer.isBuffer(text) ? text.toString('utf8') : String(text ?? '');
  const noSlash = (p) => p.replace(/\/+$/, ''); // 중첩 저장소·서브모듈은 `dir/` 로 나온다
  const subOf = (tok) => tok.slice(5, tok.indexOf(' ', 5)); // `1 XY sub …` 의 sub 칸 (서브모듈 상태: N... 또는 S<커밋><추적><미추적>)
  const out = { oid: null, initial: false, head: null, detached: false, upstream: null, ahead: null, behind: null, entries: [] };
  const toks = src.split('\0');
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i];
    if (!tok) continue;
    if (tok.startsWith('# ')) {
      const m = /^# branch\.(oid|head|upstream|ab) (.*)$/.exec(tok);
      if (!m) continue;
      if (m[1] === 'oid') { if (m[2] === '(initial)') out.initial = true; else out.oid = m[2]; }
      else if (m[1] === 'head') { if (m[2] === '(detached)') out.detached = true; else out.head = m[2]; }
      else if (m[1] === 'upstream') out.upstream = m[2];
      else {
        const ab = /^\+(\d+) -(\d+)$/.exec(m[2]);
        if (ab) { out.ahead = Number(ab[1]); out.behind = Number(ab[2]); }
      }
      continue;
    }
    const xy = tok.slice(2, 4);
    if (tok[0] === '1' && tok[1] === ' ') {
      const p = afterFields(tok, 8);
      if (p) out.entries.push({ kind: 'ordinary', x: xy[0], y: xy[1], sub: subOf(tok), path: noSlash(p) });
    } else if (tok[0] === '2' && tok[1] === ' ') {
      const p = afterFields(tok, 9);
      const orig = toks[++i]; // 다음 NUL 토큰이 원래 경로
      if (p) out.entries.push({ kind: 'rename', x: xy[0], y: xy[1], sub: subOf(tok), path: noSlash(p), orig: noSlash(orig ?? '') });
    } else if (tok[0] === 'u' && tok[1] === ' ') {
      const p = afterFields(tok, 10);
      if (p) out.entries.push({ kind: 'unmerged', x: xy[0], y: xy[1], sub: subOf(tok), path: noSlash(p) });
    } else if (tok[0] === '?' && tok[1] === ' ') {
      out.entries.push({ kind: 'untracked', x: '?', y: '?', path: noSlash(tok.slice(2)) });
    }
    // '! ' (무시된 파일)과 알 수 없는 토큰은 건너뛴다
  }
  return out;
}

// 스테이징된 변경 / 아직 안 한 변경 / 충돌로 나눈다. 이름 변경·복사(R·C)의 원래 경로는 그쪽 항목에 orig 로.
// 서브모듈이 내용만 더러우면(sub 가 `S` 로 시작하고 둘째 글자가 `.` — 서브모듈 커밋은 그대로, y 가 M) git add 로 올릴 수 없어 changes 항목에 stageable:false.
// 서브모듈 폴더를 지운 삭제(.D S...)는 올릴 수 있으므로 제외한다.
function statusLists(entries) {
  const staged = [];
  const changes = [];
  const conflicts = [];
  const item = (e, code) => (/[RC]/.test(code) && e.orig ? { path: e.path, orig: e.orig, code } : { path: e.path, code });
  for (const e of entries) {
    if (e.kind === 'unmerged') conflicts.push({ path: e.path });
    else if (e.kind === 'untracked') changes.push({ path: e.path, code: 'U' });
    else {
      if (e.x !== '.') staged.push(item(e, e.x));
      if (e.y !== '.') {
        const it = item(e, e.y);
        if (typeof e.sub === 'string' && e.sub[0] === 'S' && e.sub[1] === '.' && e.y === 'M') it.stageable = false;
        changes.push(it);
      }
    }
  }
  return { staged, changes, conflicts };
}

// 항목들의 경로(이름 변경은 원래 경로 포함). 대소문자를 합치지 않는다.
function pathSet(list) {
  const set = new Set();
  for (const it of list) { set.add(it.path); if (it.orig) set.add(it.orig); }
  return set;
}

// 경로를 저장소 루트 기준 문자 그대로 (glob·`:` 마법·옵션처럼 보이는 이름 방지)
const topPathspec = (p) => `:(top,literal)${p}`;
// --pathspec-from-file=- --pathspec-file-nul 로 넘길 입력 (명령줄 길이 한도 회피)
const pathspecInput = (paths) => paths.map((p) => `${p}\0`).join('');

const LOG_FORMAT = '%H%x00%P%x00%D%x00%an%x00%at%x00%s%x1e';

function parseLog(text) {
  const commits = [];
  for (const piece of String(text ?? '').split('\x1e')) {
    const rec = piece.trim();
    if (!rec) continue;
    const f = rec.split('\0');
    if (f.length !== 6) continue;
    commits.push({
      hash: f[0],
      parents: f[1].split(' ').filter(Boolean),
      refs: f[2].split(', ').filter(Boolean),
      author: f[3],
      at: Number(f[4]) * 1000,
      subject: f[5],
    });
  }
  return commits;
}

// 위에서부터 먼저 맞는 것. 판정 글은 stderr·stdout·message 를 모두 본다 (nothing to commit·[rejected] 는 stdout 에 나온다).
// error 가 함수면 (stderr, 오류) 를 받아 문구를 만든다. no-src 는 같은 출력에 섞이는 failed to push some refs 보다 먼저 가른다.
const RULES = [
  [/index\.lock|Another git process seems to be running|\.lock': File exists/, 'lock', '다른 git 작업이 저장소를 잠그고 있습니다.\n잠시 뒤 다시 시도해 주세요.'],
  [/Please tell me who you are|Author identity unknown|unable to auto-detect email|no email was given/, 'no-identity', 'git 사용자 이름·이메일이 없습니다.\n터미널에서 git config 로 설정해 주세요.'],
  [/Aborting commit due to empty commit message/, 'empty', '커밋 메시지를 입력해 주세요.'],
  [/nothing to commit|nothing added to commit|no changes added to commit/, 'nothing', '커밋할 변경이 없습니다'],
  [/unmerged files|unresolved conflict/, 'unmerged', '충돌이 해결되지 않았습니다.\n터미널에서 마무리해 주세요.'],
  [/gpg failed to sign|failed to write commit object/, 'sign', '커밋 서명에 실패했습니다.\n터미널에서 확인해 주세요.'],
  [/src refspec/, 'no-src', '로컬 main 브랜치가 없습니다'],
  [/\[remote rejected\]/, 'remote-rejected', (stderr) => `원격이 푸시를 거부했습니다:\n${stderr.slice(-200)}`],
  [/\[rejected\]|Updates were rejected/, 'rejected', '원격이 앞서 있어 푸시가 거절되었습니다.\nPull 또는 Commit & Sync 를 써 주세요.'],
  [/could not read Username|terminal prompts disabled|Authentication failed|Permission denied \(publickey\)|could not read Password/, 'auth',
    (stderr, e) => (e?.viaGh ? '원격 인증에 실패했습니다.\n하단 터미널에서 gh auth login 으로 로그인해 주세요.' : '원격 인증에 실패했습니다.\n하단 터미널에서 git push 로 로그인해 주세요.')],
  [/couldn't find remote ref/, 'no-remote-ref', '원격에 main 브랜치가 없습니다'],
  [/does not appear to be a git repository|Could not read from remote repository|Could not resolve host|unable to access/, 'no-remote', '원격 저장소에 연결하지 못했습니다'],
  [/would be overwritten by merge/, 'overwrite', '가져오는 변경이 커밋하지 않은 파일과 겹쳐 중단했습니다.\n터미널에서 확인해 주세요.'],
  [/CONFLICT/, 'conflict', '충돌이 있습니다'],
];

const REMOTE_MSG_MAX = 1000;
// 403 과 함께 원격이 보낸 remote: 줄 (재승인 주소 등). 앱 안내로 보이지 않게 접두어를 남기고 제어 문자는 지운다.
// 넘치면 앞 줄부터 버린다 — 글자 단위로 자르면 주소 앞이 잘려 쓸 수 없다. 한 줄이 넘치면 앞쪽을 남긴다.
function remoteMessage(stderr) {
  const lines = stderr.split(/\r?\n/).map((l) => l.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .filter((l) => /^remote:\s*\S/.test(l));
  while (lines.length > 1 && lines.join('\n').length > REMOTE_MSG_MAX) lines.shift();
  return lines.join('\n').slice(0, REMOTE_MSG_MAX);
}

// stderr 마지막 줄로만 가르는 안내: 파일 이름·hook·원격 메시지의 같은 글자에 속지 않게. RULES 보다 먼저 본다.
const LAST_LINE_RULES = [
  [/^fatal: refusing to merge unrelated histories$/, 'unrelated', '로컬과 원격의 커밋 기록이 서로 이어져 있지 않아 병합하지 않았습니다.\n같은 프로젝트가 맞다면 터미널에서 아래 명령으로 합쳐 주세요.\ngit pull --no-rebase --no-edit --ff --allow-unrelated-histories origin main'], // --ff: merge.ff=only 설정이 함께 있어도 병합되게
  [/^fatal: unable to access '.+': The requested URL returned error: 403$/, 'no-access', (stderr) => {
    const remote = remoteMessage(stderr);
    return `원격이 접근을 거부했습니다. (403)\n저장소 권한·로그인 계정·토큰 범위·조직 SSO 를 확인해 주세요.${remote ? `\n원격 메시지:\n${remote}` : ''}`;
  }],
  [/^fatal: repository '.+' not found$/, 'repo-not-found', '원격 저장소를 찾을 수 없습니다.\n저장소 주소나 로그인한 계정의 권한을 확인해 주세요.'],
  [/^fatal: Not possible to fast-forward, aborting\.$/, 'ff-only', '빨리 감기만 허용하는 설정 때문에 병합하지 않았습니다.\n터미널에서 아래 명령으로 병합해 주세요.\ngit pull --no-rebase --no-edit --ff origin main'],
];

// git() 의 오류를 { code, error } 로. step 이 'commit' 이고 종료 코드가 1 이면 (위 문구에 안 걸린) hook 실패로 본다.
// 종료 코드 1 은 git 자신의 잠금 실패(128)가 아니라 hook 등 다른 프로그램의 실패이므로, 그 출력의 index.lock 글자는 잠금으로 보지 않는다.
function errorOf(e, step) {
  const kind = e?.kind;
  if (kind === 'timeout') {
    if (e.net) return { code: 'timeout', error: '원격 작업 시간이 초과되었습니다.\n로그인 창이 열려 있었다면 다시 시도해 주세요.' };
    return { code: 'timeout', error: 'git 작업 시간이 초과되었습니다.\n잠금 파일이나 스테이징이 남았을 수 있으니\n터미널에서 git status 로 확인해 주세요.' };
  }
  if (kind === 'no-git' || kind === 'unsafe' || kind === 'nodir') return { code: kind, error: e.message };
  const stderr = String(e?.stderr || '');
  const last = lastLine(stderr);
  // 커밋 단계는 제외: 커밋 hook 이 같은 문장을 끝 줄로 내면 hook 원문이 사라지고 엉뚱한 병합 명령을 안내하게 된다.
  if (step !== 'commit') for (const [re, code, error] of LAST_LINE_RULES) if (re.test(last)) return { code, error: typeof error === 'function' ? error(stderr) : error };
  const text = `${stderr}\n${e?.stdout || ''}\n${e?.message || ''}`;
  for (const [re, code, error] of RULES) {
    if (code === 'lock' && e?.exitCode === 1) continue;
    if (re.test(text)) return { code, error: typeof error === 'function' ? error(stderr, e) : error };
  }
  if (step === 'commit' && e?.exitCode === 1) return { code: 'hook', error: `커밋 전 검사(hook)가 실패했습니다:\n${stderr.slice(0, 300)}` };
  const shown = stderr || String(e?.message || '').replace(/^git 실행 실패:\s*/, '');
  return { code: 'fail', error: `git 실행 실패:\n${shown.slice(-200)}` }; // 원인은 출력 끝에 온다
}

// 파일 이름·hook·원격 메시지의 같은 글자에 속지 않게 stderr 마지막 줄만 본다. 병합이 시작됐다는 글이 stderr·stdout 어디든 있으면 인증 실패가 아니다.
function isAuthFailure(e) {
  if (e?.kind !== 'fail' || !AUTH_LAST_LINE.test(lastLine(e.stderr))) return false;
  return !/CONFLICT|Automatic merge failed|Not committing merge/.test(`${e.stderr || ''}\n${e.stdout || ''}`);
}

// ---------- 작업 ----------

const isPathList = (v) => Array.isArray(v) && v.length > 0 && v.every((p) => typeof p === 'string' && p !== '' && !p.includes('\0'));
const isStrList = (v) => Array.isArray(v) && v.every((p) => typeof p === 'string' && !p.includes('\0'));
const fail = (code, error, extra) => ({ ok: false, code, error, ...extra });

// 던지지 않는다: 모든 메서드는 { ok: true, ... } 또는 { ok: false, code, error, ... } 를 돌려준다.
// 쓰기·네트워크는 저장소(최상위 폴더)마다 한 번에 하나만 — 다른 하위 폴더에서 동시에 오면 busy.
function createGitOps({ git, rootKey, roots, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const busyKeys = new Set();
  const bad = () => fail('bad', ERR_BAD);
  const noRoot = () => fail('root', ERR_ROOT);

  const fromError = (e, step) => {
    // 끝 줄만 본다: 원격이 보낸 메시지의 같은 글자에 속지 않게
    if (e?.kind === 'fail' && /^fatal: not a git repository/.test(lastLine(e.stderr))) return fail('not-repo', '깃 저장소가 아닙니다');
    return { ok: false, ...errorOf(e, step) };
  };

  // 최상위 폴더·이 폴더의 접두어·병합 표식 파일 경로(mergeHead)·진행 중인 작업 여부(inProgress: 병합·cherry-pick·revert·rebase)
  async function info(root) {
    const args = ['rev-parse', '--show-toplevel', '--show-prefix', ...IN_PROGRESS.flatMap((n) => ['--git-path', n])];
    const lines = (await git(root, args)).split(/\r?\n/);
    const marks = IN_PROGRESS.map((_, i) => (lines[2 + i] || '').trim()).map((p) => (p ? path.resolve(root, p) : null));
    return {
      top: lines[0].trim(), prefix: (lines[1] || '').trim(),
      mergeHead: marks[0], inProgress: marks.some((p) => p && fs.existsSync(p)),
    };
  }

  async function read(root) {
    const [meta, statusBuf, remotes] = await Promise.all([
      info(root),
      git(root, STATUS_ARGS, { buffer: true }),
      git(root, ['remote']),
    ]);
    const parsed = parseStatusV2(statusBuf);
    const { staged, changes, conflicts } = statusLists(parsed.entries);
    const hasRemote = remotes.split(/\r?\n/).some((l) => l.trim() === REMOTE);
    const merging = meta.inProgress || conflicts.length > 0;
    const detached = parsed.detached;
    const branch = detached ? null : parsed.head;
    const canWrite = branch === BRANCH && !merging;
    const reason = merging ? 'merging' : detached ? 'detached' : branch !== BRANCH ? 'not-main' : null;
    let ahead = null;
    let behind = null;
    if (parsed.upstream === `${REMOTE}/${BRANCH}`) { ahead = parsed.ahead; behind = parsed.behind; }
    else if (hasRemote) {
      try {
        const [a, b] = (await git(root, ['rev-list', '--left-right', '--count', `${BRANCH}...${REMOTE}/${BRANCH}`])).trim().split(/\s+/).map(Number);
        if (Number.isFinite(a) && Number.isFinite(b)) { ahead = a; behind = b; }
      } catch { /* main 이나 origin/main 이 없음 */ }
    }
    return {
      ok: true, top: meta.top, prefix: meta.prefix, branch, detached, initial: parsed.initial, oid: parsed.oid,
      upstream: parsed.upstream, ahead, behind, hasRemote, merging, canWrite, reason, staged, changes, conflicts,
    };
  }

  async function withWrite(root, run) {
    if (!roots.has(root)) return noRoot();
    let key;
    try { key = rootKey((await info(root)).top); } catch (e) { return fromError(e); }
    if (busyKeys.has(key)) return fail('busy', '다른 Git 작업이 진행 중입니다');
    busyKeys.add(key);
    try { return await run(); } catch (e) { return fromError(e); } finally { busyKeys.delete(key); }
  }

  // main 이 아니거나 병합 중이면 쓰기를 막는다
  function guard(st) {
    if (st.canWrite) return null;
    if (st.reason === 'merging') return fail('merging', '병합 등 다른 git 작업이 진행 중입니다.\n터미널에서 마무리해 주세요.');
    if (st.reason === 'detached') return fail('detached', '분리된 HEAD 입니다.\n터미널에서 main 으로 전환해 주세요.');
    return fail('not-main', `main 브랜치에서만 커밋·푸시합니다. (현재: ${st.branch})\n다른 작업은 아래 터미널에서`);
  }

  // 잠금 때문에 실패한 로컬 쓰기만 다시 시도한다 (그 밖의 실패는 바로 던진다). run 은 몇 번째 시도인지(0부터)를 받는다.
  async function retry(run) {
    for (let i = 0; ; i++) {
      try { return await run(i); } catch (e) {
        if (i >= LOCK_RETRY.length || errorOf(e).code !== 'lock') throw e;
        await sleep(LOCK_RETRY[i]);
      }
    }
  }

  const applyPaths = (root, args, paths) => git(root, [...args, '--pathspec-from-file=-', '--pathspec-file-nul'],
    { input: pathspecInput(paths.map(topPathspec)), timeoutMs: WRITE_TIMEOUT_MS, env: WRITE_ENV });

  const changed = () => fail('changed', '변경 목록이 바뀌었습니다.\n다시 확인해 주세요.');
  // 스테이징할 수 있는 경로: 아직 안 한 변경 중 git add 로 올릴 수 있는 것 (내용만 더러운 서브모듈은 제외)
  const stageablePaths = (st) => pathSet(st.changes.filter((c) => c.stageable !== false));

  // 네트워크 명령 한 번. 앱 종료 때 끝내도록 등록하고, 시간 초과에는 안내를 가르는 표시를 단다.
  const runNet = async (root, args, env = NET_ENV) => {
    try { return await git(root, args, { timeoutMs: NET_TIMEOUT_MS, env, track: true }); } catch (e) {
      if (e?.kind === 'timeout') e.net = true;
      throw e;
    }
  };

  // 이 원격에 쓰이는 도우미. 재시도할 수 없는 원격(https 가 아니거나 URL 에 자격이 든 경우)·조회 실패는 null, 도우미가 없으면 ''.
  async function remoteHelper(root) {
    let url;
    try { url = (await git(root, ['remote', 'get-url', REMOTE])).trim(); } catch { return null; }
    if (!/^https:\/\//i.test(url) || /^https:\/\/[^/@]*:[^/@]*@/i.test(url)) return null;
    try { return lastLine(await git(root, ['config', '--get-urlmatch', 'credential.helper', url])); }
    catch (e) { return e?.exitCode === 1 ? '' : null; }
  }

  // 인증 실패일 때만 재시도한다. 돌려주는 값은 성공한 인증 인자 (pull 이 같은 인자로 병합하게).
  // gh·도우미 없음 → GCM 전용 인자로. GCM 이 이미 나선 경우 → 자격이 거부됐을 때만 한 번 더 (지워졌으니 이번엔 창이 뜬다). 창을 닫은 뒤에는 또 띄우지 않는다.
  // 그 밖의 도우미(aws·gcloud 등)는 그쪽 인증이므로 GCM 창을 띄우지 않는다.
  async function netGit(root, args) {
    try { await runNet(root, args); return []; } catch (first) {
      if (!isAuthFailure(first)) throw first;
      const helper = await remoteHelper(root);
      const viaGh = !!helper && GH_HELPER.test(helper);
      const tag = (e) => Object.assign(e, { viaGh });
      const useGcm = helper === '' || viaGh;
      const sameAgain = !!helper && !viaGh && GCM_HELPER.test(helper) && AUTH_REJECTED.test(lastLine(first.stderr));
      if (!useGcm && !sameAgain) throw tag(first);
      const prefix = useGcm ? GCM_ARGS : [];
      const env = useGcm ? GCM_ENV : NET_ENV; // 같은 도우미 재시도는 사용자 기본 저장 공간 그대로
      try {
        try { await runNet(root, [...prefix, ...args], env); } catch (second) {
          // 전용 항목이 낡아 거부됐다 — 지워졌으니 한 번 더 하면 창이 뜬다 (최대 1회)
          if (!useGcm || !isAuthFailure(second) || !AUTH_REJECTED.test(lastLine(second.stderr))) throw second;
          await runNet(root, [...prefix, ...args], env);
        }
        return prefix;
      } catch (e) { throw tag(e); }
    }
  }

  async function pushCore(root, st) {
    try {
      await netGit(root, ['push', '--porcelain', ...(st.upstream ? [] : ['-u']), REMOTE, `${BRANCH}:${BRANCH}`]);
      return { ok: true };
    } catch (e) { return { ok: false, ...errorOf(e, 'push') }; }
  }

  const revOf = async (root, ref) => {
    try { return (await git(root, ['rev-parse', '-q', '--verify', ref])).trim() || null; } catch { return null; }
  };

  // 병합 방식으로 가져온다. 실패하고 이 pull 이 시작한 병합이 남아 있으면 (충돌·병합 hook 실패) 취소해 작업 폴더를 되돌린다.
  // 다른 환경이 그 사이 시작한 병합일 수 있으므로, MERGE_HEAD 가 방금 가져온 것(FETCH_HEAD)과 같고 「이미 병합 중」 거부가 아닐 때만 취소한다.
  async function pullCore(root) {
    let pulling = false; // fetch 는 병합을 시작할 수 없다 — 병합 증거는 pull 단계에서 난 실패만 인정한다
    try {
      // 로그인은 fetch 에서 마친다: git pull 은 자격을 기다린 뒤 그때의 HEAD 로 병합해서, 대기 중 브랜치가 바뀌면 다른 브랜치가 움직인다 (실측)
      const prefix = await netGit(root, ['fetch', REMOTE, BRANCH]);
      const denied = guard(await read(root));
      if (denied) return denied;
      // 로그인은 fetch 에서 끝났으니 여기서는 창을 띄우지 않는다 (대기 뒤의 HEAD 로 병합되는 위험). 앱을 꺼도 병합은 끝까지 간다 —
      // 도중에 죽이면 잠금·반쯤 갱신된 파일이 남으므로 추적(track)하지 않고, 시간 초과 문구도 로컬 쓰기와 같은 것을 쓴다(net 표시 없음).
      pulling = true;
      await git(root, [...prefix, 'pull', '--no-rebase', '--no-edit', REMOTE, BRANCH],
        { timeoutMs: NET_TIMEOUT_MS, env: { ...(prefix.length ? GCM_ENV : NET_ENV), GCM_INTERACTIVE: 'never' }, refuseClosing: true });
    } catch (e) {
      if (pulling && isAuthFailure(e)) { const h = await remoteHelper(root); e.viaGh = !!h && GH_HELPER.test(h); } // 안내 문구를 도우미에 맞춘다
      let started = false;
      if (e?.kind === 'fail') {
        try { const m = (await info(root)).mergeHead; started = !!m && fs.existsSync(m); } catch { /* 아래 errorOf 로 */ }
      }
      if (!started) return { ok: false, ...errorOf(e, 'pull') };
      // 원격이 보낸 줄(remote: …)은 우리 병합의 증거가 아니다: hook·서버 메시지의 같은 글자에 속지 않게 뺀다.
      const text = `${e.stderr || ''}\n${e.stdout || ''}`.split(/\r?\n/).filter((l) => !l.trimStart().startsWith('remote:')).join('\n');
      const [mergeHead, fetchHead] = await Promise.all([revOf(root, 'MERGE_HEAD'), revOf(root, 'FETCH_HEAD')]);
      // 이 pull 이 병합을 시작했다는 출력 증거가 있을 때만 취소한다: 다른 환경이 같은 원격 커밋을 병합 중이면
      // MERGE_HEAD === FETCH_HEAD 라서 커밋 번호 비교만으로는 우리 것과 구분되지 않는다.
      const ours = pulling && /CONFLICT|Automatic merge failed|Not committing merge/.test(text);
      if (!ours || !mergeHead || mergeHead !== fetchHead) {
        return fail('merging', '다른 작업의 병합이 진행 중이라 건드리지 않았습니다.\n터미널에서 확인해 주세요.');
      }
      try {
        await git(root, ['merge', '--abort'], { timeoutMs: WRITE_TIMEOUT_MS, env: WRITE_ENV });
      } catch { return fail('abort-failed', '병합 취소에 실패했습니다.\n터미널에서 git merge --abort 를 실행해 주세요.'); }
      if (/CONFLICT|Automatic merge failed/.test(text)) return fail('conflict', '충돌이 있어 병합을 취소했습니다.\n하단 터미널에서 git pull 로 해결해 주세요.');
      return fail('merge-failed', `병합을 끝내지 못해 취소했습니다:\n${String(e.stderr || e.message || '').slice(-200)}`);
    }
    const st = await read(root);
    if (st.branch !== BRANCH) return fail('branch-changed', '작업 중 브랜치가 바뀌었습니다.\n터미널에서 확인해 주세요.');
    return { ok: true, st };
  }

  // 가져온 뒤 푸시. 원격에 main 이 아직 없으면(빈 원격 첫 푸시) 가져오기는 건너뛴다.
  // 커밋 hook 이 도는 동안 다른 환경이 병합을 시작했을 수 있어 pull 직전에 다시 읽어 막는다.
  async function syncCore(root) {
    const st0 = await read(root);
    const denied = guard(st0);
    if (denied) return denied;
    const pulled = await pullCore(root);
    if (!pulled.ok) return pulled.code === 'no-remote-ref' ? pushCore(root, st0) : pulled;
    if (pulled.st.ahead === 0) return { ok: true, pushed: false }; // 받을 것만 있었다: 쓰기 권한이 없어도 Sync 가 끝나고, 로그인 창도 뜨지 않게
    const pushed = await pushCore(root, pulled.st);
    return pushed.ok ? pushed : { ...pushed, error: `가져왔지만 푸시하지 못했습니다.\n${pushed.error}` };
  }

  return {
    async state(root) {
      if (!roots.has(root)) return noRoot();
      try { return await read(root); } catch (e) { return fromError(e); }
    },

    async stage(root, paths) {
      if (!isPathList(paths)) return bad();
      return withWrite(root, async () => {
        const st = await read(root);
        const denied = guard(st);
        if (denied) return denied;
        const allowed = stageablePaths(st);
        if (!paths.every((p) => allowed.has(p))) return changed();
        await retry(() => applyPaths(root, ['add'], [...new Set(paths)]));
        return { ok: true };
      });
    },

    async unstage(root, paths) {
      if (!isPathList(paths)) return bad();
      return withWrite(root, async () => {
        const st = await read(root);
        const denied = guard(st);
        if (denied) return denied;
        const allowed = pathSet(st.staged);
        if (!paths.every((p) => allowed.has(p))) return changed();
        // 이름 변경은 새·옛 경로를 함께 해제해야 한쪽만 남지 않는다
        const targets = new Set(paths);
        for (const it of st.staged) if (targets.has(it.path) || (it.orig && targets.has(it.orig))) { targets.add(it.path); if (it.orig) targets.add(it.orig); }
        // 첫 커밋 전에는 HEAD 가 없어 restore 가 128 로 실패한다
        const args = st.initial ? ['rm', '-q', '--cached', '-f'] : ['restore', '--staged'];
        await retry(() => applyPaths(root, args, [...targets]));
        return { ok: true };
      });
    },

    // expected: 화면이 본 스테이징 목록(이름 변경은 orig 포함), stage: 이번에 함께 스테이징할 경로. 커밋 직전 지금 목록과 비교해 어긋나면 거부한다
    // (`commit --only` 는 쓰지 않는다 — 작업 폴더 내용이 섞인다). 잠금 재시도마다 다시 비교한다.
    async commit(root, req) {
      if (!req || typeof req !== 'object') return bad();
      const { message, expected, stage, then } = req;
      if (typeof message !== 'string' || !message.trim() || message.length > MESSAGE_MAX || message.includes('\0')) return fail('bad', '커밋 메시지를 입력해 주세요.');
      if (!isStrList(expected) || (stage != null && !isStrList(stage)) || !(then == null || then === 'push' || then === 'sync')) return bad();
      return withWrite(root, async () => {
        let st = await read(root);
        const denied = guard(st);
        if (denied) return denied;
        if (then && !st.hasRemote) return fail('no-remote', ERR_NO_REMOTE); // 커밋하기 전에 거부
        if (stage && stage.length) {
          const allowed = stageablePaths(st);
          if (!stage.every((p) => allowed.has(p))) return changed();
          await retry(() => applyPaths(root, ['add'], [...new Set(stage)]));
        }
        // 지금 스테이징 목록이 화면이 본 것과 맞는지: 목록 ⊆ expected∪stage, 그리고 stage 가 아닌 expected 는 모두 아직 스테이징돼 있어야 한다
        // (stage 한 파일이 HEAD 와 같아져 스테이징에서 빠지는 경우는 허용).
        const recheck = (cur) => {
          const blocked = guard(cur);
          if (blocked) return blocked;
          const have = pathSet(cur.staged);
          const ask = new Set(stage || []);
          const want = new Set(expected);
          if ([...have].some((p) => !want.has(p) && !ask.has(p)) || [...want].some((p) => !ask.has(p) && !have.has(p))) {
            return fail('staged-changed', '스테이징 목록이 바뀌었습니다.\n확인한 뒤 다시 눌러 주세요.');
          }
          return cur.staged.length ? null : fail('nothing', '커밋할 변경이 없습니다');
        };
        st = await read(root);
        const mismatch = recheck(st);
        if (mismatch) return mismatch;
        try {
          await retry(async (attempt) => {
            if (attempt > 0) { // 잠금을 기다리는 사이 다른 환경이 스테이징을 바꿨을 수 있다
              const again = recheck(await read(root));
              if (again) throw Object.assign(new Error('스테이징 재확인 실패'), { recheck: again });
            }
            return git(root, ['commit', '-F', '-'], { input: `${message.trim()}\n`, timeoutMs: WRITE_TIMEOUT_MS, env: WRITE_ENV });
          });
        } catch (e) {
          if (e.recheck) return e.recheck;
          const failure = { ok: false, ...errorOf(e, 'commit') };
          if (e.kind !== 'timeout') return failure;
          // 시간 초과여도 커밋이 이미 만들어졌을 수 있다 (post-commit hook 이 오래 걸린 경우) — HEAD 가 움직였으면 committed:true
          let head = null;
          try { head = (await git(root, ['rev-parse', 'HEAD'])).trim() || null; } catch { /* 조회 실패면 커밋 여부를 모른다 */ }
          return head && head !== st.oid ? { ...failure, committed: true, oid: head } : failure;
        }
        // 커밋은 이미 됐다 — 이어지는 단계가 어떻게 실패해도 committed:true 를 유지한다
        let oid = null;
        try { oid = (await git(root, ['rev-parse', 'HEAD'])).trim() || null; } catch { /* 커밋 번호는 못 읽어도 된다 */ }
        if (!then) return { ok: true, committed: true, oid };
        let next;
        try { next = then === 'push' ? await pushCore(root, st) : await syncCore(root); } catch (e) { next = { ok: false, ...errorOf(e, 'push') }; }
        if (!next.ok) return { ok: false, committed: true, oid, code: next.code, error: next.error };
        return { ok: true, committed: true, pushed: true, oid };
      });
    },

    async fetch(root) {
      return withWrite(root, async () => {
        const st = await read(root);
        if (!st.hasRemote) return fail('no-remote', ERR_NO_REMOTE);
        await netGit(root, ['fetch', REMOTE]);
        return { ok: true };
      });
    },

    async pull(root) {
      return withWrite(root, async () => {
        const st = await read(root);
        const denied = guard(st);
        if (denied) return denied;
        if (!st.hasRemote) return fail('no-remote', ERR_NO_REMOTE);
        const r = await pullCore(root);
        return r.ok ? { ok: true } : r;
      });
    },

    // 커밋 없이 가져온 뒤 푸시 (거절된 푸시 뒤처럼 커밋할 것이 없을 때의 Commit & Sync).
    // req.hasMessage: 화면이 누른 순간 메시지가 있었는지. 화면이 옛 상태로 눌러 커밋하려던 것이 동기화로 바뀌지 않게 여기서 다시 검사한다.
    // 돌려주는 left: 커밋하지 않고 그대로 둔 (스테이징할 수 있는) 변경 개수.
    async sync(root, req) {
      if (req != null && (typeof req !== 'object' || typeof req.hasMessage !== 'boolean')) return bad();
      return withWrite(root, async () => {
        const st = await read(root);
        const denied = guard(st);
        if (denied) return denied;
        if (!st.hasRemote) return fail('no-remote', ERR_NO_REMOTE);
        if (st.staged.length) return fail('staged-changed', '스테이징 목록이 바뀌었습니다.\n확인한 뒤 다시 눌러 주세요.');
        const left = st.changes.filter((c) => c.stageable !== false).length; // 이름 변경은 경로가 둘이어도 한 항목
        if (req?.hasMessage && left) return changed();
        const r = await syncCore(root);
        return r.ok ? { ok: true, pushed: r.pushed !== false, left } : r;
      });
    },

    async push(root) {
      return withWrite(root, async () => {
        const st = await read(root);
        const denied = guard(st);
        if (denied) return denied;
        if (!st.hasRemote) return fail('no-remote', ERR_NO_REMOTE);
        return pushCore(root, st);
      });
    },

    // 읽기 전용 기록. 쓰기 잠금을 쓰지 않는다.
    async log(root) {
      if (!roots.has(root)) return noRoot();
      try {
        const out = await git(root, ['log', '--exclude=refs/stash', '--all', '--topo-order', '--no-show-signature', '--no-color', '-n', String(LOG_MAX), `--format=${LOG_FORMAT}`],
          { timeoutMs: LOG_TIMEOUT_MS });
        return { ok: true, commits: parseLog(out) };
      } catch (e) { return fromError(e); }
    },
  };
}

module.exports = {
  BRANCH, REMOTE, WRITE_TIMEOUT_MS, LOG_MAX, MESSAGE_MAX, LOCK_RETRY, WRITE_ENV, NET_ENV, NET_TIMEOUT_MS, GCM_ARGS, GCM_ENV, STATUS_ARGS,
  parseStatusV2, statusLists, pathSet, topPathspec, pathspecInput, parseLog, errorOf, isAuthFailure, createGitOps,
};
