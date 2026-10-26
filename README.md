# Agent Office

Claude Code 의 메인 세션과 하위 에이전트를 **사무실에서 일하는 캐릭터**로 보여 주는 데스크톱 앱.
왼쪽은 사무실(항상 표시), 오른쪽은 **공식 Claude Code** 를 탭으로 여러 개 띄운다.

## 실행

```bash
npm install
npm start        # IDE 터미널에서도 동작 (ELECTRON_RUN_AS_NODE 를 지우고 실행)
npm test         # 엔진·hook 처리 단위 테스트
```

필요: Node 20+, Claude Code CLI (`npm install -g @anthropic-ai/claude-code`). 로그인은 공식 Claude Code 가 한다.

## 동작 방식

```
Claude Code (탭·VS Code 등) ──HTTP hook──▶ 앱 내부 서버 127.0.0.1:47821 ──▶ 사무실 엔진 ──▶ 테마가 그림
       ▲
       └── 오른쪽 탭: node-pty 로 공식 `claude` 실행 (--settings 로 hook 주입, --session-id 로 탭과 연결)
```

| 화면 | 연결 이벤트 |
|---|---|
| 입구 → 방으로 출근 | `SubagentStart` (종류별 방: 분석·기획·개발·검토) |
| 말풍선 「⌨ 수정 중: …」 | `PreToolUse` (하위 에이전트 것은 `agent_id` 로 구분) |
| 팀장실로 가서 보고 → 휴게실 | `SubagentStop` |
| 「📨 결과 공유 중...」 다른 자리로 이동 | 끝난 직후 30초 안에 다음 에이전트 시작 (**추정** — 가끔 틀릴 수 있음) · `SendMessage` 는 정확 |
| 빨간 「❓」 말풍선 | `PermissionRequest`·`Notification` |
| 팀장 「✅ 답변 완료」 | `Stop` |

- **앱 탭의 세션**: 자동으로 사무실에 나타난다 (사용자 설정 변경 없음).
- **VS Code 등 다른 곳의 세션**: 상단 「다른 세션 보기」를 켜면 `~/.claude/settings.json` 에 hook 이 추가된다 (백업 후 수정, 끄면 이 앱 것만 제거). 앱이 꺼져 있어도 Claude 작업은 영향 없음 (실측).
- **이어받기(복제)**: 다른 곳 세션을 `--resume <id> --fork-session` 으로 복제해 새 탭에서 이어 간다. 원래 세션은 그대로.

## 그림 바꾸기

[THEME.md](THEME.md) — 테마 폴더 하나만 추가하면 배경·캐릭터·말풍선을 통째로 바꿀 수 있다.

## 구조

```
src/main/       Electron 메인 (창, hook 서버, pty, 사용자 설정 hook)
src/renderer/   화면 (app.js: 진입·탭·터미널 / office/: 엔진 / themes/: 그림)
test/           node:test 단위 테스트
```

## 알려진 한계

- 실행 중인 VS Code 세션 **안으로** 지시를 넣는 공식 방법은 없다 — 같은 폴더에서 새 세션을 열거나 복제해서 이어받는다.
- 결과 공유 연출은 시간 근접으로 추정한다 (메인 Claude 를 거치는 실제 흐름과 다를 수 있음).
- 배포용 설치 파일(electron-builder 등)은 아직 없다.
