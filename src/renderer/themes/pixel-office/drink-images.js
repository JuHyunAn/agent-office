import { DRINKS } from '../../office/drinks.js';

const images = new Map();
let loading;

export function loadDrinkImages() {
  if (!loading) loading = Promise.all(DRINKS.map(drink => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      try {
        const source = document.createElement('canvas'); source.width = image.naturalWidth; source.height = image.naturalHeight;
        const c = source.getContext('2d', { willReadFrequently: true }); c.drawImage(image, 0, 0);
        const pixels = c.getImageData(0, 0, source.width, source.height).data;
        let left = source.width, top = source.height, right = -1, bottom = -1;
        for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
          if (pixels[(y * source.width + x) * 4 + 3] < 8) continue;
          left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
        }
        if (right < left) { reject(new Error(`Empty drink image: ${drink.id}`)); return; }
        const w = right - left + 1, h = bottom - top + 1, scale = Math.min(96 / w, 128 / h);
        const sprite = document.createElement('canvas'); sprite.width = Math.ceil(w * scale); sprite.height = Math.ceil(h * scale);
        sprite.getContext('2d').drawImage(image, left, top, w, h, 0, 0, sprite.width, sprite.height);
        images.set(drink.id, sprite); resolve();
      } catch (error) { reject(error); }
    };
    image.onerror = () => reject(new Error(`Cannot load drink image: ${drink.id}`));
    image.src = drink.image;
  }))).catch(error => { loading = null; throw error; });
  return loading;
}

export function drawDrinkImage(ctx, id, x, y, maxWidth = 16, maxHeight = 17) {
  const image = images.get(id);
  if (!image) return false;
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
  const w = image.width * scale, h = image.height * scale;
  ctx.save(); ctx.imageSmoothingEnabled = true;
  ctx.drawImage(image, x, y + maxHeight - h, w, h);
  ctx.restore();
  return true;
}
