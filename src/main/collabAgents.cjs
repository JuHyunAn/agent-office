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

module.exports = { claudeChatArgs, claudeUserLine, replayText, parseClaudeLine, parseClaudeModels, claudeModels, parseCodexLine, lineReader, killTree, ClaudeChat, CodexChat };
