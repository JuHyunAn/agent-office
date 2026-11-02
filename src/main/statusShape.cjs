'use strict';

const { AGENT_IDS } = require('../shared/agents.js');

// app:status 의 AI 연결 부분을 만드는 순수 함수 (Electron·파일·프로세스 없음 — 테스트가 직접 부른다).
// 옛 키(claude·codex·auth·codexAuth)는 다른 점검 스크립트가 새 키로 옮겨 갈 때까지 함께 준다. 둘은 같은 값에서 나온다.
//   입력 byId: { claude, codex, [그 밖의 AI id]: { loc: CLI 위치({ display }) 또는 null, version, auth } } — 없는 AI 는 미설치로 채운다
//   미설치일 때 auth 는 Claude {loggedIn:false} · Codex 와 그 밖의 AI 는 null (지금 화면이 기대하는 값).
function statusSnapshot(byId) {
  const { claude, codex } = byId;
  const claudeAuth = claude.loc ? claude.auth : { loggedIn: false };
  const codexAuth = codex.loc ? (codex.auth || null) : null;
  const claudeVersion = claude.version ?? null;
  const codexVersion = codex.version ?? null;
  const agents = {
    claude: { found: !!claude.loc, path: claude.loc?.display || null, version: claudeVersion, auth: claudeAuth },
    codex: { found: !!codex.loc, path: codex.loc?.display || null, version: codexVersion, auth: codexAuth },
  };
  for (const id of AGENT_IDS) {
    if (id === 'claude' || id === 'codex') continue;
    const e = byId[id] || {};
    agents[id] = { found: !!e.loc, path: e.loc?.display || null, version: e.version ?? null, auth: e.loc ? (e.auth || null) : null };
  }
  return {
    claude: claude.loc ? { path: claude.loc.display, version: claudeVersion } : null,
    codex: codex.loc ? { path: codex.loc.display, version: codexVersion } : null,
    auth: claudeAuth,
    codexAuth,
    // 키 순서 = AGENT_IDS 순서
    agents: Object.fromEntries(AGENT_IDS.map((id) => [id, agents[id]])),
  };
}

module.exports = { statusSnapshot };
