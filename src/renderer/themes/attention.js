// 「확인 필요」 말풍선 배경: 1.4초마다 강조색 쪽으로 최대 35% 짙어졌다 돌아온다.
// 사무실은 정지 화면에서 초당 15번만 그리므로 켜고 끄는 깜빡임 대신 부드러운 파형을 쓴다. 색은 '#rrggbb'.
export function attentionFill(base, accent, t) {
  const k = 0.35 * (0.5 - 0.5 * Math.cos(((t % 1400) / 1400) * Math.PI * 2));
  const ch = (s, i) => parseInt(s.slice(i, i + 2), 16);
  return '#' + [1, 3, 5].map((i) => Math.round(ch(base, i) + (ch(accent, i) - ch(base, i)) * k).toString(16).padStart(2, '0')).join('');
}
