// 코드 분석 하단 패널: 요약 · 읽는 순서 · 검색 키워드 탭과 상태 줄. 화면(DOM)만 다룬다 — 분석 실행·검색·이동은 바깥(panel.js)이 한다.
// 결과·검색 내용은 모두 textContent 로만 표시한다.
import { t } from '../../shared/i18n.js';

function node(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c instanceof Node ? c : String(c));
  return n;
}

const TABS = [['summary', 'code.ca.tabSummary'], ['order', 'code.ca.tabOrder'], ['keywords', 'code.ca.tabKeywords']];
const HIT_MAX = 200;
const none = () => t('code.ca.none');

const secText = (ms) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s >= 60 ? t('code.ca.minSec', { m: Math.floor(s / 60), s: s % 60 }) : t('code.ca.sec', { s });
};
const mmss = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// view = { status: 'running'|'done'|'error'|'confirm'|'stopped', scopeLabel, scopes: [{ key, label, title }] | null, active, result, cached, model, ms, costUsd,
//          error, confirm: { files, chars }, startedAt, notesOn, hiddenNotes, stale, jumpNote, canStart }
// 결과가 있을 때의 오류·중단은 상태 줄이 아니라 본문 위 한 줄(banner)로 알리고, 상태 줄은 그 결과의 정보를 그대로 둔다.
const bannerOf = (v) => (v.result && (v.status === 'error' || v.status === 'stopped') ? (v.status === 'error' ? `⚠ ${v.error}` : v.error || t('code.analysis.stopped')) : '');

// 상태 줄 = 경고(말줄임에 먼저 잘리지 않게 앞쪽에 강조) + 본 문구
function statusParts(v) {
  if (v.status === 'running') return { warn: '', text: t('code.ca.running', { time: mmss(Date.now() - v.startedAt) }) };
  if (v.status === 'confirm') return { warn: '', text: t('code.ca.needConfirm') };
  if (!v.result) {
    if (v.status === 'stopped') return { warn: '', text: v.error || t('code.analysis.stopped') };
    if (v.status === 'error') return { warn: '', text: `⚠ ${v.error}` };
  }
  const parts = [];
  if (v.cached) parts.push(t('code.ca.cachedResult'));
  else {
    if (v.model) parts.push(v.model);
    parts.push(secText(v.ms));
    if (typeof v.costUsd === 'number') parts.push(t('code.ca.apiCost', { cost: v.costUsd.toFixed(2) }));
  }
  const warn = [];
  if (v.stale) warn.push(t('code.ca.stale'));
  if (v.hiddenNotes > 0) warn.push(t('code.ca.hiddenNotes', { n: v.hiddenNotes }));
  if (v.jumpNote) warn.push(v.jumpNote);
  return { warn: warn.join(' · '), text: parts.join(' · ') };
}

export function createAnalysisPanel({ onJump, onSearch, onStop, onClose, onToggleNotes, onRerun, onConfirm, onCancel, onScope }) {
  let view = null;
  let tab = 'summary';
  let search = null; // { gi, term, state: 'loading'|'done'|'error', matches, truncated, error }
  let seq = 0; // 늦은 검색 결과 버리기
  let timer = null;
  let suspended = false;
  let bodyKey = '';
  let lastTab = 'summary';
  let lastResult = null; // 탭·결과가 바뀌면 본문 스크롤을 맨 위로
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = (o) => { if (!o) return 0; if (!ids.has(o)) ids.set(o, nextId++); return ids.get(o); };

  const scopeEl = node('span', { class: 'ca-scope' });
  const scopeSel = node('select', { class: 'ca-scope-sel', hidden: true, onchange: () => onScope(scopeSel.value) });
  const tabBtns = TABS.map(([id]) => node('button', { class: 'ca-tab', type: 'button', role: 'tab', 'data-tab': id, onclick: () => setTab(id) }));
  const tabsEl = node('div', { class: 'ca-tabs', role: 'tablist' }, tabBtns);
  const notesBtn = node('button', { class: 'ca-notes', type: 'button', 'aria-pressed': 'true', onclick: () => onToggleNotes(notesBtn.getAttribute('aria-pressed') !== 'true') });
  const statusEl = node('span', { class: 'ca-status' });
  const warnEl = node('span', { class: 'ca-warn' });
  const statusTextEl = node('span', { class: 'ca-st' });
  statusEl.append(warnEl, statusTextEl);
  const actBtn = node('button', { class: 'ca-act', type: 'button', onclick: () => (view?.status === 'running' ? onStop() : onRerun()) });
  const closeBtn = node('button', { class: 'ca-close', type: 'button', onclick: () => onClose() }, '×');
  const bodyEl = node('div', { class: 'ca-body', role: 'tabpanel' });
  // 위쪽 경계: 끌어서 패널 높이 조절 (layout.js setupAnalysisResizer)
  const resizer = node('div', { class: 'ca-resizer', role: 'separator', 'aria-orientation': 'horizontal' });
  const headEl = node('div', { class: 'ca-head' }, scopeEl, scopeSel, tabsEl, notesBtn, statusEl, actBtn, closeBtn);
  const el = node('section', { class: 'code-analysis', hidden: true }, resizer, headEl, bodyEl);

  // 한 번만 만드는 요소의 글자·툴팁·접근성 이름. 만들 때 한 번, 언어가 바뀔 때 다시 쓴다 (actBtn 의 글자는 update 가 상태에 맞게 쓴다).
  function paintLabels() {
    el.setAttribute('aria-label', t('code.ca.panel'));
    scopeSel.setAttribute('aria-label', t('code.ca.scope'));
    tabsEl.setAttribute('aria-label', t('code.ca.resultsAria'));
    TABS.forEach(([, key], i) => { tabBtns[i].textContent = t(key); });
    notesBtn.textContent = t('code.ca.notes');
    notesBtn.title = t('code.ca.notesTitle');
    actBtn.textContent = t('code.ca.rerun');
    closeBtn.setAttribute('aria-label', t('code.ca.closeAria'));
    closeBtn.title = t('code.ca.close');
    resizer.setAttribute('aria-label', t('code.ca.resizeAria'));
    resizer.title = t('code.view.dragHeight');
  }
  paintLabels();

  function setTab(id) {
    if (tab === id) return;
    tab = id;
    update();
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }
  function syncTimer() {
    const need = !!view && view.status === 'running' && !suspended;
    if (!need) stopTimer();
    else if (!timer) timer = setInterval(() => { if (view?.status === 'running') drawStatus(view); }, 1000);
  }

  function drawStatus(v) {
    const { warn, text } = statusParts(v);
    warnEl.textContent = warn;
    warnEl.hidden = !warn;
    statusTextEl.textContent = text;
    statusEl.title = [warn, text].filter(Boolean).join(' · ');
  }

  function empty(text) {
    return node('p', { class: 'ca-empty' }, text);
  }

  function drawSummary(r) {
    return r.summary ? node('p', { class: 'ca-summary' }, r.summary) : empty(none());
  }

  function drawOrder(r) {
    if (!r.readingOrder.length) return empty(none());
    return node('ol', { class: 'ca-list' }, r.readingOrder.map((it, i) => node('li', {},
      node('button', { class: 'ca-item', type: 'button', title: `${it.file}:${it.line}`, onclick: () => onJump(it) },
        node('span', { class: 'ca-num' }, String(i + 1)),
        node('span', { class: 'ca-loc' }, `${it.file}:${it.line}`),
        node('span', { class: 'ca-why' }, it.why)))));
  }

  function drawHits() {
    const s = search;
    if (s.state === 'loading') return node('p', { class: 'ca-note' }, t('code.ca.searching'));
    if (s.state === 'error') return node('p', { class: 'ca-note err' }, `⚠ ${s.error}`);
    if (!s.matches.length) return node('p', { class: 'ca-note' }, t('code.ca.noMatch'));
    const shown = s.matches.slice(0, HIT_MAX);
    return node('div', { class: 'ca-hits' },
      shown.map((m, i) => node('button', { class: 'ca-hit', type: 'button', 'data-key': `hit|${i}`, title: `${m.path}:${m.line}`, onclick: () => onJump({ file: m.path, line: m.line }) },
        node('span', { class: 'ca-loc' }, `${m.path}:${m.line}`),
        node('span', { class: 'ca-text' }, m.text))),
      s.truncated || s.matches.length > HIT_MAX ? node('p', { class: 'ca-note' }, t('code.ca.hitsCapped', { max: HIT_MAX })) : null);
  }

  function drawKeywords(r) {
    if (!r.keywords.length) return empty(none());
    return node('div', { class: 'ca-keywords' }, r.keywords.map((g, gi) => node('div', { class: 'ca-group' },
      node('div', { class: 'ca-feature' }, g.feature),
      node('div', { class: 'ca-terms' }, g.terms.map((t) => node('button', {
        class: 'ca-term', type: 'button', 'data-key': `term|${gi}|${t}`, 'aria-pressed': String(search?.gi === gi && search.term === t), onclick: () => runSearch(gi, t),
      }, t))),
      search && search.gi === gi ? drawHits() : null)));
  }

  async function runSearch(gi, term) {
    const my = ++seq;
    search = { gi, term, state: 'loading', matches: [], truncated: false, error: '' };
    drawBody();
    let r = null;
    let error = '';
    try { r = await onSearch(term); } catch (e) { error = String((e && e.message) || e); }
    if (my !== seq || !search) return; // 폴더가 바뀌었거나 다른 검색을 시작함
    if (!error && r == null) { search = null; drawBody(); return; } // 바깥에서 버린 응답
    search = error
      ? { gi, term, state: 'error', matches: [], truncated: false, error }
      : { gi, term, state: 'done', matches: Array.isArray(r.matches) ? r.matches : [], truncated: !!r.truncated, error: '' };
    drawBody();
  }

  function drawBody(reset = false) {
    const v = view;
    if (!v) { bodyEl.replaceChildren(); return; }
    const a = document.activeElement;
    const focusKey = a && bodyEl.contains(a) ? a.dataset.key : null;
    const top = reset ? 0 : bodyEl.scrollTop;
    const r = v.result;
    let content;
    if (v.status === 'confirm' && v.confirm) {
      content = node('div', { class: 'ca-confirm' },
        node('p', { class: 'ca-confirm-text' }, t('code.ca.confirmText', { files: v.confirm.files, chars: v.confirm.chars })),
        node('div', { class: 'ca-confirm-btns' },
          node('button', { class: 'ca-confirm-btn', type: 'button', disabled: v.canStart === false, onclick: () => onConfirm() }, t('code.ca.confirmGo')),
          node('button', { class: 'ca-cancel-btn', type: 'button', onclick: () => onCancel() }, t('code.ca.cancel'))));
    } else if (!r) {
      content = empty(v.status === 'running' ? t('code.ca.runningBody') : v.status === 'error' ? `⚠ ${v.error}` : v.error || none());
    } else if (tab === 'order') content = drawOrder(r);
    else if (tab === 'keywords') content = drawKeywords(r);
    else content = drawSummary(r);
    const banner = bannerOf(v);
    bodyEl.replaceChildren(...(banner && !(v.status === 'confirm' && v.confirm) ? [node('p', { class: `ca-banner${v.status === 'error' ? ' err' : ''}` }, banner)] : []), content);
    bodyEl.scrollTop = top;
    if (focusKey) [...bodyEl.querySelectorAll('[data-key]')].find((b) => b.dataset.key === focusKey)?.focus({ preventScroll: true });
  }

  function update() {
    const v = view;
    el.hidden = !v;
    if (!v) { bodyKey = ''; stopTimer(); bodyEl.replaceChildren(); return; }
    scopeEl.textContent = v.scopeLabel;
    scopeEl.title = v.scopeLabel;
    // 결과가 둘 이상이면 범위를 고를 수 있다 (하나면 글자)
    const many = Array.isArray(v.scopes) && v.scopes.length >= 2;
    scopeEl.hidden = many;
    scopeSel.hidden = !many;
    if (many) {
      scopeSel.replaceChildren(...v.scopes.map((o) => node('option', { value: o.key, title: o.title }, o.label)));
      scopeSel.value = v.active;
      scopeSel.title = v.scopeLabel;
    }
    for (const b of tabBtns) {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', String(on));
      b.classList.toggle('on', on);
    }
    notesBtn.setAttribute('aria-pressed', String(!!v.notesOn));
    drawStatus(v);
    statusEl.classList.toggle('err', v.status === 'error' && !v.result);
    actBtn.hidden = v.status === 'confirm';
    actBtn.textContent = t(v.status === 'running' ? 'code.ca.stop' : 'code.ca.rerun');
    actBtn.disabled = v.status !== 'running' && v.canStart === false;
    syncTimer();
    // 본문은 내용이 달라졌을 때만 다시 그린다 (10초 갱신마다 초점·스크롤이 흐트러지지 않게)
    const key = [tab, idOf(v.result), v.status === 'confirm' ? `c${v.confirm?.files}/${v.confirm?.chars}/${v.canStart}` : v.result ? bannerOf(v) : `${v.status}|${v.error}`].join('#');
    if (key !== bodyKey) {
      bodyKey = key;
      const reset = tab !== lastTab || idOf(v.result) !== lastResult; // 탭이나 결과가 바뀌면 맨 위부터
      lastTab = tab;
      lastResult = idOf(v.result);
      drawBody(reset);
    }
  }

  return {
    el,
    head: headEl,
    resizer,
    render(next) {
      if (next && next.result !== view?.result) { seq++; search = null; } // 다른 결과로 바뀌면 이전 검색은 버린다
      if (!next) { seq++; search = null; }
      view = next || null;
      update();
    },
    // 코드 화면을 숨기면 타이머를 멈추고, 다시 보이면 지금 시각으로 그린다.
    stopTimer() { suspended = true; stopTimer(); },
    refresh() { suspended = false; update(); },
    // 언어가 바뀜: 한 번 만든 글자를 다시 쓰고, 상태 줄·본문은 지문(bodyKey)을 비워 새 언어로 다시 그린다 (보던 스크롤·초점은 지킨다).
    relabel() { paintLabels(); bodyKey = ''; update(); },
  };
}
