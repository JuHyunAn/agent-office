# loop: 장시간 실행 안정성·효율 개선 A, C~G

## 시작 스냅샷 (2026-10-28, HEAD 1091114)
```
## main...origin/main
 M .omc/... (상태 파일)
 M src/renderer/collab/panel.js   ← B(메시지 접기), 루프 전 구현·검증 완료
 M src/renderer/styles.css        ← B(.collab-more 스타일)
```

## 범위
A 테마 전환 시 픽셀 오피스 캔버스 해제 · C 정적 부분 미리 합성 · D 창문 그라데이션 재사용
E hitTest/hit 정렬 캐시 · F custom draw 필터 캐시 · G mockup/theme.js 삭제
(D-002 테마 담당 분리는 사용자가 이번 범위로 테마 파일을 명시해 예외 적용)

## 변경·생성 파일
- src/renderer/office/view.js (unmount 에 다음 테마 전달)
- src/renderer/themes/pixel-office/theme.js (releaseCaches, unmount(next), HIT_ORDER)
- src/renderer/themes/pixel-office/atmosphere.js (release)
- src/renderer/themes/pixel-office/exterior.js (release)
- src/renderer/themes/mockup/theme.js (삭제)
- THEME.md (mockup 설명, unmount(next) 행, floorCache 참고, 예시 색)
- 임시 검증(scratchpad): check-collab-fold.cjs, check-theme-release.cjs

## 판단
반영: A(unmount(next) 방식 — ref-count 는 start 전 setTheme 에서 오해제 위험으로 기각), E(픽셀), G
보류: C(실익 ≤1~2ms, +25.6MB, 키 누락 위험), D(<0.1ms), E(커스텀)·F(수십 µs, F 는 그리기 순서 위험)

## 검증 (LOOP 1)
npm test 135/135 · test:renderer exit 0 ×2 · test:custom exit 0 · check-theme-release OK · check-collab-fold OK

## LOOP 2 (완료 리뷰 Minor 보완)
- panel.js: 펼칠 때 새 메시지만 끼워 넣고 읽던 위치 유지, 포커스 유지, 문구 변경 시만 갱신, 펼친 직후 맨 아래로 튀지 않게
- view.js: setTheme 마지막 요청만 반영(밀려난 요청 false, 실패도 무시) / app.js: false 면 저장 안 함
- styles.css: .collab-log 포커스 표시(키보드일 때만)
- THEME.md: unmount(next) 호출 순서·공유 자원 주의
검증: npm test 135/135 · test:renderer exit 0 · test:custom exit 0 · check-collab-fold OK · check-theme-release OK(경쟁 포함)
7단계 simplify 생략: 변경량 작고 리뷰 2회에서 단순화 지적 없음
결정대장: D-017~D-020 등재
