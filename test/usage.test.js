import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { flatten, parseUsage, resetToEpoch, projectDirName, deleteSessionFile } = require('../src/main/claudeUsage.cjs');
const { createUsageService, createUsageLocator, readRolloutTail, parseGrokUsage, parseMuseUsage, fmtTokens } = require('../src/main/usage.cjs');
const codexCli = require('../src/main/codexCli.cjs');
const claudeCli = require('../src/main/claudeCli.cjs');
const { startHookServer } = require('../src/main/hookServer.cjs');

const SEOUL = 'Asia/Seoul';
const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime();
const made = []; // tmp() 가 만든 폴더 — 파일 끝에서 모두 지운다
const tmp = (name) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ao-usage-${name}-`)); made.push(dir); return dir; };
after(() => {
  for (const dir of made) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 에서 잠겨 있으면(EBUSY·EPERM) 다음 정리에 맡긴다 */ }
  }
});

// ---------------------------------------------------------------------------------------------
// 화면 읽기 (순수 함수)

test('flatten: 오른쪽 이동은 공백, 그 밖의 제어열은 줄바꿈, OSC·문자 집합 지정·CR 은 제거', () => {
  assert.equal(flatten('a\x1b[3Cb'), 'a   b');
  assert.equal(flatten('a\x1b[Cb'), 'a b', '숫자가 없으면 1칸');
  assert.equal(flatten('a\x1b[2;5Hb\x1b[31mc\x1b[?25l'), 'a\nb\nc\n');
  assert.equal(flatten('x\x1b]0;제목\x07y\x1b]8;;http://a\x1b\\z'), 'xyz');
  assert.equal(flatten('x\x1b(By\x1b)0z\r\n'), 'xyz\n');
  assert.equal(flatten('\x1b[>4m\x1b[>0qA'), '\n\nA', '> 로 시작하는 확장 제어열도 글에 남지 않는다');
});

test('parseUsage: 실제 /usage 화면(고정 자료)에서 세션·주간·모델별 값을 읽는다', () => {
  const raw = fs.readFileSync(new URL('./fixtures/usage-screen.txt', import.meta.url), 'utf8');
  const now = local(2026, 10, 29, 14, 0); // 세션 재설정(6:20pm)이 5시간 안에 오는 시각
  const rows = parseUsage(flatten(raw), now, SEOUL);
  assert.deepEqual(rows.map((r) => [r.id, r.label, r.percent]), [['session', '세션', 21], ['week', '주간', 61], ['model:Fable', 'Fable', 42]]);
  assert.equal(rows[0].resetsAt, local(2026, 10, 29, 18, 20), '「6:20pm」 은 오늘');
  assert.equal(rows[1].resetsAt, local(2026, 11, 1, 7, 0), '「Nov 1, 7am」');
  assert.ok(rows.every((r) => r.resetsText === null && r.observedAt === now));
  assert.ok(!/dkswn/i.test(raw), '고정 자료에 사용자 이름이 남아 있지 않다');
});

test('parseUsage: 화면이 다시 그려져 같은 항목이 여러 번 나오면 마지막 것을 쓰고, 막대 글자는 무시한다', () => {
  const text = [
    'Current session', '█▌', '1% used', 'Resets 6:20pm (Asia/Seoul)',
    'Current week (all models)', '██████▉', '58%', 'used', 'Resets Nov 1, 7am (Asia/Seoul)',
    'Refreshing…',
    'Current session', '▌', '5% used', 'Resets 6:20pm (Asia/Seoul)',
    'Current week (Fable)', '████', '40% used', 'Resets Nov 1, 6:59am (Asia/Seoul)',
  ].join('\n');
  const rows = parseUsage(text, local(2026, 10, 29, 13, 0), SEOUL);
  assert.deepEqual(rows.map((r) => [r.id, r.percent]), [['session', 5], ['week', 58], ['model:Fable', 40]]);
  assert.equal(rows[2].resetsAt, local(2026, 11, 1, 6, 59));
  assert.deepEqual(parseUsage('아무 글', 0), []);
});

test('parseUsage: 시간대가 이 컴퓨터와 다르면 재설정 시각을 만들지 않고 원문(시간대 포함)을 남긴다', () => {
  const rows = parseUsage('Current session 3% used Resets 6:20pm (America/New_York)', local(2026, 10, 29, 13, 0), SEOUL);
  assert.equal(rows[0].resetsAt, null);
  assert.equal(rows[0].resetsText, '6:20pm (America/New_York)');
});

test('parseUsage: 세션의 재설정이 지금보다 5시간 넘게 뒤면 이미 지난 시각으로 보고 비운다 (주간·모델별은 그대로)', () => {
  const text = 'Current session 21% used Resets 6:20pm (Asia/Seoul) Current week (all models) 61% used Resets 11:00pm (Asia/Seoul)';
  const early = parseUsage(text, local(2026, 10, 29, 13, 0), SEOUL); // 6:20pm 은 5시간 20분 뒤
  assert.deepEqual([early[0].id, early[0].percent, early[0].resetsAt, early[0].resetsText], ['session', 21, null, null]);
  assert.equal(early[1].resetsAt, local(2026, 10, 29, 23, 0), '주간은 5시간 제한을 받지 않는다');
  const edge = parseUsage('Current session 3% used Resets 6:00pm (Asia/Seoul)', local(2026, 10, 29, 13, 0), SEOUL); // 정확히 5시간 뒤는 유효
  assert.equal(edge[0].resetsAt, local(2026, 10, 29, 18, 0));
  const passed = parseUsage('Current session 3% used Resets 12:30pm (Asia/Seoul)', local(2026, 10, 29, 13, 0), SEOUL); // 지났으면 내일로 읽혀 5시간을 넘는다
  assert.equal(passed[0].resetsAt, null);
  const other = parseUsage('Current session 3% used Resets 6:20pm (America/New_York)', local(2026, 10, 29, 13, 0), SEOUL);
  assert.equal(other[0].resetsText, '6:20pm (America/New_York)', '다른 시간대의 원문 표시는 그대로');
});

test('resetToEpoch: 오늘·내일·올해·내년·다른 시간대', () => {
  const at = (text, now) => resetToEpoch(text, SEOUL, now, SEOUL);
  assert.equal(at('6:20pm', local(2026, 10, 29, 13, 0)), local(2026, 10, 29, 18, 20), '아직 안 지났으면 오늘');
  assert.equal(at('6:20pm', local(2026, 10, 29, 19, 0)), local(2026, 10, 30, 18, 20), '지났으면 내일');
  assert.equal(at('12am', local(2026, 10, 29, 13, 0)), local(2026, 10, 30, 0, 0));
  assert.equal(at('12:30pm', local(2026, 10, 29, 6, 0)), local(2026, 10, 29, 12, 30));
  assert.equal(at('Nov 1, 7am', local(2026, 10, 29, 13, 0)), local(2026, 11, 1, 7, 0), '올해');
  assert.equal(at('Nov 1, 6:59am', local(2026, 10, 29, 13, 0)), local(2026, 11, 1, 6, 59));
  assert.equal(at('Nov 1, 7am', local(2026, 11, 1, 20, 0)), local(2026, 11, 1, 7, 0), '하루 안으로 지난 것은 올해 그대로');
  assert.equal(at('Nov 1, 7am', local(2026, 11, 5, 9, 0)), local(2027, 11, 1, 7, 0), '하루 넘게 지났으면 내년');
  assert.equal(resetToEpoch('6:20pm', 'America/New_York', local(2026, 10, 29, 13, 0), SEOUL), null, '다른 시간대');
  assert.equal(resetToEpoch('6:20pm', undefined, 0, SEOUL), null);
  for (const bad of ['', '25pm', 'soon', 'Foo 1, 7am', 'Feb 30, 7am', '7:75am']) assert.equal(at(bad, 0), null, bad);
});

// ---------------------------------------------------------------------------------------------
// Codex 한도·롤아웃

test('Codex 창 라벨: 300분 → 세션, 10080분 → 주간, 그 밖은 시간 단위', () => {
  assert.equal(codexCli.windowLabel(300), '세션');
  assert.equal(codexCli.windowLabel(10080), '주간');
  assert.equal(codexCli.windowLabel(180), '3시간');
  assert.equal(codexCli.windowLabel(90), '2시간');
  const rows = codexCli.limitRows({ primary: { usedPercent: 3.4, windowDurationMins: 300, resetsAt: 1793796265 }, secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 1793800000 } }, 5);
  assert.deepEqual(rows.map((r) => [r.id, r.label, r.percent, r.resetsAt, r.observedAt]), [['session', '세션', 3, 1793796265000, 5], ['week', '주간', 50, 1793800000000, 5]]);
  assert.deepEqual(codexCli.limitRows({ primary: null, secondary: null }, 1), []);
  assert.equal(codexCli.limitRows({ primary: { usedPercent: 10, windowDurationMins: 180, resetsAt: 1 } }, 1)[0].id, 'model:3시간', '세션·주간이 아닌 창도 계약의 id 모양');
});

const tokenLine = (ts, { used, size, limits }) => JSON.stringify({
  timestamp: ts, type: 'event_msg',
  payload: { type: 'token_count', info: used == null ? null : { last_token_usage: { total_tokens: used }, model_context_window: size }, rate_limits: limits },
});

test('parseRollout: 마지막 token_count 의 한도와 컨텍스트 사용률 (한도 없는 최근 줄은 건너뛴다)', () => {
  const limits = (p) => ({ primary: { used_percent: p, window_minutes: 10080, resets_at: 1793796265 }, secondary: null });
  const lines = [
    '{깨진 줄',
    tokenLine('2026-10-29T03:00:00.000Z', { used: 1000, size: 475000, limits: limits(2.0) }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } }),
    tokenLine('2026-10-29T03:27:32.550Z', { used: 29478, size: 475000, limits: limits(3.0) }),
    tokenLine('2026-10-29T03:30:00.000Z', { used: 95000, size: 475000, limits: null }),
  ];
  const r = codexCli.parseRollout(lines, 1);
  assert.equal(r.contextPercent, 20);
  assert.deepEqual(r.rows.map((x) => [x.id, x.label, x.percent, x.resetsAt, x.observedAt]), [['week', '주간', 3, 1793796265000, Date.parse('2026-10-29T03:27:32.550Z')]]);
  assert.equal(codexCli.parseRollout(['x', '{}'], 1), null);
  assert.equal(codexCli.parseRollout([tokenLine('2026-10-29T03:00:00.000Z', { used: 10, size: 0, limits: null })], 1), null, '모델 컨텍스트 크기 없음 → 정보 없음');
  assert.equal(codexCli.parseRollout([tokenLine('2026-10-29T03:00:00.000Z', { used: 999999, size: 1000, limits: null })], 1).contextPercent, 100, '100 을 넘지 않는다');
});

test('readRolloutTail: ~/.codex/sessions 아래 .jsonl 만, 끝 256KB 만 읽고 잘린 첫 줄은 버린다', async () => {
  const home = tmp('codex');
  const sessions = path.join(home, 'sessions', '2026');
  fs.mkdirSync(sessions, { recursive: true });
  const rollout = path.join(sessions, 'rollout-a.jsonl');
  const filler = JSON.stringify({ type: 'x', pad: 'p'.repeat(1000) });
  fs.writeFileSync(rollout, `${Array(400).fill(filler).join('\n')}\n${tokenLine('2026-10-29T03:00:00.000Z', { used: 1, size: 10, limits: null })}\n`);
  const outside = path.join(home, 'outside.jsonl');
  fs.writeFileSync(outside, '{}\n');
  fs.writeFileSync(path.join(sessions, 'note.txt'), 'x');
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const lines = await readRolloutTail(rollout);
    assert.ok(lines.length < 400 && lines.length > 100, `끝부분만 읽음 (${lines.length})`);
    assert.ok(lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }), '잘린 첫 줄이 남아 있지 않다');
    assert.equal(codexCli.parseRollout(lines).contextPercent, 10);
    assert.equal(await readRolloutTail(outside), null, 'sessions 밖');
    assert.equal(await readRolloutTail(path.join(sessions, 'note.txt')), null, '.jsonl 이 아님');
    await assert.rejects(readRolloutTail(path.join(sessions, 'missing.jsonl')));
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
});

// ---------------------------------------------------------------------------------------------
// /usage 읽기가 남기는 세션 파일 정리

test('세션 파일 정리: 이 읽기의 .jsonl 하나만 지운다', () => {
  assert.equal(projectDirName('C:\\Users\\dkswn\\AppData\\Local\\Temp\\ao-sl-ZG0Lsh'), 'C--Users-dkswn-AppData-Local-Temp-ao-sl-ZG0Lsh');
  const home = tmp('claude');
  const cwd = tmp('probe');
  const dir = path.join(home, 'projects', projectDirName(fs.realpathSync.native(cwd)));
  fs.mkdirSync(dir, { recursive: true });
  const mine = path.join(dir, 'aaaaaaaa-1.jsonl');
  const other = path.join(dir, 'bbbbbbbb-2.jsonl');
  const history = path.join(home, 'history.jsonl');
  for (const f of [mine, other, history]) fs.writeFileSync(f, '{}\n');
  const env = path.join(home, 'session-env', 'aaaaaaaa-1');
  const tasks = path.join(home, 'tasks', 'session-aaaaaaaa');
  const busyEnv = path.join(home, 'session-env', 'cccccccc-3');
  for (const d of [env, tasks, busyEnv]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(busyEnv, 'keep.txt'), 'x');
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    deleteSessionFile(cwd, 'aaaaaaaa-1');
    deleteSessionFile(cwd, 'cccccccc-3'); // 비어 있지 않은 폴더·없는 세션 기록은 그대로 두고 오류도 없다
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
  assert.ok(!fs.existsSync(mine) && !fs.existsSync(env) && !fs.existsSync(tasks));
  assert.ok(fs.existsSync(other) && fs.existsSync(history) && fs.existsSync(path.join(busyEnv, 'keep.txt')));
});

test('세션 파일 정리: 프로젝트 폴더의 memory → 프로젝트 폴더 순으로, 비어 있을 때만 지운다', () => {
  const home = tmp('claude');
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    const project = (cwd) => path.join(home, 'projects', projectDirName(fs.realpathSync.native(cwd)));
    // 세션 기록과 빈 memory 뿐이면 둘 다 사라진다
    const cwdA = tmp('probe-a');
    fs.mkdirSync(path.join(project(cwdA), 'memory'), { recursive: true });
    fs.writeFileSync(path.join(project(cwdA), 'aaaaaaaa-1.jsonl'), '{}\n');
    deleteSessionFile(cwdA, 'aaaaaaaa-1');
    assert.ok(!fs.existsSync(project(cwdA)));
    // memory 에 파일이 있으면 memory 도 프로젝트 폴더도 남는다
    const cwdB = tmp('probe-b');
    fs.mkdirSync(path.join(project(cwdB), 'memory'), { recursive: true });
    fs.writeFileSync(path.join(project(cwdB), 'memory', 'MEMORY.md'), 'x');
    fs.writeFileSync(path.join(project(cwdB), 'bbbbbbbb-2.jsonl'), '{}\n');
    deleteSessionFile(cwdB, 'bbbbbbbb-2');
    assert.ok(fs.existsSync(path.join(project(cwdB), 'memory', 'MEMORY.md')));
    // 다른 세션 기록이 있으면 프로젝트 폴더는 남고 빈 memory 만 사라진다
    const cwdC = tmp('probe-c');
    fs.mkdirSync(path.join(project(cwdC), 'memory'), { recursive: true });
    fs.writeFileSync(path.join(project(cwdC), 'cccccccc-3.jsonl'), '{}\n');
    fs.writeFileSync(path.join(project(cwdC), 'dddddddd-4.jsonl'), '{}\n');
    deleteSessionFile(cwdC, 'cccccccc-3');
    assert.ok(fs.existsSync(path.join(project(cwdC), 'dddddddd-4.jsonl')) && !fs.existsSync(path.join(project(cwdC), 'memory')));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

// ---------------------------------------------------------------------------------------------
// /usage 읽기 전체 흐름 (가짜 claude 를 실제 pty 로 띄운다 — 모델 요청 없음)

// mode: 'trust'(신뢰 질문 먼저) | 'plain' | 'stubborn'(/exit 를 무시해 강제 종료가 필요). 종료하면 자기 pid 를 pidFile 에 남긴다.
function fakeClaude(mode) {
  const dir = tmp('fakeclaude');
  const pidFile = path.join(dir, 'pid.txt');
  const file = path.join(dir, 'claude.cjs');
  fs.writeFileSync(file, `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    const out = (s) => process.stdout.write(s);
    const mode = ${JSON.stringify(mode)};
    let buf = '';
    let selected = mode !== 'trust'; // trust 모드에서는 ↓ 를 받기 전까지 「No, exit」 이 선택돼 있다
    let trusted = mode !== 'trust';
    let usageShown = false;
    const prompt = () => out('\\x1b[2J\\x1b[H\\x1b[1mClaude Code\\x1b[m\\r\\n\\x1b[1C\\u276f\\x1b[1CTry "refactor"\\r\\n');
    if (mode === 'trust') out('\\x1b[2J\\x1b[3;2HQuick\\x1b[1Csafety\\x1b[1Ccheck\\r\\n\\u276f\\x1b[1CNo,\\x1b[1Cexit\\r\\n  Yes,\\x1b[1CI\\x1b[1Ctrust\\x1b[1Cthis\\x1b[1Cfolder\\r\\n');
    else prompt();
    process.stdin.setRawMode(true);
    process.stdin.on('data', (d) => {
      const s = String(d);
      if (!trusted) {
        if (s === '\\x1b[B') { selected = true; out('\\r\\n  No,\\x1b[1Cexit\\r\\n\\u276f\\x1b[1CYes,\\x1b[1CI\\x1b[1Ctrust\\x1b[1Cthis\\x1b[1Cfolder\\r\\n'); }
        else if (s === '\\r') { if (!selected) process.exit(1); trusted = true; setTimeout(prompt, 100); }
        return;
      }
      buf += s;
      if (!usageShown && buf.includes('/usage') && buf.includes('\\r')) {
        usageShown = true;
        setTimeout(() => out('\\x1b[2J\\x1b[HCurrent session\\r\\n\\u2588\\u2588\\u258c\\x1b[20C21%\\x1b[1Cused\\r\\nResets\\x1b[1C6:20pm\\x1b[1C(Asia/Seoul)\\r\\nCurrent\\x1b[1Cweek\\x1b[1C(all\\x1b[1Cmodels)\\r\\n\\u2588\\u2588\\u2588\\u2588\\x1b[20C61%\\x1b[1Cused\\r\\nResets\\x1b[1CNov\\x1b[1C1,\\x1b[1C7am\\x1b[1C(Asia/Seoul)\\r\\nRefreshing\\u2026\\r\\n'), 200);
        setTimeout(() => out('Current\\x1b[1Cweek\\x1b[1C(Fable)\\r\\n\\u2588\\x1b[20C42%\\x1b[1Cused\\r\\nResets\\x1b[1CNov\\x1b[1C1,\\x1b[1C7am\\x1b[1C(Asia/Seoul)\\r\\n'), 700);
      }
      if (buf.includes('/exit\\r') && mode !== 'stubborn') process.exit(0);
    });
    setInterval(() => {}, 1000);
  `);
  return { loc: { file: process.execPath, prefixArgs: [file] }, pidFile };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function readFake(mode, extra = {}) {
  const { readClaudeUsage } = require('../src/main/claudeUsage.cjs');
  const { loc, pidFile } = fakeClaude(mode);
  const cwd = tmp('probe-cwd');
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmp('claude-home');
  try {
    const started = Date.now();
    const promise = readClaudeUsage({ loc, cwd, ...extra });
    return { promise, started, pidFile };
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
}

test('readClaudeUsage: 신뢰 질문(↓ 로 Yes 확인 뒤 Enter) → /usage → 세션·주간·모델별 값을 읽고 프로세스를 남기지 않는다', async () => {
  const { promise, pidFile } = await readFake('trust');
  const r = await promise;
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(r.rows.map((x) => [x.id, x.percent]), [['session', 21], ['week', 61], ['model:Fable', 42]], '늦게 그려진 모델별 줄까지 기다려서 읽는다');
  await new Promise((res) => setTimeout(res, 300));
  assert.ok(!alive(Number(fs.readFileSync(pidFile, 'utf8'))), '가짜 claude 가 남아 있지 않다');
});

test('readClaudeUsage: 신뢰 질문이 없으면 곧바로 /usage, /exit 를 무시하는 프로세스는 강제 종료한다', async () => {
  const { promise, pidFile } = await readFake('stubborn');
  const t0 = Date.now();
  const r = await promise;
  assert.deepEqual(r.rows.map((x) => x.id), ['session', 'week', 'model:Fable']);
  assert.ok(Date.now() - t0 < 12000, `${Date.now() - t0}ms`);
  await new Promise((res) => setTimeout(res, 300));
  assert.ok(!alive(Number(fs.readFileSync(pidFile, 'utf8'))), '/exit 를 무시해도 정리된다');
});

test('readClaudeUsage: 중단 신호를 받으면 바로 프로세스를 정리하고 { error } 로 끝낸다', async () => {
  const ac = new AbortController();
  const { promise, pidFile } = await readFake('plain', { signal: ac.signal });
  await new Promise((res) => setTimeout(res, 1500));
  ac.abort();
  const r = await promise;
  assert.deepEqual(r, { error: '중단됨' });
  await new Promise((res) => setTimeout(res, 300));
  assert.ok(!alive(Number(fs.readFileSync(pidFile, 'utf8'))));
  assert.deepEqual(await (await readFake('plain', { signal: AbortSignal.abort() })).promise, { error: '중단됨' }, '이미 중단된 신호');
});

test('readClaudeUsage: 화면을 못 읽으면 시간 상한에서 { error }, 실행 파일이 없으면 바로 { error }', async () => {
  const { readClaudeUsage } = require('../src/main/claudeUsage.cjs');
  const none = await readClaudeUsage({ loc: { file: path.join(os.tmpdir(), 'no-such-claude.exe'), prefixArgs: [] }, cwd: tmp('probe-cwd'), timeoutMs: 3000 });
  assert.ok(none.error, '실행 실패는 오류');
  const dir = tmp('fakeclaude');
  const file = path.join(dir, 'silent.cjs');
  fs.writeFileSync(file, 'setInterval(() => {}, 1000);');
  const t0 = Date.now();
  const silent = await readClaudeUsage({ loc: { file: process.execPath, prefixArgs: [file] }, cwd: tmp('probe-cwd'), timeoutMs: 1500 });
  assert.deepEqual(silent, { error: '시간 초과' });
  assert.ok(Date.now() - t0 < 8000);
});

// ---------------------------------------------------------------------------------------------
// 사용량 서비스 (가짜 시계·읽기 함수·타이머)

function makeService(over = {}) {
  const clock = { t: local(2026, 10, 29, 13, 0) };
  const timers = [];
  const calls = { claude: [], codex: [], rollout: [] };
  const changes = [];
  const opts = {
    locateClaude: () => ({ file: 'claude' }),
    locateCodex: () => ({ file: 'codex' }),
    userDataDir: path.join(os.tmpdir(), 'ao-usage-svc'),
    now: () => clock.t,
    onChange: (s) => changes.push(s),
    // 실행된 타이머는 더 이상 대기 중이 아니므로 취소된 것과 같이 센다 (live() 는 대기 중인 것만).
    schedule: (fn, ms) => { const h = { ms, cancelled: false }; h.fn = (...a) => { h.cancelled = true; return fn(...a); }; timers.push(h); return h; },
    cancel: (h) => { if (h) h.cancelled = true; },
    readClaude: async (a) => { calls.claude.push(a); return { rows: [{ id: 'session', label: '세션', percent: 7, resetsAt: clock.t + 3600000, resetsText: null, observedAt: clock.t }], at: clock.t }; },
    readCodex: async (loc, o) => { calls.codex.push(o); return { rows: [{ id: 'week', label: '주간', percent: 4, resetsAt: clock.t + 86400000, resetsText: null, observedAt: clock.t }], at: clock.t }; },
    readRollout: async (file) => { calls.rollout.push(file); return over.rolloutLines || []; },
    ...over,
  };
  const svc = createUsageService(opts);
  const live = () => timers.filter((x) => !x.cancelled);
  return { svc, clock, timers, live, calls, changes };
}

const status = (over = {}) => ({
  session_id: 's1', context_window: { used_percentage: 34.4 },
  rate_limits: { five_hour: { used_percentage: 12, resets_at: Math.floor((local(2026, 10, 29, 18, 20)) / 1000) }, seven_day: { used_percentage: 58.4, resets_at: Math.floor(local(2026, 11, 1, 7, 0) / 1000) } },
  ...over,
});

test('상태 표시줄 입력: 세션·주간 한도와 컨텍스트 %, 같은 내용이면 다시 알리지 않는다', () => {
  const { svc, changes } = makeService();
  svc.onStatus(status(), 'tab1');
  const s = svc.snapshot();
  assert.deepEqual(s.claude.rows.map((r) => [r.id, r.label, r.percent, r.resetsAt, r.resetsText]), [
    ['session', '세션', 12, local(2026, 10, 29, 18, 20), null], ['week', '주간', 58, local(2026, 11, 1, 7, 0), null]]);
  assert.ok(!('source' in s.claude.rows[0]), '내부 출처 표시는 스냅샷에 넣지 않는다');
  assert.equal(s.claude.updatedAt, local(2026, 10, 29, 13, 0));
  assert.equal(changes.length, 1);
  svc.onStatus(status(), 'tab1');
  assert.equal(changes.length, 1, '같은 내용은 생략');
  svc.onStatus({ session_id: 's1', rate_limits: null, context_window: { used_percentage: null } }, 'tab1'); // 값이 없는 입력은 이전 값을 지우지 않는다
  assert.equal(svc.snapshot().claude.rows.length, 2);
});

test('병합: 같은 항목은 관측 시각이 더 최근인 값, 리셋 시각이 지나면 percent 를 비운다', async () => {
  const { svc, clock } = makeService();
  svc.onStatus(status(), null); // 12%, 관측 13:00
  clock.t += 1000;
  await svc.refresh({ manual: true }); // /usage 7%, 관측 13:00:01 — 더 최근이라 이긴다
  assert.equal(svc.snapshot().claude.rows.find((r) => r.id === 'session').percent, 7);
  clock.t += 6 * 60 * 1000;
  svc.onStatus(status({ rate_limits: { five_hour: { used_percentage: 20, resets_at: Math.floor((clock.t + 3600000) / 1000) } } }), null);
  assert.equal(svc.snapshot().claude.rows.find((r) => r.id === 'session').percent, 20, '더 최근의 상태 표시줄 값');
  const old = makeService({ readClaude: async () => ({ rows: [{ id: 'session', label: '세션', percent: 99, resetsAt: null, resetsText: null, observedAt: 1 }], at: 1 }) });
  old.svc.onStatus(status(), null);
  await old.svc.refresh({ manual: true });
  assert.equal(old.svc.snapshot().claude.rows.find((r) => r.id === 'session').percent, 12, '오래된 관측은 덮어쓰지 못한다');
  // 리셋이 지나면 percent 를 비운다 (표시 때만 — 원본은 유지).
  clock.t = local(2026, 10, 29, 19, 0);
  const rows = svc.snapshot().claude.rows;
  assert.equal(rows.find((r) => r.id === 'session').percent, null);
  assert.equal(rows.find((r) => r.id === 'week').percent, 58);
});

test('세션 줄: 활성 탭의 요청 수·컨텍스트 %, 협업·탭 없음·세션 종료는 null', () => {
  const { svc } = makeService();
  const ev = (name, extra = {}) => ({ session_id: 's1', hook_event_name: name, _cli: 'claude', _tab: 'tab1', ...extra });
  svc.setFocus({ tabId: 'tab1', kind: 'claude', label: '작업 A' });
  assert.equal(svc.snapshot().session, null, '세션이 아직 없음');
  svc.onHookEvent(ev('SessionStart'));
  svc.onHookEvent(ev('UserPromptSubmit'));
  svc.onHookEvent(ev('PreToolUse'));
  svc.onHookEvent(ev('UserPromptSubmit'));
  svc.onStatus(status(), 'tab1');
  assert.deepEqual(svc.snapshot().session, { kind: 'claude', label: '작업 A', requests: 2, contextPercent: 34 });
  svc.setFocus({ tabId: 'tab1', kind: 'collab', label: '협업' });
  assert.equal(svc.snapshot().session, null, '협업 탭');
  svc.setFocus({ tabId: null, kind: null, label: '' });
  assert.equal(svc.snapshot().session, null, '활성 탭 없음');
  svc.setFocus({ tabId: 'tab2', kind: 'claude', label: '다른 탭' });
  assert.equal(svc.snapshot().session, null, '세션이 없는 탭');
  svc.setFocus({ tabId: 'tab1', kind: 'claude', label: '작업 A' });
  svc.onHookEvent(ev('SessionEnd'));
  assert.equal(svc.snapshot().session, null, '세션 종료');
  svc.onHookEvent({ hook_event_name: 'UserPromptSubmit' }); // session_id 없음 — 무시
  svc.setFocus('이상한 값');
  assert.equal(svc.snapshot().session, null);
});

test('세션 기록은 200개까지, 오래된 것부터 밀려난다', () => {
  const { svc } = makeService();
  svc.setFocus({ tabId: 'tab0', kind: 'claude', label: 'L' });
  for (let i = 0; i < 205; i++) svc.onHookEvent({ session_id: `s${i}`, hook_event_name: 'UserPromptSubmit', _cli: 'claude', _tab: `tab${i}` });
  assert.equal(svc.snapshot().session, null, '가장 오래된 세션은 밀려났다');
  svc.setFocus({ tabId: 'tab204', kind: 'claude', label: 'L' });
  assert.equal(svc.snapshot().session.requests, 1);
});

test('수동 갱신: 5분 안에 다시 누르면 거절하고 스냅샷만 다시 알린다', async () => {
  const { svc, clock, calls, changes } = makeService();
  await svc.refresh({ manual: true });
  assert.equal(calls.claude.length, 1);
  assert.equal(calls.claude[0].cwd, path.join(os.tmpdir(), 'ao-usage-svc', 'usage-probe'));
  assert.ok(calls.claude[0].signal instanceof AbortSignal);
  let s = svc.snapshot();
  assert.equal(s.refresh.busy, false);
  assert.equal(s.refresh.lastRunAt, clock.t);
  assert.equal(s.refresh.nextAllowedAt, clock.t + 5 * 60 * 1000);
  const n = changes.length;
  clock.t += 60 * 1000;
  await svc.refresh({ manual: true });
  assert.equal(calls.claude.length, 1, '거절');
  assert.equal(changes.length, n + 1, '거절해도 화면이 다시 확인하도록 스냅샷을 알린다');
  clock.t += 5 * 60 * 1000;
  await svc.refresh({ manual: true });
  assert.equal(calls.claude.length, 2);
  assert.equal(calls.codex.length, 2);
});

test('갱신 중에는 busy, 진행 중 호출은 무시한다', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { svc, calls } = makeService({ readClaude: async (a) => { calls.claude.push(a); await gate; return { rows: [], at: 0 }; } });
  const first = svc.refresh({ manual: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(svc.snapshot().refresh.busy, true);
  await svc.refresh({ manual: true });
  await svc.refresh({ manual: false });
  assert.equal(calls.claude.length, 1);
  release();
  await first;
  assert.equal(svc.snapshot().refresh.busy, false);
});

test('Claude /usage 읽기가 연달아 3번 실패하면 자동 갱신을 멈추고, 수동 성공이 다시 켠다', async () => {
  let fail = true;
  const { svc, clock, live, calls } = makeService({
    readClaude: async (a) => { calls.claude.push(a); return fail ? { error: '화면을 읽지 못했습니다' } : { rows: [{ id: 'week', label: '주간', percent: 1, resetsAt: null, resetsText: null, observedAt: clock.t }], at: clock.t }; },
  });
  const firstTimer = live()[0];
  assert.equal(firstTimer.ms, 2 * 60 * 1000, '앱 시작 2분 뒤 첫 자동 갱신');
  for (let i = 0; i < 3; i++) { await svc.refresh({ manual: true }); clock.t += 6 * 60 * 1000; }
  assert.equal(calls.claude.length, 3);
  assert.equal(svc.snapshot().claude.error, '화면을 읽지 못했습니다');
  svc.onStatus(status(), null); // Claude 활동이 있어도
  await firstTimer.fn();
  assert.equal(calls.claude.length, 3, '자동 갱신 중지');
  fail = false;
  await svc.refresh({ manual: true });
  assert.equal(calls.claude.length, 4);
  assert.equal(svc.snapshot().claude.error, null);
  clock.t += 3600000;
  svc.onStatus(status({ context_window: { used_percentage: 60 } }), null); // 값이 달라져야 활동으로 친다
  await live().at(-1).fn();
  assert.equal(calls.claude.length, 5, '수동 성공 뒤 자동 갱신 재개');
});

test('실패해도 이전 값은 유지하고 error 만 채운다', async () => {
  let fail = false;
  const { svc, clock } = makeService({ readClaude: async () => (fail ? { error: '시간 초과' } : { rows: [{ id: 'week', label: '주간', percent: 9, resetsAt: null, resetsText: null, observedAt: clock.t }], at: clock.t }) });
  await svc.refresh({ manual: true });
  fail = true;
  clock.t += 6 * 60 * 1000;
  await svc.refresh({ manual: true });
  const s = svc.snapshot();
  assert.equal(s.claude.error, '시간 초과');
  assert.equal(s.claude.rows[0].percent, 9);
});

test('자동 갱신: 1시간마다, 첫 실행 뒤에는 Claude 활동이 있었을 때만 /usage 를 읽는다', async () => {
  const { svc, clock, live, calls } = makeService();
  assert.equal(live().length, 1, '타이머는 하나');
  const t1 = live()[0];
  await t1.fn();
  assert.equal(calls.claude.length, 1, '첫 실행은 활동과 무관');
  assert.equal(calls.codex.length, 1, '롤아웃 값이 없으면 Codex 한도도 조회');
  assert.equal(live().length, 1);
  assert.equal(live()[0].ms, 60 * 60 * 1000);
  clock.t += 3600000;
  await live()[0].fn();
  assert.equal(calls.claude.length, 1, '활동 없으면 건너뜀');
  svc.onHookEvent({ session_id: 's1', hook_event_name: 'UserPromptSubmit', _cli: 'claude', _tab: 'tab1' });
  clock.t += 3600000;
  await live()[0].fn();
  assert.equal(calls.claude.length, 2, 'Claude 활동 뒤에는 실행');
  clock.t += 3600000;
  svc.onHookEvent({ session_id: 'c1', hook_event_name: 'UserPromptSubmit', _cli: 'codex', _tab: 'tab2' });
  await live()[0].fn();
  assert.equal(calls.claude.length, 2, 'Codex 활동은 Claude 읽기를 부르지 않는다');
  assert.equal(live().length, 1);
  assert.equal(calls.claude[0].loc.file, 'claude');
});

test('smoke 에서는 자동·수동 갱신 모두 하지 않는다', async () => {
  const { svc, timers, calls } = makeService({ smoke: true });
  assert.equal(timers.length, 0);
  await svc.refresh({ manual: true });
  await svc.refresh({ manual: false });
  assert.equal(calls.claude.length + calls.codex.length, 0);
});

test('Codex: Stop 때 롤아웃 끝을 1초 디바운스로 읽어 한도·컨텍스트를 갱신하고, 최근 롤아웃 값이 있으면 app-server 를 부르지 않는다', async () => {
  const lines = [tokenLine(new Date(local(2026, 10, 29, 12, 59)).toISOString(), { used: 47500, size: 475000, limits: { primary: { used_percent: 3, window_minutes: 10080, resets_at: Math.floor(local(2026, 11, 1, 7, 0) / 1000) }, secondary: null } })];
  const { svc, clock, live, calls } = makeService({ rolloutLines: lines });
  const ev = (name) => ({ session_id: 'c1', hook_event_name: name, _cli: 'codex', _tab: 'tab2' });
  svc.setFocus({ tabId: 'tab2', kind: 'codex', label: 'Codex A' });
  svc.onHookEvent(ev('UserPromptSubmit'), { transcriptPath: 'C:\\r.jsonl' });
  svc.onHookEvent(ev('Stop'), { transcriptPath: 'C:\\r.jsonl' });
  const timers = live().filter((x) => x.ms === 1000);
  assert.equal(timers.length, 1, '디바운스 — 마지막 이벤트 하나만 남는다');
  assert.equal(calls.rollout.length, 0);
  timers[0].fn();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls.rollout, ['C:\\r.jsonl']);
  const s = svc.snapshot();
  assert.deepEqual(s.codex.rows.map((r) => [r.id, r.label, r.percent]), [['week', '주간', 3]]);
  assert.equal(s.codex.updatedAt, local(2026, 10, 29, 12, 59));
  assert.deepEqual(s.session, { kind: 'codex', label: 'Codex A', requests: 1, contextPercent: 10 });
  svc.onHookEvent(ev('PreToolUse'), { transcriptPath: 'C:\\r.jsonl' });
  assert.equal(live().filter((x) => x.ms === 1000).length, 0, 'Stop·UserPromptSubmit 이 아니면 새로 읽지 않는다');
  await live().find((x) => x.ms === 2 * 60 * 1000).fn();
  assert.equal(calls.codex.length, 0, '1시간 안의 롤아웃 값이 있으면 자동 조회 생략');
  clock.t += 2 * 3600000;
  await live().at(-1).fn();
  assert.equal(calls.codex.length, 1, '롤아웃 값이 오래되면 조회');
  assert.equal(svc.snapshot().codex.rows[0].observedAt, clock.t, 'app-server 값이 더 최근이라 이긴다');
});

test('Claude 이벤트의 transcriptPath 는 읽지 않고, 읽기 오류는 무시한다', async () => {
  const { svc, live, calls } = makeService({ readRollout: async () => { throw new Error('없음'); } });
  svc.onHookEvent({ session_id: 's1', hook_event_name: 'Stop', _cli: 'claude', _tab: 't' }, { transcriptPath: 'C:\\c.jsonl' });
  assert.equal(live().filter((x) => x.ms === 1000).length, 0);
  svc.onHookEvent({ session_id: 'c1', hook_event_name: 'Stop', _cli: 'codex', _tab: 'u' }, { transcriptPath: 'C:\\r.jsonl' });
  live().find((x) => x.ms === 1000).fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(svc.snapshot().codex.rows.length, 0);
  assert.equal(calls.claude.length, 0);
});

test('dispose: 타이머를 취소하고 진행 중인 /usage 읽기를 중단시킨다', async () => {
  let signal;
  const { svc, timers } = makeService({ readClaude: async (a) => { signal = a.signal; await new Promise((r) => a.signal.addEventListener('abort', r)); return { error: '중단됨' }; } });
  const run = svc.refresh({ manual: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(signal.aborted, false);
  svc.dispose();
  assert.equal(signal.aborted, true);
  assert.ok(timers.every((t) => t.cancelled));
  await run;
  await svc.refresh({ manual: true }); // 종료 뒤 호출은 아무 일도 하지 않는다
});

test('dispose: 진행 중인 Codex app-server 조회도 중단시킨다', async () => {
  let signal;
  const { svc } = makeService({ readCodex: async (loc, o) => { signal = o.signal; await new Promise((r) => o.signal.addEventListener('abort', r)); return { error: '중단됨' }; } });
  const run = svc.refresh({ manual: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(signal.aborted, false);
  svc.dispose();
  assert.equal(signal.aborted, true);
  await run;
});

test('dispose: 실행 파일을 찾는 사이 끝나면 숨긴 claude·app-server 를 새로 띄우지 않는다', async () => {
  const gate = {};
  const wait = (k) => new Promise((r) => { gate[k] = r; });
  const { svc, calls } = makeService({ locateClaude: () => wait('claude'), locateCodex: () => wait('codex') });
  const run = svc.refresh({ manual: true });
  await new Promise((r) => setImmediate(r));
  svc.dispose();
  gate.claude({ file: 'claude' });
  gate.codex({ file: 'codex' });
  await run;
  assert.deepEqual([calls.claude.length, calls.codex.length], [0, 0]);
});

test('상태 표시줄 입력: 값이 직전과 같은 반복 호출은 Claude 활동이 아니다 (hook 이벤트는 활동)', async () => {
  const { svc, clock, live, calls } = makeService();
  await live()[0].fn();
  assert.equal(calls.claude.length, 1, '첫 실행');
  const hourLater = async () => { clock.t += 3600000; await live()[0].fn(); };
  clock.t += 1000;
  svc.onStatus(status(), 'tab1'); // 처음 보는 값 → 활동
  await hourLater();
  assert.equal(calls.claude.length, 2);
  clock.t += 1000;
  svc.onStatus(status(), 'tab1'); // 같은 값의 반복 호출
  svc.onStatus(status(), 'tab1');
  await hourLater();
  assert.equal(calls.claude.length, 2, '값이 같으면 활동이 아니다');
  clock.t += 1000;
  svc.onStatus(status({ context_window: { used_percentage: 50 } }), 'tab1'); // 컨텍스트가 달라짐
  await hourLater();
  assert.equal(calls.claude.length, 3);
  clock.t += 1000;
  svc.onStatus(status({ context_window: { used_percentage: 50 }, rate_limits: { five_hour: { used_percentage: 13, resets_at: 1793000000 } } }), 'tab1'); // 한도가 달라짐
  await hourLater();
  assert.equal(calls.claude.length, 4);
  clock.t += 1000;
  svc.onStatus(status({ context_window: { used_percentage: 50 }, rate_limits: { five_hour: { used_percentage: 13, resets_at: 1793000000 } } }), 'tab1');
  svc.onHookEvent({ session_id: 's1', hook_event_name: 'PreToolUse', _cli: 'claude', _tab: 'tab1' }); // hook 이벤트는 값과 무관하게 활동
  await hourLater();
  assert.equal(calls.claude.length, 5);
  clock.t += 1000;
  svc.onStatus({ rate_limits: { five_hour: { used_percentage: 1, resets_at: 1793000000 } } }); // session_id 없는 입력도 같은 값이면 한 번만
  await hourLater();
  assert.equal(calls.claude.length, 6);
  clock.t += 1000;
  svc.onStatus({ rate_limits: { five_hour: { used_percentage: 1, resets_at: 1793000000 } } });
  await hourLater();
  assert.equal(calls.claude.length, 6);
});

test('포커스를 null 로 주면 세션 줄이 비워진다 (화면을 새로 고칠 때 메인이 부른다)', () => {
  const { svc } = makeService();
  svc.onStatus(status(), 'tab1');
  svc.setFocus({ tabId: 'tab1', kind: 'claude', label: 'proj' });
  assert.equal(svc.snapshot().session.label, 'proj');
  svc.setFocus(null);
  assert.equal(svc.snapshot().session, null);
});

// ---------------------------------------------------------------------------------------------
// Codex app-server 한도 조회 (가짜 app-server)

function fakeCodex(body) {
  const dir = tmp('fakecodex');
  const file = path.join(dir, 'app-server.cjs');
  fs.writeFileSync(file, `
    const rl = require('node:readline').createInterface({ input: process.stdin });
    const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
    rl.on('line', (line) => {
      const m = JSON.parse(line);
      ${body}
    });
  `);
  return { file: process.execPath, prefixArgs: [file] };
}

test('rateLimits: initialize → initialized → account/rateLimits/read 를 거쳐 한도 줄을 만든다', async () => {
  const loc = fakeCodex(`
    if (m.method === 'initialize') { if (m.params.clientInfo.name !== 'agent-office' || m.params.clientInfo.version !== '9.9.9') process.exit(5); out({ id: 1, result: {} }); }
    if (m.method === 'account/rateLimits/read') out({ id: 2, result: { rateLimits: { primary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1793796265 }, secondary: null } } });
  `);
  const r = await codexCli.rateLimits(loc, { appVersion: '9.9.9' });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.rows.map((x) => [x.id, x.label, x.percent, x.resetsAt]), [['week', '주간', 3, 1793796265000]]);
  assert.ok(Number.isFinite(r.at) && r.rows[0].observedAt <= r.at);
});

test('rateLimits: message 없는 오류 응답은 기존처럼 「한도 정보가 없습니다」', async () => {
  const r = await codexCli.rateLimits(fakeCodex(`
    if (m.method === 'initialize') out({ id: 1, result: {} });
    if (m.method === 'account/rateLimits/read') out({ id: 2, error: { code: -1 } });`));
  assert.equal(r.error, '한도 정보가 없습니다');
});

test('rateLimits: 응답이 없으면 시간 초과, 오류 응답·즉시 종료·실행 실패는 { error }', async () => {
  const silent = await codexCli.rateLimits(fakeCodex(`if (m.method === 'initialize') out({ id: 1, result: {} });`), { timeoutMs: 400 });
  assert.match(silent.error, /시간 초과/);
  const bad = await codexCli.rateLimits(fakeCodex(`
    if (m.method === 'initialize') out({ id: 1, result: {} });
    if (m.method === 'account/rateLimits/read') out({ id: 2, error: { message: '로그인이 필요합니다' } });
  `));
  assert.match(bad.error, /로그인/);
  const dead = await codexCli.rateLimits(fakeCodex(`process.exit(1);`));
  assert.match(dead.error, /응답 없이/);
  const missing = await codexCli.rateLimits({ file: path.join(os.tmpdir(), 'no-such-codex.exe'), prefixArgs: [] });
  assert.match(missing.error, /실행하지 못/);
  assert.match((await codexCli.rateLimits({ file: 'cmd.exe', prefixArgs: [], cmdShim: 'x.cmd' })).error, /실행할 수 없/);
});

test('rateLimits: 서버가 보낸 요청·알림(method 가 있는 줄)은 id 가 같아도 응답으로 받지 않는다', async () => {
  const loc = fakeCodex(`
    if (m.method === 'initialize') out({ id: 1, result: {} });
    if (m.method === 'account/rateLimits/read') {
      out({ id: 2, method: 'item/tool/requestUserInput', params: {} });
      out({ id: 2, result: { rateLimits: { primary: { usedPercent: 9, windowDurationMins: 300, resetsAt: 1793796265 }, secondary: null } } });
    }
  `);
  const r = await codexCli.rateLimits(loc);
  assert.deepEqual(r.rows.map((x) => [x.id, x.percent]), [['session', 9]]);
});

test('rateLimits: 중단 신호를 받으면 자식 app-server 를 정리하고 { error } 로 끝낸다 (이미 중단된 신호는 띄우지도 않는다)', async () => {
  const pidFile = path.join(tmp('codexpid'), 'pid.txt');
  const loc = fakeCodex(`if (m.method === 'initialize') { require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); out({ id: 1, result: {} }); }`);
  const ac = new AbortController();
  const run = codexCli.rateLimits(loc, { signal: ac.signal, timeoutMs: 20000 });
  for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100)); // 응답을 안 하는 서버가 떴을 때까지
  ac.abort();
  assert.deepEqual(await run, { error: '중단됨' });
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 30 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!alive(pid), 'app-server 가 남지 않는다');
  const pre = await codexCli.rateLimits({ file: path.join(os.tmpdir(), 'no-such-codex.exe'), prefixArgs: [] }, { signal: AbortSignal.abort() });
  assert.deepEqual(pre, { error: '중단됨' });
});

// ---------------------------------------------------------------------------------------------
// Codex 로그인 상태 (codex login status + app-server account/read)

test('parseLoginStatus: 종료 0 + 「Logged in using」 줄일 때만 로그인, API 키 꼬리는 버린다', () => {
  assert.deepEqual(codexCli.parseLoginStatus(0, 'Logged in using ChatGPT\n'), { loggedIn: true, method: 'ChatGPT' });
  assert.deepEqual(codexCli.parseLoginStatus(0, 'Logged in using an API key - sk-proj-***ABCD'), { loggedIn: true, method: 'an API key' });
  assert.deepEqual(codexCli.parseLoginStatus(0, 'Logged in using ChatGPT\r\n'), { loggedIn: true, method: 'ChatGPT' }, 'CRLF');
  assert.deepEqual(codexCli.parseLoginStatus(0, '\nLogged in using ChatGPT'), { loggedIn: true, method: 'ChatGPT' }, 'stderr 쪽 문구가 뒤에 붙은 합친 출력');
  assert.deepEqual(codexCli.parseLoginStatus(1, 'Not logged in'), { loggedIn: false });
  assert.equal(codexCli.parseLoginStatus(1, 'Logged in using ChatGPT').loggedIn, false, '종료 코드가 0 이 아니면 로그인이 아니다');
  const odd = codexCli.parseLoginStatus(0, '\n  \n뭔가 이상한 출력\n두 번째 줄');
  assert.deepEqual([odd.loggedIn, odd.error], [false, '뭔가 이상한 출력']);
  assert.deepEqual(codexCli.parseLoginStatus(0, ''), { loggedIn: false, error: '로그인 상태를 읽지 못했습니다' });
  assert.equal(codexCli.parseLoginStatus(2, undefined).loggedIn, false);
});

test('methodLabel: 로그인 방식 이름을 한글 표시로 바꾼다', () => {
  const m = codexCli.methodLabel;
  assert.deepEqual([m('ChatGPT'), m('an API key'), m('a API key'), m('personal access token'), m('an access token'), m('Amazon Bedrock')],
    ['ChatGPT', 'API 키', 'API 키', '개인 액세스 토큰', '액세스 토큰', 'Amazon Bedrock']);
  assert.equal(m('something else'), 'something else');
  assert.equal(m('x'.repeat(100)).length, 60);
});

test('appServerRequest: params 가 있으면 싣고 result 를 돌려주며, 없으면 params 키를 생략한다', async () => {
  const got = await codexCli.appServerRequest(fakeCodex(`
    if (m.method === 'initialize') out({ id: 1, result: {} });
    if (m.method === 'x/echo') out({ id: 2, result: { has: 'params' in m, params: m.params ?? null } });
  `), 'x/echo', { a: 1 });
  assert.deepEqual(got, { result: { has: true, params: { a: 1 } } });
  const bare = await codexCli.appServerRequest(fakeCodex(`
    if (m.method === 'initialize') out({ id: 1, result: {} });
    if (m.method === 'x/echo') out({ id: 2, result: { has: 'params' in m } });
  `), 'x/echo', undefined);
  assert.deepEqual(bare, { result: { has: false } });
  const err = await codexCli.appServerRequest(fakeCodex(`
    if (m.method === 'initialize') out({ id: 1, result: {} });
    if (m.method === 'x/echo') out({ id: 2, error: { message: '거절' } });
  `), 'x/echo');
  assert.deepEqual(err, { error: '거절' });
});

// 'login status' 면 출력하고 끝나고, 그 밖(app-server)이면 줄 단위로 처리하는 가짜 codex. account/read 가 불리면 표식 파일을 남긴다.
function fakeAuthCodex({ code = 0, out: loginOut = '', err: loginErr = '', body = '' }) {
  const dir = tmp('fakeauth');
  const file = path.join(dir, 'codex.cjs');
  const mark = path.join(dir, 'account-read.txt');
  fs.writeFileSync(file, `
    if (process.argv[2] === 'login') {
      process.stdout.write(${JSON.stringify(loginOut)}); process.stderr.write(${JSON.stringify(loginErr)}); process.exit(${code});
    }
    const rl = require('node:readline').createInterface({ input: process.stdin });
    const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
    rl.on('line', (line) => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') out({ id: 1, result: {} });
      if (m.method === 'account/read') { require('node:fs').writeFileSync(${JSON.stringify(mark)}, JSON.stringify(m.params)); ${body} }
    });
  `);
  return { loc: { file: process.execPath, prefixArgs: [file] }, mark };
}

test('authStatus: 로그인되어 있으면 account/read 로 이메일·플랜을 덧붙인다 (refreshToken: false)', async () => {
  const { loc, mark } = fakeAuthCodex({ out: 'Logged in using ChatGPT\n',
    body: `out({ id: 2, result: { account: { type: 'chatgpt', email: 'me@example.com', planType: 'plus' }, requiresOpenaiAuth: true } });` });
  const r = await codexCli.authStatus(loc, { appVersion: '1.2.3' });
  assert.deepEqual(r, { loggedIn: true, method: 'ChatGPT', methodLabel: 'ChatGPT', email: 'me@example.com', plan: 'plus' });
  assert.deepEqual(JSON.parse(fs.readFileSync(mark, 'utf8')), { refreshToken: false });
});

test('authStatus: stderr 쪽 문구도 보고, account/read 가 응답이 없으면 판정은 유지하고 이메일·플랜만 비운다', async () => {
  const { loc } = fakeAuthCodex({ err: 'Logged in using an API key - sk-proj-***ABCD\n' }); // account/read 에 응답하지 않는다
  const r = await codexCli.authStatus(loc, { timeoutMs: 200 });
  assert.deepEqual(r, { loggedIn: true, method: 'an API key', methodLabel: 'API 키', email: null, plan: null });
});

test('authStatus: 로그인되어 있지 않으면 account/read 를 부르지 않는다', async () => {
  const { loc, mark } = fakeAuthCodex({ code: 1, err: 'Not logged in\n' });
  assert.deepEqual(await codexCli.authStatus(loc), { loggedIn: false });
  assert.ok(!fs.existsSync(mark), 'app-server 를 띄우지 않는다');
});

// ---------------------------------------------------------------------------------------------
// Git Bash 찾기 (시작 때 한 번 — 중계가 매번 찾지 않는다)

test('findGitBash: 환경 변수 → PATH 의 git 옆 → Program Files 순, WSL(System32·WindowsApps) 의 bash.exe 는 쓰지 않는다', async () => {
  const PF = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const X86 = 'C:\\Program Files (x86)\\Git\\bin\\bash.exe';
  const find = (files, env = {}, where = '') => claudeCli.findGitBash({ env, exists: (p) => files.includes(p), runWhere: async () => ({ stdout: where }) });
  const viaGit = 'D:\\tools\\Git\\bin\\bash.exe';
  const where = 'D:\\tools\\Git\\cmd\\git.exe\r\nC:\\other\\git.exe\r\n';
  assert.equal(await find([PF, viaGit, 'E:\\mybash.exe'], { CLAUDE_CODE_GIT_BASH_PATH: 'E:\\mybash.exe' }, where), 'E:\\mybash.exe', '환경 변수가 먼저');
  assert.equal(await find([PF, viaGit], { CLAUDE_CODE_GIT_BASH_PATH: 'E:\\없음.exe' }, where), viaGit, '환경 변수의 파일이 없으면 git 옆');
  assert.equal(await find([PF, viaGit], {}, where), viaGit, 'PATH 의 git 이 Program Files 보다 먼저');
  assert.equal(await find([PF, X86], {}, ''), PF);
  assert.equal(await find([X86], {}, ''), X86);
  const wsl = 'C:\\Windows\\System32\\bash.exe';
  const apps = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe';
  assert.equal(await find([wsl, apps], { CLAUDE_CODE_GIT_BASH_PATH: wsl }, 'C:\\Windows\\System32\\git.exe'), null, 'System32·WindowsApps 는 제외');
  assert.equal(await find([apps], { CLAUDE_CODE_GIT_BASH_PATH: apps }, ''), null);
  assert.equal(await claudeCli.findGitBash({ env: {}, exists: () => false, runWhere: async () => { throw new Error('where 실패'); } }), null, 'where 가 실패해도 오류 없이 null');
});

// ---------------------------------------------------------------------------------------------
// 상태 표시줄 중계 (실제 스크립트를 node 로 실행)

const RELAY = fileURLToPath(new URL('../src/main/statusline-relay.cjs', import.meta.url));

// project: { local, shared } — 작업 폴더의 .claude/settings.local.json·settings.json 에 넣을 statusLine (undefined 면 파일 없음)
function runRelay({ port, token = 'tok', statusLine, input = '{"session_id":"s9","rate_limits":{}}', tab = 't7', bashPath, project = {} }) {
  const dir = tmp('relay');
  fs.copyFileSync(RELAY, path.join(dir, 'statusline-relay.cjs'));
  if (port) fs.writeFileSync(path.join(dir, 'relay.json'), JSON.stringify({ port, token, ...(bashPath ? { bashPath } : {}) }));
  const cfg = tmp('cfg');
  if (statusLine) fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ statusLine }));
  const cwd = tmp('proj'); // 저장소 안의 .claude 설정이 섞이지 않게 빈 작업 폴더에서 실행한다
  for (const [name, sl] of [['settings.local.json', project.local], ['settings.json', project.shared]]) {
    if (!sl) continue;
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.claude', name), JSON.stringify({ statusLine: sl }));
  }
  return new Promise((resolve) => {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, AGENT_OFFICE_TAB: tab };
    const child = spawn(process.execPath, [path.join(dir, 'statusline-relay.cjs')], { env, cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') }));
    child.stdin.end(input);
  });
}

test('상태 표시줄 중계: 앱 서버에 입력을 알리고, 사용자 statusLine 의 출력·종료 코드를 그대로 돌려준다', async () => {
  const got = [];
  const { server, port } = await startHookServer({ port: 0, token: 'tok', onEvent: () => {}, onStatus: (p, tab) => got.push({ p, tab }) });
  try {
    const echo = { type: 'command', command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'] };
    const r = await runRelay({ port, statusLine: echo, input: '{"session_id":"s9","한글":"표시줄"}' });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '{"session_id":"s9","한글":"표시줄"}', '입력을 그대로 넘기고 출력도 그대로');
    assert.equal(got.length, 1);
    assert.equal(got[0].p.session_id, 's9');
    assert.equal(got[0].tab, 't7');
    const exit3 = await runRelay({ port, statusLine: { type: 'command', command: process.execPath, args: ['-e', 'process.stdout.write("hud");process.exit(3)'] } });
    assert.deepEqual([exit3.code, exit3.stdout], [3, 'hud']);
    assert.equal(got.length, 2);
  } finally {
    server.close();
  }
});

test('상태 표시줄 중계: Claude 와 같은 command 한 줄(셸 실행)도 같은 입력을 받아 출력한다 (Git Bash 는 relay.json 의 bashPath)', async (t) => {
  const bashPath = process.platform === 'win32' ? await claudeCli.findGitBash() : null;
  if (process.platform === 'win32' && !bashPath) { t.skip('Git Bash 없음'); return; }
  const r = await runRelay({ port: 1, bashPath, statusLine: { type: 'command', command: 'node -e "process.stdin.pipe(process.stdout)"' }, input: '{"a":"한글"}' });
  assert.deepEqual([r.code, r.stdout], [0, '{"a":"한글"}']);
});

test('상태 표시줄 중계: Windows 에서 bashPath 가 없으면 PowerShell(절대 경로)로 실행한다', async (t) => {
  if (process.platform !== 'win32') { t.skip('Windows 전용'); return; }
  const noBash = await runRelay({ port: 1, statusLine: { type: 'command', command: 'Write-Output hud' } });
  assert.deepEqual([noBash.code, noBash.stdout.trim()], [0, 'hud']);
  const badBash = await runRelay({ port: 1, bashPath: path.join(os.tmpdir(), 'no-such-bash.exe'), statusLine: { type: 'command', command: 'Write-Output hud' } });
  assert.equal(badBash.stdout.trim(), 'hud', '없는 bashPath 도 PowerShell 로');
  const asked = await runRelay({ port: 1, statusLine: { type: 'command', shell: 'powershell', command: 'Write-Output ps' } });
  assert.equal(asked.stdout.trim(), 'ps');
});

test('상태 표시줄 중계: 사용자 표시줄은 작업 폴더 settings.local.json → settings.json → 사용자 설정 순으로 처음 찾은 command 형식', async () => {
  const hud = (name) => ({ type: 'command', command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(name)})`] });
  const relaySelf = { type: 'command', command: 'node "C:/ud/statusline-relay.cjs"' };
  const out = async (o) => (await runRelay(o)).stdout;
  assert.equal(await out({ statusLine: hud('user'), project: { local: hud('local'), shared: hud('shared') } }), 'local');
  assert.equal(await out({ statusLine: hud('user'), project: { shared: hud('shared') } }), 'shared');
  assert.equal(await out({ statusLine: hud('user'), project: {} }), 'user');
  assert.equal(await out({ statusLine: hud('user'), project: { local: { type: 'text', command: 'x' }, shared: hud('shared') } }), 'shared', 'command 형식이 아니면 건너뜀');
  assert.equal(await out({ statusLine: hud('user'), project: { local: relaySelf, shared: relaySelf } }), 'user', '중계 자신은 건너뜀');
  assert.equal(await out({ statusLine: relaySelf, project: { local: relaySelf } }), '', '끝내 없으면 출력 없음');
});

test('상태 표시줄 중계: 사용자 statusLine 이 없거나 command 형식이 아니거나 자기 자신이면 아무것도 출력하지 않는다', async () => {
  const got = [];
  const { server, port } = await startHookServer({ port: 0, token: 'tok', onEvent: () => {}, onStatus: (p) => got.push(p) });
  try {
    for (const statusLine of [undefined, { type: 'text', command: 'echo hi' }, { type: 'command', command: 'node "C:/x/statusline-relay.cjs"' }]) {
      const r = await runRelay({ port, statusLine });
      assert.deepEqual([r.code, r.stdout], [0, ''], JSON.stringify(statusLine));
    }
    assert.equal(got.length, 3, '출력이 없어도 앱에는 알린다');
  } finally {
    server.close();
  }
});

test('상태 표시줄 중계: 앱 서버가 없거나 토큰이 틀려도 사용자 표시줄은 그대로 나온다', async () => {
  const hud = { type: 'command', command: process.execPath, args: ['-e', 'process.stdout.write("HUD")'] };
  assert.equal((await runRelay({ statusLine: hud })).stdout, 'HUD', 'relay.json 없음');
  assert.equal((await runRelay({ port: 1, statusLine: hud })).stdout, 'HUD', '서버 없음');
  const got = [];
  const { server, port } = await startHookServer({ port: 0, token: 'other', onEvent: () => {}, onStatus: (p) => got.push(p) });
  try {
    assert.equal((await runRelay({ port, token: 'tok', statusLine: hud })).stdout, 'HUD');
    assert.equal(got.length, 0, '토큰이 틀리면 서버가 받지 않는다');
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------------------------
// 모든 AI 사용량 (Grok·Muse·Antigravity) — 실제 CLI 는 실행하지 않고 가짜 runCli·locate 를 넣는다

const GROK_SID = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const GROK_SID2 = '0198a1b2-c3d4-7e5f-8a9b-ffffffffffff';
const tick = () => new Promise((r) => setImmediate(r));
// 실측한 모양(session 필드)의 `grok usage` 출력: 22864 토큰 · 433600000 ticks
const grokJson = (over = {}) => JSON.stringify({
  sessionId: GROK_SID, updatedAt: '2026-11-03T00:00:00Z',
  session: { inputTokens: 20000, outputTokens: 2864, cachedReadTokens: 0, totalTokens: 22864, modelCalls: 3, costUsdTicks: 433600000, turnCount: 2, primaryModelId: 'grok-build', modelUsage: {}, ...over },
  turns: [],
});
const grokStop = (sid = GROK_SID, extra = {}) => ({ session_id: sid, hook_event_name: 'Stop', _cli: 'grok', _tab: 'tab5', ...extra });
// reply(args, loc) → { code, stdout, stderr } 로 답하는 가짜 runCli. cli 에 호출 기록이 쌓인다.
function cliStub(reply) {
  const cli = [];
  return { cli, runCli: async (loc, args, ms) => { cli.push({ loc, args, ms }); return reply(args, loc); } };
}
const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
const fire1s = (live) => live().find((x) => x.ms === 1000).fn();

test('스냅샷: grok·muse·antigravity 칸이 claude·codex 뒤에 있고, 가짜 옵션이 없으면 비어 있다', async () => {
  const { svc } = makeService();
  const s = svc.snapshot();
  assert.deepEqual(Object.keys(s), ['claude', 'codex', 'grok', 'muse', 'antigravity', 'session', 'refresh']);
  for (const k of ['grok', 'muse', 'antigravity']) assert.deepEqual(s[k], { rows: [], error: null, updatedAt: null }, k);
  await svc.refresh({ manual: true }); // locate 옵션이 없으면 읽지 않고 칸도 비어 있다
  for (const k of ['grok', 'muse', 'antigravity']) assert.deepEqual(svc.snapshot()[k], { rows: [], error: null, updatedAt: null }, k);
});

test('Grok: 앱 탭의 Stop 을 1초 디바운스해 `grok usage <세션>` 을 읽고 토큰·비용 줄을 만든다', async () => {
  const { cli, runCli } = cliStub(() => ok(grokJson()));
  const { svc, clock, live } = makeService({ locateGrok: () => ({ file: 'grok' }), runCli });
  svc.onHookEvent(grokStop());
  svc.onHookEvent(grokStop());
  assert.equal(live().filter((x) => x.ms === 1000).length, 1, '디바운스 — 마지막 이벤트 하나만 남는다');
  assert.equal(cli.length, 0);
  const stopAt = clock.t;
  clock.t += 5000;
  fire1s(live);
  await tick();
  assert.deepEqual(cli.map((c) => [c.loc.file, c.args, c.ms]), [['grok', ['usage', GROK_SID], 15000]]);
  const g = svc.snapshot().grok;
  assert.deepEqual(g.rows.map((r) => [r.id, r.label, r.percent, r.valueText, r.observedAt]), [
    ['session', '이번 세션', null, '토큰 22.9k · $0.04', stopAt], ['calls', '모델 호출', null, '3회 · 2턴', stopAt]]);
  assert.ok(g.rows.every((r) => r.resetsAt === null && r.resetsText === null && !('source' in r)));
  assert.equal(g.error, null);
  assert.equal(g.updatedAt, stopAt, '갱신 시각은 Stop 을 받은 시각');
  assert.deepEqual(svc.snapshot().claude.rows, [], 'Claude 칸은 건드리지 않는다');
});

test('Grok: 앱 밖 세션(_tab 없음)·잘못된 세션 ID·Stop 이 아닌 이벤트는 읽지 않는다', async () => {
  const { cli, runCli } = cliStub(() => ok(grokJson()));
  const { svc, live } = makeService({ locateGrok: () => ({ file: 'grok' }), runCli });
  svc.onHookEvent(grokStop(GROK_SID, { _tab: undefined })); // 앱 밖 Grok 세션
  svc.onHookEvent(grokStop('not-a-uuid'));
  svc.onHookEvent(grokStop('../../etc/passwd-0000000000000000000'));
  svc.onHookEvent(grokStop(GROK_SID, { hook_event_name: 'UserPromptSubmit' }));
  svc.onHookEvent(grokStop(GROK_SID, { hook_event_name: 'PreToolUse' }));
  assert.equal(live().filter((x) => x.ms === 1000).length, 0);
  await tick();
  assert.equal(cli.length, 0);
});

test('Grok: 늦게 끝난 옛 읽기가 새 값을 덮지 않는다 (Stop 시각이 관측 시각)', async () => {
  const gates = {};
  const { svc, clock, live } = makeService({
    locateGrok: () => ({ file: 'grok' }),
    runCli: (loc, args) => new Promise((resolve) => { gates[args[1]] = resolve; }),
  });
  svc.onHookEvent(grokStop(GROK_SID)); // 옛 Stop
  fire1s(live);
  await tick();
  clock.t += 5000;
  svc.onHookEvent(grokStop(GROK_SID2)); // 새 Stop
  fire1s(live);
  await tick();
  gates[GROK_SID2](ok(grokJson({ totalTokens: 2000 })));
  await tick();
  assert.equal(svc.snapshot().grok.rows[0].valueText, '토큰 2.0k · $0.04');
  gates[GROK_SID](ok(grokJson({ totalTokens: 1000 }))); // 옛 읽기가 나중에 끝남
  await tick();
  assert.equal(svc.snapshot().grok.rows[0].valueText, '토큰 2.0k · $0.04', '옛 값은 덮지 못한다');
});

test('Grok: 읽기 실패(설치 없음·종료 코드·JSON 아님·형식 다름)는 오류만 채우고 기존 값은 유지, 다음 성공이 오류를 지운다', async () => {
  let mode = 'ok';
  const { runCli } = cliStub(() => (mode === 'ok' ? ok(grokJson()) : mode === 'exit' ? { code: 1, stdout: '', stderr: 'boom' } : mode === 'text' ? ok('no json') : mode === 'shape' ? ok('{"session":{}}') : mode === 'throw' ? Promise.reject(new Error('x')) : ok('')));
  let located = true;
  const { svc, clock, live } = makeService({ locateGrok: () => (located ? { file: 'grok' } : null), runCli });
  const stopAndRead = async () => { clock.t += 1000; svc.onHookEvent(grokStop()); fire1s(live); await tick(); };
  await stopAndRead();
  assert.equal(svc.snapshot().grok.error, null);
  for (const m of ['exit', 'text', 'shape', 'throw']) {
    mode = m;
    await stopAndRead();
    const g = svc.snapshot().grok;
    assert.equal(g.error, 'Grok 사용량을 읽지 못했습니다', m);
    assert.equal(g.rows[0].valueText, '토큰 22.9k · $0.04', `${m}: 기존 값 유지`);
  }
  located = false;
  await stopAndRead();
  assert.equal(svc.snapshot().grok.error, 'Grok 사용량을 읽지 못했습니다', '설치 없음');
  located = true;
  mode = 'ok';
  await stopAndRead();
  assert.equal(svc.snapshot().grok.error, null);
});

test('Grok: SessionEnd 는 그 세션의 대기 중인 읽기를 지우고, dispose 뒤 늦게 온 결과는 버린다', async () => {
  let gate;
  const { svc, live, changes } = makeService({ locateGrok: () => ({ file: 'grok' }), runCli: () => new Promise((r) => { gate = r; }) });
  svc.onHookEvent(grokStop());
  assert.equal(live().filter((x) => x.ms === 1000).length, 1);
  svc.onHookEvent({ session_id: GROK_SID, hook_event_name: 'SessionEnd', _cli: 'grok', _tab: 'tab5' });
  assert.equal(live().filter((x) => x.ms === 1000).length, 0, 'SessionEnd 가 디바운스 타이머를 지운다');
  svc.onHookEvent(grokStop(GROK_SID2));
  fire1s(live);
  await tick();
  const n = changes.length;
  svc.dispose();
  gate(ok(grokJson()));
  await tick();
  assert.deepEqual(svc.snapshot().grok.rows, []);
  assert.equal(changes.length, n, 'dispose 뒤에는 알리지 않는다');
  const again = makeService({ locateGrok: () => ({ file: 'grok' }), runCli: async () => ok(grokJson()) });
  again.svc.onHookEvent(grokStop());
  again.svc.dispose();
  assert.ok(again.timers.every((t) => t.cancelled), 'dispose 가 Grok 디바운스 타이머도 취소');
});

test('Muse: 로그인이 안 됐으면 줄을 비우고 안내, 그 밖의 실패는 값을 유지한 채 오류', async () => {
  let reply = ok(JSON.stringify({ windows: [{ name: '5시간', used_percent: 30 }] }));
  const { cli, runCli } = cliStub(() => reply);
  const { svc, clock } = makeService({ locateMuse: () => ({ file: 'muse' }), runCli });
  await svc.refresh({ manual: true });
  assert.deepEqual(cli.map((c) => [c.args, c.ms]), [[['usage', '--json'], 15000]]);
  assert.equal(svc.snapshot().muse.rows.length, 1);
  clock.t += 6 * 60 * 1000;
  reply = { code: 1, stdout: '', stderr: 'not logged in: run `muse login` first' };
  await svc.refresh({ manual: true });
  assert.deepEqual(svc.snapshot().muse, { rows: [], error: 'Muse 로그인 필요 (구독 계정)', updatedAt: null });
  reply = ok(JSON.stringify({ windows: [{ name: '5시간', used_percent: 30 }] }));
  clock.t += 6 * 60 * 1000;
  await svc.refresh({ manual: true });
  assert.equal(svc.snapshot().muse.error, null);
  clock.t += 6 * 60 * 1000;
  reply = { code: 2, stdout: '', stderr: 'unexpected failure' };
  await svc.refresh({ manual: true });
  assert.equal(svc.snapshot().muse.error, 'Muse 사용량을 읽지 못했습니다');
  assert.equal(svc.snapshot().muse.rows.length, 1, '값 유지');
  clock.t += 6 * 60 * 1000;
  reply = { code: 1, stdout: 'Subscribe to a plan', stderr: '' }; // stdout 쪽 문구도 본다
  await svc.refresh({ manual: true });
  assert.equal(svc.snapshot().muse.error, 'Muse 로그인 필요 (구독 계정)');
  clock.t += 6 * 60 * 1000;
  reply = ok('not json');
  await svc.refresh({ manual: true });
  assert.equal(svc.snapshot().muse.error, 'Muse 사용량 형식을 읽지 못했습니다');
  clock.t += 6 * 60 * 1000;
  reply = ok('{"hello":"world"}');
  await svc.refresh({ manual: true });
  assert.equal(svc.snapshot().muse.error, 'Muse 사용량 형식을 읽지 못했습니다', 'JSON 이지만 사용률을 못 찾음');
  clock.t += 6 * 60 * 1000;
  reply = ok(JSON.stringify({ windows: [{ name: 'subscribe', percent: 10 }] })); // 정상 JSON 이면 문구가 들어 있어도 로그인 검사를 하지 않는다
  await svc.refresh({ manual: true });
  assert.deepEqual([svc.snapshot().muse.error, svc.snapshot().muse.rows.length], [null, 1]);
});

test('Muse: 사용률 키(초 단위 리셋)와 used·limit 쌍, 두 가지 JSON 형태를 줄로 만든다', async () => {
  const future = Math.floor(local(2026, 10, 29, 18, 0) / 1000);
  const shapes = [
    { windows: [{ name: '5h', used_percent: 42.4, resets_at: future }], weekly: { percent: 0.5, resetsAt: '2026-11-01T00:00:00Z' } },
    { allowance: { used: 30, limit: 120 } },
  ];
  let i = 0;
  const { runCli } = cliStub(() => ok(JSON.stringify(shapes[i])));
  const { svc, clock } = makeService({ locateMuse: () => ({ file: 'muse' }), runCli });
  await svc.refresh({ manual: true });
  const rows = Object.fromEntries(svc.snapshot().muse.rows.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(rows).sort(), ['muse:5h', 'muse:weekly']);
  assert.deepEqual([rows['muse:5h'].label, rows['muse:5h'].percent, rows['muse:5h'].resetsAt], ['5h', 42, future * 1000]);
  assert.deepEqual([rows['muse:weekly'].label, rows['muse:weekly'].percent, rows['muse:weekly'].resetsAt], ['weekly', 50, Date.parse('2026-11-01T00:00:00Z')]);
  assert.equal(svc.snapshot().muse.updatedAt, clock.t);
  i = 1;
  clock.t += 6 * 60 * 1000;
  await svc.refresh({ manual: true });
  assert.deepEqual(svc.snapshot().muse.rows.map((r) => [r.id, r.label, r.percent]), [['muse:allowance', 'allowance', 25]], '예전 줄은 남기지 않는다');
});

test('Muse: 자동 갱신은 직전 실행 뒤 Muse 활동이 있었을 때만, 수동은 설치돼 있으면 항상', async () => {
  const { cli, runCli } = cliStub(() => ok(JSON.stringify({ windows: [{ name: '5h', percent: 10 }] })));
  const { svc, clock, live } = makeService({ locateMuse: () => ({ file: 'muse' }), runCli });
  await live()[0].fn();
  assert.equal(cli.length, 0, 'Muse 를 쓴 적이 없으면 첫 자동 갱신에도 읽지 않는다');
  svc.onHookEvent({ session_id: 'm1', hook_event_name: 'UserPromptSubmit', _cli: 'muse', _tab: 'tab6' });
  clock.t += 3600000;
  await live()[0].fn();
  assert.equal(cli.length, 1, 'Muse 활동 뒤에는 읽는다');
  clock.t += 3600000;
  await live()[0].fn();
  assert.equal(cli.length, 1, '그 뒤 활동이 없으면 다음 주기엔 읽지 않는다');
  clock.t += 1000;
  svc.onHookEvent({ session_id: 'm1', hook_event_name: 'PreToolUse', _cli: 'muse', _tab: 'tab6' });
  clock.t += 3600000;
  await live()[0].fn();
  assert.equal(cli.length, 2);
  clock.t += 3600000;
  await svc.refresh({ manual: true });
  assert.equal(cli.length, 3, '수동은 활동과 무관');
  const none = makeService({ locateMuse: () => null, runCli });
  await none.svc.refresh({ manual: true });
  assert.deepEqual(none.svc.snapshot().muse, { rows: [], error: null, updatedAt: null }, '설치 안 됨 — 칸을 숨긴다');
  assert.equal(cli.length, 3);
});

test('Antigravity: 협업 턴 usage 를 누적해 한 줄로 보이고, 설치만 됐을 때는 안내 문구', async () => {
  const { svc, clock, changes } = makeService({ locateAntigravity: () => ({ file: 'agy' }) });
  await svc.refresh({ manual: true });
  assert.deepEqual(svc.snapshot().antigravity, { rows: [], error: '사용량 조회 명령 없음 · 협업 대화 토큰만 표시', updatedAt: null });
  svc.addTurnUsage('antigravity', { input_tokens: 900, output_tokens: 200, thinking_tokens: 100, cache_read_tokens: 50, total_tokens: 1200 });
  svc.addTurnUsage('antigravity', { total_tokens: 800 });
  let a = svc.snapshot().antigravity;
  assert.deepEqual(a.rows.map((r) => [r.id, r.label, r.percent, r.valueText]), [['collab', '협업 대화', null, '토큰 2.0k · 2턴']]);
  assert.equal(a.error, null, '누적이 생기면 안내를 지운다');
  assert.equal(a.updatedAt, clock.t);
  svc.addTurnUsage('antigravity', { input_tokens: 10, output_tokens: 5, thinking_tokens: 5 }); // total_tokens 가 없으면 세 값의 합
  assert.equal(svc.snapshot().antigravity.rows[0].valueText, '토큰 2.0k · 3턴');
  svc.addTurnUsage('antigravity', { total_tokens: 998000 });
  assert.equal(svc.snapshot().antigravity.rows[0].valueText, '토큰 1.0M · 4턴');
  const n = changes.length;
  svc.addTurnUsage('claude', { total_tokens: 5 }); // 다른 AI·이상한 값은 무시
  svc.addTurnUsage('antigravity', null);
  svc.addTurnUsage('antigravity', 'x');
  assert.equal(changes.length, n);
  clock.t += 6 * 60 * 1000;
  await svc.refresh({ manual: true });
  assert.equal(svc.snapshot().antigravity.error, null, '누적이 있으면 갱신해도 안내가 돌아오지 않는다');
  const none = makeService({ locateAntigravity: () => null });
  await none.svc.refresh({ manual: true });
  assert.deepEqual(none.svc.snapshot().antigravity, { rows: [], error: null, updatedAt: null }, '설치 안 됨 — 칸을 숨긴다');
  const disposed = makeService();
  disposed.svc.dispose();
  disposed.svc.addTurnUsage('antigravity', { total_tokens: 5 });
  assert.deepEqual(disposed.svc.snapshot().antigravity.rows, []);
});

test('hook: UserPromptSubmit 이 모든 AI 의 세션 요청 수를 세고, focus kind 가 AI 면 세션 줄 (컨텍스트는 모름)', () => {
  const { svc } = makeService();
  for (const cli of ['grok', 'muse', 'antigravity', 'claude', 'codex']) {
    const tab = `tab-${cli}`;
    svc.setFocus({ tabId: tab, kind: cli, label: `${cli} 작업` });
    assert.equal(svc.snapshot().session, null, `${cli}: 세션이 아직 없음`);
    const ev = (name) => ({ session_id: `s-${cli}`, hook_event_name: name, _cli: cli, _tab: tab });
    svc.onHookEvent(ev('SessionStart'));
    svc.onHookEvent(ev('UserPromptSubmit'));
    svc.onHookEvent(ev('PreToolUse'));
    svc.onHookEvent(ev('UserPromptSubmit'));
    assert.deepEqual(svc.snapshot().session, { kind: cli, label: `${cli} 작업`, requests: 2, contextPercent: null }, cli);
  }
  svc.setFocus({ tabId: 'tab-grok', kind: 'collab', label: '협업' });
  assert.equal(svc.snapshot().session, null, '협업 탭');
  svc.setFocus({ tabId: 'tab-grok', kind: 'gemini', label: '모르는 AI' });
  assert.equal(svc.snapshot().session, null, '모르는 종류');
  svc.onHookEvent({ session_id: 'x1', hook_event_name: 'UserPromptSubmit', _cli: 'gemini', _tab: 'tab-x' });
  svc.setFocus({ tabId: 'tab-x', kind: 'claude', label: 'X' });
  assert.equal(svc.snapshot().session, null, '모르는 AI 의 활동은 세션으로 세지 않는다');
});

test('hook: Grok·Muse 활동은 Claude 자동 /usage 읽기와 Codex 롤아웃 읽기를 부르지 않는다', async () => {
  const { svc, clock, live, calls } = makeService();
  await live()[0].fn();
  assert.equal(calls.claude.length, 1);
  clock.t += 3600000;
  svc.onHookEvent({ session_id: GROK_SID, hook_event_name: 'UserPromptSubmit', _cli: 'grok', _tab: 'tab5' });
  svc.onHookEvent({ session_id: 'm1', hook_event_name: 'Stop', _cli: 'muse', _tab: 'tab6' }, { transcriptPath: 'C:\\m.jsonl' });
  svc.onHookEvent({ session_id: 'a1', hook_event_name: 'Stop', _cli: 'antigravity', _tab: 'tab7' }, { transcriptPath: 'C:\\a.jsonl' });
  assert.equal(live().filter((x) => x.ms === 1000).length, 0, '롤아웃 디바운스는 Codex 만');
  await live()[0].fn();
  assert.equal(calls.claude.length, 1, 'Claude 활동이 아니다');
  assert.equal(calls.rollout.length, 0);
});

test('fmtTokens: 1000 미만은 정수, k·M 은 소수 한 자리 (경계: 999 → 999, 1000 → 1.0k, 999999 → 1.0M)', () => {
  const t = [[0, '0'], [7, '7'], [999, '999'], [1000, '1.0k'], [1234, '1.2k'], [22864, '22.9k'], [999949, '999.9k'], [999950, '1.0M'], [999999, '1.0M'], [1e6, '1.0M'], [1234567, '1.2M']];
  for (const [n, want] of t) assert.equal(fmtTokens(n), want, String(n));
  for (const bad of [NaN, -5, Infinity, undefined, null, '12']) assert.equal(fmtTokens(bad), '0', String(bad));
});

test('parseGrokUsage: 세션 토큰·비용과 호출·턴 줄, 비용은 ticks/1e10 의 소수 둘째 자리(0.005 미만은 <0.01), 형식이 다르면 null', () => {
  const rows = parseGrokUsage(JSON.parse(grokJson()), 42);
  assert.deepEqual(rows, [
    { id: 'session', label: '이번 세션', percent: null, resetsAt: null, resetsText: null, valueText: '토큰 22.9k · $0.04', observedAt: 42 },
    { id: 'calls', label: '모델 호출', percent: null, resetsAt: null, resetsText: null, valueText: '3회 · 2턴', observedAt: 42 }]);
  const text = (over) => parseGrokUsage(JSON.parse(grokJson(over)), 1)[0].valueText;
  assert.equal(text({ costUsdTicks: 12345 }), '토큰 22.9k · $<0.01');
  assert.equal(text({ costUsdTicks: 5e7 }), '토큰 22.9k · $0.01', '0.005 는 올림');
  assert.equal(text({ costUsdTicks: 12.5e10 }), '토큰 22.9k · $12.50');
  assert.equal(text({ costUsdTicks: undefined }), '토큰 22.9k', '비용을 모르면 생략');
  assert.equal(text({ costUsdTicks: 'x' }), '토큰 22.9k');
  assert.equal(parseGrokUsage(JSON.parse(grokJson({ modelCalls: undefined, turnCount: undefined })), 1)[1].valueText, '0회 · 0턴');
  for (const bad of [null, undefined, 5, 'x', [], {}, { session: null }, { session: {} }, { session: { totalTokens: '5' } }]) assert.equal(parseGrokUsage(bad, 1), null, JSON.stringify(bad));
});

test('parseMuseUsage: 사용률 키·이름 키·리셋 키 변형, 0~1 비율, 중첩(깊이 4)·배열, 최대 6줄, 쌍 계산은 사용률 키가 없을 때만', () => {
  const sec = 1793000000;
  const one = (o) => parseMuseUsage(o, 9);
  for (const key of ['used_percent', 'usage_percent', 'percent_used', 'percent', 'utilization', 'usedPercent', 'usagePercent']) {
    assert.equal(one({ plan: { [key]: 33.4 } })[0].percent, 33, key);
  }
  assert.deepEqual(one({ a: { percent: 1 } })[0].percent, 100, '1 이하는 비율');
  assert.deepEqual(one({ a: { percent: 0.375 } })[0].percent, 38);
  assert.deepEqual(one({ a: { percent: 150 } })[0].percent, 100, '범위를 넘으면 100');
  for (const key of ['name', 'label', 'window', 'period', 'type']) assert.equal(one({ x: { [key]: '주간 한도', percent: 5 } })[0].label, '주간 한도', key);
  assert.equal(one({ x: { percent: 5 } })[0].label, 'x', '이름이 없으면 키 이름');
  assert.equal(one({ percent: 5 })[0].label, 'Muse', '키도 없으면 Muse');
  assert.equal(one([{ percent: 5 }])[0].label, 'Muse', '배열 칸 번호는 이름이 아니다');
  assert.equal(one({ x: { percent: 5 } })[0].id, 'muse:x');
  assert.equal(one({ x: { name: 'Weekly Limit', percent: 5 } })[0].id, 'muse:weekly limit', '소문자');
  const reset = (extra) => one({ x: { percent: 5, ...extra } })[0].resetsAt;
  for (const key of ['resets_at', 'reset_at', 'resetsAt', 'resetAt']) assert.equal(reset({ [key]: sec }), sec * 1000, key);
  assert.equal(reset({ resets_at: sec * 1000 }), sec * 1000, '밀리초');
  assert.equal(reset({ resets_at: String(sec) }), sec * 1000, '문자열 숫자');
  assert.equal(reset({ resets_at: '2026-11-01T00:00:00Z' }), Date.parse('2026-11-01T00:00:00Z'), 'ISO');
  assert.equal(reset({ resets_at: 'soon' }), null);
  assert.equal(reset({}), null);
  assert.deepEqual(one({ a: { b: { c: { d: { percent: 5 } } } } }).length, 1, '깊이 4');
  assert.deepEqual(one({ a: { b: { c: { d: { e: { percent: 5 } } } } } }), [], '깊이 5 는 보지 않는다');
  assert.equal(parseMuseUsage({ rows: Array.from({ length: 9 }, (_, i) => ({ name: `n${i}`, percent: i })) }, 9).length, 6, '최대 6줄');
  assert.deepEqual(one({ a: { used: 5, limit: 20 }, b: { usage: 1, allowance: 4 }, c: { used: 1, limit: 0 } }).map((r) => [r.label, r.percent]), [['a', 25], ['b', 25]], 'limit 0 은 계산하지 않는다');
  assert.deepEqual(one({ a: { used: 5, limit: 20 }, b: { percent: 70 } }).map((r) => [r.label, r.percent]), [['b', 70]], '사용률 키가 있으면 쌍은 보지 않는다');
  for (const bad of [null, undefined, 5, 'x', [], {}, { a: { percent: 'x' } }]) assert.deepEqual(one(bad), [], JSON.stringify(bad));
});

test('createUsageLocator: 설치되지 않은 결과는 5분 기억해 다시 찾지 않고, 탭이 위치를 알려 주면 그 값을 먼저 쓴다', async () => {
  const locs = new Map(); let t = 0; let finds = 0; let installed = null;
  const locate = createUsageLocator({
    get: (id) => locs.get(id) || null, set: (id, v) => locs.set(id, v), exists: (f) => f !== 'gone.exe', now: () => t,
    locate: async () => { finds++; return installed; },
  });
  assert.equal(await locate('grok'), null);
  assert.equal(finds, 1);
  t = 4 * 60000;
  assert.equal(await locate('grok'), null);
  assert.equal(finds, 1, '5분 안에는 다시 찾지 않는다');
  assert.equal(await locate('muse'), null);
  assert.equal(finds, 2, '다른 AI 는 따로 센다');
  locs.set('grok', { file: 'grok.exe' }); // 그 사이 탭을 열어 위치가 생김
  assert.deepEqual(await locate('grok'), { file: 'grok.exe' });
  assert.equal(finds, 2);
  locs.delete('grok');
  t = 5 * 60000 + 1;
  installed = { file: 'grok2.exe' };
  assert.deepEqual(await locate('grok'), { file: 'grok2.exe' }, '5분이 지나면 다시 찾는다');
  assert.equal(finds, 3);
  assert.deepEqual(await locate('grok'), { file: 'grok2.exe' });
  assert.equal(finds, 3, '찾았으면 기억한 위치를 그대로');
  locs.set('grok', { file: 'gone.exe' }); // 기억한 파일이 지워지면 다시 찾는다
  installed = null;
  assert.equal(await locate('grok'), null);
  assert.equal(finds, 4);
  assert.equal(await locate('grok'), null);
  assert.equal(finds, 4, '지워진 뒤 못 찾은 결과도 5분 기억');
  locs.set('muse', { file: 'shim.cmd', cmdShim: true });
  assert.equal((await locate('muse')).cmdShim, true, 'cmd 경유 위치는 파일 확인 없이 그대로');
});
