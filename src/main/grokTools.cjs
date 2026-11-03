'use strict';

// Grok 의 도구 이름·입력을 Claude 도구 모양으로 맞추는 표 (hookServer 의 사무실 hook 과 협업 실행기가 함께 쓴다).
// 이름은 grok 1.0.70 실측(available_commands) — 표에 없는 이름은 그대로 둔다.
const GROK_TOOL_NAMES = Object.freeze({
  run_terminal_command: 'Bash',
  read_file: 'Read',
  search_replace: 'Edit',
  write_file: 'Write',
  list_dir: 'LS',
  grep: 'Grep',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
  spawn_subagent: 'Task',
  todo_write: 'TodoWrite',
});

// 도구 입력(JSON 문자열 또는 객체)을 객체로 풀고 target_file 을 file_path 로 옮긴다. 풀 수 없으면 빈 객체.
function pickGrokInput(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return {}; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = { ...obj };
  if (out.target_file !== undefined) {
    if (out.file_path === undefined) out.file_path = out.target_file;
    delete out.target_file;
  }
  return out;
}

// 협업 방·앱 탭의 Grok 연결: Grok 사무실 hook 은 탭 ID 를 실을 수 없어(헤더 치환 안 됨, 1.0.70 실측) 세션 ID 로만 방·탭을 찾는다.
// rooms: Map<Grok 세션 ID, roomId 또는 tabId>. GrokChat 이 내는 session 이벤트로 채우고, hook 이벤트에는 방 ID 를 _tab 으로 붙인다.
function trackGrokSession(rooms, roomId, ev) {
  if (ev && ev.type === 'session' && typeof ev.sessionId === 'string') rooms.set(ev.sessionId, roomId);
}

function attachGrokRoom(rooms, ev) {
  if (ev && ev._cli === 'grok' && !ev._tab && rooms.has(ev.session_id)) ev._tab = rooms.get(ev.session_id);
  return ev;
}

// 앱 Grok 탭도 같은 표를 쓴다: 탭을 만들 때 미리 정한 세션 ID(-s)를 탭 ID 로 등록한다. 같은 탭에 다시 만들면 앞 세션 연결은 지운다.
function trackGrokTab(rooms, tabId, sessionId) {
  if (typeof tabId !== 'string' || !tabId || typeof sessionId !== 'string' || !sessionId) return;
  dropGrokRoom(rooms, tabId);
  rooms.set(sessionId, tabId);
}

function dropGrokRoom(rooms, roomId) {
  for (const [sid, id] of [...rooms]) if (id === roomId) rooms.delete(sid);
}

module.exports = { GROK_TOOL_NAMES, pickGrokInput, trackGrokSession, trackGrokTab, attachGrokRoom, dropGrokRoom };
