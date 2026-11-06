# 한영 전환 구현 사양 (확정 — 2026-11-06, 사용자 결정: 「전체 키 방식 재구성」, 분석 결과도 영어)

## 이미 만들어 둔 것 (수정 금지 — 필요하면 보고)
- `src/shared/i18n.js`: `t(key, args?, lang?)`, `getLang()`, `setLang(lang)`, `onLangChange(fn) → 해제 함수`, `hasKey(key)`, `locale()`('ko-KR'|'en-US'), `LANGS`, `normLang`.
  - 값이 문자열이면 `{name}` 자리 채우기, 함수면 `args => 문자열`(영어 복수형: `a => \`${a.n} agent${a.n === 1 ? '' : 's'}\``).
  - 메인 프로세스는 `const { t, getLang, setLang, onLangChange } = require('../shared/i18n.js');` (require(esm), 실측 동작).
- `src/renderer/i18n-dom.js`(화면 전용): `initLang({sync})`(localStorage 'ao.lang' 복원·저장, `<html lang>`, storage 이벤트로 다른 창 따라감), `applyStatic(root?)`(`data-i18n="키"` → textContent, `data-i18n-title` / `data-i18n-aria-label` / `data-i18n-placeholder` → 속성), `bindLangToggle(button)`.
- 사전: `src/shared/i18n/ko/<영역>.js`, `src/shared/i18n/en/<영역>.js` — `export default { '영역.키': '값', ... }`. **영역 파일은 자기 담당만 편집한다.**
- `test/i18n.test.js`: 한·영 키 동일, 접두어=영역, 영역 간 중복 없음, 영어 값에 한글 없음, `{자리}` 일치, 소스의 `t('키')`·`data-i18n="키"` 가 사전에 있음.

## 핵심 규칙
1. **한국어 값은 지금 화면 문구와 글자까지 똑같이**(공백·줄바꿈 `\n`·이모지·마침표 포함 — D-079 줄바꿈 규칙 유지). 그래서 기본 언어(ko)에서 기존 테스트가 기대값 수정 없이 통과해야 한다. **기존 테스트의 한국어 기대값을 바꾸지 마라.** 내부 구조가 바뀌어 테스트 코드를 고쳐야 하면 최소한으로, 기대 문구는 그대로.
2. 키 이름: `영역.묶음.이름` 영문 camelCase (예: `code.git.pushFailed`, `office.bubble.reportDone`). 변수는 `{name}` 자리로. 한국어 조사(이/가/을/를)가 변수에 붙는 문장은 ko 값에 조사까지 그대로, en 값은 자연스러운 영어로.
3. 영어 번역: 짧고 자연스러운 앱 UI 영어(문장형 안내는 문장, 버튼은 동사/명사). 고유명사(Claude, Codex, Grok, Muse, Gemini, Antigravity CLI, Agent Office, Git, main, origin)·명령어·경로·키 이름은 그대로. 이모지는 유지.
4. **번역하지 않는 것**: AI 에게 보내는 프롬프트·협업 규칙(collabRules.cjs, moderator 의 promptFor/ownerLine 등)·`[질문]/[완료]/[선택]/[사용자]` 표시와 그 정규식, hookServer 의 DENY_MESSAGE(AI 에게 가는 글), git·CLI 원문 판별 정규식(stderr 마지막 줄 규칙 등 — 원문 판별용 정규식은 그대로), AI·사용자가 쓴 내용, 사용자 입력 데이터(커스텀 사무실 이름 등), `console.*` 로그, 주석, 협업 SIMPLE_RE/HARD_RE(사용자 입력 키워드).
5. **문구로 판별하는 로직 금지**: 번역된 메시지를 정규식·includes 로 판별하는 곳(예: panel.js `/너무 큽니다/`, codeGit.cjs `/^git 실행 실패:/`)은 코드/종류 값으로 바꾼다(메시지는 표시 전용).
6. **실행 중 전환**(창 새로고침 금지 — 새로고침하면 메인이 터미널·협업을 정리한다):
   - 오래 보이는 화면(버튼·라벨·placeholder·select option·제목·목록·상태줄·이름표·방 이름·툴팁·메뉴)은 `onLangChange` 에서 **즉시** 다시 그린다. 한 번만 만드는 요소는 다시 그리는 함수로 분리하거나 그 자리에서 글자만 갱신. 리스너 중복 등록 금지. 지문 캐시(fp 등)가 있으면 비운다.
   - 잠깐 보이는 것(말풍선·작업 요약·활동 기록에 이미 쌓인 줄·이미 보낸 메인 메시지·터미널에 이미 쓴 글·대화창에 이미 그린 AI/안내 메시지)은 **다음 갱신 때** 새 언어로 바뀌면 된다(받아들인 한계).
   - 데이터 표의 표시 이름(음료·가구·방·상주 캐릭터 이름 등)은 getter(`get label() { return t('office.drink.americano'); }`)나 표시 시점 `t()` 로 — 저장된 값·id·비교 키는 바꾸지 않는다.
   - 날짜·시간 형식의 `'ko-KR'` 하드코딩은 `locale()` 로.
7. 메인 프로세스 문구는 메인의 현재 언어(`getLang()`, 화면이 `lang:set` 으로 알려 줌)로 **만들 때** 번역해 보낸다. 오류 `throw new Error(t('main.x', {...}))`.
8. 화면 쪽 정적 HTML 은 `data-i18n*` 속성 + 기존 한국어 글자 유지(첫 그림 깜빡임 방지), `applyStatic` 이 덮어쓴다.
9. 새 파일·새 의존성·새 테스트 러너 금지(사전 영역 파일·기존 test 파일에 테스트 추가는 허용). 범위 밖 파일 수정 금지. 관계없는 코드 정리·리팩토링 금지. 주석은 주변처럼 한국어로 짧게.
10. 검증: 담당 파일과 관련된 기존 테스트를 `node --test test/<파일>.test.js` 로 돌려 통과 확인 + `node --test test/i18n.test.js` 통과. 경계 문구(메인이 만드는 오류 등)는 기존 test 파일에 `setLang('en')` → 영어 확인 → `finally setLang('ko')` 테스트를 1~3개 추가. 전체 `npm test` 는 돌리지 말 것(다른 에이전트가 동시에 편집 중).
11. 끝나면 보고: 바꾼 파일, 추가한 키 수, 번역하지 않고 남긴 한글(이유), 영역 밖에 필요한 일(다른 담당에게 넘길 것), 실행한 테스트 명령과 결과.

## 영역 간 약속 (정확히 이 이름으로)
- 테마 이름: 키 `theme.name.<테마 id>` (office·theme 담당이 정의: `pixel-office`, `pixel-office-plain`?, … 실제 id 로). 화면 틀 담당은 select option 을 `hasKey(k) ? t(k) : th.name` 으로.
- `window.office.setLang(lang)` → `ipcRenderer.invoke('lang:set', { lang })` (메인 담당이 preload·main.cjs 에 추가). 화면 틀 담당이 시작 시와 `onLangChange` 때 호출(실패 무시 `.catch(() => {})`).
- 메인 `lang:set`: `handleMain`(ipcGuard) 으로 등록, `setLang(lang)` + `config.lang` 저장 + 트레이 메뉴 재생성 + 펫 창 제목 갱신. 앱 시작 때 `setLang(config.lang)` 을 트레이 만들기 전에.
- 펫 창: `pet.js` 가 `initLang({ sync: true })` 로 언어를 따라간다(펫 창은 lang:set 호출 금지 — ipcGuard 가 메인 창만 허용).
- 사무실 환경 문구(`office/environment.js` 의 label)는 언어가 바뀌면 캐시를 비워 다음 읽기에 새 언어. 화면 틀 담당은 `onLangChange` 에서 상태줄을 다시 그린다.
- `office/phrases.js` 의 `toolPhrase()` 등은 호출 시점 언어로 문자열을 돌려준다(협업 패널이 사용).
- 확인 필요 문구(app.js ATTENTION_TEXT): 상태에는 reason 을 두고 보낼 때 `t()` — 언어가 바뀌면 다시 publish(펫 창도 새 언어 문구를 받음).

## 담당
| 담당 | 파일 | 사전 영역 |
|---|---|---|
| A 화면 틀 | src/renderer/index.html, app.js, layout.js, agentStatus.js, styles.css(버튼 모양만) | app |
| B 협업 | src/renderer/collab/panel.js, collab/moderator.js(화면 문구만) | collab |
| C 코드 화면 | src/renderer/code/*.js, src/main/codeGit.cjs, codeRepo.cjs, codeAnalysis.cjs | code |
| D 사무실·테마 | src/renderer/office/*.js, src/renderer/themes/**(D-002 사용자 예외) | office, theme |
| E 메인 | src/main/main.cjs, preload.cjs, ipcGuard.cjs, agentCli.cjs, museCli.cjs, grokHooks.cjs, agyHooks.cjs, hookSettings.cjs, claudeCli.cjs, shellCmd.cjs, env.cjs, statusShape.cjs, modelCatalog.cjs, weather.cjs | main |
| F 실행기·사용량·펫 | src/main/collabAgents.cjs, usage.cjs, claudeUsage.cjs, codexCli.cjs, petImport.cjs, pet.cjs, petRules.cjs, src/renderer/pet/(pet.js, model.js, index.html, pet.css) | run, pet |
