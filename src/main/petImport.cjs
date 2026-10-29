'use strict';

// 펫 가져오기: 인터넷에서 받은 zip·폴더를 검사해 userData/pets/<id> 로 설치한다 (electron 에 기대지 않는 순수 모듈).
// 원칙은 「애매하면 거부」. 오류는 정해진 한국어 문구만 error 로 돌려주고, 원문 메시지는 detail 로만 따로 둔다 (메인 로그용).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { PET_ID_RE, MAX_SHEET_BYTES, SHEETS, readPet, spriteVersion } = require('./petRules.cjs');

const MAX_ZIP_BYTES = 32 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_ENTRIES = 64;
const MAX_NAME = 256;
const EOCD_SEARCH = 65557; // EOCD 22B + 주석 최대 65535B
const MAX_SHEET_CANDIDATES = 4; // pet.json 이 없을 때 크기를 확인해 볼 그림 파일 수 상한
const SLEEP = { width: 1536, height: 208 };

const ERR = {
  generic: '펫을 가져오지 못했습니다',
  zipBig: 'zip 파일이 너무 큽니다 (32MB 이하만 가져올 수 있습니다)',
  zipBad: '올바른 zip 파일이 아닙니다',
  zipUnsupported: '지원하지 않는 zip 형식입니다 (암호화·ZIP64 등)',
  zipMany: '파일이 너무 많습니다',
  badName: '허용되지 않는 파일 이름이 들어 있습니다',
  layout: '폴더 구조가 맞지 않습니다 (최상위 폴더 하나까지만 허용됩니다)',
  broken: '압축 파일 안의 내용이 손상되었거나 선언과 다릅니다',
  bigFile: '파일이 너무 큽니다',
  badJson: 'pet.json 을 읽을 수 없습니다',
  noSheet: '펫 그림 파일(png·webp)을 찾을 수 없습니다',
  ambiguous: '펫 그림을 하나로 정할 수 없습니다 (pet.json 이 필요합니다)',
  badSize: '그림 크기가 1536x1872(9줄) 또는 1536x2288(11줄)이 아닙니다',
  badVersion: '펫 정보의 그림 버전과 실제 그림 크기가 맞지 않습니다',
  install: '펫을 설치하지 못했습니다',
};

class PetImportError extends Error {}
const fail = (message) => { throw new PetImportError(message); };

// 오류를 { error, detail? } 로: 정해진 문구는 그대로, 그 밖의 예외는 일반 문구 + 원문(detail).
function failure(e, fallback = ERR.generic) {
  return e instanceof PetImportError ? { error: e.message } : { error: fallback, detail: String(e?.message ?? e) };
}

const CONTROL_RE = /\p{Cc}/u;
const HIDDEN_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu; // 제어·서식(양방향·폭 0 문자 포함)·줄/문단 구분 문자

// ───────────────────────── zip 읽기 ─────────────────────────

// 정규화된 이름(구분자 '/')을 검사한다: 선행 '/', 드라이브, ':', 제어문자, '.'·'..'·빈 조각은 거부.
function checkName(n) {
  if (!n || n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.includes(':') || CONTROL_RE.test(n)) fail(ERR.badName);
  for (const part of n.split('/')) if (part === '' || part === '.' || part === '..') fail(ERR.badName);
}

// 가져올 때 무시하는 파일 (macOS 가 끼워 넣는 것들).
function isIgnoredName(name) {
  const parts = name.split('/');
  const last = parts[parts.length - 1].toLowerCase();
  return parts[0].toLowerCase() === '__macosx' || parts.some((p) => p.startsWith('._')) || last === '.ds_store' || last === 'thumbs.db';
}

function parseZip(buf) {
  if (!Buffer.isBuffer(buf)) fail(ERR.zipBad);
  if (buf.length > MAX_ZIP_BYTES) fail(ERR.zipBig);
  if (buf.length < 22) fail(ERR.zipBad);
  // EOCD: 끝에서 거꾸로 찾되 「서명 + 22 + 주석 길이 === 파일 길이」 인 것만 (주석 속 가짜 서명을 피한다)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - EOCD_SEARCH); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) { eocd = i; break; }
  }
  if (eocd < 0) fail(ERR.zipBad);
  const disk = buf.readUInt16LE(eocd + 4), cdDisk = buf.readUInt16LE(eocd + 6);
  const onDisk = buf.readUInt16LE(eocd + 8), total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12), cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || onDisk === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) fail(ERR.zipUnsupported); // ZIP64
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) fail(ERR.zipUnsupported); // ZIP64 EOCD 위치 표시
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total || total === 0) fail(ERR.zipBad);
  if (total > MAX_ENTRIES) fail(ERR.zipMany);
  const cdEnd = cdOffset + cdSize;
  if (cdEnd > eocd) fail(ERR.zipBad);

  const entries = [];
  const seen = new Set();
  const ranges = [];
  let pos = cdOffset;
  for (let n = 0; n < total; n++) {
    if (pos + 46 > cdEnd || buf.readUInt32LE(pos) !== 0x02014b50) fail(ERR.zipBad);
    const flags = buf.readUInt16LE(pos + 8), method = buf.readUInt16LE(pos + 10), crc = buf.readUInt32LE(pos + 16);
    const csize = buf.readUInt32LE(pos + 20), usize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28), extraLen = buf.readUInt16LE(pos + 30), commentLen = buf.readUInt16LE(pos + 32);
    const diskStart = buf.readUInt16LE(pos + 34), localOffset = buf.readUInt32LE(pos + 42);
    const next = pos + 46 + nameLen + extraLen + commentLen;
    if (next > cdEnd) fail(ERR.zipBad);
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff || diskStart === 0xffff) fail(ERR.zipUnsupported);
    if (nameLen === 0 || nameLen > MAX_NAME) fail(ERR.badName);
    if (flags & 0x2041) fail(ERR.zipUnsupported); // 비트 0·6 (암호화), 13 (중앙 디렉터리 암호화)
    if (method !== 0 && method !== 8) fail(ERR.zipUnsupported);
    if (diskStart !== 0 || (method === 0 && csize !== usize)) fail(ERR.zipBad);
    // 로컬 헤더의 이름·extra 길이까지 더한 실제 데이터 범위 (중앙 디렉터리의 값과 다를 수 있다)
    if (localOffset + 30 > cdOffset || buf.readUInt32LE(localOffset) !== 0x04034b50) fail(ERR.zipBad);
    const dataEnd = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28) + csize;
    if (dataEnd > cdOffset) fail(ERR.zipBad);

    const raw = buf.subarray(pos + 46, pos + 46 + nameLen);
    const norm = (flags & 0x800 ? raw.toString('utf8') : raw.toString('latin1')).replace(/\\/g, '/');
    const isDir = norm.endsWith('/');
    const clean = isDir ? norm.slice(0, -1) : norm;
    checkName(clean);
    const key = clean.toLowerCase();
    if (seen.has(key)) fail(ERR.badName); // 대소문자만 다른 중복도 거부
    seen.add(key);
    ranges.push({ start: localOffset, end: dataEnd });
    if (!isDir && !isIgnoredName(clean)) entries.push({ name: clean, method, flags, crc, csize, usize, localOffset, dataLimit: cdOffset });
    pos = next;
  }
  if (pos !== cdEnd) fail(ERR.zipBad);
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) if (ranges[i].start < ranges[i - 1].end) fail(ERR.zipBad); // 항목끼리 데이터가 겹침
  return entries;
}

// zip 의 중앙 디렉터리만 읽어 파일 목록을 돌려준다 (압축은 풀지 않는다). 디렉터리·무시 대상은 목록에서 빠진다.
function readZipEntries(buf) {
  try {
    return { entries: parseZip(buf) };
  } catch (e) {
    return failure(e, ERR.zipBad);
  }
}

// 항목 하나를 푼다. 로컬 헤더를 다시 확인하고, 선언 크기·CRC 가 다르면 던진다.
function extractEntry(buf, entry, maxBytes) {
  if (entry.method !== 0 && entry.method !== 8) fail(ERR.zipUnsupported);
  if (entry.usize > maxBytes) fail(ERR.bigFile);
  const off = entry.localOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== 0x04034b50) fail(ERR.broken);
  const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28); // 로컬 이름·extra 길이 (중앙의 것과 다를 수 있다)
  const end = start + entry.csize;
  if (end > entry.dataLimit || end > buf.length) fail(ERR.broken);
  const data = buf.subarray(start, end);
  let out;
  if (entry.method === 0) {
    out = Buffer.from(data);
  } else {
    try {
      out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, entry.usize) }); // 선언한 크기를 넘으면 던진다
    } catch {
      fail(ERR.broken);
    }
  }
  if (out.length !== entry.usize) fail(ERR.broken);
  if (typeof zlib.crc32 === 'function' && zlib.crc32(out) !== entry.crc) fail(ERR.broken);
  return out;
}

// ───────────────────────── 그림 크기 ─────────────────────────

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 그림 머리글만 읽어 { type: 'png'|'webp', width, height } 를 돌려준다. 그 밖은 null.
function imageInfo(b) {
  if (!Buffer.isBuffer(b)) return null;
  if (b.length >= 24 && b.subarray(0, 8).equals(PNG_SIG) && b.toString('latin1', 12, 16) === 'IHDR') {
    return { type: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { type: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      return { type: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { type: 'webp', width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}

function imageSize(b) {
  const i = imageInfo(b);
  return i ? { width: i.width, height: i.height } : null;
}

// ───────────────────────── 펫 검사 ─────────────────────────

// 모든 파일이 루트에 있거나 모두 같은 최상위 폴더 하나 아래에 있어야 한다. 그 접두를 뗀 소문자 이름의 Map 을 돌려준다.
function stripCommonFolder(files) {
  const names = [...files.keys()].map((n) => String(n));
  for (const n of names) checkName(n);
  const depth = names.map((n) => n.split('/').length);
  let prefix = '';
  if (!depth.every((d) => d === 1)) {
    const tops = new Set(names.map((n) => n.split('/')[0].toLowerCase()));
    if (!depth.every((d) => d === 2) || tops.size !== 1) fail(ERR.layout);
    prefix = `${names[0].split('/')[0]}/`;
  }
  const out = new Map();
  for (const [name, read] of files) {
    const key = String(name).slice(prefix.length).toLowerCase();
    if (out.has(key)) fail(ERR.badName);
    out.set(key, read);
  }
  return out;
}

// pet.json 이 가리키는 파일을 목록에서 찾는다 ('./' 제거·'\' 정규화·대소문자 무시, png/webp 만). 없으면 null.
function findFile(local, p) {
  if (typeof p !== 'string' || !p || p.length > MAX_NAME) return null;
  let s = p.replace(/\\/g, '/').toLowerCase();
  while (s.startsWith('./')) s = s.slice(2);
  if (!/\.(png|webp)$/.test(s)) return null;
  if (s.split('/').some((x) => x === '' || x === '.' || x === '..' || x.includes(':'))) return null;
  return local.has(s) ? s : null;
}

// 그림 파일 하나를 읽어 크기가 허용 목록(wants) 중 하나인지 확인한다. 내용으로 정한 형식(png/webp)을 확장자로, 맞은 항목의 버전(있으면)을 돌려준다.
function readImage(read, wants, sizeError) {
  const bytes = read(MAX_SHEET_BYTES);
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_SHEET_BYTES) fail(ERR.bigFile);
  const info = imageInfo(bytes);
  const want = info && wants.find((w) => w.width === info.width && w.height === info.height);
  if (!want) fail(sizeError);
  return { bytes, ext: info.type, version: want.version };
}

function parseMeta(read) {
  const buf = read(MAX_JSON_BYTES);
  if (!Buffer.isBuffer(buf) || buf.length > MAX_JSON_BYTES) fail(ERR.badJson);
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 앞의 BOM
  let meta;
  try { meta = JSON.parse(text); } catch { fail(ERR.badJson); }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) fail(ERR.badJson);
  return meta;
}

// 폴더 이름으로 쓸 id: 소문자, [a-z0-9_-] 외는 '-', 연속 '-' 하나로, 앞뒤 정리, 64자. 비면 'pet', Windows 예약 이름이면 앞에 'pet-'.
function slugId(raw) {
  let s = String(raw ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^[-_]+/, '').slice(0, 64).replace(/[-_]+$/, '');
  if (!s) s = 'pet';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(s)) s = `pet-${s}`.slice(0, 64);
  return s;
}

function cleanText(v, max) {
  return typeof v === 'string' ? [...v.replace(HIDDEN_RE, '').trim()].slice(0, max).join('') : '';
}

function buildPet(files, sourceName) {
  if (!(files instanceof Map) || files.size === 0) fail(ERR.noSheet);
  const local = stripCommonFolder(files);
  const jsonRead = local.get('pet.json');
  const meta = jsonRead ? parseMeta(jsonRead) : null;

  let sheet;
  if (meta) {
    const key = findFile(local, meta.spritesheetPath);
    if (!key) fail(ERR.noSheet);
    sheet = readImage(local.get(key), SHEETS, ERR.badSize);
    if (spriteVersion(meta.spriteVersionNumber, sheet.version) === null) fail(ERR.badVersion); // 선언이 있으면 그림 크기가 정한 버전과 같아야 한다
  } else {
    // pet.json 이 없으면 허용 크기(1536x1872·1536x2288)의 그림이 정확히 하나일 때만 그것을 시트로 쓴다
    const candidates = [...local.keys()].filter((k) => /\.(png|webp)$/.test(k));
    if (candidates.length === 0) fail(ERR.noSheet);
    if (candidates.length > MAX_SHEET_CANDIDATES) fail(ERR.ambiguous);
    const found = [];
    for (const k of candidates) {
      try {
        found.push(readImage(local.get(k), SHEETS, ERR.badSize));
      } catch (e) {
        if (!(e instanceof PetImportError) || e.message !== ERR.badSize) throw e; // 크기가 다른 그림만 건너뛰고, 손상 등은 그대로 알린다
      }
    }
    if (found.length === 0) fail(ERR.badSize);
    if (found.length > 1) fail(ERR.ambiguous);
    [sheet] = found;
  }

  // 자는 동작 줄은 선택 항목: 없거나 어긋나면 오류 없이 버린다
  let sleep;
  const sleepKey = findFile(local, meta?.agentOffice?.sleepSheetPath);
  if (sleepKey) {
    try { sleep = readImage(local.get(sleepKey), [SLEEP], ERR.badSize); } catch { sleep = undefined; }
  }

  const id = slugId(typeof meta?.id === 'string' && meta.id.trim() ? meta.id : sourceName);
  const prepared = { id, displayName: cleanText(meta?.displayName, 40) || id, description: cleanText(meta?.description, 120), sheet, version: sheet.version };
  if (sleep) prepared.sleep = sleep;
  return prepared;
}

// files: Map<정규화한 이름(소문자 키), (maxBytes) => Buffer 지연 읽기>. 시트·잠자기 그림과 pet.json 만 읽는다.
function preparePet({ files, sourceName } = {}) {
  try {
    return buildPet(files, sourceName);
  } catch (e) {
    return failure(e);
  }
}

// zip 바이트 → preparePet 결과. 항목은 필요할 때만 푼다.
function importZip(buf, sourceName) {
  const z = readZipEntries(buf);
  if (z.error) return z;
  const files = new Map();
  for (const e of z.entries) files.set(e.name.toLowerCase(), (max) => extractEntry(buf, e, max));
  return preparePet({ files, sourceName });
}

// 폴더 → preparePet 결과: 폴더 안 파일과 하위 폴더 한 겹의 파일만, 실제 경로가 고른 폴더 안인 것만 (연결로 밖을 가리키면 제외).
// 루트에 pet.json 이 있으면 루트 파일만 보고 하위 폴더는 무시한다.
function importFolder(dir) {
  try {
    const realDir = fs.realpathSync(dir);
    const inside = (real) => { const rel = path.relative(realDir, real); return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
    const files = new Map();
    const add = (rel, real) => {
      if (isIgnoredName(rel)) return;
      const key = rel.toLowerCase();
      if (files.has(key)) fail(ERR.badName);
      if (files.size >= MAX_ENTRIES) fail(ERR.zipMany);
      files.set(key, (max) => {
        const st = fs.statSync(real);
        if (!st.isFile() || st.size > max) fail(ERR.bigFile);
        return fs.readFileSync(real);
      });
    };
    const scan = (abs, prefix, deep) => {
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const full = path.join(abs, e.name);
        let real;
        try { real = fs.realpathSync(full); } catch { continue; }
        if (!inside(real)) continue;
        if (e.isDirectory()) {
          if (deep) scan(full, `${prefix}${e.name}/`, false);
        } else if (fs.statSync(real).isFile()) {
          add(`${prefix}${e.name}`, real);
        }
      }
    };
    const rootMeta = fs.readdirSync(dir, { withFileTypes: true }).some((e) => !e.isDirectory() && e.name.toLowerCase() === 'pet.json');
    scan(dir, '', !rootMeta);
    return preparePet({ files, sourceName: path.basename(dir) });
  } catch (e) {
    return failure(e);
  }
}

// ───────────────────────── 설치·삭제 ─────────────────────────

async function renameRetry(fsImpl, from, to) {
  for (let i = 0; ; i++) {
    try {
      fsImpl.renameSync(from, to);
      return;
    } catch (e) {
      if ((e.code === 'EPERM' || e.code === 'EBUSY') && i < 3) await delay(100); // 백신·탐색기가 잠깐 잡고 있을 때 (메인 스레드는 막지 않는다)
      else throw e;
    }
  }
}

// preparePet 결과를 petsDir/<id> 에 설치한다. 임시 폴더에 고정 이름으로 쓰고 readPet 로 다시 읽어 통과해야 옮긴다.
async function installPet(prepared, petsDir, fsImpl = fs) {
  let tmp = null;
  try {
    if (!prepared || prepared.error || !PET_ID_RE.test(prepared.id) || !['png', 'webp'].includes(prepared.sheet?.ext) || !Buffer.isBuffer(prepared.sheet?.bytes) || (prepared.version !== 1 && prepared.version !== 2)) fail(ERR.install);
    fsImpl.mkdirSync(petsDir, { recursive: true });
    for (const n of fsImpl.readdirSync(petsDir)) { // 이전에 중단된 설치의 임시 폴더
      if (n.startsWith('.tmp-')) { try { fsImpl.rmSync(path.join(petsDir, n), { recursive: true, force: true }); } catch { /* 다음에 다시 */ } }
    }
    const taken = new Set(fsImpl.readdirSync(petsDir).map((n) => n.toLowerCase()));
    let id = prepared.id;
    for (let n = 2; taken.has(id.toLowerCase()); n++) {
      if (n > 999) fail(ERR.install);
      const suffix = `-${n}`;
      id = prepared.id.slice(0, 64 - suffix.length).replace(/[-_]+$/, '') + suffix; // 잘린 끝의 -·_ 는 떼고 접미어를 붙인다
    }

    tmp = path.join(petsDir, `.tmp-${crypto.randomBytes(6).toString('hex')}`);
    const dir = path.join(tmp, id);
    fsImpl.mkdirSync(dir, { recursive: true });
    const sheetName = `spritesheet.${prepared.sheet.ext}`;
    fsImpl.writeFileSync(path.join(dir, sheetName), prepared.sheet.bytes, { flag: 'wx' });
    const meta = { id, displayName: prepared.displayName, description: prepared.description, spritesheetPath: sheetName, spriteVersionNumber: prepared.version };
    if (prepared.sleep) {
      const sleepName = `sleep.${prepared.sleep.ext}`;
      fsImpl.writeFileSync(path.join(dir, sleepName), prepared.sleep.bytes, { flag: 'wx' });
      meta.agentOffice = { sleepSheetPath: sleepName };
    }
    fsImpl.writeFileSync(path.join(dir, 'pet.json'), JSON.stringify(meta, null, 2), { flag: 'wx' });

    const back = readPet(tmp, id, fsImpl);
    if (!back || !back.bytes.equals(prepared.sheet.bytes) || back.spriteVersionNumber !== prepared.version || (prepared.sleep && !back.sleepBytes?.equals(prepared.sleep.bytes))) fail(ERR.install);
    const target = path.join(petsDir, id);
    if (fsImpl.existsSync(target)) fail(ERR.install);
    await renameRetry(fsImpl, dir, target);
    return { id };
  } catch (e) {
    return failure(e, ERR.install);
  } finally {
    if (tmp) { try { fsImpl.rmSync(tmp, { recursive: true, force: true }); } catch { /* 다음 설치 때 정리 */ } }
  }
}

// 가져온 펫 폴더를 지운다: 소문자 id 형식·실제 경로(petsDir 바로 아래)를 확인하고 폴더 안이 일반 파일뿐일 때만,
// 먼저 .tmp-del-* 로 옮겨 목록에서 바로 사라지게 한 뒤 그 안을 지운다 (지우다 실패해도 남은 .tmp-* 는 다음 설치 때 정리된다).
function removePet(petsDir, id, fsImpl = fs) {
  try {
    if (typeof id !== 'string' || !PET_ID_RE.test(id) || id !== id.toLowerCase()) return false;
    const real = fsImpl.realpathSync(path.join(petsDir, id));
    if (real !== path.join(fsImpl.realpathSync(petsDir), id)) return false;
    for (const n of fsImpl.readdirSync(real)) if (!fsImpl.lstatSync(path.join(real, n)).isFile()) return false;
    const trash = path.join(petsDir, `.tmp-del-${crypto.randomBytes(6).toString('hex')}`);
    fsImpl.renameSync(real, trash);
    try { fsImpl.rmSync(trash, { recursive: true, force: true }); } catch { /* 다음 설치 때 정리 */ }
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  MAX_ZIP_BYTES, ERR, PetImportError, readZipEntries, extractEntry, imageSize, preparePet, importZip, importFolder, installPet, removePet,
};
