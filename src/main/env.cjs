'use strict';

// 이 앱을 IDE(VS Code·Cursor) 안의 Claude Code 에서 띄우면, 그 세션 전용 값이 환경변수로 따라온다.
// 그대로 넘기면 앱이 띄운 claude 가 「하위 세션」·「IDE 연결」로 오인하므로 세션·IDE 식별 값만 지운다.
// 사용자가 직접 켠 기능 플래그(CLAUDE_CODE_EXPERIMENTAL_* 등)와 인증 관련 값은 건드리지 않는다.
const SESSION_KEYS = new Set([
  'ELECTRON_RUN_AS_NODE',
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_EMIT_STARTUP_TIMING',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDE_CODE_QUESTION_PREVIEW_FORMAT',
  'CLAUDE_CODE_ENABLE_TASKS',
  'AGENT_OFFICE_TAB',
]);

function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SESSION_KEYS.has(k) || k.startsWith('VSCODE_')) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

module.exports = { cleanEnv, SESSION_KEYS };
