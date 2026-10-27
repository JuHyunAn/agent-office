// 치수는 사무실 바닥 좌표 기준이다. 회전 시 이용 위치도 함께 변환한다.
export const TILE = 192;
export const GRID = 24;
export const ROLES = { lead: '팀장', analysis: '분석', planning: '기획', dev: '개발', review: '검토', skills: '스킬', rest: '휴식' };
export const CATALOG = [
  { kind: 'floor-wood', label: '오크 바닥', group: '바닥', w: TILE, d: TILE, color: '#d5b58e' },
  { kind: 'floor-mint', label: '민트 바닥', group: '바닥', w: TILE, d: TILE, color: '#a8c9b7' },
  { kind: 'floor-stone', label: '석재 바닥', group: '바닥', w: TILE, d: TILE, color: '#bbc2ce' },
  { kind: 'wall', label: '따뜻한 벽', group: '구조', w: TILE, d: 12, h: 118, color: '#d8d1bb' },
  { kind: 'wall-blue', label: '청록 벽', group: '구조', w: TILE, d: 12, h: 118, color: '#91b3b0' },
  { kind: 'window', label: '넓은 창문', group: '구조', w: TILE, d: 12, h: 118, color: '#d8d1bb' },
  { kind: 'window-grid', label: '격자 창문', group: '구조', w: TILE, d: 12, h: 118, color: '#798d9e' },
  { kind: 'window-round', label: '아치 창문', group: '구조', w: TILE, d: 12, h: 118, color: '#d6b09a' },
  { kind: 'door', label: '자동 출입문', group: '구조', w: TILE, d: 12, h: 118, color: '#92afa8' },
  { kind: 'desk', label: '업무 책상', group: '가구', w: 144, d: 72, h: 32, color: '#d7b18d', action: 'laptop' },
  { kind: 'round-table', label: '회의 테이블', group: '가구', w: 144, d: 120, h: 30, color: '#e0bc96', action: 'collaborate' },
  { kind: 'sofa', label: '라운지 소파', group: '가구', w: 144, d: 72, h: 42, color: '#75a59a', action: 'sit' },
  { kind: 'chair', label: '사무용 의자', group: '가구', w: 48, d: 48, h: 40, color: '#7999b0', action: 'sit' },
  { kind: 'bookshelf', label: '낮은 책장', group: '가구', w: 96, d: 48, h: 64, color: '#b88c6c', action: 'read' },
  { kind: 'coffee', label: '커피 머신', group: '생활', w: 96, d: 72, h: 62, color: '#ba9d83', action: 'brew', menu: 'coffee' },
  { kind: 'vending', label: '음료 자판기', group: '생활', w: 72, d: 72, h: 95, color: '#d78d7f', action: 'drink' },
  { kind: 'arcade', label: '게임기', group: '생활', w: 72, d: 72, h: 80, color: '#9a8cb9', action: 'arcade' },
  { kind: 'plant', label: '큰 화분', group: '장식', w: 48, d: 48, h: 60, color: '#8cae74', action: 'water' },
  { kind: 'lamp', label: '플로어 조명', group: '장식', w: 48, d: 48, h: 90, color: '#e2c481' },
  { kind: 'rug', label: '보라 러그', group: '장식', w: 192, d: 144, h: 1, color: '#b7a1c2', walkable: true },
  { kind: 'mat', label: '요가 매트', group: '생활', w: 96, d: 72, h: 1, color: '#8bafbf', action: 'stretch', walkable: true },
  { kind: 'entry', label: '출입 위치', group: '생활', w: 48, d: 48, h: 2, color: '#e6bf76', walkable: true },
];
export const MATERIALS = Object.fromEntries(CATALOG.map(m => [m.kind, m]));
export const isFloor = item => MATERIALS[item.kind]?.group === '바닥';
export const isWall = item => MATERIALS[item.kind]?.group === '구조';
