import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AGENT_IDS } from '../src/shared/agents.js';

const { statusSnapshot } = createRequire(import.meta.url)('../src/main/statusShape.cjs');

const claudeLoc = { display: 'C:\\claude.exe' };
const codexLoc = { display: 'C:\\codex.exe' };

test('statusSnapshot: agents.X 와 옛 키(claude·codex·auth·codexAuth)가 같은 값', () => {
  const auth = { loggedIn: true, email: 'c@example.com' };
  const cauth = { loggedIn: true, email: 'x@example.com', plan: 'plus' };
  const s = statusSnapshot({ claude: { loc: claudeLoc, version: '2.1', auth }, codex: { loc: codexLoc, version: '0.5', auth: cauth } });
  assert.deepEqual(s.claude, { path: 'C:\\claude.exe', version: '2.1' });
  assert.deepEqual(s.codex, { path: 'C:\\codex.exe', version: '0.5' });
  assert.equal(s.auth, auth);
  assert.equal(s.codexAuth, cauth);
  assert.deepEqual(s.agents.claude, { found: true, path: s.claude.path, version: s.claude.version, auth: s.auth });
  assert.deepEqual(s.agents.codex, { found: true, path: s.codex.path, version: s.codex.version, auth: s.codexAuth });
  assert.deepEqual(Object.keys(s.agents), [...AGENT_IDS]); // claude·codex 외에는 미설치로 채운 항목 (아래 테스트)
});

test('statusSnapshot: 미설치 — 옛 키 claude·codex 는 null, auth 는 Claude {loggedIn:false} · Codex null', () => {
  const s = statusSnapshot({ claude: { loc: null }, codex: { loc: null } });
  assert.equal(s.claude, null);
  assert.equal(s.codex, null);
  assert.deepEqual(s.auth, { loggedIn: false });
  assert.equal(s.codexAuth, null);
  assert.deepEqual(s.agents.claude, { found: false, path: null, version: null, auth: { loggedIn: false } });
  assert.deepEqual(s.agents.codex, { found: false, path: null, version: null, auth: null });
});

test('statusSnapshot: Codex 만 있고 확인에 실패해도(auth 오류) 같은 값이 나간다', () => {
  const auth = { loggedIn: false, error: 'Codex 상태를 확인하지 못했습니다: x' };
  const s = statusSnapshot({ claude: { loc: null }, codex: { loc: codexLoc, auth } });
  assert.deepEqual(s.codex, { path: 'C:\\codex.exe', version: null });
  assert.equal(s.codexAuth, auth);
  assert.equal(s.agents.codex.found, true);
  assert.equal(s.agents.codex.auth, auth);
});

test('statusSnapshot: Codex 위치가 있는데 auth 가 비어 있으면 null (옛 동작)', () => {
  const s = statusSnapshot({ claude: { loc: claudeLoc, version: '2', auth: { loggedIn: false } }, codex: { loc: codexLoc, version: '1' } });
  assert.equal(s.codexAuth, null);
  assert.equal(s.agents.codex.auth, null);
  assert.equal(s.agents.claude.auth, s.auth);
});

test('statusSnapshot: 새 AI 항목 — 찾았으면 경로·버전·auth, 위치가 없으면 found:false · auth null', () => {
  const grokAuth = { loggedIn: true };
  const s = statusSnapshot({
    claude: { loc: claudeLoc, version: '2.1', auth: { loggedIn: true } },
    codex: { loc: null },
    grok: { loc: { display: 'C:\\grok.exe' }, version: '1.0.70', auth: grokAuth },
    muse: { loc: null, auth: { loggedIn: true } }, // 위치가 없으면 auth 는 버린다
  });
  assert.deepEqual(s.agents.grok, { found: true, path: 'C:\\grok.exe', version: '1.0.70', auth: grokAuth });
  assert.equal(s.agents.grok.auth, grokAuth);
  assert.deepEqual(s.agents.muse, { found: false, path: null, version: null, auth: null });
});

test('statusSnapshot: 넘기지 않은 AI 도 미설치로 채우고, 키 순서는 AGENT_IDS 순서', () => {
  const s = statusSnapshot({ claude: { loc: claudeLoc, version: '2.1', auth: { loggedIn: true } }, codex: { loc: codexLoc, version: '0.5' } });
  assert.deepEqual(Object.keys(s.agents), [...AGENT_IDS]);
  for (const id of ['grok', 'muse', 'antigravity']) assert.deepEqual(s.agents[id], { found: false, path: null, version: null, auth: null }, id);
});

test('statusSnapshot: 새 AI 가 있어도 옛 키(claude·codex·auth·codexAuth)와 claude·codex 항목은 그대로', () => {
  const auth = { loggedIn: true };
  const base = statusSnapshot({ claude: { loc: claudeLoc, version: '2.1', auth }, codex: { loc: codexLoc, version: '0.5' } });
  const withGrok = statusSnapshot({ claude: { loc: claudeLoc, version: '2.1', auth }, codex: { loc: codexLoc, version: '0.5' }, grok: { loc: { display: 'g' }, version: '1', auth: { loggedIn: false } } });
  for (const k of ['claude', 'codex', 'auth', 'codexAuth']) assert.deepEqual(withGrok[k], base[k], k);
  assert.deepEqual(withGrok.agents.claude, base.agents.claude);
  assert.deepEqual(withGrok.agents.codex, base.agents.codex);
});
