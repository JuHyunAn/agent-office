export class OfficeCamera {
  constructor() { this.zoom = 1; this.scale = 1; this.ox = 0; this.oy = 0; this.cw = 1; this.ch = 1; }

  resize(cw, ch, width, height) {
    const center = this.width ? this.toScene(this.cw / 2, this.ch / 2) : { x: width / 2, y: height / 2 };
    Object.assign(this, { cw, ch, width, height });
    this.base = Math.min(cw / width, ch / height);
    this.scale = this.base * this.zoom;
    this.ox = cw / 2 - center.x * this.scale; this.oy = ch / 2 - center.y * this.scale;
    this.clamp();
  }

  fit() { this.zoom = 1; this.scale = this.base; this.ox = (this.cw - this.width * this.scale) / 2; this.oy = (this.ch - this.height * this.scale) / 2; }
  toScene(x, y) { return { x: (x - this.ox) / this.scale, y: (y - this.oy) / this.scale }; }
  pan(dx, dy) { this.ox += dx; this.oy += dy; this.clamp(); }

  zoomAt(factor, x = this.cw / 2, y = this.ch / 2) {
    const p = this.toScene(x, y);
    this.zoom = Math.max(1, Math.min(4, this.zoom * factor));
    this.scale = this.base * this.zoom;
    this.ox = x - p.x * this.scale; this.oy = y - p.y * this.scale;
    this.clamp();
  }

  centerOn(p) { this.ox = this.cw / 2 - p.x * this.scale; this.oy = this.ch / 2 - p.y * this.scale; this.clamp(); }
  clamp() {
    const w = this.width * this.scale, h = this.height * this.scale;
    this.ox = w <= this.cw ? (this.cw - w) / 2 : Math.max(this.cw - w, Math.min(0, this.ox));
    this.oy = h <= this.ch ? (this.ch - h) / 2 : Math.max(this.ch - h, Math.min(0, this.oy));
  }
}
