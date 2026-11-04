# Commit & Sync: 커밋할 것이 없으면 동기화만 — 사양 (2026-11-04)

> **완료 리뷰 반영:** 메인이 스테이징·올릴 변경을 다시 검사해 거부하고(`staged-changed`, `changed`), 가져온 뒤 올릴 커밋이 없으면 푸시하지 않는다. 안내에 남은 변경 수, 가져온 뒤 푸시 실패를 밝힌다.

사용자 결정: 「버튼도 켜기」. VS Code 의 Sync Changes 처럼, 커밋이 불가능한 상태에서 올리거나 받을 커밋이 있으면 Commit & Sync 가 켜져 Pull 후 Push 한다.
재현(실제 git, 임시 저장소): Commit & Push 가 `rejected` 로 끝나면 `committed:true`, `ahead:1`, 변경 0, 메시지 빈칸이라 Commit & Sync 만 꺼져 있었고, 안내는 그 버튼을 쓰라고 했다.

## 판정: `src/renderer/code/gitModel.js`

```js
// Commit & Sync 를 동기화만으로 쓰는 경우: 커밋이 불가능하고(스테이징 없음 + 메시지가 비었거나 올릴 변경 없음) 주고받을 커밋이 있다.
// 스테이징이 있으면 커밋하려는 것이므로 이 경우가 아니다. 스테이징하지 않은 파일은 그대로 둔다.
export function canSyncOnly(gs, message) {
  if (!gs || !gs.canWrite || !gs.hasRemote || gs.staged.length) return false;
  if (String(message ?? '').trim() && stageablePaths(gs.changes).length) return false;
  return gs.ahead > 0 || gs.behind > 0;
}
```
- `ahead`·`behind` 가 null(upstream 도 origin/main 도 없음)이면 false. 첫 푸시는 ⇑ Push.
- `LOGIN_HINT_KINDS` 에 `'syncOnly'` 추가.

## 메인: `src/main/codeGit.cjs`

createGitOps 반환 객체의 `push` 옆:
```js
// 커밋 없이 가져온 뒤 푸시 (거절된 푸시 뒤처럼 커밋할 것이 없을 때의 Commit & Sync).
async sync(root) {
  return withWrite(root, async () => {
    const st = await read(root);
    const denied = guard(st);
    if (denied) return denied;
    if (!st.hasRemote) return fail('no-remote', ERR_NO_REMOTE);
    return syncCore(root);
  });
},
```
`syncCore` 는 그대로. 인증 재시도·병합 안전 규칙도 그대로 탄다.

## IPC
- `src/main/codeRepo.cjs` `registerCodeIpc`: `code:git:pull`·`code:git:push` 와 같은 형식으로 `code:git:sync`.
- `src/main/preload.cjs`: `codeGitSync`, `codeGitPush` 와 같은 형식.
- `code:git:pull` 을 grep 해서 다른 등록·허용 목록·시험의 채널 표가 있으면 함께 고친다.

## 화면: `src/renderer/code/gitPanel.js`
- import 에 `canSyncOnly`. `OP_TEXT.syncOnly = '동기화 중'`, `OK_TEXT.syncOnly = '가져와 푸시했습니다'`, `GRAPH_OPS` 에 `'syncOnly'`.
- 함수: `const syncOnlyNow = () => !unavailable && !curOp() && typeof api.codeGitSync === 'function' && canSyncOnly(gs, msgEl.value);`
- `updateControls`: `syncBtn.disabled = !canCommit('sync') && !syncOnlyNow();`, 제목은 `noRemote ? NO_REMOTE_TITLE : syncOnlyNow() ? SYNC_ONLY_TITLE : 'Commit & Sync'`. `SYNC_ONLY_TITLE = '커밋할 것이 없어 Pull 후 Push 합니다'`.
- 클릭은 `startCommit('sync')` 그대로 두고, `startCommit` 의 `confirmThen` 검사 **다음**, `canCommit` 검사 **앞**에: `if (then === 'sync' && !canCommit('sync') && syncOnlyNow()) { remoteOp('syncOnly', syncBtn, (r) => api.codeGitSync(r)); return; }`.
- 커밋 흐름(`canCommit`, 확인 줄, 메시지 초기화)은 바꾸지 않는다. 메시지와 올릴 변경이 있으면 지금처럼 커밋 후 동기화한다.
- `pushBtn`(Commit & Push)은 바꾸지 않는다.

## 테스트 (먼저 실패를 본 뒤 구현)

`test/git-model.test.js` `canSyncOnly`:
- ahead>0·변경 0·메시지 빈칸 → true. behind>0 → true. 둘 다 0·null → false.
- 스테이징 있음 → false (메시지 유무 무관).
- 스테이징 안 한 변경 + 메시지 빈칸 + ahead>0 → true. 변경 + 메시지 있음 → false.
- 메시지 있음 + 변경 0 + ahead>0 → true. 공백뿐인 메시지는 빈칸으로 본다.
- `stageable:false` 변경만 + 메시지 있음 + ahead>0 → true.
- `canWrite:false`, `hasRemote:false`, gs 없음 → false.
- `loginHint('syncOnly', 4000)` 안내 있음.

`test/codeGit.test.js` `sync` (실제 git, 로컬 bare 원격):
- 거절된 Commit & Push 뒤 `sync` → `{ok:true}`, 원격 main 에 내 커밋과 원격 커밋이 모두 있고 ahead 0.
- 스테이징 안 한 파일이 있어도 진행하고 파일은 그대로, 스테이징되지 않음.
- 받을 파일과 겹치면 `overwrite`, 푸시 호출 없음.
- 충돌 → `conflict`, `merge --abort` 1회, 푸시 호출 없음, 내 커밋 유지.
- main 이 아니면 `not-main`, 병합 중이면 `merging`, 원격 없으면 `no-remote`, 허용 안 된 폴더 `root`, 진행 중이면 `busy`.
- 인증 실패 재시도는 가짜 git 으로 fetch·push 각각 (기존 `netFake` 방식). **실제 GCM 금지.**
- 커밋 호출이 없음을 단언.

IPC: `code:git:sync` 등록을 기존 채널 시험 형식으로 확인.

`scripts/check-code-view.cjs` (수정 직전에 다시 읽고 필요한 곳만 Edit):
- 원격이 앞선 상태에서 Commit & Push 가 거절되면 안내가 나오고, 메시지 칸이 빈 채 `.gp-commit-sync` 가 켜지며 제목이 `SYNC_ONLY_TITLE`.
- 누르면 `가져와 푸시했습니다`, `.gp-ab` 가 비고, 다시 꺼진다.
- 스테이징이 있으면 메시지가 비어도 꺼져 있다.
- 기존 시나리오(「메시지가 없으면 꺼진다」 등)가 ahead>0 상태에서 깨지면, 의미를 유지해 상태를 맞추거나 조건을 고친다. 이유를 보고한다.

## 건드리지 않기
- README·결정대장은 메인이 고친다.
- `src/renderer/office/**`, `themes/**`, `scripts/check-renderer.cjs`, `test/isometric*`, `test/layout*`, `test/office-play*`, `src/renderer/index.html` 은 다른 세션.
- 안내 문구는 바꾸지 않는다. 「Pull 또는 Commit & Sync 를 써 주세요.」 가 이제 맞는 안내가 된다.
