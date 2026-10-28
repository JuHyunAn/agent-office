'use strict';

// 협업 대화: 화면 없는 공식 실행 방식으로 Claude·Codex 와 대화한다.
//  - Claude: claude -p --input-format/--output-format stream-json — 한 프로세스에서 여러 턴, 글자 단위 실시간 출력 (2.1.312 실측)
//  - Codex : codex exec --json — 턴마다 실행하고 exec resume 으로 같은 세션을 이어 간다 (0.163 실측)
// 이 모듈은 실행·해석만 맡고, 누가 말할 차례인지는 화면 쪽 진행자(collab/moderator.js)가 정한다.

const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { spawn: nodeSpawn, execFile } = require('node:child_process');
const claudeCli = require('./claudeCli.cjs');
const codexCli = require('./codexCli.cjs');

const SAFE = /^[A-Za-z0-9._:-]{1,80}$/;
const EFFORT_RE = /^[a-z]{2,12}$/; // 단계 이름은 Claude 가 알려 준 목록(low … max)에서 온다
const TOOL_KEYS = ['file_path', 'notebook_path', 'pattern', 'path', 'description', 'command', 'query', 'url', 'subagent_type', 'skill'];

function pick(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const k of TOOL_KEYS) if (typeof input[k] === 'string') out[k] = input[k].slice(0, 300);
  return out;
}

function claudeChatArgs({ settingsPath, sessionId, resume, model, effort, systemPrompt }) {
  if (!SAFE.test(String(model))) throw new Error('잘못된 모델');
  if (effort != null && !EFFORT_RE.test(String(effort))) throw new Error('잘못된 노력 단계');
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--model', model, ...(effort ? ['--effort', effort] : []), '--dangerously-skip-permissions', '--settings', settingsPath,
    ...(systemPrompt ? ['--append-system-prompt', systemPrompt] : []),
    ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId])];
}

function claudeUserLine(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
}

function parseClaudeLine(j) {
  if (!j || typeof j !== 'object') return [];
  if (j.parent_tool_use_id != null && (j.type === 'stream_event' || j.type === 'assistant')) return []; // 하위 에이전트의 글·도구
  if (j.type === 'system' && j.subtype === 'init') return [{ type: 'session', sessionId: j.session_id, model: j.model }];
  // 글 블록이 새로 시작하면 문단을 나눈다 — 도구 호출 뒤의 [질문]·[완료] 줄이 앞 문장에 붙지 않게.
  if (j.type === 'stream_event' && j.event?.type === 'content_block_start' && j.event.content_block?.type === 'text') return [{ type: 'text', text: '', block: true }];
  if (j.type === 'stream_event' && j.event?.type === 'content_block_delta' && j.event.delta?.type === 'text_delta') return [{ type: 'text', text: j.event.delta.text }];
  if (j.type === 'assistant' && Array.isArray(j.message?.content)) {
    return j.message.content.filter((c) => c.type === 'tool_use').map((c) => ({ type: 'tool', name: c.name, input: pick(c.input) }));
  }
  if (j.type === 'result') return [j.subtype === 'success' && !j.is_error ? { type: 'done', ok: true } : { type: 'done', ok: false, error: String(j.result || j.subtype || '실패').slice(0, 300) }];
  return [];
}

// Codex 가 실행 때마다 띄우는 안내성 경고 — 대화창에는 보이지 않게 거른다.
const BENIGN = [/^Under-development features/, /dangerously-bypass-hook-trust/, /^clamping .* hook timeout/, /^This session was recorded with model/];

function parseCodexLine(j) {
  if (!j || typeof j !== 'object') return [];
  if (j.type === 'thread.started') return [{ type: 'session', sessionId: j.thread_id }];
  if (j.type === 'turn.completed') return [{ type: 'done', ok: true }];
  if (j.type === 'turn.failed') return [{ type: 'done', ok: false, error: String(j.error?.message || '실패').slice(0, 300) }];
  if (j.type === 'error') return [{ type: 'notice', text: String(j.message || '오류').slice(0, 300) }];
  const it = j.item;
  if (!it) return [];
  if (j.type === 'item.completed' && it.type === 'agent_message') return [{ type: 'text', text: String(it.text || ''), block: true }];
  if (j.type === 'item.completed' && it.type === 'error') {
    const msg = String(it.message || '');
    return BENIGN.some((re) => re.test(msg)) ? [] : [{ type: 'notice', text: msg.slice(0, 300) }];
  }
  if (j.type === 'item.started' && it.type === 'command_execution') return [{ type: 'tool', name: 'Bash', input: { command: String(it.command || '').slice(0, 300) } }];
  if (j.type === 'item.started' && it.type === 'mcp_tool_call') return [{ type: 'tool', name: String(it.tool || 'MCP'), input: {} }];
  if (j.type === 'item.started' && it.type === 'web_search') return [{ type: 'tool', name: 'WebSearch', input: { query: String(it.query || '').slice(0, 300) } }];
  if (j.type === 'item.completed' && it.type === 'file_change') {
    return (Array.isArray(it.changes) ? it.changes : []).slice(0, 5).map((c) => ({ type: 'tool', name: 'apply_patch', input: { file_path: String(c.path || '') } }));
  }
  return [];
}

// JSON 줄 단위로 끊어 읽는다 (조각이 줄·글자 중간에서 잘려 와도 안전 — 한글 3바이트가 나뉘어 와도 이어 붙여 해석).
function lineReader(onJson) {
  let buf = '';
  const decoder = new StringDecoder('utf8');
  return (chunk) => {
    buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      onJson(j);
    }
  };
}

// 자식(도구 실행)까지 함께 끝낸다.
function killTree(p) {
  if (!p || p.exitCode != null) return;
  if (process.platform === 'win32' && p.pid) execFile('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else try { p.kill(); } catch { /* 이미 종료 */ }
}

function spawnCli(spawn, loc, args, opts) {
  const c = claudeCli.commandFor(loc, args);
  const p = typeof c.args === 'string'
    ? spawn(c.file, [c.args], { ...opts, windowsVerbatimArguments: true, windowsHide: true })
    : spawn(c.file, c.args, { ...opts, windowsHide: true });
  p.stdin?.on?.('error', () => {}); // 실행 실패·강제 종료 뒤의 쓰기 오류(EPIPE)로 앱이 죽지 않게 — 실패는 exit/error 로 알린다
  return p;
}

// 헤드리스 시작 응답(initialize)의 models: 계정에서 쓸 수 있는 모델과 모델별 노력 단계 (2.1.x 실측).
// 「default」 항목은 다른 모델을 가리키는 별칭이라 뺀다.
function parseClaudeModels(models) {
  return (Array.isArray(models) ? models : [])
    .filter((m) => m && m.value !== 'default' && SAFE.test(String(m.value)))
    .map((m) => ({
      value: m.value, label: String(m.displayName || m.value), description: String(m.description || ''),
      efforts: m.supportsEffort && Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.map(String).filter((e) => EFFORT_RE.test(e)) : [],
    }));
}

// 대화를 시작하지 않고 시작 요청만 보내 목록을 받은 뒤 바로 끝낸다.
// settingsPath 는 hook 을 모두 끈 설정 — 사무실에 빈 세션 캐릭터가 생기지 않게.
// 실패하면 null — 이유는 onError 로 알린다 (화면에 표시).
function claudeModels({ loc, settingsPath, cwd, env, spawn = nodeSpawn, kill = killTree, timeoutMs = 30000, onError = () => {} }) {
  return new Promise((resolve) => {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--settings', settingsPath, '--no-session-persistence'];
    const p = spawnCli(spawn, loc, args, { cwd, env });
    const id = 'models';
    let timer = null; let err = '';
    const finish = (list, reason) => {
      if (!timer) return;
      clearTimeout(timer); timer = null; kill(p);
      if (!list) onError(reason);
      resolve(list);
    };
    timer = setTimeout(() => finish(null, `${timeoutMs / 1000}초 안에 응답이 없습니다`), timeoutMs);
    p.stdout.on('data', lineReader((j) => {
      if (j.type === 'control_response' && j.response?.request_id === id) {
        finish(j.response.subtype === 'success' ? parseClaudeModels(j.response.response?.models) : null, String(j.response.error || '시작 요청 실패').slice(0, 200));
      }
    }));
    p.stderr?.on?.('data', (d) => { err = (err + d).slice(-400); });
    p.on('error', (e) => finish(null, `실행 실패: ${e.message}`));
    p.on('exit', (code) => finish(null, `응답 전에 종료 (코드 ${code})${err.trim() ? `: ${err.trim().split('\n').pop()}` : ''}`));
    p.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'initialize' } }) + '\n');
  });
}

class ClaudeChat {
  constructor({ loc, cwd, settingsPath, systemPrompt, env, onEvent, spawn = nodeSpawn, kill = killTree }) {
    Object.assign(this, { loc, cwd, settingsPath, systemPrompt, env, onEvent, spawnFn: spawn, killFn: kill });
    this.sessionId = crypto.randomUUID();
    this.hasHistory = false; // 세션이 실제로 만들어진 뒤에만 --resume 으로 다시 띄운다
    this.proc = null; this.busy = false; this.config = null; this.turn = null;
  }

  // 진행자가 붙인 턴 번호를 함께 돌려보내 늦게 도착한 이벤트를 화면에서 거를 수 있게 한다.
  emit(ev) { this.onEvent(this.turn == null ? ev : { ...ev, turn: this.turn }); }

  start(model, effort) {
    const args = claudeChatArgs({ settingsPath: this.settingsPath, sessionId: this.sessionId, resume: this.hasHistory, model, effort, systemPrompt: this.systemPrompt });
    const p = spawnCli(this.spawnFn, this.loc, args, { cwd: this.cwd, env: this.env });
    this.proc = p; this.config = `${model}/${effort}`;
    // 끝내는 중인 옛 프로세스(taskkill 은 비동기)의 늦은 출력은 새 턴에 섞지 않는다.
    p.stdout.on('data', lineReader((j) => {
      if (this.proc !== p) return;
      for (const ev of parseClaudeLine(j)) {
        if (ev.type === 'session') this.hasHistory = true;
        if (ev.type === 'done') { if (!this.busy) continue; this.busy = false; }
        this.emit(ev);
      }
    }));
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-600); });
    p.on('error', (e) => this.exited(p, `Claude 를 실행하지 못했습니다: ${e.message}`));
    p.on('exit', (code) => this.exited(p, `Claude 가 종료되었습니다 (코드 ${code})${err.trim() ? `: ${err.trim().split('\n').pop()}` : ''}`));
  }

  exited(p, message) {
    if (this.proc !== p) return;
    this.proc = null;
    if (this.busy) { this.busy = false; this.emit({ type: 'done', ok: false, error: message }); }
  }

  send(text, { model, effort }, turn = null) {
    if (this.proc && this.config !== `${model}/${effort}`) this.restart();
    if (!this.proc) this.start(model, effort);
    this.turn = turn; this.busy = true;
    this.proc.stdin.write(claudeUserLine(text));
  }

  restart() {
    const p = this.proc; this.proc = null; this.killFn(p);
    if (!this.hasHistory) this.sessionId = crypto.randomUUID(); // 첫 응답 전에 끝났으면 같은 ID 를 다시 쓰지 않는다
  }

  stop() {
    const was = this.busy; this.busy = false;
    if (this.proc) this.restart();
    if (was) this.emit({ type: 'done', ok: false, stopped: true });
  }

  close() { this.busy = false; if (this.proc) this.restart(); }
}

class CodexChat {
  constructor({ loc, cwd, systemPrompt, hooks, env, onEvent, spawn = nodeSpawn, kill = killTree }) {
    Object.assign(this, { loc, cwd, systemPrompt, hooks, env, onEvent, spawnFn: spawn, killFn: kill });
    this.threadId = null;
    this.run = null; // 현재 턴 { p, finished, turn }
    this.live = new Set(); // 턴이 끝났어도 아직 종료되지 않은 프로세스 (hook 실행 등) — 닫을 때 모두 끝낸다
  }

  get proc() { return this.run && !this.run.finished ? this.run.p : null; }

  send(text, { model, effort }, turn = null) {
    this.abandon(); // 이전 턴이 남아 있으면 조용히 정리한다 (새 턴에 「중단됨」을 보내지 않음)
    const args = codexCli.execArgs({ resumeId: this.threadId, model, effort, hooks: this.hooks });
    const p = spawnCli(this.spawnFn, this.loc, args, { cwd: this.cwd, env: this.env });
    const run = { p, finished: false, turn };
    this.run = run; this.live.add(p);
    const emit = (ev) => this.onEvent(turn == null ? ev : { ...ev, turn });
    const finish = (ev) => { if (run.finished) return; run.finished = true; emit(ev); };
    let err = '';
    p.stdout.on('data', lineReader((j) => {
      if (run.finished) return; // 끝났거나 중단한 실행의 늦은 출력
      for (const ev of parseCodexLine(j)) {
        if (ev.type === 'session') { this.threadId = this.threadId || ev.sessionId; emit(ev); }
        else if (ev.type === 'done') finish(ev);
        else emit(ev);
      }
    }));
    p.stderr.on('data', (d) => { err = (err + d).slice(-600); });
    p.on('error', (e) => { this.live.delete(p); finish({ type: 'done', ok: false, error: `Codex 를 실행하지 못했습니다: ${e.message}` }); });
    p.on('exit', (code) => {
      this.live.delete(p);
      const tail = err.trim() ? `: ${err.trim().split('\n').pop().slice(0, 200)}` : '';
      finish(code === 0 ? { type: 'done', ok: true } : { type: 'done', ok: false, error: `Codex 가 응답 없이 종료되었습니다 (코드 ${code})${tail}` });
    });
    p.stdin.end(this.threadId || !this.systemPrompt ? text : `${this.systemPrompt}\n\n${text}`);
  }

  abandon() {
    const run = this.run;
    if (!run || run.finished) return null;
    run.finished = true;
    this.killFn(run.p);
    return run;
  }

  stop() {
    const run = this.abandon();
    if (run) this.onEvent(run.turn == null ? { type: 'done', ok: false, stopped: true } : { type: 'done', ok: false, stopped: true, turn: run.turn });
  }

  close() {
    this.abandon();
    for (const p of this.live) this.killFn(p);
    this.live.clear();
  }
}

module.exports = { claudeChatArgs, claudeUserLine, parseClaudeLine, parseClaudeModels, claudeModels, parseCodexLine, lineReader, killTree, ClaudeChat, CodexChat };
