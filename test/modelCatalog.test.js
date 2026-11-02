import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createModelCatalog } = require('../src/main/modelCatalog.cjs');

// 호출 횟수를 세는 가짜 조회기
function fetchers(plan) {
  const calls = { claude: 0, codex: 0, grok: 0 };
  const make = (id) => async () => { calls[id]++; const r = plan[id]; return typeof r === 'function' ? r(calls[id]) : r; };
  return { calls, set: { claude: make('claude'), codex: make('codex'), grok: make('grok') } };
}
const L = (v) => [{ value: v }];

test('모델 목록 캐시: 성공한 AI 는 재사용하고 실패한 AI 만 다시 조회한다', async () => {
  const f = fetchers({
    claude: { list: L('opus') },
    codex: { list: L('gpt') },
    grok: (n) => (n === 1 ? { error: 'Grok 로그인이 필요합니다' } : { list: L('grok-4.7') }),
  });
  const fails = [];
  const models = createModelCatalog(f.set, { onFail: (id, e) => fails.push([id, e]) });
  const r1 = await models();
  assert.deepEqual(Object.keys(r1), ['claude', 'codex', 'grok', 'errors'], '결과 모양 { claude, codex, grok, errors }');
  assert.deepEqual(r1.claude, L('opus')); assert.equal(r1.grok, null);
  assert.deepEqual(r1.errors, { grok: 'Grok 로그인이 필요합니다' });
  assert.deepEqual(fails, [['grok', 'Grok 로그인이 필요합니다']]);
  const r2 = await models();
  assert.deepEqual(r2.grok, L('grok-4.7')); assert.deepEqual(r2.errors, {});
  assert.deepEqual(f.calls, { claude: 1, codex: 1, grok: 2 }, 'Claude·Codex 는 다시 조회하지 않는다');
  await models();
  assert.deepEqual(f.calls, { claude: 1, codex: 1, grok: 2 }, '모두 성공했으면 더 조회하지 않는다');
});

test('모델 목록 캐시: final 실패(미설치)는 다시 조회하지 않고, 그 밖의 실패·예외는 다음 호출에서 재시도한다', async () => {
  const f = fetchers({
    claude: (n) => { if (n === 1) throw new Error('boom'); return { list: L('opus') }; },
    codex: { list: [], error: 'codex debug models 응답을 읽지 못했습니다' },
    grok: { error: 'Grok Build 를 찾지 못했습니다', final: true },
  });
  const models = createModelCatalog(f.set);
  const r1 = await models();
  assert.deepEqual(r1.errors, { claude: 'boom', codex: 'codex debug models 응답을 읽지 못했습니다', grok: 'Grok Build 를 찾지 못했습니다' });
  assert.deepEqual([r1.claude, r1.codex, r1.grok], [null, null, null]);
  const r2 = await models();
  assert.deepEqual(r2.claude, L('opus'));
  assert.deepEqual(r2.errors, { codex: 'codex debug models 응답을 읽지 못했습니다', grok: 'Grok Build 를 찾지 못했습니다' });
  assert.deepEqual(f.calls, { claude: 2, codex: 2, grok: 1 }, 'final 은 한 번만');
});

test('모델 목록 캐시: reset(id) 은 그 AI 의 확정(미설치 final 포함)을 버려 다시 조회하고, 조회 중 reset 된 옛 결과는 저장하지 않는다', async () => {
  let installed = false;
  const f = fetchers({ claude: { list: L('o') }, codex: { list: L('c') }, grok: () => (installed ? { list: L('grok-4.7') } : { error: '없음', final: true }) });
  const models = createModelCatalog(f.set);
  assert.equal(typeof models.reset, 'function');
  assert.equal((await models()).grok, null);
  await models();
  assert.equal(f.calls.grok, 1, 'final 은 reset 전까지 한 번만');
  installed = true;
  models.reset('grok');
  const r = await models();
  assert.deepEqual(r.grok, L('grok-4.7')); assert.deepEqual(r.errors, {});
  assert.deepEqual(f.calls, { claude: 1, codex: 1, grok: 2 }, '다른 AI 는 다시 조회하지 않는다');
  models.reset('nope'); // 모르는 id 는 아무 일도 없다
  // 조회가 끝나기 전에 reset 하면 옛 결과가 새 조회를 덮지 않는다
  let release; const gate = new Promise((res) => { release = res; });
  let n = 0;
  const slow = createModelCatalog({ a: async () => { const k = ++n; if (k === 1) await gate; return { list: L('v' + k) }; } });
  const first = slow();
  slow.reset('a');
  const second = await slow();
  release();
  assert.deepEqual((await first).a, L('v1')); assert.deepEqual(second.a, L('v2'));
  assert.deepEqual((await slow()).a, L('v2'), '옛 조회가 끝나도 새 결과가 유지된다'); assert.equal(n, 2);
});

test('모델 목록 캐시: 동시에 불러도 AI 별로 한 번만 조회한다 (동기 예외 포함)', async () => {
  const f = fetchers({ claude: { list: L('o') }, codex: () => { throw new Error('즉시 예외'); }, grok: { list: L('g') } });
  const models = createModelCatalog(f.set);
  const [a, b] = await Promise.all([models(), models()]);
  assert.deepEqual(a, b);
  assert.deepEqual(f.calls, { claude: 1, codex: 1, grok: 1 });
  assert.equal(a.errors.codex, '즉시 예외');
  await models();
  assert.equal(f.calls.codex, 2, '실패는 진행 중 목록에 남지 않고 다음 호출에서 재시도');
});
