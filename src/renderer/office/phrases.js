// 도구 호출 → 말풍선 한 줄 + 자세(pose).

export function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, Math.max(1, n - 1)) + '…' : t;
}

export function baseName(p) {
  return String(p ?? '').split(/[\\/]/).filter(Boolean).pop() || '';
}

// A short, deterministic summary from observed tool metadata; no extra model call.
export function activitySummary(name, input = {}) {
  const file = clip(baseName(input.file_path || input.notebook_path), 22);
  switch (name) {
    case 'Read': return `${file || '자료'} 내용 검토 중`;
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return `${file || '코드'} 수정 중`;
    case 'Write': return `${file || '파일'} 작성 중`;
    case 'Grep': case 'Glob': return `${clip(input.pattern || '관련 코드', 20)} 찾는 중`;
    case 'WebSearch': return `${clip(input.query || '참고 자료', 22)} 조사 중`;
    case 'WebFetch': return '웹 자료 확인 중';
    case 'Skill': return `${clip(input.skill, 28)} 스킬 작업 중`;
    case 'Agent': case 'Task': return `${clip(input.description || '하위 작업', 25)} 역할 분담 중`;
    case 'SendMessage': return `${clip(input.to || '동료', 18)}에게 결과 공유 중`;
    case 'Bash': case 'PowerShell':
      if (input.description) return clip(input.description, 36);
      if (/\b(npm (run )?test|pytest|gradlew?\S* .*test|dotnet test|node --test)\b/i.test(input.command || '')) return '테스트 실행 중';
      if (/\bgit\s+(status|diff|log)\b/.test(input.command || '')) return '변경 내역 확인 중';
      return `${clip(input.command || '명령', 27)} 실행 중`;
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': return '작업 순서와 진행 상황 정리 중';
    case 'AskUserQuestion': return '사용자에게 확인할 내용 정리 중';
    default: return `${clip(String(name || '도구').split('__').pop(), 25)} 사용 중`;
  }
}

export function toolPhrase(name, input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'Read': return `📖 읽는 중: ${clip(baseName(i.file_path), 20)}`;
    case 'Edit':
    case 'MultiEdit': return `⌨ 수정 중: ${clip(baseName(i.file_path), 20)}`;
    case 'Write': return `📝 작성 중: ${clip(baseName(i.file_path), 20)}`;
    case 'NotebookEdit': return `📓 노트북 수정: ${clip(baseName(i.notebook_path), 16)}`;
    case 'Grep': return `🔍 검색 중: ${clip(i.pattern, 18)}`;
    case 'Glob': return `🗂 파일 찾는 중: ${clip(i.pattern, 16)}`;
    case 'Bash':
    case 'PowerShell': return `▶ 실행 중: ${clip(i.description || i.command, 22)}`;
    case 'WebSearch': return `🌐 웹 검색: ${clip(i.query, 18)}`;
    case 'WebFetch': return '🌐 페이지 읽는 중';
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate': return '🗒 할 일 정리 중';
    case 'Skill': return `🧩 스킬 사용: ${clip(i.skill, 16)}`;
    case 'SendMessage': return '💬 메시지 전달';
    case 'AskUserQuestion': return '❓ 질문 준비 중';
    case 'Agent':
    case 'Task': return `📣 업무 지시: ${clip(i.description, 18)}`;
    default:
      if (typeof name === 'string' && name.startsWith('mcp__')) return `🔌 ${clip(name.split('__').pop(), 20)}`;
      return `⚙ ${clip(name || '작업', 20)}`;
  }
}

const READ = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'LS']);
const RUN = new Set(['Bash', 'PowerShell']);
const TALK = new Set(['SendMessage', 'AskUserQuestion', 'Agent', 'Task']);

export function toolPose(name) {
  if (READ.has(name)) return 'read';
  if (RUN.has(name)) return 'run';
  if (TALK.has(name)) return 'talk';
  return 'type';
}
