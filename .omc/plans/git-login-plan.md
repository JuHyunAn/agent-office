# Git 패널 로그인 창 지원 — 사양 (2026-11-04, 설계 리뷰 반영판)

> **완료 리뷰 뒤 달라진 점 (최종 동작은 결정대장 D-078):** 저장 공간은 `-c credential.namespace` 가 아니라 환경 변수 `GCM_NAMESPACE`(`GCM_ENV`, 환경 변수가 어떤 설정보다 우선, 실측). pull 2단계는 창 금지·추적 없음·net 표시 없음. 병합 증거는 `pulling` 뒤의 출력만, `remote:` 줄 제외. `GH_HELPER`·`GCM_HELPER` 를 실행 파일 이름까지 조임. `killTrackedGit({ closing: true })` 뒤의 추적 실행은 거부.

사용자 결정: 「이 PC 에서도 띄우기」. 평소에는 기존 인증(gh 등)을 그대로 쓰고, 인증이 실패했을 때만 GCM 로그인 창이 뜬다.
**절대 조건: 전역 Git 설정·gh 로그인·기존 저장 자격 증명(`git:https://…`, `gh:…`)을 앱이 바꾸거나 지우지 않는다.** gh·도우미 없음 경로의 재시도 저장·삭제는 전용 네임스페이스 `agent-office:…` 안에서만 일어난다. GCM 이 원래 도우미인 원격은 앱 밖 git 과 같다.

## 실측 근거 (git 2.54.0.windows.1, GCM 2.7.3, gh 2.103.3)

| 사실 | 근거 |
|---|---|
| 이 PC 의 github.com 도우미는 gh 뿐 (`credential.https://github.com.helper` 빈 값 + gh, 전역) | `git config --show-scope --get-regexp`, `--get-urlmatch` → gh 만 |
| `windowsHide:true`·파이프·`GIT_TERMINAL_PROMPT=0` 으로 띄워도 GCM 창이 **보인다** (제목 Connect to GitHub) | probe-gcm-window.cjs |
| `-c credential.helper= -c credential.helper=<G>` 는 URL 전용 gh 까지 비운다. get·store·erase 모두 G 만 호출 | probe-retry-chain.sh (가짜 도우미) |
| GCM 을 뒤에 **더하기만** 하면 성공 뒤 gh 토큰이 GCM 에 store 되고, gh 토큰이 만료면 GCM 차례가 안 온다 | probe-helper-chain.sh. 그래서 비우고 GCM 만 |
| **`credential.namespace` 로 분리된다**: 기본 항목을 못 읽고, 저장은 `agent-office:https://호스트`, 삭제해도 기본 항목 그대로 | probe-namespace.sh (실제 GCM, 가짜 호스트) |
| gh 의 store·erase 는 아무 일도 안 한다 (로그아웃 방지 주석) | cli/cli `pkg/cmd/auth/gitcredential/helper.go` |
| `--get-urlmatch credential.helper <url>`: 가장 잘 맞는 설정의 **마지막 값 한 줄**, 없으면 exit 1 | probe-retry-chain.sh |
| `git pull` 은 인증 실패에도 종료 코드 **1**. 종료 코드로 못 가른다 | 401 서버 |
| 진짜 인증 실패 9조합(push·pull·fetch × 도우미 없음·사용자만·낡은 자격)의 stderr **마지막 줄**은 모두 아래 정규식에 맞고, 오탐 5종(`would be overwritten` 파일 이름, 미추적 파일 이름, pre-push hook 출력, 원격 pre-receive 출력, 서브모듈만 401)은 안 맞는다 | 리뷰어 실측 p1~p3 |
| 도우미가 낡은 자격을 주면 git 은 erase 후 `Authentication failed` 로 끝나고 그 시도에서 창을 다시 띄우지 않는다. 다음 시도에서 뜬다 | 리뷰어 실측 7a·7b |
| `git pull` 은 fetch 로 자격을 기다린 뒤 **그때의 HEAD** 로 병합한다 (대기 중 `checkout -b` 하면 feat 이 이동) | 리뷰어 실측 |
| 부모가 끝나도 git·창은 살아남아 뒤이어 병합·푸시를 진행한다 | 리뷰어 실측 E |

## 메인: `src/main/codeGit.cjs`

```js
const NET_TIMEOUT_MS = 300000; // 네트워크 명령: 로그인 창에서 입력할 시간까지 5분
// 네트워크 명령: GCM 로그인 창은 허용하고 터미널 입력만 끈다 (패널에는 입력할 터미널이 없다)
const NET_ENV = { GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', GIT_TERMINAL_PROMPT: '0' };
// 인증 실패 뒤 재시도: 도우미 목록을 비우고 GCM 만, 앱 전용 저장 공간에서.
// 더하기만 하면 gh 토큰이 GCM 에 복사되고 만료된 gh 에 막히며, 전용 공간이 아니면 거부 때 사용자의 기존 항목이 지워진다 (실측)
const GCM_ARGS = ['-c', 'credential.helper=', '-c', 'credential.helper=manager', '-c', 'credential.namespace=agent-office'];
const AUTH_LAST_LINE = /^fatal: (could not read (Username|Password) for '.+': terminal prompts disabled|Authentication failed for '.+')$/;
const AUTH_REJECTED = /^fatal: Authentication failed for /;
const GH_HELPER = /auth git-credential/;
const GCM_HELPER = /manager/i;
const lastLine = (s) => String(s || '').trim().split(/\r?\n/).pop().trim();
// 파일 이름·hook·원격 메시지의 같은 글자에 속지 않게 stderr 마지막 줄만 본다. 병합이 시작됐다는 글이 stderr·stdout 어디든 있으면 인증 실패가 아니다.
function isAuthFailure(e) {
  if (e?.kind !== 'fail' || !AUTH_LAST_LINE.test(lastLine(e.stderr))) return false;
  return !/CONFLICT|Automatic merge failed|Not committing merge/.test(`${e.stderr || ''}\n${e.stdout || ''}`);
}
```

- `WRITE_ENV`·`WRITE_TIMEOUT_MS` 는 로컬 쓰기(add·restore·rm·commit·merge --abort)에 그대로. 20줄 주석은 「로컬 쓰기」로 고친다.
- createGitOps 안:
  ```js
  // 네트워크 명령 한 번. 앱 종료 때 끝내도록 등록하고, 시간 초과에는 안내를 가르는 표시를 단다.
  const runNet = async (root, args) => {
    try { return await git(root, args, { timeoutMs: NET_TIMEOUT_MS, env: NET_ENV, track: true }); } catch (e) {
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
      try {
        try { await runNet(root, [...prefix, ...args]); } catch (second) {
          // 전용 항목이 낡아 거부됐다 — 지워졌으니 한 번 더 하면 창이 뜬다 (최대 1회)
          if (!useGcm || !isAuthFailure(second) || !AUTH_REJECTED.test(lastLine(second.stderr))) throw second;
          await runNet(root, [...prefix, ...args]);
        }
        return prefix;
      } catch (e) { throw tag(e); }
    }
  }
  ```
- `pushCore`: `await netGit(root, ['push', ...])`. `fetch`: `await netGit(root, ['fetch', REMOTE])`.
- `pullCore` 를 두 단계로 (사람을 기다리는 구간을 병합 앞에서 끝낸다). 기존 catch 는 그대로 전체를 감싼다:
  ```js
  try {
    // 로그인은 fetch 에서 마친다: git pull 은 자격을 기다린 뒤 그때의 HEAD 로 병합해서, 대기 중 브랜치가 바뀌면 다른 브랜치가 움직인다 (실측)
    const prefix = await netGit(root, ['fetch', REMOTE, BRANCH]);
    const denied = guard(await read(root));
    if (denied) return denied;
    await runNet(root, [...prefix, 'pull', '--no-rebase', '--no-edit', REMOTE, BRANCH]);
  } catch (e) { ...기존 그대로... }
  ```
  `merge --abort` 는 그대로 `git` + `WRITE_ENV`. 원격에 main 이 없으면 fetch 가 `couldn't find remote ref` 로 실패해 기존 `no-remote-ref` 로 간다 (syncCore 그대로).
- `RULES` 의 auth 항목을 함수로: `(stderr, e) => (e?.viaGh ? '원격 인증에 실패했습니다. 하단 터미널에서 gh auth login 으로 로그인해 주세요' : '원격 인증에 실패했습니다. 하단 터미널에서 git push 로 로그인해 주세요')`. `errorOf` 의 호출을 `error(stderr, e)` 로. 판정 규칙·순서는 그대로.
- `errorOf` 의 timeout: `e?.net` 이면 문구 `원격 작업 시간이 초과되었습니다. 로그인 창이 열려 있었다면 다시 시도해 주세요` (code 는 그대로 `timeout`).
- exports 에 `NET_ENV, NET_TIMEOUT_MS, GCM_ARGS, isAuthFailure` 추가.

## 메인: `src/main/codeRepo.cjs`, `src/main/main.cjs`

- `git()` 에 옵션 `track = false`. true 면 자식을 모듈 수준 `const trackedGit = new Set()` 에 넣고 `child.once('close', ...)` 에서 뺀다.
- `function killTrackedGit() { for (const c of trackedGit) if (isAlive(c)) killTree(c); trackedGit.clear(); }` export. 주석: 로그인 창을 띄운 채 앱을 끄면 git·창이 살아남아 병합·푸시를 이어 가므로 앱 종료 때 함께 끝낸다.
- `main.cjs` `before-quit` 에서 호출 (`dropSessions()` 근처). main.cjs 의 기존 codeRepo 사용 방식을 따른다.
- 134줄 위 옵션 주석에 track 을 덧붙인다.

## 화면: `src/renderer/code/gitModel.js`, `gitPanel.js`, `styles.css`

- `gitModel.js`:
  ```js
  const LOGIN_HINT_KINDS = new Set(['push', 'sync', 'fetch', 'pull', 'pushOnly']);
  const LOGIN_HINT_MS = 4000;
  // 네트워크 작업이 잠시 이어지면 로그인 창을 기다리는 중일 수 있다 (창이 앱 뒤에 뜰 수 있음). 메인은 창이 떴는지 모르므로 경과로만 판단한다.
  export function loginHint(kind, elapsedMs) {
    return LOGIN_HINT_KINDS.has(kind) && elapsedMs >= LOGIN_HINT_MS ? '로그인 창이 떴다면 로그인을 마쳐 주세요. 안 보이면 작업 표시줄을 확인해 주세요' : '';
  }
  ```
- `gitPanel.js`: import 추가, `loginEl = node('div', { class: 'gp-login', role: 'status', hidden: true })`, 145줄 `el` 의 `headEl` 과 `fixedEl` 사이. `drawBusy()` 에서 `const hint = op ? loginHint(op.kind, Date.now() - op.startedAt) : ''; loginEl.hidden = !hint; if (loginEl.textContent !== hint) loginEl.textContent = hint;`. 새 IPC 없음.
- `styles.css`: `.gp-login { flex: 0 0 auto; padding: 0 10px 3px; color: #cca700; font-size: 11px; }`, `.gp-busy` 줄 근처.

## 테스트 (실패를 먼저 보고 구현)

**절대 금지: 테스트에서 실제 GCM 호출 — 사용자 화면에 창이 뜬다.** 안전장치를 맨 먼저 넣는다:
- `test/codeGit.test.js` 16줄 옆과 `scripts/check-code-view.cjs` 환경 준비 부분에 `process.env.GCM_INTERACTIVE = 'never'`.
- `makeOps` 의 `rec`: 인자에 `credential.helper=manager` 가 있는데 `inner === realGit` 이면 예외. `calls` 는 그대로 두고 옵션까지 담는 `callOpts` 배열을 추가해 돌려준다. 기존 대체 방식 `args[0] === 'pull'` 은 재시도 인자(`-c` 로 시작)를 빠져나가 실제 git 으로 가므로, 재시도 시험의 가짜는 인자에 명령이 **포함**됐는지로 가른다.

`test/codeGit.test.js` (가짜 git 은 `{ kind:'fail', stderr, stdout, exitCode }` 를 던진다):
1. `isAuthFailure`: 진짜 문구 3종 true. 마지막 줄이 아닌 파일 이름(`would be overwritten by merge:\n\tAuthentication failed.txt\nAborting`), hook 출력 뒤 `error: failed to push some refs`, `remote: ... Authentication failed` 뒤 다른 끝 줄, 서브모듈 끝 줄, 마지막 줄이 맞아도 stdout 에 `CONFLICT` → false. kind≠fail → false.
2. push: 첫 시도 `could not read Username ...` + 도우미 gh → 둘째 인자 `[...GCM_ARGS, 'push', ...]`, `{ok:true}`. 두 호출 모두 `env===NET_ENV`, `timeoutMs===NET_TIMEOUT_MS`, `track===true`.
3. 재시도도 `could not read`(창 닫음) + gh → 네트워크 2회로 끝, `code:'auth'`, 문구에 `gh auth login`.
4. 재시도가 `Authentication failed` + gh → 1회 더(총 3회). 그래도 실패면 `auth`.
5. 도우미 `manager` + `could not read` → 재시도 없음(1회), 문구에 `git push`. `manager` + `Authentication failed` → 접두어 없이 1회 더(총 2회), 또 실패면 끝.
6. `get-urlmatch` exit 1 → GCM 재시도, 문구 `git push`. 그 밖의 config 실패(exit 128) → 재시도 없음.
7. SSH·http·`https://u:tok@host/...` 원격 → 재시도 없음, **get-urlmatch 도 부르지 않음**. `https://u@host/...` 는 재시도. 도우미 `!aws codecommit credential-helper $@` → 재시도 없음.
8. 인증 아닌 실패(rejected, 호스트 없음, timeout) → 재시도 없음, get-url 도 없음. 네트워크 timeout 문구가 「로그인 창」 안내. 커밋 timeout 문구는 기존 그대로.
9. pull: 호출 순서 fetch → read → pull. fetch 재시도 성공 → pull 도 `GCM_ARGS` 로. 인증 그대로면 접두어 없음. **fetch 재시도 중 브랜치가 바뀌면 pull·merge 호출 없이 `not-main`.** fetch 인증 실패 후 재시도 실패 → pull·merge 호출 없음.
10. 재시도 둘째 단계 pull 의 CONFLICT → `merge --abort` 1회, `code:'conflict'`. 둘째 단계 중 다른 세션의 병합 → `merging`, abort 없음.
11. Sync: fetch 재시도 성공 → push 도 인증 실패면 재시도 성공. fetch 최종 실패 → push 없음, `then:'sync'`·`then:'push'` 의 `committed:true` 유지.
12. 재시도 중 같은 저장소의 다른 호출 → `busy`.
13. 커밋·스테이징·`merge --abort` 의 env 는 `WRITE_ENV` (`GCM_INTERACTIVE:'never'` 포함), `track` 없음.
14. 기존 시험은 fetch 호출이 늘어 호출 수를 세는 곳이 있으면 의미를 유지해 고친다. 안전 규칙 단언을 약하게 만들지 않는다.

`test/codeRepo.test.js`: `git(.., { track:true })` 로 오래 도는 자식(`-c alias.x=!node -e "setTimeout(()=>{},60000)"` 또는 기존 패턴) → `killTrackedGit()` 뒤 빠르게 거부, 다시 불러도 안전. `track` 없는 자식은 끝내지 않음. 끝난 자식은 집합에서 빠짐(내보낸 시험용 접근이 필요하면 최소로).

`test/git-model.test.js`: `loginHint` — 경계(3999/4000), 다섯 종류, `commit`·`stage`·미지정은 빈 글.

`scripts/check-code-view.cjs`: 1763 줄 근처 느린 작업 시나리오 옆에, 커밋 작업 중에는 `.gp-login` 이 숨어 있고, 느린 원격 작업(pre-push hook 약 6초 대기 + Push)에서는 4초 뒤 보이고 끝나면 숨는지. **이 파일은 다른 세션이 함께 고칠 수 있으니 바로 전에 다시 읽고 필요한 곳만 Edit.**

## 받아들인 한계

- 첫 시도·재시도가 각 5분이라 네트워크가 멈추면 Sync 는 이론상 더 길어진다. 대기 중 취소 수단 없음.
- Commit & Push·Sync 는 느린 커밋 hook 중에도 4초 뒤 조건부 안내가 뜬다.
- 체인이 `gh, manager` 처럼 마지막이 manager 이면 만료된 gh 앞에서 창이 안 뜰 수 있다 (`--get-urlmatch` 가 마지막 값만 준다). `pushurl` 이 따로 있으면 판단은 fetch URL 기준.
- 계정이 달라 생기는 `Repository not found`·403 은 인증 실패로 보지 않아 창이 뜨지 않는다.
- 재시도 인자·환경(`GIT_CONFIG_PARAMETERS`, `GCM_NAMESPACE`, `GCM_INTERACTIVE`)은 hook 으로도 전달되어 hook 안의 git 도 같은 인증을 쓴다.
- 줄바꿈 없는 hook 출력(`remote: …` 뒤에 git 문구가 이어 붙음)은 병합 증거를 가려, 자기 병합을 「다른 작업」으로 안내하고 병합 상태를 남긴다. 데이터 손실은 없다.
- 도우미 경로에 `manager` 라는 단어만 있어도 GCM 으로 판별될 수 있다(`C:/manager tool/foo.exe`). 같은 도우미로 한 번 더 시도할 뿐이다.

## 범위 밖 / 건드리지 않기

- 전역 Git 설정·`gh`·Windows 자격 증명 변경 금지. 실제 인증 실패를 만드는 시험 금지.
- `src/renderer/office/**`, `themes/**`, `scripts/check-renderer.cjs`, `test/isometric·layout·office-play` 는 다른 세션 작업 중.
- 문서(README·결정대장)는 메인이 고친다.
