'use strict';

// 사용량 서비스: Claude·Codex 계정 사용량과 활성 탭의 세션 정보(요청 수·컨텍스트 %)를 모아 스냅샷으로 만든다.
// 출처는 모두 모델 요청이 없는 것뿐이다 — Claude: 상태 표시줄 중계(공짜)·/usage 화면 읽기, Codex: 롤아웃의 token_count·app-server 한도 조회.
// 스냅샷은 onChange 로 내보내고(펫이 정리해 표시), 화면은 사용량의 출처가 아니다.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const codexCli = require('./codexCli.cjs');
const { readClaudeUsage } = require('./claudeUsage.cjs');

const MANUAL_GAP_MS = 5 * 60 * 1000; // 수동 갱신 최소 간격
const HOUR_MS = 60 * 60 * 1000;
const FIRST_AUTO_MS = 2 * 60 * 1000; // 앱 시작 뒤 첫 자동 갱신
const MAX_SESSIONS = 200;
const MAX_FAILS = 3; // Claude /usage 읽기가 이만큼 연달아 실패하면 자동 갱신을 멈춘다
const ROLLOUT_DEBOUNCE_MS = 1000;
const ROLLOUT_TAIL = 256 * 1024;
const FOCUS_KINDS = ['claude', 'codex', 'collab'];

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

// Codex 롤아웃 끝부분의 줄들. 경로는 실제 위치가 ~/.codex/sessions 아래 .jsonl 일 때만 읽는다 (hook 본문의 경로를 그대로 믿지 않는다).
async function readRolloutTail(file) {
  const fsp = fs.promises;
  const root = await fsp.realpath(path.join(codexHome(), 'sessions'));
  const real = await fsp.realpath(file);
  const inside = (a, b) => (process.platform === 'win32' ? a.toLowerCase().startsWith(b.toLowerCase()) : a.startsWith(b));
  if (!real.toLowerCase().endsWith('.jsonl') || !inside(real, root + path.sep)) return null;
  const fh = await fsp.open(real, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - ROLLOUT_TAIL);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // 중간에서 잘린 첫 줄
    return lines.filter(Boolean);
  } finally {
    await fh.close();
  }
}

const defaultSchedule = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; };

const pct = (v) => Math.max(0, Math.min(100, Math.round(Number(v))));
const ROW_ORDER = (r) => (r.id === 'session' ? 0 : r.id === 'week' ? 1 : 2);

// 주입 가능한 부분(읽기 함수·시계·타이머)은 모두 테스트에서 가짜로 바꾼다.
function createUsageService({
  locateClaude, locateCodex, userDataDir, onChange = () => {}, smoke = false, now = Date.now, appVersion = '0.1.0',
  readClaude = readClaudeUsage, readCodex = codexCli.rateLimits, readRollout = readRolloutTail,
  schedule = defaultSchedule, cancel = clearTimeout,
}) {
  const claudeRows = new Map(); // id → { ...Row, source: 'status'|'usage' }
  const codexRows = new Map(); // id → { ...Row, source: 'rollout'|'app-server' }
  const sessions = new Map(); // sessionId → { cli, tab, requests, contextPercent, transcriptPath, at } — 오래된 것부터 밀려난다
  const tabSession = new Map(); // 탭 → 그 탭의 최신 세션
  const rolloutTimers = new Map(); // sessionId → 디바운스 타이머
  let focus = null;
  let claudeError = null;
  let codexError = null;
  let busy = false;
  let lastRunAt = null;
  let lastManualAt = null;
  let lastClaudeRunAt = null;
  let lastClaudeActivityAt = 0;
  let noSessionSig = null; // session_id 없는 상태 표시줄 입력의 직전 값 서명
  let claudeFails = 0;
  let claudeAutoOff = false;
  let timerHandle = null;
  let abort = null; // 진행 중인 Claude /usage 읽기
  let codexAbort = null; // 진행 중인 Codex app-server 조회
  let lastKey = '';
  let disposed = false;

  function merge(map, rows, source) {
    for (const r of rows) {
      const cur = map.get(r.id);
      if (!cur || r.observedAt >= cur.observedAt) map.set(r.id, { ...r, source });
    }
  }

  // 표시 때 리셋 시각이 지났으면 percent 를 비운다 (「리셋됨」). 원본 값은 그대로 둔다.
  function view(map) {
    const t = now();
    return [...map.values()].sort((a, b) => ROW_ORDER(a) - ROW_ORDER(b) || a.label.localeCompare(b.label)).map(({ source, ...r }) => (
      r.resetsAt != null && r.resetsAt < t ? { ...r, percent: null } : r));
  }

  const updatedAt = (map) => (map.size ? Math.max(...[...map.values()].map((r) => r.observedAt)) : null);

  function sessionLine() {
    if (!focus || !focus.tabId || (focus.kind !== 'claude' && focus.kind !== 'codex')) return null; // 협업·활성 탭 없음
    const s = sessions.get(tabSession.get(focus.tabId));
    return s ? { kind: focus.kind, label: focus.label, requests: s.requests, contextPercent: s.contextPercent } : null;
  }

  function snapshot() {
    const t = now();
    return {
      claude: { rows: view(claudeRows), error: claudeError, updatedAt: updatedAt(claudeRows) },
      codex: { rows: view(codexRows), error: codexError, updatedAt: updatedAt(codexRows) },
      session: sessionLine(),
      refresh: { busy, nextAllowedAt: lastManualAt != null && lastManualAt + MANUAL_GAP_MS > t ? lastManualAt + MANUAL_GAP_MS : null, lastRunAt },
    };
  }

  // 내용이 같으면 알리지 않는다. force 는 「거절됨」처럼 화면이 다시 확인해야 할 때.
  function emit(force = false) {
    if (disposed) return;
    const s = snapshot();
    const key = JSON.stringify(s);
    if (key === lastKey && !force) return;
    lastKey = key;
    try { onChange(s); } catch { /* 화면 쪽 오류는 무시 */ }
  }

  function drop(sid) {
    const s = sessions.get(sid);
    if (!s) return;
    sessions.delete(sid);
    if (s.tab && tabSession.get(s.tab) === sid) tabSession.delete(s.tab);
    cancel(rolloutTimers.get(sid));
    rolloutTimers.delete(sid);
  }

  // 세션을 가져오거나 만들고 가장 최근 것으로 올린다. 상한을 넘으면 가장 오래된 것부터 지운다.
  function touch(sid, cli, tab) {
    let s = sessions.get(sid);
    if (s) sessions.delete(sid);
    else s = { cli, tab: null, requests: 0, contextPercent: null, transcriptPath: null, at: 0 };
    s.at = now();
    sessions.set(sid, s);
    if (tab) { s.tab = tab; tabSession.set(tab, sid); }
    while (sessions.size > MAX_SESSIONS) drop(sessions.keys().next().value);
    return s;
  }

  async function readRolloutNow(sid) {
    rolloutTimers.delete(sid);
    const s = sessions.get(sid);
    if (disposed || !s || !s.transcriptPath) return;
    let lines = null;
    try { lines = await readRollout(s.transcriptPath); } catch { /* 파일이 아직 없거나 읽을 수 없음 */ }
    if (disposed || !lines || sessions.get(sid) !== s) return;
    const r = codexCli.parseRollout(lines, now());
    if (!r) return;
    merge(codexRows, r.rows, 'rollout');
    if (r.contextPercent != null) s.contextPercent = r.contextPercent;
    emit();
  }

  function onHookEvent(ev, meta) {
    if (disposed || !ev || typeof ev.session_id !== 'string' || !ev.session_id) return;
    const sid = ev.session_id;
    if (ev.hook_event_name === 'SessionEnd') { drop(sid); emit(); return; }
    const cli = ev._cli === 'codex' ? 'codex' : 'claude';
    const s = touch(sid, cli, ev._tab);
    if (ev.hook_event_name === 'UserPromptSubmit') s.requests++;
    if (cli === 'claude') {
      lastClaudeActivityAt = now();
    } else if (meta && typeof meta.transcriptPath === 'string' && meta.transcriptPath) {
      s.transcriptPath = meta.transcriptPath;
      if (ev.hook_event_name === 'Stop' || ev.hook_event_name === 'UserPromptSubmit') {
        cancel(rolloutTimers.get(sid));
        rolloutTimers.set(sid, schedule(() => { readRolloutNow(sid); }, ROLLOUT_DEBOUNCE_MS));
      }
    }
    emit();
  }

  // 상태 표시줄 입력: rate_limits(five_hour·seven_day)와 context_window.used_percentage.
  function onStatus(payload, tab) {
    if (disposed || !payload || typeof payload !== 'object') return;
    const t = now();
    // 값이 직전과 같은 반복 호출(상태 표시줄 새로 고침)은 Claude 활동이 아니다 — 자동 /usage 읽기를 불러내지 않게.
    const rl = payload.rate_limits;
    const sig = JSON.stringify([rl?.five_hour?.used_percentage, rl?.five_hour?.resets_at, rl?.seven_day?.used_percentage, rl?.seven_day?.resets_at, payload.context_window?.used_percentage]);
    const hasSid = typeof payload.session_id === 'string' && payload.session_id;
    const prevSig = hasSid ? sessions.get(payload.session_id)?.statusSig : noSessionSig;
    if (sig !== prevSig) lastClaudeActivityAt = t;
    if (!hasSid) noSessionSig = sig;
    for (const [key, id, label] of [['five_hour', 'session', '세션'], ['seven_day', 'week', '주간']]) {
      const w = payload.rate_limits?.[key];
      if (!w || typeof w.used_percentage !== 'number' || !Number.isFinite(w.used_percentage)) continue;
      const resets = Number(w.resets_at);
      const resetsAt = Number.isFinite(resets) && resets > 0 ? (resets < 1e12 ? resets * 1000 : resets) : null;
      merge(claudeRows, [{ id, label, percent: pct(w.used_percentage), resetsAt, resetsText: null, observedAt: t }], 'status');
    }
    if (hasSid) {
      const s = touch(payload.session_id, 'claude', tab);
      s.statusSig = sig;
      const used = payload.context_window?.used_percentage;
      if (typeof used === 'number' && Number.isFinite(used)) s.contextPercent = pct(used);
    }
    emit();
  }

  function setFocus(f) {
    focus = f && typeof f === 'object'
      ? { tabId: typeof f.tabId === 'string' ? f.tabId : null, kind: FOCUS_KINDS.includes(f.kind) ? f.kind : null, label: typeof f.label === 'string' ? f.label.slice(0, 60) : '' }
      : null;
    emit();
  }

  async function readClaudeNow(manual) {
    if (!manual && (claudeAutoOff || (lastClaudeRunAt != null && lastClaudeActivityAt <= lastClaudeRunAt))) return; // 자동은 직전 실행 뒤 활동이 있을 때만
    const loc = await locateClaude();
    if (disposed) return; // 찾는 사이 앱이 끝났으면 숨긴 claude 를 새로 띄우지 않는다
    if (!loc) { if (manual) claudeError = 'Claude Code 를 찾지 못했습니다'; return; }
    lastClaudeRunAt = now();
    abort = new AbortController();
    const r = await readClaude({ loc, cwd: path.join(userDataDir, 'usage-probe'), signal: abort.signal });
    abort = null;
    if (disposed) return;
    if (r.error) {
      claudeError = r.error;
      if (++claudeFails >= MAX_FAILS) claudeAutoOff = true;
    } else {
      merge(claudeRows, r.rows, 'usage');
      claudeError = null;
      claudeFails = 0;
      claudeAutoOff = false; // 수동으로 성공하면 자동 갱신을 다시 켠다
    }
  }

  async function readCodexNow(manual) {
    const loc = await locateCodex();
    if (disposed || !loc) return;
    if (!manual) {
      const times = [...codexRows.values()].filter((r) => r.source === 'rollout').map((r) => r.observedAt);
      if (times.length && now() - Math.max(...times) < HOUR_MS) return; // 최근 롤아웃 값이 있으면 앱 서버를 부르지 않는다
    }
    codexAbort = new AbortController();
    const r = await readCodex(loc, { appVersion, signal: codexAbort.signal });
    codexAbort = null;
    if (disposed) return;
    if (r.error) { codexError = r.error; return; }
    merge(codexRows, r.rows, 'app-server');
    codexError = null;
  }

  async function refresh({ manual = false } = {}) {
    if (disposed || smoke || busy) return;
    if (manual) {
      const t = now();
      if (lastManualAt != null && t - lastManualAt < MANUAL_GAP_MS) { emit(true); return; } // 거절 — 화면이 다시 확인하도록 알린다
      lastManualAt = t;
    }
    busy = true;
    emit();
    try {
      await Promise.all([
        readClaudeNow(manual).catch((e) => { claudeError = String(e && e.message || e).slice(0, 100); }),
        readCodexNow(manual).catch((e) => { codexError = String(e && e.message || e).slice(0, 100); }),
      ]);
    } finally {
      busy = false;
      lastRunAt = now();
      emit();
    }
  }

  // 앱 시작 2분 뒤 한 번, 이후 1시간마다. 타이머는 하나만 둔다.
  function arm(ms) {
    cancel(timerHandle);
    timerHandle = schedule(async () => {
      timerHandle = null;
      try { await refresh({ manual: false }); } catch { /* 다음 주기에 다시 */ }
      if (!disposed) arm(HOUR_MS);
    }, ms);
  }
  if (!smoke) arm(FIRST_AUTO_MS);

  function dispose() {
    disposed = true;
    cancel(timerHandle);
    timerHandle = null;
    for (const h of rolloutTimers.values()) cancel(h);
    rolloutTimers.clear();
    if (abort) abort.abort();
    if (codexAbort) codexAbort.abort();
  }

  return { onHookEvent, onStatus, setFocus, refresh, snapshot, dispose };
}

module.exports = { createUsageService, readRolloutTail };
