// Git 패널의 순수 로직: 경로 변환·스테이징 대상·에이전트 수정 표시·지문·안내 글·그래프 줄 표시.
// 화면(DOM)·IPC 와 무관해서 화면 없이 테스트할 수 있다. 경로는 모두 저장소 루트 기준(「/」 구분)이다.

// 저장소 기준 경로 → 열린 폴더 기준 경로. 열린 폴더(prefix, 예: 'sub/') 밖이거나 폴더 자신이면 null.
// prefix 비교만 대소문자를 무시하고 결과는 원래 표기를 그대로 둔다.
export function toLocal(p, prefix) {
  if (typeof p !== 'string' || !p) return null;
  const pre = typeof prefix === 'string' ? prefix : '';
  if (pre && p.slice(0, pre.length).toLowerCase() !== pre.toLowerCase()) return null;
  const rest = p.slice(pre.length);
  return rest || null;
}

// 커밋 요청에 실어 보낼 「화면이 본 스테이징 목록」: 경로와 이름 변경 전 경로 전부.
export function expectedPaths(staged) {
  return (Array.isArray(staged) ? staged : []).flatMap((s) => (s.orig ? [s.path, s.orig] : [s.path]));
}

// 스테이징할 수 있는 변경의 경로 (서브모듈 내용만 더러운 항목은 뺀다). 이름 변경이면 옛 경로도 함께.
export function stageablePaths(changes) {
  return (Array.isArray(changes) ? changes : []).filter((c) => c.stageable !== false).flatMap((c) => (c.orig ? [c.path, c.orig] : [c.path]));
}

// 목록이 길 때 max 줄까지만 보이고 나머지 개수를 알려 준다 (원본 배열은 건드리지 않는다).
export function capList(list, max) {
  const all = Array.isArray(list) ? list : [];
  return { shown: all.slice(0, max), more: Math.max(0, all.length - max) };
}

// 에이전트가 windowMs 안에 수정한 파일의 저장소 기준 소문자 경로 Set (editAt = 마지막 수정 시각). items 의 rel 은 열린 폴더 기준이라 prefix 를 붙인다.
export function recentEditSet(items, prefix, now, windowMs = 60000) {
  const out = new Set();
  const pre = typeof prefix === 'string' ? prefix : '';
  for (const it of Array.isArray(items) ? items : []) {
    if (it && typeof it.editAt === 'number' && now - it.editAt < windowMs) out.add(`${pre}${it.rel}`.toLowerCase());
  }
  return out;
}

// 화면에 보이는 값의 지문: 같으면 목록을 다시 그리지 않는다. marks(에이전트 표시 경로)는 순서와 무관하다.
export function gitFingerprint(gs, marks) {
  const g = gs || {};
  return JSON.stringify([g.branch, g.detached, g.ahead, g.behind, g.upstream, g.hasRemote, g.canWrite, g.reason, g.prefix,
    g.staged, g.changes, g.conflicts, [...(marks || [])].sort()]);
}

// 「↑2 ↓1」: 0·null 은 표시하지 않는다.
export function aheadBehindText(gs) {
  const parts = [];
  if (gs && gs.ahead > 0) parts.push(`↑${gs.ahead}`);
  if (gs && gs.behind > 0) parts.push(`↓${gs.behind}`);
  return parts.join(' ');
}

// 쓰기를 막은 이유의 안내 글 (막지 않았으면 null).
export function reasonText(gs) {
  switch (gs && gs.reason) {
    case 'not-main': return `main 브랜치에서만 커밋·푸시합니다. (현재: ${gs.branch})\n다른 작업은 아래 터미널에서`;
    case 'detached': return '분리된 HEAD 입니다.\n터미널에서 main 으로 전환해 주세요.';
    case 'merging': return '병합 등 다른 git 작업이 진행 중입니다.\n터미널에서 마무리해 주세요.';
    default: return null;
  }
}

// Commit & Sync 를 동기화만으로 쓰는 경우: 커밋이 불가능하고(스테이징 없음 + 메시지가 비었거나 올릴 변경 없음) 주고받을 커밋이 있다.
// 스테이징이 있으면 커밋하려는 것이므로 이 경우가 아니다. 스테이징하지 않은 파일은 그대로 둔다.
export function canSyncOnly(gs, message) {
  if (!gs || !gs.canWrite || !gs.hasRemote || gs.staged.length) return false;
  if (String(message ?? '').trim() && stageablePaths(gs.changes).length) return false;
  return gs.ahead > 0 || gs.behind > 0;
}

// 그래프 줄의 ref 칩. git 의 %D 조각(「HEAD -> main」「origin/main」「tag: v1」)을 { label, kind, current } 로 바꾼다.
// kind: local · remote(origin/) · tag · head(분리된 HEAD). origin/HEAD 는 군더더기라 뺀다.
export function refChips(refs) {
  const out = [];
  for (const raw of Array.isArray(refs) ? refs : []) {
    const r = String(raw).trim();
    if (!r) continue;
    if (r.startsWith('tag: ')) out.push({ label: r.slice(5), kind: 'tag', current: false });
    else if (r.startsWith('HEAD -> ')) out.push({ label: r.slice(8), kind: 'local', current: true });
    else if (r === 'HEAD') out.push({ label: 'HEAD', kind: 'head', current: true });
    else if (!r.endsWith('/HEAD')) out.push({ label: r, kind: r.startsWith('origin/') ? 'remote' : 'local', current: false });
  }
  return out;
}

// 커밋 시각 표시 (지역 시간): 오늘이면 HH:MM, 아니면 YYYY-MM-DD. 시각이 올바르지 않으면 빈 글자.
export function logTime(at, now) {
  const d = new Date(at);
  if (typeof at !== 'number' || Number.isNaN(d.getTime())) return '';
  const p2 = (n) => String(n).padStart(2, '0');
  const today = new Date(now);
  if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()) return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

// 그래프를 다시 받아야 하는지 가르는 키: 커밋 위치·원격 연결·앞섬/뒤처짐이 바뀌었을 때만 달라진다 (파일 변경은 무관).
export function logKey(gs) {
  const g = gs || {};
  return JSON.stringify([g.oid ?? null, g.upstream ?? null, g.ahead ?? null, g.behind ?? null]);
}

const LOGIN_HINT_KINDS = new Set(['push', 'sync', 'fetch', 'pull', 'pushOnly', 'syncOnly']);
const LOGIN_HINT_MS = 4000;
// 네트워크 작업이 잠시 이어지면 로그인 창을 기다리는 중일 수 있다 (창이 앱 뒤에 뜰 수 있음). 메인은 창이 떴는지 모르므로 경과로만 판단한다.
export function loginHint(kind, elapsedMs) {
  return LOGIN_HINT_KINDS.has(kind) && elapsedMs >= LOGIN_HINT_MS ? '로그인 창에서 로그인을 진행하세요.\n로그인 창이 안 보이면 작업 표시줄을 확인하세요.' : '';
}
