import { CATALOG, MATERIALS, ROLES, isFloor, groupLabel } from './catalog.js';
import { t, onLangChange } from '../../../shared/i18n.js';
import { footprint, snap, placementError, place, validate, area, BASE_AREA, makeLayout, normalizeName } from './model.js';
import { saveOffice, importBackground } from './storage.js';
import { ENVIRONMENT_OPTIONS, environmentSettings } from './environment.js';

const EDIT_MIN_ZOOM = 0.4; // 제작 중에는 40% 까지 줄여 넓게 보며 배치한다 (이용 중은 100%)
const node = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
export class OfficeEditor {
  constructor(theme, doc) {
    this.theme = theme; this.doc = doc; this.editing = true; this.selected = null; this.errors = []; this.history = []; this.future = []; this.rotation = 0; this.filter = '전체'; this.dirty = false;
  }
  mount(view) {
    this.view = view; this.abort = new AbortController(); this.signal = this.abort.signal;
    document.body.classList.add('custom-office-active');
    if (!document.querySelector('#custom-office-style')) { const css = node('link'); css.id = 'custom-office-style'; css.rel = 'stylesheet'; css.href = new URL('./editor.css', import.meta.url).href; document.head.append(css); }
    this.panel = node('section', '', 'custom-builder'); // 고정 글자는 relabel() 이 채운다(처음과 언어가 바뀔 때).
    this.bar = node('div', '', 'custom-actions'); this.panel.append(this.bar);
    const button = (label, action, key) => { const b = node('button', label); b.type = 'button'; b.dataset.action = key; b.addEventListener('click', action, { signal: this.signal }); this.bar.append(b); return b; };
    this.modeButton = button('', () => this.toggle(), 'mode');
    this.undoButton = button('', () => this.undo(), 'undo');
    this.redoButton = button('', () => this.redo(), 'redo');
    this.rotateButton = button('', () => this.rotate(), 'rotate');
    this.copyButton = button('', () => this.duplicate(), 'copy');
    this.deleteButton = button('', () => this.remove(), 'delete');
    this.floorButton = button('', () => { this.floorSelect = !this.floorSelect; this.refresh(); }, 'floor');
    this.roleSelect = node('select'); 
    for (const value of Object.keys(ROLES)) { const option = node('option'); option.value = value; this.roleSelect.append(option); }
    this.roleSelect.addEventListener('change', () => { const i = this.doc.items.find(i => i.id === this.selected); if (i?.kind === 'desk') this.commit({ ...this.doc, items: this.doc.items.map(item => item.id === i.id ? { ...item, role: this.roleSelect.value } : item) }); }, { signal: this.signal }); this.bar.append(this.roleSelect);
    this.backgroundInput = node('input'); this.backgroundInput.type = 'file'; this.backgroundInput.accept = 'image/png,image/jpeg,image/webp'; this.backgroundInput.hidden = true;
    this.backgroundButton = button('', () => this.backgroundInput.click(), 'background');
    const backgroundInput = this.backgroundInput, mountSignal = this.signal;
    backgroundInput.addEventListener('change', async () => {
      try {
        const data = await importBackground(backgroundInput.files[0]);
        if (mountSignal.aborted || !this.editing) return;
        this.commit({ ...this.doc, background: data }); this.message(t('theme.editor.bgLoaded'));
      } catch (e) { if (!mountSignal.aborted) this.message(e.message); }
      finally { backgroundInput.value = ''; }
    }, { signal: mountSignal });
    this.panel.append(this.backgroundInput);
    this.clearBackgroundButton = button('', () => this.commit({ ...this.doc, background: null }), 'clear-background');
    this.nameEditor = node('div', '', 'custom-name-editor');
    this.nameLabel = node('label', t('theme.editor.displayName')); this.nameInput = node('input'); this.nameInput.type = 'text'; this.nameInput.maxLength = 20; this.nameLabel.append(this.nameInput);
    const applyName = this.applyNameButton = node('button'); applyName.type = 'button'; applyName.dataset.action = 'name'; applyName.addEventListener('click', () => this.renameSelected(this.nameInput.value), { signal: this.signal });
    this.nameInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.renameSelected(this.nameInput.value); } }, { signal: this.signal });
    this.nameHint = node('span'); this.nameEditor.append(this.nameLabel, applyName, this.nameHint); this.panel.append(this.nameEditor);
    const environmentBar = this.environmentBar = node('div', '', 'custom-environment'); this.environmentSelects = {}; this.environmentLabels = {};
    for (const [key, option] of Object.entries(ENVIRONMENT_OPTIONS)) {
      const label = node('label', option.label), select = node('select'); select.dataset.environment = key;
      for (const value of Object.keys(option.values)) { const item = node('option'); item.value = value; select.append(item); }
      select.addEventListener('change', () => { this.commit({ ...this.doc, environment: { ...environmentSettings(this.doc.environment), [key]: select.value } }); this.message(t('theme.editor.envApplied')); }, { signal: this.signal });
      this.environmentSelects[key] = select; this.environmentLabels[key] = label.firstChild; label.append(select); environmentBar.append(label);
    }
    this.meta = node('div', '', 'custom-meta'); this.panel.append(this.meta);
    this.tabs = node('div', '', 'custom-categories');
    for (const label of ['전체', '바닥', '구조', '가구', '생활', '장식', '환경']) { const b = node('button', groupLabel(label)); b.dataset.category = label; b.addEventListener('click', () => { this.filter = label; this.renderCatalog(); }, { signal: this.signal }); this.tabs.append(b); }
    this.panel.append(this.tabs);
    this.strip = node('div', '', 'custom-materials'); this.panel.append(this.strip);
    this.panel.append(environmentBar);
    this.status = node('div', '', 'custom-status'); this.status.setAttribute('role', 'status'); this.panel.append(this.status);
    document.querySelector('.layout').append(this.panel);
    this.relabel(); this.offLang = onLangChange(() => this.relabel()); // 닫을 때(unmount) 해제
    this.message(this.theme.loadError || t('theme.editor.hint'));
    const c = view.canvas;
    c.addEventListener('pointerdown', e => this.down(e), { capture: true, signal: this.signal });
    c.addEventListener('pointermove', e => this.move(e), { capture: true, signal: this.signal });
    c.addEventListener('pointerup', e => this.up(e), { capture: true, signal: this.signal });
    c.addEventListener('pointercancel', () => this.cancel(), { capture: true, signal: this.signal });
    document.addEventListener('keydown', e => {
      if (!this.editing || e.target.closest('input,select,textarea,.cli-pane') || document.querySelector('dialog[open]')) return;
      if (e.key === 'Escape') { this.cancel(); this.selected = null; this.refresh(); }
      else if (e.key === 'Delete') { e.preventDefault(); this.remove(); }
      else if (e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.altKey) { e.preventDefault(); this.rotate(); }
      else if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
      else if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); }
    }, { signal: this.signal });
    this.applyLayout(false); view.resize(); view.setMinZoom(this.editing ? EDIT_MIN_ZOOM : 1); view.fit();
  }
  unmount() {
    this.offLang?.(); this.offLang = null; this.cancel(); this.abort?.abort(); this.panel?.remove(); document.body.classList.remove('custom-office-active'); this.view?.setMinZoom(1); this.view = null;
  }
  // 고정 버튼·라벨·목록 글자만 현재 언어로 바꾼다. 확대·선택·입력 중인 이름·진행 중인 가져오기는 그대로 둔다.
  relabel() {
    if (!this.panel) return;
    this.panel.setAttribute('aria-label', t('theme.editor.panel'));
    this.undoButton.textContent = t('theme.editor.undo'); this.redoButton.textContent = t('theme.editor.redo');
    this.rotateButton.textContent = t('theme.editor.rotate'); this.copyButton.textContent = t('theme.editor.copy');
    this.deleteButton.textContent = t('theme.editor.delete'); this.floorButton.textContent = t('theme.editor.floor');
    this.backgroundButton.textContent = t('theme.editor.background'); this.clearBackgroundButton.textContent = t('theme.editor.clearBackground');
    this.roleSelect.setAttribute('aria-label', t('theme.editor.roleLabel'));
    for (const option of this.roleSelect.options) option.textContent = ROLES[option.value];
    this.nameInput.setAttribute('aria-label', t('theme.editor.nameLabel')); this.nameInput.placeholder = t('theme.editor.namePlaceholder');
    this.applyNameButton.textContent = t('theme.editor.applyName'); this.nameHint.textContent = t('theme.editor.nameHint');
    for (const [key, option] of Object.entries(ENVIRONMENT_OPTIONS)) {
      this.environmentLabels[key].textContent = option.label; this.environmentSelects[key].setAttribute('aria-label', option.label);
      for (const item of this.environmentSelects[key].options) item.textContent = option.values[item.value];
    }
    for (const b of this.tabs.children) b.textContent = groupLabel(b.dataset.category);
    this.strip.setAttribute('aria-label', t('theme.editor.stripLabel'));
    const left = this.strip.scrollLeft, typed = this.nameInput.value; // 목록을 다시 그리면 refresh() 가 이름 칸을 저장값으로 되돌린다
    this.renderCatalog(); this.strip.scrollLeft = left; this.nameInput.value = typed;
  }
  message(text) { if (this.status) this.status.textContent = text; }
  refresh() {
    if (!this.panel) return;
    const selected = this.doc.items.find(i => i.id === this.selected);
    this.meta.textContent = t('theme.editor.meta', { mode: t(this.editing ? 'theme.editor.modeEdit' : 'theme.editor.modeUse'), pct: Math.round(area(this.doc) / BASE_AREA * 100), count: this.doc.items.filter(i => !isFloor(i)).length, dirty: t(this.dirty ? 'theme.editor.unsaved' : 'theme.editor.saved'), selected: selected ? t('theme.editor.selected', { label: MATERIALS[selected.kind].label }) : '' });
    this.modeButton.textContent = t(this.editing ? 'theme.editor.saveUse' : 'theme.editor.edit');
    for (const b of [this.rotateButton, this.copyButton, this.deleteButton]) b.disabled = !this.editing || !selected;
    this.undoButton.disabled = !this.editing || !this.history.length; this.redoButton.disabled = !this.editing || !this.future.length;
    this.floorButton.disabled = !this.editing; this.floorButton.setAttribute('aria-pressed', String(!!this.floorSelect));
    this.roleSelect.hidden = selected?.kind !== 'desk'; this.roleSelect.disabled = !this.editing; this.roleSelect.value = selected?.role || 'dev';
    this.nameEditor.hidden = !this.editing || !selected || !(isFloor(selected) || selected.kind === 'desk');
    this.nameLabel.firstChild.textContent = t(selected && isFloor(selected) ? 'theme.editor.spaceName' : 'theme.editor.deskName');
    this.nameInput.value = selected?.name || '';
    const environment = environmentSettings(this.doc.environment);
    for (const [key, select] of Object.entries(this.environmentSelects || {})) { select.value = environment[key]; select.disabled = !this.editing; }
    this.tabs.hidden = !this.editing;
    this.strip.hidden = !this.editing || this.filter === '환경';
    this.environmentBar.hidden = !this.editing || this.filter !== '환경';
    for (const b of this.bar.querySelectorAll('[data-action="background"],[data-action="clear-background"]')) b.disabled = !this.editing;
    this.view?.resize();
  }
  renderCatalog() {
    this.strip.replaceChildren();
    for (const m of CATALOG.filter(m => this.filter === '전체' || m.group === this.filter)) {
      const b = node('button', '', 'custom-material'); b.type = 'button'; b.dataset.kind = m.kind; b.title = t('theme.editor.materialTitle', { label: m.label });
      const canvas = node('canvas'); canvas.width = 144; canvas.height = 98; this.theme.thumbnail(canvas, m.kind);
      b.append(canvas, node('span', m.label));
      b.addEventListener('pointerdown', e => this.paletteDown(e, m.kind), { signal: this.signal });
      b.addEventListener('click', e => { if (e.detail === 0) this.add(m.kind); }, { signal: this.signal });
      this.strip.append(b);
    }
    for (const b of this.tabs.children) b.setAttribute('aria-pressed', String(b.dataset.category === this.filter));
    this.strip.scrollLeft = 0;
    this.strip.onwheel = e => { e.preventDefault(); this.strip.scrollLeft += e.deltaX || e.deltaY; };
    this.refresh();
  }
  center() { const v = this.view, p = v.camera.toScene(v.canvas.clientWidth / 2, v.canvas.clientHeight / 2); return this.theme.unproject(p.x, p.y); }
  point(e) { const r = this.view.canvas.getBoundingClientRect(), p = this.view.camera.toScene(e.clientX - r.left, e.clientY - r.top); return { ...this.theme.unproject(p.x, p.y), scene: p }; }
  newItem(kind, p) { const m = MATERIALS[kind], rotation = isFloor({ kind }) ? 0 : this.rotation; return { id: `custom-${crypto.randomUUID()}`, kind, x: p.x - (rotation % 2 ? m.d : m.w) / 2, y: p.y - (rotation % 2 ? m.w : m.d) / 2, rotation, ...(kind === 'desk' ? { role: 'dev' } : {}) }; }
  add(kind, point = this.center(), role, name) {
    if (!this.editing) return false;
    const raw = this.newItem(kind, point);
    if (kind === 'desk' && ROLES[role]) raw.role = role;
    if (normalizeName(name)) raw.name = normalizeName(name);
    let result = place(this.doc, raw);
    // 중앙이 이미 사용 중이면 가까운 빈 위치에 배치한다.
    if (result.error && !isFloor(raw)) outer: for (let radius = 24; radius <= 288; radius += 24) for (const [dx, dy] of [[radius, 0], [-radius, 0], [0, radius], [0, -radius], [radius, radius], [-radius, -radius]]) {
      const candidate = place(this.doc, { ...raw, x: raw.x + dx, y: raw.y + dy }); if (!candidate.error) { result = candidate; break outer; }
    }
    if (result.error) { this.message(result.error); return false; }
    this.selected = result.item.id; this.commit(result.doc); this.message(t('theme.editor.placed', { label: MATERIALS[kind].label })); return true;
  }
  commit(doc) {
    if (!this.editing) return;
    this.history.push(this.doc); if (this.history.length > 60) this.history.shift(); this.future = []; this.doc = doc; this.dirty = true; this.errors = [];
    this.changed();
  }
  changed() { this.theme.setDraft(this.doc); this.refresh(); }
  undo() { if (!this.editing || !this.history.length) return; this.future.push(this.doc); this.doc = this.history.pop(); this.selected = null; this.errors = []; this.dirty = true; this.changed(); this.message(t('theme.editor.undone')); }
  redo() { if (!this.editing || !this.future.length) return; this.history.push(this.doc); this.doc = this.future.pop(); this.selected = null; this.errors = []; this.dirty = true; this.changed(); }
  remove() { if (!this.editing || !this.selected) return; this.commit({ ...this.doc, items: this.doc.items.filter(i => i.id !== this.selected) }); this.selected = null; this.refresh(); this.message(t('theme.editor.deleted')); }
  rotate() {
    if (!this.editing) return; this.rotation = (this.rotation + 1) % 4;
    const i = this.doc.items.find(i => i.id === this.selected); if (!i || isFloor(i)) return;
    const f = footprint(i), rotated = { ...i, rotation: (i.rotation + 1) % 4 }, g = footprint(rotated);
    rotated.x += (f.w - g.w) / 2; rotated.y += (f.h - g.h) / 2;
    const result = place(this.doc, rotated); if (result.error) this.message(result.error); else { this.commit(result.doc); this.message(t('theme.editor.rotated')); }
  }
  renameSelected(value) {
    const selected = this.doc.items.find(i => i.id === this.selected);
    if (!this.editing || !selected || !(isFloor(selected) || selected.kind === 'desk')) return;
    const name = normalizeName(value); if (name === (selected.name || '')) return;
    this.commit({ ...this.doc, items: this.doc.items.map(i => { if (i.id !== selected.id) return i; const next = { ...i }; if (name) next.name = name; else delete next.name; return next; }) });
    this.message(name ? t('theme.editor.renamed', { name }) : t('theme.editor.renameReset'));
  }
  duplicate() { const i = this.doc.items.find(i => i.id === this.selected); if (i && this.editing) { this.rotation = i.rotation; const f = footprint(i); this.add(i.kind, { x: i.x + f.w / 2 + 48, y: i.y + f.h / 2 + 48 }, i.role, i.name); } }
  applyLayout(save = true) {
    const errors = validate(this.doc); this.errors = errors;
    if (errors.length) { this.message(`${errors[0].text}${errors.length > 1 ? t('theme.editor.moreErrors', { n: errors.length - 1 }) : ''}`); return false; }
    try { if (save) saveOffice(localStorage, this.doc); } catch { this.message(t('theme.editor.saveFailed')); return false; }
    const v = this.view, previous = v.life;
    this.theme.layout = makeLayout(this.doc); v.engine.setLayout(this.theme.layout);
    v.life = this.theme.createLife(this.theme.layout, v.engine);
    if (previous) {
      v.life.time = previous.time;
      Object.assign(v.life.player, { appearance: previous.player.appearance, heldItem: previous.player.heldItem });
      if (v.life.navigation.isWalkable(previous.player)) { v.life.player.x = previous.player.x; v.life.player.y = previous.player.y; }
    }
    this.theme.applied = this.doc;
    if (save) this.dirty = false;
    return true;
  }
  toggle() {
    if (this.editing && !this.nameEditor.hidden) this.renameSelected(this.nameInput.value);
    if (this.editing && !this.applyLayout()) return;
    this.editing = !this.editing; this.selected = null; this.cancel(); this.refresh(); this.view.setMinZoom(this.editing ? EDIT_MIN_ZOOM : 1); this.view.fit();
    if (this.editing) { this.view.life?.closeMenu(); this.view.notify(); }
    this.message(t(this.editing ? 'theme.editor.toEdit' : 'theme.editor.toUse'));
  }
  down(e) {
    if (!this.editing || e.button !== 0) return;
    const p = this.point(e), found = this.theme.art.hit(this.doc, p.scene.x, p.scene.y, this.floorSelect);
    if (!found) { this.selected = null; this.refresh(); return; }
    e.preventDefault(); e.stopImmediatePropagation(); this.selected = found.id;
    this.drag = { item: found, startX: e.clientX, startY: e.clientY, x: p.x, y: p.y };
    this.view.canvas.setPointerCapture(e.pointerId); this.refresh();
  }
  move(e) {
    if (!this.drag) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (Math.hypot(e.clientX - this.drag.startX, e.clientY - this.drag.startY) < 4) return;
    const p = this.point(e), i = this.drag.item;
    this.ghost = snap(this.doc, { ...i, x: i.x + p.x - this.drag.x, y: i.y + p.y - this.drag.y });
    this.ghostError = placementError(this.doc, this.ghost); this.message(this.ghostError || t('theme.editor.dropHere'));
  }
  up(e) {
    if (!this.drag) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (this.view.canvas.hasPointerCapture(e.pointerId)) this.view.canvas.releasePointerCapture(e.pointerId);
    if (this.ghost) { const result = place(this.doc, this.ghost); if (!result.error) this.commit(result.doc); else this.message(result.error); }
    this.cancel();
  }
  cancel() { this.drag = null; this.ghost = null; this.ghostError = null; this.paletteAbort?.abort(); this.paletteAbort = null; }
  paletteDown(e, kind) {
    if (!this.editing || e.button !== 0) return;
    e.preventDefault(); const startX = e.clientX, startY = e.clientY, left = this.strip.scrollLeft;
    let mode = null; this.paletteAbort?.abort(); this.paletteAbort = new AbortController(); const signal = this.paletteAbort.signal;
    document.addEventListener('pointermove', ev => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (!mode && Math.hypot(dx, dy) > 7) mode = Math.abs(dx) > Math.abs(dy) ? 'scroll' : 'place';
      if (mode === 'scroll') this.strip.scrollLeft = left - dx;
      if (mode === 'place') { this.ghost = snap(this.doc, this.newItem(kind, this.point(ev))); this.ghostError = placementError(this.doc, this.ghost); this.message(this.ghostError || t('theme.editor.dropHere')); }
    }, { signal });
    document.addEventListener('pointerup', ev => {
      if (!mode) this.add(kind);
      else if (mode === 'place') {
        const r = this.view.canvas.getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom && this.ghost) {
          const result = place(this.doc, this.ghost);
          if (result.error) this.message(result.error); else { this.selected = result.item.id; this.commit(result.doc); this.message(t('theme.editor.placedDone', { label: MATERIALS[kind].label })); }
        } else this.message(t('theme.editor.dropInside'));
      }
      this.cancel();
    }, { signal, once: true });
    document.addEventListener('pointercancel', () => this.cancel(), { signal, once: true });
  }
}
