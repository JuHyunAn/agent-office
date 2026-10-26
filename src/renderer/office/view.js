// 엔진 상태를 테마로 그리는 루프. 화면 크기에 맞춰 배치도를 비율 유지로 맞춘다.

const HIT_RADIUS = 20;
const SEATED = new Set(['sit', 'type', 'read', 'run']);

export class OfficeView {
  constructor(canvas, engine, theme, { tooltip } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.engine = engine;
    this.theme = theme;
    this.tooltip = tooltip || null;
    this.view = { scale: 1, ox: 0, oy: 0, dpr: 1 };
    this.last = 0;
    this.running = false;
    this.hoverAt = null;
    this.resize = this.resize.bind(this);
    this.frame = this.frame.bind(this);
    new ResizeObserver(this.resize).observe(canvas.parentElement);
    canvas.addEventListener('mousemove', (e) => { this.hoverAt = { x: e.offsetX, y: e.offsetY, cx: e.clientX, cy: e.clientY }; });
    canvas.addEventListener('mouseleave', () => { this.hoverAt = null; if (this.tooltip) this.tooltip.hidden = true; });
  }

  // load() 가 실패하면 예외를 그대로 올린다 — 호출자가 이전 테마를 유지한다.
  async setTheme(theme) {
    if (theme.load) await theme.load();
    this.theme = theme;
    this.engine.setLayout(theme.layout);
    this.resize();
  }

  async start() {
    if (this.running) return;
    if (this.theme.load) await this.theme.load();
    this.running = true;
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
    const L = this.theme.layout;
    const scale = Math.min(cw / L.width, ch / L.height);
    this.view = { scale, ox: (cw - L.width * scale) / 2, oy: (ch - L.height * scale) / 2, dpr };
  }

  frame(now) {
    if (!this.running) return;
    const dt = now - this.last;
    this.last = now;
    try {
      this.engine.update(dt);
      this.draw(now);
    } catch (e) {
      // 테마 그리기 오류 하나로 사무실이 멈추지 않게 한다 (같은 오류는 한 번만 기록).
      if (this.lastError !== String(e)) { this.lastError = String(e); console.error('[office]', e); }
    } finally {
      requestAnimationFrame(this.frame);
    }
  }

  draw(t) {
    const { ctx, theme } = this;
    const { scale, ox, oy, dpr } = this.view;
    const L = theme.layout;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#17171c';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);

    const agents = this.engine.snapshot().sort((a, b) => a.y - b.y);
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
    if (!this.hoverAt) { this.tooltip.hidden = true; return; }
    const { scale, ox, oy } = this.view;
    const lx = (this.hoverAt.x - ox) / scale;
    const ly = (this.hoverAt.y - oy) / scale;
    let best = null;
    let bestD = HIT_RADIUS;
    for (const a of agents) {
      const d = Math.hypot(a.x - lx, a.y - 12 - ly);
      if (d < bestD) { best = a; bestD = d; }
    }
    if (!best) { this.tooltip.hidden = true; return; }
    this.tooltip.hidden = false;
    this.tooltip.textContent = `${best.label}${best.isLead ? '' : ` · ${best.sessionLabel}`}\n${best.task || '-'}\n상태: ${STATUS[best.status] || best.status}`;
    this.tooltip.style.left = `${this.hoverAt.cx + 14}px`;
    this.tooltip.style.top = `${this.hoverAt.cy + 14}px`;
  }
}

const STATUS = {
  arriving: '출근 중', working: '작업 중', reporting: '보고 중', sharing: '결과 공유 중',
  resting: '휴식 중', away: '잠깐 휴식', idle: '대기', leaving: '퇴근 중',
};
