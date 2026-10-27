import { CATALOG, MATERIALS, ROLES, isFloor } from './catalog.js';
import { footprint, snap, placementError, place, validate, area, BASE_AREA, makeLayout, normalizeName } from './model.js';
import { saveOffice, importBackground } from './storage.js';
import { ENVIRONMENT_OPTIONS, environmentSettings } from './environment.js';

const node = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
export class OfficeEditor {
  constructor(theme, doc) {
    this.theme = theme; this.doc = doc; this.editing = true; this.selected = null; this.errors = []; this.history = []; this.future = []; this.rotation = 0; this.filter = '전체'; this.dirty = false;
  }
  mount(view) {
    this.view = view; this.abort = new AbortController(); this.signal = this.abort.signal;
    document.body.classList.add('custom-office-active');
    if (!document.querySelector('#custom-office-style')) { const css = node('link'); css.id = 'custom-office-style'; css.rel = 'stylesheet'; css.href = new URL('./editor.css', import.meta.url).href; document.head.append(css); }
    this.panel = node('section', '', 'custom-builder'); this.panel.setAttribute('aria-label', '사무실 제작 도구');
    this.bar = node('div', '', 'custom-actions'); this.panel.append(this.bar);
    const button = (label, action, key) => { const b = node('button', label); b.type = 'button'; b.dataset.action = key; b.addEventListener('click', action, { signal: this.signal }); this.bar.append(b); return b; };
    this.modeButton = button('저장 · 이용하기', () => this.toggle(), 'mode');
    this.undoButton = button('되돌리기', () => this.undo(), 'undo');
    this.redoButton = button('다시 실행', () => this.redo(), 'redo');
    this.rotateButton = button('회전 ↻', () => this.rotate(), 'rotate');
    this.copyButton = button('복제', () => this.duplicate(), 'copy');
    this.deleteButton = button('삭제', () => this.remove(), 'delete');
    this.floorButton = button('바닥 선택', () => { this.floorSelect = !this.floorSelect; this.refresh(); }, 'floor');
    this.roleSelect = node('select'); this.roleSelect.setAttribute('aria-label', '책상 작업 용도');
    for (const [value, label] of Object.entries(ROLES)) { const option = node('option', label); option.value = value; this.roleSelect.append(option); }
    this.roleSelect.addEventListener('change', () => { const i = this.doc.items.find(i => i.id === this.selected); if (i?.kind === 'desk') this.commit({ ...this.doc, items: this.doc.items.map(item => item.id === i.id ? { ...item, role: this.roleSelect.value } : item) }); }, { signal: this.signal }); this.bar.append(this.roleSelect);
    this.backgroundInput = node('input'); this.backgroundInput.type = 'file'; this.backgroundInput.accept = 'image/png,image/jpeg,image/webp'; this.backgroundInput.hidden = true;
    button('배경 이미지', () => this.backgroundInput.click(), 'background');
    const backgroundInput = this.backgroundInput, mountSignal = this.signal;
    backgroundInput.addEventListener('change', async () => {
      try {
        const data = await importBackground(backgroundInput.files[0]);
        if (mountSignal.aborted || !this.editing) return;
        this.commit({ ...this.doc, background: data }); this.message('배경을 불러왔어요. 저장하면 다음 실행에도 유지돼요.');
      } catch (e) { if (!mountSignal.aborted) this.message(e.message); }
      finally { backgroundInput.value = ''; }
    }, { signal: mountSignal });
    this.panel.append(this.backgroundInput);
    button('배경 지우기', () => this.commit({ ...this.doc, background: null }), 'clear-background');
    this.nameEditor = node('div', '', 'custom-name-editor');
    this.nameLabel = node('label', '표시 이름'); this.nameInput = node('input'); this.nameInput.type = 'text'; this.nameInput.maxLength = 20; this.nameInput.setAttribute('aria-label', '공간 또는 책상 이름'); this.nameInput.placeholder = '예: 개발실, 대표실'; this.nameLabel.append(this.nameInput);
    const applyName = node('button', '이름 적용'); applyName.type = 'button'; applyName.dataset.action = 'name'; applyName.addEventListener('click', () => this.renameSelected(this.nameInput.value), { signal: this.signal });
    this.nameInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.renameSelected(this.nameInput.value); } }, { signal: this.signal });
    this.nameEditor.append(this.nameLabel, applyName, node('span', '최대 20자 · 비우면 기본 이름')); this.panel.append(this.nameEditor);
    const environmentBar = this.environmentBar = node('div', '', 'custom-environment'); this.environmentSelects = {};
    for (const [key, option] of Object.entries(ENVIRONMENT_OPTIONS)) {
      const label = node('label', option.label), select = node('select'); select.dataset.environment = key; select.setAttribute('aria-label', option.label);
      for (const [value, text] of Object.entries(option.values)) { const item = node('option', text); item.value = value; select.append(item); }
      select.addEventListener('change', () => { this.commit({ ...this.doc, environment: { ...environmentSettings(this.doc.environment), [key]: select.value } }); this.message('환경을 미리 적용했어요. 저장 · 이용하기를 누르면 선택이 유지돼요.'); }, { signal: this.signal });
      this.environmentSelects[key] = select; label.append(select); environmentBar.append(label);
    }
    this.meta = node('div', '', 'custom-meta'); this.panel.append(this.meta);
    this.tabs = node('div', '', 'custom-categories');
    for (const label of ['전체', '바닥', '구조', '가구', '생활', '장식', '환경']) { const b = node('button', label); b.dataset.category = label; b.addEventListener('click', () => { this.filter = label; this.renderCatalog(); }, { signal: this.signal }); this.tabs.append(b); }
    this.panel.append(this.tabs);
    this.strip = node('div', '', 'custom-materials'); this.strip.setAttribute('aria-label', '재료 목록. 좌우로 끌어 탐색하고 위로 끌어 배치하세요.'); this.panel.append(this.strip);
    this.panel.append(environmentBar);
    this.status = node('div', '', 'custom-status'); this.status.setAttribute('role', 'status'); this.panel.append(this.status);
    document.querySelector('.layout').append(this.panel);
    this.renderCatalog(); this.refresh();
    this.message(this.theme.loadError || '재료 클릭: 중앙 배치 · 위로 끌기: 원하는 위치 · 좌우 끌기: 목록 이동');
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
    this.applyLayout(false); view.resize(); view.fit();
  }
  unmount() {
    this.cancel(); this.abort?.abort(); this.panel?.remove(); document.body.classList.remove('custom-office-active'); this.view = null;
  }
  message(text) { if (this.status) this.status.textContent = text; }
  refresh() {
    if (!this.panel) return;
    const selected = this.doc.items.find(i => i.id === this.selected);
    this.meta.textContent = `${this.editing ? '제작 중' : '사무실 이용 중'} · 바닥 ${Math.round(area(this.doc) / BASE_AREA * 100)}% / 최대 200% · ${this.doc.items.filter(i => !isFloor(i)).length}개 재료${this.dirty ? ' · 저장 전' : ' · 저장됨'}${selected ? ` · 선택: ${MATERIALS[selected.kind].label}` : ''}`;
    this.modeButton.textContent = this.editing ? '저장 · 이용하기' : '사무실 편집';
    for (const b of [this.rotateButton, this.copyButton, this.deleteButton]) b.disabled = !this.editing || !selected;
    this.undoButton.disabled = !this.editing || !this.history.length; this.redoButton.disabled = !this.editing || !this.future.length;
    this.floorButton.disabled = !this.editing; this.floorButton.setAttribute('aria-pressed', String(!!this.floorSelect));
    this.roleSelect.hidden = selected?.kind !== 'desk'; this.roleSelect.disabled = !this.editing; this.roleSelect.value = selected?.role || 'dev';
    this.nameEditor.hidden = !this.editing || !selected || !(isFloor(selected) || selected.kind === 'desk');
    this.nameLabel.firstChild.textContent = selected && isFloor(selected) ? '공간 이름' : '책상·부서 이름';
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
      const b = node('button', '', 'custom-material'); b.type = 'button'; b.dataset.kind = m.kind; b.title = `${m.label} · 클릭 또는 위로 끌어 배치`;
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
    this.selected = result.item.id; this.commit(result.doc); this.message(`${MATERIALS[kind].label}을 배치했어요. 선택 후 끌어서 옮길 수 있어요.`); return true;
  }
  commit(doc) {
    if (!this.editing) return;
    this.history.push(this.doc); if (this.history.length > 60) this.history.shift(); this.future = []; this.doc = doc; this.dirty = true; this.errors = [];
    this.changed();
  }
  changed() { this.theme.setDraft(this.doc); this.refresh(); }
  undo() { if (!this.editing || !this.history.length) return; this.future.push(this.doc); this.doc = this.history.pop(); this.selected = null; this.errors = []; this.dirty = true; this.changed(); this.message('이전 배치로 되돌렸어요.'); }
  redo() { if (!this.editing || !this.future.length) return; this.history.push(this.doc); this.doc = this.future.pop(); this.selected = null; this.errors = []; this.dirty = true; this.changed(); }
  remove() { if (!this.editing || !this.selected) return; this.commit({ ...this.doc, items: this.doc.items.filter(i => i.id !== this.selected) }); this.selected = null; this.refresh(); this.message('삭제했어요. 되돌리기로 복구할 수 있어요.'); }
  rotate() {
    if (!this.editing) return; this.rotation = (this.rotation + 1) % 4;
    const i = this.doc.items.find(i => i.id === this.selected); if (!i || isFloor(i)) return;
    const f = footprint(i), rotated = { ...i, rotation: (i.rotation + 1) % 4 }, g = footprint(rotated);
    rotated.x += (f.w - g.w) / 2; rotated.y += (f.h - g.h) / 2;
    const result = place(this.doc, rotated); if (result.error) this.message(result.error); else { this.commit(result.doc); this.message('사선 시점에 맞춰 회전했어요.'); }
  }
  renameSelected(value) {
    const selected = this.doc.items.find(i => i.id === this.selected);
    if (!this.editing || !selected || !(isFloor(selected) || selected.kind === 'desk')) return;
    const name = normalizeName(value); if (name === (selected.name || '')) return;
    this.commit({ ...this.doc, items: this.doc.items.map(i => { if (i.id !== selected.id) return i; const next = { ...i }; if (name) next.name = name; else delete next.name; return next; }) });
    this.message(name ? `‘${name}’ 이름을 적용했어요. 저장하면 다음 실행에도 유지돼요.` : '기본 표시 이름으로 되돌렸어요.');
  }
  duplicate() { const i = this.doc.items.find(i => i.id === this.selected); if (i && this.editing) { this.rotation = i.rotation; const f = footprint(i); this.add(i.kind, { x: i.x + f.w / 2 + 48, y: i.y + f.h / 2 + 48 }, i.role, i.name); } }
  applyLayout(save = true) {
    const errors = validate(this.doc); this.errors = errors;
    if (errors.length) { this.message(`${errors[0].text}${errors.length > 1 ? ` 외 ${errors.length - 1}곳 · 붉은 표시를 확인해 주세요.` : ''}`); return false; }
    try { if (save) saveOffice(localStorage, this.doc); } catch { this.message('저장 공간이 부족하거나 접근할 수 없어요. 배경 크기를 줄인 뒤 다시 저장해 주세요.'); return false; }
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
    this.editing = !this.editing; this.selected = null; this.cancel(); this.refresh(); this.view.fit();
    if (this.editing) { this.view.life?.closeMenu(); this.view.notify(); }
    this.message(this.editing ? '재료를 배치하고 저장 · 이용하기를 눌러 주세요.' : '저장했어요. 바닥을 클릭해 이동하고 가구를 클릭해 이용하세요.');
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
    this.ghostError = placementError(this.doc, this.ghost); this.message(this.ghostError || '놓으면 이 위치에 배치돼요.');
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
      if (mode === 'place') { this.ghost = snap(this.doc, this.newItem(kind, this.point(ev))); this.ghostError = placementError(this.doc, this.ghost); this.message(this.ghostError || '놓으면 이 위치에 배치돼요.'); }
    }, { signal });
    document.addEventListener('pointerup', ev => {
      if (!mode) this.add(kind);
      else if (mode === 'place') {
        const r = this.view.canvas.getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom && this.ghost) {
          const result = place(this.doc, this.ghost);
          if (result.error) this.message(result.error); else { this.selected = result.item.id; this.commit(result.doc); this.message(`${MATERIALS[kind].label} 배치 완료`); }
        } else this.message('사무실 화면 안에 놓아 주세요.');
      }
      this.cancel();
    }, { signal, once: true });
    document.addEventListener('pointercancel', () => this.cancel(), { signal, once: true });
  }
}
