// 도구 호출 → 말풍선 한 줄 + 자세(pose). 문구는 부르는 시점의 언어로 만든다.
import { t } from '../../shared/i18n.js';

export function clip(s, n) {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  return text.length > n ? text.slice(0, Math.max(1, n - 1)) + '…' : text;
}

export function baseName(p) {
  return String(p ?? '').split(/[\\/]/).filter(Boolean).pop() || '';
}

// Codex 의 apply_patch 는 파일 경로 대신 패치 본문(*** Update File: 경로)을 넘긴다.
export function patchFile(input) {
  return input.file_path || String(input.command || '').match(/\*\*\* (?:Update|Add|Delete) File: (.+)/)?.[1]?.trim() || '';
}

const TEST_COMMAND = /\b(npm (run )?test|pytest|gradlew?\S* .*test|dotnet test|node --test)\b/i;

// A short, deterministic summary from observed tool metadata; no extra model call.
export function activitySummary(name, input = {}) {
  const file = clip(baseName(name === 'apply_patch' ? patchFile(input) : input.file_path || input.notebook_path), 22);
  switch (name) {
    case 'Read': return t('office.activity.read', { file: file || t('office.word.material') });
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': case 'apply_patch': return t('office.activity.edit', { file: file || t('office.word.code') });
    case 'Write': return t('office.activity.write', { file: file || t('office.word.file') });
    case 'Grep': case 'Glob': return t('office.activity.search', { pattern: clip(input.pattern || t('office.word.relatedCode'), 20) });
    case 'WebSearch': return t('office.activity.webSearch', { query: clip(input.query || t('office.word.reference'), 22) });
    case 'WebFetch': return t('office.activity.webFetch');
    case 'Skill': return t('office.activity.skillWork', { skill: clip(input.skill, 28) });
    case 'Agent': case 'Task': return t('office.activity.agent', { desc: clip(input.description || t('office.word.subtask'), 25) });
    case 'SendMessage': return t('office.activity.send', { to: clip(input.to || t('office.word.colleague'), 18) });
    case 'Bash': case 'PowerShell':
      if (input.description) return clip(input.description, 36);
      if (TEST_COMMAND.test(input.command || '')) return t('office.activity.test');
      if (/\bgit\s+(status|diff|log)\b/.test(input.command || '')) return t('office.activity.gitCheck');
      return t('office.activity.run', { cmd: clip(input.command || t('office.word.command'), 27) });
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': return t('office.activity.todo');
    case 'AskUserQuestion': return t('office.activity.ask');
    default: return t('office.activity.use', { name: clip(String(name || t('office.word.tool')).split('__').pop(), 25) });
  }
}

// 말풍선을 한 줄로 줄일 때 쓰는 도구 종류별 요약 (파일명·명령은 빼고 무슨 일인지만).
export function workBrief(name, input = {}) {
  switch (name) {
    case 'Read': return t('office.brief.read');
    case 'Grep': case 'Glob': case 'LS': return t('office.brief.search');
    case 'WebSearch': case 'WebFetch': return t('office.brief.web');
    case 'Edit': case 'MultiEdit': case 'apply_patch': case 'NotebookEdit': return t('office.brief.edit');
    case 'Write': return t('office.brief.write');
    case 'Bash': case 'PowerShell': return TEST_COMMAND.test(input?.command || '') ? t('office.brief.test') : t('office.brief.run');
    case 'Skill': return t('office.brief.skill');
    case 'Agent': case 'Task': return t('office.brief.assign');
    case 'SendMessage': return t('office.brief.share');
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': return t('office.brief.todo');
    case 'AskUserQuestion': return t('office.brief.ask');
    default: return typeof name === 'string' && name.startsWith('mcp__') ? t('office.brief.mcp') : t('office.brief.work');
  }
}

export function toolPhrase(name, input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'Read': return t('office.tool.read', { file: clip(baseName(i.file_path), 20) });
    case 'Edit':
    case 'MultiEdit': return t('office.tool.edit', { file: clip(baseName(i.file_path), 20) });
    case 'apply_patch': return t('office.tool.edit', { file: clip(baseName(patchFile(i)), 20) });
    case 'Write': return t('office.tool.write', { file: clip(baseName(i.file_path), 20) });
    case 'NotebookEdit': return t('office.tool.notebook', { file: clip(baseName(i.notebook_path), 16) });
    case 'Grep': return t('office.tool.grep', { pattern: clip(i.pattern, 18) });
    case 'Glob': return t('office.tool.glob', { pattern: clip(i.pattern, 16) });
    case 'Bash':
    case 'PowerShell': return t('office.tool.run', { cmd: clip(i.description || i.command, 22) });
    case 'WebSearch': return t('office.tool.webSearch', { query: clip(i.query, 18) });
    case 'WebFetch': return t('office.tool.webFetch');
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate': return t('office.tool.todo');
    case 'Skill': return t('office.tool.skill', { skill: clip(i.skill, 16) });
    case 'SendMessage': return t('office.tool.send');
    case 'AskUserQuestion': return t('office.tool.ask');
    case 'Agent':
    case 'Task': return t('office.tool.agent', { desc: clip(i.description, 18) });
    default:
      if (typeof name === 'string' && name.startsWith('mcp__')) return `🔌 ${clip(name.split('__').pop(), 20)}`;
      return `⚙ ${clip(name || t('office.word.work'), 20)}`;
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
