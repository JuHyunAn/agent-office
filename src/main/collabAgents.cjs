'use strict';

// 협업 대화: 화면 없는 공식 실행 방식으로 Claude·Codex·Grok·Muse·Antigravity 와 대화한다.
//  - Claude: claude -p --input-format/--output-format stream-json — 한 프로세스에서 여러 턴, 글자 단위 실시간 출력 (2.1.312 실측)
//  - Codex : codex exec --json — 턴마다 실행하고 exec resume 으로 같은 세션을 이어 간다 (0.163 실측)
//  - Grok  : grok --prompt-file … --output-format streaming-json — 턴마다 실행하고 -r 로 같은 세션을 이어 간다 (1.0.70 실측)
//  - Muse  : muse exec --json --prompt-file … --session-id — 턴마다 실행하고 같은 --session-id 로 대화를 이어 간다 (1.4.14 실측, museCli.cjs)
//  - Antigravity: agy -p <프롬프트> --output-format stream-json — 턴마다 실행하고 --conversation 으로 같은 대화를 이어 간다 (1.4.12 실측)
// 이 모듈은 실행·해석만 맡고, 누가 말할 차례인지는 화면 쪽 진행자(collab/moderator.js)가 정한다.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { spawn: nodeSpawn, execFile } = require('node:child_process');
const claudeCli = require('./claudeCli.cjs');
const codexCli = require('./codexCli.cjs');
const { GROK_TOOL_NAMES, pickGrokInput } = require('./grokTools.cjs');
const { AGY_TOOL_NAMES, pickAgyInput } = require('./agyTools.cjs');
const museCli = require('./museCli.cjs');

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
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages',
    '--model', model, ...(effort ? ['--effort', effort] : []), '--dangerously-skip-permissions', '--settings', settingsPath,
    ...(systemPrompt ? ['--append-system-prompt', systemPrompt] : []),
    ...(resume ? ['--resume', sessionId] : ['--session-id', sessionId])];
}

function claudeUserLine(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
}

const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n').trim();

// --replay-user-messages: Claude 가 받아 처리하기 시작한 user 메시지를 stdout 으로 되돌려 준다 (2.1.312 실측).
function replayText(j) {
  if (j?.type !== 'user' || !j.isReplay || j.parent_tool_use_id != null) return null; // 하위 에이전트 쪽 메시지는 제외
  const c = j.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const texts = c.filter((b) => b?.type === 'text');
    return texts.length ? texts.map((b) => String(b.text ?? '')).join('') : null; // 글 없는 되돌림(도구 결과 등)은 확인으로 보지 않는다
  }
  return null;
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

const STEER_WAIT_MS = 30000; // 넣은 메시지를 기다리며 턴 끝을 미룬 뒤 출력이 이만큼 없으면 끝낸다

class ClaudeChat {
  constructor({ loc, cwd, settingsPath, systemPrompt, env, onEvent, spawn = nodeSpawn, kill = killTree, steerWaitMs = STEER_WAIT_MS }) {
    Object.assign(this, { loc, cwd, settingsPath, systemPrompt, env, onEvent, spawnFn: spawn, killFn: kill, steerWaitMs });
    this.sessionId = crypto.randomUUID();
    this.hasHistory = false; // 세션이 실제로 만들어진 뒤에만 --resume 으로 다시 띄운다
    this.proc = null; this.busy = false; this.config = null; this.turn = null;
    this.steered = []; // 넣었지만 아직 되돌아오지 않은 글 (norm 값)
    this.prompted = false; this.promptNorm = ''; // 이번 턴 프롬프트(norm 값)의 되돌림을 아직 받지 않음
    this.hold = null; // 넣은 메시지를 기다리는 동안의 감시 타이머
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
      if (this.hold) this.armHold(); // 출력이 오면 감시 타이머를 다시 시작
      const r = replayText(j);
      if (r != null) { this.onReplay(norm(r)); return; }
      for (const ev of parseClaudeLine(j)) {
        if (ev.type === 'session') { this.hasHistory = true; this.emit(ev); continue; }
        if (!this.busy) continue;
        if (ev.type !== 'done') { this.emit(ev); continue; }
        if (ev.ok && this.steered.length) { this.armHold(); continue; } // 넣은 메시지가 남았으면 이어지는 턴까지 같은 턴
        if (!ev.ok && this.steered.length) { this.finish(ev); this.restart(); continue; } // 실패면 CLI 대기열에 남은 메시지까지 버린다 (다음 send 는 --resume)
        this.finish(ev);
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
    if (this.busy) this.finish({ type: 'done', ok: false, error: message });
  }

  finish(ev) { this.clearHold(); this.busy = false; this.steered = []; this.emit(ev); }

  armHold() {
    clearTimeout(this.hold);
    this.hold = setTimeout(() => {
      this.hold = null;
      // 끝내 처리되지 않은 메시지가 CLI 대기열에 남아 다음 턴에 섞이지 않게 재시작한다 (다음 send 는 --resume).
      if (this.busy) { this.finish({ type: 'done', ok: true, unconfirmed: this.steered.length }); this.restart(); }
    }, this.steerWaitMs);
  }

  clearHold() { clearTimeout(this.hold); this.hold = null; }

  // 되돌림(받아 처리하기 시작함): 이번 턴 프롬프트와 같은 글이 먼저 오고, 그 뒤는 steer 로 넣은 글 — 넣은 글과 정확히 같을 때만 확인으로 본다.
  // 프롬프트 되돌림 전에 온 다른 글(예: 이어 쓰는 세션의 지난 기록)은 무시한다. 프롬프트 글이 어긋나 못 맞췄어도 넣은 글이 되돌아오면 프롬프트는 지난 것이다.
  onReplay(text) {
    if (this.prompted) {
      if (text === this.promptNorm) { this.prompted = false; return; }
      if (!this.steered.includes(text)) return;
      this.prompted = false;
    }
    const k = this.steered.indexOf(text);
    if (k < 0) return;
    this.steered.splice(k, 1);
    this.clearHold(); // 처리 중이라는 증거 — 남은 메시지가 있으면 다음 ok result 에서 다시 기다린다
    this.emit({ type: 'steered' });
  }

  // 답변 중인 프로세스에 바로 써 넣는다 — 도구 사이에 끼어 같은 답변에 반영되거나, 글만 쓰는 중이면 이어서 한 턴 더 답한다(실측).
  // 처리되면 되돌림으로 'steered' 를 알린다.
  steer(text, turn = null) {
    if (!this.busy || !this.proc || (turn != null && turn !== this.turn)) return false;
    const t = norm(text);
    if (!t) return false;
    this.steered.push(t);
    this.proc.stdin.write(claudeUserLine(String(text)));
    return true;
  }

  send(text, { model, effort }, turn = null) {
    if (this.proc && this.config !== `${model}/${effort}`) this.restart();
    if (!this.proc) this.start(model, effort);
    this.turn = turn; this.busy = true;
    this.steered = []; this.prompted = true; this.promptNorm = norm(text); this.clearHold();
    this.proc.stdin.write(claudeUserLine(text));
  }

  restart() {
    const p = this.proc; this.proc = null; this.killFn(p);
    this.steered = []; this.clearHold();
    if (!this.hasHistory) this.sessionId = crypto.randomUUID(); // 첫 응답 전에 끝났으면 같은 ID 를 다시 쓰지 않는다
  }

  stop() {
    const was = this.busy; this.busy = false;
    this.steered = []; this.clearHold();
    if (this.proc) this.restart();
    if (was) this.emit({ type: 'done', ok: false, stopped: true });
  }

  close() { this.busy = false; this.steered = []; this.clearHold(); if (this.proc) this.restart(); }
}

const CODEX_EXIT_WAIT_MS = 5000; // 같은 세션의 이전 프로세스가 끝나길 기다리는 상한
const CODEX_CARRY_NOTE = '[진행 중 추가 메시지] 답변하는 동안 사용자가 보낸 메시지입니다. 하던 답변이 이 메시지를 반영하려고 중간에 끊겼을 수 있습니다. 아래 내용을 반영해 하던 작업을 이어서 마무리하고, 끝나면 평소처럼 [완료]·[질문] 규칙을 따르세요.';

// 이 종류의 item 이 끝난 지점에서만 끊는다 (reasoning·시작 경고(error)·todo_list 는 제외 — 시작 경고는 turn.started 보다 먼저 온다, 0.165 실측).
const CODEX_CUT_AFTER = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'agent_message']);

// 한 번의 exec 실행 상태. waiting: 이전 프로세스 종료를 기다리는 중(아직 spawn 전), started: 이 실행이 턴을 시작함(turn.started),
// open: 시작했지만 끝나지 않은 작업 item.
function newRun(text, cfg, turn) {
  return { p: null, waiting: true, started: false, finished: false, turn, cfg, text, open: new Set(), queue: [], carry: 0, collab: false, timer: null };
}

class CodexChat {
  constructor({ loc, cwd, systemPrompt, hooks, env, onEvent, spawn = nodeSpawn, kill = killTree, exitWaitMs = CODEX_EXIT_WAIT_MS }) {
    Object.assign(this, { loc, cwd, systemPrompt, hooks, env, onEvent, spawnFn: spawn, killFn: kill, exitWaitMs });
    this.threadId = null;
    this.run = null; // 현재 실행 (newRun 참고)
    this.live = new Set(); // 턴이 끝났어도 아직 종료되지 않은 프로세스 (hook 실행 등) — 닫을 때 모두 끝낸다
    this.stale = new Set(); // 종료 대기 상한을 넘겨 기다리지 않기로 한 프로세스 — 닫을 때 끝낸다
  }

  get proc() { return this.run && !this.run.finished ? this.run.p : null; }

  get busy() { return !!this.run && !this.run.finished; }

  send(text, { model, effort }, turn = null) {
    this.abandon(); // 이전 턴이 남아 있으면 조용히 정리한다 (새 턴에 「중단됨」을 보내지 않음)
    this.run = newRun(text, { model, effort }, turn);
    this.launch(this.run);
  }

  // 같은 세션을 쓰는 이전 프로세스가 끝나기 전에 resume 하면 active writer 오류(실측) — 끝날 때까지 기다린다(상한).
  launch(run) {
    if (!this.live.size) { this.spawnRun(run); return; }
    run.timer = setTimeout(() => {
      // 상한까지 안 끝난 프로세스는 한 번 더 끝내 보고 대기 목록에서 뺀다 — 이후 턴마다 상한만큼 늦어지지 않게 (닫을 때는 stale 로 정리)
      for (const p of this.live) { this.killFn(p); this.stale.add(p); }
      this.live.clear();
      this.spawnRun(run);
    }, this.exitWaitMs);
    run.timer.unref?.();
  }

  spawnRun(run) {
    if (run !== this.run || run.finished || !run.waiting) return;
    clearTimeout(run.timer); run.waiting = false;
    const emit = (ev) => this.onEvent(run.turn == null ? ev : { ...ev, turn: run.turn });
    let p;
    try {
      const args = codexCli.execArgs({ resumeId: this.threadId, model: run.cfg.model, effort: run.cfg.effort, hooks: this.hooks });
      p = spawnCli(this.spawnFn, this.loc, args, { cwd: this.cwd, env: this.env });
    } catch (e) { // 미뤄 띄울 때는 타이머·exit 핸들러 안이라 던지면 아무도 받지 않는다 — 턴을 오류로 끝낸다
      run.finished = true; emit({ type: 'done', ok: false, error: `Codex 를 실행하지 못했습니다: ${e.message}` }); return;
    }
    run.p = p; this.live.add(p);
    const finish = (ev) => { if (run.finished) return; run.finished = true; emit(ev); };
    // 이전 프로세스가 모두 끝났고 새 실행이 기다리는 중이면 이제 시작한다.
    const next = () => { if (!this.live.size && this.run?.waiting && !this.run.finished) this.spawnRun(this.run); };
    let err = '';
    p.stdout.on('data', lineReader((j) => {
      if (run.finished) return; // 끝났거나 중단한 실행의 늦은 출력
      const it = j?.item;
      if (j?.type === 'turn.started') {
        run.started = true;
        for (let i = 0; i < run.carry; i++) emit({ type: 'steered' }); // 이어 보낸 메시지를 새 실행이 실제로 받았다
        run.carry = 0;
      }
      if (it?.id && it.type !== 'todo_list') {
        if (j.type === 'item.started') { run.open.add(it.id); if (it.type === 'collab_tool_call') run.collab = true; }
        else if (j.type === 'item.completed') run.open.delete(it.id);
      }
      for (const ev of parseCodexLine(j)) {
        if (ev.type === 'session') { this.threadId = this.threadId || ev.sessionId; emit(ev); }
        else if (ev.type === 'done') {
          if (ev.ok && run.queue.length) { this.carryOn(run, true); return; } // 턴이 끝났지만 넣은 메시지가 남음 — 같은 세션으로 이어 답한다
          finish(ev); // 실패면 남은 메시지는 버린다 (진행자가 확인 안 된 메시지를 다음 프롬프트에 넣는다)
        } else emit(ev);
      }
      // 턴을 시작한 뒤 명령·파일 변경·도구·답변 글이 하나 끝났고 열린 작업이 없는 지점에서만 끊는다. 하위 에이전트를 쓴 실행은 턴 끝에서 이어 답한다.
      if (j?.type === 'item.completed' && CODEX_CUT_AFTER.has(it?.type) && run.started && run === this.run && !run.finished
        && run.queue.length && !run.open.size && !run.collab) this.carryOn(run, false);
    }));
    p.stderr.on('data', (d) => { err = (err + d).slice(-600); });
    p.on('error', (e) => { this.live.delete(p); this.stale.delete(p); finish({ type: 'done', ok: false, error: `Codex 를 실행하지 못했습니다: ${e.message}` }); next(); });
    // exit 가 stdout 의 turn.completed 보다 먼저 오면 여기서 끝난다 — 남은 queue 는 버리고 진행자가 다음 차례로 넘긴다.
    p.on('exit', (code) => {
      this.live.delete(p); this.stale.delete(p);
      const tail = err.trim() ? `: ${err.trim().split('\n').pop().slice(0, 200)}` : '';
      finish(code === 0 ? { type: 'done', ok: true } : { type: 'done', ok: false, error: `Codex 가 응답 없이 종료되었습니다 (코드 ${code})${tail}` });
      next();
    });
    p.stdin.end(this.threadId || !this.systemPrompt ? run.text : `${this.systemPrompt}\n\n${run.text}`);
  }

  // Codex exec 는 실행 중 입력을 받지 않는다 — 안전 지점에서 지금 실행을 끊고 옛 프로세스가 끝난 뒤 같은 세션(exec resume)으로 그 메시지를 보내 이어 답하게 한다(실측).
  steer(text, turn = null) {
    const run = this.run;
    if (!run || run.finished || (turn != null && turn !== run.turn)) return false;
    const t = String(text ?? '').trim();
    if (!t) return false;
    if (run.waiting) { run.text += `\n\n${text}`; run.carry++; return true; } // 아직 실행 전이면 보낼 글에 합친다
    run.queue.push(String(text)); // 안전 지점(무언가 끝나고 열린 작업 없음)이나 턴 끝에서 이어 답한다
    return true;
  }

  carryOn(run, ended) {
    const texts = run.queue.splice(0);
    run.finished = true; // 이 실행의 늦은 출력·종료는 무시
    if (!ended) this.killFn(run.p);
    const next = newRun(`${CODEX_CARRY_NOTE}\n\n${texts.join('\n\n')}`, run.cfg, run.turn);
    next.carry = texts.length; // 새 실행이 턴을 시작하면 steered 를 낸다 (받았다는 확인)
    this.run = next; this.launch(next);
  }

  abandon() {
    const run = this.run;
    if (!run || run.finished) return null;
    run.finished = true;
    clearTimeout(run.timer);
    if (run.p) this.killFn(run.p); // 대기 중인 실행은 프로세스가 없다
    return run;
  }

  stop() {
    const run = this.abandon();
    if (run) this.onEvent(run.turn == null ? { type: 'done', ok: false, stopped: true } : { type: 'done', ok: false, stopped: true, turn: run.turn });
  }

  close() {
    this.abandon();
    for (const p of [...this.live, ...this.stale]) this.killFn(p);
    this.live.clear(); this.stale.clear();
  }
}

// 프롬프트 파일을 쓰고 턴마다 프로세스를 띄우는 협업 실행기의 공통 골격 (Grok·Muse·Antigravity).
//  - 프롬프트는 --prompt-file 로 넘긴다 (stdin 은 읽지 않음 — 한글·큰따옴표·% 가 셸을 거치지 않아 깨지지 않는다). 파일은 프로세스가 끝나면 반드시 지운다.
//    (Antigravity 는 프롬프트 파일 옵션이 없어 -p 인자로 넘기고, 긴 프롬프트만 이 파일을 읽게 한다.)
//  - 출력 줄마다 하위 클래스의 parse 가 이벤트로 바꾼다. 'end' 이벤트는 턴이 끝났다는 내부 표시라 대화창에 내보내지 않는다.
//  - 하위 클래스가 채울 것: subj·obj(오류 문구의 AI 이름과 조사)·filePrefix(프롬프트 파일 이름) · buildArgs({ file, resume, model, effort }) · parse(j) · failText(tail, errText)
const GROK_EFFORT_RE = /^(low|medium|high|xhigh)$/;
const GROK_EXIT_WAIT_MS = 300; // exit 가 stdout 의 마지막 줄(end)보다 먼저 올 수 있어 close 를 이만큼 기다린 뒤 끝낸다
const GROK_END_GRACE_MS = 3000; // end 줄을 받은 뒤 프로세스가 이 안에 끝나지 않으면 정상으로 끝내고 프로세스를 죽인다
const GROK_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/; // 첫 글자는 영숫자 (-로 시작하면 CLI 옵션으로 읽힐 수 있다)
const PROMPT_FILE_RE = /^ao-(?:grok|muse|agy)-\d+-\d+\.txt$/; // 이 앱이 만드는 프롬프트 파일 이름 규칙 (FileTurnChat.send)
let promptSeq = 0;

// 앱이 비정상 종료해 남은 프롬프트 파일 중 오래된 것만 지운다 (앱 시작 때). 이 앱의 이름 규칙에 맞는 파일만 대상이다.
function cleanStalePromptFiles({ tmpDir = os.tmpdir(), now = Date.now(), maxAgeMs = 3600000, fsApi = fs } = {}) {
  let n = 0;
  let names = [];
  try { names = fsApi.readdirSync(tmpDir); } catch { return 0; }
  for (const name of names) {
    if (!PROMPT_FILE_RE.test(name)) continue;
    const file = path.join(tmpDir, name);
    try {
      const st = fsApi.statSync(file);
      if (!st.isFile() || now - st.mtimeMs <= maxAgeMs) continue;
      fsApi.rmSync(file, { force: true }); n++;
    } catch { /* 다른 프로세스가 쓰는 중이면 건너뛴다 */ }
  }
  return n;
}

class FileTurnChat {
  constructor({ loc, cwd, systemPrompt, env, onEvent, spawn = nodeSpawn, kill = killTree, tmpDir = os.tmpdir(), endGraceMs = GROK_END_GRACE_MS }) {
    Object.assign(this, { loc, cwd, systemPrompt, env, onEvent, spawnFn: spawn, killFn: kill, tmpDir, endGraceMs });
    this.sessionId = crypto.randomUUID();
    this.started = false; // 첫 턴이 정상으로 끝난 뒤에만 이어 간다 (Grok 은 -r, Muse 는 같은 --session-id)
    this.announcedId = null; // 마지막으로 알린 세션 ID — 바뀔 때마다 session 이벤트를 다시 낸다 (협업 방 ↔ CLI 세션 연결용)
    this.closed = false;
    this.run = null; // 현재 실행: { p, file, turn, finished, stopped, ended, endOk, error, errText, timer, endTimer, wrote, sawText }
  }

  get proc() { return this.run && !this.run.finished ? this.run.p : null; }

  get busy() { return !!this.run && !this.run.finished; }

  // 실행 직전에 세션 ID 를 알린다 (앱이 ID 를 정하는 Grok·Muse). 대화 ID 를 CLI 가 정하는 AI 는 끄고 출력에서 받은 뒤 알린다.
  get announceOnSpawn() { return true; }

  send(text, { model, effort } = {}, turn = null) {
    if (this.closed || this.busy) return;
    const run = { p: null, file: path.join(this.tmpDir, `ao-${this.filePrefix}-${process.pid}-${++promptSeq}.txt`), turn, finished: false, stopped: false, ended: false, endOk: true, error: '', errText: '', timer: null, endTimer: null, wrote: false, sawText: false };
    this.run = run;
    const emit = (ev) => this.onEvent(turn == null ? ev : { ...ev, turn });
    // 내가 쓴 파일만 지운다 (wx 로 만들지 못한 — 이미 있던 — 파일은 건드리지 않는다)
    const cleanup = () => { if (run.wrote) try { fs.rmSync(run.file, { force: true }); } catch { /* 열려 있으면 프로세스가 끝난 뒤 다시 지운다 */ } };
    const finish = () => {
      if (run.finished) return;
      run.finished = true; clearTimeout(run.timer); clearTimeout(run.endTimer); cleanup();
      if (run.ended && run.endOk) this.started = true; // 첫 턴은 이미 성공 — 유예 중 중단돼도 세션 ID 를 유지한다
      if (run.ended && run.endOk && !run.stopped) { emit({ type: 'done', ok: true }); return; }
      if (!this.started) this.sessionId = crypto.randomUUID(); // 첫 응답 전에 실패·중단됐으면 같은 ID 를 다시 쓰지 않는다 (다음 send 가 session 을 다시 알린다)
      if (run.stopped) emit({ type: 'done', ok: false, stopped: true });
      else emit({ type: 'done', ok: false, error: run.error || this.failText(tail, run.errText) });
    };
    let tail = '';
    run.cleanup = cleanup; run.finish = finish;
    try {
      const args = this.buildArgs({ file: run.file, resume: this.started, model, effort });
      run.wrote = true;
      try {
        fs.writeFileSync(run.file, this.started || !this.systemPrompt ? String(text) : `${this.systemPrompt}\n\n${text}`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      } catch (e) { if (e.code === 'EEXIST') run.wrote = false; throw e; } // 이미 있는 파일은 덮어쓰지도 지우지도 않는다
      run.p = spawnCli(this.spawnFn, this.loc, args, { cwd: this.cwd, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      run.error = `${this.obj} 실행하지 못했습니다: ${e.message}`; finish(); return;
    }
    const p = run.p;
    if (this.announceOnSpawn && this.announcedId !== this.sessionId) { this.announcedId = this.sessionId; emit({ type: 'session', sessionId: this.sessionId }); }
    p.stdout.on('data', lineReader((j) => {
      if (run.finished) return; // 중단했거나 끝난 실행의 늦은 출력
      const ev = this.parse(j);
      if (!ev) return;
      if (ev.type === 'end') {
        run.ended = true; run.endOk = ev.ok !== false;
        if (!run.endOk) run.error = String(ev.reason || ev.text || '').slice(0, 300) || `${this.subj} 오류로 끝났습니다`;
        else if (ev.text && !run.sawText) emit({ type: 'text', text: ev.text }); // 조각 출력 없이 최종 응답만 온 경우
        // 끝 줄을 받았는데 프로세스가 끝나지 않으면(자식이 파이프를 쥐고 있는 경우 등) 잠시 기다렸다가 정상으로 끝내고 죽인다
        clearTimeout(run.endTimer); // 끝 줄이 또 오면 유예를 다시 잰다 (앞 타이머를 남기지 않는다)
        run.endTimer = setTimeout(() => { if (run.finished) return; this.killFn(run.p); finish(); }, this.endGraceMs);
        run.endTimer.unref?.();
        return;
      }
      if (ev.type === 'notice') run.error = ev.text;
      if (ev.type === 'text' && ev.text) run.sawText = true;
      emit(ev);
    }));
    p.stderr?.on?.('data', (d) => { tail = String(d).trim().split('\n').pop().slice(0, 200) || tail; run.errText = (run.errText + d).slice(-600); });
    p.on('error', (e) => { run.error ||= `${this.obj} 실행하지 못했습니다: ${e.message}`; finish(); cleanup(); });
    p.on('close', () => { finish(); cleanup(); }); // 중단·닫기로 먼저 끝난 실행도 프로세스가 끝나면 프롬프트 파일을 다시 지운다
    p.on('exit', () => { if (!run.finished) { run.timer = setTimeout(finish, GROK_EXIT_WAIT_MS); run.timer.unref?.(); } });
  }

  // 실행 중 입력을 받지 않는다 — 진행자가 턴이 끝난 뒤 다음 차례에 전달한다.
  steer() { return false; }

  stop() {
    const run = this.run;
    if (!run || run.finished) return;
    run.stopped = true;
    this.killFn(run.p);
    run.finish(); // 종료 이벤트를 기다리지 않고 바로 「중단됨」으로 끝낸다 (kill 은 비동기 — 늦은 출력은 무시)
  }

  close() {
    this.closed = true;
    const run = this.run;
    if (!run || run.finished) return;
    run.finished = true; clearTimeout(run.timer); clearTimeout(run.endTimer);
    this.killFn(run.p);
    run.cleanup();
  }
}

// Grok Build 협업: 턴마다 실행하고 -r 로 같은 세션을 이어 간다 (grok 1.0.70 실측).
//  - 승인 없이 실행: 공식 --always-approve (Codex 협업의 승인 우회와 같은 역할)
//  - 출력 --output-format streaming-json: 줄마다 JSON ({type:'text'|'tool_call'|'end'|'error'|…})
function grokChatArgs({ file, cwd, sessionId, resume, model, effort }) {
  return ['--prompt-file', file, '--output-format', 'streaming-json', '--no-auto-update', '--always-approve', '--cwd', cwd,
    ...(resume ? ['-r', sessionId] : ['-s', sessionId]),
    ...(model && model !== 'auto' && GROK_MODEL_RE.test(String(model)) ? ['-m', model] : []),
    ...(effort && effort !== 'auto' && GROK_EFFORT_RE.test(String(effort)) ? ['--effort', effort] : [])];
}

// end 는 턴이 정상으로 끝났다는 내부 표시라 대화창에 내보내지 않는다 (FileTurnChat 이 처리). thought·usage·available_commands·tool_call_update 는 null.
function parseGrokLine(j) {
  if (!j || typeof j !== 'object') return null;
  if (j.type === 'text') return { type: 'text', text: String(j.data ?? '') };
  if (j.type === 'tool_call') return { type: 'tool', name: GROK_TOOL_NAMES[j.toolName] || String(j.toolName || j.title || 'tool').slice(0, 80), input: pick(pickGrokInput(j.rawInput)) };
  if (j.type === 'end') return { type: 'end', stopReason: String(j.stopReason ?? '') };
  if (j.type === 'error') return { type: 'notice', text: String(j.message || '오류').slice(0, 300) };
  return null;
}

class GrokChat extends FileTurnChat {
  get subj() { return 'Grok 이'; }

  get obj() { return 'Grok 을'; }

  get filePrefix() { return 'grok'; }

  buildArgs({ file, resume, model, effort }) { return grokChatArgs({ file, cwd: this.cwd, sessionId: this.sessionId, resume, model, effort }); }

  parse(j) { return parseGrokLine(j); }

  failText(tail) { return tail || 'Grok 이 응답 없이 끝났습니다'; }
}

// Muse Code 협업: 턴마다 `muse exec --json` 을 실행하고 같은 --session-id 로 대화를 이어 간다 (muse 1.4.14 실측, 인자·줄 해석은 museCli.cjs).
//  - 세션 ID 는 방 내내 같은 UUID 를 쓴다 (첫 턴 실패·중단이면 새 ID + session 재통지). 사무실 hook 은 hooks(-c hooks.<이벤트>=…)로 넣고 주소의 tab 이 방 ID 라 매핑 표가 필요 없다.
//  - extraArgs: exec 인자 끝에 덧붙인다 (점검에서 --provider echo 로 로그인 없이 실제 실행해 보기 위함).
//  - cmd.exe 경유(cmdShim) 위치는 JSON 인자가 깨지므로 만들 때 거절한다 (실행 파일 muse-bin-*.exe 를 직접 써야 한다).
class MuseChat extends FileTurnChat {
  constructor(opts) {
    if (opts?.loc?.cmdShim) throw new Error('Muse 실행 파일(muse-bin-*.exe)을 찾지 못했습니다 — Muse 를 다시 설치하세요');
    super(opts);
    this.hooks = opts.hooks || [];
    this.extraArgs = opts.extraArgs || [];
  }

  // 도구 호출 중복 제거 표는 턴마다 새로 시작한다 (이미 실행 중이면 send 는 무시되므로 표도 건드리지 않는다).
  send(text, opts, turn = null) {
    if (this.closed || this.busy) return;
    this.seenTools = new Set();
    super.send(text, opts, turn);
  }

  get subj() { return 'Muse 가'; }

  get obj() { return 'Muse 를'; }

  get filePrefix() { return 'muse'; }

  buildArgs({ file, model, effort }) {
    return [...museCli.execArgs({ promptFile: file, sessionId: this.sessionId, model, effort, hooks: this.hooks }), ...this.extraArgs];
  }

  parse(j) { return museCli.parseMuseLine(j, this.sessionId, this.seenTools); }

  failText(tail, errText) {
    if (museCli.LOGIN_HINT_RE.test(errText) || museCli.LOGIN_HINT_RE.test(tail)) return 'Muse 로그인이 필요합니다 (결제 수단·구독이 있는 Meta 계정)';
    return tail || 'Muse 가 응답 없이 끝났습니다';
  }
}

// Antigravity(agy) 협업: 턴마다 `agy -p` 를 실행하고 --conversation 으로 같은 대화를 이어 간다 (agy 1.4.12 실측).
//  - 프롬프트는 -p 인자 (Node spawn 인자로 넘긴 한글·따옴표·%PATH%·개행이 그대로 전달된다 — cmd 를 거치지 않는 agy.exe 직접 실행이 전제).
//    명령줄 길이 제한(Windows 32767자)에 걸리지 않게, 이스케이프 후 AGY_ARG_MAX 를 넘는 프롬프트는 FileTurnChat 이 쓴 프롬프트 파일을 읽게 하는 안내 문장을 넘긴다.
//  - 승인 없이 실행: 공식 --dangerously-skip-permissions (이것 없이 비대화 모드는 명령 실행을 자동 거부한다 — 실측)
//  - agy 에는 --cwd 가 없어 작업 폴더는 spawn 의 cwd 다.
//  - 출력 --output-format stream-json: 줄마다 JSON ({event:'init'|'step_update'|'result'})
const AGY_ARG_MAX = 24000;
const AGY_MODEL_RE = GROK_MODEL_RE;

// --effort 는 쓰지 않는다: Gemini 는 단계가 모델 이름(gemini-3.8-flash-high 등 High·Medium·Low)에 들어 있다 (모델 목록을 못 받았을 때도 — 확인 안 된 조합을 만들지 않게).
function agyChatArgs({ prompt, conversationId, resume, model }) {
  return ['-p', prompt, '--output-format', 'stream-json', '--dangerously-skip-permissions',
    ...(resume && conversationId ? ['--conversation', conversationId] : []),
    ...(model && model !== 'auto' && AGY_MODEL_RE.test(String(model)) ? ['--model', model] : [])];
}

// 대화 ID: init 줄은 최상위(`{"event":"init","conversation_id":"…","init":{…}}` — 1.4.12 실측), step_update·result 는 같은 이름의 객체 안쪽에 있다.
function agyConversationId(j) {
  const id = j?.conversation_id ?? j?.[j?.event]?.conversation_id;
  return typeof id === 'string' && id ? id : null;
}

// 한 줄 → 이벤트 (순수 함수). 대화 ID 갱신·단락 구분·도구 중복 거르기는 AgyChat.parse 가 맡는다.
function parseAgyLine(j) {
  if (!j || typeof j !== 'object') return null;
  if (j.event === 'init') { const id = agyConversationId(j); return id ? { type: 'session', sessionId: id } : null; }
  if (j.event === 'result') {
    const r = j.result || {};
    const ok = r.status === 'SUCCESS';
    return { type: 'end', ok, text: typeof r.response === 'string' ? r.response : '', reason: ok ? '' : String(r.response || r.status || '') };
  }
  const s = j.event === 'step_update' ? j.step_update : null;
  if (!s || typeof s !== 'object') return null;
  if (s.step_type === 'agent_response') return typeof s.text_delta === 'string' && s.text_delta ? { type: 'text', text: s.text_delta } : null;
  // 도구 오류(state ERROR)는 모델이 스스로 다룬다 — 대화창에 오류로 띄우지 않는다
  if (s.step_type === 'tool' && s.state === 'ACTIVE' && s.tool_name) return { type: 'tool', name: AGY_TOOL_NAMES[s.tool_name] || String(s.tool_name).slice(0, 80), input: pick(pickAgyInput(s.tool_info?.parameters)) };
  return null;
}

const AGY_ERROR_RE = /"short_error":"((?:[^"\\]|\\.)*)"/;
const AGY_LOGIN_RE = /please sign in|not signed in|sign in to|authenticat/i;

class AgyChat extends FileTurnChat {
  // onUsage(usage): 턴이 끝날 때 result.usage 객체를 받는다 (사용량 단계에서 연결)
  // cmd.exe 경유(cmdShim) 위치는 프롬프트 인자(개행·따옴표)가 깨지므로 만들 때 거절한다.
  constructor(opts) {
    if (opts?.loc?.cmdShim) throw new Error('Antigravity CLI 실행 파일(agy.exe)을 찾지 못했습니다');
    super(opts);
    this.onUsage = opts.onUsage;
    this.agyId = null; // agy 가 정한 대화 ID — 이것이 있고 첫 턴이 성공했을 때만 --conversation 으로 이어 간다
    this.promptText = '';
  }

  // 대화 ID 는 agy 가 정한다 — 실행 전 임시 ID 는 알리지 않고, 출력에서 받은 ID 만 알린다.
  get announceOnSpawn() { return false; }

  // FileTurnChat.send 는 buildArgs 를 파일을 쓰기 전에 부르고 글을 넘기지 않으므로, 프롬프트(첫 턴은 규칙 포함)를 미리 기억해 둔다.
  // 도구·단락 표는 턴마다 새로 시작한다 (이미 실행 중이면 send 는 무시되므로 표도 건드리지 않는다).
  send(text, opts, turn = null) {
    if (this.closed || this.busy) return;
    this.promptText = this.started || !this.systemPrompt ? String(text) : `${this.systemPrompt}\n\n${text}`;
    if (!this.started) this.agyId = null; // 실패한 첫 턴의 ID 는 이어받지 않는다
    this.seenTools = new Set(); this.textStep = null;
    super.send(text, opts, turn);
  }

  get subj() { return 'Gemini 가'; }

  get obj() { return 'Gemini 를'; }

  get filePrefix() { return 'agy'; }

  // 길이는 JSON 이스케이프 후로 센다 (따옴표·역슬래시가 많으면 실제 명령줄이 더 길어진다).
  buildArgs({ file, resume, model, effort }) {
    const prompt = JSON.stringify(this.promptText).length > AGY_ARG_MAX
      ? `다음 파일의 내용을 그대로 읽고, 그 안의 지시에 따라 답하세요: ${file}` : this.promptText;
    return agyChatArgs({ prompt, conversationId: this.agyId, resume: resume && !!this.agyId, model, effort });
  }

  parse(j) {
    const id = agyConversationId(j);
    if (id) {
      this.agyId = id; this.sessionId = id;
      // 알린 ID 와 다르면 조용히 덮어쓰지 않고 session 이벤트로 알린다 (협업 방 ↔ agy 대화 연결)
      if (id !== this.announcedId) {
        this.announcedId = id;
        const turn = this.run?.turn;
        this.onEvent(turn == null ? { type: 'session', sessionId: id } : { type: 'session', sessionId: id, turn });
      }
    }
    const ev = j?.event === 'init' ? null : parseAgyLine(j); // init 의 session 은 위에서 한 번만 알린다
    if (j?.event === 'result' && j.result?.usage && typeof j.result.usage === 'object') this.onUsage?.(j.result.usage);
    if (!ev) return null;
    // 한 턴에 답변 단계(agent_response)가 여러 번 온다 (도구 호출 사이) — 단계가 바뀌면 문단을 나눈다
    if (ev.type === 'text') {
      const step = j.step_update.step_index;
      if (step !== this.textStep) { this.textStep = step; return { ...ev, block: true }; }
    }
    // 같은 단계의 ACTIVE 는 한 번만 알린다
    if (ev.type === 'tool' && typeof j.step_update.step_index === 'number') {
      if (this.seenTools.has(j.step_update.step_index)) return null;
      this.seenTools.add(j.step_update.step_index);
    }
    return ev;
  }

  failText(tail, errText) {
    if (AGY_LOGIN_RE.test(errText) || AGY_LOGIN_RE.test(tail)) return 'Gemini 로그인이 필요합니다 (진입 화면에서 로그인)';
    const m = String(errText).match(AGY_ERROR_RE); // 잘린 JSON 일 수 있어 JSON.parse 대신 정규식으로 읽는다
    if (m) return m[1].replace(/\\(.)/g, '$1').slice(0, 200);
    return tail || 'Gemini 가 응답 없이 끝났습니다';
  }
}

module.exports = { claudeChatArgs, claudeUserLine, replayText, parseClaudeLine, parseClaudeModels, claudeModels, parseCodexLine, grokChatArgs, parseGrokLine, agyChatArgs, parseAgyLine, cleanStalePromptFiles, lineReader, killTree, spawnCli, ClaudeChat, CodexChat, GrokChat, MuseChat, AgyChat };
