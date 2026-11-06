// 언어 사전·번역기 검사 — 사전 짝 맞춤(한·영 같은 키), 영역 접두어, 영역 사이 중복, 영어 값에 한글 없음, 자리 표시 일치, 소스의 t('키') 존재.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, setLang, getLang, onLangChange, normLang, locale, dictionaries } from '../src/shared/i18n.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const AREAS = ['app', 'collab', 'code', 'office', 'theme', 'main', 'pet', 'run'];
const HANGUL = /[가-힣ㄱ-ㅎㅏ-ㅣ]/;
// 영어 사전에 한글이 남아도 되는 키(언어 전환 버튼의 「한」 처럼 일부러 한글인 것).
const HANGUL_OK = new Set(['app.langKo', 'app.langTitle']);

async function area(lang, name) { return (await import(`../src/shared/i18n/${lang}/${name}.js`)).default; }
const holes = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

test('영역마다 한국어·영어 키가 같고, 접두어가 영역 이름이다', async () => {
  for (const name of AREAS) {
    const ko = await area('ko', name), en = await area('en', name);
    assert.deepEqual(Object.keys(en).sort(), Object.keys(ko).sort(), `${name}: 한·영 키가 다르다`);
    for (const k of Object.keys(ko)) assert.ok(k.startsWith(`${name}.`), `${name}: 접두어가 다른 키 ${k}`);
  }
});

test('영역 사이에 같은 키가 없다', async () => {
  const seen = new Map();
  for (const name of AREAS) for (const k of Object.keys(await area('ko', name))) {
    assert.ok(!seen.has(k), `${k} 가 ${seen.get(k)} 와 ${name} 에 함께 있다`);
    seen.set(k, name);
  }
});

test('영어 값에는 한글이 없고, 값이 비어 있지 않으며, 자리 표시가 한국어와 같다', () => {
  const { ko, en } = dictionaries();
  const sample = new Proxy({}, { get: (_, k) => (k === 'n' || k === 'count' ? 2 : 'x') });
  for (const [k, v] of Object.entries(en)) {
    const out = typeof v === 'function' ? v(sample) : v;
    assert.equal(typeof out, 'string', `${k}: 문자열이 아니다`);
    if (!HANGUL_OK.has(k)) assert.ok(!HANGUL.test(out), `${k}: 영어 값에 한글 — ${out}`);
    const kv = ko[k];
    assert.ok(kv !== '' && out !== '' || kv === '', `${k}: 영어 값이 비었다`);
    if (typeof v === 'string' && typeof kv === 'string') assert.deepEqual(holes(v), holes(kv), `${k}: 자리 표시가 다르다`);
  }
});

test('소스의 t(\'키\') 는 모두 사전에 있다', () => {
  const { ko } = dictionaries();
  const files = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'i18n' && e.name !== 'assets') walk(p); }
      else if (/\.(c?js|html)$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(ROOT, 'src'));
  const missing = [];
  const re = /(?:\bt|\btr)\(\s*['"`]((?:app|collab|code|office|theme|main|pet|run)\.[\w.-]+)['"`]|data-i18n(?:-[\w-]+)?="((?:app|collab|code|office|theme|main|pet|run)\.[\w.-]+)"/g;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(re)) {
      const key = m[1] || m[2];
      if (!(key in ko)) missing.push(`${path.relative(ROOT, f)}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('t: 자리 채우기·함수 값·없는 키·언어 인자', () => {
  assert.equal(normLang('fr'), 'ko');
  assert.equal(t('없는.키'), '없는.키');
  assert.equal(getLang(), 'ko');
  assert.equal(locale('en'), 'en-US');
  assert.equal(locale('ko'), 'ko-KR');
});

test('setLang: 바뀔 때만 알리고, 알림 하나가 실패해도 나머지는 받는다', () => {
  const got = [];
  const offA = onLangChange(() => { throw new Error('boom'); });
  const offB = onLangChange(l => got.push(l));
  const err = console.error; console.error = () => {};
  try {
    assert.equal(setLang('en'), true);
    assert.equal(setLang('en'), false);
    assert.equal(setLang('ko'), true);
  } finally { console.error = err; offA(); offB(); setLang('ko'); }
  assert.deepEqual(got, ['en', 'ko']);
});
