// 에이전트 종류(agent_type) → 근무 방. 그림(테마)과 무관한 규칙이라 엔진 쪽에 둔다.

export const ROOM_KEYS = ['lead', 'analysis', 'planning', 'dev', 'review', 'rest'];

export const ROOM_LABELS = {
  lead: '팀장실',
  analysis: '분석실',
  planning: '기획실',
  dev: '개발실',
  review: '검토실',
  rest: '휴게실',
};

// "oh-my-claudecode:executor" → "executor"
export function displayType(type) {
  const s = String(type ?? '').trim();
  if (!s) return '';
  const i = s.lastIndexOf(':');
  return i >= 0 ? s.slice(i + 1) : s;
}

// 위에서부터 먼저 맞는 규칙을 쓴다. 어디에도 안 맞으면 개발실.
const RULES = [
  ['review', /(review|verif|cross-?check|critic|qa-?test|security|audit)/i],
  ['planning', /(plan|architect)/i],
  ['analysis', /(explore|analy|tracer|scientist|research|specialist|guide|search|debug|investig)/i],
];

export function roleOf(type, overrides = {}) {
  const d = displayType(type);
  if (overrides[d]) return overrides[d];
  for (const [role, re] of RULES) if (re.test(d)) return role;
  return 'dev';
}
