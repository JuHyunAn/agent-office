'use strict';

// 사용량 서비스: 모든 AI 의 사용량과 활성 탭의 세션 정보(요청 수·컨텍스트 %)를 모아 스냅샷으로 만든다.
// 출처는 모두 모델 요청이 없는 것뿐이다 — Claude: 상태 표시줄 중계(공짜)·/usage 화면 읽기, Codex: 롤아웃의 token_count·app-server 한도 조회,
// Grok: `grok usage <세션>` (로컬 기록), Muse: `muse usage --json` (구독 한도), Antigravity: 사용량 조회 명령이 없어 협업 대화의 턴 토큰만 쌓는다.
// 스냅샷은 onChange 로 내보내고(펫이 정리해 표시), 화면은 사용량의 출처가 아니다.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const codexCli = require('./codexCli.cjs');
const { readClaudeUsage } = require('./claudeUsage.cjs');
const { AGENT_IDS } = require('../shared/agents.js');
const { t: tr } = require('../shared/i18n.js');

const MANUAL_GAP_MS = 5 * 60 * 1000; // 수동 갱신 최소 간격
const HOUR_MS = 60 * 60 * 1000;
const FIRST_AUTO_MS = 2 * 60 * 1000; // 앱 시작 뒤 첫 자동 갱신
const MAX_SESSIONS = 200;
const MAX_FAILS = 3; // Claude /usage 읽기가 이만큼 연달아 실패하면 자동 갱신을 멈춘다
const ROLLOUT_DEBOUNCE_MS = 1000;
const ROLLOUT_TAIL = 256 * 1024;
const FOCUS_KINDS = [...AGENT_IDS, 'collab'];
const CLI_TIMEOUT_MS = 15000; // runCli 는 중단 신호가 없다 — dispose 뒤에도 이 시간 안에 끝나고, 늦게 온 결과는 버린다
const GROK_SID_RE = /^[0-9a-f-]{36}$/i;
const MUSE_LOGIN_RE = /not logged in|muse login|payment method|subscribe/i;
const MUSE_MAX_ROWS = 6;
// Muse `usage --json` 의 모양은 로그인한 계정에서 확인하지 못했다 — 사용률 키(여러 이름)·사용량/한도 쌍을 방어적으로 찾는다.
const MUSE_PCT_KEYS = ['used_percent', 'usage_percent', 'percent_used', 'percent', 'utilization', 'usedPercent', 'usagePercent'];
const MUSE_NAME_KEYS = ['name', 'label', 'window', 'period', 'type'];
const MUSE_RESET_KEYS = ['resets_at', 'reset_at', 'resetsAt', 'resetAt'];
const MUSE_PAIR_KEYS = [['used', 'limit'], ['usage', 'allowance']];

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
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// 토큰 수 표시: 999 → '999', 1234 → '1.2k', 1234567 → '1.2M' (999950 이상은 '1000.0k' 대신 M).
function fmtTokens(n) {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  if (v < 1000) return String(Math.round(v));
  return v >= 999950 ? `${(v / 1e6).toFixed(1)}M` : `${(v / 1000).toFixed(1)}k`;
}

// `grok usage <세션>` 의 JSON → 행 (세션 토큰·비용, 모델 호출·턴). 형식이 다르면 null.
// 비용: costUsdTicks 의 단위는 xAI API 관례(1 USD = 10^10 ticks)로 본 것이며 공식 문서로 확인하지 못했다.
function parseGrokUsage(json, observedAt) {
  const s = json && typeof json === 'object' ? json.session : null;
  const total = s && typeof s === 'object' ? num(s.totalTokens) : null;
  if (total === null) return null;
  const ticks = num(s.costUsdTicks);
  const usd = ticks === null ? null : ticks / 1e10;
  const cost = usd === null ? '' : ` · $${usd < 0.005 ? '<0.01' : usd.toFixed(2)}`;
  const n = (v) => (num(v) === null ? 0 : Math.trunc(v));
  return [
    { id: 'session', label: tr('run.usage.thisSession'), percent: null, resetsAt: null, resetsText: null, valueText: `${tr('run.usage.tokens', { tokens: fmtTokens(total) })}${cost}`, observedAt },
    { id: 'calls', label: tr('run.usage.modelCalls'), percent: null, resetsAt: null, resetsText: null, valueText: tr('run.usage.callsTurns', { calls: n(s.modelCalls), turns: n(s.turnCount) }), observedAt },
  ];
}

// 초·밀리초 숫자(문자열 숫자 포함)나 ISO 문자열 → 밀리초. 알 수 없으면 null.
function toEpochMs(v) {
  const n = typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
  if (typeof n === 'number') return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : null;
  const t = typeof n === 'string' ? Date.parse(n) : NaN;
  return Number.isFinite(t) ? t : null;
}

// `muse usage --json` 의 JSON → 행 (최대 6). 객체·배열을 깊이 4 까지 훑어 사용률 키가 있는 객체마다 한 줄,
// 하나도 없으면 사용량/한도 쌍(used·limit, usage·allowance)으로 계산한다. 못 찾으면 빈 배열.
function parseMuseUsage(json, observedAt) {
  const collect = (pick) => {
    const out = [];
    const walk = (node, key, depth) => {
      if (!node || typeof node !== 'object' || depth > 4 || out.length >= MUSE_MAX_ROWS) return;
      if (!Array.isArray(node)) {
        const p = pick(node);
        if (p !== null) {
          const name = MUSE_NAME_KEYS.map((k) => node[k]).find((v) => typeof v === 'string' && v.trim());
          const label = (name || (typeof key === 'string' && !/^\d+$/.test(key) ? key : 'Muse')).trim().slice(0, 40);
          const resetsAt = MUSE_RESET_KEYS.map((k) => toEpochMs(node[k])).find((v) => v !== null) ?? null;
          out.push({ id: `muse:${label}`.toLowerCase(), label, percent: pct(p), resetsAt, resetsText: null, observedAt });
          return;
        }
      }
      for (const [k, v] of Object.entries(node)) walk(v, k, depth + 1);
    };
    walk(json, null, 0);
    return out;
  };
  const byPercent = (o) => {
    const v = MUSE_PCT_KEYS.map((k) => num(o[k])).find((x) => x !== null);
    return v === undefined ? null : (v >= 0 && v <= 1 ? v * 100 : v); // 0~1 은 비율로 본다
  };
  const byPair = (o) => {
    for (const [a, b] of MUSE_PAIR_KEYS) {
      const used = num(o[a]);
      const limit = num(o[b]);
      if (used !== null && limit !== null && limit > 0) return (used / limit) * 100;
    }
    return null;
  };
  const rows = collect(byPercent);
  return rows.length ? rows : collect(byPair);
}

// 주입 가능한 부분(읽기 함수·시계·타이머)은 모두 테스트에서 가짜로 바꾼다.
function createUsageService({
  locateClaude, locateCodex, locateGrok, locateMuse, locateAntigravity, runCli, userDataDir, onChange = () => {}, smoke = false, now = Date.now, appVersion = '0.1.0',
  readClaude = readClaudeUsage, readCodex = codexCli.rateLimits, readRollout = readRolloutTail,
  schedule = defaultSchedule, cancel = clearTimeout,
}) {
  const claudeRows = new Map(); // id → { ...Row, source: 'status'|'usage' }
  const codexRows = new Map(); // id → { ...Row, source: 'rollout'|'app-server' }
  const grokRows = new Map(); // id → { ...Row, source: 'grok' } — 가장 최근에 Stop 을 받은 Grok 세션 하나
  const museRows = new Map(); // id → { ...Row, source: 'muse' }
  const agyRows = new Map(); // id → { ...Row, source: 'collab' } — 협업 대화 턴 토큰 누적
  const sessions = new Map(); // sessionId → { cli, tab, requests, contextPercent, transcriptPath, at } — 오래된 것부터 밀려난다
  const tabSession = new Map(); // 탭 → 그 탭의 최신 세션
  const rolloutTimers = new Map(); // sessionId → 디바운스 타이머
  const grokTimers = new Map(); // Grok sessionId → { timer, at } 디바운스 (at = 마지막 Stop 을 받은 시각)
  let focus = null;
  let claudeError = null;
  let codexError = null;
  let grokError = null;
  let museError = null;
  let agyError = null;
  let agyTokens = 0; // Antigravity 협업 턴 토큰 누적 (앱 실행 동안)
  let agyTurns = 0;
  let busy = false;
  let lastRunAt = null;
  let lastManualAt = null;
  let lastClaudeRunAt = null;
  let lastClaudeActivityAt = 0;
  let lastMuseRunAt = 0;
  let lastMuseActivityAt = 0;
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
    if (!focus || !focus.tabId || !AGENT_IDS.includes(focus.kind)) return null; // 협업·활성 탭 없음
    const s = sessions.get(tabSession.get(focus.tabId));
    return s ? { kind: focus.kind, label: focus.label, requests: s.requests, contextPercent: s.contextPercent } : null;
  }

  function snapshot() {
    const t = now();
    return {
      claude: { rows: view(claudeRows), error: claudeError, updatedAt: updatedAt(claudeRows) },
      codex: { rows: view(codexRows), error: codexError, updatedAt: updatedAt(codexRows) },
      grok: { rows: view(grokRows), error: grokError, updatedAt: updatedAt(grokRows) },
      muse: { rows: view(museRows), error: museError, updatedAt: updatedAt(museRows) },
      antigravity: { rows: view(agyRows), error: agyError, updatedAt: updatedAt(agyRows) },
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
    cancel(grokTimers.get(sid)?.timer);
    grokTimers.delete(sid);
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
    if (ev._cli && !AGENT_IDS.includes(ev._cli)) return; // 모르는 AI 의 활동은 Claude 사용량으로 잡지 않는다
    const cli = ev._cli || 'claude';
    const s = touch(sid, cli, ev._tab);
    if (ev.hook_event_name === 'UserPromptSubmit') s.requests++;
    if (cli === 'claude') {
      lastClaudeActivityAt = now();
    } else if (cli === 'muse') {
      lastMuseActivityAt = now();
    } else if (cli === 'grok') {
      // 앱 탭·협업 방의 Grok 세션만 읽는다 (앱 밖 세션의 Stop 은 이 앱의 사용량이 아니다).
      if (ev.hook_event_name === 'Stop' && ev._tab && GROK_SID_RE.test(sid)) {
        cancel(grokTimers.get(sid)?.timer);
        const at = now();
        grokTimers.set(sid, { at, timer: schedule(() => { readGrokNow(sid, at); }, ROLLOUT_DEBOUNCE_MS) });
      }
    } else if (cli === 'codex' && meta && typeof meta.transcriptPath === 'string' && meta.transcriptPath) {
      s.transcriptPath = meta.transcriptPath;
      if (ev.hook_event_name === 'Stop' || ev.hook_event_name === 'UserPromptSubmit') {
        cancel(rolloutTimers.get(sid));
        rolloutTimers.set(sid, schedule(() => { readRolloutNow(sid); }, ROLLOUT_DEBOUNCE_MS));
      }
    }
    emit();
  }

  // 세션 하나의 `grok usage` 를 읽어 행으로 만든다. at = 그 세션의 마지막 Stop 시각 — 늦게 끝난 옛 읽기가 새 값을 덮지 않게 관측 시각으로 쓴다.
  async function readGrokNow(sid, at) {
    grokTimers.delete(sid);
    if (disposed || !locateGrok || !runCli) return;
    let rows = null;
    try {
      const loc = await locateGrok();
      if (disposed) return;
      if (loc) {
        const r = await runCli(loc, ['usage', sid], CLI_TIMEOUT_MS);
        if (disposed) return;
        if (r.code === 0) rows = parseGrokUsage(JSON.parse(r.stdout), at);
      }
    } catch { /* 아래에서 오류로 표시 */ }
    if (disposed) return;
    if (rows) {
      merge(grokRows, rows, 'grok');
      grokError = null;
    } else {
      grokError = tr('run.usage.grokReadFailed'); // 기존 값은 그대로 둔다
    }
    emit();
  }

  // Muse 구독 한도 읽기. 자동은 직전 실행 뒤 Muse 활동이 있었을 때만, 수동은 설치돼 있으면 항상.
  async function readMuseNow(manual) {
    if (!locateMuse || !runCli) return;
    if (!manual && lastMuseActivityAt <= lastMuseRunAt) return;
    const loc = await locateMuse();
    if (disposed || !loc) return; // 설치 안 됨 — 칸을 숨긴다
    lastMuseRunAt = now();
    const r = await runCli(loc, ['usage', '--json'], CLI_TIMEOUT_MS);
    if (disposed) return;
    let json;
    if (r.code === 0) { try { json = JSON.parse(r.stdout); } catch { /* 아래에서 형식 오류 */ } }
    if (json === undefined) {
      if (MUSE_LOGIN_RE.test(`${r.stdout}\n${r.stderr}`)) { museRows.clear(); museError = tr('run.usage.museLogin'); return; }
      museError = r.code === 0 ? tr('run.usage.museFormat') : tr('run.usage.museReadFailed');
      return;
    }
    const rows = parseMuseUsage(json, now());
    if (!rows.length) { museError = tr('run.usage.museFormat'); return; }
    museRows.clear(); // 구독 한도 전체를 다시 읽은 것이라 예전 줄은 남기지 않는다
    merge(museRows, rows, 'muse');
    museError = null;
  }

  // Antigravity 는 사용량 조회 명령이 없다 — 설치돼 있으면 칸이 보이게 안내만 두고, 값은 협업 턴(addTurnUsage)이 채운다.
  async function readAntigravityNow() {
    if (!locateAntigravity) return;
    const loc = await locateAntigravity();
    if (disposed || !loc) return;
    if (!agyTurns) agyError = tr('run.usage.agyNoCommand');
  }

  // 협업 대화 한 턴의 usage ({ total_tokens, ... }) 를 앱 실행 동안 누적한다. 지금은 Antigravity 만 (탭 세션 사용량은 출처가 없다).
  function addTurnUsage(cli, u) {
    if (disposed || cli !== 'antigravity' || !u || typeof u !== 'object') return;
    agyTokens += num(u.total_tokens) ?? ['input_tokens', 'output_tokens', 'thinking_tokens'].reduce((a, k) => a + (num(u[k]) ?? 0), 0);
    agyTurns++;
    merge(agyRows, [{ id: 'collab', label: tr('run.usage.collab'), percent: null, resetsAt: null, resetsText: null, valueText: tr('run.usage.tokensTurns', { tokens: fmtTokens(agyTokens), turns: agyTurns }), observedAt: now() }], 'collab');
    agyError = null;
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
    for (const [key, id, label] of [['five_hour', 'session', tr('run.usage.session')], ['seven_day', 'week', tr('run.usage.week')]]) {
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
    if (!loc) { if (manual) claudeError = tr('run.usage.claudeNotFound'); return; }
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
        readMuseNow(manual).catch((e) => { museError = String(e && e.message || e).slice(0, 100); }),
        readAntigravityNow().catch((e) => { agyError = String(e && e.message || e).slice(0, 100); }),
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
    for (const g of grokTimers.values()) cancel(g.timer);
    grokTimers.clear();
    if (abort) abort.abort();
    if (codexAbort) codexAbort.abort();
  }

  return { onHookEvent, onStatus, setFocus, refresh, snapshot, addTurnUsage, dispose };
}

// 사용량 서비스가 쓰는 CLI 위치 찾기: 기억한 실행 파일이 쓸 수 있으면 그대로, 없거나 지워졌으면 다시 찾는다.
// 못 찾은(설치되지 않은) 결과는 missMs 동안 기억해 갱신 때마다 `where` 를 다시 돌리지 않는다 — 그 사이 탭을 열어 위치가 생기면(get) 그 값을 먼저 쓴다.
function createUsageLocator({ get, set, locate, exists, now = Date.now, missMs = 5 * 60000 }) {
  const missedAt = new Map();
  return async (id) => {
    const l = get(id);
    if (l && (l.cmdShim || exists(l.file))) return l;
    const at = missedAt.get(id);
    if (!l && at !== undefined && now() - at < missMs) return null;
    const found = await locate(id);
    set(id, found);
    if (found) missedAt.delete(id); else missedAt.set(id, now());
    return get(id);
  };
}

module.exports = { createUsageService, createUsageLocator, readRolloutTail, parseGrokUsage, parseMuseUsage, fmtTokens };
