// 목업 테마 배치도 (논리 좌표 1200×780). 계약은 THEME.md 「배치도」 절 참조.

const TOP_Y = 36;
const TOP_H = 300;
const HALL_Y0 = TOP_Y + TOP_H; // 336
const HALL_Y1 = 424;
const BOT_H = 340;
const COLS = [16, 408, 800];
const W = 384;

function workSeats(x, y, rowsY) {
  const seats = [];
  for (const ry of rowsY) for (const dx of [82, 192, 302]) seats.push({ x: x + dx, y: y + ry, facing: 'down' });
  return seats;
}

function room(key, label, emoji, col, top) {
  const x = COLS[col];
  const y = top ? TOP_Y : HALL_Y1;
  const h = top ? TOP_H : BOT_H;
  return {
    key, label, emoji, x, y, w: W, h,
    door: { x: x + W / 2, y: top ? y + h : y },
  };
}

const analysis = { ...room('analysis', '분석실', '🔍', 0, true) };
analysis.seats = workSeats(analysis.x, analysis.y, [118, 222]);

const planning = { ...room('planning', '기획실', '📝', 1, true) };
planning.seats = workSeats(planning.x, planning.y, [118, 222]);

const lead = { ...room('lead', '팀장실', '⭐', 2, true) };
lead.seats = [92, 192, 292].map((dx) => ({ x: lead.x + dx, y: lead.y + 112, facing: 'down' }));
lead.wander = { x: lead.x + 40, y: lead.y + 170, w: W - 80, h: 90 };

const dev = { ...room('dev', '개발실', '💻', 0, false) };
dev.seats = workSeats(dev.x, dev.y, [122, 246]);

const review = { ...room('review', '검토실', '✅', 1, false) };
review.seats = workSeats(review.x, review.y, [122, 246]);

const rest = { ...room('rest', '휴게실', '☕', 2, false) };
rest.seats = [
  ...[70, 120, 170, 220].map((dx) => ({ x: rest.x + dx, y: rest.y + 286, facing: 'up' })),
  { x: rest.x + 300, y: rest.y + 150, facing: 'left' },
  { x: rest.x + 300, y: rest.y + 210, facing: 'left' },
];
rest.wander = { x: rest.x + 40, y: rest.y + 90, w: 210, h: 150 };

export default {
  width: 1200,
  height: 780,
  hallway: { y: (HALL_Y0 + HALL_Y1) / 2, y0: HALL_Y0, y1: HALL_Y1 },
  entrance: { x: 6, y: (HALL_Y0 + HALL_Y1) / 2 },
  rooms: { analysis, planning, lead, dev, review, rest },
};
