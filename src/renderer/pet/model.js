// 펫 화면의 순수 규칙 (DOM 에 기대지 않아 테스트할 수 있다).

// Codex 펫 형식(openai/skills hatch-pet): 버전 1 = 1536x1872 (8열 x 9행), 버전 2 = 1536x2288 (8열 x 11행, 9·10행은 커서를 바라보는 16방향), 칸 192x208.
// 행마다 쓰는 칸 수와 칸별 시간(ms).
export const CELL = { width: 192, height: 208 };
export const SHEETS = { 1: { width: 1536, height: 1872 }, 2: { width: 1536, height: 2288 } };
export const SHEET = SHEETS[1]; // 버전 1 (예전 이름)
export const ROWS = {
  idle: { row: 0, ms: [280, 110, 110, 140, 140, 320] },
  'running-right': { row: 1, ms: [120, 120, 120, 120, 120, 120, 120, 220] },
  'running-left': { row: 2, ms: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving: { row: 3, ms: [140, 140, 140, 280] },
  jumping: { row: 4, ms: [140, 140, 140, 140, 280] },
  failed: { row: 5, ms: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, ms: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, ms: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, ms: [150, 150, 150, 150, 150, 280] },
  // 앱 전용 자는 동작: 시트 줄이 아니라 pet.json 의 agentOffice.sleepSheetPath (1536x208, 8열 x 1행) 에서 앞 6칸만 쓴다.
  sleeping: { row: null, ms: [320, 320, 320, 320, 320, 600] },
};
export const SLEEP_SHEET = { width: 1536, height: 208 };
export const SLEEP_AFTER_MS = 5 * 60000; // 작업·알림 없이 이만큼 가만히 있으면 잔다

// 커서를 바라보는 칸 (Codex 와 같은 계산): dx, dy = 커서 − 펫 중심 (화면 픽셀, y 는 아래로 +). 중심 1px 이내면 null.
// 위쪽이 0°, 시계 방향으로 22.5° 마다 한 칸 (16방향) — 9행(0~7칸) 과 10행(8~15번째) 에 이어 놓여 있다.
export function gazeCell(dx, dy) {
  if (Math.hypot(dx, dy) <= 1) return null;
  const a = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
  const o = Math.round(a / 22.5) % 16;
  return { row: 9 + Math.floor(o / 8), col: o % 8 };
}

// 보일 펫: 상시 → Claude(+ Codex 가 설치돼 있으면 Codex), 알림만 → 알림이 있는 종류만. 끄기 → 없음.
// 협업 대화가 진행 중이면 모드와 상관없이(끄기 제외) 둘 다 — Claude 왼쪽 · Codex 오른쪽.
export function visiblePets({ mode, codex, kinds = {}, collab = null } = {}) {
  if (mode === 'off') return [];
  if (collab?.active) return ['claude', 'codex'];
  if (mode === 'alerts') return ['claude', 'codex'].filter((k) => (kinds[k]?.attention || []).length > 0);
  return codex ? ['claude', 'codex'] : ['claude'];
}

// 상태: 드래그 중이 가장 먼저(방향), 그다음 오류 > 확인 대기 > 완료 > 협업 대화(말하는 쪽 running · 듣는 쪽 review, 말하는 쪽이 없으면 직전에 말한 쪽) > 작업 중 > 5분 넘게 가만히(sleeping) > 대기.
// idleFor: 이 펫이 대기 상태로 이어진 시간(ms). kind·collab: 이 펫의 종류와 협업 대화 정보.
export function petState(kindState = {}, drag = null, { idleFor = 0, collab = null, kind = null } = {}) {
  if (drag) return drag === 'left' ? 'running-left' : 'running-right';
  const list = kindState.attention || [];
  if (list.some((x) => x.reason === 'collab-error')) return 'failed';
  if (list.some((x) => x.kind === 'alert')) return 'waiting';
  if (list.some((x) => x.kind === 'done')) return 'waving';
  if (collab?.active) return kind === (collab.speaker ?? collab.prev) ? 'running' : 'review'; // 차례 사이(speaker 없음)에는 방금 말한 쪽이 계속 말하는 것으로
  if (kindState.working) return 'running';
  return idleFor >= SLEEP_AFTER_MS ? 'sleeping' : 'idle';
}

// 카드로 허용·거부할 수 있는 도구와 그 도구의 실제 실행 필드 (main/petRules.cjs 의 cardPreview 와 같은 규칙 — 두 벌이라 test/pet.test.js 가 같은 입력 표로 맞춰 본다).
const CARD_FIELDS = {
  Bash: 'command', PowerShell: 'command', Read: 'file_path', WebFetch: 'url', WebSearch: 'query', LS: 'path',
};
// 도구별 허용 입력 키: input 에 이 밖의 키가 하나라도 있으면 안내만 한다.
const CARD_KEYS = {
  Bash: ['command', 'description', 'timeout', 'run_in_background'],
  PowerShell: ['command', 'description', 'timeout', 'run_in_background'],
  Read: ['file_path', 'offset', 'limit'],
  LS: ['path'],
  WebFetch: ['url', 'prompt'],
  WebSearch: ['query'],
};
const CARD_MAX_LEN = 160;
const CARD_MAX_BREAKS = 3;
const CARD_BREAK_RE = /\r\n|[\r\n\u2028\u2029\u0085]/g; // 줄 구분: CRLF, CR, LF, LS, PS, NEL
const CARD_HIDDEN_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/; // 제어·양방향·폭 0 문자 (보이는 글과 실제 값이 달라 보일 수 있다)

// 카드에 보여 줄 승인 대상 문자열. 카드로 답할 수 없으면 null: 허용 목록 밖 도구 · 허용 밖 입력 키 · 문자열이 아님/빔 · '…' 로 끝남(잘림) · 160자 초과 · 줄바꿈 3개 초과 · 제어 문자.
export function cardPreview(tool, input) {
  if (typeof tool !== 'string' || !Object.hasOwn(CARD_FIELDS, tool) || !input || typeof input !== 'object') return null;
  if (Object.keys(input).some((k) => !CARD_KEYS[tool].includes(k))) return null;
  const v = input[CARD_FIELDS[tool]];
  if (typeof v !== 'string' || v.trim() === '' || v.endsWith('…') || v.length > CARD_MAX_LEN) return null;
  if ((v.match(CARD_BREAK_RE) || []).length > CARD_MAX_BREAKS || CARD_HIDDEN_RE.test(v)) return null;
  return v;
}

// 버튼을 보여 줄 수 있는 항목: 메인이 답할 수 있다고 했고 permId 가 있으며, 미리보기가 그 도구의 실행 필드 전체로서 규칙(cardPreview)을 지킬 때만 (한 번 더 확인).
function answerableItem(x) {
  if (!x.canAnswer || !x.permId || typeof x.preview !== 'string' || !Object.hasOwn(CARD_FIELDS, x.tool)) return false;
  return cardPreview(x.tool, { [CARD_FIELDS[x.tool]]: x.preview }) === x.preview;
}

// 권한 요청 카드: reason 이 permission 인 항목 가운데 카드로 답할 수 있는(canAnswer) 것이 있으면 그중 가장 오래된 것(새 요청이 와도 카드가 바뀌지 않게),
// 없으면 가장 최근 것. more 는 나머지 권한 요청 수. 권한 요청이 없으면 null. key·tabId 는 그 항목의 탭 (카드 클릭이 연다).
export function cardOf(kindState = {}) {
  const perms = (kindState.attention || []).filter((x) => x.reason === 'permission');
  if (!perms.length) return null;
  const answerable = perms.filter(answerableItem);
  const pick = answerable.length
    ? answerable.reduce((a, b) => (b.at < a.at ? b : a))
    : perms.reduce((a, b) => (b.at >= a.at ? b : a));
  return {
    permId: pick.permId || null, tool: pick.tool || '', preview: pick.preview || '', canAnswer: answerableItem(pick),
    label: pick.label || '', key: pick.key || null, tabId: pick.tabId || null, more: perms.length - 1,
  };
}

// ───────────────────────── 사용량 패널 ─────────────────────────

const MIN_MS = 60000;
const DAY_MS = 24 * 60 * MIN_MS;
const RESET_AT_FORMAT = new Intl.DateTimeFormat('ko-KR', { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true });

// 24시간 안에 리셋: 「리셋 2시간 13분 후」「리셋 13분 후」「곧 리셋」(1분 미만).
function formatResetIn(ms) {
  if (ms < MIN_MS) return '곧 리셋';
  const h = Math.floor(ms / (60 * MIN_MS));
  const m = Math.floor((ms % (60 * MIN_MS)) / MIN_MS);
  return `리셋 ${h ? `${h}시간 ` : ''}${m ? `${m}분 ` : ''}후`;
}

// 24시간 넘게 남은 리셋: 「(토) 오전 7:00 재설정」.
const formatResetAt = (at) => `${RESET_AT_FORMAT.format(at)} 재설정`;

// 사용량 한 줄의 글: pct = 「58% 사용」「리셋됨」「알 수 없음」, reset = 재설정 문구 (없으면 빈 글).
// 리셋 시각이 지났으면 (패널을 다시 읽기 전이라도) 값은 이미 지난 창의 것이라 「리셋됨」으로 본다.
export function usageRowText(row, now) {
  const at = Number.isFinite(row?.resetsAt) ? row.resetsAt : null;
  const gone = at !== null && at <= now;
  let reset = '';
  if (gone) reset = '리셋됨';
  else if (at !== null) reset = at - now <= DAY_MS ? formatResetIn(at - now) : formatResetAt(at);
  else if (typeof row?.resetsText === 'string' && row.resetsText) reset = `${row.resetsText} 재설정`;
  let pct = '알 수 없음';
  if (gone) pct = '리셋됨';
  else if (Number.isFinite(row?.percent)) pct = `${row.percent}% 사용`;
  return { pct, reset };
}

// 「방금 갱신」「n분 전 갱신」「n시간 전 갱신」「갱신 전」.
export function updatedText(updatedAt, now) {
  if (!Number.isFinite(updatedAt)) return '갱신 전';
  const diff = Math.max(0, now - updatedAt);
  if (diff < MIN_MS) return '방금 갱신';
  if (diff < 60 * MIN_MS) return `${Math.floor(diff / MIN_MS)}분 전 갱신`;
  return `${Math.floor(diff / (60 * MIN_MS))}시간 전 갱신`;
}

// ⟳ 버튼: 읽는 중이거나 다음 허용 시각 전이면 막고, 이유를 title 로 알린다.
export function refreshButton(refresh, now) {
  if (refresh?.busy) return { disabled: true, title: '사용량을 읽는 중이에요' };
  if (Number.isFinite(refresh?.nextAllowedAt) && now < refresh.nextAllowedAt) {
    return { disabled: true, title: `${Math.ceil((refresh.nextAllowedAt - now) / MIN_MS)}분 뒤 다시 갱신할 수 있어요` };
  }
  return { disabled: false, title: '사용량 다시 읽기' };
}

// 세션 줄 「{label} · 요청 {n}회 · 컨텍스트 {p}%」 (컨텍스트를 모르면 '—').
export function sessionText(s) {
  return `${s.label} · 요청 ${s.requests}회 · 컨텍스트 ${Number.isFinite(s.contextPercent) ? `${s.contextPercent}%` : '—'}`;
}

// 말풍선: 가장 최근 알림의 「문구 · 탭 이름」, 없으면 null.
export function bubbleOf(kindState = {}) {
  const x = (kindState.attention || []).at(-1);
  return x ? { text: x.label ? `${x.text} · ${x.label}` : x.text, key: x.key, tabId: x.tabId } : null;
}
