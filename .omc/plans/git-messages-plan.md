# Git 패널 안내 문구 정리 — 사양 (2026-11-04)

사용자 확정 규칙:
1. 문장이 끝나는 곳에서 줄을 바꾼다.
2. `(현재: dev)` 는 앞 문장과 같은 줄. 커밋 번호는 완료 문장과 같은 줄.
3. `~주세요` 뒤에는 마침표.
4. 로그인 안내는 아래 문구 그대로.

`\n` 은 문구 정의에 직접 넣는다. 표시할 때 자동으로 끊지 않는다 (git 원문이 잘린다). git 원문 자체는 고치지 않는다.

## 최종 문구 (이 표와 글자까지 같게)

### `src/renderer/code/gitModel.js`
| 줄 | 문구 |
|---|---|
| 58 not-main | `main 브랜치에서만 커밋·푸시합니다. (현재: ${gs.branch})\n다른 작업은 아래 터미널에서` |
| 59 detached | `분리된 HEAD 입니다.\n터미널에서 main 으로 전환해 주세요.` |
| 60 merging | `병합 등 다른 git 작업이 진행 중입니다.\n터미널에서 마무리해 주세요.` |
| 100 loginHint | `로그인 창에서 로그인을 진행하세요.\n로그인 창이 안 보이면 작업 표시줄을 확인하세요.` |

### `src/renderer/code/gitPanel.js`
| 줄 | 문구 |
|---|---|
| 43 SUBMODULE_TITLE | `서브모듈 안에서 커밋해 주세요.` |
| 48 STALE_TEXT | `목록이 바뀌었습니다.\n다시 눌러 주세요.` |
| 395 완료 | `${r.pushed ? '커밋·푸시했습니다.' : '커밋했습니다.'} ${oid}` |
| 395 커밋 후 실패 | `커밋됨 ${oid}\n⚠ ${r.error}` |
| 475 확인 줄 | `parts.join('\n')` |
| 490 | `커밋 메시지를 입력해 주세요.` |

### `src/main/codeGit.cjs`
| 줄 | 코드 | 문구 |
|---|---|---|
| 157 | lock | `다른 git 작업이 저장소를 잠그고 있습니다.\n잠시 뒤 다시 시도해 주세요.` |
| 158 | no-identity | `git 사용자 이름·이메일이 없습니다.\n터미널에서 git config 로 설정해 주세요.` |
| 159 | empty | `커밋 메시지를 입력해 주세요.` |
| 161 | unmerged | `충돌이 해결되지 않았습니다.\n터미널에서 마무리해 주세요.` |
| 162 | sign | `커밋 서명에 실패했습니다.\n터미널에서 확인해 주세요.` |
| 164 | remote-rejected | `원격이 푸시를 거부했습니다:\n${stderr.slice(-200)}` |
| 165 | rejected | `원격이 앞서 있어 푸시가 거절되었습니다.\nPull 또는 Commit & Sync 를 써 주세요.` |
| 167 | auth gh | `원격 인증에 실패했습니다.\n하단 터미널에서 gh auth login 으로 로그인해 주세요.` |
| 167 | auth 그 외 | `원격 인증에 실패했습니다.\n하단 터미널에서 git push 로 로그인해 주세요.` |
| 170 | overwrite | `가져오는 변경이 커밋하지 않은 파일과 겹쳐 중단했습니다.\n터미널에서 확인해 주세요.` |
| 179 | timeout net | `원격 작업 시간이 초과되었습니다.\n로그인 창이 열려 있었다면 다시 시도해 주세요.` |
| 180 | timeout | `git 작업 시간이 초과되었습니다.\n잠금 파일이나 스테이징이 남았을 수 있으니\n터미널에서 git status 로 확인해 주세요.` |
| 189 | hook | `커밋 전 검사(hook)가 실패했습니다:\n${stderr.slice(0, 300)}` |
| 191 | fail | `git 실행 실패:\n${shown.slice(-200)}` |
| 271 | merging | `병합 등 다른 git 작업이 진행 중입니다.\n터미널에서 마무리해 주세요.` |
| 272 | detached | `분리된 HEAD 입니다.\n터미널에서 main 으로 전환해 주세요.` (패널과 통일) |
| 273 | not-main | `main 브랜치에서만 커밋·푸시합니다. (현재: ${st.branch})\n다른 작업은 아래 터미널에서` (패널과 통일) |
| 289 | changed | `변경 목록이 바뀌었습니다.\n다시 확인해 주세요.` |
| 374 | merging | `다른 작업의 병합이 진행 중이라 건드리지 않았습니다.\n터미널에서 확인해 주세요.` |
| 378 | abort-failed | `병합 취소에 실패했습니다.\n터미널에서 git merge --abort 를 실행해 주세요.` |
| 379 | conflict | `충돌이 있어 병합을 취소했습니다.\n하단 터미널에서 git pull 로 해결해 주세요.` |
| 380 | merge-failed | `병합을 끝내지 못해 취소했습니다:\n${...slice(-200)}` |
| 383 | branch-changed | `작업 중 브랜치가 바뀌었습니다.\n터미널에서 확인해 주세요.` |
| 440 | bad | `커밋 메시지를 입력해 주세요.` |
| 461 | staged-changed | `스테이징 목록이 바뀌었습니다.\n확인한 뒤 다시 눌러 주세요.` |

줄 190 의 `replace(/^git 실행 실패: /, '')` 는 codeRepo 문구 변경에 맞춰 `/^git 실행 실패:\s*/` 로.

### `src/main/codeRepo.cjs`
- 180: `git 실행 실패:\n${text.slice(0, 200) || err.message}`. 이 문구를 읽는 곳(`shown`, 다른 호출부, codeRepo 서비스의 오류 표시)을 grep 해서 깨지지 않게 한다.

### `src/main/codeAnalysis.cjs`
- 42 cmdShim: `코드 분석은 Claude Code 실행 파일 설치에서만 동작합니다.\nClaude Code 를 업데이트해 주세요.`
- 48 oldCli: `Claude Code 를 최신 버전으로 업데이트해 주세요.`
- 344: `사용 한도에 도달했습니다:\n${shown}`, 345: `${label}:\n${shown}`. 분석 화면의 `.ca-status` 는 nowrap 이라 공백으로 보이고 `.ca-banner` 는 pre-wrap 이라 줄이 바뀐다. 둘 다 문제없음.

### `src/renderer/styles.css`
- `.gp-login` 에 `white-space: pre-wrap; overflow-wrap: anywhere;` 추가.
- `.gp-note` 의 `max-height: 6em` → `8em`.

## `git init` 미갱신 결함: `src/renderer/code/panel.js` tick (910 줄)

폴더를 연 뒤 터미널에서 `git init` 하면 `treeInfo.git === false` 가 남아 tick 이 조회 없이 끝난다. ⟳ 를 눌러야만 반영됐다.

```js
// 깃 저장소가 아니던 폴더: 터미널에서 git init 했을 수 있으니 상태만 묻고, 저장소가 됐으면 트리부터 다시 받는다.
if (!treeInfo.git) {
  const root = current;
  const fg = folderGen;
  const gs = await Promise.resolve().then(() => api.codeGitState(root)).catch(() => null);
  if (fg === folderGen && gs && gs.ok !== false) await loadTree();
  return;
}
```
- 실패(저장소 아님)면 아무것도 바꾸지 않는다. 기존 안내(`깃 저장소에서만…`)가 그대로 남고 콘솔 오류가 나지 않는다.
- 머리줄 상태 글을 건드리지 않는다.

## 테스트 (먼저 고쳐 실패를 본 뒤 구현)

- `test/git-model.test.js`: reasonText 3종, loginHint 글자 그대로.
- `test/codeGit.test.js`: 위 표로 정확 비교를 모두 갱신. `/^커밋 전 검사\(hook\)가 실패했습니다: /`, `/^병합을 끝내지 못해 취소했습니다: /`, `/^원격이 푸시를 거부했습니다: /` 같은 정규식과 `'…: '.length + N` 은 `:\n` 기준으로.
- `test/codeAnalysis.test.js`: `사용 한도에 도달했습니다:\n…`, oldCli 마침표, errorText 의 label 단언, 길이 단언.
- `test/codeRepo.test.js`: `git 실행 실패` 단언이 있으면 맞춘다.
- 새 시험 (test/codeGit.test.js): 소스 스캔으로 `src/main/codeGit.cjs`, `src/renderer/code/gitModel.js`, `src/renderer/code/gitPanel.js` 에 `주세요` 바로 뒤에 따옴표·백틱이 오는 문구가 없는지 (마침표 규칙 회귀 방지).
- 약하게 만들지 않는다: 정확 비교를 부분 비교로 바꾸지 말 것.

`scripts/check-code-view.cjs` (수정 직전에 다시 읽고 필요한 곳만 Edit):
- 1272: `'커밋했습니다 '` → `'커밋했습니다. '`.
- 1660: `/서브모듈 안에서 커밋해 주세요\./`.
- `gpNoteHas` 가 부분 비교라 나머지는 대체로 그대로 통과한다. 깨지면 의미를 유지해 고친다.
- 새 단언: main 이 아닌 상태(1526 근처)에서 `.gp-note-text` 의 글에 `\n` 이 있고 계산된 `white-space` 가 `pre-wrap`. 1816 근처에서 `.gp-login` 의 글이 사양 문구와 같고 계산된 `white-space` 가 `pre-wrap`.
- 새 시나리오 (`git init` 결함): 새 임시 폴더(FIXBASE 아래, PLAIN 을 재사용하지 말 것)를 열어 「깃 저장소에서만」 안내를 확인 → 그 폴더에서 `git init -b main` 과 지역 `user.name`·`user.email` 설정, 파일 하나 → **⟳ 를 누르지 않고** 최대 15초 안에 `.gp-branch` 가 `main`, 안내가 사라짐, 변경 목록에 파일이 보임 → 저장소가 안 된 폴더는 콘솔 오류 없이 안내가 유지됨(기존 PLAIN 시나리오). 끝나면 원래 폴더로 돌아간다.

## 건드리지 않기
- README·결정대장·사양 문서는 메인이 고친다.
- `src/renderer/office/**`, `themes/**`, `scripts/check-renderer.cjs`, `test/isometric*`, `test/layout*`, `test/office-play*`, `src/renderer/index.html` 은 다른 세션.
- 재시도·인증·병합 로직은 문구 외에 바꾸지 않는다. `isAuthFailure` 등이 stderr 를 보는 판정은 그대로. 사용자 문구를 조건으로 쓰는 코드가 있으면 멈추고 보고.
