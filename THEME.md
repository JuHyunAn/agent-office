# 테마 제작 사양 (그림·애니메이션 담당용)

Agent Office 의 **그림은 전부 테마가 그린다.** 엔진은 「누가 어디에 있고, 어떤 자세이며, 무슨 말풍선을 띄우는지」만 계산해 넘긴다.
새 그림(배경 일러스트·캐릭터 스프라이트)으로 바꾸려면 **새 테마 폴더 하나만 추가**하면 된다. 엔진·앱 코드는 고치지 않는다.

기본 테마는 `pixel-office`(도시 배경)이며 `pixel-office-plain`(배경 없음)과 기존 `mockup`도 선택할 수 있다. 두 픽셀 버전은 같은 배치도와 렌더러를 공유하며, 전환할 때 생활 상태·에이전트·카메라를 재생성하지 않는다.
이동 좌표는 엔진의 직사각형 월드에서 계산하고 사선 시점은 화면에서만 투영한다.
기본 테마는 중앙 8개 구역과 대표실·화장실 별채, 두 연결 통로로 구성된 U자형 월드를 사용한다.
작업실의 `layout.workTables`와 `layout.furnishings`가 실제 가구 배치를 정의한다. 좌석·장애물·그림·책상 조명이 이 배치를 공유하므로 가구를 옮길 때 해당 데이터를 수정한다.

```
src/renderer/
├─ office/            ← 엔진 (수정 금지: 이동·상태·말풍선 계산)
│   ├─ engine.js
│   ├─ roles.js       ← 에이전트 종류 → 방 규칙
│   └─ view.js        ← 그리기 루프 (테마 함수를 호출)
└─ themes/
    ├─ index.js       ← 테마 등록부 (여기에 한 줄 추가)
    ├─ mockup/        ← 현재 목업 (도형) — 참고용 예시
    └─ <새 테마>/      ← 여기에 만든다
        ├─ theme.js
        ├─ layout.js
        └─ assets/    ← png 등
```

## 1. 테마 객체

`themes/<이름>/theme.js` 는 아래 모양의 객체를 `export default` 한다.

| 필드 | 필수 | 설명 |
|---|---|---|
| `id` | ✔ | 영문 식별자 (`'pixel-office'`) |
| `name` | ✔ | 상단 「테마」 선택 상자에 보일 이름 |
| `layout` | ✔ | 배치도 (2절) |
| `load()` | | 이미지 미리 불러오기. `async` 가능. 테마 전환 시 1회 호출 |
| `drawBackground(ctx, layout, t)` | ✔ | 바닥·벽·가구 등 캐릭터 **뒤** |
| `drawForeground(ctx, layout, t)` | | 책상 앞판 등 **앉은 캐릭터 앞**을 가리는 것 (서 있거나 걷는 캐릭터는 이보다 앞에 그려진다) |
| `drawAgent(ctx, agent, t)` | ✔ | 캐릭터 1명 (3절) |
| `drawBubble(ctx, agent, bubble, t)` | ✔ | 말풍선 1개 (4절) |

아이소메트릭처럼 가구와 사람을 하나의 깊이 순서로 그리는 테마는 위 그리기 함수 대신
`drawScene(ctx, agents, t, state)`를 제공할 수 있다. `state`는 이동 목표·문 개폐·가구 선택과 `environment`(서울 시각의 낮/밤·현재 날씨)를 전달한다. 이때 아래 필드도 사용한다.

| 필드 | 설명 |
|---|---|
| `viewport: { width, height }` | 투영된 화면 크기. 생략하면 `layout` 크기를 사용 |
| `project(x, y)` | 엔진 좌표를 화면 좌표로 변환. 캐릭터 툴팁 선택에도 사용 |
| `background` | 화면의 여백 색 |
| `sceneBackground(environment)` | 낮·밤에 따른 여백 색. 생략하면 `background` 사용 |

`pixel-office`는 1600×1000 논리 화면을 3200×2000 렌더 버퍼에서 그린다. 도형은 반 픽셀 단위로 래스터화하고 확대 보간은 끈다.
고정 가구는 고해상도 비트맵으로 한 번 그린 뒤 캐시하여 매 프레임 캐릭터·문과 깊이 순서로 합성한다.
음료 정의는 `office/drinks.js`, 투명 배경 원본과 제작 프롬프트는 `assets/drinks/`에 있다. `drink-images.js`가 원본을 작은 비트맵으로 한 번 준비하고 캐릭터 손에도 같은 음료 이미지를 그린다.
`exterior.js`는 `assets/city/`의 낮·일반 밤·네온 밤 원화를 불러온다. 최초 승인 시안과 바닥 위치 가이드로 제작했고, 프롬프트는 같은 폴더의 `제작기록.md`에 보관한다. 원화의 세 기준점을 실제 사무실 좌표에 맞춘 뒤 1600×1000 비트맵으로 캐시한다. 아래층 외벽은 화면 아래까지 이어지며, 비·눈만 배경 프레임에서 움직인다.
서울 22:00~07:00의 유효한 비 외 날씨에서 `environment.neon`이 켜진다. 도시 캐시는 네온 상태와 흐린 날씨도 구분하며, 비가 오면 일반 밤 배경을 사용한다.
`atmosphere.js`는 후면·측면 통창 7개에 동일한 배경 프레임을 같은 좌표로 복사해 창문 안팎의 풍경을 연결한다. 불투명한 사무실 바닥·벽을 외부 위에 그려 강수가 실내를 침범하지 않도록 한다.
낮 바닥광·접촉 그림자와 밤의 감쇠·책상 조명은 미리 합성해 재사용하고, 창문을 제외한 실내 마스크로 범위를 제한한다. 이름표·말풍선은 조명 합성 후 그려 가독성을 유지한다.
캐릭터는 원본 스프라이트의 1.5배로 그리며, 이전 2배 크기보다 25% 작다.
가구와 사람은 월드 `x + y` 순서로 합성한다. 캐릭터는 `sprites.js`에서 130ms 단위 프레임으로
그리며, 원형 몸체를 유지하고 무작위 머리·악세서리·눈·소품·다리 움직임으로 상태를 구분한다. 외형은 `appearance`에 고정되며 렌더링 중 무작위 값을 생성하지 않는다.
`npm run test:renderer`는 실제 Claude를 실행하지 않고 합성 이벤트로 화면·액션을 검증하고
`output/design/`에 화면 캡처를 저장한다.

확장 테마의 `unproject(x, y)`는 화면 클릭을 월드 좌표로 역변환하고,
`hitTest(x, y)`는 상호작용 가구를 선택한다. 카메라의 드래그·휠 확대는 `office/camera.js`,
내 캐릭터와 상주 캐릭터의 생활 행동은 `office/life.js`에서 처리한다.
`layout.walkBounds`·`obstacles`가 있으면 `office/navigation.js`의 격자 경로 탐색으로
가구와 구역 경계를 피한다. `interactions`는 화면에 그리는 가구와 접근 지점·액션의 공통 데이터다.
외곽 별채는 `walkways`와 방의 `door`/`doors`로 연결한다. 문 열림 정도는 `OfficeLife`에서 접근 거리와 클릭을 기준으로 계산한다.
작업 말풍선은 엔진의 `assignment`·최근 `activity`를 바탕으로 작업 중 지속 표시한다. 그림 쪽은 최대 두 줄로 배치한다.

- `ctx` 는 Canvas 2D 컨텍스트이고, **이미 배치도 논리 좌표로 변환**되어 있다. 화면 크기·고해상도(dpr)는 신경 쓰지 않아도 된다.
- `t` 는 밀리초 단위 시각(`performance.now()`)이다. 걷기 프레임·깜빡임 등 애니메이션에 쓴다.
- 그리는 순서: 배경 → 앉은 캐릭터(pose 가 `sit`·`type`·`read`·`run`, y 오름차순) → 전경 → 서 있거나 걷는 캐릭터 → 말풍선.
- `drawAgent` 등에서 예외가 나도 화면 루프는 멈추지 않는다 (콘솔에 `[office]` 로 한 번 기록). `load()` 가 실패하면 기본 테마로 돌아간다.
- 이미지 경로는 `new URL('./assets/office.png', import.meta.url)` 로 만든다 (앱은 `app://` 주소로 파일을 읽는다).

```js
import layout from './layout.js';
const img = (p) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = new URL(p, import.meta.url); });
let bg, sprites;

export default {
  id: 'pixel-office',
  name: '픽셀 오피스',
  layout,
  async load() { bg = await img('./assets/office.png'); sprites = await img('./assets/agent.png'); },
  drawBackground(ctx, L) { ctx.drawImage(bg, 0, 0, L.width, L.height); },
  drawAgent(ctx, a, t) { /* a.pose·a.facing·프레임으로 sprites 에서 잘라 그림 */ },
  drawBubble(ctx, a, b, t) { /* … */ },
};
```

등록: `themes/index.js` 의 `THEMES` 배열에 import 해서 추가한다. 선택한 테마는 다음 실행에도 유지된다.

## 2. 배치도 (`layout`)

기존 목업은 「**위 줄 방 3개 + 가운데 가로 복도 + 아래 줄 방 3개**」 동선을 사용한다.
확장 픽셀 테마는 위·아래 각 4개 구역과 가운데 복도를 사용하며, 실제 이동은 장애물 경로 탐색으로 계산한다.
배경 그림은 자유지만 이 동선과 맞아야 캐릭터가 벽을 뚫고 다니지 않는다.

```js
export default {
  width: 1200, height: 780,                 // 논리 좌표계 크기 (그림 원본 비율과 맞추면 편하다)
  hallway: { y: 380, y0: 336, y1: 424 },    // 복도 중앙선 y, 복도 위·아래 경계
  entrance: { x: 6, y: 380 },               // 출근·퇴근 지점 (복도 위)
  rooms: {
    lead:     { x, y, w, h, label, emoji, door: { x, y }, seats: [ { x, y, facing } ], wander? },
    analysis: { … }, planning: { … }, dev: { … }, review: { … }, rest: { … },
  },
};
```

| 항목 | 규칙 |
|---|---|
| 방 키 6개 | `lead`(팀장실) `analysis`(분석실) `planning`(기획실) `dev`(개발실) `review`(검토실) `rest`(휴게실) — **이름 변경 불가**, 위치·크기는 자유 |
| `door` | 방 테두리 위의 출입 지점. 위 줄 방은 아래 변, 아래 줄 방은 위 변 |
| `seats` | 캐릭터가 서는/앉는 **발 위치**. 작업 방은 책상 의자 위치. 자리가 모자라면 방 안 빈 곳에 서 있게 된다 (작업 방 6석 이상 권장) |
| `facing` | 앉았을 때 보는 방향 `'up'|'down'|'left'|'right'` |
| `wander` | (선택) `{x,y,w,h}`. 휴게실은 캐릭터가 돌아다니는 영역, 다른 방은 자리가 모자랄 때 서 있을 영역 |
| `label`·`emoji` | 엔진은 쓰지 않는다. 테마가 방 이름표에 쓰는 값 |

## 3. 캐릭터 (`drawAgent` 의 `agent`)

| 필드 | 값 | 그림에 쓰는 법 |
|---|---|---|
| `x`, `y` | 논리 좌표 | **발 위치** (그림자 중심). 몸은 위로 그린다 |
| `pose` | `walk` `stand` `sit` `type` `read` `run` `talk` `alert` | 아래 표 |
| `facing` | `up` `down` `left` `right` | 걷는 방향 / 앉아서 보는 방향 |
| `moving` | boolean | 걷는 중 |
| `isLead` | boolean | 메인 Claude (팀장). 크게·왕관 등 구분 |
| `role` | `lead` `analysis` `planning` `dev` `review` | 직군별 복장·소품 |
| `displayType` | `executor`, `Explore` … | 에이전트 종류 (색·모자 등) |
| `colorIndex` | 0~7 (팀장 -1) | 종류별 고정 색 번호 |
| `label` | `executor #2` | 명찰 글자 |
| `status` | `working` `reporting` `sharing` `resting` `away` `idle` `leaving` | 참고용 (`away` = 한가한 팀장이 휴게실에 간 상태) |
| `bubble` | `{ text, kind }` 또는 `null` | 4절 |

| pose | 언제 | 그림 예시 |
|---|---|---|
| `walk` | 이동 중 | 걷기 프레임 (facing 방향) |
| `stand` | 자리가 아닌 곳에 서 있음 (보고·공유 도착 후, 휴게실 배회) | 서 있기 |
| `sit` | 자리에 앉아 쉬는 중 (팀장 대기, 휴게실 소파) | 앉기 |
| `type` | 파일 수정·작성 | 키보드 치기 |
| `read` | 읽기·검색·웹 | 서류/화면 보기 |
| `run` | 명령 실행 | 터미널 조작, `>_` 소품 |
| `talk` | 업무 지시·메시지·잡담 | 손짓·입 모양 |
| `alert` | 사용자 확인·권한 요청 대기 | 손 들기, 느낌표 |

## 4. 말풍선 (`drawBubble`)

`bubble.text` 는 이모지 1개 + 짧은 한국어 (예: `📨 결과 공유 중...`, `⌨ 수정 중: Foo.kt`). 길면 테마가 말줄임한다.

| kind | 의미 | 목업 색 |
|---|---|---|
| `work` | 지금 하는 작업 | 흰색 |
| `info` | 출근·업무 접수·확인 | 흰색 |
| `share` | 결과 공유 중 (다른 에이전트에게 걸어가는 중) | 노랑, 테두리 깜빡임 |
| `report` | 팀장에게 보고 중 | 파랑, 테두리 깜빡임 |
| `done` | 완료·전달 완료 | 초록 |
| `alert` | 사용자 확인 필요 (사라지지 않음) | 빨강 |
| `chat` | 휴게실 잡담 | 보라 |

## 5. 하지 말 것

- `office/` 엔진 파일 수정 — 동작 규칙이 바뀌면 테스트(`npm test`)가 깨진다. 동작 변경이 필요하면 별도 요청으로.
- 테마 안에서 `window.office`(Claude 실행·설정 변경 API) 호출.
- 매 프레임 큰 이미지 새로 만들기 — 배경은 `load()` 나 첫 그리기에서 한 번 만들어 재사용 (목업 `bgCache` 참고).
- Anthropic 공식 로고·이름을 앱 이름·창 제목에 쓰기 (캐릭터 그림은 소유자 판단).

## 6. 확인 방법

1. `npm start` → 「입장하기」 → 상단 「테마」에서 새 테마 선택.
2. 탭을 열고 Claude 에게 「Explore 에이전트로 폴더 구조 보고, executor 로 README 한 줄 고쳐줘」처럼 하위 에이전트를 쓰는 요청을 한다.
3. 볼 것: 출근(입구 → 방) · 작업 자세 · 보고(팀장실) · 결과 공유(노란 말풍선으로 다른 자리까지) · 휴게실 배회·잡담 · 퇴근.
