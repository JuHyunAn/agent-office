'use strict';

// Claude 의 /usage 화면을 숨긴 pty 에서 읽는다 (모델 요청 없음 — claude -p 는 /usage 를 모델 질문으로 처리하므로 쓰지 않는다).
// 모델별 주간 사용량(예: Fable)은 이 화면에만 있다. 세션·주간 값은 상태 표시줄 중계로도 오지만 같은 모양으로 맞춰 둔다.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const claudeCli = require('./claudeCli.cjs');
const { cleanEnv } = require('./env.cjs');

// 화면 제어 문자를 글로 펼친다: 오른쪽 이동 \x1b[nC 는 공백 n개(Claude 가 공백 대신 쓴다), 그 밖의 CSI 는 줄바꿈, OSC·문자 집합 지정은 제거.
function flatten(raw) {
  return String(raw)
    .replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(Math.min(n ? Number(n) : 1, 300)))
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][0-9A-B]/g, '')
    .replace(/\x1b\[[0-9;?<=>]*[ -/]*[@-~]/g, '\n')
    .replace(/\r/g, '');
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_MS = 5 * 60 * 60 * 1000; // 세션 사용량 창

// 「6:20pm」「Nov 1, 7am」「Nov 1, 6:59am」 → epoch(ms). 시간대(tz)가 이 컴퓨터와 같을 때만 해석하고, 아니면 null.
function resetToEpoch(text, tz, now = Date.now(), localTz = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  if (!tz || tz !== localTz) return null;
  const m = String(text).trim().match(/^(?:([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!m) return null;
  const hour = Number(m[3]);
  const minute = m[4] ? Number(m[4]) : 0;
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const h24 = (hour % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0);
  const base = new Date(now);
  if (!m[1]) {
    // 시각만 있으면 오늘 그 시각, 이미 지났으면 내일.
    const today = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h24, minute, 0, 0).getTime();
    return today > now ? today : new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, h24, minute, 0, 0).getTime();
  }
  const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  if (month < 0) return null;
  const day = Number(m[2]);
  const at = (year) => new Date(year, month, day, h24, minute, 0, 0);
  let t = at(base.getFullYear());
  if (t.getMonth() !== month) return null; // 없는 날짜 (예: 2월 30일)
  // 올해 그 날짜가 하루 넘게 지났으면 내년 것으로 본다.
  if (t.getTime() < now - DAY_MS) t = at(base.getFullYear() + 1);
  return t.getTime();
}

// 막대(▌ █ 등 U+2580~259F)가 글 사이에 끼므로 공백으로 바꾼 뒤 공백을 하나로 줄인다.
function compact(text) {
  return String(text).replace(/[▀-▟]/g, ' ').replace(/\s+/g, ' ');
}

const TAIL = String.raw`(\d{1,3})%(?:\s*used)?\s+Resets\s+([^()]+?)\s*\(([^)]+)\)`;
const SESSION_RE = new RegExp(String.raw`Current session\s+${TAIL}`, 'g');
const WEEK_RE = new RegExp(String.raw`Current week \(all models\)\s+${TAIL}`, 'g');
const MODEL_RE = new RegExp(String.raw`Current week \((?!all models)([^)]+)\)\s+${TAIL}`, 'g');

// /usage 화면 글 → Row[] (세션, 주간, 모델별 순). 화면이 다시 그려져 같은 항목이 여러 번 나오면 마지막 것을 쓴다.
// localTz: 이 컴퓨터의 시간대 (테스트에서만 바꾼다).
function parseUsage(text, now = Date.now(), localTz = undefined) {
  const t = compact(text);
  const rows = new Map();
  const put = (id, label, pct, resetText, tz) => {
    let resetsAt = resetToEpoch(resetText, tz, now, localTz);
    // 세션은 5시간 창이다 — 해석한 재설정이 5시간 넘게 뒤면 이미 지난 시각을 다음 날로 잘못 읽은 것이므로 버린다 (원문도 보이지 않는다).
    const stale = id === 'session' && resetsAt != null && resetsAt > now + SESSION_MS;
    if (stale) resetsAt = null;
    rows.set(id, {
      id, label, percent: Math.min(100, Number(pct)), resetsAt,
      resetsText: resetsAt == null && !stale ? `${resetText} (${tz})` : null, observedAt: now,
    });
  };
  for (const m of t.matchAll(SESSION_RE)) put('session', '세션', m[1], m[2], m[3]);
  for (const m of t.matchAll(WEEK_RE)) put('week', '주간', m[1], m[2], m[3]);
  for (const m of t.matchAll(MODEL_RE)) put(`model:${m[1].trim()}`, m[1].trim(), m[2], m[3], m[4]);
  const order = (r) => (r.id === 'session' ? 0 : r.id === 'week' ? 1 : 2);
  return [...rows.values()].sort((a, b) => order(a) - order(b));
}

// ~/.claude/projects/<작업 폴더의 영숫자 아닌 글자를 -로 바꾼 이름>
function projectDirName(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// 이 읽기가 만든 세션 기록(.jsonl)과, Claude 가 함께 만드는 빈 폴더(프로젝트 폴더의 memory·프로젝트 폴더, session-env/<id>, tasks/session-<id 앞 8자>)만 지운다.
// 폴더는 비어 있을 때만 지우고(rmdir), 다른 세션·history.jsonl 은 건드리지 않는다.
function deleteSessionFile(cwd, sessionId) {
  let real = cwd;
  try { real = fs.realpathSync.native(cwd); } catch { /* 폴더가 없으면 그대로 */ }
  const home = claudeHome();
  const projectDir = path.join(home, 'projects', projectDirName(real));
  try { fs.unlinkSync(path.join(projectDir, `${sessionId}.jsonl`)); } catch { /* 안 만들어졌으면 지울 것이 없다 */ }
  // 세션 파일을 지운 뒤 프로젝트 폴더 안의 memory → 프로젝트 폴더 순으로, 비어 있을 때만 지운다 (이 읽기 전용 폴더에 쌓이는 빈 폴더 정리).
  for (const dir of [path.join(projectDir, 'memory'), projectDir,
    path.join(home, 'session-env', sessionId), path.join(home, 'tasks', `session-${sessionId.slice(0, 8)}`)]) {
    try { fs.rmdirSync(dir); } catch { /* 없거나 비어 있지 않으면 그대로 */ }
  }
}

function killTree(pid) {
  if (process.platform !== 'win32' || !pid) return;
  try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }); } catch { /* 이미 종료 */ }
}

const TRUST_TEXT = 'Yes,Itrustthisfolder';

// 반환: { rows, at } 또는 { error }. signal 이 중단되면(앱 종료) 바로 프로세스를 정리하고 { error } 로 끝낸다.
// onRaw(chunk): 원시 pty 출력을 그대로 받는다 (고정 자료 캡처·점검용).
function readClaudeUsage({ loc, cwd, timeoutMs = 25000, signal, onRaw }) {
  return new Promise((resolve) => {
    const sessionId = crypto.randomUUID();
    let term;
    try {
      fs.mkdirSync(cwd, { recursive: true });
      const cmd = claudeCli.commandFor(loc, ['--setting-sources', 'local', '--strict-mcp-config', '--session-id', sessionId]);
      term = require('node-pty').spawn(cmd.file, cmd.args, {
        name: 'xterm-256color', cols: 120, rows: 50, cwd, env: { ...cleanEnv(), DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1' }, // 사용자 입력 기록(history.jsonl)에 /usage·/exit 를 남기지 않는다 (실측)
      });
    } catch (e) {
      resolve({ error: `Claude 를 실행하지 못했습니다: ${String(e && e.message || e).slice(0, 80)}` });
      return;
    }

    const startedAt = Date.now();
    let raw = '';
    let lastDataAt = startedAt;
    let trust = 'none'; // none → sent(↓ 보냄, 선택 확인 대기) → done
    let base = 0; // 신뢰 질문을 넘긴 뒤의 화면만 보기 위한 raw 오프셋
    let readyAt = startedAt;
    let phase = 'boot'; // boot → typed(/usage 입력함)
    let timer = null;
    let usageOffset = 0;
    let typedAt = 0;
    let exited = false;
    let finishing = false;
    let onExited = null;

    term.onData((d) => { raw += d; lastDataAt = Date.now(); if (onRaw) onRaw(d); });
    term.onExit(() => { exited = true; if (onExited) onExited(); if (!finishing) finish(snapshot() || { error: 'Claude 가 예기치 않게 끝났습니다' }); });

    // 지금까지 화면에서 읽은 값. 세션·주간을 모두 찾았는지(complete)도 함께 본다.
    function parsed() {
      const rows = parseUsage(flatten(raw.slice(usageOffset)));
      return { rows, complete: rows.some((r) => r.id === 'session') && rows.some((r) => r.id === 'week') };
    }
    function snapshot() {
      if (phase !== 'typed') return null;
      const { rows } = parsed();
      return rows.length ? { rows, at: Date.now() } : null;
    }

    // 정리의 마지막은 항상 pty.kill() — Windows 에서는 이게 읽기 스레드·소켓을 놓아 주어야 node 가 핸들을 쥐고 있지 않는다.
    let released = false;
    function release() {
      if (released) return;
      released = true;
      if (!exited) killTree(term.pid); // 살아 있으면 프로세스 트리째 정리
      try { term.kill(); } catch { /* 이미 종료 */ }
    }

    function closeTerm(hard) {
      return new Promise((done) => {
        const timers = [];
        const end = () => { timers.forEach(clearTimeout); onExited = null; release(); done(); };
        if (exited) { end(); return; }
        onExited = end;
        if (hard) {
          release();
          deleteSessionFile(cwd, sessionId); // 앱 종료 중에는 뒤의 정리가 돌기 전에 프로세스가 끝날 수 있어 바로 지운다
          timers.push(setTimeout(end, 1000));
          return;
        }
        try { term.write('\x1b'); } catch { /* 이미 종료 */ }
        timers.push(setTimeout(() => { try { term.write('/exit\r'); } catch { /* 이미 종료 */ } }, 300));
        timers.push(setTimeout(release, 2300)); // /exit 뒤 2초가 지나도 살아 있으면 강제 종료
        timers.push(setTimeout(end, 4000)); // 종료 알림이 끝내 안 와도 여기서 마친다 (release 는 이미 했다)
      });
    }

    function finish(res, hard = false) {
      if (finishing) return;
      finishing = true;
      clearInterval(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      closeTerm(hard).then(() => { deleteSessionFile(cwd, sessionId); resolve(res); });
    }
    function onAbort() { finish({ error: '중단됨' }, true); }
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    function checkTrustSelected(mark) {
      if (finishing) return;
      const after = flatten(raw.slice(mark)).replace(/\s+/g, '');
      if (!after.includes(`❯${TRUST_TEXT}`)) { finish({ error: '신뢰 질문 처리 실패' }); return; }
      term.write('\r');
      trust = 'done';
      base = raw.length;
      readyAt = Date.now();
      lastDataAt = readyAt;
    }

    timer = setInterval(() => {
      const now = Date.now();
      if (now - startedAt >= timeoutMs) { finish(snapshot() || { error: '시간 초과' }); return; }
      if (phase === 'boot') {
        if (trust === 'sent') return;
        const plain = flatten(raw.slice(base)).replace(/\s+/g, '');
        if (trust === 'none' && plain.includes(TRUST_TEXT)) {
          // 신뢰 질문은 ↓ 로 「Yes」 를 고른 것이 화면에서 확인될 때만 Enter 를 보낸다 (기본 선택은 「No, exit」). 한 번만 처리한다.
          trust = 'sent';
          const mark = raw.length;
          term.write('\x1b[B');
          setTimeout(() => checkTrustSelected(mark), 400);
          return;
        }
        const quiet = now - lastDataAt >= 1000;
        if ((plain.includes('❯') && quiet) || (now - readyAt >= 8000 && plain.length > 0)) {
          phase = 'typed';
          usageOffset = raw.length;
          term.write('/usage');
          setTimeout(() => { if (!finishing) { term.write('\r'); typedAt = Date.now(); } }, 300);
        }
        return;
      }
      if (phase === 'typed' && typedAt) {
        const { rows, complete } = parsed();
        // 모델별 줄은 세션·주간보다 늦게 다시 그려지므로 출력이 잠잠해질 때까지 기다린다 (최대 12초).
        if (complete && now - lastDataAt >= 1200) { finish({ rows, at: now }); return; }
        if (now - typedAt >= 12000) finish(rows.length ? { rows, at: now } : { error: '사용량 화면을 읽지 못했습니다' });
      }
    }, 200);
  });
}

module.exports = { flatten, parseUsage, resetToEpoch, readClaudeUsage, projectDirName, deleteSessionFile };
