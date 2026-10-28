import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Moderator, autoChoice, resolveChoice, fitEffort, EFFORT_LABEL, MODEL_OPTIONS } from '../src/renderer/collab/moderator.js';

function room(opts = {}) {
  const sent = []; const stopped = [];
  const m = new Moderator({ send: (agent, text, choice, turn) => sent.push({ agent, text, choice, turn }), stop: (agent) => stopped.push(agent), ...opts });
  const reply = (agent, text, extra = {}) => { m.handle(agent, { type: 'text', text }); m.handle(agent, { type: 'done', ok: true, ...extra }); };
  return { m, sent, stopped, reply };
}

test('자동 모델: 어려운 추론은 Fable·Astra + xhigh, 설계된 단순 작업은 Sonnet, 그 외 Opus·Sol + high', () => {
  assert.deepEqual(autoChoice('claude', '이 버그의 원인을 분석해 줘'), { kind: 'hard', model: 'fable', effort: 'xhigh' });
  assert.deepEqual(autoChoice('codex', '아키텍처 설계 검토'), { kind: 'hard', model: 'gpt-6-astra', effort: 'xhigh' });
  assert.deepEqual(autoChoice('claude', '주석 오타만 고쳐 줘'), { kind: 'simple', model: 'sonnet', effort: 'high' });
  assert.deepEqual(autoChoice('claude', '설계대로 구현만 해 줘'), { kind: 'simple', model: 'sonnet', effort: 'high' });
  assert.deepEqual(autoChoice('claude', '로그인 화면 만들어 줘'), { kind: 'normal', model: 'opus', effort: 'high' });
  assert.deepEqual(autoChoice('codex', '로그인 화면 만들어 줘'), { kind: 'normal', model: 'gpt-6.1-sol', effort: 'high' });
  assert.deepEqual(resolveChoice('claude', { model: 'sonnet', effort: 'auto' }, '원인 분석'), { model: 'sonnet', effort: 'xhigh' });
  assert.deepEqual(resolveChoice('codex', { model: 'auto', effort: 'high' }, '원인 분석'), { model: 'gpt-6-astra', effort: 'high' });
  assert.ok(MODEL_OPTIONS.claude.some((o) => o.value === 'fable') && MODEL_OPTIONS.codex.some((o) => o.value === 'gpt-6-astra'));
});

test('CLI 가 알려 준 목록이 있으면 고른 모델이 지원하는 노력 단계로 맞춘다', () => {
  const claude = [
    { value: 'opus', label: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'claude-opus-4-6', label: 'Opus 4.6', efforts: ['low', 'medium', 'high', 'max'] },
    { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', efforts: [] },
  ];
  assert.deepEqual(resolveChoice('claude', { model: 'opus', effort: 'max' }, '', claude), { model: 'opus', effort: 'max' });
  assert.deepEqual(resolveChoice('claude', { model: 'claude-opus-4-6', effort: 'auto' }, '원인 분석', claude), { model: 'claude-opus-4-6', effort: 'high' }, 'xhigh 미지원 → high');
  assert.deepEqual(resolveChoice('claude', { model: 'claude-haiku-4-5-20251001', effort: 'auto' }, '', claude), { model: 'claude-haiku-4-5-20251001', effort: null }, '노력 단계 없는 모델');
  assert.deepEqual(fitEffort('ultra', ['low', 'max']), 'max', 'high 도 없으면 가장 높은 단계');
  assert.deepEqual(fitEffort('xhigh', null), 'xhigh', '목록을 모르면 그대로');
  assert.equal(EFFORT_LABEL.xhigh, 'Extra High');
});

test('대화 중 쓰는 모델은 CLI 가 알려 준 목록 기준으로 노력 단계를 맞춰 보낸다', () => {
  const { m, sent } = room();
  m.catalog.claude = [{ value: 'claude-opus-4-6', label: 'Opus 4.6', efforts: ['high', 'max'] }];
  m.prefs.claude = { model: 'claude-opus-4-6', effort: 'xhigh' };
  m.say('안녕', 'claude');
  assert.deepEqual(sent[0].choice, { model: 'claude-opus-4-6', effort: 'high' });
});

test('모두에게 말하면 구현 담당부터 답하고, 이후 상대 발언을 넘겨 가며 계속 대화한다 (횟수 제한 없음)', () => {
  const { m, sent, reply } = room();
  m.owner = 'codex';
  m.say('로그인 기능을 같이 정하자');
  assert.equal(sent[0].agent, 'codex');
  assert.match(sent[0].text, /\[사용자\] 로그인 기능을 같이 정하자/);
  assert.match(sent[0].text, /구현 담당: Codex \(당신\)/);
  reply('codex', 'Codex 의견');
  assert.equal(sent[1].agent, 'claude');
  assert.match(sent[1].text, /\[사용자\] 로그인 기능을 같이 정하자/);
  assert.match(sent[1].text, /\[Codex\] Codex 의견/);
  for (let i = 0; i < 30; i++) reply(sent.at(-1).agent, `발언 ${i}`);
  assert.equal(sent.length, 32, '제한 없이 이어진다');
  assert.ok(!/\[Claude\]/.test(sent.filter((s) => s.agent === 'claude').at(-1).text), '자기 발언은 다시 보내지 않는다');
});

test('대화 중 사용자가 끼어들면 다음 차례에 함께 전달되고, 중단하면 즉시 멈춘다', () => {
  const { m, sent, stopped, reply } = room();
  m.say('시작');
  m.say('잠깐, 보안도 고려해');
  assert.equal(sent.length, 1, '진행 중에는 새 턴을 만들지 않는다');
  reply('claude', '첫 의견');
  assert.match(sent[1].text, /\[사용자\] 시작[\s\S]*\[Claude\] 첫 의견[\s\S]*\[사용자\] 잠깐, 보안도 고려해/); // 실제 시간 순서
  m.halt();
  assert.deepEqual(stopped, ['codex']); assert.equal(m.status, 'stopped');
  m.handle('codex', { type: 'done', ok: false, stopped: true });
  assert.equal(sent.length, 2, '중단 후에는 다음 차례로 넘어가지 않는다');
  m.say('다시 이어서');
  assert.equal(sent.length, 3); assert.equal(m.status, 'running');
});

test('AI 가 [질문] 으로 물으면 사용자 답을 기다리고, 답은 질문한 쪽이 먼저 받는다', () => {
  const { m, sent, reply } = room();
  m.say('결제 붙여 줘');
  reply('claude', '어떤 PG 를 쓸까요?\n[질문] 토스 / 카카오');
  assert.equal(m.status, 'question'); assert.equal(sent.length, 1);
  m.say('토스');
  assert.equal(sent[1].agent, 'claude');
  assert.match(sent[1].text, /\[사용자\] 토스/);
});

test('[완료] 면 멈추고, 자동 이어가기를 끄면 대상만 한 번 답한다', () => {
  const { m, sent, reply } = room();
  m.say('정리해 줘');
  reply('claude', '정리 끝\n[완료]');
  assert.equal(m.status, 'idle'); assert.equal(sent.length, 1);
  m.auto = false;
  m.say('@codex 의견만', 'codex');
  assert.equal(sent[1].agent, 'codex');
  reply('codex', '의견');
  assert.equal(sent.length, 2); assert.equal(m.status, 'idle');
  m.say('둘 다 한 번씩', 'all');
  reply('claude', 'c'); reply('codex', 'x');
  assert.deepEqual(sent.slice(2).map((s) => s.agent), ['claude', 'codex']);
  assert.equal(m.status, 'idle');
});

test('진행 중 끼어든 메시지는 자동 이어가기를 꺼도·[완료] 로 끝나도 답을 받고, 지정한 상대가 먼저 받는다', () => {
  const { m, sent, reply } = room();
  m.auto = false;
  m.say('리팩터링해', 'claude');
  m.say('잠깐, 테스트도 같이');
  reply('claude', '알겠습니다');
  assert.equal(sent.length, 2, '끼어든 메시지가 버려지지 않는다');
  assert.equal(sent[1].agent, 'codex', '모두에게 보낸 끼어들기는 답하던 쪽의 상대가 받는다');
  assert.match(sent[1].text, /\[사용자\] 잠깐, 테스트도 같이/);

  const b = room();
  b.m.say('시작', 'claude');
  b.m.say('Codex 에게만', 'codex');
  b.reply('claude', '정리 끝\n[완료]');
  assert.equal(b.sent.length, 2, '[완료] 여도 끼어든 메시지는 전달');
  assert.equal(b.sent[1].agent, 'codex', '지정한 상대가 받는다');
});

test('중단은 진행 중인 발언을 즉시 끝내므로, 프로세스가 아직 없어도 다음 메시지가 막히지 않는다', () => {
  const { m, sent, stopped } = room();
  m.say('시작');
  m.halt();
  assert.deepEqual(stopped, ['claude']); assert.equal(m.running, null); assert.equal(m.messages.at(-1).streaming, false);
  m.say('다시');
  assert.equal(sent.length, 2); assert.equal(sent[1].agent, 'claude');
  assert.notEqual(sent[0].turn, sent[1].turn, '턴마다 번호를 붙여 보낸다');
  m.handle('claude', { type: 'done', ok: false, stopped: true, turn: sent[0].turn }); // 앞 턴의 늦은 중단 알림
  assert.equal(m.status, 'running', '새 턴은 영향받지 않는다');
  m.handle('claude', { type: 'text', text: '새 답', turn: sent[1].turn });
  assert.equal(m.messages.at(-1).text, '새 답');
});

test('턴마다 모델·노력을 고르고, 실시간 글자·도구 사용을 발언에 붙이며 오류는 멈춘다', () => {
  const { m, sent } = room();
  m.prefs.codex = { model: 'auto', effort: 'auto' };
  m.say('원인 분석 부탁', 'codex');
  assert.deepEqual(sent[0].choice, { model: 'gpt-6-astra', effort: 'xhigh' });
  m.handle('codex', { type: 'text', text: '분석 ', block: true });
  m.handle('codex', { type: 'tool', name: 'Bash', input: { command: 'npm test' } });
  m.handle('codex', { type: 'text', text: '결과', block: true });
  const msg = m.messages.at(-1);
  assert.equal(msg.from, 'codex'); assert.equal(msg.model, 'gpt-6-astra'); assert.equal(msg.effort, 'xhigh');
  assert.equal(msg.text, '분석 \n\n결과'); assert.deepEqual(msg.tools, [{ name: 'Bash', input: { command: 'npm test' } }]);
  m.handle('codex', { type: 'done', ok: false, error: '한도 초과' });
  assert.equal(m.status, 'error');
  assert.match(m.messages.at(-1).text, /Codex 오류: 한도 초과/);
});
