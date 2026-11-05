import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toLocal, expectedPaths, stageablePaths, capList, recentEditSet, secretPaths, secretWarning, gitFingerprint, aheadBehindText, reasonText, refChips, logTime, logKey, loginHint, canSyncOnly } from '../src/renderer/code/gitModel.js';

test('toLocal: 열린 폴더(prefix) 기준 경로로 바꾸고, 폴더 밖이나 폴더 자신은 null', () => {
  assert.equal(toLocal('src/a.js', ''), 'src/a.js', 'prefix 가 비면 저장소 루트가 열린 폴더');
  assert.equal(toLocal('sub/src/a.js', 'sub/'), 'src/a.js');
  assert.equal(toLocal('SUB/Src/a.js', 'sub/'), 'Src/a.js', '비교만 대소문자 무시, 결과 표기는 그대로');
  assert.equal(toLocal('other/a.js', 'sub/'), null, '폴더 밖');
  assert.equal(toLocal('sub2/a.js', 'sub/'), null, '이름만 비슷한 폴더');
  assert.equal(toLocal('sub/', 'sub/'), null, '빈 경로');
  assert.equal(toLocal('', ''), null);
  assert.equal(toLocal('한글 폴더/파일 1.txt', '한글 폴더/'), '파일 1.txt');
});

test('expectedPaths: 스테이징 목록의 경로와 이름 변경 전 경로를 모두', () => {
  assert.deepEqual(expectedPaths([]), []);
  assert.deepEqual(expectedPaths([{ path: 'a.js', code: 'M' }, { path: 'new.js', orig: 'old.js', code: 'R' }]), ['a.js', 'new.js', 'old.js']);
});

test('stageablePaths: stageable:false 는 빼고, 이름 변경이면 orig 도', () => {
  assert.deepEqual(stageablePaths([]), []);
  assert.deepEqual(
    stageablePaths([{ path: 'a.js', code: 'M' }, { path: 'sm', code: 'M', stageable: false }, { path: 'n.js', orig: 'o.js', code: 'R' }, { path: 'u.js', code: 'U', stageable: true }]),
    ['a.js', 'n.js', 'o.js', 'u.js']);
});

test('recentEditSet: editAt 이 60초 안인 항목만, 저장소 기준 소문자 경로 (읽기가 나중에 와도 editAt 기준)', () => {
  const now = 1_000_000;
  const items = [
    { rel: 'Src/A.js', kind: 'edit', at: now - 1000, editAt: now - 1000 },
    { rel: 'b.js', kind: 'read', at: now - 1000 },
    { rel: 'old.js', kind: 'edit', at: now - 100, editAt: now - 60000 },
    { rel: 'edge.js', kind: 'edit', at: now - 59999, editAt: now - 59999 },
    { rel: 'readlater.js', kind: 'edit', at: now - 10, editAt: now - 20000 },
  ];
  assert.deepEqual([...recentEditSet(items, '', now)].sort(), ['edge.js', 'readlater.js', 'src/a.js']);
  assert.deepEqual([...recentEditSet(items, 'Sub/', now)].sort(), ['sub/edge.js', 'sub/readlater.js', 'sub/src/a.js'], '폴더 기준 rel 에 prefix 를 붙인다');
  assert.deepEqual([...recentEditSet(items, '', now, 500)], [], '창을 줄이면 제외');
  assert.deepEqual([...recentEditSet([], '', now)], []);
  assert.deepEqual([...recentEditSet(null, '', now)], [], 'items 가 없어도 던지지 않음');
});

test('capList: 최대 줄 수까지만 보이고 나머지 개수를 알려 준다', () => {
  const list = Array.from({ length: 7 }, (_, i) => i);
  assert.deepEqual(capList(list, 5), { shown: [0, 1, 2, 3, 4], more: 2 });
  assert.deepEqual(capList(list, 7), { shown: list, more: 0 });
  assert.deepEqual(capList(list, 100), { shown: list, more: 0 });
  assert.deepEqual(capList([], 5), { shown: [], more: 0 });
  assert.deepEqual(capList(null, 5), { shown: [], more: 0 });
  assert.notEqual(capList(list, 100).shown, list, '원본 배열을 그대로 내주지 않는다');
});

test('gitFingerprint: 표시에 쓰는 값이 같으면 같고, 하나라도 다르면 다르다', () => {
  const gs = { ok: true, branch: 'main', detached: false, ahead: 1, behind: 0, upstream: 'origin/main', hasRemote: true, canWrite: true, reason: null, prefix: '',
    staged: [{ path: 'a', code: 'M' }], changes: [{ path: 'b', code: 'M' }], conflicts: [], top: '/x', oid: 'abc' };
  const base = gitFingerprint(gs, new Set(['b']));
  assert.equal(typeof base, 'string');
  assert.equal(gitFingerprint({ ...gs, oid: 'zzz', top: '/y' }, new Set(['b'])), base, '표시에 안 쓰는 필드는 무시');
  assert.equal(gitFingerprint(gs, ['b']), base, 'marks 는 배열도 받는다');
  assert.equal(gitFingerprint(gs, new Set(['c', 'b'])) === gitFingerprint(gs, new Set(['b', 'c'])), true, 'marks 는 순서 무관');
  for (const patch of [{ branch: 'dev' }, { detached: true }, { ahead: 2 }, { behind: 1 }, { upstream: null }, { hasRemote: false }, { canWrite: false }, { reason: 'merging' }, { prefix: 'sub/' },
    { staged: [] }, { changes: [{ path: 'b', code: 'D' }] }, { conflicts: [{ path: 'c' }] }]) {
    assert.notEqual(gitFingerprint({ ...gs, ...patch }, new Set(['b'])), base, JSON.stringify(patch));
  }
  assert.notEqual(gitFingerprint(gs, new Set()), base, 'marks 가 다르면 다름');
  assert.equal(typeof gitFingerprint({ ok: false, error: 'x' }, new Set()), 'string', '실패 상태도 지문이 만들어진다');
});

test('aheadBehindText: 0 은 표시 안 하고 null 이면 빈 글자', () => {
  assert.equal(aheadBehindText({ ahead: 2, behind: 1 }), '↑2 ↓1');
  assert.equal(aheadBehindText({ ahead: 2, behind: 0 }), '↑2');
  assert.equal(aheadBehindText({ ahead: 0, behind: 3 }), '↓3');
  assert.equal(aheadBehindText({ ahead: 0, behind: 0 }), '');
  assert.equal(aheadBehindText({ ahead: null, behind: null }), '');
  assert.equal(aheadBehindText({ ahead: null, behind: 2 }), '↓2');
  assert.equal(aheadBehindText({}), '');
});

test('reasonText: 쓰기를 막은 이유별 안내, 막지 않았으면 null', () => {
  assert.equal(reasonText({ reason: 'not-main', branch: 'dev' }), 'main 브랜치에서만 커밋·푸시합니다. (현재: dev)\n다른 작업은 아래 터미널에서');
  assert.equal(reasonText({ reason: 'detached' }), '분리된 HEAD 입니다.\n터미널에서 main 으로 전환해 주세요.');
  assert.equal(reasonText({ reason: 'merging' }), '병합 등 다른 git 작업이 진행 중입니다.\n터미널에서 마무리해 주세요.');
  assert.equal(reasonText({ reason: null }), null);
  assert.equal(reasonText({}), null);
  assert.equal(reasonText(null), null);
});

test('refChips: HEAD -> main 은 현재 브랜치, origin/ 은 원격, tag: 는 태그, origin/HEAD 는 뺀다', () => {
  assert.deepEqual(refChips(['HEAD -> main', 'origin/main', 'tag: v1', 'feature/x']), [
    { label: 'main', kind: 'local', current: true },
    { label: 'origin/main', kind: 'remote', current: false },
    { label: 'v1', kind: 'tag', current: false },
    { label: 'feature/x', kind: 'local', current: false },
  ]);
  assert.deepEqual(refChips(['HEAD']), [{ label: 'HEAD', kind: 'head', current: true }], '분리된 HEAD');
  assert.deepEqual(refChips(['origin/HEAD', 'origin/main']), [{ label: 'origin/main', kind: 'remote', current: false }], 'origin/HEAD 는 표시하지 않음');
  assert.deepEqual(refChips(['', '  ']), [], '빈 값은 버린다');
  assert.deepEqual(refChips([]), []);
  assert.deepEqual(refChips(null), []);
});

test('logTime: 오늘이면 HH:MM, 아니면 YYYY-MM-DD (지역 시간)', () => {
  const now = new Date(2026, 10, 3, 15, 30).getTime();
  assert.equal(logTime(new Date(2026, 10, 3, 9, 5).getTime(), now), '09:05');
  assert.equal(logTime(new Date(2026, 10, 3, 0, 0).getTime(), now), '00:00', '오늘 0시');
  assert.equal(logTime(new Date(2026, 10, 2, 23, 59).getTime(), now), '2026-11-02', '어제는 날짜');
  assert.equal(logTime(new Date(2025, 0, 7, 12, 0).getTime(), now), '2025-01-07', '월·일은 두 자리');
  assert.equal(logTime(NaN, now), '');
  assert.equal(logTime(undefined, now), '');
});

test('logKey: oid·upstream·ahead·behind 가 같으면 같고 하나라도 다르면 다르다', () => {
  const gs = { oid: 'abc', upstream: 'origin/main', ahead: 1, behind: 2, branch: 'main', staged: [], changes: [{ path: 'a' }] };
  const base = logKey(gs);
  assert.equal(typeof base, 'string');
  assert.equal(logKey({ ...gs, branch: 'dev', staged: [{ path: 'z' }], changes: [] }), base, '목록·브랜치 이름은 무관');
  for (const patch of [{ oid: 'abd' }, { upstream: null }, { ahead: 0 }, { behind: 3 }]) assert.notEqual(logKey({ ...gs, ...patch }), base, JSON.stringify(patch));
  assert.equal(typeof logKey(null), 'string', 'null 이어도 던지지 않음');
  assert.equal(typeof logKey({ oid: null }), 'string', '빈 저장소(oid null)도 키가 만들어짐');
});

test('loginHint: 네트워크 작업이 4초 이상 이어질 때만 로그인 창 안내', () => {
  assert.equal(loginHint('push', 3999), '');
  assert.equal(loginHint('push', 4000), '로그인 창에서 로그인을 진행하세요.\n로그인 창이 안 보이면 작업 표시줄을 확인하세요.');
  for (const kind of ['push', 'sync', 'fetch', 'pull', 'pushOnly', 'syncOnly']) assert.notEqual(loginHint(kind, 10000), '', kind);
  for (const kind of ['commit', 'stage', 'unstage', undefined, null]) assert.equal(loginHint(kind, 60000), '', String(kind));
  assert.equal(loginHint('sync', 0), '');
});

test('canSyncOnly: 커밋이 불가능하고 주고받을 커밋이 있을 때만 (Commit & Sync 를 동기화만으로 쓴다)', () => {
  const gs = { canWrite: true, hasRemote: true, ahead: 1, behind: 0, staged: [], changes: [] };
  assert.equal(canSyncOnly(gs, ''), true, '올릴 커밋 + 변경 0 + 메시지 빈칸');
  assert.equal(canSyncOnly({ ...gs, ahead: 0, behind: 2 }, ''), true, '받을 커밋만 있어도');
  assert.equal(canSyncOnly({ ...gs, ahead: 0, behind: 0 }, ''), false, '주고받을 것이 없다');
  assert.equal(canSyncOnly({ ...gs, ahead: null, behind: null }, ''), false, 'upstream 도 origin/main 도 없다 (첫 푸시는 Push)');
  // 스테이징이 있으면 커밋하려는 것이다 (메시지와 무관)
  assert.equal(canSyncOnly({ ...gs, staged: [{ path: 'a', code: 'M' }] }, ''), false);
  assert.equal(canSyncOnly({ ...gs, staged: [{ path: 'a', code: 'M' }] }, '메시지'), false);
  // 스테이징 안 한 변경은 그대로 둔다: 메시지가 빈칸이면 켜지고, 메시지가 있으면 커밋 흐름이다
  const dirty = { ...gs, changes: [{ path: 'b', code: 'M' }] };
  assert.equal(canSyncOnly(dirty, ''), true);
  assert.equal(canSyncOnly(dirty, '메시지'), false);
  assert.equal(canSyncOnly(dirty, '   \n'), true, '공백뿐인 메시지는 빈칸');
  assert.equal(canSyncOnly(gs, '메시지'), true, '메시지만 있고 올릴 변경이 없다');
  assert.equal(canSyncOnly(gs, '  \t'), true);
  assert.equal(canSyncOnly(gs), true, '메시지 인자가 없어도 던지지 않음');
  // 내용만 더러운 서브모듈은 스테이징할 수 없어 올릴 변경이 아니다
  assert.equal(canSyncOnly({ ...gs, changes: [{ path: 'sm', code: 'M', stageable: false }] }, '메시지'), true);
  assert.equal(canSyncOnly({ ...gs, changes: [{ path: 'sm', code: 'M', stageable: false }, { path: 'b', code: 'M' }] }, '메시지'), false, '올릴 변경이 하나라도 있으면');
  assert.equal(canSyncOnly({ ...gs, canWrite: false }, ''), false);
  assert.equal(canSyncOnly({ ...gs, hasRemote: false }, ''), false);
  assert.equal(canSyncOnly(null, ''), false);
  assert.equal(canSyncOnly(undefined, ''), false);
});

test('secretPaths: 비밀 파일 이름만 (이름 변경 전 이름 포함), 일반 파일·잘못된 입력은 제외', () => {
  assert.deepEqual(secretPaths([{ path: 'a.js' }, { path: 'cfg/.env' }, { path: 'k/server.PEM' }]), ['cfg/.env', 'k/server.PEM']);
  assert.deepEqual(secretPaths([{ path: 'new.txt', orig: 'old/id_rsa' }, { path: 'x.txt', orig: 'y.txt' }]), ['new.txt'], '옛 이름이 비밀 파일이면 새 경로를 알린다');
  assert.deepEqual(secretPaths([{ path: 'src/env.js' }, { path: 'keyboard.js' }, { path: 'dir.key/a.js' }]), [], '이름이 닮은 일반 파일');
  assert.deepEqual(secretPaths(null), []);
  assert.deepEqual(secretPaths(undefined), []);
  assert.deepEqual(secretPaths([]), []);
});

test('secretWarning: 3개까지 나열하고 넘으면 「외 N개」, 빈 목록은 빈 글', () => {
  assert.equal(secretWarning([]), '');
  assert.equal(secretWarning(['.env']), '비밀 파일일 수 있습니다: .env');
  assert.equal(secretWarning(['a', 'b', 'c']), '비밀 파일일 수 있습니다: a, b, c');
  assert.equal(secretWarning(['a', 'b', 'c', 'd']), '비밀 파일일 수 있습니다: a, b, c 외 1개');
  assert.equal(secretWarning(['a', 'b', 'c', 'd', 'e', 'f']), '비밀 파일일 수 있습니다: a, b, c 외 3개');
  assert.equal(secretWarning(['a', 'b', 'c', 'd'], 2), '비밀 파일일 수 있습니다: a, b 외 2개');
});
