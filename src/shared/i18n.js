// 화면 문구 번역(한국어·영어) — 메인(require)·화면(import)이 함께 쓴다.
// 규칙: 최상위에서 window·document·localStorage 를 건드리지 않는다(메인·node 테스트에서도 읽힌다). 최상위 await·import.meta 금지.
// 사전은 src/shared/i18n/<언어>/<영역>.js — 키는 영역 접두어(app. collab. code. office. theme. main. pet. run.)로 시작한다.
// 한국어 값은 예전 화면 문구와 글자까지 같게 둔다(기본 언어가 한국어라 기존 테스트가 그대로 통과).
// 값은 문자열('{name}' 자리 채우기) 또는 함수(args => 문자열 — 영어 복수형 등).
// 번역하지 않는 것: AI 에게 보내는 프롬프트·협업 규칙·[질문]/[완료]/[선택] 표시, git·CLI 원문, AI·사용자가 쓴 내용, 로그·주석.
import ko from './i18n/ko.js';
import en from './i18n/en.js';

const DICTS = { ko, en };
export const LANGS = Object.freeze(['ko', 'en']);
export const DEFAULT_LANG = 'ko';

let current = DEFAULT_LANG;
const listeners = new Set();

export function normLang(v) { return LANGS.includes(v) ? v : DEFAULT_LANG; }
export function getLang() { return current; }

// 바뀌었을 때만 알린다. 알림 하나가 실패해도 나머지는 받는다.
export function setLang(lang) {
  const next = normLang(lang);
  if (next === current) return false;
  current = next;
  for (const fn of [...listeners]) {
    try { fn(next); } catch (e) { console.error('[i18n]', e); }
  }
  return true;
}

export function onLangChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// 없는 키는 한국어 값, 그것도 없으면 키 자체를 돌려준다(테스트가 누락을 잡는다).
export function t(key, args, lang = current) {
  const dict = DICTS[lang] || DICTS[DEFAULT_LANG];
  let v = dict[key];
  if (v === undefined) v = DICTS[DEFAULT_LANG][key];
  if (v === undefined) return key;
  if (typeof v === 'function') return String(v(args || {}));
  if (!args) return v;
  return v.replace(/\{(\w+)\}/g, (m, k) => (args[k] === undefined || args[k] === null ? m : String(args[k])));
}

export function hasKey(key, lang = DEFAULT_LANG) { return Object.prototype.hasOwnProperty.call(DICTS[lang] || {}, key); }

// 날짜·숫자 표기용 로캘.
export function locale(lang = current) { return lang === 'en' ? 'en-US' : 'ko-KR'; }

// 검사용(테스트·check 스크립트): 언어별 전체 사전.
export function dictionaries() { return DICTS; }
