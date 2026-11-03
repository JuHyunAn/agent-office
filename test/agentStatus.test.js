import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentsOf, connectedIds, canEnter, accountText, pickDefault, collabChoices, collabReady, collabSupported,
} from '../src/renderer/agentStatus.js';

const ok = { loggedIn: true, email: 'a@example.com', plan: 'plus' };
const NEW_IDS = ['grok', 'muse', 'antigravity']; // 상태가 없으면 미설치로 보이는 새 AI (레지스트리 순서)

test('agentsOf: 새 키(agents)가 있으면 그것을 쓴다 — AGENTS 순서의 배열', () => {
  const list = agentsOf({
    claude: null, // 옛 키는 무시된다
    agents: {
      claude: { found: true, path: 'C:\\c', version: '2.1', auth: { loggedIn: true, email: 'c@example.com', subscriptionType: 'max' } },
      codex: { found: true, path: 'C:\\x', version: '0.5', auth: ok },
    },
  });
  assert.deepEqual(list.map((e) => [e.id, e.found, e.version, e.path, e.state]), [
    ['claude', true, '2.1', 'C:\\c', 'connected'],
    ['codex', true, '0.5', 'C:\\x', 'connected'],
    ...NEW_IDS.map((id) => [id, false, null, null, 'missing']),
  ]);
  assert.equal(list[0].def.product, 'Claude Code');
  assert.equal(list[1].def.id, 'codex');
});

test('agentsOf: agents 가 없으면 옛 키(claude·codex·auth·codexAuth)로 만든다 — 다른 점검 스크립트의 가짜 상태 모양', () => {
  const list = agentsOf({ claude: { version: '코드 화면 검증' }, auth: { loggedIn: true }, hook: { global: {} } });
  assert.deepEqual(list.map((e) => [e.id, e.found, e.version, e.state]), [
    ['claude', true, '코드 화면 검증', 'connected'],
    ['codex', false, null, 'missing'],
    ...NEW_IDS.map((id) => [id, false, null, 'missing']),
  ]);
  const both = agentsOf({ claude: { path: 'P', version: 'v' }, codex: { version: 'w' }, auth: { loggedIn: true }, codexAuth: ok });
  assert.deepEqual(both.map((e) => [e.id, e.path, e.state, e.auth === ok]), [['claude', 'P', 'connected', false], ['codex', null, 'connected', true], ...NEW_IDS.map((id) => [id, null, 'missing', false])]);
});

test('agentsOf: agents 에 빠진 id 는 설치 안 됨으로 본다 · 상태 없음/오류 객체도 죽지 않는다', () => {
  const list = agentsOf({ agents: { claude: { found: true, version: '1', auth: { loggedIn: false } } } });
  assert.deepEqual(list.map((e) => [e.id, e.found, e.state]), [['claude', true, 'login'], ['codex', false, 'missing'], ...NEW_IDS.map((id) => [id, false, 'missing'])]);
  for (const st of [null, undefined, {}, { error: '실패' }]) {
    assert.deepEqual(agentsOf(st).map((e) => e.state), ['missing', 'missing', ...NEW_IDS.map(() => 'missing')], String(st));
  }
});

test('state 4종: missing · connected · error · login', () => {
  const state = (agents) => agentsOf({ agents }).map((e) => e.state).slice(0, 2); // 새 AI 는 상태가 없어 미설치 (위 테스트)
  assert.deepEqual(state({
    claude: { found: false, auth: { loggedIn: true } }, // 못 찾았으면 계정 정보와 상관없이 missing
    codex: { found: true, auth: { loggedIn: true } },
  }), ['missing', 'connected']);
  assert.deepEqual(state({
    claude: { found: true, auth: { loggedIn: false, error: '읽기 실패' } },
    codex: { found: true, auth: null },
  }), ['error', 'login']);
  assert.deepEqual(state({ claude: { found: true, auth: { loggedIn: false } }, codex: { found: true } }), ['login', 'login']);
  // 로그인됨이면 error 문구가 함께 있어도 연결됨
  assert.deepEqual(state({ claude: { found: true, auth: { loggedIn: true, error: 'x' } }, codex: { found: false } }), ['connected', 'missing']);
});

test('connectedIds·canEnter: 0개 · 1개 · 2개', () => {
  const mk = (c, x) => agentsOf({ agents: { claude: { found: true, auth: { loggedIn: c } }, codex: { found: true, auth: { loggedIn: x } } } });
  assert.deepEqual([connectedIds(mk(false, false)), canEnter(mk(false, false))], [[], false]);
  assert.deepEqual([connectedIds(mk(false, true)), canEnter(mk(false, true))], [['codex'], true]); // Claude 없이도 입장
  assert.deepEqual([connectedIds(mk(true, true)), canEnter(mk(true, true))], [['claude', 'codex'], true]);
});

test('accountText: 연결됨 · 로그인 필요 · 상태 확인 실패 · 미설치', () => {
  const one = (agent) => accountText(agentsOf({ agents: { claude: agent, codex: { found: false } } })[0]);
  assert.equal(one({ found: true, auth: { loggedIn: true, email: 'a@example.com', plan: 'plus' } }), 'a@example.com · plus');
  assert.equal(one({ found: true, auth: { loggedIn: true, email: 'a@example.com', subscriptionType: 'max' } }), 'a@example.com · max');
  assert.equal(one({ found: true, auth: { loggedIn: true, methodLabel: 'ChatGPT' } }), 'ChatGPT');
  assert.equal(one({ found: true, auth: { loggedIn: true } }), '로그인됨');
  assert.equal(one({ found: true, auth: { loggedIn: false } }), '로그인 필요');
  assert.equal(one({ found: true, auth: { loggedIn: false, error: 'e' } }), '상태 확인 실패');
  assert.equal(one({ found: false }), '설치되어 있지 않음');
});

test('pickDefault: 기억한 것 → 로그인 필요·오류인 첫 항목 → 연결된 첫 항목 → 첫 항목 (미설치는 맨 뒤)', () => {
  const mk = (c, x) => agentsOf({ agents: { claude: { found: true, auth: { loggedIn: c } }, codex: { found: true, auth: { loggedIn: x } } } });
  assert.equal(pickDefault(mk(true, true), 'codex'), 'codex');
  assert.equal(pickDefault(mk(true, false), null), 'codex'); // 마저 연결할 AI 가 먼저 보인다
  assert.equal(pickDefault(mk(false, false), undefined), 'claude');
  assert.equal(pickDefault(mk(true, true), null), 'claude'); // 모두 연결이면 첫 항목
  assert.equal(pickDefault(mk(true, false), 'gemini'), 'codex'); // 목록에 없는 기억값은 무시
  assert.equal(pickDefault(mk(true, true), 'grok'), 'grok'); // 등록된 AI 면 미설치여도 기억값 그대로
  assert.equal(pickDefault(agentsOf({ agents: { claude: { found: true, auth: { loggedIn: true } } } }), null), 'claude'); // Codex·새 AI 미설치여도 연결된 Claude
  assert.equal(pickDefault(agentsOf({}), null), 'claude'); // 모두 미설치면 첫 항목
  assert.equal(pickDefault(mk(true, false), '__proto__'), 'codex');
  assert.equal(pickDefault([], 'claude'), null);
});

test('collabChoices·collabReady·collabSupported', () => {
  const list = agentsOf({ agents: { claude: { found: true, auth: { loggedIn: true } }, codex: { found: true, auth: { loggedIn: false } } } });
  assert.deepEqual(collabChoices(list).map((e) => e.id), ['claude']);
  assert.deepEqual([collabReady([]), collabReady(['claude']), collabReady(['claude', 'codex'])], [false, false, true]);
  // 중복 없이 2개 이상이고 모두 협업 실행기(caps.collab)가 있는 AI 일 때만
  assert.equal(collabSupported(['claude', 'codex']), true);
  assert.equal(collabSupported(['codex', 'claude']), true);
  assert.equal(collabSupported(['claude']), false);
  assert.equal(collabSupported([]), false);
  assert.equal(collabSupported(['claude', 'codex', 'grok']), true);
  assert.equal(collabSupported(['claude', 'muse']), true);
  assert.equal(collabSupported(['claude', 'antigravity']), true);
  assert.equal(collabSupported(['antigravity', 'muse', 'grok']), true);
  assert.equal(collabSupported(['claude', 'grok']), true);
  assert.equal(collabSupported(['claude', 'claude']), false);
  assert.equal(collabSupported(['claude', 'codex', 'claude']), false); // 길이가 3이어도 중복이면 거절
  assert.equal(collabSupported(['claude', '__proto__']), false);
  assert.equal(collabSupported(['claude', 'constructor']), false);
});

test('connectedIds: 확인 오류는 연결로 보지 않는다', () => {
  const st = { agents: { claude: { found: true, auth: { error: 'timeout' } }, codex: { found: true, auth: ok } } };
  assert.deepEqual(connectedIds(agentsOf(st)), ['codex']);
});
