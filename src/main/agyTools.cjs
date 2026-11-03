'use strict';

// Antigravity(agy) 의 도구 이름·입력을 Claude 도구 모양으로 맞추는 표 (hookServer 의 사무실 hook 과 협업 실행기가 함께 쓴다).
// 이름은 agy 1.4.12 실측 — 표에 없는 이름은 그대로 둔다.
const AGY_TOOL_NAMES = Object.freeze({
  run_command: 'Bash',
  read_file: 'Read',
  view_file: 'Read',
  list_dir: 'LS',
  grep_search: 'Grep',
  search_web: 'WebSearch',
  read_url_content: 'WebFetch',
  write_to_file: 'Write',
  replace_file_content: 'Edit',
  multi_replace_file_content: 'Edit',
});

// agy 도구 인자의 키 이름 → Claude 쪽 키 이름 (agy 1.4.12 실측: run_command{CommandLine}, write_file{Path} 등)
const AGY_INPUT_KEYS = Object.freeze({ CommandLine: 'command', Path: 'file_path', AbsolutePath: 'file_path', TargetFile: 'file_path', query: 'query', Url: 'url' });

// 도구 인자(객체)에서 위 키의 문자열 값만 Claude 키 이름으로 옮긴다 (300자까지, 같은 키가 겹치면 먼저 온 값). 객체가 아니면 빈 객체.
function pickAgyInput(params) {
  const out = {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) return out;
  for (const [from, to] of Object.entries(AGY_INPUT_KEYS)) {
    if (typeof params[from] === 'string' && out[to] === undefined) out[to] = params[from].slice(0, 300);
  }
  return out;
}

module.exports = { AGY_TOOL_NAMES, pickAgyInput };
