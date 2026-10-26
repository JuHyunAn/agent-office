const rooms = {};
const cols = [32, 552, 1072, 1592];
const definitions = [
  ['analysis', '리서치 라이브러리', 0, true], ['planning', '아이디어 스튜디오', 1, true],
  ['lead', '팀장실', 2, true], ['skills', '스킬 스튜디오', 3, true],
  ['dev', '개발실', 0, false], ['review', '리뷰 랩', 1, false],
  ['rest', '그린 라운지', 2, false], ['cafe', '카페 & 플레이', 3, false],
];
for (const [key, label, col, top] of definitions) {
  const x = cols[col], y = top ? 64 : 648, h = top ? 440 : 552;
  rooms[key] = {
    key, label, x, y, w: 496, h,
    door: { x: x + 248, y: top ? y + h : y },
    seats: [],
    wander: { x: x + 40, y: y + 100, w: 410, h: h - 170 },
  };
}
// Furniture coordinates below are local to each room; navigation and lighting
// consume these same footprints after conversion to world coordinates.
const workTables = [
  ['analysis', 'reading', 48, 190, 120, 78, [[108, 170]]],
  ['analysis', 'reading', 278, 190, 120, 78, [[338, 170]]],
  ['analysis', 'reading', 48, 328, 120, 78, [[108, 308]]],
  ['planning', 'collaboration', 56, 240, 384, 116, [[112, 220], [248, 220], [384, 220]]],
  ['lead', 'director', 242, 212, 188, 96, [[326, 192]]],
  ['dev', 'engineering', 44, 178, 272, 96, [[104, 158], [248, 158]]],
  ['dev', 'engineering', 102, 382, 300, 90, [[160, 362], [344, 362]]],
  ['review', 'review', 54, 230, 320, 106, [[116, 210], [284, 210]]],
  ['skills', 'workshop', 52, 190, 272, 96, [[110, 170], [258, 170]]],
  ['skills', 'workshop', 122, 324, 272, 70, [[180, 304], [328, 304]]],
].map(([room, kind, x, y, w, d, seats]) => {
  const r = rooms[room];
  const positions = seats.map(([sx, sy]) => ({ x: r.x + sx, y: r.y + sy, facing: 'down' }));
  r.seats.push(...positions);
  return { room, kind, x: r.x + x, y: r.y + y, w, d, seats: positions };
});
const furnishings = [
  ['analysis', 'bookcase', 26, 32, 100, 30], ['analysis', 'bookcase', 164, 32, 100, 30],
  ['analysis', 'bookcase', 308, 32, 100, 30], ['analysis', 'sofa', 286, 322, 175, 64],
  ['analysis', 'sideTable', 225, 354, 42, 42],
  ['planning', 'ideaBoard', 76, 42, 320, 12],
  ['planning', 'beanbag', 48, 378, 54, 50], ['planning', 'beanbag', 390, 378, 58, 50],
  ['lead', 'bookcase', 28, 32, 100, 30], ['lead', 'returnDesk', 376, 308, 54, 70],
  ['lead', 'roundTable', 52, 302, 136, 112],
  ['dev', 'server', 28, 36, 60, 35], ['dev', 'server', 112, 36, 60, 35],
  ['dev', 'toolShelf', 328, 42, 118, 32],
  ['review', 'ideaBoard', 34, 40, 250, 12], ['review', 'display', 340, 90, 104, 70],
  ['review', 'roundTable', 72, 400, 126, 110], ['review', 'beanbag', 360, 430, 68, 58],
  ['skills', 'ideaBoard', 34, 40, 230, 12], ['skills', 'toolShelf', 362, 132, 86, 48],
  ['skills', 'prototype', 390, 232, 60, 68],
].map(([room, kind, x, y, w, d]) => ({ room, kind, x: rooms[room].x + x, y: rooms[room].y + y, w, d }));
rooms.rest.seats = [
  ...[80, 130, 180].map(dx => ({ x: rooms.rest.x + dx, y: 1018, facing: 'down' })),
  ...[320, 370, 420].map(dx => ({ x: rooms.rest.x + dx, y: 1100, facing: 'down' })),
];
// Two detached wings and short bridges make a U-shaped campus around an open court.
rooms.ceo = { key: 'ceo', label: '대표실', x: 32, y: 1360, w: 672, h: 440,
  door: { x: 280, y: 1360 }, seats: [], wander: { x: 80, y: 1420, w: 560, h: 320 } };
rooms.restroom = { key: 'restroom', label: '화장실', x: 1592, y: 1360, w: 496, h: 400,
  door: { x: 1840, y: 1360 }, seats: [], wander: { x: 1640, y: 1410, w: 400, h: 300 } };
rooms.dev.doors = [rooms.dev.door, { x: 280, y: 1200 }];
rooms.cafe.doors = [rooms.cafe.door, { x: 1840, y: 1200 }];

const interactions = [
  { id: 'vending', label: '음료 자판기', room: 'cafe', x: 1950, y: 700, w: 90, d: 56, height: 68, stand: { x: 1994, y: 800 }, action: 'drink', description: '클릭하면 다가가 시원한 음료를 마셔요.' },
  { id: 'laptop', label: '내 노트북', room: 'cafe', x: 1730, y: 940, w: 112, d: 72, height: 22, stand: { x: 1780, y: 918 }, action: 'laptop', description: '클릭하면 노트북을 펴고 잠시 작업해요.' },
  { id: 'sofa', label: '라운지 소파', room: 'rest', x: 1112, y: 982, w: 190, d: 78, height: 26, stand: { x: 1202, y: 1084 }, seat: { x: 1202, y: 1018 }, action: 'sit', description: '클릭하면 소파에 앉아 편하게 쉬어요.' },
  { id: 'coffee', label: '커피 바', room: 'cafe', x: 1632, y: 706, w: 150, d: 54, height: 48, stand: { x: 1700, y: 812 }, action: 'drink', description: '따뜻한 커피 한 잔으로 쉬어 가세요.' },
  { id: 'ceo-door', label: '대표실 출입문', room: 'ceo', x: 220, y: 1356, w: 120, d: 8, height: 70,
    stand: { x: 280, y: 1420 }, action: 'visit', door: true, description: '클릭하면 문을 열고 별채 대표실로 들어가요.' },
  { id: 'restroom-door', label: '화장실 출입문', room: 'restroom', x: 1780, y: 1356, w: 120, d: 8, height: 70,
    stand: { x: 1840, y: 1420 }, action: 'visit', door: true, description: '클릭하면 문을 열고 화장실로 들어가요.' },
  { id: 'lounge-coffee', label: '라운지 커피 머신', room: 'rest', x: 1320, y: 710, w: 140, d: 48, height: 48,
    stand: { x: 1388, y: 800 }, action: 'brew', menu: 'coffee', description: '다가가 커피를 골라 보세요. 받은 컵은 45초 동안 들고 다녀요.' },
  { id: 'arcade', label: '픽셀 아케이드', room: 'cafe', x: 1980, y: 1070, w: 58, d: 48, height: 59,
    stand: { x: 1930, y: 1120 }, action: 'arcade', description: '잠깐 게임을 즐기고 오늘의 최고 점수에 도전해요.' },
  { id: 'plant', label: '라운지 초록 친구', room: 'rest', x: 1470, y: 738, w: 40, d: 36, height: 48,
    stand: { x: 1476, y: 816 }, action: 'water', description: '물을 주면 반짝반짝, 작은 정원을 가꿔요.' },
  { id: 'reading', label: '라운지 책장', room: 'rest', x: 1132, y: 768, w: 100, d: 30, height: 39,
    stand: { x: 1180, y: 846 }, action: 'read', description: '책 한 권을 꺼내 잠깐 읽어 봐요.' },
  { id: 'stretch', label: '스트레칭 매트', room: 'rest', x: 1430, y: 870, w: 90, d: 70, height: 1, walkable: true,
    stand: { x: 1475, y: 905 }, action: 'stretch', description: '기지개를 켜고 잠시 몸을 풀어요.' },
];
const obstacles = [];
for (const item of [...workTables, ...furnishings]) obstacles.push({ x: item.x, y: item.y, w: item.w, h: item.d });
for (const item of interactions) if (!item.door && !item.walkable) obstacles.push({ x: item.x, y: item.y, w: item.w, h: item.d });
obstacles.push({ x: 1360, y: 1064, w: 190, h: 78 });
obstacles.push({ x: 1258, y: 900, w: 92, h: 76 }, { x: 1620, y: 1100, w: 58, h: 48 });
obstacles.push({ x: 400, y: 1480, w: 220, h: 100 }, { x: 74, y: 1650, w: 190, h: 70 },
  { x: 1640, y: 1536, w: 105, h: 160 }, { x: 1960, y: 1480, w: 78, h: 220 });

export default {
  width: 2144, height: 1860,
  hallway: { y: 576, y0: 504, y1: 648 },
  entrance: { x: 24, y: 576 },
  walkBounds: { x: 24, y: 64, w: 2072, h: 1748 },
  walkways: [{ x: 216, y: 1188, w: 128, h: 188 }, { x: 1776, y: 1188, w: 128, h: 188 }],
  playerStart: { x: 1390, y: 896 },
  rooms, workTables, furnishings, interactions, obstacles,
};
