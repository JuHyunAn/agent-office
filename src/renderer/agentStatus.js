// AI 연결 상태를 화면용 목록으로 바꾸는 순수 함수 (DOM·IPC 없음 — 테스트가 직접 부른다).
import { AGENTS, agentById } from '../shared/agents.js';
import { t } from '../shared/i18n.js';

// 메인 status 에서 AI 별 상태를 꺼낸다. st.agents 가 있으면 그것을, 없으면 옛 키(claude·codex·auth·codexAuth)를 쓴다.
// 반환: AGENTS 순서의 [{ id, def, found, version, path, auth, state }] — state: missing(미설치) · connected · error · login(로그인 필요)
export function agentsOf(st) {
  const legacy = {
    claude: { found: !!st?.claude, path: st?.claude?.path ?? null, version: st?.claude?.version ?? null, auth: st?.auth ?? null },
    codex: { found: !!st?.codex, path: st?.codex?.path ?? null, version: st?.codex?.version ?? null, auth: st?.codexAuth ?? null },
  };
  return AGENTS.map((def) => {
    const raw = (st?.agents ? st.agents[def.id] : legacy[def.id]) || { found: false };
    const found = !!raw.found;
    const auth = raw.auth ?? null;
    const state = !found ? 'missing' : auth?.loggedIn ? 'connected' : auth?.error ? 'error' : 'login';
    return { id: def.id, def, found, version: raw.version ?? null, path: raw.path ?? null, auth, state };
  });
}

export const connectedIds = (list) => list.filter((e) => e.state === 'connected').map((e) => e.id);

// 입장 조건: AI 가 하나 이상 연결됨
export const canEnter = (list) => connectedIds(list).length >= 1;

// 목록 요약 한 줄
export function accountText(entry) {
  if (entry.state === 'connected') {
    const a = entry.auth;
    const plan = a.plan || a.subscriptionType;
    return `${a.email || a.methodLabel || t('app.agents.acctLoggedIn')}${plan ? ` · ${plan}` : ''}`;
  }
  if (entry.state === 'login') return t('app.agents.acctNeedLogin');
  if (entry.state === 'error') return t('app.agents.acctError');
  return t('app.agents.acctMissing');
}

// 처음 고를 AI: 기억한 것이 목록에 있으면 그것, 아니면 연결 안 된 첫 항목(마저 설정하도록), 모두 연결됐으면 첫 항목
// 기억한 것 → 설치됐지만 연결이 안 된 첫 AI(로그인 필요·확인 오류) → 연결된 첫 AI → 첫 항목.
// 미설치 AI 가 여럿이어도 쓰던 AI(연결됨)가 먼저 보이게 미설치는 맨 뒤로 둔다.
export function pickDefault(list, remembered) {
  if (list.some((e) => e.id === remembered)) return remembered;
  return (list.find((e) => e.state === 'login' || e.state === 'error') || list.find((e) => e.state === 'connected') || list[0])?.id ?? null;
}

// 협업에 참여할 수 있는 AI = 연결된 AI
export const collabChoices = (list) => list.filter((e) => e.state === 'connected');

// 협업은 2개 이상 골라야 한다
export const collabReady = (selected) => selected.length >= 2;

// 협업 가능: 중복 없이 2개 이상이고 모두 협업 실행기(caps.collab)가 있는 AI
export const collabSupported = (selected) =>
  new Set(selected).size === selected.length && selected.length >= 2 && selected.every((id) => agentById(id)?.caps?.collab === true);
