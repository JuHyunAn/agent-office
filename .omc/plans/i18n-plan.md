# 한영 전환 설계안 (loop 2단계 결론, 2026-11-06)

## 요청
모든 메뉴·안내·에이전트 이름·작업 사항 등 한글 문구를 영어로 번역하고, 버튼으로 한↔영 전환. 버튼은 상단 바에 「한영전환 / 펫 / 테마」 순서.

## 실측 사실 (1단계)
- 표시 문구: 렌더러 메인 화면 ~210, 코드 화면 ~175, 사무실(엔진·생활·phrases·view·environment) ~200, 메인 프로세스가 만들어 보내는 완성 문장 ~200(git·분석·협업 실행기·usage·petImport·status), 펫 창 ~25, 네이티브(트레이·대화상자) ~25.
- 메인은 오류·안내를 **완성된 한글 문장**으로 보낸다(코드/키 없음). 테스트 ~300곳 + check-code-view ~100곳이 한글 원문을 비교.
- **창 새로고침 금지**: main.cjs:525 `did-start-loading` → `dropSessions()` 가 PTY·협업·권한 보류 전부 정리. → 실행 중 전환은 화면 재번역으로 해야 한다.
- 캔버스: 테마가 `a.label`·`a.bubble.text`(office 가 매 프레임 새 snapshot 객체로 넘김 — engine.snapshot/life.snapshot 은 새 객체)를 그린다. 테마 자체 상수(pixel-office TITLES 10개 — load() 때 캐시에 구움, '커피 · 음료', 'N명 스킬 협업 중', japan '오피스', custom ROLES·'나')는 테마 파일 안(D-002 다른 에이전트 담당).
- 메인 창·펫 창은 같은 출처 `app://office` → localStorage·storage 이벤트 공유.
- 진입 화면(#gate)은 z-index 50 전체 덮개 — 상단 바 버튼이 안 보인다.

## 설계: 「표시 시점 사전 번역」 (권장안 A)
소스 문자열은 한국어 그대로 둔다(기본 언어 ko — 기존 동작·테스트 무변경). 영어 모드일 때만 화면에 나타나는 순간 사전으로 바꾼다.

1. `src/shared/i18n.js` (ES 모듈, 메인은 require(esm) — D-048 선례): `tr(s, lang)` 번역기 + 사전 `src/shared/i18n/*.js`(영역별 `{ exact: {한글: English}, patterns: [[RegExp, replacer]] }`).
   - 순서: 한글 없음 → 그대로 / 앞뒤 공백 보존 / exact / 여러 줄이면 줄마다 / patterns(캡처는 재귀 tr) / 앞쪽 이모지·기호 떼고 재시도 / 구분자(` · `, ` — `, `: `) 로 나눠 부분 번역 / 못 찾으면 원문 유지(한글 그대로 — 점진적 폴백). 결과 캐시(상한).
2. 렌더러 `src/renderer/i18n-dom.js`: 영어 모드일 때만 `MutationObserver(document.body, childList·subtree·characterData·attributes[title, aria-label, placeholder])` 로 텍스트 노드·속성을 번역. 원문은 WeakMap(node → {orig, out}) 에 보관 → 한국어로 돌아갈 때 DOM 을 훑어 `data === out` 인 노드를 원문으로 복원. 자기 쓰기는 out 비교로 무시. **제외**: `.xterm`, `.monaco-editor`, 협업 AI·사용자 메시지 본문, 코드 화면 파일 트리·경로, input/textarea/contenteditable, `[data-no-i18n]`. 한국어 모드에서는 관찰자 해제(오버헤드 0).
   - `window.confirm`/`alert` 감싸서 번역.
   - textContent 를 되읽어 비교하는 2곳(gitPanel.js:289, collab/panel.js:209)은 원문 비교 도우미로 바꿈(같은 문구 반복 쓰기 방지).
   - `document.documentElement.lang` 전환.
3. 캔버스(테마 파일 무수정):
   - view.js draw(): snapshot 의 `label`·`bubble.text`·`sessionLabel`·`task` 를 테마에 넘기기 전에 번역(새 객체라 엔진 상태 불변).
   - 테마 상수: view.js 가 테마 호출(load·draw*) 동안만 `CanvasRenderingContext2D.prototype.fillText/strokeText/measureText` 를 번역하는 범위 플래그를 켠다(영어 모드일 때만). 전환 시 view 가 현재 테마 캐시를 다시 굽는다(`unmount(null)` → `load()` → `mount()`, D-019 와 같은 짧은 멈춤).
4. 앱이 xterm 에 직접 쓰는 안내(app.js 603·906·916, terminalPanel)는 호출부에서 `tr()`.
5. 펫 창: 같은 i18n-dom 사용, 언어는 localStorage `ao.lang` + storage 이벤트. pet/model.js 의 `Intl 'ko-KR'` → 언어 따라.
6. 메인: `lang:set` IPC(preload `setLang`) → `config.lang` 저장, 트레이 메뉴 재생성. 네이티브 문구(트레이·pet 서브메뉴·showMessageBox·showOpenDialog 제목·showErrorBox·펫 창 제목)만 `tr()` 로 감싼다. 메인이 렌더러로 보내는 오류 문장은 그대로(화면에서 번역).
7. 코드 분석 결과 언어: 영어 모드면 프롬프트의 「출력 규칙(모두 한국어)」을 영어로, 캐시 지문에 언어 포함(전환 후 이전 언어 결과 재사용 방지). 커밋 메시지 생성은 이미 저장소 언어를 따르므로 그대로.
8. 번역하지 않는 것: AI 에게 보내는 프롬프트·협업 규칙(collabRules, moderator promptFor, `[질문]/[완료]/[선택]` 프로토콜), AI·사용자가 쓴 내용, git 원문, 터미널에 이미 쓴 글, 사용자 입력 데이터(커스텀 사무실 이름 등), 로그·주석. 협업 SIMPLE_RE/HARD_RE(사용자 입력 키워드) 그대로.
9. 버튼: 상단 바 `.spacer` 뒤, 펫 앞에 `한 | EN` 분절 pill(현재 언어 굵게, title 「언어 전환 · Language」). 진입 화면에도 같은 버튼 1개(오른쪽 위) — 진입 화면은 상단 바를 덮기 때문(자동 결정).
10. 저장: localStorage `ao.lang`('ko'|'en', 기본 ko) + 메인 config.lang(트레이용, 시작 시 렌더러가 동기화).
11. 검증: `test/i18n.test.js`(번역기 단위 — exact·공백·여러 줄·이모지·구분자·패턴·폴백·ko 항등), `scripts/check-i18n.cjs`(UI 소스의 한글 문자열 리터럴·템플릿을 뽑아 en 번역 후 한글이 남는 것 보고 — npm test 에 넣지 않음: 다른 세션이 문구를 추가할 때 테스트가 깨지지 않게), 기존 `npm test` 전체 무변경 통과, `npm run test:renderer`.

## 대안 B (비권장)
모든 호출부를 `t('key')` 로 바꾸고 메인이 언어를 받아 문장을 만들거나 오류 코드를 보내게 재구성. 영향 40+ 파일·테스트 ~400곳 수정, 테마 파일(D-002) 수정 필요, 다른 세션과 충돌 위험 큼. 장점: 명시적, 미번역 누락을 정적으로 잡기 쉬움.

## 알려진 한계 (A)
- 이미 터미널에 쓴 글·활동 기록에 남은 AI 작성 부분은 번역 안 됨. 활동 기록·말풍선의 앱 문구는 전환 시 다시 번역됨.
- 사전에 없는 새 문구는 한글로 남는다(check-i18n 으로 발견).
- 동적 합성 문장은 패턴 품질에 좌우.
- 협업 대화의 AI 답변 언어는 AI 가 정한다(규칙이 한국어라 대개 한국어).
