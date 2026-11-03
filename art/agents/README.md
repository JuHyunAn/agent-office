# 승인된 캐릭터 원본

- `grok.png`: 검은 구체와 흰 눈, 팔다리 없는 탄성 움직임.
- `muse.png`: 크림색 인형, 업무·검토 자세에서만 헤드셋.
- `antigravity.png`: 제미나이 외형. 실제 에이전트 식별자는 `antigravity` 유지.

사용자 승인 시안의 투명 배경 원본이며, 기본 이미지 생성 도구로 제작했다.
각 이미지에는 대기·눈 깜빡임·좌우 이동·인사·점프·업무·검토·대기 확인·오류·수면·기상 대표 자세 12개가 있다.

`node scripts/build-agent-sprites.cjs`는 대표 자세를 정렬하고 발·팔·몸통의 부분 변형과 탄성·호흡을 미리 렌더링한다.
결과는 `src/renderer/assets/pets/office-{grok,muse,antigravity}/`에 저장된다.
기본 9동작 57프레임, 별도 수면 6프레임, 사무실용 대표 자세 시트로 구성된다. 63장을 각각 새로 그린 방식은 아니다.
바탕화면은 이 전용 그림을 사용한다. 사무실은 `companion-sprite.js`에서 기존 Claude·Codex와 같은 정수 도트·제한 색상으로 별도로 그린다.
프레임 재생 중 이미지 생성이나 네트워크 요청은 없다.

`node scripts/check-agent-art.cjs`로 전체 프레임의 잘림·움직임 유무, 모든 테마의 캐릭터 표시, 실제 펫 상태 전환·캐시 재사용을 검사한다.
확인 화면과 측정 결과는 `output/design/agent-applied-20261102/`에 저장된다.
