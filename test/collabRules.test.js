import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AGENTS, makeRegistry } from '../src/shared/agents.js';

const { collabRules } = createRequire(import.meta.url)('../src/main/collabRules.cjs');

// 0C 이전 main.cjs 의 COLLAB_RULES·CLAUDE_RULES·CODEX_RULES 를 그대로 복사한 고정값 — 2명([claude, codex])일 때 글자까지 같아야 한다.
const COLLAB_RULES = [
  '당신은 Agent Office 의 협업 대화에 참여하고 있습니다. 참여자는 사용자, Claude(Claude Code), Codex(OpenAI Codex) 셋이며 같은 작업 폴더를 함께 씁니다.',
  '상대 AI 와 사용자의 발언은 [Claude] [Codex] [사용자] 표시와 함께 전달되고, 당신의 답변은 상대 AI 와 사용자 모두에게 보입니다.',
  '메시지 첫 줄의 구현 담당 지시를 따릅니다. 구현 담당이 아니면 파일을 수정하지 말고 설계·검토·의견만 냅니다.',
  '방향·범위·되돌리기 어려운 변경처럼 중요한 선택이 필요하면 진행을 멈추고, 답변 끝에 [질문] 으로 시작하는 줄에 질문을 적습니다. 선택지가 있으면 그 아래 줄마다 [선택] 이름 — 설명 형식으로 2~8개를 적습니다. 사용자는 버튼으로 고르며 답은 선택: 이름 으로 옵니다. 상대 AI 가 한 번 더 말할 수 있지만 사용자가 답하기 전에는 그 선택을 대신 정하지 않습니다.',
  '대화의 목표는 사용자 요청에 대해 Claude 와 Codex 둘 다 만족하는 최종 답변을 내는 것입니다. 상대의 답을 바탕으로 토론·검토·분석하며 결론으로 수렴합니다.',
  '코드 작업이면 추측하지 말고 실제 파일을 읽어 확인하고 근거가 필요하면 읽기 위주 명령으로 실측해 요청 의도를 확정한 뒤, 핵심 문제 위주의 가벼운 계획을 함께 다듬습니다. 테스트 실행은 구현 담당이 맡고 같은 확인을 되풀이하지 않습니다.',
  '구현 전 계획 단계에서는 [완료] 를 쓰지 않습니다. 계획에 둘 다 동의하면 구현 담당이 [질문] 줄로 이 계획대로 구현할지 묻고 [선택] 줄로 승인 선택지를 주며(구현 담당이 정해지지 않았으면 누가 구현할지도 같은 질문으로 묻습니다), 사용자가 승인한 뒤에만 구현하고, 구현은 아래 검증 고리를 따릅니다. 코드 작업이 아닌 질문은 일반 Claude·ChatGPT 처럼 바로 답하고, 상대는 틀린 점이나 보탤 점이 있을 때만 의견을 내며 없으면 짧은 동의와 [완료] 만 적습니다.',
  '결론에 만족하면 마지막 줄에는 [완료] 만 둡니다. 먼저 [완료] 를 쓰는 쪽은 그 답변에 최종 답변 전체(코드 작업이면 바꾼 것과 검증 결과)를 적고, 상대는 동의하면 짧은 동의와 함께 [완료] 를 적습니다. 반론이나 보탤 내용이 있으면 [완료] 대신 그 내용을 적습니다. 두 AI 가 이어서 [완료] 를 써야 대화가 끝납니다.',
  '상대의 말을 되풀이하지 말고 새 정보·반론·결정만 한국어로 간결하게 답합니다. 단 [완료] 와 함께 내는 최종 답변은 빠짐없이 적습니다.',
  '작업 원칙: 코딩 전에 가정과 모호한 점을 드러내고, 요청을 푸는 가장 단순한 방법을 고르며, 요청과 관계없는 코드는 고치지 않고, 작업마다 확인할 수 있는 완료 기준을 먼저 정해 그것으로 검증합니다.',
  '승인된 구현은 고리로 진행합니다. 구현 담당이 구현하고 테스트로 검증해 결과를 알리면 상대가 변경 내용을 검토하고, 결함이 나오면 구현 담당이 고쳐 다시 검증합니다. 이 고리는 최대 3회이며, 3회를 다 쓰고도 결함이 남거나 같은 원인으로 두 번 실패하면 멈추고 [질문] 으로 사용자에게 방향을 묻습니다. 오타처럼 작은 수정은 검토를 한 번으로 끝냅니다.',
];
const CLAUDE_RULES = [...COLLAB_RULES,
  '하위 에이전트를 적극 활용합니다. 어려운 추론·설계 검토는 model fable, 설계가 끝난 단순 코딩·주석·문법 수정은 model sonnet 에게 맡기고, 노력 단계는 high 또는 xhigh 만 씁니다.'].join(' ');
const CODEX_RULES = [...COLLAB_RULES,
  '하위 에이전트를 쓸 때 어려운 추론은 gpt-6-astra, 그 외는 gpt-6.1-sol 을 쓰고, 추론 단계는 high 또는 xhigh 만 씁니다.'].join('\n');

const FAKE = { id: 'x', name: 'X', product: 'X Agent', tabPrefix: 'X · ', color: '#888888', collabLabel: 'X(Fake)', install: { cmd: 'x', url: 'https://example.com' }, caps: { externalSessions: false, collab: true } };
const reg3 = makeRegistry([...AGENTS, FAKE]);

test('[claude, codex]: 예전 CLAUDE_RULES·CODEX_RULES 와 글자까지 같다', () => {
  assert.equal(collabRules(['claude', 'codex'], 'claude'), CLAUDE_RULES);
  assert.equal(collabRules(['claude', 'codex'], 'codex'), CODEX_RULES);
  // 레지스트리를 따로 넘겨도 (가짜 AI 가 등록돼 있어도) 같다
  assert.equal(collabRules(['claude', 'codex'], 'claude', reg3), CLAUDE_RULES);
  assert.equal(collabRules(['claude', 'codex'], 'codex', reg3), CODEX_RULES);
});

test('claude 규칙(cmd.exe 경유)에는 줄바꿈·큰따옴표·% 가 없고, 표기에 쓰는 이름도 마찬가지다', () => {
  const bad = /[\r\n"%]/;
  assert.ok(!bad.test(collabRules(['claude', 'codex'], 'claude')));
  assert.ok(!bad.test(collabRules(['claude', 'codex', 'x'], 'claude', reg3)));
  assert.ok(!bad.test(collabRules(['claude', 'codex', 'x'], 'x', reg3)));
  for (const a of reg3.list.filter((d) => d.caps.collab)) {
    assert.ok(!bad.test(a.collabLabel) && !bad.test(a.name), a.id);
  }
});

test('3명([claude, codex, x]): 참여자 수 「넷」·[X] 표기·「모두」 문장', () => {
  const rules = collabRules(['claude', 'codex', 'x'], 'claude', reg3);
  assert.ok(rules.includes('참여자는 사용자, Claude(Claude Code), Codex(OpenAI Codex), X(Fake) 넷이며 같은 작업 폴더를 함께 씁니다.'));
  assert.ok(rules.includes('발언은 [Claude] [Codex] [X] [사용자] 표시와 함께 전달되고'));
  assert.ok(rules.includes('Claude, Codex, X 모두 만족하는 최종 답변'));
  assert.ok(rules.includes('다른 AI 가 차례대로 더 말할 수 있지만 사용자가 답하기 전에는'));
  assert.ok(!rules.includes('상대 AI 가 한 번 더 말할 수 있지만'));
  assert.ok(rules.includes('계획에 모두 동의하면 구현 담당이'));
  assert.ok(rules.includes('참여한 AI 모두가 이어서 [완료] 를 써야 대화가 끝납니다.'));
  assert.ok(!rules.includes('둘 다') && !rules.includes('두 AI'), '3명 이상에는 둘이라는 말이 남지 않는다');
});

test('참여자 수 읽기: 셋·넷·다섯, 그 밖은 n명', () => {
  const ids = (n) => ['claude', 'codex', ...Array.from({ length: n - 2 }, (_, i) => `x${i}`)];
  const reg = makeRegistry([...AGENTS, ...Array.from({ length: 4 }, (_, i) => ({ ...FAKE, id: `x${i}`, name: `X${i}`, collabLabel: `X${i}(Fake)` }))]);
  assert.match(collabRules(ids(2), 'claude', reg), /\) 셋이며 같은 작업 폴더/);
  assert.match(collabRules(ids(3), 'claude', reg), /\) 넷이며 같은 작업 폴더/);
  assert.match(collabRules(ids(4), 'claude', reg), /\) 다섯이며 같은 작업 폴더/);
  assert.match(collabRules(ids(5), 'claude', reg), /\) 6명이며 같은 작업 폴더/);
});

test('AI 별 추가 문장·이음 문자: claude 는 공백, codex 는 줄바꿈, 표에 없는 AI 는 추가 문장 없이 공백', () => {
  const roster = ['claude', 'codex', 'x'];
  const claude = collabRules(roster, 'claude', reg3), codex = collabRules(roster, 'codex', reg3), x = collabRules(roster, 'x', reg3);
  assert.ok(claude.endsWith('하위 에이전트를 적극 활용합니다. 어려운 추론·설계 검토는 model fable, 설계가 끝난 단순 코딩·주석·문법 수정은 model sonnet 에게 맡기고, 노력 단계는 high 또는 xhigh 만 씁니다.'));
  assert.ok(codex.endsWith('\n하위 에이전트를 쓸 때 어려운 추론은 gpt-6-astra, 그 외는 gpt-6.1-sol 을 쓰고, 추론 단계는 high 또는 xhigh 만 씁니다.'));
  assert.equal(codex.split('\n').length, 12);
  assert.ok(!x.includes('\n') && !x.includes('하위 에이전트'));
  assert.ok(x.endsWith('오타처럼 작은 수정은 검토를 한 번으로 끝냅니다.'));
});

test('collabLabel 이 없는 AI 는 「이름(제품)」 으로 표기한다', () => {
  const noLabel = { ...FAKE, collabLabel: undefined };
  const reg = makeRegistry([...AGENTS, noLabel]);
  assert.ok(collabRules(['claude', 'x'], 'claude', reg).includes('사용자, Claude(Claude Code), X(X Agent) 셋이며'));
});

test('[claude, grok]: 추가 문장 없이 줄바꿈으로 잇고, 참여자 표기·둘 다 문구는 두 명 기준', () => {
  const grok = collabRules(['claude', 'grok'], 'grok');
  assert.equal(grok.split('\n').length, 11, '공통 문장 11개만 (AGENT_RULES.grok 없음)');
  assert.ok(grok.startsWith('당신은 Agent Office 의 협업 대화에 참여하고 있습니다. 참여자는 사용자, Claude(Claude Code), Grok(xAI Grok Build) 셋이며'));
  assert.ok(grok.includes('[Claude] [Grok] [사용자]') && grok.includes('Claude 와 Grok 둘 다 만족하는'));
  assert.ok(!grok.includes('하위 에이전트'));
  const claude = collabRules(['claude', 'grok'], 'claude');
  assert.ok(!/[\r\n"%]/.test(claude), 'claude 규칙(cmd.exe 경유)에는 줄바꿈·큰따옴표·% 가 없다');
  assert.ok(claude.includes('Claude 와 Grok 둘 다'));
  // 셋이면 Codex 규칙은 그대로 줄바꿈 + 자기 추가 문장
  const three = collabRules(['claude', 'codex', 'grok'], 'grok');
  assert.ok(three.includes('Claude(Claude Code), Codex(OpenAI Codex), Grok(xAI Grok Build) 넷이며'));
  assert.ok(!/"|%/.test(three));
});

test('[claude, antigravity]: 추가 문장 없이 줄바꿈으로 잇는다 (-p 인자는 cmd 를 거치지 않아 줄바꿈이 안전하다)', () => {
  const agy = collabRules(['claude', 'antigravity'], 'antigravity');
  assert.equal(agy.split('\n').length, 11, '공통 문장 11개만 (AGENT_RULES.antigravity 없음)');
  assert.ok(agy.startsWith('당신은 Agent Office 의 협업 대화에 참여하고 있습니다. 참여자는 사용자, Claude(Claude Code), Gemini(Google Antigravity CLI) 셋이며'));
  assert.ok(agy.includes('[Claude] [Gemini] [사용자]') && agy.includes('Claude 와 Gemini 둘 다 만족하는'));
  assert.ok(!agy.includes('하위 에이전트'));
  assert.ok(!/[\r\n"%]/.test(collabRules(['claude', 'antigravity'], 'claude')), 'claude 규칙(cmd.exe 경유)에는 줄바꿈·큰따옴표·% 가 없다');
  assert.ok(!/"|%/.test(agy), 'agy 규칙에도 큰따옴표·% 는 없다');
});

test('[claude, muse]: Grok 처럼 추가 문장 없이 줄바꿈으로 잇는다', () => {
  const muse = collabRules(['claude', 'muse'], 'muse');
  assert.equal(muse.split('\n').length, 11, '공통 문장 11개만 (AGENT_RULES.muse 없음)');
  assert.ok(muse.includes('Claude(Claude Code), Muse(Meta Muse Code) 셋이며') && muse.includes('Claude 와 Muse 둘 다 만족하는'));
  assert.ok(!/[\r\n"%]/.test(collabRules(['claude', 'muse'], 'claude')));
});
