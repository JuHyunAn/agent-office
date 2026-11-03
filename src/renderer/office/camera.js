// 전체 보기(100%)는 가로를 채운다. 아주 넓은 화면에서 위아래가 너무 잘리지 않게 세로 맞춤의 116% 에서 멈춘다.
// 세로로 긴 화면은 위아래가 비지 않게 세로에 맞추고, 넘치는 양옆은 드래그로 본다.
const FIT_FILL = 1.16;

export class OfficeCamera {
  constructor() { this.zoom = 1; this.minZoom = 1; this.scale = 1; this.ox = 0; this.oy = 0; this.cw = 1; this.ch = 1; }

  resize(cw, ch, width, height) {
    const center = this.width ? this.toScene(this.cw / 2, this.ch / 2) : { x: width / 2, y: height / 2 };
    Object.assign(this, { cw, ch, width, height });
    this.base = Math.max(Math.min(cw / width, (ch / height) * FIT_FILL), ch / height);
    this.scale = this.base * this.zoom;
    this.ox = cw / 2 - center.x * this.scale; this.oy = ch / 2 - center.y * this.scale;
    this.clamp();
  }

  fit() { this.zoom = 1; this.scale = this.base; this.ox = (this.cw - this.width * this.scale) / 2; this.clamp(); }
  // 드래그로 옮길 수 있는가: 확대했거나, 전체 보기에서 양옆이 넘칠 때
  get canPan() { return this.zoom > 1 || this.width * this.scale > this.cw + 0.5; }
  toScene(x, y) { return { x: (x - this.ox) / this.scale, y: (y - this.oy) / this.scale }; }
  pan(dx, dy) { this.ox += dx; this.oy += dy; this.clamp(); }

  zoomAt(factor, x = this.cw / 2, y = this.ch / 2) {
    const p = this.toScene(x, y);
    this.zoom = Math.max(this.minZoom, Math.min(4, this.zoom * factor));
    this.scale = this.base * this.zoom;
    this.ox = x - p.x * this.scale; this.oy = y - p.y * this.scale;
    this.clamp();
  }

  centerOn(p) { this.ox = this.cw / 2 - p.x * this.scale; this.oy = this.ch / 2 - p.y * this.scale; this.clamp(); }
  clamp() {
    const w = this.width * this.scale, h = this.height * this.scale;
    this.ox = w <= this.cw ? (this.cw - w) / 2 : Math.max(this.cw - w, Math.min(0, this.ox));
    // 전체 보기는 세로를 고정한다. 세로가 넘치면 사무실 위쪽을 맞추고 아래로 이어지는 외벽 쪽만 잘리게 한다.
    if (this.zoom <= 1) { this.oy = h <= this.ch ? (this.ch - h) / 2 : 0; return; }
    this.oy = h <= this.ch ? (this.ch - h) / 2 : Math.max(this.ch - h, Math.min(0, this.oy));
  }
}
