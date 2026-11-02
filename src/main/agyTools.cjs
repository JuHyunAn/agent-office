'use strict';

// Antigravity(agy) 의 도구 이름을 Claude 도구 이름으로 맞추는 표 (hookServer 의 사무실 hook 이 쓴다).
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

module.exports = { AGY_TOOL_NAMES };
