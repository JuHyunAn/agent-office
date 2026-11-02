import { agentById } from '../../../shared/agents.js';

// AI 별 임시 사무실 캐릭터 색: codex-sprite 모양(구름 머리 로봇)에 색과 가슴 표식만 바꿔 쓴다 (0D 임시 — 그림은 나중에 따로).
// 키는 AI id. 표에 없는 등록된 AI 는 레지스트리 색(color)에서 만든다. Claude 는 기존 그림이라 여기 없다.
export const AGENT_LOOKS = Object.freeze({
  codex: Object.freeze({ body: '#5887d8', light: '#80a9ee', shade: '#3c62aa', ink: '#25385f', eye: '#b4eee9', mark: 'dots' }),
  grok: Object.freeze({ body: '#7d8794', light: '#a7b0bb', shade: '#5a626d', ink: '#1d2127', eye: '#f1f3f6', mark: 'slash' }),
  muse: Object.freeze({ body: '#8a6bd8', light: '#ae95ec', shade: '#6449ad', ink: '#2c2150', eye: '#f3d2f7', mark: 'bar' }),
  antigravity: Object.freeze({ body: '#3f9f78', light: '#6cc39e', shade: '#2c7a5a', ink: '#173d2f', eye: '#f6e27a', mark: 'plus' }),
});
export const MARKS = ['dots', 'bar', 'plus', 'slash'];

const HEX = /^#[0-9a-f]{6}$/i;
// hex 색을 다른 색 쪽으로 k 만큼 섞는다 (채널마다 반올림)
function mix(hex, toHex, k) {
  const out = [1, 3, 5].map((i) => {
    const a = parseInt(hex.slice(i, i + 2), 16), b = parseInt(toHex.slice(i, i + 2), 16);
    return Math.round(a + (b - a) * k).toString(16).padStart(2, '0');
  });
  return `#${out.join('')}`;
}

// 레지스트리 색 하나에서 다섯 색을 만든다. #rrggbb 가 아니면 null.
export function deriveLook(color) {
  if (typeof color !== 'string' || !HEX.test(color)) return null;
  const body = color.toLowerCase();
  return Object.freeze({
    body, light: mix(body, '#ffffff', .3), shade: mix(body, '#000000', .3), ink: mix(body, '#000000', .7), eye: mix(body, '#ffffff', .75), mark: 'dots',
  });
}

const derived = new Map();
// 이 AI 를 그릴 색. null 이면 Claude 그림(기존 그대로) — claude·미등록·문자열이 아닌 값.
export function lookOf(cli) {
  if (typeof cli !== 'string' || cli === 'claude') return null;
  if (Object.hasOwn(AGENT_LOOKS, cli)) return AGENT_LOOKS[cli];
  const agent = agentById(cli);
  if (!agent) return null;
  if (!derived.has(cli)) derived.set(cli, deriveLook(agent.color));
  return derived.get(cli);
}
