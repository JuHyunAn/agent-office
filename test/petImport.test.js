import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const { readZipEntries, extractEntry, imageSize, preparePet, importZip, importFolder, installPet, removePet, ERR } = require('../src/main/petImport.cjs');

// ───────────────────────── 도우미: 그림 머리글 · zip 조립 ─────────────────────────

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (w, h, tag = '') => {
  const b = Buffer.alloc(33);
  PNG_SIG.copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return Buffer.concat([b, Buffer.from(tag)]);
};
// 손으로 만든 webp 머리글 (kind: 'VP8 ' | 'VP8L' | 'VP8X')
const webp = (kind, w, h, tag = '') => {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(32, 4);
  b.write('WEBP', 8, 'latin1');
  b.write(kind, 12, 'latin1');
  b.writeUInt32LE(20, 16);
  if (kind === 'VP8 ') { b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a; b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28); }
  if (kind === 'VP8L') { b[20] = 0x2f; b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21); }
  if (kind === 'VP8X') { b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); }
  return Buffer.concat([b, Buffer.from(tag)]);
};
const SHEET = webp('VP8X', 1536, 1872, 'sheet');
const SLEEP = webp('VP8X', 1536, 208, 'sleep');
const petJson = (extra = {}) => JSON.stringify({ id: 'Cool Pet', displayName: 'Cool', description: 'a pet', spritesheetPath: 'spritesheet.webp', ...extra });

// zip 한 개를 조립한다. 항목마다 method·flags·extra·crc·크기 등을 덮어써서 깨진 zip 도 만든다.
function makeZip(items, { comment = Buffer.alloc(0), eocd = {} } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const it of items) {
    const nameBuf = Buffer.from(it.name, 'utf8');
    const raw = Buffer.isBuffer(it.data) ? it.data : Buffer.from(it.data ?? '');
    const method = it.method ?? 8;
    const comp = it.comp ?? (method === 8 ? zlib.deflateRawSync(raw) : raw);
    const crc = it.crc ?? zlib.crc32(raw);
    const usize = it.usize ?? raw.length;
    const csize = it.csize ?? comp.length;
    const flags = it.flags ?? 0x800;
    const lextra = it.localExtra ?? Buffer.alloc(0);
    const cextra = it.centralExtra ?? Buffer.alloc(0);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    if (!it.descriptor) { lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(csize, 18); lh.writeUInt32LE(usize, 22); }
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(lextra.length, 28);
    const parts = [lh, nameBuf, lextra, comp];
    if (it.descriptor) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(csize, 8); dd.writeUInt32LE(usize, 12);
      parts.push(dd);
    }
    const local = Buffer.concat(parts);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(csize, 20);
    ch.writeUInt32LE(usize, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(cextra.length, 30);
    ch.writeUInt32LE(it.localOffset ?? offset, 42);
    centrals.push(Buffer.concat([ch, nameBuf, cextra]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(eocd.disk ?? 0, 4);
  e.writeUInt16LE(eocd.onDisk ?? items.length, 8);
  e.writeUInt16LE(eocd.total ?? items.length, 10);
  e.writeUInt32LE(eocd.cdSize ?? cd.length, 12);
  e.writeUInt32LE(eocd.cdOffset ?? offset, 16);
  e.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, cd, e, comment]);
}

const basic = (extra = []) => [
  { name: 'pet.json', data: petJson({ agentOffice: { sleepSheetPath: 'sleep.webp' } }) },
  { name: 'spritesheet.webp', data: SHEET },
  { name: 'sleep.webp', data: SLEEP },
  ...extra,
];
const tmp = (prefix = 'ao-pi-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const write = (dir, rel, data) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), data); };

// ───────────────────────── imageSize ─────────────────────────

test('imageSize: png 1x1 · 시트 크기 · webp VP8/VP8L/VP8X', () => {
  assert.deepEqual(imageSize(png(1, 1)), { width: 1, height: 1 });
  assert.deepEqual(imageSize(png(1536, 1872)), { width: 1536, height: 1872 });
  assert.deepEqual(imageSize(webp('VP8 ', 1536, 1872)), { width: 1536, height: 1872 });
  assert.deepEqual(imageSize(webp('VP8L', 1536, 1872)), { width: 1536, height: 1872 });
  assert.deepEqual(imageSize(webp('VP8X', 1536, 1872)), { width: 1536, height: 1872 });
  assert.deepEqual(imageSize(webp('VP8L', 1, 1)), { width: 1, height: 1 });
  assert.deepEqual(imageSize(webp('VP8L', 16384, 16384)), { width: 16384, height: 16384 });
});

test('imageSize: 알 수 없거나 짧은 입력은 null', () => {
  for (const bad of [null, undefined, 'x', Buffer.alloc(0), Buffer.alloc(10), Buffer.alloc(40), Buffer.from('GIF89a'.padEnd(40, ' ')), PNG_SIG, png(1, 1).subarray(0, 23)]) {
    assert.equal(imageSize(bad), null, String(bad));
  }
  const noIhdr = png(5, 5);
  noIhdr.write('IDAT', 12, 'latin1');
  assert.equal(imageSize(noIhdr), null);
  const badStart = webp('VP8 ', 10, 10);
  badStart[24] = 0;
  assert.equal(imageSize(badStart), null, 'VP8 프레임 시작 코드가 틀림');
  const badL = webp('VP8L', 10, 10);
  badL[20] = 0;
  assert.equal(imageSize(badL), null, 'VP8L 서명이 틀림');
  const other = webp('VP8X', 10, 10);
  other.write('ALPH', 12, 'latin1');
  assert.equal(imageSize(other), null, '알 수 없는 첫 청크');
});

// ───────────────────────── zip 읽기: 정상 ─────────────────────────

test('importZip: 루트에 pet.json + 시트 + 자는 줄, README 는 무시', () => {
  const r = importZip(makeZip(basic([{ name: 'README.md', data: '# hi' }, { name: 'preview.gif', data: 'GIF89a' }])), 'ignored-name');
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.id, 'cool-pet'); // pet.json id 를 slug 로
  assert.equal(r.displayName, 'Cool');
  assert.equal(r.description, 'a pet');
  assert.equal(r.sheet.ext, 'webp');
  assert.ok(r.sheet.bytes.equals(SHEET));
  assert.ok(r.sleep.bytes.equals(SLEEP));
});

test('importZip: 폴더 하나로 감싼 zip + 디렉터리 항목', () => {
  const zip = makeZip([
    { name: 'pet/', data: '', method: 0 },
    { name: 'pet/pet.json', data: petJson() },
    { name: 'pet/spritesheet.webp', data: SHEET },
  ]);
  const r = importZip(zip, 'x');
  assert.equal(r.error, undefined, r.error);
  assert.ok(r.sheet.bytes.equals(SHEET));
  assert.equal(r.sleep, undefined);
  const list = readZipEntries(zip);
  assert.deepEqual(list.entries.map((e) => e.name), ['pet/pet.json', 'pet/spritesheet.webp'], '디렉터리 항목은 목록에서 빠진다');
});

test('importZip: __MACOSX · ._ · .DS_Store · Thumbs.db 는 무시 (깨진 내용이어도 풀지 않는다)', () => {
  const zip = makeZip(basic([
    { name: '__MACOSX/', data: '', method: 0 },
    { name: '__MACOSX/._pet.json', data: 'junk' },
    { name: '._spritesheet.webp', data: 'junk' },
    { name: '.DS_Store', data: 'junk' },
    { name: 'Thumbs.db', data: 'junk', crc: 1 },
  ]));
  const list = readZipEntries(zip);
  assert.deepEqual(list.entries.map((e) => e.name), ['pet.json', 'spritesheet.webp', 'sleep.webp']);
  assert.equal(importZip(zip, 'x').error, undefined);
});

test('importZip: 역슬래시 이름 · 로컬 extra 길이가 중앙과 다름 · 데이터 디스크립터 · 저장(method 0)', () => {
  const r1 = importZip(makeZip([
    { name: 'pet\\pet.json', data: petJson() },
    { name: 'pet\\spritesheet.webp', data: SHEET },
  ]), 'x');
  assert.equal(r1.error, undefined, r1.error);
  const r2 = importZip(makeZip([
    { name: 'pet.json', data: petJson(), localExtra: Buffer.alloc(11, 1), centralExtra: Buffer.alloc(2, 2) },
    { name: 'spritesheet.webp', data: SHEET, localExtra: Buffer.alloc(0), centralExtra: Buffer.alloc(9, 3) },
  ]), 'x');
  assert.equal(r2.error, undefined, r2.error);
  assert.ok(r2.sheet.bytes.equals(SHEET));
  const r3 = importZip(makeZip([
    { name: 'pet.json', data: petJson(), flags: 0x808, descriptor: true },
    { name: 'spritesheet.webp', data: SHEET, flags: 0x808, descriptor: true },
  ]), 'x');
  assert.equal(r3.error, undefined, r3.error);
  assert.ok(r3.sheet.bytes.equals(SHEET));
  const r4 = importZip(makeZip([
    { name: 'pet.json', data: petJson(), method: 0 },
    { name: 'spritesheet.webp', data: SHEET, method: 0 },
  ]), 'x');
  assert.equal(r4.error, undefined, r4.error);
  assert.ok(r4.sheet.bytes.equals(SHEET));
});

test('importZip: pet.json 이름 대소문자 · spritesheetPath 의 ./ 와 대소문자 · BOM · png 시트', () => {
  const r1 = importZip(makeZip([
    { name: 'PET.JSON', data: petJson({ spritesheetPath: './SpriteSheet.WEBP' }) },
    { name: 'spritesheet.webp', data: SHEET },
  ]), 'x');
  assert.equal(r1.error, undefined, r1.error);
  const r2 = importZip(makeZip([
    { name: 'pet.json', data: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(petJson({ spritesheetPath: '.\\sheet.png' }))]) },
    { name: 'sheet.png', data: png(1536, 1872, 'p') },
  ]), 'x');
  assert.equal(r2.error, undefined, r2.error);
  assert.equal(r2.sheet.ext, 'png');
});

test('importZip: 내용으로 정한 형식을 확장자로 쓴다 (이름은 .webp 인데 png 내용)', () => {
  const r = importZip(makeZip([
    { name: 'pet.json', data: petJson() },
    { name: 'spritesheet.webp', data: png(1536, 1872) },
  ]), 'x');
  assert.equal(r.sheet.ext, 'png');
});

test('importZip: pet.json 이 없으면 1536x1872 그림이 정확히 하나일 때만 · id 는 가져온 파일 이름에서', () => {
  const ok = importZip(makeZip([{ name: 'cover.png', data: png(100, 100) }, { name: 'My Pet!!.webp', data: SHEET }, { name: 'README.txt', data: 'x' }]), 'Fancy Pet (1)');
  assert.equal(ok.error, undefined, ok.error);
  assert.equal(ok.id, 'fancy-pet-1');
  assert.equal(ok.displayName, 'fancy-pet-1');
  const two = importZip(makeZip([{ name: 'a.webp', data: SHEET }, { name: 'b.png', data: png(1536, 1872) }]), 'x');
  assert.equal(two.error, ERR.ambiguous);
  const none = importZip(makeZip([{ name: 'a.png', data: png(10, 10) }]), 'x');
  assert.equal(none.error, ERR.badSize);
  assert.equal(importZip(makeZip([{ name: 'README.md', data: 'x' }]), 'x').error, ERR.noSheet);
  const many = importZip(makeZip(Array.from({ length: 5 }, (_, i) => ({ name: `a${i}.png`, data: png(1536, 1872, String(i)) }))), 'x');
  assert.equal(many.error, ERR.ambiguous, '후보가 너무 많으면 거부');
  // 크기 오류가 아닌 문제 (CRC·손상) 는 건너뛰지 않고 그 문구로 거부
  const corrupt = importZip(makeZip([{ name: 'a.png', data: png(100, 100) }, { name: 'b.webp', data: SHEET, crc: 1 }]), 'x');
  assert.equal(corrupt.error, ERR.broken);
  const bigOther = preparePet({ files: mapOf({ 'a.png': Buffer.alloc(8 * 1024 * 1024 + 1), 'b.webp': SHEET }), sourceName: 'x' });
  assert.equal(bigOther.error, ERR.bigFile);
});

// ───────────────────────── zip 읽기: 거부 ─────────────────────────

test('zip 이름 검사: ../ · 절대 경로 · 드라이브 · ":" · 제어문자 · 빈 조각 · 중복', () => {
  const bad = (name) => makeZip([{ name, data: 'x' }, ...basic()]);
  for (const name of ['../evil.txt', 'a/../../evil.txt', '/abs.txt', '\\abs.txt', 'C:/x.txt', 'C:\\x.txt', 'a:b.txt', 'ok/..', 'a//b.txt', './x.txt', 'a\u0001b.txt', 'a\u0085b']) {
    assert.deepEqual(Object.keys(readZipEntries(bad(name))), ['error'], JSON.stringify(name));
    assert.equal(readZipEntries(bad(name)).error, ERR.badName, JSON.stringify(name));
  }
  assert.equal(readZipEntries(makeZip([{ name: 'a.txt', data: '1' }, { name: 'A.TXT', data: '2' }])).error, ERR.badName, '대소문자만 다른 중복');
  assert.equal(readZipEntries(makeZip([{ name: 'a.txt', data: '1' }, { name: 'a.txt', data: '2' }])).error, ERR.badName);
  assert.equal(readZipEntries(makeZip([{ name: 'dir/', data: '', method: 0 }, { name: 'dir', data: '2' }])).error, ERR.badName, '디렉터리와 같은 이름');
  assert.equal(readZipEntries(makeZip([{ name: 'x'.repeat(257), data: '1' }])).error, ERR.badName, '이름 길이 256 초과');
  assert.equal(readZipEntries(makeZip([{ name: 'x'.repeat(256), data: '1' }])).error, undefined);
  // 무시 대상이어도 이름이 위험하면 거부한다
  assert.equal(readZipEntries(makeZip([{ name: '__MACOSX/../x', data: '1' }])).error, ERR.badName);
});

test('zip 거부: 암호화 · 지원하지 않는 방식 · ZIP64 값', () => {
  assert.equal(importZip(makeZip(basic().map((x) => ({ ...x, flags: 0x801 }))), 'x').error, ERR.zipUnsupported, '암호화 비트 0');
  assert.equal(importZip(makeZip(basic().map((x) => ({ ...x, flags: 0x840 }))), 'x').error, ERR.zipUnsupported, '비트 6');
  assert.equal(importZip(makeZip(basic().map((x) => ({ ...x, flags: 0x2800 }))), 'x').error, ERR.zipUnsupported, '비트 13');
  assert.equal(readZipEntries(makeZip([{ name: 'a', data: 'x', method: 12, comp: Buffer.from('x') }])).error, ERR.zipUnsupported);
  assert.equal(readZipEntries(makeZip(basic(), { eocd: { total: 0xffff, onDisk: 0xffff } })).error, ERR.zipUnsupported, '항목 수 0xFFFF');
  assert.equal(readZipEntries(makeZip(basic(), { eocd: { cdOffset: 0xffffffff } })).error, ERR.zipUnsupported, '중앙 디렉터리 위치 0xFFFFFFFF');
  assert.equal(readZipEntries(makeZip([{ name: 'a', data: 'x', csize: 0xffffffff }])).error, ERR.zipUnsupported, '압축 크기 0xFFFFFFFF');
  assert.equal(readZipEntries(makeZip([{ name: 'a', data: 'x', usize: 0xffffffff }])).error, ERR.zipUnsupported, '원본 크기 0xFFFFFFFF');
  assert.equal(readZipEntries(makeZip([{ name: 'a', data: 'x', localOffset: 0xffffffff }])).error, ERR.zipUnsupported, '로컬 위치 0xFFFFFFFF');
});

test('zip 거부: 구조가 어긋난 EOCD · 디스크 · 중앙 디렉터리 범위 · 겹친 데이터', () => {
  const good = makeZip(basic());
  assert.equal(readZipEntries(good).error, undefined);
  assert.equal(readZipEntries(Buffer.alloc(0)).error, ERR.zipBad);
  assert.equal(readZipEntries(Buffer.from('not a zip file at all, really not')).error, ERR.zipBad);
  assert.equal(readZipEntries('x').error, ERR.zipBad);
  assert.equal(readZipEntries(good.subarray(0, good.length - 1)).error, ERR.zipBad, '잘린 파일');
  assert.equal(readZipEntries(makeZip(basic(), { eocd: { disk: 1 } })).error, ERR.zipBad, '디스크 번호');
  assert.equal(readZipEntries(makeZip(basic(), { eocd: { onDisk: 2 } })).error, ERR.zipBad, '이 디스크 항목 수 ≠ 전체');
  assert.equal(readZipEntries(makeZip(basic(), { eocd: { cdOffset: 10000 } })).error, ERR.zipBad, '중앙 디렉터리가 EOCD 뒤');
  assert.equal(readZipEntries(makeZip(basic(), { eocd: { total: 2 } })).error, ERR.zipBad, '항목 수가 실제와 다름 (남는 바이트)');
  assert.equal(readZipEntries(makeZip(basic(), { eocd: { total: 5 } })).error, ERR.zipBad, '항목 수가 실제보다 많음');
  assert.equal(readZipEntries(makeZip([{ name: 'a', data: 'x' }, { name: 'b', data: 'y', localOffset: 0 }])).error, ERR.zipBad, '데이터 범위가 겹침');
  assert.equal(readZipEntries(makeZip([{ name: 'a', data: 'x', method: 0, comp: Buffer.from('xx'), usize: 1 }])).error, ERR.zipBad, '저장 방식인데 크기가 다름');
  assert.equal(readZipEntries(makeZip([{ name: 'a', data: 'x', csize: 99999 }])).error, ERR.zipBad, '데이터가 중앙 디렉터리 시작을 넘음');
});

test('zip 거부: 로컬 이름·extra 길이를 더하면 데이터가 다음 로컬 헤더 위로 겹침', () => {
  const items = [{ name: 'a.bin', data: 'x'.repeat(50), method: 0 }, { name: 'b.bin', data: 'y'.repeat(50), method: 0 }];
  const good = makeZip(items);
  assert.equal(readZipEntries(good).error, undefined);
  // 첫 항목의 로컬 이름 길이를 60B 로 고쳐 (중앙 디렉터리는 그대로) 데이터가 두 번째 로컬 헤더를 덮게 한다
  const nameOverlap = Buffer.from(good);
  nameOverlap.writeUInt16LE(60, 26);
  assert.equal(readZipEntries(nameOverlap).error, ERR.zipBad, '로컬 이름 길이');
  const extraOverlap = Buffer.from(good);
  extraOverlap.writeUInt16LE(60, 28);
  assert.equal(readZipEntries(extraOverlap).error, ERR.zipBad, '로컬 extra 길이');
  // 로컬 길이가 중앙 디렉터리 시작을 넘는 경우
  const past = Buffer.from(good);
  past.writeUInt16LE(60000, 28);
  assert.equal(readZipEntries(past).error, ERR.zipBad);
  // 로컬 서명이 틀리면 읽는 단계에서 거부
  const noSig = Buffer.from(good);
  noSig.writeUInt32LE(0x12345678, 0);
  assert.equal(readZipEntries(noSig).error, ERR.zipBad);
});

test('zip 거부: 항목 65개 (64개까지 허용) · 32MB 초과', () => {
  const many = (n) => makeZip(Array.from({ length: n }, (_, i) => ({ name: `f${i}.txt`, data: String(i), method: 0 })));
  assert.equal(readZipEntries(many(64)).entries.length, 64);
  assert.equal(readZipEntries(many(65)).error, ERR.zipMany);
  assert.equal(readZipEntries(Buffer.alloc(32 * 1024 * 1024 + 1)).error, ERR.zipBig);
  // 무시 대상·디렉터리도 항목 수 상한에 든다
  const ignored = makeZip(Array.from({ length: 65 }, (_, i) => ({ name: `__MACOSX/f${i}`, data: '' })));
  assert.equal(readZipEntries(ignored).error, ERR.zipMany);
});

test('zip 거부: 선언 크기 불일치 · CRC 불일치 · 깨진 압축 · 로컬 헤더 이상', () => {
  const hdr = (over) => importZip(makeZip([{ name: 'pet.json', data: petJson() }, { name: 'spritesheet.webp', data: SHEET, ...over }]), 'x');
  assert.equal(hdr({ usize: SHEET.length + 1 }).error, ERR.broken, '선언이 실제보다 큼');
  assert.equal(hdr({ usize: SHEET.length - 1 }).error, ERR.broken, '선언이 실제보다 작음 (압축 해제 상한)');
  assert.equal(hdr({ crc: 12345 }).error, ERR.broken, 'CRC');
  assert.equal(hdr({ comp: Buffer.from('this is not deflate data'), csize: 24 }).error, ERR.broken, '깨진 압축');
  assert.equal(hdr({ method: 0, comp: SHEET.subarray(0, 10), usize: 10 }).error, ERR.broken, '저장 방식 CRC');
  // 로컬 헤더 서명이 틀리면 거부
  const zip = makeZip(basic());
  const entry = readZipEntries(zip).entries[0];
  const broken = Buffer.from(zip);
  broken.writeUInt32LE(0x12345678, entry.localOffset);
  assert.throws(() => extractEntry(broken, entry, 1024), { message: ERR.broken });
  assert.throws(() => extractEntry(zip, { ...entry, usize: 99999 }, 1024), { message: ERR.bigFile }, 'maxBytes 초과');
  assert.throws(() => extractEntry(zip, { ...entry, localOffset: zip.length }, 1024), { message: ERR.broken });
  assert.throws(() => extractEntry(zip, { ...entry, dataLimit: entry.localOffset + 31 }, 1024), { message: ERR.broken }, '데이터가 중앙 디렉터리를 넘음');
  assert.ok(extractEntry(zip, entry, 1024 * 1024).length > 0);
});

test('zip 거부: 최상위 폴더 두 겹 · 루트와 폴더가 섞임 · 폴더가 서로 다름', () => {
  const t = (items) => importZip(makeZip(items), 'x').error;
  assert.equal(t([{ name: 'a/b/pet.json', data: petJson() }, { name: 'a/b/spritesheet.webp', data: SHEET }]), ERR.layout);
  assert.equal(t([{ name: 'a/pet.json', data: petJson() }, { name: 'spritesheet.webp', data: SHEET }]), ERR.layout);
  assert.equal(t([{ name: 'a/pet.json', data: petJson() }, { name: 'b/spritesheet.webp', data: SHEET }]), ERR.layout);
});

test('zip 거부: EOCD 주석 속 가짜 서명', () => {
  // 가짜 서명이 주석 한가운데 있으면 「위치 + 22 + 주석 길이 = 파일 길이」 가 맞지 않아 건너뛰고 진짜 EOCD 를 쓴다
  const fake = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18), Buffer.from('padding after the fake signature....')]);
  assert.equal(importZip(makeZip(basic(), { comment: fake }), 'x').error, undefined);
  // 파일 끝 22바이트가 그럴듯한 가짜 EOCD (항목 0개) 이면 그것을 EOCD 로 보게 되고, 항목이 없으므로 거부
  const tail = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
  assert.equal(readZipEntries(makeZip(basic(), { comment: tail })).error, ERR.zipBad);
});

// ───────────────────────── preparePet ─────────────────────────

const mapOf = (obj) => new Map(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), () => v]));

test('preparePet: 시트 크기 오류 · 크기 상한 · 잠자기 그림은 어긋나면 버림', () => {
  const json = Buffer.from(petJson({ agentOffice: { sleepSheetPath: 'sleep.webp' } }));
  assert.equal(preparePet({ files: mapOf({ 'pet.json': json, 'spritesheet.webp': webp('VP8X', 1536, 1871) }), sourceName: 'x' }).error, ERR.badSize);
  assert.equal(preparePet({ files: mapOf({ 'pet.json': json, 'spritesheet.webp': Buffer.from('not an image') }), sourceName: 'x' }).error, ERR.badSize);
  assert.equal(preparePet({ files: mapOf({ 'pet.json': json, 'spritesheet.webp': Buffer.alloc(8 * 1024 * 1024 + 1) }), sourceName: 'x' }).error, ERR.bigFile);
  assert.equal(preparePet({ files: mapOf({ 'pet.json': json }), sourceName: 'x' }).error, ERR.noSheet, '시트 파일이 없음');
  const badSleep = preparePet({ files: mapOf({ 'pet.json': json, 'spritesheet.webp': SHEET, 'sleep.webp': webp('VP8X', 1536, 200) }), sourceName: 'x' });
  assert.equal(badSleep.error, undefined);
  assert.equal(badSleep.sleep, undefined, '크기가 다른 잠자기 그림은 오류 없이 버린다');
  const missingSleep = preparePet({ files: mapOf({ 'pet.json': json, 'spritesheet.webp': SHEET }), sourceName: 'x' });
  assert.equal(missingSleep.error, undefined);
  assert.equal(missingSleep.sleep, undefined);
  const big = preparePet({ files: mapOf({ 'pet.json': json, 'spritesheet.webp': SHEET, 'sleep.webp': Buffer.alloc(9 * 1024 * 1024) }), sourceName: 'x' });
  assert.equal(big.sleep, undefined);
  // 정확히 8MB 시트는 허용 (크기만 맞으면)
  const exact = Buffer.concat([SHEET, Buffer.alloc(8 * 1024 * 1024 - SHEET.length)]);
  assert.equal(preparePet({ files: mapOf({ 'pet.json': json, 'spritesheet.webp': exact }), sourceName: 'x' }).error, undefined);
});

test('preparePet: pet.json 오류 (JSON · 형식 · 크기 · 경로)', () => {
  const run = (json, extra = {}) => preparePet({ files: mapOf({ 'pet.json': Buffer.from(json), 'spritesheet.webp': SHEET, ...extra }), sourceName: 'x' }).error;
  assert.equal(run('{ nope'), ERR.badJson);
  assert.equal(run('[]'), ERR.badJson);
  assert.equal(run('null'), ERR.badJson);
  assert.equal(run('{}'), ERR.noSheet, 'spritesheetPath 없음');
  assert.equal(run(JSON.stringify({ spritesheetPath: 5 })), ERR.noSheet);
  assert.equal(run(JSON.stringify({ spritesheetPath: '../spritesheet.webp' })), ERR.noSheet);
  assert.equal(run(JSON.stringify({ spritesheetPath: '/spritesheet.webp' })), ERR.noSheet);
  assert.equal(run(JSON.stringify({ spritesheetPath: 'C:/spritesheet.webp' })), ERR.noSheet);
  assert.equal(run(JSON.stringify({ spritesheetPath: 'spritesheet.gif' }), { 'spritesheet.gif': SHEET }), ERR.noSheet, '확장자 png/webp 만');
  assert.equal(run(JSON.stringify({ spritesheetPath: 'spritesheet.webp', pad: 'x'.repeat(70 * 1024) })), ERR.badJson, 'pet.json 64KB 초과');
  assert.equal(run(JSON.stringify({ spritesheetPath: 'spritesheet.webp' })), undefined);
});

test('preparePet: id slug · 예약 이름 · 표시 이름 정리', () => {
  const idOf = (meta, sourceName) => preparePet({ files: mapOf({ 'pet.json': Buffer.from(JSON.stringify({ spritesheetPath: 's.webp', ...meta })), 's.webp': SHEET }), sourceName }).id;
  assert.equal(idOf({ id: '  Cool__Pet!! v2  ' }, 'x'), 'cool__pet-v2');
  assert.equal(idOf({ id: '한글만' }, 'x'), 'pet', '글자가 모두 사라지면 pet');
  assert.equal(idOf({}, 'My.Pet-Final'), 'my-pet-final');
  assert.equal(idOf({ id: 5 }, 'fallback'), 'fallback');
  assert.equal(idOf({ id: '--a--b--' }, 'x'), 'a-b');
  assert.equal(idOf({ id: '_hidden' }, 'x'), 'hidden', '첫 글자는 영숫자');
  assert.equal(idOf({ id: 'a'.repeat(80) }, 'x'), 'a'.repeat(64));
  assert.equal(idOf({ id: `${'a'.repeat(63)}_b` }, 'x'), 'a'.repeat(63), '자른 끝의 _·- 는 뗀다');
  assert.equal(idOf({ id: `${'a'.repeat(62)}-_b` }, 'x'), 'a'.repeat(62));
  for (const reserved of ['con', 'PRN', 'aux', 'nul', 'com1', 'LPT9']) assert.equal(idOf({ id: reserved }, 'x'), `pet-${reserved.toLowerCase()}`, reserved);
  assert.equal(idOf({ id: 'com10' }, 'x'), 'com10');
  assert.equal(idOf({}, undefined), 'pet');
  const named = preparePet({ files: mapOf({ 'pet.json': Buffer.from(JSON.stringify({ spritesheetPath: 's.webp', displayName: `A\u202Eb\u0007${'c'.repeat(60)}`, description: `x\n${'d'.repeat(200)}` })), 's.webp': SHEET }), sourceName: 'x' });
  assert.equal(named.displayName, `Ab${'c'.repeat(38)}`, '제어·양방향 문자 제거 뒤 40자');
  assert.equal(named.description.length, 120);
  assert.ok(!named.description.includes('\n'));
});

// ───────────────────────── 그림 버전 2 (1536x2288, 11줄) ─────────────────────────

const SHEET2 = webp('VP8X', 1536, 2288, 'sheet2');
const PNG2 = png(1536, 2288, 'p2');

test('importZip: 버전 2 시트 (webp·png) 를 가져오고 선언이 없으면 그림 버전을 쓴다', () => {
  const w = importZip(makeZip([{ name: 'pet.json', data: petJson({ spriteVersionNumber: 2 }) }, { name: 'spritesheet.webp', data: SHEET2 }]), 'x');
  assert.equal(w.error, undefined, w.error);
  assert.equal(w.version, 2);
  assert.ok(w.sheet.bytes.equals(SHEET2));
  const p = importZip(makeZip([{ name: 'pet.json', data: petJson({ spritesheetPath: 'sheet.png' }) }, { name: 'sheet.png', data: PNG2 }]), 'x');
  assert.equal(p.error, undefined, p.error);
  assert.equal(p.version, 2, '선언이 없으면 그림 높이가 정한 버전');
  assert.equal(p.sheet.ext, 'png');
  assert.equal(importZip(makeZip(basic()), 'x').version, 1, '버전 1 시트는 그대로');
  const declared1 = importZip(makeZip([{ name: 'pet.json', data: petJson({ spriteVersionNumber: 1 }) }, { name: 'spritesheet.webp', data: SHEET }]), 'x');
  assert.equal(declared1.version, 1);
  const nul = importZip(makeZip([{ name: 'pet.json', data: petJson({ spriteVersionNumber: null }) }, { name: 'spritesheet.webp', data: SHEET2 }]), 'x');
  assert.equal(nul.version, 2, 'null 은 선언 없음');
});

test('importZip: 그림 버전 선언이 실제 크기와 다르거나 1·2 가 아니면 거부, 허용 밖 크기는 badSize', () => {
  const run = (extra, sheet) => importZip(makeZip([{ name: 'pet.json', data: petJson(extra) }, { name: 'spritesheet.webp', data: sheet }]), 'x').error;
  assert.equal(run({ spriteVersionNumber: 1 }, SHEET2), ERR.badVersion, '선언 1 인데 그림은 v2');
  assert.equal(run({ spriteVersionNumber: 2 }, SHEET), ERR.badVersion, '선언 2 인데 그림은 v1');
  assert.equal(run({ spriteVersionNumber: 3 }, SHEET2), ERR.badVersion);
  assert.equal(run({ spriteVersionNumber: 0 }, SHEET), ERR.badVersion);
  assert.equal(run({ spriteVersionNumber: '2' }, SHEET2), ERR.badVersion, '문자열은 거부');
  assert.equal(run({ spriteVersionNumber: true }, SHEET), ERR.badVersion);
  assert.equal(run({ spriteVersionNumber: [2] }, SHEET2), ERR.badVersion);
  assert.equal(run({}, webp('VP8X', 1536, 2287)), ERR.badSize, '1536x2287');
  assert.equal(run({}, webp('VP8X', 1536, 2289)), ERR.badSize);
  assert.equal(run({}, webp('VP8X', 1535, 2288)), ERR.badSize);
  assert.match(ERR.badSize, /1872.*2288/);
});

test('importZip: pet.json 없이 v2 그림 하나 → 성공, v1·v2 가 함께 있으면 모호', () => {
  const ok = importZip(makeZip([{ name: 'cover.png', data: png(100, 100) }, { name: 'Wide.webp', data: SHEET2 }]), 'My Pet');
  assert.equal(ok.error, undefined, ok.error);
  assert.equal(ok.version, 2);
  assert.equal(ok.id, 'my-pet');
  assert.equal(importZip(makeZip([{ name: 'a.webp', data: SHEET }, { name: 'b.webp', data: SHEET2 }]), 'x').error, ERR.ambiguous);
  assert.equal(importZip(makeZip([{ name: 'a.png', data: png(1536, 2287) }]), 'x').error, ERR.badSize);
});

test('installPet: v2 는 pet.json 에 spriteVersionNumber 2 를 쓰고 readPet 로 다시 읽힌다', async () => {
  const { readPet } = require('../src/main/petRules.cjs');
  const petsDir = path.join(tmp(), 'pets');
  const prepared = importZip(makeZip([{ name: 'pet.json', data: petJson({ spriteVersionNumber: 2 }) }, { name: 'spritesheet.webp', data: SHEET2 }, { name: 'sleep.webp', data: SLEEP }]), 'zipname');
  const { id } = await installPet(prepared, petsDir);
  const meta = JSON.parse(fs.readFileSync(path.join(petsDir, id, 'pet.json'), 'utf8'));
  assert.equal(meta.spriteVersionNumber, 2);
  const pet = readPet(petsDir, id);
  assert.equal(pet.spriteVersionNumber, 2);
  assert.ok(pet.bytes.equals(SHEET2));
  // 원래 pet.json 의 선언 없이 v2 그림만 있어도 재생성한 pet.json 에는 버전이 들어간다
  const bare = importZip(makeZip([{ name: 'only.png', data: PNG2 }]), 'bare');
  const done = await installPet(bare, petsDir);
  assert.equal(JSON.parse(fs.readFileSync(path.join(petsDir, done.id, 'pet.json'), 'utf8')).spriteVersionNumber, 2);
  // 준비 결과의 버전이 그림과 어긋난 채로 오면(재확인 때 읽은 값과 다르면) 설치를 거부한다
  const mismatch = await installPet({ ...prepared, version: 1 }, petsDir, { ...fs, writeFileSync(p, d, o) { return fs.writeFileSync(p, String(p).endsWith('pet.json') ? String(d).replace('"spriteVersionNumber": 1', '"spriteVersionNumber": 2') : d, o); } });
  assert.equal(mismatch.error, ERR.install);
});

test('spriteVersion 규칙 표: 없음/null → 그림 버전, 1·2 → 같아야 함, 그 밖 → null', () => {
  const { spriteVersion, sheetVersionOf } = require('../src/main/petRules.cjs');
  for (const v of [1, 2]) {
    assert.equal(spriteVersion(undefined, v), v);
    assert.equal(spriteVersion(null, v), v);
    assert.equal(spriteVersion(v, v), v);
    assert.equal(spriteVersion(v === 1 ? 2 : 1, v), null);
    for (const bad of [0, 3, '1', '2', true, NaN, [], {}, 1.5]) assert.equal(spriteVersion(bad, v), null, String(bad));
  }
  assert.equal(spriteVersion(1, null), null, '그림 버전을 모르면 거부');
  assert.equal(spriteVersion(undefined, 3), null);
  assert.equal(sheetVersionOf({ width: 1536, height: 1872 }), 1);
  assert.equal(sheetVersionOf({ width: 1536, height: 2288 }), 2);
  for (const bad of [null, undefined, { width: 1536, height: 2287 }, { width: 1535, height: 1872 }, { width: 1872, height: 1536 }]) assert.equal(sheetVersionOf(bad), null);
});

// ───────────────────────── installPet · removePet · importFolder ─────────────────────────

test('installPet: 고정 이름 · pet.json 새로 생성 · 충돌 -2/-3 · 임시 폴더 정리', async () => {
  const petsDir = path.join(tmp(), 'pets');
  const prepared = (id = 'mine') => ({ id, displayName: 'Mine', description: 'desc', version: 1, sheet: { bytes: SHEET, ext: 'webp' }, sleep: { bytes: SLEEP, ext: 'webp' }, evil: { x: 1 } });
  fs.mkdirSync(path.join(petsDir, '.tmp-old', 'junk'), { recursive: true }); // 이전에 중단된 설치
  const r = await installPet(prepared(), petsDir);
  assert.deepEqual(r, { id: 'mine' });
  assert.deepEqual(fs.readdirSync(petsDir).sort(), ['mine'], '임시 폴더가 남지 않는다');
  assert.deepEqual(fs.readdirSync(path.join(petsDir, 'mine')).sort(), ['pet.json', 'sleep.webp', 'spritesheet.webp']);
  const meta = JSON.parse(fs.readFileSync(path.join(petsDir, 'mine', 'pet.json'), 'utf8'));
  assert.deepEqual(meta, { id: 'mine', displayName: 'Mine', description: 'desc', spritesheetPath: 'spritesheet.webp', spriteVersionNumber: 1, agentOffice: { sleepSheetPath: 'sleep.webp' } });
  assert.ok(fs.readFileSync(path.join(petsDir, 'mine', 'spritesheet.webp')).equals(SHEET));
  assert.deepEqual(await installPet(prepared(), petsDir), { id: 'mine-2' });
  assert.deepEqual(await installPet(prepared(), petsDir), { id: 'mine-3' });
  assert.deepEqual(await installPet(prepared('MINE'.toLowerCase()), petsDir), { id: 'mine-4' });
  const meta2 = JSON.parse(fs.readFileSync(path.join(petsDir, 'mine-2', 'pet.json'), 'utf8'));
  assert.equal(meta2.id, 'mine-2', 'pet.json id 도 최종 id');
  // 64자 id 충돌: 앞부분을 잘라 64자 안에 맞춘다
  const long = 'a'.repeat(64);
  assert.deepEqual(await installPet(prepared(long), petsDir), { id: long });
  assert.deepEqual(await installPet(prepared(long), petsDir), { id: `${'a'.repeat(62)}-2` });
  // 자른 끝이 -·_ 면 떼고 접미어를 붙인다 (62자째까지 자르면 '-'·'__' 로 끝나는 id)
  const dashed = `${'b'.repeat(61)}-cc`;
  assert.deepEqual(await installPet(prepared(dashed), petsDir), { id: dashed });
  assert.deepEqual(await installPet(prepared(dashed), petsDir), { id: `${'b'.repeat(61)}-2` });
  const under = `${'u'.repeat(60)}__cc`;
  assert.deepEqual(await installPet(prepared(under), petsDir), { id: under });
  assert.deepEqual(await installPet(prepared(under), petsDir), { id: `${'u'.repeat(60)}-2` });
  // 잠자기 그림이 없으면 agentOffice 도 없다
  const noSleep = await installPet({ ...prepared('nosleep'), sleep: undefined, sheet: { bytes: png(1536, 1872), ext: 'png' } }, petsDir);
  assert.deepEqual(noSleep, { id: 'nosleep' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(petsDir, 'nosleep', 'pet.json'), 'utf8')), { id: 'nosleep', displayName: 'Mine', description: 'desc', spritesheetPath: 'spritesheet.png', spriteVersionNumber: 1 });
});

test('installPet: 예약 이름은 preparePet 에서 pet- 접두 · 잘못된 입력 거부', async () => {
  const petsDir = path.join(tmp(), 'pets');
  const p = preparePet({ files: mapOf({ 's.webp': SHEET }), sourceName: 'CON' });
  assert.equal(p.id, 'pet-con');
  assert.deepEqual(await installPet(p, petsDir), { id: 'pet-con' });
  const okSheet = { bytes: SHEET, ext: 'webp' };
  for (const bad of [null, { error: 'x' }, { id: '../x', version: 1, sheet: okSheet }, { id: 'ok', version: 1, sheet: { bytes: SHEET, ext: 'exe' } }, { id: 'ok', version: 1, sheet: { bytes: 'x', ext: 'png' } },
    { id: 'ok', sheet: okSheet }, { id: 'ok', version: 3, sheet: okSheet }, { id: 'ok', version: '2', sheet: okSheet }]) { // 그림 버전이 1·2 가 아니면 설치 거부
    assert.equal((await installPet(bad, petsDir)).error, ERR.install, JSON.stringify(bad));
  }
  assert.deepEqual(fs.readdirSync(petsDir), ['pet-con']);
});

test('installPet: 실패하면 임시 폴더를 지우고 id 폴더를 남기지 않는다 · EPERM/EBUSY 는 재시도', async () => {
  const petsDir = path.join(tmp(), 'pets');
  const prepared = { id: 'mine', displayName: 'Mine', description: '', version: 1, sheet: { bytes: SHEET, ext: 'webp' } };
  const failing = { ...fs, renameSync() { throw Object.assign(new Error('C:\\secret\\path boom'), { code: 'EACCES' }); } };
  const r = await installPet(prepared, petsDir, failing);
  assert.equal(r.error, ERR.install);
  assert.ok(!r.error.includes('secret'), '경로·원문은 error 에 없다');
  assert.match(r.detail, /boom/);
  assert.deepEqual(fs.readdirSync(petsDir), []);
  let calls = 0;
  const flaky = { ...fs, renameSync(...a) { if (++calls <= 2) throw Object.assign(new Error('busy'), { code: calls === 1 ? 'EPERM' : 'EBUSY' }); return fs.renameSync(...a); } };
  assert.deepEqual(await installPet(prepared, petsDir, flaky), { id: 'mine' });
  assert.equal(calls, 3);
  const stuck = { ...fs, renameSync() { calls++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } };
  calls = 0;
  assert.equal((await installPet({ ...prepared, id: 'other' }, petsDir, stuck)).error, ERR.install);
  assert.equal(calls, 4, '처음 + 재시도 3번');
  assert.deepEqual(fs.readdirSync(petsDir), ['mine']);
  // 쓰기 도중 실패해도 정리
  const writeFail = { ...fs, writeFileSync(p, ...rest) { if (String(p).endsWith('pet.json')) throw new Error('disk full'); return fs.writeFileSync(p, ...rest); } };
  assert.equal((await installPet({ ...prepared, id: 'w' }, petsDir, writeFail)).error, ERR.install);
  assert.deepEqual(fs.readdirSync(petsDir), ['mine']);
});

test('removePet: 정상 삭제 · id 형식 오류 · 폴더 밖 연결 · 하위 폴더가 있으면 거부', () => {
  const petsDir = tmp();
  write(petsDir, 'good/pet.json', '{}');
  write(petsDir, 'good/spritesheet.webp', 'x');
  write(petsDir, 'nested/pet.json', '{}');
  write(petsDir, 'nested/sub/file.txt', 'x');
  assert.equal(removePet(petsDir, 'good'), true);
  assert.ok(!fs.existsSync(path.join(petsDir, 'good')));
  assert.ok(!fs.readdirSync(petsDir).some((n) => n.startsWith('.tmp-del-')), '옮긴 임시 폴더도 지워진다');
  // 먼저 .tmp-del-* 로 옮기므로, 안을 지우다 실패해도 id 폴더는 이미 없다 (남은 .tmp-* 는 다음 설치 때 정리)
  write(petsDir, 'stuck/pet.json', '{}');
  const rmFail = { ...fs, rmSync() { throw new Error('locked'); } };
  assert.equal(removePet(petsDir, 'stuck', rmFail), true);
  assert.ok(!fs.existsSync(path.join(petsDir, 'stuck')));
  assert.equal(fs.readdirSync(petsDir).filter((n) => n.startsWith('.tmp-del-')).length, 1);
  write(petsDir, 'upper/pet.json', '{}');
  assert.equal(removePet(petsDir, 'Upper'), false, '대문자 id 는 거부');
  assert.ok(fs.existsSync(path.join(petsDir, 'upper', 'pet.json')));
  const moveFail = { ...fs, renameSync() { throw new Error('busy'); } };
  assert.equal(removePet(petsDir, 'upper', moveFail), false, '옮기지 못하면 아무것도 지우지 않는다');
  assert.ok(fs.existsSync(path.join(petsDir, 'upper', 'pet.json')));
  assert.equal(removePet(petsDir, 'good'), false, '이미 없음');
  assert.equal(removePet(petsDir, 'nested'), false);
  assert.ok(fs.existsSync(path.join(petsDir, 'nested', 'sub', 'file.txt')), '하위 폴더가 있으면 아무것도 지우지 않는다');
  assert.ok(fs.existsSync(path.join(petsDir, 'nested', 'pet.json')));
  for (const bad of ['', '..', '../x', 'a/b', 'a\\b', '.hidden', '.tmp-x', null, undefined, 5, 'x'.repeat(65)]) assert.equal(removePet(petsDir, bad), false, String(bad));
  const outside = tmp('ao-outside-');
  write(outside, 'keep.txt', 'x');
  try {
    fs.symlinkSync(outside, path.join(petsDir, 'link'), 'junction');
    assert.equal(removePet(petsDir, 'link'), false, 'petsDir 밖을 가리키는 연결');
    assert.ok(fs.existsSync(path.join(outside, 'keep.txt')));
  } catch (e) { if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e; }
});

test('importFolder: 폴더 안 파일 · 하위 폴더 한 겹 · 크기 상한 · 폴더 밖 연결 제외', () => {
  const flat = tmp();
  write(flat, 'pet.json', petJson());
  write(flat, 'spritesheet.webp', SHEET);
  write(flat, '.DS_Store', 'junk');
  const r = importFolder(flat);
  assert.equal(r.error, undefined, r.error);
  assert.ok(r.sheet.bytes.equals(SHEET));
  assert.equal(r.id, 'cool-pet');

  const wrapped = tmp();
  write(wrapped, 'inner/pet.json', petJson());
  write(wrapped, 'inner/spritesheet.webp', SHEET);
  assert.equal(importFolder(wrapped).error, undefined);

  const deep = tmp();
  write(deep, 'a/b/pet.json', petJson());
  write(deep, 'a/b/spritesheet.webp', SHEET);
  assert.equal(importFolder(deep).error, ERR.noSheet, '두 겹 아래는 보지 않는다');

  const mixed = tmp();
  write(mixed, 'pet.json', petJson());
  write(mixed, 'spritesheet.webp', SHEET);
  write(mixed, 'docs/readme.md', 'x');
  assert.equal(importFolder(mixed).error, undefined, '루트에 pet.json 이 있으면 하위 폴더는 보지 않는다');
  assert.ok(importFolder(mixed).sheet.bytes.equals(SHEET));

  // pet.json 이 없고 루트에 그림과 하위 폴더가 섞이면 여전히 거부
  const mixedNoMeta = tmp();
  write(mixedNoMeta, 'spritesheet.webp', SHEET);
  write(mixedNoMeta, 'docs/readme.md', 'x');
  assert.equal(importFolder(mixedNoMeta).error, ERR.layout);

  // 루트에 pet.json 이 있으면 하위 폴더의 같은 이름 그림·잘못된 파일이 있어도 영향이 없다
  const rootWins = tmp();
  write(rootWins, 'pet.json', petJson());
  write(rootWins, 'spritesheet.webp', SHEET);
  write(rootWins, 'inner/spritesheet.webp', 'broken');
  write(rootWins, 'inner/pet.json', '{ nope');
  const rw = importFolder(rootWins);
  assert.equal(rw.error, undefined, rw.error);
  assert.ok(rw.sheet.bytes.equals(SHEET));

  // 끝에 구분자가 붙은 경로도 그대로 받는다 (루트 비교는 path.relative 로 한다)
  const rootLike = tmp();
  write(rootLike, 'pet.json', petJson());
  write(rootLike, 'spritesheet.webp', SHEET);
  assert.equal(importFolder(`${rootLike}${path.sep}`).error, undefined);

  const big = tmp();
  write(big, 'pet.json', petJson());
  write(big, 'spritesheet.webp', Buffer.concat([SHEET, Buffer.alloc(8 * 1024 * 1024)]));
  assert.equal(importFolder(big).error, ERR.bigFile);

  const missing = importFolder(path.join(flat, 'nope'));
  assert.equal(missing.error, ERR.generic);
  assert.ok(!missing.error.includes(flat), '경로는 error 문구에 넣지 않는다');

  const withLink = tmp();
  write(withLink, 'pet.json', petJson());
  write(withLink, 'spritesheet.webp', SHEET);
  const outside = tmp('ao-outside-');
  write(outside, 'extra.png', png(10, 10));
  try {
    fs.symlinkSync(outside, path.join(withLink, 'sub'), 'junction');
    const linked = importFolder(withLink);
    assert.equal(linked.error, undefined, '폴더 밖을 가리키는 연결은 목록에서 빠진다');
  } catch (e) { if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e; }
});

test('가져온 폴더는 설치 뒤 readPet 로 다시 읽힌다 (zip → install → 같은 바이트)', async () => {
  const { readPet } = require('../src/main/petRules.cjs');
  const petsDir = path.join(tmp(), 'pets');
  const prepared = importZip(makeZip(basic()), 'zipname');
  const { id } = await installPet(prepared, petsDir);
  const pet = readPet(petsDir, id);
  assert.equal(pet.displayName, 'Cool');
  assert.ok(pet.bytes.equals(SHEET));
  assert.ok(pet.sleepBytes.equals(SLEEP));
  assert.equal(pet.type, 'image/webp');
});

test('앱에 넣은 기본 펫은 Codex 펫 형식을 지킨다 (시트 1536x1872 · 잠자기 1536x208)', () => {
  const { readPet } = require('../src/main/petRules.cjs');
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'src', 'renderer', 'assets', 'pets');
  for (const id of ['office-claude', 'office-codex']) {
    const pet = readPet(dir, id);
    assert.ok(pet, id);
    assert.deepEqual(imageSize(pet.bytes), { width: 1536, height: 1872 }, id);
    assert.deepEqual(imageSize(pet.sleepBytes), { width: 1536, height: 208 }, id);
  }
});
