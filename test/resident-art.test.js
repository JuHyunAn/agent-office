import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ROWS } from '../src/renderer/pet/model.js';
const { readPet } = createRequire(import.meta.url)('../src/main/petRules.cjs');

test('새 세 캐릭터는 설치본에 포함되는 기본 펫으로 읽히며 기존 규격과 수면 시트를 갖춘다', () => {
  const dir = new URL('../src/renderer/assets/pets/', import.meta.url);
  for (const kind of ['grok', 'muse', 'antigravity']) {
    const id = 'office-' + kind, pet = readPet(fileURLToPath(dir), id);
    assert.ok(pet, id);
    assert.equal(pet.type, 'image/png');
    for (const [bytes, height] of [[pet.bytes, 1872], [pet.sleepBytes, 208]]) {
      assert.equal(bytes.readUInt32BE(16), 1536, id);
      assert.equal(bytes.readUInt32BE(20), height, id);
      assert.ok(bytes.length < 8 * 1024 * 1024, id);
    }
    assert.ok(fs.existsSync(new URL(id + '/poses.png', dir)));
  }
  assert.equal(Object.values(ROWS).reduce((sum, row) => sum + row.ms.length, 0), 63);
});
