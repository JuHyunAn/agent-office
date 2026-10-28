// 엔진 상태를 테마로 그리는 루프. 화면 크기에 맞춰 배치도를 비율 유지로 맞춘다.

const HIT_RADIUS = 20;
// 움직이는 것이 없을 때는 초당 15번만 그린다. 앉아 있는 동작(타이핑 등)은 0.13초마다 바뀌므로 보이는 차이가 없다.
const IDLE_FRAME_MS = 1000 / 15;
const INPUT_ACTIVE_MS = 500;
const SEATED = new Set(['sit', 'type', 'read', 'run']);
import { OfficeCamera } from './camera.js';
import { OfficeLife } from './life.js';
import { OfficeEnvironment } from './environment.js';

export class OfficeView {
  constructor(canvas, engine, theme, { tooltip, onState } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.engine = engine;
    this.theme = theme;
    this.tooltip = tooltip || null;
    this.onState = onState;
    this.camera = new OfficeCamera();
    this.environment = new OfficeEnvironment();
    this.life = theme.createLife ? theme.createLife(theme.layout, engine) : theme.layout.interactions ? new OfficeLife(theme.layout, engine) : null;
    this.view = { scale: 1, ox: 0, oy: 0, dpr: 1 };
    this.last = 0;
    this.running = false;
    this.hoverAt = null;
    this.lastDraw = 0;
    this.lastInputAt = 0;
    this.redraw = true;
    this.resize = this.resize.bind(this);
    this.frame = this.frame.bind(this);
    new ResizeObserver(this.resize).observe(canvas.parentElement);
    const input = () => { this.lastInputAt = performance.now(); };
    for (const type of ['pointerdown', 'pointermove', 'wheel', 'mouseleave']) canvas.addEventListener(type, input, { passive: true });
    canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      this.pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, dragging: false };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
      const r = canvas.getBoundingClientRect();
      this.hoverAt = { x: e.clientX - r.left, y: e.clientY - r.top, cx: e.clientX, cy: e.clientY };
      const p = this.pointer;
      if (p) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) p.dragging = true;
        if (p.dragging) {
          this.camera.pan(e.clientX - p.lastX, e.clientY - p.lastY); this.syncCamera();
          this.hoverAt = null; canvas.style.cursor = this.camera.zoom > 1 ? 'grabbing' : 'default';
        }
        p.lastX = e.clientX; p.lastY = e.clientY;
      } else {
        const point = this.camera.toScene(this.hoverAt.x, this.hoverAt.y);
        canvas.style.cursor = this.theme.hitTest?.(point.x, point.y) ? 'pointer' : this.camera.zoom > 1 ? 'grab' : 'default';
      }
    });
    canvas.addEventListener('pointerup', e => {
      const p = this.pointer; this.pointer = null;
      if (!p || p.id !== e.pointerId) return;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      canvas.style.cursor = this.camera.zoom > 1 ? 'grab' : 'default';
      if (!p.dragging) { const r = canvas.getBoundingClientRect(); this.clickAt(e.clientX - r.left, e.clientY - r.top); }
    });
    canvas.addEventListener('pointercancel', () => { this.pointer = null; canvas.style.cursor = this.camera.zoom > 1 ? 'grab' : 'default'; });
    canvas.addEventListener('lostpointercapture', () => { this.pointer = null; canvas.style.cursor = this.camera.zoom > 1 ? 'grab' : 'default'; });
    canvas.addEventListener('wheel', e => {
      e.preventDefault(); const r = canvas.getBoundingClientRect();
      this.camera.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top); this.syncCamera();
    }, { passive: false });
    canvas.addEventListener('mouseleave', () => { this.hoverAt = null; if (this.tooltip) this.tooltip.hidden = true; });
  }

  // load() 가 실패하면 예외를 그대로 올린다 — 호출자가 이전 테마를 유지한다.
  async setTheme(theme) {
    if (theme.load) await theme.load();
    this.theme.unmount?.();
    const layoutChanged = theme.layout !== this.theme.layout;
    this.theme = theme;
    if (layoutChanged) {
      this.engine.setLayout(theme.layout);
      this.life = theme.createLife ? theme.createLife(theme.layout, this.engine) : theme.layout.interactions ? new OfficeLife(theme.layout, this.engine) : null;
      this.camera = new OfficeCamera();
    }
    this.resize();
    if (this.running) theme.mount?.(this);
  }

  async start() {
    if (this.running) return;
    if (this.theme.load) await this.theme.load();
    this.running = true;
    this.theme.mount?.(this);
    this.resize();
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  resize() {
    const host = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const cw = host.clientWidth;
    const ch = host.clientHeight;
    this.canvas.width = Math.max(1, Math.floor(cw * dpr));
    this.canvas.height = Math.max(1, Math.floor(ch * dpr));
    this.canvas.style.width = `${cw}px`;
    this.canvas.style.height = `${ch}px`;
    const L = this.theme.viewport || this.theme.layout;
    this.camera ||= new OfficeCamera();
    this.camera.resize(cw, ch, L.width, L.height);
    this.view.dpr = dpr;
    this.redraw = true; // 캔버스 크기를 다시 정하면 그림이 지워진다
    this.syncCamera();
  }

  syncCamera() {
    const { scale, ox, oy } = this.camera;
    this.view = { ...this.view, scale, ox, oy };
    this.redraw = true;
    if (!this.pointer?.dragging) this.canvas.style.cursor = this.camera.zoom > 1 ? 'grab' : 'default';
    this.notify();
  }

  zoomBy(factor) { this.camera.zoomAt(factor); this.syncCamera(); }
  // 축소 하한 (기본 100%). 커스터마이징 제작 중에만 낮춰 넓게 보며 배치한다.
  setMinZoom(min) { this.camera.minZoom = min; if (this.camera.zoom < min) this.camera.fit(); this.syncCamera(); }
  fit() { this.camera.fit(); this.syncCamera(); }
  chooseDrink(id) { const chosen = this.life?.chooseDrink(id); this.notify(); return chosen; }
  closeInteractionMenu() { this.life?.closeMenu(); this.notify(); }
  environmentSnapshot() { const actual = this.environment?.snapshot(); return this.theme.resolveEnvironment?.(actual) || actual; }
  focusPlayer() {
    if (!this.life || !this.theme.project) return;
    this.camera.zoomAt(1.8 / this.camera.zoom);
    this.camera.centerOn(this.theme.project(this.life.player.x, this.life.player.y)); this.syncCamera();
  }

  clickAt(x, y) {
    if (this.theme.editor?.editing) return;
    if (!this.life || !this.theme.unproject) return;
    const scene = this.camera.toScene(x, y);
    const item = this.theme.hitTest?.(scene.x, scene.y);
    const success = item ? this.life.interact(item.id) : this.life.moveTo(this.theme.unproject(scene.x, scene.y));
    if (!success) {
      this.life.player.bubble = { text: '이쪽은 지나갈 수 없어요', kind: 'info', until: this.life.time + 2000 };
    }
    this.notify();
  }

  notify(headcount) {
    if (!this.onState) return;
    const state = { zoom: Math.round(this.camera.zoom * 100), minZoom: Math.round(this.camera.minZoom * 100), playerTask: this.life?.player.task || '',
      environment: this.environmentSnapshot(),
      interactionMenu: this.life?.menu || null,
      heldItem: this.life?.player.heldItem ? `${this.life.player.heldItem.label} · ${Math.ceil((this.life.player.heldItem.until - this.life.time) / 1000)}초` : '',
      headcount: headcount ?? this.engine.snapshot().filter(a => a.status !== 'leaving').length };
    const key = JSON.stringify(state);
    if (key !== this.lastState) { this.lastState = key; this.onState(state); }
  }

  frame(now) {
    if (!this.running) return;
    const dt = now - this.last;
    this.last = now;
    try {
      this.engine.update(dt);
      this.life?.update(dt);
      // 움직임이 끝난 프레임도 한 번 더 그려 마지막 위치·자세가 바로 보이게 한다.
      const animating = this.animating(now), finishing = this.wasAnimating;
      this.wasAnimating = animating;
      // 60Hz 에서 4프레임 간격(66.6~66.7ms)이 기준을 아슬하게 못 넘어 5프레임으로 밀리지 않게 여유를 둔다.
      if (this.redraw || animating || finishing || now - this.lastDraw >= IDLE_FRAME_MS - 4) {
        this.redraw = false; this.lastDraw = now;
        this.draw(now);
      }
    } catch (e) {
      // 테마 그리기 오류 하나로 사무실이 멈추지 않게 한다 (같은 오류는 한 번만 기록).
      if (this.lastError !== String(e)) { this.lastError = String(e); console.error('[office]', e); }
    } finally {
      requestAnimationFrame(this.frame);
    }
  }

  // 화면에 움직이는 것이 있으면 매 프레임 그린다 (걷기·문·비/눈·효과·마우스 조작·편집).
  animating(now) {
    if (this.pointer || now - this.lastInputAt < INPUT_ACTIVE_MS || this.theme.editor?.editing) return true;
    if (['rain', 'snow'].includes(this.environmentSnapshot()?.condition)) return true;
    for (const a of this.engine.agents.values()) if (a.path.length) return true;
    const life = this.life;
    if (!life) return false;
    if (life.effects.length || life.destination || life.doors.some(d => d.amount > 0 && d.amount < 1)) return true;
    return [life.player, ...life.residents].some(a => a.path.length);
  }

  draw(t) {
    const { ctx, theme } = this;
    const { scale, ox, oy, dpr } = this.view;
    const L = theme.layout;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = theme.sceneBackground?.(this.environmentSnapshot()) || theme.background || '#17171c';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const backdropDrawn = theme.drawBackdrop?.(ctx, this.canvas.width, this.canvas.height) || false;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);

    const sessions = this.engine.snapshot();
    const agents = [...sessions, ...(this.life?.snapshot() || [])].sort((a, b) => a.y - b.y);
    this.notify(sessions.filter(a => a.status !== 'leaving').length);
    if (theme.drawScene) {
      theme.drawScene(ctx, agents, t, { backdropDrawn, environment: this.environmentSnapshot(), effects: this.life?.effects, destination: this.life?.destination, doors: this.life?.doors, hoveredItem: this.hoverAt ? theme.hitTest?.((this.hoverAt.x - ox) / scale, (this.hoverAt.y - oy) / scale)?.id : null });
      this.updateTooltip(agents);
      return;
    }
    theme.drawBackground(ctx, L, t);
    // 앉은 사람만 책상(전경) 뒤에, 서 있거나 걷는 사람은 앞에 그린다.
    const seated = agents.filter((a) => SEATED.has(a.pose));
    const upright = agents.filter((a) => !SEATED.has(a.pose));
    for (const a of seated) theme.drawAgent(ctx, a, t);
    if (theme.drawForeground) theme.drawForeground(ctx, L, t);
    for (const a of upright) theme.drawAgent(ctx, a, t);
    for (const a of agents) if (a.bubble) theme.drawBubble(ctx, a, a.bubble, t);

    this.updateTooltip(agents);
  }

  updateTooltip(agents) {
    if (!this.tooltip) return;
    if (this.theme.editor?.editing) { this.tooltip.hidden = true; return; }
    if (!this.hoverAt) { this.tooltip.hidden = true; return; }
    const { scale, ox, oy } = this.view;
    const lx = (this.hoverAt.x - ox) / scale;
    const ly = (this.hoverAt.y - oy) / scale;
    let best = null;
    let bestD = this.theme.agentHitRadius || (this.theme.unproject ? 44 : HIT_RADIUS);
    for (const a of agents) {
      const p = this.theme.project ? this.theme.project(a.x, a.y) : a;
      const d = Math.hypot(p.x - lx, p.y - (this.theme.agentHead || (this.theme.unproject ? 60 : this.theme.project ? 28 : 12)) - ly);
      if (d < bestD) { best = a; bestD = d; }
    }
    let content;
    if (best) content = `${best.label} · ${best.isPlayer ? '내 캐릭터' : best.isAmbient ? '상주 캐릭터' : best.sessionLabel || '에이전트'}\n${best.task || '-'}${best.skill ? `\n사용 스킬: ${best.skill}` : ''}\n상태: ${STATUS[best.status] || best.status}`;
    else {
      const item = this.theme.hitTest?.(lx, ly);
      if (item) content = `${item.label}\n${item.description}`;
      else if (this.theme.unproject) {
        const point = this.theme.unproject(lx, ly);
        const entry = Object.entries(this.theme.layout.rooms).find(([, r]) => point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h);
        if (entry) {
          const [key, room] = entry;
          const occupants = agents.filter(a => !a.isPlayer && !a.isAmbient && a.status !== 'leaving' && a.x >= room.x && a.x <= room.x + room.w && a.y >= room.y && a.y <= room.y + room.h);
          content = `${room.label}\n에이전트 ${occupants.length}명`;
          if (key === 'skills') {
            const skills = agents.filter(a => a.skill && a.status !== 'leaving');
            content += skills.length ? '\n' + skills.map(a => `${a.label}: ${a.skill}`).join('\n') : '\n스킬 호출을 기다리고 있어요';
          }
        }
      }
    }
    if (!content) { this.tooltip.hidden = true; return; }
    this.tooltip.hidden = false;
    this.tooltip.textContent = content;
    const width = typeof window === 'undefined' ? 2000 : window.innerWidth;
    const height = typeof window === 'undefined' ? 2000 : window.innerHeight;
    this.tooltip.style.left = `${Math.max(8, Math.min(this.hoverAt.cx + 14, width - 310))}px`;
    this.tooltip.style.top = `${Math.max(8, Math.min(this.hoverAt.cy + 14, height - (this.tooltip.offsetHeight || 100) - 12))}px`;
  }
}

const STATUS = {
  arriving: '출근 중', working: '작업 중', reporting: '보고 중', sharing: '결과 공유 중',
  resting: '휴식 중', away: '잠깐 휴식', idle: '대기', leaving: '퇴근 중',
  walking: '산책 중',
};
