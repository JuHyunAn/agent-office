import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const agyHooks = require('../src/main/agyHooks.cjs');
const { normalizeAgy, toEvent, startHookServer } = require('../src/main/hookServer.cjs');

// 실제 ~/.gemini 은 건드리지 않고 임시 홈만 쓴다.
function withHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-agyhooks-'));
  try { return fn({ homedir: dir }, dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const SYS = { systemRoot: 'C:\\Windows' };
const AGY = { cli: 'antigravity' };

test('agyHooks.command: 절대 경로 curl · 쿼리 · %AGENT_OFFICE_TAB% 치환 자리, 이상하면 null', () => {
  const c = agyHooks.command(47821, 'abcd', 'PreToolUse', SYS);
  assert.equal(c, 'C:\\Windows\\System32\\curl.exe -sS --noproxy 127.0.0.1 -m 3 -H Content-Type:application/json --data-binary @- --url-query k=abcd --url-query src=global --url-query cli=antigravity --url-query ev=PreToolUse --url-query tab=%AGENT_OFFICE_TAB% http://127.0.0.1:47821/hook');
  assert.ok(!c.includes('"'));
  assert.equal(agyHooks.command(47821, 'abcd', 'PreToolUse', { systemRoot: 'C:\\My Windows' }), null, '경로에 공백');
  assert.equal(agyHooks.command(47821, 'abcd', 'PreToolUse', { systemRoot: 'C:\\W&calc' }), null, 'cmd 특수문자');
  assert.equal(agyHooks.command(0, 'abcd', 'Stop', SYS), null);
  assert.equal(agyHooks.command(1.5, 'abcd', 'Stop', SYS), null);
  assert.equal(agyHooks.command(1, 'a b', 'Stop', SYS), null);
  assert.equal(agyHooks.command(1, 'abcd', 'PostToolUse', SYS), null, '쓰지 않는 이벤트');
});

test('agyHooks.entry: 도구 이벤트만 matcher+hooks, 그 밖 이벤트는 hook 객체를 바로 나열(평평)', () => {
  const e = agyHooks.entry(47821, 'abcd', SYS);
  assert.equal(e.enabled, true);
  assert.deepEqual(Object.keys(e), ['enabled', 'SessionStart', 'PreToolUse', 'PreInvocation', 'Stop']);
  for (const ev of ['SessionStart', 'PreInvocation', 'Stop']) {
    assert.ok(Array.isArray(e[ev]) && e[ev].length === 1, ev);
    assert.equal(e[ev][0].type, 'command', `${ev} 는 hook 객체를 바로`);
    assert.equal(e[ev][0].timeout, 5);
    assert.ok(!('hooks' in e[ev][0]) && !('matcher' in e[ev][0]), `${ev} 는 감싸지 않는다`);
    assert.ok(e[ev][0].command.includes(`ev=${ev} `));
  }
  assert.equal(e.PreToolUse.length, 1);
  assert.equal(e.PreToolUse[0].matcher, '*');
  assert.equal(e.PreToolUse[0].hooks[0].type, 'command');
  assert.ok(e.PreToolUse[0].hooks[0].command.includes('ev=PreToolUse '));
  assert.equal(agyHooks.entry(47821, 'abcd', { systemRoot: 'C:\\My Windows' }), null, 'curl 경로가 이상하면 항목을 만들지 않는다');
});

test('agyHooks.filePath: ~/.gemini/config/hooks.json', () => {
  assert.equal(agyHooks.filePath({ homedir: path.join('x', 'h') }), path.join('x', 'h', '.gemini', 'config', 'hooks.json'));
});

test('agyHooks.enable: 파일이 없으면 폴더째 만들고 LF · 2칸 들여쓰기, 백업 없음', () => withHome((opts, dir) => {
  const file = agyHooks.enable(1234, 'tok', { ...opts, ...SYS });
  assert.equal(file, path.join(dir, '.gemini', 'config', 'hooks.json'));
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('\r') && text.endsWith('}\n') && text.includes('\n  "agent-office"'));
  assert.deepEqual(JSON.parse(text), { 'agent-office': agyHooks.entry(1234, 'tok', SYS) });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['hooks.json'], '백업 파일 없음');
}));

test('agyHooks.status: 없음 · 우리 항목(현재/옛 포트·토큰) · 남의 키만 · 깨진 JSON · 객체 아님', () => withHome((opts) => {
  const o = { ...opts, ...SYS };
  assert.deepEqual(agyHooks.status(1, 'a', o), { installed: false, ours: false, current: false, valid: false, foreign: false });
  const file = agyHooks.filePath(o);
  agyHooks.enable(1, 'a', o);
  assert.deepEqual(agyHooks.status(1, 'a', o), { installed: true, ours: true, current: true, valid: true, foreign: false });
  assert.equal(agyHooks.status(2, 'a', o).current, false, '포트가 다름');
  assert.equal(agyHooks.status(11, 'a', o).current, false, '포트가 앞부분만 같음');
  assert.equal(agyHooks.status(1, 'b', o).current, false, '토큰이 다름');
  assert.equal(agyHooks.status(2, 'a', o).ours, true);
  fs.writeFileSync(file, JSON.stringify({ mine: { enabled: true } }));
  assert.deepEqual(agyHooks.status(1, 'a', o), { installed: true, ours: false, current: false, valid: true, foreign: false });
  fs.writeFileSync(file, '{ 깨짐');
  assert.deepEqual(agyHooks.status(1, 'a', o), { installed: true, ours: false, current: false, valid: false, foreign: false });
  fs.writeFileSync(file, '[1]');
  assert.deepEqual(agyHooks.status(1, 'a', o), { installed: true, ours: false, current: false, valid: false, foreign: false });
}));

test('agyHooks.status: enabled 는 비교에서 뺀다 · 형식이 바뀐 옛 항목은 current 가 아니다 · 우리 키가 객체가 아니면 foreign', () => withHome((opts) => {
  const o = { ...opts, ...SYS };
  const file = agyHooks.filePath(o);
  agyHooks.enable(1, 'a', o);
  const put = (v) => fs.writeFileSync(file, JSON.stringify({ 'agent-office': v }));
  put({ ...agyHooks.entry(1, 'a', SYS), enabled: false });
  assert.equal(agyHooks.status(1, 'a', o).current, true, 'enabled 가 꺼져 있어도 같은 내용이면 현재');
  const old = agyHooks.entry(1, 'a', SYS);
  old.Stop[0].timeout = 99; // 명령의 포트·토큰은 같지만 내용이 다른 옛 항목
  put(old);
  assert.deepEqual(agyHooks.status(1, 'a', o), { installed: true, ours: true, current: false, valid: true, foreign: false });
  const wrapped = agyHooks.entry(1, 'a', SYS);
  wrapped.Stop = [{ matcher: '*', hooks: wrapped.Stop }]; // 비도구 이벤트를 감싼 옛 형식
  put(wrapped);
  assert.equal(agyHooks.status(1, 'a', o).current, false);
  for (const v of ['문자열', 3, null, [1], true]) {
    put(v);
    assert.deepEqual(agyHooks.status(1, 'a', o), { installed: true, ours: false, current: false, valid: true, foreign: true }, JSON.stringify(v));
  }
}));

test('agyHooks.enable: 기존 우리 항목의 enabled(boolean) 는 유지하고, 옛 형식 항목은 새 형식으로 고친다', () => withHome((opts) => {
  const o = { ...opts, ...SYS };
  const file = agyHooks.filePath(o);
  agyHooks.enable(1, 'a', o);
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(read()['agent-office'].enabled, true, '처음엔 켠다');
  fs.writeFileSync(file, JSON.stringify({ 'agent-office': { ...agyHooks.entry(1, 'a', SYS), enabled: false } }));
  agyHooks.enable(2, 'b', o);
  assert.equal(read()['agent-office'].enabled, false, '사용자가 끈 것을 다시 켜지 않는다');
  assert.equal(agyHooks.status(2, 'b', o).current, true);
  fs.writeFileSync(file, JSON.stringify({ 'agent-office': { enabled: 'yes', Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'x' }] }] } }));
  agyHooks.enable(2, 'b', o);
  assert.deepEqual(read()['agent-office'], agyHooks.entry(2, 'b', SYS), 'boolean 이 아니면 켠 채로, 옛 내용은 새 형식으로');
}));

test('agyHooks.enable: 우리 이름 키가 객체가 아니면 오류 · 파일·백업 모두 그대로', () => withHome((opts) => {
  const o = { ...opts, ...SYS };
  const file = agyHooks.filePath(o);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const v of ['문자열', 3, null, [1]]) {
    const text = JSON.stringify({ mine: 1, 'agent-office': v });
    fs.writeFileSync(file, text);
    assert.throws(() => agyHooks.enable(1, 'a', o), /다른 용도로 쓰여 건드리지 않습니다/, JSON.stringify(v));
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['hooks.json'], '백업도 임시 파일도 없다');
    assert.equal(agyHooks.disable(o), false, 'disable 도 남의 값은 지우지 않는다');
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
}));

test('agyHooks.enable: 쓰기 도중 실패하면 원본이 그대로이고 임시 파일도 남지 않는다 · 쓰기 직전에 다시 읽는다', () => {
  const files = new Map();
  const homedir = path.join('virtual', 'home');
  const o = { homedir, ...SYS };
  const file = agyHooks.filePath(o);
  const orig = JSON.stringify({ mine: 1 });
  files.set(file, orig);
  let failRename = true;
  const fake = {
    existsSync: (f) => files.has(f),
    readFileSync: (f) => files.get(f),
    writeFileSync: (f, t) => files.set(f, t),
    mkdirSync: () => {},
    renameSync: (a, b) => { if (failRename) throw new Error('rename 실패'); files.set(b, files.get(a)); files.delete(a); },
    rmSync: (f) => { files.delete(f); },
  };
  assert.throws(() => agyHooks.enable(1, 'a', { ...o, fs: fake }), /rename 실패/);
  assert.equal(files.get(file), orig, '원본 보존');
  assert.ok([...files.keys()].every((k) => k === file || k.includes('-backup-')), '임시 파일은 지운다');
  // 첫 읽기와 쓰기 사이에 외부가 키를 추가해도 그 내용 위에 얹는다
  failRename = false;
  const realRead = fake.readFileSync;
  let n = 0;
  fake.readFileSync = (f) => { const t = realRead(f); if (++n === 1) files.set(file, JSON.stringify({ mine: 1, late: 2 })); return t; };
  agyHooks.enable(1, 'a', { ...o, fs: fake });
  const got = JSON.parse(files.get(file));
  assert.equal(got.late, 2, '읽기-고치기 사이에 추가된 키를 잃지 않는다');
  assert.equal(got.mine, 1);
  assert.deepEqual(Object.keys(got).filter((k) => k === 'agent-office'), ['agent-office']);
  assert.ok(!files.has(`${file}.agent-office-tmp-${process.pid}`), '임시 파일 없음');
});

test('agyHooks.enable: 남의 키를 보존하고 처음 넣을 때 한 번만 백업, 다시 켜면 우리 항목만 바꾼다', () => withHome((opts) => {
  const o = { ...opts, ...SYS };
  const file = agyHooks.filePath(o);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const orig = { mine: { enabled: true, Stop: [{ type: 'command', command: 'echo hi' }] }, other: 3 };
  const origText = JSON.stringify(orig, null, 4);
  fs.writeFileSync(file, origText);
  agyHooks.enable(1, 'a', o);
  let got = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(got.mine, orig.mine);
  assert.equal(got.other, 3);
  assert.deepEqual(got['agent-office'], agyHooks.entry(1, 'a', SYS));
  assert.deepEqual(Object.keys(got), ['mine', 'other', 'agent-office']);
  const backups = () => fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith('hooks.json.agent-office-backup-'));
  assert.equal(backups().length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), backups()[0]), 'utf8'), origText, '백업은 원본 그대로');
  // 포트가 바뀌어 다시 써도 백업은 늘지 않고 남의 키는 그대로
  agyHooks.enable(2, 'b', { ...o, now: new Date(Date.now() + 5000) });
  got = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(got.mine, orig.mine);
  assert.equal(got.other, 3);
  assert.deepEqual(agyHooks.status(2, 'b', o), { installed: true, ours: true, current: true, valid: true, foreign: false });
  assert.equal(backups().length, 1, '두 번째부터는 백업하지 않는다');
}));

test('agyHooks.enable: 깨진 JSON · 객체가 아닌 파일 · 안전하지 않은 curl 경로는 파일을 건드리지 않고 오류', () => withHome((opts) => {
  const o = { ...opts, ...SYS };
  const file = agyHooks.filePath(o);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const bad of ['{ 깨짐', '[1,2]', '"문자열"', '', '   ', 'null']) {
    fs.writeFileSync(file, bad);
    assert.throws(() => agyHooks.enable(1, 'a', o), /건드리지 않습니다/, JSON.stringify(bad));
    assert.equal(fs.readFileSync(file, 'utf8'), bad);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['hooks.json'], '백업도 만들지 않는다');
  }
  fs.writeFileSync(file, '{"mine":1}');
  assert.throws(() => agyHooks.enable(1, 'a', { ...opts, systemRoot: 'C:\\My Windows' }), /안전하지 않아/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"mine":1}');
  fs.rmSync(file);
  assert.throws(() => agyHooks.enable(1, 'a', { ...opts, systemRoot: 'C:\\My Windows' }), /안전하지 않아/);
  assert.ok(!fs.existsSync(file), '파일이 없었다면 만들지도 않는다');
}));

test('agyHooks.disable: 우리 항목만 지운다 · 없거나 깨졌으면 false', () => withHome((opts) => {
  const o = { ...opts, ...SYS };
  const file = agyHooks.filePath(o);
  assert.equal(agyHooks.disable(o), false);
  agyHooks.enable(1, 'a', o);
  assert.equal(agyHooks.disable(o), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {}, '남은 키가 없으면 빈 객체');
  assert.equal(agyHooks.disable(o), false);
  fs.writeFileSync(file, JSON.stringify({ mine: 1, 'agent-office': { enabled: true } }));
  assert.equal(agyHooks.disable(o), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mine: 1 });
  fs.writeFileSync(file, '{ 깨짐');
  assert.equal(agyHooks.disable(o), false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ 깨짐');
}));

test('agyHooks: 주입한 fs 만 쓴다 (실제 파일시스템을 건드리지 않는다)', () => {
  const files = new Map();
  const fake = {
    existsSync: (f) => files.has(f),
    readFileSync: (f) => files.get(f),
    writeFileSync: (f, t) => files.set(f, t),
    mkdirSync: () => {},
    renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
    rmSync: (f) => { files.delete(f); },
  };
  const homedir = path.join('virtual', 'home');
  const o = { fs: fake, homedir, ...SYS };
  agyHooks.enable(5, 'k', o);
  assert.equal(agyHooks.status(5, 'k', o).current, true);
  assert.equal(files.size, 1);
  assert.ok(!fs.existsSync(homedir));
  files.set(agyHooks.filePath(o), '{"x":1}');
  agyHooks.enable(5, 'k', o);
  assert.equal(files.size, 2, '기존 파일이 있었으므로 백업이 한 번 생긴다');
  assert.equal(agyHooks.disable(o), true);
});

// ───────── hookServer.normalizeAgy: agy 1.4.12 실측 본문 (필요한 필드만) ─────────

const common = () => ({
  conversationId: 'conv-1', workspacePaths: ['C:/proj/demo'], modelName: 'gemini-x', lastUserInput: '안녕',
  transcriptPath: 'C:/t.jsonl', artifactDirectoryPath: 'C:/a',
});

test('normalizeAgy: SessionStart → SessionStart(startup) + 세션·폴더', () => {
  const n = normalizeAgy(common(), { ...AGY, ev: 'SessionStart' });
  assert.deepEqual(n, { session_id: 'conv-1', cwd: 'C:/proj/demo', hook_event_name: 'SessionStart', source: 'startup' });
});

test('normalizeAgy: PreInvocation 은 invocationNum 0 만 UserPromptSubmit(프롬프트=lastUserInput), 나머지는 null', () => {
  const first = normalizeAgy({ ...common(), invocationNum: 0, initialNumSteps: 0 }, { ...AGY, ev: 'PreInvocation' });
  assert.equal(first.hook_event_name, 'UserPromptSubmit');
  assert.equal(first.prompt, '안녕');
  assert.equal(first.session_id, 'conv-1');
  assert.equal(normalizeAgy({ ...common(), invocationNum: 1, initialNumSteps: 3 }, { ...AGY, ev: 'PreInvocation' }), null);
  assert.equal(normalizeAgy({ ...common(), initialNumSteps: 3 }, { ...AGY, ev: 'PreInvocation' }), null, 'invocationNum 이 없으면 버린다');
});

test('normalizeAgy: PreToolUse 는 도구 이름·입력을 Claude 모양으로', () => {
  const run = normalizeAgy({ ...common(), stepIdx: 4, toolCall: { name: 'run_command', args: { CommandLine: 'ls -la', Cwd: 'C:/x', SafeToAutoRun: true } } }, { ...AGY, ev: 'PreToolUse' });
  assert.equal(run.hook_event_name, 'PreToolUse');
  assert.equal(run.tool_name, 'Bash');
  assert.deepEqual(run.tool_input, { command: 'ls -la' });
  const read = normalizeAgy({ ...common(), toolCall: { name: 'read_file', args: { Path: 'C:/a.txt' } } }, { ...AGY, ev: 'PreToolUse' });
  assert.equal(read.tool_name, 'Read');
  assert.deepEqual(read.tool_input, { file_path: 'C:/a.txt' });
  assert.deepEqual(normalizeAgy({ ...common(), toolCall: { name: 'view_file', args: { AbsolutePath: 'C:/b' } } }, { ...AGY, ev: 'PreToolUse' }).tool_input, { file_path: 'C:/b' });
  assert.deepEqual(normalizeAgy({ ...common(), toolCall: { name: 'write_to_file', args: { TargetFile: 'C:/c' } } }, { ...AGY, ev: 'PreToolUse' }).tool_input, { file_path: 'C:/c' });
  const web = normalizeAgy({ ...common(), toolCall: { name: 'search_web', args: { query: '날씨' } } }, { ...AGY, ev: 'PreToolUse' });
  assert.equal(web.tool_name, 'WebSearch');
  assert.deepEqual(web.tool_input, { query: '날씨' });
  assert.deepEqual(normalizeAgy({ ...common(), toolCall: { name: 'read_url_content', args: { Url: 'https://x.y' } } }, { ...AGY, ev: 'PreToolUse' }).tool_input, { url: 'https://x.y' });
  // 표에 없는 도구는 이름 그대로, 입력은 알려진 키가 없으면 빈 객체
  const ask = normalizeAgy({ ...common(), toolCall: { name: 'ask_question', args: { questions: [{ q: 1 }] } } }, { ...AGY, ev: 'PreToolUse' });
  assert.equal(ask.tool_name, 'ask_question');
  assert.deepEqual(ask.tool_input, {});
  assert.equal(normalizeAgy({ ...common() }, { ...AGY, ev: 'PreToolUse' }), null, 'toolCall 이 없음');
  assert.equal(normalizeAgy({ ...common(), toolCall: { args: {} } }, { ...AGY, ev: 'PreToolUse' }), null, '도구 이름이 없음');
});

test('normalizeAgy: Stop → Stop (최종 답변 없음) · 모르는 이벤트는 null · camelCase 원본 키는 없다', () => {
  const stop = normalizeAgy({ ...common(), terminationReason: 'done', error: '', fullyIdle: true, executionNum: 1 }, { ...AGY, ev: 'Stop' });
  assert.deepEqual(stop, { session_id: 'conv-1', cwd: 'C:/proj/demo', hook_event_name: 'Stop' });
  assert.equal(normalizeAgy(common(), { ...AGY, ev: 'PostInvocation' }), null);
  assert.equal(normalizeAgy(common(), { ...AGY, ev: 'PostToolUse' }), null);
  for (const ev of ['SessionStart', 'Stop']) {
    const n = normalizeAgy(common(), { ...AGY, ev });
    for (const k of ['conversationId', 'workspacePaths', 'modelName', 'lastUserInput', 'transcriptPath', 'artifactDirectoryPath']) assert.ok(!(k in n), k);
  }
});

test('normalizeAgy: antigravity 쿼리·ev 가 없으면 본문을 그대로, 읽을 수 없는 본문은 null', () => {
  const p = { hook_event_name: 'Stop', session_id: 's' };
  assert.equal(normalizeAgy(p, {}), p);
  assert.equal(normalizeAgy(p, { cli: 'grok', ev: 'Stop' }), p);
  assert.equal(normalizeAgy(p, { cli: 'antigravity' }), p);
  assert.equal(normalizeAgy(null, { ...AGY, ev: 'Stop' }), null);
  assert.equal(normalizeAgy('x', { ...AGY, ev: 'Stop' }), null);
});

test('toEvent: 정규화한 agy 본문 → _cli antigravity · 치환 안 된 %AGENT_OFFICE_TAB% 는 탭 없음(외부 세션)', () => {
  const n = normalizeAgy({ ...common(), toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } }, { ...AGY, ev: 'PreToolUse' });
  const inApp = toEvent(n, {}, 'global', 1, { ...AGY, tab: 'tab-agy-1' });
  assert.equal(inApp._cli, 'antigravity');
  assert.equal(inApp._tab, 'tab-agy-1');
  assert.equal(inApp.tool_name, 'Bash');
  assert.deepEqual(inApp.tool_input, { command: 'ls' });
  assert.equal(toEvent(n, {}, 'global', 1, { ...AGY, tab: '%AGENT_OFFICE_TAB%' })._tab, null);
});

test('hookServer: agy 본문을 ev 쿼리로 해석해 전달하고, 쓰지 않는 이벤트는 {} 로 응답만 하고 버린다', async () => {
  const got = [];
  const srv = await startHookServer({ port: 0, token: 'tok', onEvent: (ev) => got.push(ev) });
  const post = async (ev, body, tab = 'tab-agy-1') => {
    const r = await fetch(`http://127.0.0.1:${srv.port}/hook?k=tok&src=global&cli=antigravity&ev=${ev}&tab=${encodeURIComponent(tab)}`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), '{}');
  };
  try {
    await post('SessionStart', common());
    await post('PreInvocation', { ...common(), invocationNum: 0, initialNumSteps: 0 });
    await post('PreInvocation', { ...common(), invocationNum: 1, initialNumSteps: 2 }); // 버려진다
    await post('PostInvocation', { ...common(), invocationNum: 1 }); // 버려진다
    await post('PreToolUse', { ...common(), stepIdx: 1, toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } });
    await post('Stop', { ...common(), fullyIdle: true }, '%AGENT_OFFICE_TAB%');
    assert.deepEqual(got.map((e) => e.hook_event_name), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']);
    assert.ok(got.every((e) => e._cli === 'antigravity' && e.session_id === 'conv-1'));
    assert.deepEqual(got.map((e) => e._tab), ['tab-agy-1', 'tab-agy-1', 'tab-agy-1', null]);
    assert.equal(got[1].prompt, '안녕');
    assert.equal(got[2].tool_name, 'Bash');
    // 같은 본문이라도 ev 가 다르면 다른 이벤트다 (SessionStart 와 Stop 은 본문이 같은 경우가 있다)
    const same = { conversationId: 'c2', workspacePaths: ['C:/w'] };
    await post('SessionStart', same);
    await post('Stop', same);
    assert.equal(got.length, 6);
  } finally {
    srv.server.close();
    srv.server.closeAllConnections?.();
  }
});
