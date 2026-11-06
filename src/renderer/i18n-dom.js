// 화면(메인 창·펫 창) 쪽 언어 도우미 — 저장·복원, 정적 문구(data-i18n*) 적용, 전환 버튼.
// 언어는 localStorage 'ao.lang' 에 둔다. 메인 창·펫 창은 같은 출처(app://office)라 storage 이벤트로 함께 바뀐다.
// 창을 새로고침하지 않는다(새로고침하면 메인이 터미널·협업을 정리한다 — main.cjs dropSessions). 각 화면은 onLangChange 로 다시 그린다.
import { t, getLang, setLang, normLang, onLangChange } from '../shared/i18n.js';

const KEY = 'ao.lang';

function readSaved() {
  try { return normLang(JSON.parse(localStorage.getItem(KEY))); } catch { return normLang(null); }
}

function save(lang) {
  try { localStorage.setItem(KEY, JSON.stringify(lang)); } catch { /* 저장 실패는 이번 실행에만 적용 */ }
}

// data-i18n="키" → 글자, data-i18n-title / data-i18n-aria-label / data-i18n-placeholder → 속성.
const ATTRS = [['i18nTitle', 'title'], ['i18nAriaLabel', 'aria-label'], ['i18nPlaceholder', 'placeholder']];
export function applyStatic(root = document) {
  for (const el of root.querySelectorAll('[data-i18n], [data-i18n-title], [data-i18n-aria-label], [data-i18n-placeholder]')) {
    if (el.dataset.i18n) el.textContent = t(el.dataset.i18n);
    for (const [prop, attr] of ATTRS) if (el.dataset[prop]) el.setAttribute(attr, t(el.dataset[prop]));
  }
}

// 시작할 때 한 번: 저장된 언어를 적용하고, 바뀌면 저장·정적 문구·<html lang> 을 맞춘다.
// sync: 다른 창(펫 창 등)에서 바꾼 언어를 storage 이벤트로 따라간다.
export function initLang({ sync = true } = {}) {
  setLang(readSaved());
  document.documentElement.lang = getLang();
  applyStatic();
  onLangChange(lang => {
    save(lang);
    document.documentElement.lang = lang;
    applyStatic();
  });
  if (sync) {
    window.addEventListener('storage', e => { if (e.key === KEY) setLang(readSaved()); });
  }
  return getLang();
}

// 「한 | EN」 버튼: 지금 언어 쪽을 굵게(data-lang), 누르면 반대 언어로.
export function bindLangToggle(button) {
  const paint = () => {
    button.dataset.lang = getLang();
    button.title = t('app.langTitle');
    button.setAttribute('aria-label', t('app.langTitle'));
  };
  button.addEventListener('click', () => setLang(getLang() === 'ko' ? 'en' : 'ko'));
  onLangChange(paint);
  paint();
}
