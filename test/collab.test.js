import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Moderator, inputMode, isEmptyReply, parseQuestion, stripCode, autoChoice, resolveChoice, fitEffort, EFFORT_LABEL, MODEL_OPTIONS } from '../src/renderer/collab/moderator.js';

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

test('「모두에게」 의 첫 AI 가 [질문] 해도 상대가 한 번 답한 뒤 사용자 답을 기다리고, 답은 질문한 쪽이 먼저 받는다', () => {
  const { m, sent, reply } = room();
  m.say('결제 붙여 줘');
  reply('claude', '어떤 PG 를 쓸까요?\n[질문] 토스 / 카카오');
  assert.equal(sent.length, 2, '상대(Codex) 차례가 이어진다'); assert.equal(sent[1].agent, 'codex');
  reply('codex', '저는 아직 판단 보류');
  assert.equal(m.status, 'question'); assert.equal(m.asker, 'claude'); assert.equal(sent.length, 2);
  m.say('토스');
  assert.equal(sent[2].agent, 'claude');
  assert.match(sent[2].text, /\[사용자\] 토스/);
});

const LONG = '최종 답변 내용입니다. '.repeat(10); // 80자 이상

test('한쪽의 [완료] 는 제안일 뿐이라 상대가 반론하면 계속되고, 최종안에 상대가 이어서 [완료] 하면 멈춘다. 자동 이어가기를 끄면 대상만 한 번 답한다', () => {
  const { m, sent, reply } = room();
  m.say('정리해 줘');
  reply('claude', '정리 끝\n[완료]');
  assert.equal(sent.length, 2); assert.equal(m.status, 'running');
  reply('codex', '동의합니다');
  assert.equal(sent.length, 3); assert.equal(sent[2].agent, 'claude'); assert.equal(m.status, 'running', '평범한 답은 합의가 아니라 claude 차례');
  reply('claude', `${LONG}\n[완료]`);
  reply('codex', '동의합니다\n[완료]');
  assert.equal(m.status, 'idle'); assert.equal(sent.length, 4);
  const claudes = m.messages.filter((e) => e.from === 'claude');
  assert.equal(claudes[1].final, true); assert.equal(claudes[0].final, undefined, '첫 [완료] 메시지는 최종 답변이 아니다');
  m.auto = false;
  m.say('@codex 의견만', 'codex');
  assert.equal(sent[4].agent, 'codex');
  reply('codex', '의견');
  assert.equal(sent.length, 5); assert.equal(m.status, 'idle');
  m.say('둘 다 한 번씩', 'all');
  reply('claude', 'c'); reply('codex', 'x');
  assert.deepEqual(sent.slice(5).map((s) => s.agent), ['claude', 'codex']);
  assert.equal(m.status, 'idle');
});

test('「모두에게」 긴 답 + [완료] 에 상대가 이어서 [완료] 하면 합의 — 그 긴 답이 최종 답변이 된다', () => {
  const { m, sent, reply } = room();
  m.say('정리해 줘');
  reply('claude', `${LONG}\n[완료]`);
  reply('codex', '동의\n[완료]');
  assert.equal(m.status, 'idle'); assert.equal(sent.length, 2);
  const [c, x] = m.messages.filter((e) => e.from !== 'user');
  assert.equal(c.final, true); assert.equal(x.final, undefined);
  assert.equal(m.round.final, c); assert.equal(m.round.proposal, null);
});

test('최종안이 짧으면(80자 미만) 같은 라운드의 앞 AI 답이 최종 답변으로 표시된다', () => {
  const { m, sent, reply } = room();
  m.say('정리해 줘');
  reply('claude', LONG);
  reply('codex', '보탤 것 없습니다\n[완료]');
  assert.equal(m.status, 'running'); assert.equal(sent.length, 3); assert.equal(sent[2].agent, 'claude');
  reply('claude', '동의\n[완료]');
  assert.equal(m.status, 'idle');
  const [c1, x, c2] = m.messages.filter((e) => e.from !== 'user');
  assert.equal(c1.final, true); assert.equal(x.final, undefined); assert.equal(c2.final, undefined);
  assert.equal(m.round.final, c1);
});

test('같은 AI 가 [완료] 를 연달아 써도 합의가 아니다', () => {
  const a = room();
  a.m.auto = false;
  a.m.say('정리', 'claude');
  a.reply('claude', '끝\n[완료]');
  assert.equal(a.m.status, 'idle'); assert.equal(a.m.round.final, null); assert.equal(a.sent.length, 1);

  const b = room();
  b.m.say('정리', 'claude');
  b.reply('claude', '끝\n[완료]');
  assert.equal(b.sent.length, 2); assert.equal(b.sent[1].agent, 'codex'); assert.equal(b.m.round.final, null);
  assert.equal(b.m.round.proposal, b.m.messages.find((e) => e.from === 'claude'));
});

test('[완료] 뒤에 상대가 [질문] 하면 합의가 끊기고 질문 대기가 된다', () => {
  const { m, reply } = room();
  m.say('시작');
  reply('claude', `${LONG}\n[완료]`);
  reply('codex', '[질문] 하나만 확인할게요');
  assert.equal(m.status, 'question'); assert.equal(m.asker, 'codex');
  assert.equal(m.round.proposal, null); assert.equal(m.round.final, null);
});

test('[완료] 뒤 상대 차례에서 오류가 나면 합의 없이 멈추고, 다음 메시지는 새 라운드로 시작한다', () => {
  const { m, sent, reply } = room();
  m.say('시작');
  reply('claude', `${LONG}\n[완료]`);
  assert.ok(m.round.proposal);
  m.handle('codex', { type: 'done', ok: false, error: '한도 초과' });
  assert.equal(m.status, 'error'); assert.equal(m.round.final, null);
  m.say('다시');
  assert.equal(m.round.proposal, null); assert.equal(m.round.final, null); assert.equal(sent.at(-1).agent, 'claude');
});

test('상대 차례 중 끼어든 메시지는 [완료] 합의를 끊는다', () => {
  const { m, sent, reply } = room();
  m.say('시작');
  reply('claude', `${LONG}\n[완료]`);
  assert.equal(m.running, 'codex');
  m.say('잠깐, 이것도 봐', 'claude');
  reply('codex', '동의\n[완료]');
  assert.equal(m.round.final, null); assert.equal(m.round.proposal, null);
  assert.equal(m.status, 'running'); assert.equal(sent.at(-1).agent, 'claude', '끼어들기 경로로 지정한 상대가 받는다');
  assert.ok(m.messages.every((e) => !e.final));
});

test('계획 승인 흐름: 계획 합의 → 구현 담당의 승인 [질문] → 사용자 선택 → 구현 보고 [완료] → 검토 [완료] 로 합의', () => {
  const { m, sent, reply } = room();
  m.say('로그인 기능 만들어 줘');
  reply('claude', '계획: 로그인 모듈 추가');
  reply('codex', '계획에 동의합니다');
  assert.equal(sent.length, 3); assert.equal(sent[2].agent, 'claude');
  reply('claude', '[질문] 이 계획대로 구현할까요?\n[선택] 구현 진행\n[선택] 계획 수정');
  assert.equal(m.status, 'question'); assert.equal(m.asker, 'claude'); assert.equal(m.round.final, null);
  m.say('선택: 구현 진행', 'claude');
  assert.equal(sent.length, 4); assert.equal(sent[3].agent, 'claude');
  reply('claude', `${LONG}\n[완료]`);
  assert.equal(sent.length, 5); assert.equal(sent[4].agent, 'codex');
  reply('codex', '검토 통과\n[완료]');
  assert.equal(m.status, 'idle');
  const report = m.messages.filter((e) => e.from === 'claude').at(-1);
  assert.equal(m.round.final, report); assert.equal(report.final, true);
});

test('진행자 안내: 상대가 [완료] 로 최종안을 내면 그 사실을 알리고, 평소에는 만족하면 [완료] 하라고 안내한다', () => {
  const { m, sent, reply } = room();
  m.say('정리해 줘');
  assert.match(sent[0].text, /결론에 만족하면 마지막 줄에 \[완료\]/);
  assert.doesNotMatch(sent[0].text, /최종안을 냈습니다/);
  reply('claude', `${LONG}\n[완료]`);
  assert.match(sent[1].text, /상대\(Claude\)가 \[완료\] 로 최종안을 냈습니다/);
  reply('codex', '반론이 있습니다');
  assert.match(sent[2].text, /결론에 만족하면 마지막 줄에 \[완료\]/);
  assert.doesNotMatch(sent[2].text, /최종안을 냈습니다/);
});

test('현재 요청 줄: 첫 요청이 매 턴 프롬프트에 붙고, 질문 답·중단 뒤 답·끼어들기로는 바뀌지 않으며 새 요청이면 바뀐다', () => {
  const goalOf = (text) => text.match(/현재 요청\(최종 목표\): (.*)\n/)?.[1];
  const a = room();
  a.m.say('결제 붙여 줘');
  assert.match(a.sent[0].text.split('\n')[0], /^\[협업 대화\] 구현 담당: Claude \(당신\)$/);
  assert.equal(goalOf(a.sent[0].text), '결제 붙여 줘');
  a.reply('claude', '[질문] 어떤 PG?\n[선택] 토스\n[선택] 카카오');
  a.reply('codex', '의견');
  assert.equal(a.m.status, 'question');
  a.m.say('선택: 토스', 'claude');
  assert.equal(goalOf(a.sent.at(-1).text), '결제 붙여 줘', '질문 답은 목표를 바꾸지 않는다');

  const b = room(); // 구현 담당은 claude, 질문은 codex
  b.m.say('범위 정하기', 'codex'); b.reply('codex', '[질문] 범위는?');
  b.m.say('답'); b.reply('codex', '[질문] 더 구체적으로는?');
  assert.equal(b.m.running, 'claude');
  b.m.halt();
  b.m.say('넓게');
  assert.equal(b.sent.at(-1).agent, 'codex');
  assert.equal(goalOf(b.sent.at(-1).text), '범위 정하기', '상대 차례에서 중단한 뒤 답해도 유지');

  const c = room();
  c.m.say('원래 요청');
  c.m.say('끼어들기 내용');
  c.reply('claude', '의견');
  assert.equal(c.sent[1].agent, 'codex'); assert.equal(goalOf(c.sent[1].text), '원래 요청', '진행 중 끼어들기는 유지');

  const d = room();
  d.m.auto = false;
  d.m.say('첫 요청', 'claude'); d.reply('claude', '끝');
  assert.equal(d.m.status, 'idle');
  d.m.say('새 요청', 'claude');
  assert.equal(goalOf(d.sent[1].text), '새 요청', 'idle 뒤 새 요청이면 바뀐다');

  const e = room();
  e.m.say('줄1\n\n줄2   줄3', 'claude');
  assert.equal(goalOf(e.sent[0].text), '줄1 줄2 줄3', '여러 줄은 한 줄로');
  const f = room();
  f.m.say('가'.repeat(400), 'claude');
  assert.equal(goalOf(f.sent[0].text).length, 300, '300자로 자름');
});

test('자동 이어가기를 꺼도 「모두에게」 는 첫 AI 가 [완료] 해도 두 번째 답 뒤에 멈춘다', () => {
  const { m, sent, reply } = room();
  m.auto = false;
  m.say('정리', 'all');
  reply('claude', '끝\n[완료]');
  assert.equal(sent.length, 2);
  reply('codex', '네');
  assert.equal(m.status, 'idle'); assert.equal(sent.length, 2);
});

test('대상을 직접 정해 보낸 메시지에 [질문] 하면 바로 사용자 답을 기다린다', () => {
  const { m, sent, reply } = room();
  m.say('결제 어떻게?', 'claude');
  reply('claude', '[질문] 토스로 갈까요?');
  assert.equal(m.status, 'question'); assert.equal(sent.length, 1);
});

test('두 AI 가 모두 질문하면 둘 다 살아 있다가 사용자가 답하는 순간 함께 꺼지고, 답은 먼저 질문한 쪽부터 받는다', () => {
  const { m, sent, reply } = room();
  m.say('방향 정하자');
  reply('claude', '[질문] A 로 갈까요?');
  reply('codex', '[질문] B 는요?');
  assert.equal(m.status, 'question'); assert.equal(m.asker, 'claude');
  assert.deepEqual(m.round.askers, ['claude', 'codex']);
  const [c, x] = m.messages.filter((e) => e.from !== 'user');
  assert.ok(m.isActiveQuestion(c) && m.isActiveQuestion(x));
  m.say('답');
  assert.ok(!m.isActiveQuestion(c) && !m.isActiveQuestion(x));
  reply('claude', '반영');
  assert.deepEqual(sent.slice(2).map((s) => s.agent), ['claude', 'codex'], '첫 질문자부터 둘 다');
});

test('한 답에 [질문] 과 [완료] 가 같이 있으면 질문이 이기고, 라운드가 끝나면 상대의 [질문] 도 합쳐진다', () => {
  const { m, sent, reply } = room();
  m.say('시작');
  reply('claude', '[질문] 어느 쪽?\n[완료]');
  reply('codex', '평범한 답');
  assert.equal(m.status, 'question'); assert.equal(m.asker, 'claude');

  const b = room();
  b.m.say('시작');
  b.reply('claude', '정리\n[완료]');
  b.reply('codex', '[질문] 하나만 확인할게요');
  assert.equal(b.m.status, 'question'); assert.equal(b.m.asker, 'codex');
  assert.equal(b.sent.length, 2);
});

test('질문이 있던 라운드에 끼어들면 라운드가 새로 시작되고, 상대 차례에서 중단해도 다음 답은 질문한 쪽이 먼저 받는다', () => {
  const { m, sent, reply } = room();
  m.say('시작');
  reply('claude', '[질문] 어느 쪽?');
  const q = m.messages.find((e) => e.from === 'claude');
  m.say('Codex 는 이것도 봐', 'codex');
  reply('codex', '봤어요');
  assert.deepEqual(m.round.askers, [], '끼어들기로 라운드 초기화');
  assert.ok(!m.isActiveQuestion(q));

  const c = room(); // 구현 담당은 claude, 질문은 codex
  c.m.say('q', 'codex'); c.reply('codex', '[질문] 범위는?');
  c.m.say('답'); c.reply('codex', '[질문] 더 구체적으로는?');
  assert.equal(c.m.running, 'claude');
  c.m.halt();
  assert.equal(c.m.status, 'stopped');
  c.m.say('넓게');
  assert.equal(c.sent.at(-1).agent, 'codex', '구현 담당이 아니라 질문한 쪽부터');
});

test('[질문]·[완료] 판정은 CRLF 줄바꿈과 불릿·굵게 꾸밈도 알아보고, 문장 속 ``` 는 코드 블록으로 보지 않는다', () => {
  assert.deepEqual(parseQuestion('[질문] q\r\n[선택] A — a\r\n[선택] B\r\n').choices, [{ name: 'A', desc: 'a' }, { name: 'B', desc: '' }]);
  assert.equal(parseQuestion('- [질문] 고를까요?\n[선택] A\n[선택] B').question, '고를까요?');
  assert.equal(parseQuestion('**[질문] 고를까요?**\n[선택] A\n[선택] B').question, '고를까요?');
  assert.equal(parseQuestion('설명: ``` 로 감싸면 됩니다\n[질문] 진행?\n[선택] 예\n[선택] 아니오').choices.length, 2);
  assert.equal(parseQuestion('~~~\n[질문] q\n[선택] A\n[선택] B\n~~~'), null, '~~~ 블록도 무시');
  assert.deepEqual(parseQuestion('- [질문] q\n  - [선택] A\n  - [선택] B').choices.map((c) => c.name), ['A', 'B'], '들여쓴 [선택] 중첩 목록');
  assert.equal(parseQuestion('[질문] **무엇?**\n[선택] A\n[선택] B').question, '무엇?');
  assert.equal(stripCode('```[질문]``` 태그를 쓰세요\n[질문] y'), '```[질문]``` 태그를 쓰세요\n[질문] y', '뒤 글에 백틱이 있으면 펜스 아님');
  const t = Date.now(); stripCode('`'.repeat(100000)); assert.ok(Date.now() - t < 200, '긴 백틱 줄도 빠르게');
  const crlf = room(); // CRLF [완료] 두 번이 이어져야 합의
  crlf.m.say('시작');
  crlf.reply('claude', '정리\r\n[완료]\r\n'); crlf.reply('codex', '동의\r\n[완료]\r\n');
  assert.equal(crlf.m.status, 'idle'); assert.equal(crlf.sent.length, 2); assert.ok(crlf.m.round.final);
  for (const [text, want] of [['* [질문] 괜찮을까요?', 'question'], ['설명: ``` 로 감쌉니다\n[질문] 진행?', 'question']]) {
    const { m, sent, reply } = room();
    m.say('시작', 'claude');
    reply('claude', text);
    assert.equal(sent.length, 1, text); assert.equal(m.status, want, text);
  }
  const { m, sent, reply } = room();
  m.say('시작', 'claude');
  reply('claude', '> [질문] 어느 쪽?\n\n저는 A 입니다.');
  assert.equal(sent.length, 2, '인용한 질문은 질문이 아니다');
});

test('parseQuestion: 굵게 감싼 이름·콜론 위치·빈 이름', () => {
  assert.deepEqual(parseQuestion('[질문] q\n**[선택] 토스** — 수수료\n[선택] **A안:** 캐시').choices,
    [{ name: '토스', desc: '수수료' }, { name: 'A안', desc: '캐시' }]);
  assert.deepEqual(parseQuestion('[질문] 몇 시?\n[선택] 10:30 회의\n[선택] http://a.com\n[선택] http://b.com').choices.map((c) => c.name),
    ['10:30 회의', 'http://a.com', 'http://b.com'], '뒤에 공백 없는 콜론은 나누지 않음');
  assert.deepEqual(parseQuestion('[질문] q\n[선택] 10：30 회의\n[선택] __A:__ b').choices.map((c) => c.name), ['10：30 회의', 'A'], '숫자 앞 전각 콜론·__ 굵게');
  assert.deepEqual(parseQuestion('[질문] q\n[선택] — 설명만\n[선택] A\n[선택] B').choices.map((c) => c.name), ['A', 'B'], '이름이 비면 버림');
});

test('구현 담당이 Codex 여도 「모두에게」 의 Codex [질문] 은 Claude 차례를 지난 뒤 Codex 가 질문자로 남는다', () => {
  const { m, sent, reply } = room();
  m.owner = 'codex';
  m.say('시작');
  reply('codex', '[질문] 범위는?');
  assert.equal(sent.length, 2); assert.equal(sent[1].agent, 'claude');
  reply('claude', '의견');
  assert.equal(m.status, 'question'); assert.equal(m.asker, 'codex');
});

test('이전 라운드의 질문 버튼은 새 질문이 와도 되살아나지 않는다', () => {
  const { m, reply } = room();
  m.say('시작', 'claude');
  reply('claude', '[질문] 어떤 PG?\n[선택] 토스 — 간편\n[선택] 카카오 — 큰 사용자');
  const first = m.messages.at(-1);
  assert.equal(first.question.choices.length, 2); assert.ok(m.isActiveQuestion(first));
  m.say('선택: 토스', 'claude');
  assert.ok(!m.isActiveQuestion(first));
  reply('claude', '[질문] 진행할까요?');
  const second = m.messages.at(-1);
  assert.equal(m.status, 'question');
  assert.ok(!m.isActiveQuestion(first), '1라운드 질문은 꺼진 채');
  assert.ok(m.isActiveQuestion(second)); assert.equal(second.question, null);
});

test('두 번째 차례에서 오류가 나면 앞 AI 의 질문은 꺼지고, 다음 메시지는 구현 담당부터 시작한다', () => {
  const { m, sent, reply } = room();
  m.say('시작');
  reply('claude', '[질문] 어느 쪽?');
  const q = m.messages.find((e) => e.from === 'claude');
  m.handle('codex', { type: 'done', ok: false, error: '한도 초과' });
  assert.equal(m.status, 'error'); assert.ok(!m.isActiveQuestion(q));
  m.say('다시');
  assert.equal(sent.at(-1).agent, 'claude');
});

test('코드 블록 안의 [질문] 은 질문으로 보지 않는다', () => {
  const { m, sent, reply } = room();
  m.say('형식 알려 줘', 'claude');
  reply('claude', '예시입니다\n```\n[질문] 형식\n[선택] A — a\n```\n끝');
  assert.equal(sent.length, 2, '질문이 아니라 자동으로 Codex 에게 넘어간다');
  assert.equal(m.status, 'running'); assert.equal(m.messages.find((e) => e.from === 'claude').question, undefined);
});

test('stripCode: 닫힌 코드 블록과 닫히지 않은 코드 블록을 지운다', () => {
  assert.equal(stripCode('가\n```js\n[질문] x\n```\n나'), '가\n\n나');
  assert.equal(stripCode('가\n```\n[질문] x\n끝까지'), '가\n');
  assert.equal(stripCode(null), '');
});

test('parseQuestion: 기본 형식, 불릿·번호, 구분자, 설명 없음', () => {
  assert.deepEqual(parseQuestion('앞말\n[질문] 어떤 PG?\n[선택] 토스 — 간편\n[선택] 카카오 — 큰 사용자'),
    { question: '어떤 PG?', choices: [{ name: '토스', desc: '간편' }, { name: '카카오', desc: '큰 사용자' }] });
  const bullets = parseQuestion('[질문] 고르세요\n- [선택] 가\n1. [선택] 나\n2) [선택] 다');
  assert.deepEqual(bullets.choices.map((c) => c.name), ['가', '나', '다']);
  for (const sep of [' — ', ' – ', ' - ', ': ', '：']) {
    assert.deepEqual(parseQuestion(`[질문] q\n[선택] A${sep}설명\n[선택] B`).choices[0], { name: 'A', desc: '설명' }, `구분자 ${sep}`);
  }
  assert.deepEqual(parseQuestion('[질문] q\n[선택] A안: 캐시 - 빠름\n[선택] B').choices[0], { name: 'A안', desc: '캐시 - 빠름' }, '가장 앞 구분자');
  assert.deepEqual(parseQuestion('[질문] q\n[선택] A-B 방식\n[선택] C').choices[0], { name: 'A-B 방식', desc: '' }, '공백 없는 하이픈은 구분자가 아님');
});

test('parseQuestion: 마크다운 장식과 줄 모양 예외', () => {
  const md = parseQuestion('[질문] q\n- **[선택]** **토스** — 수수료\n`[선택]` 카카오\n**[선택] 네이버 — 간편**');
  assert.deepEqual(md.choices, [{ name: '토스', desc: '수수료' }, { name: '카카오', desc: '' }, { name: '네이버', desc: '간편' }]);
  assert.deepEqual(parseQuestion('[질문] q\n설명 줄입니다\n[선택] A\n[선택] B').choices.map((c) => c.name), ['A', 'B'], '질문 뒤 설명 줄은 건너뜀');
  assert.deepEqual(parseQuestion('[질문] q\n[선택] A\n    A 의 하위 설명\n[선택] B').choices.map((c) => c.name), ['A', 'B'], '들여쓴 줄은 건너뜀');
  assert.deepEqual(parseQuestion('[질문] q\n[선택] A\n[선택] B\n다른 글\n[선택] C').choices.map((c) => c.name), ['A', 'B'], '선택 뒤 다른 글이면 거기까지');
  assert.deepEqual(parseQuestion('[ 질문 ] q\n[ 선택 ] A\n[ 선택 ] B'), { question: 'q', choices: [{ name: 'A', desc: '' }, { name: 'B', desc: '' }] });
});

test('parseQuestion: 개수·중복·길이·마지막 질문·없는 경우', () => {
  assert.equal(parseQuestion('[질문] q\n[선택] A'), null, '1개면 null');
  const nine = Array.from({ length: 9 }, (_, i) => `[선택] 항목${i}`).join('\n');
  assert.equal(parseQuestion(`[질문] q\n${nine}`).choices.length, 8);
  assert.deepEqual(parseQuestion('[질문] q\n[선택] Abc\n[선택] abc\n[선택] D').choices.map((c) => c.name), ['Abc', 'D'], '대소문자 무시 중복 제거');
  assert.deepEqual(parseQuestion('[질문] 옛\n[선택] X\n[선택] Y\n[질문] 새\n[선택] A\n[선택] B').question, '새', '마지막 [질문] 기준');
  assert.equal(parseQuestion('```\n[질문] q\n[선택] A\n[선택] B\n```'), null, '코드 블록 안은 무시');
  assert.equal(parseQuestion('질문 없음\n[선택] A\n[선택] B'), null);
  assert.equal(parseQuestion(`[질문] q\n[선택] ${'가'.repeat(70)}\n[선택] B`).choices[0].name.length, 60);
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
  reply('codex', '네');
  assert.equal(sent.length, 3); assert.equal(sent[2].agent, 'claude', '답하던 쪽도 그 메시지에 답한다');

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

test('코드 위주 최종안도 최종 답변으로 표시하고, 꾸민 [완료] 도 합의로 본다', () => {
  const { m, reply } = room();
  m.say('고쳐 줘');
  reply('claude', '반론입니다');
  reply('codex', `수정안:\n\`\`\`js\n${'const a = 1;\n'.repeat(20)}\`\`\`\n[완료]`);
  reply('claude', '동의\n**[완료]**');
  const fix = m.messages.find((e) => e.from === 'codex');
  assert.equal(m.status, 'idle'); assert.equal(m.round.final, fix);
  assert.ok(!m.messages.find((e) => e.text === '반론입니다').final);
});

test('자동 이어가기를 꺼도 「모두에게」 두 AI 가 이어서 [완료] 하면 합의다', () => {
  const { m, reply } = room();
  m.auto = false;
  m.say('정리');
  reply('claude', `${'정리 내용 '.repeat(10)}\n[완료]`);
  reply('codex', '- [완료]');
  assert.equal(m.status, 'idle'); assert.equal(m.round.final, m.messages.find((e) => e.from === 'claude'));
});

test('오류·중단 뒤 이어 가자는 말은 현재 요청을 바꾸지 않고, 상대 최종안 안내에도 계획 단계 예외가 붙는다', () => {
  const { m, sent, reply } = room();
  m.say('로그인 만들어 줘', 'claude');
  m.handle('claude', { type: 'done', ok: false, error: '끊김' });
  m.say('다시', 'claude');
  assert.match(sent.at(-1).text, /현재 요청\(최종 목표\): 로그인 만들어 줘/);
  m.halt();
  m.say('계속해', 'claude');
  assert.match(sent.at(-1).text, /현재 요청\(최종 목표\): 로그인 만들어 줘/);
  reply('claude', '계획 A\n[완료]');
  assert.match(sent.at(-1).text, /최종안을 냈습니다[\s\S]*구현 전 계획이라면 \[완료\] 대신 구현 담당이 승인 \[질문\]/);
});

test('구현 담당을 정하지 않으면 계획 합의 뒤 Claude 가 승인과 담당을 함께 묻도록 안내한다', () => {
  const { m, sent } = room();
  m.owner = 'ask';
  m.say('기능 추가');
  assert.match(sent[0].text, /당신\(Claude\)이 구현 승인과 구현 담당을 한 \[질문\] 으로 사용자에게 묻습니다/);
  m.handle('claude', { type: 'text', text: '계획 A' }); m.handle('claude', { type: 'done', ok: true });
  assert.match(sent[1].text, /당신\(Codex\)은 승인 \[질문\] 을 내지 말고/);
});

test('상대 차례에서 중단돼도 질문 답을 기다리는 동안 선택지 버튼은 살아 있다', () => {
  const { m, reply } = room();
  m.say('시작');
  reply('claude', '[질문] 어느 쪽?\n[선택] A\n[선택] B');
  const q = m.messages.find((e) => e.from === 'claude');
  assert.ok(!m.isActiveQuestion(q), 'Codex 가 답하는 중에는 아직 아님');
  m.halt();
  assert.ok(m.isActiveQuestion(q));
  m.say('선택: A', 'claude');
  assert.ok(!m.isActiveQuestion(q));
});

// 진행 중 메시지 반영(steer): result 가 true/false/throw/Promise 인 가짜 steer 를 단 방
function steerRoom(result = true) {
  const calls = [];
  const r = room({ steer: (agent, text, turn) => { calls.push({ agent, text, turn }); return typeof result === 'function' ? result() : result; } });
  return { ...r, calls };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test('입력 버튼 상태: 글이 있으면 보내기, 빈 입력이면 답변 중에만 중단, 그 밖은 비활성', () => {
  for (const s of ['idle', 'running', 'question', 'stopped', 'error']) assert.equal(inputMode('안녕', s), 'send', s);
  assert.equal(inputMode('', 'running'), 'stop');
  for (const s of ['idle', 'question', 'stopped', 'error']) assert.equal(inputMode('', s), 'idle', s);
  assert.equal(inputMode('  \n ', 'running'), 'stop', '공백만이면 글 없음');
  assert.equal(inputMode(null, 'idle'), 'idle');
});

test('Claude 답변 중 「모두에게」: 바로 넣고, 받았다는 확인이 오면 말풍선을 나눠 반영한 답을 새 말풍선에 받으며 상대가 이어 답한다', () => {
  const { m, sent, calls, reply } = steerRoom();
  m.say('시작');
  m.handle('claude', { type: 'text', text: '앞글' });
  const before = m.current;
  m.say('보안도 봐줘');
  const um = m.messages.at(-1);
  assert.deepEqual(calls, [{ agent: 'claude', text: '[사용자] 보안도 봐줘', turn: sent[0].turn }]);
  assert.equal(m.interjection, null); assert.equal(um.steering, 'claude'); assert.equal(sent.length, 1);
  assert.equal(m.goal, '시작', '진행 중 메시지는 목표를 바꾸지 않는다');
  m.handle('claude', { type: 'steered', turn: sent[0].turn });
  const now = m.current;
  assert.equal(before.streaming, false); assert.notEqual(now, before);
  assert.ok(now.streaming && now.from === 'claude' && now.turn === before.turn);
  assert.equal(um.steering, null); assert.equal(um.steered, 'claude'); assert.equal(m.round.start, m.messages.indexOf(now));
  m.handle('claude', { type: 'text', text: '반영한 답' }); m.handle('claude', { type: 'done', ok: true });
  assert.equal(now.text, '반영한 답'); assert.equal(before.text, '앞글');
  assert.equal(sent.length, 2); assert.equal(sent[1].agent, 'codex');
  assert.match(sent[1].text, /\[Claude\] 앞글[\s\S]*\[사용자\] 보안도 봐줘[\s\S]*\[Claude\] 반영한 답/);
  reply('codex', '의견');
  assert.equal(sent[2].agent, 'claude');
  assert.ok(!/보안도 봐줘/.test(sent[2].text), '이미 받은 사용자 메시지는 다시 보내지 않는다');
});

test('두 메시지를 넣고 하나만 확인된 뒤 멈추거나 끝나도, 확인 안 된 메시지는 Claude 다음 프롬프트에 들어간다', () => {
  for (const end of ['halt', 'ok', 'fail']) {
    const { m, sent } = steerRoom();
    m.auto = false;
    m.say('시작', 'claude');
    m.say('A 지시', 'claude'); m.say('B 지시', 'claude');
    m.handle('claude', { type: 'steered' });
    if (end === 'halt') m.halt();
    else m.handle('claude', { type: 'done', ok: end === 'ok', error: '끊김' });
    if (end !== 'ok') m.say('계속', 'claude');
    const last = sent.at(-1);
    assert.equal(last.agent, 'claude', end);
    assert.match(last.text, /B 지시/, `${end}: 확인 안 된 B 는 전달`);
    assert.ok(!/A 지시/.test(last.text), `${end}: 이미 받은 A 는 다시 안 보냄`);
  }
});

test('Claude 진행 중 Codex 에게 보낸 메시지는 그 뒤 Claude 가 다른 메시지를 받아도 Claude 다음 프롬프트에서 빠지지 않는다', () => {
  const { m, sent, reply } = steerRoom();
  m.say('시작', 'claude');
  m.say('Codex 만 봐', 'codex');
  m.say('Claude 지시', 'claude');
  m.handle('claude', { type: 'steered' });
  reply('claude', '반영');
  assert.equal(sent[1].agent, 'codex'); assert.match(sent[1].text, /Codex 만 봐/);
  reply('codex', '확인');
  assert.equal(sent[2].agent, 'claude'); assert.match(sent[2].text, /Codex 만 봐/);
});

test('「모두에게」로 시작한 라운드에서 Claude 에게만 넣으면 남은 Codex 차례를 지운다 (지정한 상대만)', () => {
  const { m, sent } = steerRoom();
  m.auto = false;
  m.say('시작');
  assert.deepEqual(m.pending, ['codex']);
  m.say('Claude 만', 'claude');
  assert.deepEqual(m.pending, []);
  m.handle('claude', { type: 'steered' });
  m.handle('claude', { type: 'text', text: '답' }); m.handle('claude', { type: 'done', ok: true });
  assert.equal(sent.length, 1); assert.equal(m.status, 'idle');
});

test('확인 없이 끝난 메시지와 앞선 끼어들기가 섞이면, 하나라도 모두에게면 모두에게로 이어 답한다', () => {
  const { m, sent } = steerRoom();
  m.auto = false;
  m.say('시작', 'claude');
  m.say('Codex 만', 'codex');
  m.say('둘 다 봐');
  m.handle('claude', { type: 'text', text: '답' }); m.handle('claude', { type: 'done', ok: true });
  assert.deepEqual(sent.slice(1).map((s) => s.agent), ['codex']);
  m.handle('codex', { type: 'text', text: '의견' }); m.handle('codex', { type: 'done', ok: true });
  assert.deepEqual(sent.slice(1).map((s) => s.agent), ['codex', 'claude'], '모두에게라 Claude 도 답한다');
  assert.match(sent[2].text, /둘 다 봐/);
});

test('아무것도 쓰기 전에 받았다는 확인이 오면 앞 말풍선은 숨긴다', () => {
  const { m, sent } = steerRoom();
  m.say('시작', 'claude');
  const before = m.current;
  m.say('방향 바꿔', 'claude');
  m.handle('claude', { type: 'steered' });
  assert.equal(before.skip, true); assert.equal(before.streaming, false);
  const typed = steerRoom();
  typed.m.say('시작', 'claude'); typed.m.handle('claude', { type: 'tool', name: 'Bash', input: {} });
  const b2 = typed.m.current;
  typed.m.say('방향 바꿔', 'claude'); typed.m.handle('claude', { type: 'steered' });
  assert.ok(!b2.skip, '도구를 쓴 말풍선은 숨기지 않는다'); assert.equal(sent.length, 1);
});

test('대상별 steer: Claude 지정은 상대를 더하지 않고, 상대 지정은 기존 끼어들기, Codex 답변 중 「모두에게」·codex 지정은 Codex 에 넣는다', () => {
  const a = steerRoom();
  a.m.say('시작', 'claude'); a.m.say('보충', 'claude');
  assert.equal(a.calls.length, 1); assert.deepEqual(a.m.pending, []);
  const all = steerRoom();
  all.m.say('시작', 'claude'); all.m.say('보충');
  assert.deepEqual(all.m.pending, ['codex'], '모두에게면 이 턴 뒤 상대도 답한다');
  const b = steerRoom();
  b.m.say('시작', 'claude'); b.m.say('코덱스만', 'codex');
  assert.equal(b.calls.length, 0); assert.equal(b.m.interjection, 'codex');
  const c = steerRoom();
  c.m.owner = 'codex';
  c.m.say('시작'); c.m.say('끼어들기');
  assert.equal(c.calls.length, 1); assert.equal(c.calls[0].agent, 'codex'); assert.equal(c.calls[0].text, '[사용자] 끼어들기');
  assert.equal(c.m.interjection, null); assert.equal(c.m.messages.at(-1).steering, 'codex');
  const d = steerRoom();
  d.m.owner = 'codex';
  d.m.say('시작'); d.m.say('코덱스만', 'codex');
  assert.equal(d.calls.length, 1); assert.equal(d.calls[0].agent, 'codex');
  const e = steerRoom();
  e.m.owner = 'codex';
  e.m.say('시작'); e.m.say('클로드만', 'claude');
  assert.equal(e.calls.length, 0); assert.equal(e.m.interjection, 'claude', '상대에게 보낸 메시지는 다음 차례');
  const none = room(); // steer 없는 방 = 기존 끼어들기 그대로
  none.m.say('시작'); none.m.say('끼어들기');
  assert.equal(none.m.interjection, 'all'); assert.equal(none.m.messages.at(-1).steering, undefined);
});

test('받았다는 확인 전에 정상 종료되면 끼어들기로 대체한다 (모두에게면 상대 → Claude 순서)', () => {
  const { m, sent, reply } = steerRoom();
  m.say('시작'); m.say('끼어들기');
  const um = m.messages.at(-1);
  reply('claude', '답');
  assert.equal(um.steering, null);
  assert.equal(sent.length, 2); assert.equal(sent[1].agent, 'codex'); assert.match(sent[1].text, /\[사용자\] 끼어들기/);
  reply('codex', '의견');
  assert.equal(sent[2].agent, 'claude');
});

test('받았다는 확인 전에 중단하거나 실패하면 steering 을 풀고 다음 프롬프트에 그 메시지가 들어간다', () => {
  const h = steerRoom();
  h.m.say('시작', 'claude'); h.m.say('보충', 'claude');
  const hm = h.m.messages.at(-1);
  h.m.halt();
  assert.equal(hm.steering, null);
  h.m.say('계속', 'claude');
  assert.match(h.sent[1].text, /\[사용자\] 보충/);
  const f = steerRoom();
  f.m.say('시작', 'claude'); f.m.say('보충', 'claude');
  const fm = f.m.messages.at(-1);
  f.m.handle('claude', { type: 'done', ok: false, error: '끊김' });
  assert.equal(fm.steering, null); assert.equal(f.m.status, 'error');
  f.m.say('다시', 'claude');
  assert.match(f.sent[1].text, /\[사용자\] 보충/);
});

test('steer 가 false·throw·reject 면 같은 턴은 기존 끼어들기로, 이미 턴이 끝났으면 새 메시지처럼 바로 보낸다', async () => {
  for (const result of [false, () => { throw new Error('x'); }, () => Promise.reject(new Error('x')), () => Promise.resolve(false)]) {
    const { m, sent, reply } = steerRoom(result);
    m.say('시작', 'claude'); m.say('보충', 'claude');
    await flush();
    const um = m.messages.at(-1);
    assert.equal(um.steering, null); assert.equal(m.interjection, 'claude');
    reply('claude', '답');
    assert.equal(sent.length, 2); assert.equal(sent[1].agent, 'claude'); assert.match(sent[1].text, /\[사용자\] 보충/);
  }
  // 거부 응답이 늦게 와서 그 사이 턴이 끝나 있던 경우 (방어 분기 — 상태를 직접 비워 재현)
  let reject;
  const late = steerRoom(() => new Promise((_, rej) => { reject = rej; }));
  late.m.say('시작', 'claude'); late.m.say('보충', 'claude');
  late.m.running = null; late.m.current = null;
  reject(new Error('x'));
  await flush();
  assert.equal(late.sent.length, 2); assert.equal(late.sent[1].agent, 'claude');
});

test('steer 로 나뉜 새 말풍선의 [완료] 와 상대 동의가 합의가 되면 최종 답변은 새 말풍선이다', () => {
  const { m, reply } = steerRoom();
  m.say('시작'); m.handle('claude', { type: 'text', text: '앞 말풍선' });
  const before = m.current;
  m.say('보충');
  m.handle('claude', { type: 'steered' });
  const now = m.current;
  reply('claude', `${'최종안 내용 '.repeat(20)}\n[완료]`);
  reply('codex', '동의\n[완료]');
  assert.equal(m.status, 'idle'); assert.equal(m.round.final, now); assert.ok(now.final); assert.ok(!before.final);
});

test('나뉘기 전 말풍선의 [질문] 은 나뉜 뒤 판정에 쓰이지 않아 평범한 답이면 자동으로 이어 간다', () => {
  const { m, sent } = steerRoom();
  m.say('시작', 'claude');
  m.handle('claude', { type: 'text', text: '[질문] 어느 쪽?\n[선택] A\n[선택] B' });
  const old = m.messages.find((e) => e.from === 'claude');
  m.say('그냥 알아서', 'claude');
  m.handle('claude', { type: 'steered' });
  m.handle('claude', { type: 'text', text: '알겠습니다' }); m.handle('claude', { type: 'done', ok: true });
  assert.equal(m.status, 'running'); assert.equal(sent.at(-1).agent, 'codex');
  assert.deepEqual(m.round.askers, []); assert.ok(!old.question && !m.isActiveQuestion(old));
});

test('글도 도구 사용도 없이 끝난 AI 발언은 빈 발언으로 보고(화면에서 숨김), 내용이 있었으면 그대로 둔다', () => {
  assert.equal(isEmptyReply({ from: 'claude', text: '', tools: [], streaming: false }), true);
  assert.equal(isEmptyReply({ from: 'codex', text: '  \n ', tools: [], streaming: false }), true);
  assert.equal(isEmptyReply({ from: 'claude', text: '', tools: [], streaming: true }), false, '답변 중(생각 중…)은 보인다');
  assert.equal(isEmptyReply({ from: 'claude', text: '200', tools: [], streaming: false }), false);
  assert.equal(isEmptyReply({ from: 'claude', text: '', tools: [{ name: 'Bash', input: {} }], streaming: false }), false, '도구를 썼으면 보인다');
  assert.equal(isEmptyReply({ from: 'user', text: '', streaming: false }), false);
  const { m, sent } = room();
  m.say('100+100', 'claude');
  m.halt();
  assert.equal(isEmptyReply(m.messages.at(-1)), true, '아무것도 쓰기 전에 중단한 말풍선');
  m.say('다시', 'claude');
  m.handle('claude', { type: 'text', text: '20', turn: sent[1].turn });
  m.halt();
  assert.equal(isEmptyReply(m.messages.at(-1)), false, '쓰는 중에 중단하면 그대로 둔다');
});

// ───── 0C: 참여자(roster) 다자 진행 — 가짜 세 번째 AI 'x' 로 확인한다 (2명 동작은 위의 기존 테스트가 고정) ─────
import { OWNERS, nameOf, ownerOptions, targetsOf, mentionOf, agreedText, placeholderOf, effortLevels, EFFORT_IN_MODEL } from '../src/renderer/collab/moderator.js';

const room3 = (opts = {}) => room({ roster: ['claude', 'codex', 'x'], ...opts });

test('roster: 기본은 [claude, codex](동결), 잘못된 값은 오류, 구현 담당 기본은 claude 가 있으면 claude 아니면 첫 AI', () => {
  const { m } = room();
  assert.deepEqual([...m.roster], ['claude', 'codex']);
  assert.ok(Object.isFrozen(m.roster));
  assert.deepEqual(Object.keys(m.seen), ['claude', 'codex']);
  assert.deepEqual(Object.keys(m.prefs), ['claude', 'codex']);
  assert.deepEqual(Object.keys(m.catalog), ['claude', 'codex']);
  assert.equal(m.owner, 'claude');
  assert.equal(room({ roster: ['codex', 'x'] }).m.owner, 'codex');
  assert.deepEqual(Object.keys(room3().m.prefs), ['claude', 'codex', 'x']);
  for (const bad of [['claude'], [], ['claude', 'claude'], ['claude', 3], ['claude', ''], 'claude,codex', {}, ['claude', 'all'], ['ask', 'claude'], ['user', 'claude'], ['claude', 'system']]) {
    assert.throws(() => room({ roster: bad }), /잘못된 협업 참여자/, JSON.stringify(bad));
  }
});

test('roster 3명: 「모두에게」 는 구현 담당부터 한 바퀴 (claude→codex→x, 구현 담당 codex 면 codex→x→claude)', () => {
  const a = room3();
  a.m.say('안건');
  a.reply('claude', '의견 1'); a.reply('codex', '의견 2');
  assert.deepEqual(a.sent.map((s) => s.agent), ['claude', 'codex', 'x']);
  const b = room3();
  b.m.owner = 'codex';
  b.m.say('안건');
  b.reply('codex', '의견 1'); b.reply('x', '의견 2');
  assert.deepEqual(b.sent.map((s) => s.agent), ['codex', 'x', 'claude']);
  const c = room3();
  c.m.say('엑스부터', 'x');
  assert.deepEqual(c.sent.map((s) => s.agent), ['x'], '지정하면 그 AI 하나');
});

test('roster 3명: 자동 이어가기는 직전 발언자 다음 사람에게 넘기는 라운드 로빈', () => {
  const { m, sent, reply } = room3();
  m.say('시작', 'claude');
  for (let i = 0; i < 6; i++) reply(sent.at(-1).agent, `발언 ${i}`);
  assert.deepEqual(sent.map((s) => s.agent), ['claude', 'codex', 'x', 'claude', 'codex', 'x', 'claude']);
  const off = room3();
  off.m.auto = false;
  off.m.say('한 번만', 'codex');
  off.reply('codex', '끝');
  assert.equal(off.sent.length, 1); assert.equal(off.m.status, 'idle', '자동 이어가기를 끄면 지정한 상대만');
});

test('roster 3명: 합의는 제안한 AI 를 뺀 나머지 전원이 이어서 [완료] 를 써야 하고, 중간에 반론이 나오면 처음부터', () => {
  const { m, sent, reply } = room3();
  m.say('안건');
  reply('claude', '최종안입니다\n[완료]');
  reply('codex', '동의합니다\n[완료]');
  assert.equal(m.status, 'running'); assert.equal(m.running, 'x', '아직 x 차례 — 합의 전');
  assert.equal(m.round.final, null);
  reply('x', '동의합니다\n[완료]');
  assert.equal(m.status, 'idle');
  assert.equal(m.round.final.from, 'claude'); assert.equal(m.round.final.final, true);
  assert.equal(sent.length, 3);

  const b = room3();
  b.m.say('안건');
  b.reply('claude', '최종안입니다\n[완료]');
  b.reply('codex', '동의합니다\n[완료]');
  b.reply('x', '그런데 이 부분은 다릅니다');
  assert.equal(b.m.round.final, null); assert.equal(b.m.round.proposal, null); assert.equal(b.m.round.agreed.size, 0);
  assert.equal(b.m.status, 'running'); assert.equal(b.m.running, 'claude', '반론 뒤에는 다음 사람(claude)이 이어서');
});

test('roster 3명: 짧은 동의가 제안이면 같은 라운드 앞의 참여 AI 답(x 포함)이 최종 답변이다', () => {
  const { m, reply } = room3();
  m.owner = 'x';
  m.say('안건');
  reply('x', '긴 답변입니다. '.repeat(10));
  reply('claude', '동의\n[완료]');
  reply('codex', '동의\n[완료]');
  reply('x', '동의\n[완료]');
  assert.equal(m.status, 'idle');
  assert.equal(m.round.final.from, 'x'); assert.ok(m.round.final.text.length >= 80);
});

test('roster 3명: 여러 AI 가 [질문] 하면 askers 순서를 기억하고, 사용자 답은 첫 질문자부터 한 바퀴', () => {
  const { m, sent, reply } = room3();
  m.say('결제 붙여 줘');
  reply('claude', '의견입니다');
  reply('codex', '어떤 PG?\n[질문] 토스 / 카카오');
  reply('x', '범위는?\n[질문] 전체 / 일부');
  assert.equal(m.status, 'question');
  assert.deepEqual(m.round.askers, ['codex', 'x']);
  assert.equal(m.asker, 'codex');
  m.say('토스로', 'all');
  assert.deepEqual(sent.slice(3).map((s) => s.agent), ['codex'], '질문한 쪽이 먼저');
  reply('codex', '확인');
  reply('x', '확인'); reply('claude', '확인');
  assert.deepEqual(sent.slice(3, 6).map((s) => s.agent), ['codex', 'x', 'claude'], '첫 질문자부터 한 바퀴');
});

test('roster 3명: 답변 중 「모두에게」 끼어들기는 나머지 → 답하던 쪽 순서로 전원', () => {
  const { m, sent, reply } = room3();
  m.say('시작', 'claude');
  m.say('잠깐', 'all');
  assert.equal(sent.length, 1, '진행 중에는 새 턴을 만들지 않는다');
  reply('claude', '첫 의견');
  reply('codex', '둘째'); reply('x', '셋째');
  assert.deepEqual(sent.map((s) => s.agent), ['claude', 'codex', 'x', 'claude']);
});

test('roster 3명: steer 「모두에게」 는 나머지 둘을 대기열에 넣고, 진행 중 AI 지정은 다른 차례를 지운다', () => {
  const a = room3({ steer: () => true });
  a.m.say('시작', 'claude');
  a.m.say('덧붙임', 'all');
  assert.deepEqual(a.m.pending, ['codex', 'x']);
  a.m.say('또 덧붙임', 'all');
  assert.deepEqual(a.m.pending, ['codex', 'x'], '이미 있으면 중복해서 넣지 않는다');
  const b = room3({ steer: () => true });
  b.m.say('시작');
  assert.deepEqual(b.m.pending, ['codex', 'x']);
  b.m.say('너만', 'claude');
  assert.deepEqual(b.m.pending, [], 'claude 지정은 다른 사람 차례를 지운다');
});

test('roster 3명: x 의 프롬프트에는 claude·codex 발언이 들어가고 자기 발언은 빠지며, 이미 동의한 사람이 cue 에 나온다', () => {
  const { m, sent, reply } = room3();
  m.say('안건');
  reply('claude', '클로드 최종안\n[완료]');
  reply('codex', '코덱스 동의\n[완료]');
  assert.match(sent[2].text, /\[사용자\] 안건/);
  assert.match(sent[2].text, /\[Claude\] 클로드 최종안/);
  assert.match(sent[2].text, /\[Codex\] 코덱스 동의/);
  assert.match(sent[2].text, /— 당신\(x\) 차례입니다/);
  assert.match(sent[2].text, /상대\(Claude\)가 \[완료\] 로 최종안을 냈습니다[\s\S]*\(이미 동의: Codex\)$/);
  reply('x', 'x 반론');
  reply('claude', '재검토'); reply('codex', '재검토 동의');
  assert.equal(sent.at(-1).agent, 'x');
  assert.ok(!sent.at(-1).text.includes('x 반론'), '자기 발언은 다시 보내지 않는다');
  assert.match(sent.at(-1).text, /\[Claude\] 재검토/);
  assert.match(sent[3].text, /\[x\] x 반론/, 'claude 는 x 발언을 받는다');
});

test('roster 2명: cue 에 「이미 동의」 가 생기지 않는다', () => {
  const { m, sent, reply } = room();
  m.say('안건');
  reply('claude', '최종안\n[완료]');
  assert.match(sent[1].text, /상대\(Claude\)가 \[완료\] 로 최종안을 냈습니다/);
  assert.ok(!sent[1].text.includes('이미 동의'));
});

test('ownerLine(ask): 2명은 기존 문장 그대로, 3명은 「모두」 와 roster 첫 AI 가 묻는다', () => {
  const two = room().m; two.owner = 'ask';
  assert.equal(two.ownerLine('claude'), '구현 담당: 정하지 않음 — 파일을 수정하지 마세요. 계획에 둘 다 동의하면 당신(Claude)이 구현 승인과 구현 담당을 한 [질문] 으로 사용자에게 묻습니다.');
  assert.equal(two.ownerLine('codex'), '구현 담당: 정하지 않음 — 파일을 수정하지 마세요. 계획에 둘 다 동의하면 Claude 가 구현 승인과 구현 담당을 묻습니다. 당신(Codex)은 승인 [질문] 을 내지 말고 계획 의견만 내세요.');
  const three = room3().m; three.owner = 'ask';
  assert.equal(three.ownerLine('claude'), '구현 담당: 정하지 않음 — 파일을 수정하지 마세요. 계획에 모두 동의하면 당신(Claude)이 구현 승인과 구현 담당을 한 [질문] 으로 사용자에게 묻습니다.');
  assert.equal(three.ownerLine('x'), '구현 담당: 정하지 않음 — 파일을 수정하지 마세요. 계획에 모두 동의하면 Claude 가 구현 승인과 구현 담당을 묻습니다. 당신(x)은 승인 [질문] 을 내지 말고 계획 의견만 내세요.');
  const second = room({ roster: ['codex', 'claude'] }).m; second.owner = 'ask';
  assert.match(second.ownerLine('claude'), /^구현 담당: 정하지 않음 — 파일을 수정하지 마세요\. 계획에 둘 다 동의하면 Codex 가 구현 승인과 구현 담당을 묻습니다\./, '묻는 사람은 roster 첫 AI');
  three.owner = 'x';
  assert.equal(three.ownerLine('x'), '구현 담당: x (당신)');
  assert.equal(three.ownerLine('codex'), '구현 담당: x — 당신(Codex)은 파일을 수정하지 말고 설계·검토·의견만 내세요.');
});

test('표에 없는 AI: 자동 모델·노력 단계는 null(CLI 기본값), 이름은 id 그대로, 빈 발언 판정은 참여 AI 전체', () => {
  assert.deepEqual(autoChoice('x', '원인 분석'), { kind: 'hard', model: null, effort: null });
  assert.deepEqual(resolveChoice('x', { model: 'auto', effort: 'auto' }, '로그인 화면'), { model: null, effort: null });
  assert.deepEqual(autoChoice('constructor', ''), { kind: 'normal', model: null, effort: null });
  assert.equal(nameOf('x'), 'x'); assert.equal(nameOf('claude'), 'Claude'); assert.equal(nameOf('constructor'), 'constructor');
  assert.equal(isEmptyReply({ from: 'x', text: '', tools: [] }), true);
  assert.equal(isEmptyReply({ from: 'x', text: '', tools: [], streaming: true }), false);
  assert.equal(isEmptyReply({ from: 'user', text: '' }), false);
  assert.equal(isEmptyReply({ from: 'system', text: '' }), false);
});

test('화면 파생값: 2명일 때 지금 화면 문자열과 같고, 3명 이상은 roster 로 만든다', () => {
  const two = ['claude', 'codex'], three = ['claude', 'codex', 'x'];
  assert.deepEqual(ownerOptions(two), OWNERS);
  assert.deepEqual(ownerOptions(three), [{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }, { value: 'x', label: 'x' }, { value: 'ask', label: '구현 전에 물어보기' }]);
  assert.deepEqual(targetsOf(two), [{ value: 'all', label: '모두에게' }, { value: 'claude', label: 'Claude 에게' }, { value: 'codex', label: 'Codex 에게' }]);
  assert.deepEqual(targetsOf(three).map((t) => t.value), ['all', 'claude', 'codex', 'x']);
  assert.equal(agreedText(two), '두 AI 합의 완료 — 최종 답변 표시를 확인하세요');
  assert.equal(agreedText(three), '참여 AI 모두 합의 완료 — 최종 답변 표시를 확인하세요');
  assert.equal(placeholderOf(two), '메시지 입력 · Enter 보내기 · Shift+Enter 줄바꿈 · Esc 중단 · @claude / @codex 로 지정 · 답변 중에 보내면 지금 답변에 반영해요 (Codex 는 하던 작업이 끝난 지점에서)');
  assert.match(placeholderOf(three), /@claude \/ @codex \/ @x 로 지정/);
  assert.deepEqual(mentionOf(two, '@Codex 안녕'), { to: 'codex', text: '안녕' });
  assert.deepEqual(mentionOf(two, '@claude'), { to: 'claude', text: '@claude' }, '지정만 쓰면 글은 그대로');
  assert.equal(mentionOf(two, '안녕 @codex'), null);
  assert.equal(mentionOf(two, '@claudex 안녕'), null);
  assert.equal(mentionOf(two, '@x 안녕'), null);
  assert.deepEqual(mentionOf(three, '@x 해 줘'), { to: 'x', text: '해 줘' });
  // 표시 이름이 Gemini 인 antigravity: @gemini 와 내부 id @antigravity 모두 같은 AI, 자리 표시 문구는 @gemini
  const withGemini = ['claude', 'antigravity'];
  assert.deepEqual(mentionOf(withGemini, '@gemini 안녕'), { to: 'antigravity', text: '안녕' });
  assert.deepEqual(mentionOf(withGemini, '@Gemini 안녕'), { to: 'antigravity', text: '안녕' });
  assert.deepEqual(mentionOf(withGemini, '@antigravity 안녕'), { to: 'antigravity', text: '안녕' });
  assert.deepEqual(mentionOf(withGemini, '@claude 안녕'), { to: 'claude', text: '안녕' });
  assert.equal(mentionOf(withGemini, '@geminix 안녕'), null);
  assert.match(placeholderOf(withGemini), /@claude \/ @gemini 로 지정/);
  assert.ok(!placeholderOf(withGemini).includes('@antigravity'));
});

test('effortLevels: 단계가 없는 모델(Gemini)은 빈 배열이라 화면이 단계 상자를 숨기고, 단계가 있는 모델은 그대로', () => {
  const gemini = [{ value: 'gemini-3.8-flash-high', efforts: [] }, { value: 'gemini-3.8-flash-low', efforts: [] }];
  assert.deepEqual(effortLevels(gemini, 'auto'), []);
  assert.deepEqual(effortLevels(gemini, 'gemini-3.8-flash-low'), []);
  const other = [{ value: 'a', efforts: ['low', 'high'] }, { value: 'b', efforts: ['high', 'max'] }];
  assert.deepEqual(effortLevels(other, 'auto'), ['low', 'high', 'max']);
  assert.deepEqual(effortLevels(other, 'b'), ['high', 'max']);
  assert.deepEqual(effortLevels(other, '없는 모델'), []);
});

test('placeholderOf: Codex 안내는 Codex 가 참여할 때만, rosterOf: 2명 미만이면 기본 참여자', async () => {
  const { placeholderOf, rosterOf } = await import('../src/renderer/collab/moderator.js');
  assert.match(placeholderOf(['claude', 'codex']), /@claude \/ @codex 로 지정 .*\(Codex 는 하던 작업이 끝난 지점에서\)$/);
  assert.doesNotMatch(placeholderOf(['claude', 'x']), /Codex/);
  assert.deepEqual(rosterOf(['claude', 'codex', 'x']), ['claude', 'codex', 'x']);
  for (const v of [null, undefined, [], ['claude'], 'claude']) assert.deepEqual(rosterOf(v), ['claude', 'codex']);
});

// ───── Grok 참여: roster [claude, grok] (기존 2명 테스트는 그대로) ─────
test('roster [claude, grok]: 구현 담당 claude 부터 한 바퀴 돌고, 지정·표기·모델 선택지가 Grok 으로 나온다', () => {
  const { m, sent, reply } = room({ roster: ['claude', 'grok'] });
  assert.deepEqual([...m.roster], ['claude', 'grok']); assert.equal(m.owner, 'claude');
  assert.deepEqual(Object.keys(m.prefs), ['claude', 'grok']);
  m.say('안건');
  reply('claude', '의견');
  assert.deepEqual(sent.map((s) => s.agent), ['claude', 'grok']);
  assert.match(sent[1].text, /\[Claude\] 의견/);
  assert.match(sent[1].text, /당신\(Grok\)은 파일을 수정하지 말고/);
  assert.equal(nameOf('grok'), 'Grok');
  assert.deepEqual(targetsOf(['claude', 'grok']).map((t) => t.value), ['all', 'claude', 'grok']);
  assert.deepEqual(ownerOptions(['claude', 'grok']).map((o) => o.value), ['claude', 'grok', 'ask']);
  assert.match(placeholderOf(['claude', 'grok']), /@claude \/ @grok 로 지정/);
  assert.deepEqual(MODEL_OPTIONS.grok.map((o) => o.value), ['auto', 'grok-4.7']);
});

test('roster [claude, grok]: Grok 의 자동 모델은 CLI 기본(모델·단계 생략), 고른 모델은 CLI 가 알려 준 단계로 맞춘다', () => {
  assert.deepEqual(autoChoice('grok', '원인 분석'), { kind: 'hard', model: null, effort: null });
  assert.deepEqual(resolveChoice('grok', { model: 'auto', effort: 'auto' }, '로그인 화면 만들어 줘'), { model: null, effort: null });
  const grok = [{ value: 'grok-4.7', label: 'grok-4.7', efforts: ['low', 'medium', 'high', 'xhigh'] }];
  assert.deepEqual(resolveChoice('grok', { model: 'grok-4.7', effort: 'xhigh' }, '', grok), { model: 'grok-4.7', effort: 'xhigh' });
  assert.deepEqual(resolveChoice('grok', { model: 'grok-4.7', effort: 'max' }, '', grok), { model: 'grok-4.7', effort: 'high' }, '지원하지 않는 단계는 high');
  const { m, sent } = room({ roster: ['claude', 'grok'] });
  m.catalog.grok = grok; m.prefs.grok = { model: 'grok-4.7', effort: 'ultra' };
  m.say('Grok 먼저', 'grok');
  assert.deepEqual(sent[0].choice, { model: 'grok-4.7', effort: 'high' });
});

test('roster [claude, grok]: Grok 이 답하는 중 보낸 사용자 글은 가로채지 않고(steer 호출 없음) 이 턴이 끝난 뒤 다음 차례에 함께 전달된다', () => {
  const calls = [];
  const { m, sent, reply } = room({ roster: ['claude', 'grok'], steer: (...a) => { calls.push(a); return true; } });
  m.say('시작', 'grok');
  m.say('잠깐, 보안도 고려해', 'grok');
  assert.equal(calls.length, 0, 'Grok 은 가로채기를 지원하지 않는다'); assert.equal(sent.length, 1, '진행 중에는 새 턴을 만들지 않는다');
  reply('grok', '첫 의견');
  assert.equal(sent.length, 2); assert.equal(sent[1].agent, 'grok');
  assert.match(sent[1].text, /\[사용자\] 잠깐, 보안도 고려해/);
});

// ───── Muse 참여: roster [claude, muse] ─────
test('roster [claude, muse]: 구현 담당 claude 부터 한 바퀴 돌고, 지정·표기·고정 모델 선택지가 Muse 로 나온다', () => {
  const { m, sent, reply } = room({ roster: ['claude', 'muse'] });
  assert.deepEqual([...m.roster], ['claude', 'muse']); assert.equal(m.owner, 'claude');
  assert.deepEqual(Object.keys(m.prefs), ['claude', 'muse']);
  m.say('안건');
  reply('claude', '의견');
  assert.deepEqual(sent.map((s) => s.agent), ['claude', 'muse']);
  assert.match(sent[1].text, /\[Claude\] 의견/);
  assert.match(sent[1].text, /당신\(Muse\)은 파일을 수정하지 말고/);
  assert.equal(nameOf('muse'), 'Muse');
  assert.deepEqual(targetsOf(['claude', 'muse']).map((t) => t.value), ['all', 'claude', 'muse']);
  assert.deepEqual(ownerOptions(['claude', 'muse']).map((o) => o.value), ['claude', 'muse', 'ask']);
  assert.match(placeholderOf(['claude', 'muse']), /@claude \/ @muse 로 지정/);
  assert.deepEqual(MODEL_OPTIONS.muse.map((o) => o.value), ['auto', 'muse-spark-1.3', 'muse-spark-1.2', 'muse-wonder-1.0']);
});

test('roster [claude, muse]: Muse 의 자동 모델은 CLI 기본(모델·단계 생략), 고른 모델은 그대로 넘기고 가로채기는 지원하지 않는다', () => {
  assert.deepEqual(autoChoice('muse', '원인 분석'), { kind: 'hard', model: null, effort: null });
  assert.deepEqual(resolveChoice('muse', { model: 'auto', effort: 'auto' }, '로그인 화면 만들어 줘'), { model: null, effort: null });
  assert.deepEqual(resolveChoice('muse', { model: 'muse-spark-1.3', effort: 'xhigh' }, ''), { model: 'muse-spark-1.3', effort: 'xhigh' }, '목록 조회가 없으니 단계를 맞추지 않는다');
  const calls = [];
  const { m, sent, reply } = room({ roster: ['claude', 'muse'], steer: (...a) => { calls.push(a); return true; } });
  m.say('시작', 'muse');
  m.say('잠깐, 보안도 고려해', 'muse');
  assert.equal(calls.length, 0, 'Muse 는 가로채기를 지원하지 않는다'); assert.equal(sent.length, 1);
  reply('muse', '첫 의견');
  assert.equal(sent.length, 2); assert.equal(sent[1].agent, 'muse');
  assert.match(sent[1].text, /\[사용자\] 잠깐, 보안도 고려해/);
});

test('EFFORT_IN_MODEL: Gemini(antigravity) 는 단계를 따로 고르지 않는다 — 다른 AI 는 아님', () => {
  assert.ok(EFFORT_IN_MODEL.has('antigravity'));
  for (const id of ['claude', 'codex', 'grok', 'muse']) assert.ok(!EFFORT_IN_MODEL.has(id), id);
});
