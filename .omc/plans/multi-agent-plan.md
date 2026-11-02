# 계획: AI 종류 확장 (Grok Build · Muse Code · Antigravity) + 협업 다중 선택 + 임시 캐릭터·펫 (2026-11-02)

사용자 결정: Kimi 제외. Google 은 Antigravity CLI(agy) 중심. 협업은 사용자가 참여 AI 를 직접 다중 선택. 새 AI 마다 사무실 캐릭터·바탕화면 펫을 임시 간단 디자인으로(디자인은 나중에 별도) — 그림 파일 경계(D-002)의 사용자 지시 예외.

## 조사 근거
- 코드 지도(explore): 앱 전체가 'claude'|'codex' 두 값 전제. 위험 지점 hookServer.toEvent(:50, 세 번째 값 → claude), moderator.other()(:93, 상대 한 명). 공통인 것: 프로세스 실행(run/commandFor/spawnCli/lineReader/killTree/ptyManager), loc 모양, 협업 실행기 인터페이스(send/steer/stop/close/busy/proc + 이벤트 session/text/tool/done/notice/steered), 모델 {value,label,description,efforts}, 사용량 Row.
- 캐릭터: pixel-office sprites.drawCharacter 가 `a.cli === 'codex'` 면 codex-sprite.drawCodexCharacter(포즈 walk/sit/type/read/run/drink·졸음·뒷모습·액세서리 처리 완비). custom 테마는 pixel-office drawCharacter 를 그대로 씀(art.js:6,216) → 분기 한 곳이면 두 테마 모두 적용. 말풍선 높이 보정 Codex 전용(theme.js:524-528, art.js:234).
- 펫: PET_KINDS=['claude','codex'](petRules:8), visiblePets 가 두 종류 고정(model.js:35-39), drawBase 대체 그림은 Claude=아이콘·그 외 `>_` 상자(pet.js:45-72), 사용량 섹션 #usage-claude/#usage-codex 고정, 펫 선택 대화상자 두 구역 고정(index.html:102-107), 창 크기는 펫 수에 따라(placeBounds).
- 외부 CLI(공식 문서, 미설치라 실측 전): Grok Build `grok`(hook HTTP·Claude 와 같은 이벤트, `-p --output-format streaming-json`, ACP `grok agent stdio`, 로그인 상태 명령 없음, .claude/settings.json hook 도 읽음 → 중복 주의) / Muse Code `muse`(hook command 17종, `muse exec --json`, `muse serve`(MSP: model/list·usage/read·approval), Muse Wonder Full 은 Power 플랜) / Antigravity `agy`(hook command 6종 — 프롬프트 제출·알림·권한 요청 없음, `-p --output-format stream-json --conversation`, 키링 인증·상태 명령 없음, 모델 ID 비공개, Gemini 4 Argon).

## 단계 (각 단계 loop, 커밋은 사용자)
### 0A. 에이전트 레지스트리 + Claude·Codex 어댑터 (동작 무변경)
- `src/shared/agents.js`(렌더러·메인 공용 정의: id, name, short, color, accent, order, capabilities) + `src/main/agents/{index,claude,codex}.cjs`(locate·version·authStatus·loginArgs·tabArgs·hook 주입·createChat·listModels·readUsage).
- main: 전역 claude/codex → locs Map, status() → `agents: { id: { found, path, version, auth } }`(기존 키는 호환용 유지 후 제거), createTabPty·collabSend·collabModels·collabRunning·needX 를 레지스트리 순회로. hookServer `_cli` 허용 목록.
- 렌더러: KIND_NAME/KIND_PREFIX/NAMES/PICK_KINDS/색 클래스를 레지스트리에서. engine cli 정규화 허용 목록.
- 테스트: 기존 전부 통과 + 레지스트리 단위 테스트, 가짜 세 번째 AI 로 hook·엔진이 claude 로 오인하지 않음.
- 축소(확정 사양 .omc/state/spec-agents-0a.md): 어댑터·status 순회·협업 함수는 0B·0C 로 미룬다. 0A 는 정의 파일 + 이름 상수 파생 + hook/엔진 정규화 + main 의 locs Map + status().agents 키만.
### 0B. 진입 화면 좌우 분할 · 상단 통합 · 새 탭 목록 · 협업 다중 선택 UI
- 진입: 왼쪽 AI 목록(상태 점 ● 연결/○ 로그인 필요/– 미설치, 계정 요약) · 오른쪽 선택한 AI 상세(설치 안내 / 로그인 터미널 / 계정·플랜·「이 AI 로 새 탭」). 입장 조건 = 하나 이상 연결(사용자 확인 필요 — 지금은 Claude 필수). 「다른 세션 보기」 등 Claude 전용 기능은 Claude 있을 때만 표시.
- 상단: 「연결 n/N」 칸 하나 → 같은 목록 패널.
- 새 탭: 실행 = AI 목록(연결된 것만 활성) + 「협업 대화」. 협업을 고르면 참여 AI 체크박스(2개 이상, 연결된 것만), 구현 담당 선택지도 고른 AI + 「구현 전에 물어보기」. 선택은 기억(store).
- 구현 결과(확정 사양 .omc/state/spec-agents-0b.md): 입장 조건 = 하나 이상 연결(사용자 결정 반영). 「구현 담당 선택지(고른 AI + 물어보기)」·어댑터 폴더(src/main/agents/)는 0C 로 미룸 — 협업 참여 AI 는 지금 Claude·Codex 둘 다일 때만 열림.
### 0C. 협업 다자 진행자 (사용자 지시: 다중 선택) — 구현 완료 (확정 사양 .omc/state/spec-agents-0c.md, 결정대장 D-054)
- 구현 결과: roster·규칙 문장 생성(collabRules.cjs)·COLLAB_CHATS 표·panel/CSS 완료. 펫·확인 필요의 roster 화(아래 「펫 협업 상호작용」)는 0D 로 남김. 실제 AI 호출 점검은 생략(2명 경로는 규칙 문장 일치·기존 협업 테스트로 보장).
- Moderator 에 roster(참여 AI 배열, 순서 = 선택 순서, 구현 담당이 있으면 맨 앞). other() → 「다음 차례 = roster 에서 직전 화자 다음」 라운드 로빈.
- 「모두에게」 = roster 전원이 한 번씩(첫 질문자·구현 담당 우선), 끼어들기·steer 도 전원 기준.
- 합의(D-032): 한쪽 [완료] 는 제안 → **나머지 전원**이 이어서 [완료] 해야 종료(반론 하나면 초기화). 질문(D-031): askers 다수 그대로, 버튼 답은 질문한 AI 에게.
- seen/prefs/catalog 를 roster 맵으로, 프롬프트 표기 [이름] 를 레지스트리 이름으로, COLLAB_RULES 를 roster 로 생성(참여자 목록 문장), 「구현 담당 없음」 시 승인 질문자 = roster 첫 AI.
- panel: 모델·추론 단계 행을 roster 만큼, 받는 사람 선택지·@멘션 정규식을 roster 에서, 말풍선 색 클래스는 레지스트리 색.
- 펫 협업 상호작용(D-025)·확인 필요(D-022) 를 roster 기준으로.
- 테스트: collab.test.js 를 roster 매개변수화(2명 기존 동작 그대로 + 3명 순서·합의·질문·끼어들기).
### 0D. 임시 캐릭터 · 펫 (그림 경계 사용자 지시 예외 — 결정대장 기록) — 구현 (확정 사양 .omc/state/spec-agents-0d.md, 결정대장 D-055)
- 사무실: codex-sprite 를 바탕으로 팔레트·머리 표식만 바꾸는 `drawAgentCharacter(ctx, a, t, x, y, look)` 일반화(포즈·졸음·뒷모습·음료·액세서리 동작 그대로), 레지스트리의 look(본체·그늘·밝은색·표식 글자/모양)으로 AI 별 구분. sprites.drawCharacter 분기를 cli → 그리기 함수 맵으로(Claude·Codex 는 기존 함수 그대로). 말풍선 높이 보정도 맵. custom 테마는 자동 적용.
- 펫: PET_KINDS 를 레지스트리에서, visiblePets(상시 = 설치·연결된 AI 전부, 알림만 = 알림 있는 AI, 협업 = roster), 대체 그림 = 그 AI 의 사무실 캐릭터를 크게 그린 것(새 그림 파일 없음), 창 크기·배치 N 개(최대 개수와 줄바꿈 규칙 정함), 사용량 섹션·펫 선택 대화상자 구역을 레지스트리에서 생성. 사용량 없는 AI 는 섹션 숨김.
- 점검: check-renderer 에 세 번째 가짜 AI 로 캐릭터 모든 포즈가 그려지고(픽셀 변화) 펫 N 개 배치가 화면 안인지.
### 1. Grok Build 어댑터 (설치·로그인 후 실측부터)
locate(%USERPROFILE%\.grok\bin, npm @xai-official/grok), version, 로그인 판정(상태 명령 없음 — 실측으로 정함), 탭 인자, hook HTTP 주입(세션 단위 설정 가능 여부 실측 — 전역 파일 수정은 사용자 승인), Claude 전역 hook 중복 구분(GROK_HOOK_EVENT·camelCase), 협업 실행기(ACP 또는 -p streaming-json — 실측 후 선택), 모델(grok models), 사용량(조회 경로 없으면 표시 안 함).
### 2. Muse Code 어댑터
hook = command 전용 → 앱이 배포하는 작은 전달 스크립트(curl.exe 방식 재사용 가능 여부 실측), 협업·모델·사용량 = `muse serve`(MSP) 또는 `muse exec --json`, 로그인 판정 실측.
### 3. Antigravity 어댑터
hook 6종(~/.gemini/config/hooks.json — 세션 단위 주입 가능 여부 실측), 프롬프트 제출·멈춤 외 상태는 PreToolUse/Stop 로 근사, 협업 = `agy -p --output-format stream-json --conversation`(Windows 헤드리스 제약 실측), 로그인 = 헤드리스 미인증 즉시 실패를 판정에 사용, 모델 = 표시명 → 실측 슬러그.

## 사용자 결정 (2026-11-02)
- 입장 조건: 하나 이상 연결되면 입장. 로그인 화면에 「Claude 를 메인으로 지원합니다」 같은 안내 문구(0B).
- 펫 상시 표시: 연결된 AI 전부, 가로 한 줄(0D) → 사용자 재지시(0D 중): 쓰는 중인 AI(탭을 연 AI)만 + 알림 있는 AI, 실행 직후엔 펫 없음.
- 진행: 0A 부터 차례로 loop.

## 새 AI 단계(1~3) 공통 원칙 (사용자 지시 2026-11-02)
- 각 AI 의 **공식 문서**를 먼저 확인하고 설계 근거로 삼는다(docs.x.ai/build · dev.meta.ai/docs/muse-code · antigravity.google/docs). 커뮤니티 자료(비공식 gist·릴리스 모음·다른 도구 코드의 주장)는 참고만 하고 근거로 쓰면 「미확인」 표시. 그다음 설치·로그인 후 로컬 실측으로 문서와 맞는지 확인.

## 선행 조건
- 1~3단계 실측에는 각 CLI 설치·로그인(구독) 필요 — 사용자.
- 테마 파일(사무실 캐릭터) 수정은 이번에 사용자 지시 예외 — 상주 캐릭터(life.js)는 다른 세션 작업이므로 건드리지 않음.

## 사용자 결정 (2026-11-02, 0D 뒤)
- 설치형에 CLI 를 넣어 배포하지 않는다(Claude Code 재배포 불가 — 라이선스 실측). 진입 화면 「설치」 버튼이 공식 설치 명령을 앱 안 터미널에서 실행, 안전하게 못 하면 안내만 유지.
- 새 AI 3종은 「등록 먼저 + 설치는 Claude 가」: 공식 문서 기준으로 바로 등록하고 설치 버튼·탭 실행·로그인을 붙인다. Claude 가 이 PC 에 세 CLI 를 공식 명령으로 설치해 실측 준비, 로그인은 사용자. 로그인 뒤 사무실 hook·협업을 실측으로 붙인다(1~3단계를 「등록·기본」과 「실측 연동」으로 나눔).
- 공식 설치 명령(Windows, Node.js 불필요): Claude `irm https://claude.ai/install.ps1 | iex` (→ %USERPROFILE%\.local\bin\claude.exe, PATH 는 안 고침), Codex `$env:CODEX_NON_INTERACTIVE='1'; irm https://chatgpt.com/codex/install.ps1 | iex` (-ExecutionPolicy Bypass, → %LOCALAPPDATA%\Programs\OpenAI\Codex\bin, 사용자 PATH 추가). 출처 code.claude.com/docs/en/setup · learn.chatgpt.com/docs/codex/cli.
