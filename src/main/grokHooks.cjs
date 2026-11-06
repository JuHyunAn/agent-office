'use strict';

const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { t } = require('../shared/i18n.js');

// Grok 은 세션 단위로 hook 을 주입하는 공식 경로가 없다(1.0.70 실측: GROK_CONFIG 의 hooks 는 무시).
// 그래서 공식 위치 ~/.grok/hooks/ 에 이 앱 전용 파일 하나만 두고, 켜고 끌 수 있게 한다. 다른 파일은 건드리지 않는다.
const MARK = 'agent-office';
const FILE_NAME = 'agent-office.json';
// Grok 에는 PermissionRequest 가 오지 않는다(실측) — 넣지 않는다.
const EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse',
  'SubagentStart', 'SubagentStop', 'Notification', 'Stop', 'StopFailure',
];

function home({ env = process.env, homedir = os.homedir() } = {}) {
  return path.resolve(env.GROK_HOME || path.join(homedir, '.grok'));
}

function filePath(opts) {
  return path.join(home(opts), 'hooks', FILE_NAME);
}

function urlOf(port, token) {
  return `http://127.0.0.1:${port}/hook?k=${token}&src=global&cli=grok&app=${MARK}`;
}

function build(port, token) {
  const hooks = {};
  for (const ev of EVENTS) hooks[ev] = [{ matcher: '*', hooks: [{ type: 'http', url: urlOf(port, token), timeout: 2 }] }];
  return { hooks };
}

// 파일 안 hook 주소를 모두 모은다.
function urlsOf(obj) {
  const urls = [];
  for (const groups of Object.values(obj?.hooks || {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) if (typeof h?.url === 'string') urls.push(h.url);
    }
  }
  return urls;
}

// installed: 파일이 있음 · ours: 이 앱이 만든 파일(주소에 app=agent-office) · current: 모든 주소가 지금 포트·토큰과 같음.
// 읽기 실패·깨진 JSON 은 「있지만 우리 것이 아님」으로 본다 (덮어쓰거나 지우지 않는다).
function status(port, token, { fs = nodeFs, ...opts } = {}) {
  const file = filePath(opts);
  if (!fs.existsSync(file)) return { installed: false, ours: false, current: false };
  try {
    const urls = urlsOf(JSON.parse(fs.readFileSync(file, 'utf8')));
    const ours = urls.some((u) => u.includes(`app=${MARK}`));
    const want = urlOf(port, token);
    return { installed: true, ours, current: ours && urls.length > 0 && urls.every((u) => u === want) };
  } catch {
    return { installed: true, ours: false, current: false };
  }
}

function enable(port, token, { fs = nodeFs, ...opts } = {}) {
  const file = filePath(opts);
  const cur = status(port, token, { fs, ...opts });
  if (cur.installed && !cur.ours) throw new Error(t('main.grok.fileConflict', { file }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(build(port, token), null, 2) + '\n');
  return file;
}

// 이 앱이 만든 파일일 때만 지운다. 없으면 그대로 성공, 남의 파일이면 그대로 둔다.
function disable({ fs = nodeFs, ...opts } = {}) {
  const file = filePath(opts);
  if (!fs.existsSync(file)) return false;
  if (!status(0, '', { fs, ...opts }).ours) return false;
  fs.rmSync(file, { force: true });
  return true;
}

module.exports = { MARK, EVENTS, home, filePath, build, status, enable, disable };
