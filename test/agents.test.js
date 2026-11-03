import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  AGENTS, AGENT_IDS, DEFAULT_AGENT, makeRegistry, registry, normAgent, agentName, agentById,
} from '../src/shared/agents.js';

test('AGENTS: id·name·product·tabPrefix·color·install·caps 모양과 동결', () => {
  assert.ok(Object.isFrozen(AGENTS));
  for (const a of AGENTS) {
    assert.ok(Object.isFrozen(a));
    assert.deepEqual(Object.keys(a).sort(), ['caps', 'collabLabel', 'color', 'id', 'install', 'name', 'product', 'tabPrefix']);
    for (const k of ['id', 'name', 'product', 'collabLabel']) assert.equal(typeof a[k], 'string');
    assert.equal(typeof a.tabPrefix, 'string');
    assert.match(a.color, /^#[0-9a-f]{6}$/i);
    assert.ok(Object.isFrozen(a.install));
    assert.deepEqual(Object.keys(a.install).sort(), ['cmd', 'url']);
    assert.ok(a.install.cmd && a.install.url.startsWith('https://'));
    assert.ok(Object.isFrozen(a.caps));
    assert.deepEqual(Object.keys(a.caps), ['externalSessions', 'collab']);
    assert.equal(typeof a.caps.externalSessions, 'boolean');
    assert.equal(typeof a.caps.collab, 'boolean');
    assert.match(a.id, /^[a-z][a-z0-9-]*$/); // @멘션 정규식·DOM id 에 그대로 쓰인다
  }
  assert.ok(Object.isFrozen(registry));
});

test('AGENTS: 색·설치 안내·외부 세션 능력 값', () => {
  assert.deepEqual(AGENTS.map((a) => [a.id, a.color, a.install.cmd, a.install.url, a.caps.externalSessions]), [
    ['claude', '#d97757', 'irm https://claude.ai/install.ps1 | iex', 'https://code.claude.com/docs/en/setup', true],
    ['codex', '#6fa3c9', 'irm https://chatgpt.com/codex/install.ps1 | iex', 'https://developers.openai.com/codex/cli', false],
    ['grok', '#7d8794', 'irm https://x.ai/cli/install.ps1 | iex', 'https://docs.x.ai/build', false],
    ['muse', '#8a6bd8', 'irm https://dev.meta.ai/install.ps1 | iex', 'https://dev.meta.ai/docs/muse-code', false],
    ['antigravity', '#3f9f78', 'irm https://antigravity.google/cli/install.ps1 | iex', 'https://antigravity.google/docs/getting-started?tab=cli', false],
  ]);
  assert.equal(agentById('codex').caps.externalSessions, false);
  assert.equal(agentById('grok').caps.externalSessions, false);
  assert.equal(agentById('unknown-ai')?.caps.externalSessions, undefined); // 모르는 AI 는 외부 세션으로 보지 않는다
});

test('AGENTS: 협업 표기(collabLabel)와 협업 능력(caps.collab)', () => {
  assert.deepEqual(AGENTS.map((a) => [a.id, a.collabLabel, a.caps.collab]), [
    ['claude', 'Claude(Claude Code)', true],
    ['codex', 'Codex(OpenAI Codex)', true],
    ['grok', 'Grok(xAI Grok Build)', true],
    ['muse', 'Muse(Meta Muse Code)', true],
    ['antigravity', 'Gemini(Google Antigravity CLI)', true],
  ]);
  assert.equal(agentById('unknown-ai')?.caps?.collab, undefined); // 모르는 AI 는 협업 가능으로 보지 않는다
});

test('AGENTS: 기존 화면 값과 같다', () => {
  assert.deepEqual(AGENTS.map((a) => [a.id, a.name, a.product, a.tabPrefix]), [
    ['claude', 'Claude', 'Claude Code', ''],
    ['codex', 'Codex', 'Codex', 'Codex · '],
    ['grok', 'Grok', 'Grok Build', 'Grok · '],
    ['muse', 'Muse', 'Muse Code', 'Muse · '],
    ['antigravity', 'Gemini', 'Gemini (Antigravity CLI)', 'Gemini · '],
  ]);
  assert.equal(DEFAULT_AGENT, 'claude');
});

test('AGENT_IDS: claude·codex·grok·muse·antigravity 순서, 동결', () => {
  assert.deepEqual([...AGENT_IDS], ['claude', 'codex', 'grok', 'muse', 'antigravity']);
  assert.ok(Object.isFrozen(AGENT_IDS));
});

test('normAgent: 등록된 값만 남기고 나머지는 claude', () => {
  assert.equal(normAgent('codex'), 'codex');
  assert.equal(normAgent('claude'), 'claude');
  assert.equal(normAgent('grok'), 'grok');
  assert.equal(normAgent('antigravity'), 'antigravity');
  for (const v of [undefined, null, '', 'gemini', 'CODEX', 'constructor', '__proto__', 'toString']) assert.equal(normAgent(v), 'claude', String(v));
});

test('agentName·agentById', () => {
  assert.equal(agentName('claude'), 'Claude');
  assert.equal(agentName('codex'), 'Codex');
  assert.equal(agentName('grok'), 'Grok');
  assert.equal(agentName('muse'), 'Muse');
  assert.equal(agentName('antigravity'), 'Gemini');
  assert.equal(agentName('gemini'), 'Claude');
  assert.equal(agentName(undefined), 'Claude');
  assert.equal(agentById('codex').product, 'Codex');
  assert.equal(agentById('gemini'), null);
  assert.equal(agentById('__proto__'), null);
});

test('makeRegistry: 가짜 AI 는 테스트 안에서만 등록된다', () => {
  const r = makeRegistry([...AGENTS, { id: 'fake-ai', name: 'Fake', product: 'Fake Build', tabPrefix: 'Fake · ', color: '#888888', collabLabel: 'Fake(Fake Build)', install: { cmd: 'x', url: 'https://example.com' }, caps: { externalSessions: false, collab: false } }]);
  assert.deepEqual([...r.ids], ['claude', 'codex', 'grok', 'muse', 'antigravity', 'fake-ai']);
  assert.equal(r.norm('fake-ai'), 'fake-ai');
  assert.equal(r.name('fake-ai'), 'Fake');
  assert.equal(r.has('fake-ai'), true);
  // 기본 레지스트리는 영향받지 않는다
  assert.equal(normAgent('fake-ai'), 'claude');
  assert.equal(registry.has('fake-ai'), false);
});

test('메인(require)이 읽어도 같은 AGENT_IDS', () => {
  const cjs = createRequire(import.meta.url)('../src/shared/agents.js');
  assert.deepEqual([...cjs.AGENT_IDS], [...AGENT_IDS]);
  assert.equal(cjs.normAgent('codex'), 'codex');
});
