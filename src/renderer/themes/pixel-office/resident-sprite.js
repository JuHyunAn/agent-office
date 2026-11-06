import { ROWS, CELL } from '../../pet/model.js';
import { drawDrinkImage } from './drink-images.js';
import { t } from '../../../shared/i18n.js';

const KINDS = new Set(['grok', 'muse', 'antigravity']);
const images = new Map();
let loading;

export function loadResidentSprites() {
  if (!loading) loading = Promise.all([...KINDS].map(async kind => {
    const load = name => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(t('theme.err.spriteLoad', { path: `${kind}/${name}` })));
      image.src = new URL(`../../assets/pets/office-${kind}/${name}.png`, import.meta.url).href;
    });
    const [sheet, sleep, poses] = await Promise.all(['spritesheet', 'sleep', 'poses'].map(load));
    images.set(kind, { sheet, sleep, poses });
  })).catch(error => { loading = null; throw error; });
  return loading;
}

// 바탕화면의 기본 이미지 대체 표시에 쓴다. 사무실은 companion-sprite의 정수 도트로 그린다.
export function residentState(a) {
  if (a.pose === 'walk') return a.facing === 'left' || a.facing === 'up' ? 'running-left' : 'running-right';
  if (a.status === 'error') return 'failed';
  if (a.pose === 'sleep' || a.status === 'away') return 'sleeping';
  if (a.pose === 'alert' || a.status === 'waiting') return 'waiting';
  if (a.pose === 'talk' || a.status === 'reporting' || a.status === 'sharing') return 'waving';
  if (['type', 'run', 'play'].includes(a.pose)) return 'running';
  if (['read', 'sit'].includes(a.pose)) return 'review';
  if (a.pose === 'stretch') return 'jumping';
  return 'idle';
}

export function drawResidentCharacter(ctx, a, t, x, y) {
  if (!KINDS.has(a.cli)) return false;
  const art = images.get(a.cli);
  if (!art) return false; // 읽히기 전에는 기존 벡터 그림으로 대체한다.
  const state = residentState(a), def = ROWS[state];
  const total = def.ms.reduce((sum, ms) => sum + ms, 0);
  let time = ((t + (a.colorIndex || 0) * 137) % total + total) % total, frame = 0;
  while (time >= def.ms[frame]) time -= def.ms[frame++];
  const seated = ['sit', 'type', 'read', 'run'].includes(a.pose);
  ctx.save(); ctx.translate(Math.round(x), Math.round(y) - (seated ? 12 : 0));
  ctx.imageSmoothingEnabled = false;
  const wake = a.pose === 'stretch';
  ctx.drawImage(wake ? art.poses : state === 'sleeping' ? art.sleep : art.sheet,
    wake ? 3 * CELL.width : frame * CELL.width, wake ? 2 * CELL.height : (def.row || 0) * CELL.height,
    CELL.width, CELL.height, -16, -194 / 6, 32, CELL.height / 6);
  // 생활 소품은 캐릭터 외형과 분리해 받은 음료와 사용 기한을 그대로 반영한다.
  const sip = a.pose === 'drink' ? Math.round(Math.sin(t / 240) * 2) : 0;
  if (a.heldItem || a.pose === 'drink') drawDrinkImage(ctx, a.heldItem?.id || 'americano', 7, -17 + sip, 8, 10);
  if (a.pose === 'brew') {
    ctx.fillStyle = '#eee7d2'; ctx.fillRect(8, -12, 6, 6);
    ctx.fillStyle = '#ab7451'; ctx.fillRect(9, -12, 4, 1);
  } else if (a.pose === 'water') {
    ctx.fillStyle = '#6cafaf'; ctx.fillRect(7, -12, 7, 5); ctx.fillRect(13, -10, 4, 2);
    ctx.fillStyle = '#b5e0ef'; ctx.fillRect(17, -7 + Math.floor(t / 160) % 3, 1, 2);
  }
  ctx.restore(); return true;
}
