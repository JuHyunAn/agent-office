'use strict';

const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { curlPath, SAFE } = require('./museCli.cjs');
const { t } = require('../shared/i18n.js');

// Antigravity(agy 1.4.12 실측)는 세션 단위 hook 주입 경로가 없다 (--settings 는 hooks 를 「unknown setting」으로 거부).
// 그래서 공용 ~/.gemini/config/hooks.json 에 이 앱 이름(NAME)의 항목 하나만 넣는다 — 다른 키는 그대로 둔다.
// 실측 형식: 도구 이벤트(PreToolUse·PostToolUse)만 [{ matcher, hooks:[…] }] 로 감싸고, 그 밖 이벤트는 hook 객체를 바로 나열한다
// (비도구 이벤트를 감싸면 「command hook must specify 'command'」 로 파일 전체가 거부된다).
// hook 은 cmd 로 실행되고 명령 안의 %AGENT_OFFICE_TAB% 가 앱 탭 환경변수로 치환된다 (앱 밖 세션은 치환되지 않아 문자 그대로 → 외부 세션).
const NAME = 'agent-office';
const FILE_NAME = 'hooks.json';
// PostInvocation·PostToolUse 는 사무실 표시에 쓰지 않는다 (PostToolUse 는 실측에서 발화도 안 함).
const EVENTS = ['SessionStart', 'PreToolUse', 'PreInvocation', 'Stop'];
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse'];

function filePath({ homedir = os.homedir() } = {}) {
  return path.join(homedir, '.gemini', 'config', FILE_NAME);
}

// 이벤트마다 hook 명령 한 줄. curl 은 절대 경로 (museCli.curlPath — cmd 는 현재 폴더를 먼저 찾으므로 이름만 쓰지 않는다).
// 끝은 `>nul 2>nul & exit /b 0`: Antigravity 는 hook 이 실패하거나(exit≠0 — 앱이 꺼져 curl 이 연결 실패) 결과가 `{}` 이면 모든 도구를 거부한다(fail closed, 1.4.12 실측).
// 그래서 curl 출력(앱 응답)에 기대지 않고 늘 출력 없이 exit 0 으로 끝낸다. 오류 출력도 버린다 (cmd 의 한글 오류가 UTF-8 이 아니면 agy 가 비정상 종료한다).
// 명령에는 큰따옴표를 넣지 않는다 (agy 가 `\"` 로 바꿔 cmd 에 넘겨 명령이 깨진다).
// 경로·포트·토큰이 안전하지 않으면 null (호출하는 쪽이 항목을 만들지 않는다).
function command(port, token, ev, { systemRoot } = {}) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
  if (!SAFE.test(String(token)) || !EVENTS.includes(ev)) return null;
  const curl = curlPath(systemRoot);
  if (!curl) return null;
  return `${curl} -s --noproxy 127.0.0.1 -m 3 -H Content-Type:application/json --data-binary @- --url-query k=${token} --url-query src=global --url-query cli=antigravity --url-query ev=${ev} --url-query tab=%AGENT_OFFICE_TAB% http://127.0.0.1:${p}/hook >nul 2>nul & exit /b 0`;
}

// 우리 항목. 안전한 명령을 만들 수 없으면 null.
function entry(port, token, opts) {
  const hookOf = (ev) => {
    const cmd = command(port, token, ev, opts);
    return cmd && { type: 'command', command: cmd, timeout: 5 };
  };
  const out = { enabled: true };
  for (const ev of EVENTS) {
    const h = hookOf(ev);
    if (!h) return null;
    out[ev] = TOOL_EVENTS.includes(ev) ? [{ matcher: '*', hooks: [h] }] : [h];
  }
  return out;
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// 파일 내용 → 객체. 깨진 JSON 이거나 객체가 아니면 null.
function parse(text) {
  try {
    const obj = JSON.parse(String(text).replace(/^﻿/, ''));
    return isObj(obj) ? obj : null;
  } catch {
    return null;
  }
}

const withoutEnabled = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'enabled'));

// installed: 파일이 있음 · valid: JSON 객체임 · ours: 우리 이름 항목이 있음 · foreign: 우리 이름 키가 있지만 객체가 아님(남의 값 — 덮지 않는다)
// current: 그 항목이 지금 포트·토큰으로 만든 항목과 같음 (enabled 는 사용자가 agy 쪽에서 끌 수 있어 비교에서 뺀다).
// 읽기 실패·깨진 JSON 은 「있지만 유효하지 않음」으로 본다 (덮어쓰거나 지우지 않는다).
function status(port, token, { fs = nodeFs, ...opts } = {}) {
  const file = filePath(opts);
  const base = { installed: true, ours: false, current: false, valid: false, foreign: false };
  if (!fs.existsSync(file)) return { ...base, installed: false };
  let obj = null;
  try { obj = parse(fs.readFileSync(file, 'utf8')); } catch { /* 읽기 실패 */ }
  if (!obj) return base;
  if (Object.hasOwn(obj, NAME) && !isObj(obj[NAME])) return { ...base, valid: true, foreign: true };
  const ours = obj[NAME];
  if (!ours) return { ...base, valid: true };
  const mine = entry(port, token, opts);
  return { ...base, ours: true, valid: true, current: !!mine && JSON.stringify(withoutEnabled(ours)) === JSON.stringify(withoutEnabled(mine)) };
}

function backupName(file, now) {
  return `${file}.${NAME}-backup-${now.toISOString().replace(/[:.]/g, '-')}`;
}

// 파일을 읽어 객체로 돌려준다. 파일이 없으면 null. 깨진 JSON·객체가 아님·우리 이름 키가 객체가 아님(남의 값)이면 건드리지 않고 오류.
function load(fs, file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const obj = parse(text);
  if (!obj) throw new Error(t('main.agy.hooksUnreadable', { file }));
  if (Object.hasOwn(obj, NAME) && !isObj(obj[NAME])) throw new Error(t('main.agy.hooksKeyConflict', { name: NAME, file }));
  return { text, obj };
}

// 임시 파일에 쓴 뒤 바꿔치기한다 (쓰다 끊겨도 원본이 반쯤 잘리지 않게). 실패하면 임시 파일을 지우고 오류.
function writeAtomic(fs, file, obj) {
  const tmp = `${file}.${NAME}-tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 이미 없음 */ }
    throw e;
  }
}

// 우리 항목을 넣거나 바꾼다. 파일이 없으면 새로 만들고, 있으면 다른 키는 그대로 두며, 처음 우리 항목을 넣을 때만 한 번 백업한다.
// 쓰기 직전에 파일을 한 번 더 읽어 그 사이 바뀐 내용 위에 우리 항목만 얹는다. 이미 있는 항목의 enabled(boolean)는 그대로 둔다.
// 파일이 깨진 JSON 이거나 객체가 아니거나 우리 이름 키가 남의 값이면 건드리지 않고 오류를 던진다 (사용자 파일 보호).
function enable(port, token, { fs = nodeFs, now = new Date(), ...opts } = {}) {
  const file = filePath(opts);
  const mine = entry(port, token, opts);
  if (!mine) throw new Error(t('main.agy.hooksUnsafe'));
  const first = load(fs, file);
  if (!first) fs.mkdirSync(path.dirname(file), { recursive: true });
  else if (!Object.hasOwn(first.obj, NAME)) fs.writeFileSync(backupName(file, now), first.text);
  const fresh = load(fs, file);
  const obj = fresh ? fresh.obj : {};
  const prev = obj[NAME];
  obj[NAME] = { ...mine, enabled: typeof prev?.enabled === 'boolean' ? prev.enabled : true };
  writeAtomic(fs, file, obj);
  return file;
}

// 우리 항목만 지운다 (다른 키는 그대로 — 남은 키가 없으면 빈 객체). 파일이 없거나 우리 항목이 없거나 깨진 파일이면 아무것도 하지 않고 false.
function disable({ fs = nodeFs, ...opts } = {}) {
  const file = filePath(opts);
  if (!fs.existsSync(file)) return false;
  const obj = parse(fs.readFileSync(file, 'utf8'));
  if (!obj || !isObj(obj[NAME])) return false;
  delete obj[NAME];
  writeAtomic(fs, file, obj);
  return true;
}

module.exports = { NAME, EVENTS, filePath, command, entry, status, enable, disable };
