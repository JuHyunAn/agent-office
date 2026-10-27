import { parseDocument } from './model.js';
export const STORAGE_KEY = 'ao.custom-office.v1';
export function readOffice(storage) {
  const raw = storage.getItem(STORAGE_KEY);
  return raw ? parseDocument(JSON.parse(raw)) : null;
}
export function saveOffice(storage, document) {
  const safe = parseDocument(document);
  storage.setItem(STORAGE_KEY, JSON.stringify(safe));
}
export async function importBackground(file) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('PNG·JPG·WebP 이미지를 골라 주세요.');
  if (file.size > 12 * 1024 * 1024) throw new Error('이미지는 12MB 이하로 골라 주세요.');
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 32000000) throw new Error('이미지 해상도가 너무 커요. 3,200만 화소 이하로 줄여 주세요.');
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/webp', .84);
    if (data.length > 1900000) throw new Error('저장할 이미지가 너무 커요. 조금 더 작은 이미지를 골라 주세요.');
    return data;
  } finally { bitmap.close(); }
}
