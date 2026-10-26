'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MARK = 'agent-office';
const EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse',
  'SubagentStart', 'SubagentStop', 'Notification', 'PermissionRequest', 'Stop',
];

function hookEntry(port, token, src) {
  return {
    type: 'http',
    url: `http://127.0.0.1:${port}/hook?k=${token}&src=${src}&app=${MARK}`,
    // 앱이 띄운 탭이면 AGENT_OFFICE_TAB 이 채워진다 (헤더 치환은 2.1.241 실측).
    headers: { 'X-Office-Tab': '$AGENT_OFFICE_TAB' },
    allowedEnvVars: ['AGENT_OFFICE_TAB'],
    timeout: 2,
  };
}

function buildHooks(port, token, src) {
  const hooks = {};
  for (const ev of EVENTS) hooks[ev] = [{ hooks: [hookEntry(port, token, src)] }];
  return hooks;
}

function sessionSettings(port, token) {
  return { hooks: buildHooks(port, token, 'session') };
}

function isOurs(h) {
  return !!h && h.type === 'http' && typeof h.url === 'string' && h.url.includes(`app=${MARK}`);
}

// 사용자 설정에서 이 앱이 넣은 hook 만 걷어낸다. 다른 hook·키는 그대로 둔다.
function removeOurs(settings) {
  const out = JSON.parse(JSON.stringify(settings || {}));
  if (!out.hooks || typeof out.hooks !== 'object') return out;
  for (const ev of Object.keys(out.hooks)) {
    const groups = Array.isArray(out.hooks[ev]) ? out.hooks[ev] : [];
    const kept = [];
    for (const g of groups) {
      const hs = Array.isArray(g?.hooks) ? g.hooks.filter((h) => !isOurs(h)) : g?.hooks;
      if (Array.isArray(hs) && hs.length === 0) continue;
      kept.push({ ...g, hooks: hs });
    }
    if (kept.length) out.hooks[ev] = kept; else delete out.hooks[ev];
  }
  if (Object.keys(out.hooks).length === 0) delete out.hooks;
  return out;
}

function addOurs(settings, port, token) {
  const out = removeOurs(settings);
  out.hooks = out.hooks || {};
  const ours = buildHooks(port, token, 'global');
  for (const ev of EVENTS) out.hooks[ev] = [...(out.hooks[ev] || []), ...ours[ev]];
  return out;
}

function findOurs(settings) {
  for (const groups of Object.values(settings?.hooks || {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
        if (isOurs(h)) {
          const m = h.url.match(/127\.0\.0\.1:(\d+)\//);
          const k = h.url.match(/[?&]k=([^&]+)/);
          return { installed: true, port: m ? Number(m[1]) : null, token: k ? k[1] : null };
        }
      }
    }
  }
  return { installed: false, port: null, token: null };
}

function globalSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  return JSON.parse(text); // 깨진 JSON 이면 예외 — 덮어쓰지 않는다
}

// 토큰은 화면으로 내보내지 않고 일치 여부만 알린다.
function readGlobalStatus(currentPort, currentToken, file = globalSettingsPath()) {
  try {
    const { token, ...st } = findOurs(readJson(file));
    return {
      ...st,
      portMatches: st.installed ? st.port === currentPort : null,
      tokenMatches: st.installed ? token === currentToken : null,
      path: file,
    };
  } catch (e) {
    return { installed: false, port: null, portMatches: null, tokenMatches: null, path: file, error: `설정 파일을 읽지 못했습니다: ${e.message}` };
  }
}

function writeWithBackup(target, obj) {
  // 닷파일 관리 도구가 심볼릭 링크로 걸어 둔 경우 링크가 아니라 실제 파일을 고친다.
  let file = target;
  try { file = fs.realpathSync(target); } catch { /* 아직 없는 파일 */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backup = `${file}.agent-office-backup-${stamp}`;
    fs.copyFileSync(file, backup);
  }
  const tmp = `${file}.agent-office-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return backup;
}

function installGlobal(port, token, file = globalSettingsPath()) {
  const next = addOurs(readJson(file), port, token);
  return writeWithBackup(file, next);
}

function uninstallGlobal(file = globalSettingsPath()) {
  const cur = readJson(file);
  if (!findOurs(cur).installed) return null;
  return writeWithBackup(file, removeOurs(cur));
}

module.exports = {
  EVENTS, MARK, sessionSettings, addOurs, removeOurs, findOurs, isOurs,
  readGlobalStatus, installGlobal, uninstallGlobal, globalSettingsPath,
};
