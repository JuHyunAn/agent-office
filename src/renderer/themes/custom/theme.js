import { createArt } from './art.js';
import { OfficeEditor } from './editor.js';
import { CustomLife } from './life.js';
import { exampleDocument, makeLayout, footprint } from './model.js';
import { readOffice } from './storage.js';
import { MATERIALS } from './catalog.js';
import { loadDrinkImages } from '../pixel-office/drink-images.js';
import { resolveEnvironment } from './environment.js';

let initial = exampleDocument(), loadError = null, saved = false;
try { if (typeof localStorage !== 'undefined') { const stored = readOffice(localStorage); if (stored) { initial = stored; saved = true; } } }
catch { loadError = '저장된 사무실을 읽지 못해 예제 배치를 표시했어요. 기존 저장 내용은 덮어쓰지 않았어요.'; }
const art = createArt(); art.setDocument(initial);
let background = null, backgroundSource = null;
const theme = {
  id: 'custom-office', name: '커스터마이징', art, layout: makeLayout(initial), applied: initial, loadError,
  agentHead: 40, agentHitRadius: 30, background: '#e9eee7',
  get viewport() { return art.viewport; },
  project(x, y) { const p = art.project(x, y); return { x: p.x * 2, y: p.y * 2 }; },
  unproject(x, y) { return art.unproject(x, y); },
  resolveEnvironment(env) { return resolveEnvironment(this.editor.doc, env); },
  sceneBackground(env) { return env?.citypop ? env.night ? '#29223f' : '#e9e1ed' : env?.night ? '#293342' : '#e9eee7'; },
  drawBackdrop(ctx, width, height) {
    if (!background) return false;
    const scale = Math.max(width / background.width, height / background.height);
    ctx.save(); ctx.imageSmoothingEnabled = true;
    ctx.drawImage(background, (width - background.width * scale) / 2, (height - background.height * scale) / 2, background.width * scale, background.height * scale);
    ctx.fillStyle = '#1c253329'; ctx.fillRect(0, 0, width, height); ctx.restore(); return true;
  },
  createLife(layout, engine) { return new CustomLife(layout, engine); },
  setDraft(doc) {
    art.setDocument(doc);
    if (doc.background !== backgroundSource) {
      backgroundSource = doc.background; background = null;
      if (backgroundSource) { const source = backgroundSource, image = new Image(); image.onload = () => { if (source === backgroundSource) background = image; }; image.src = source; }
    }
  },
  async load() { await loadDrinkImages(); this.setDraft(this.editor.doc); },
  mount(view) { this.editor.mount(view); },
  unmount() { this.editor.unmount(); },
  hitTest(x, y) {
    if (this.editor.editing) return null;
    const item = art.hit(this.applied, x, y);
    return item && this.layout.interactions.find(i => i.id === item.id);
  },
  drawScene(ctx, agents, t, state) { art.draw(ctx, this.editor.doc, this.editor.editing ? [] : agents, t, state, this.editor, background); },
  thumbnail(canvas, kind) {
    const preview = createArt(), i = { id: 'preview', kind, x: 0, y: 0, rotation: 0 }, f = footprint(i);
    const p = preview.project(f.w / 2, f.h / 2), h = MATERIALS[kind].h || 5, scale = Math.min(1.4, 80 / (h + (f.w + f.h) * .18));
    const c = canvas.getContext('2d'); c.setTransform(scale, 0, 0, scale, canvas.width / 2 - p.x * scale, 82 - p.y * scale); c.imageSmoothingEnabled = false;
    preview.item(c, i, 0, { night: false, condition: 'clear' });
  },
};
theme.editor = new OfficeEditor(theme, initial);
theme.editor.dirty = !saved;
export default theme;
