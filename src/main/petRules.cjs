'use strict';

// 바탕화면 펫의 순수 규칙 (electron 에 기대지 않아 테스트할 수 있다): 설정 정리, 표시 여부, 창 위치, 펫 그림 읽기.
const fs = require('node:fs');
const path = require('node:path');

const PET_MODES = ['always', 'alerts', 'off'];
const PET_KINDS = ['claude', 'codex'];
const PET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MARGIN = 16;
const MAX_SHEET_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const SHEET_TYPES = { '.png': 'image/png', '.webp': 'image/webp' };
// Codex 펫 형식의 허용 시트 크기: 버전 1 = 9줄, 버전 2 = 11줄 (버전은 그림 높이로 정한다)
const SHEETS = [{ version: 1, width: 1536, height: 1872 }, { version: 2, width: 1536, height: 2288 }];

// { width, height } 가 허용 시트 크기면 그 버전(1·2), 아니면 null.
function sheetVersionOf(size) {
  const s = size && SHEETS.find((x) => x.width === size.width && x.height === size.height);
  return s ? s.version : null;
}

// pet.json 의 spriteVersionNumber 규칙 하나: 없음/null → 그림 버전을 쓴다, 숫자 1·2 → 그림 버전과 같아야 한다, 그 밖(3, "2" 문자열 등) → 거부.
// 쓸 버전(1·2) 또는 거부면 null.
function spriteVersion(declared, imageVersion) {
  if (imageVersion !== 1 && imageVersion !== 2) return null;
  if (declared === undefined || declared === null) return imageVersion;
  return declared === imageVersion ? imageVersion : null;
}

// 펫 그림 선택 값: null (기본) | 'none' (아이콘만) | 'builtin:<id>' | 'user:<id>'. 예전 맨 id 는 'user:<id>' 로 옮기고, 그 밖은 null. id 는 소문자로 맞춘다.
function normalizeSprite(v) {
  if (v === 'none') return 'none';
  if (typeof v !== 'string') return null;
  const m = /^(builtin|user):(.*)$/s.exec(v);
  if (m) return PET_ID_RE.test(m[2]) ? `${m[1]}:${m[2].toLowerCase()}` : null;
  return PET_ID_RE.test(v) ? `user:${v.toLowerCase()}` : null;
}

function normalizePetConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const a = r.anchor;
  const anchor = a && typeof a === 'object' && Number.isFinite(a.right) && Number.isFinite(a.bottom) ? { right: a.right, bottom: a.bottom } : null;
  const s = r.sprites && typeof r.sprites === 'object' ? r.sprites : {};
  return {
    mode: PET_MODES.includes(r.mode) ? r.mode : 'always',
    anchor,
    sprites: { claude: normalizeSprite(s.claude), codex: normalizeSprite(s.codex) },
    usage: { expanded: r.usage?.expanded !== false }, // 사용량 패널 펼침 (기본 펼침)
  };
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
const pct = (v) => (finite(v) === null ? null : Math.min(100, Math.max(0, Math.round(v))));

// 메인 사용량 서비스의 스냅샷을 펫 화면에 보낼 형식으로 정리한다: 알려진 필드만, 줄 수·글 길이·숫자 범위를 제한한다.
function sanitizeUsage(s) {
  const src = s && typeof s === 'object' ? s : {};
  const section = (v) => {
    const x = v && typeof v === 'object' ? v : {};
    const rows = [];
    for (const r of Array.isArray(x.rows) ? x.rows.slice(0, 6) : []) {
      if (!r || typeof r !== 'object') continue;
      rows.push({
        id: text(r.id, 60) ?? '', label: text(r.label, 40) ?? '', percent: pct(r.percent),
        resetsAt: finite(r.resetsAt), resetsText: text(r.resetsText, 60), observedAt: finite(r.observedAt),
      });
    }
    return { rows, error: text(x.error, 120), updatedAt: finite(x.updatedAt) };
  };
  const ss = src.session && typeof src.session === 'object' ? src.session : null;
  const rf = src.refresh && typeof src.refresh === 'object' ? src.refresh : {};
  return {
    claude: section(src.claude),
    codex: section(src.codex),
    session: ss && (ss.kind === 'claude' || ss.kind === 'codex')
      ? { kind: ss.kind, label: text(ss.label, 60) ?? '', requests: finite(ss.requests) === null ? 0 : Math.max(0, Math.trunc(ss.requests)), contextPercent: pct(ss.contextPercent) }
      : null,
    refresh: { busy: rf.busy === true, nextAllowedAt: finite(rf.nextAllowedAt), lastRunAt: finite(rf.lastRunAt) },
  };
}

function hasAttention(payload) {
  return Object.values(payload?.kinds || {}).some((k) => Array.isArray(k?.attention) && k.attention.length > 0);
}

function shouldShow(mode, payload) {
  if (mode === 'off') return false;
  if (mode === 'alerts') return hasAttention(payload) || !!payload?.collab?.active; // 협업 대화 중에는 알림이 없어도 보인다
  return true;
}

// 카드로 허용·거부할 수 있는 도구와 그 도구의 실제 실행 필드. 카드의 미리보기는 이 필드의 문자열 전체여야 한다 (그 밖의 도구는 안내만).
// renderer/pet/model.js 의 cardPreview 와 같은 규칙이다 (main=CommonJS, renderer=ESM 이라 두 벌 — test/pet.test.js 가 같은 입력 표로 맞춰 본다).
const CARD_FIELDS = {
  Bash: 'command', PowerShell: 'command', Read: 'file_path', WebFetch: 'url', WebSearch: 'query', LS: 'path',
};
// 도구별 허용 입력 키: input 에 이 밖의 키가 하나라도 있으면 카드에 안 보이는 값이 실행에 영향을 줄 수 있으니 안내만 한다.
const CARD_KEYS = {
  Bash: ['command', 'description', 'timeout', 'run_in_background'],
  PowerShell: ['command', 'description', 'timeout', 'run_in_background'],
  Read: ['file_path', 'offset', 'limit'],
  LS: ['path'],
  WebFetch: ['url', 'prompt'],
  WebSearch: ['query'],
};
const CARD_MAX_LEN = 160;
const CARD_MAX_BREAKS = 3;
const CARD_BREAK_RE = /\r\n|[\r\n\u2028\u2029\u0085]/g; // 줄 구분: CRLF, CR, LF, LS, PS, NEL
const CARD_HIDDEN_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/; // 제어·양방향·폭 0 문자 (보이는 글과 실제 값이 달라 보일 수 있다)

// 카드에 보여 줄 승인 대상 문자열. 카드로 답할 수 없으면 null: 허용 목록 밖 도구 · 허용 밖 입력 키 · 문자열이 아님/빔 · '…' 로 끝남(잘림) · 160자 초과 · 줄바꿈 3개 초과 · 제어 문자.
function cardPreview(tool, input) {
  if (typeof tool !== 'string' || !Object.hasOwn(CARD_FIELDS, tool) || !input || typeof input !== 'object') return null;
  if (Object.keys(input).some((k) => !CARD_KEYS[tool].includes(k))) return null;
  const v = input[CARD_FIELDS[tool]];
  if (typeof v !== 'string' || v.trim() === '' || v.endsWith('…') || v.length > CARD_MAX_LEN) return null;
  if ((v.match(CARD_BREAK_RE) || []).length > CARD_MAX_BREAKS || CARD_HIDDEN_RE.test(v)) return null;
  return v;
}

// 카드로 답할 수 있는 권한 요청의 permId 모음: 마지막 펫 상태에서 canAnswer 이고 permId 가 있는 항목만.
// pending ([{ id, tool, input }], 서버가 붙잡은 요청) 을 주면 거기에 더해, 서버가 보류할 때 받은 도구·입력으로 계산한 미리보기가 항목의 preview 와 정확히 같은 것만 남긴다.
function answerableIds(kinds, pending) {
  const held = Array.isArray(pending) ? new Map(pending.map((p) => [p.id, p])) : null;
  const ids = new Set();
  for (const kind of PET_KINDS) {
    for (const x of Array.isArray(kinds?.[kind]?.attention) ? kinds[kind].attention : []) {
      if (!x || x.canAnswer !== true || typeof x.permId !== 'string' || !x.permId) continue;
      if (held) {
        const h = held.get(x.permId);
        if (!h || h.tool !== x.tool) continue;
        const shown = cardPreview(h.tool, h.input);
        if (shown === null || shown !== x.preview) continue;
      }
      ids.add(x.permId);
    }
  }
  return ids;
}

// 붙잡고 있는 권한 요청 가운데 풀어야 할 것 (id 배열). pending: [{ id, at }], seen: 카드로 답할 수 있다고 확인된 id 모음 (여기서 채운다).
// 답할 수 있는 항목이면 남기고, 아니면: 한 번 나타났다가 빠졌거나 graceMs 안에 나타나지 않았을 때 푼다.
function permsToRelease(pending, answerable, seen, now, graceMs = 2000) {
  const out = [];
  for (const p of Array.isArray(pending) ? pending : []) {
    if (answerable.has(p.id)) { seen.add(p.id); continue; }
    if (seen.has(p.id) || now - p.at >= graceMs) out.push(p.id);
  }
  return out;
}

const contains = (wa, p) => p.x >= wa.x && p.x < wa.x + wa.width && p.y >= wa.y && p.y < wa.y + wa.height;

// 점이 놓인 모니터. 어디에도 없으면 작업 영역 중심이 가장 가까운 모니터, 모니터 목록이 비면 주 모니터.
function displayFor(point, displays, primary) {
  if (!displays?.length) return primary;
  const inside = displays.find((d) => contains(d.workArea, point));
  if (inside) return inside;
  const dist = (d) => Math.hypot(point.x - (d.workArea.x + d.workArea.width / 2), point.y - (d.workArea.y + d.workArea.height / 2));
  return displays.reduce((best, d) => (dist(d) < dist(best) ? d : best));
}

function placeBounds(anchor, size, displays, primary) {
  const { width, height } = size;
  let right;
  let bottom;
  if (anchor) {
    ({ right, bottom } = anchor);
  } else {
    const wa = primary.workArea;
    right = wa.x + wa.width - MARGIN;
    bottom = wa.y + wa.height - MARGIN;
  }
  const wa = displayFor({ x: right - 1, y: bottom - 1 }, displays, primary).workArea;
  const clamp = (v, min, max) => (max < min ? min : Math.min(Math.max(v, min), max));
  return {
    x: Math.round(clamp(right - width, wa.x, wa.x + wa.width - width)),
    y: Math.round(clamp(bottom - height, wa.y, wa.y + wa.height - height)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function anchorOf(bounds) {
  return { right: bounds.x + bounds.width, bottom: bounds.y + bounds.height };
}

// 펫 폴더 안의 그림 파일 하나를 읽는다: 상대 경로·'..' 없음·png/webp·폴더 밖을 가리키지 않음·8MB 이하. 어긋나면 null.
// head: 숫자면 파일 앞부분 그만큼만 읽어 head 로 돌려준다 (목록에서 그림 크기를 볼 때 전체를 읽지 않으려고).
function readSheet(dir, realDir, rel, fsImpl, withBytes = true, head = 0) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel)) return null;
  if (rel.split(/[\\/]/).includes('..')) return null;
  const type = SHEET_TYPES[path.extname(rel).toLowerCase()];
  if (!type) return null;
  const realFile = fsImpl.realpathSync(path.join(dir, rel));
  if (!realFile.startsWith(realDir + path.sep)) return null;
  const st = fsImpl.statSync(realFile);
  if (!st.isFile() || st.size > MAX_SHEET_BYTES) return null;
  let top = null;
  if (head > 0) {
    const fd = fsImpl.openSync(realFile, 'r');
    try {
      const buf = Buffer.alloc(Math.min(head, st.size));
      const n = fsImpl.readSync(fd, buf, 0, buf.length, 0);
      top = buf.subarray(0, n);
    } finally { fsImpl.closeSync(fd); }
  }
  return { type, bytes: withBytes ? fsImpl.readFileSync(realFile) : null, head: top };
}

// 사용자 폴더의 펫(pet.json + 그림 시트)을 읽는다. 폴더 밖을 가리키는 경로·큰 파일·잘못된 형식은 모두 null.
// pet.json 의 앱 전용 항목 agentOffice.sleepSheetPath (자는 동작 줄) 는 같은 검증을 거쳐 sleepBytes·sleepType 으로 붙고, 실패해도 본 그림은 그대로다.
// bytes: false 면 그림 내용은 읽지 않고(목록용) 검사만 한다 — 이때 bytes·sleepBytes 는 null. head: 숫자면 본 그림 앞부분만 읽어 head 로 붙인다.
function readPet(petsDir, id, fsImpl = fs, { bytes = true, head = 0 } = {}) {
  try {
    if (typeof id !== 'string' || !PET_ID_RE.test(id)) return null;
    const dir = path.join(petsDir, id);
    const realDir = fsImpl.realpathSync(dir);
    const jsonPath = fsImpl.realpathSync(path.join(dir, 'pet.json'));
    if (!jsonPath.startsWith(realDir + path.sep)) return null; // pet.json 이 폴더 밖을 가리키는 연결이면 읽지 않는다
    if (fsImpl.statSync(jsonPath).size > MAX_JSON_BYTES) return null;
    const meta = JSON.parse(fsImpl.readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, '')); // 앞의 BOM 은 떼고 읽는다
    const sheet = readSheet(dir, realDir, meta?.spritesheetPath, fsImpl, bytes, head);
    if (!sheet) return null;
    const displayName = typeof meta.displayName === 'string' ? meta.displayName.slice(0, 40) : id;
    // 선언한 그림 버전: 없음/null → null, 1·2 → 그 숫자, 그 밖의 값 → 'invalid' (spriteVersion 이 거부한다). 크기 검사는 호출하는 쪽에서.
    const declared = meta.spriteVersionNumber;
    const pet = { id, displayName, type: sheet.type, bytes: sheet.bytes, spriteVersionNumber: declared === undefined || declared === null ? null : declared === 1 || declared === 2 ? declared : 'invalid' };
    if (head > 0) pet.head = sheet.head;
    if (meta.agentOffice?.sleepSheetPath !== undefined) {
      try {
        const sleep = readSheet(dir, realDir, meta.agentOffice.sleepSheetPath, fsImpl, bytes);
        if (sleep) { pet.sleepType = sleep.type; pet.sleepBytes = sleep.bytes; }
      } catch { /* 자는 그림만 없는 것으로 */ }
    }
    return pet;
  } catch {
    return null;
  }
}

module.exports = {
  PET_MODES, PET_KINDS, PET_ID_RE, MARGIN, MAX_SHEET_BYTES, SHEETS, sheetVersionOf, spriteVersion,
  normalizePetConfig, normalizeSprite, sanitizeUsage, hasAttention, shouldShow, CARD_FIELDS, cardPreview, answerableIds, permsToRelease, displayFor, placeBounds, anchorOf, readPet,
};
