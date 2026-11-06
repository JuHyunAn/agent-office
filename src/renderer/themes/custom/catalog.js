import { t } from '../../../shared/i18n.js';

// 치수는 사무실 바닥 좌표 기준이다. 회전 시 이용 위치도 함께 변환한다.
export const TILE = 192;
export const GRID = 24;
export const ROLES = {
  get lead() { return t('theme.role.lead'); }, get analysis() { return t('theme.role.analysis'); }, get planning() { return t('theme.role.planning'); },
  get dev() { return t('theme.role.dev'); }, get review() { return t('theme.role.review'); }, get skills() { return t('theme.role.skills'); }, get rest() { return t('theme.role.rest'); },
};
export const CATALOG = [
  { kind: 'floor-wood', get label() { return t('theme.mat.floorWood'); }, group: '바닥', w: TILE, d: TILE, color: '#d5b58e' },
  { kind: 'floor-mint', get label() { return t('theme.mat.floorMint'); }, group: '바닥', w: TILE, d: TILE, color: '#a8c9b7' },
  { kind: 'floor-stone', get label() { return t('theme.mat.floorStone'); }, group: '바닥', w: TILE, d: TILE, color: '#bbc2ce' },
  { kind: 'wall', get label() { return t('theme.mat.wall'); }, group: '구조', w: TILE, d: 12, h: 118, color: '#d8d1bb' },
  { kind: 'wall-blue', get label() { return t('theme.mat.wallBlue'); }, group: '구조', w: TILE, d: 12, h: 118, color: '#91b3b0' },
  { kind: 'window', get label() { return t('theme.mat.window'); }, group: '구조', w: TILE, d: 12, h: 118, color: '#d8d1bb' },
  { kind: 'window-grid', get label() { return t('theme.mat.windowGrid'); }, group: '구조', w: TILE, d: 12, h: 118, color: '#798d9e' },
  { kind: 'window-round', get label() { return t('theme.mat.windowRound'); }, group: '구조', w: TILE, d: 12, h: 118, color: '#d6b09a' },
  { kind: 'door', get label() { return t('theme.mat.door'); }, group: '구조', w: TILE, d: 12, h: 118, color: '#92afa8' },
  { kind: 'desk', get label() { return t('theme.mat.desk'); }, group: '가구', w: 144, d: 72, h: 32, color: '#d7b18d', action: 'laptop' },
  { kind: 'round-table', get label() { return t('theme.mat.roundTable'); }, group: '가구', w: 144, d: 120, h: 30, color: '#e0bc96', action: 'collaborate' },
  { kind: 'sofa', get label() { return t('theme.mat.sofa'); }, group: '가구', w: 144, d: 72, h: 42, color: '#75a59a', action: 'sit' },
  { kind: 'chair', get label() { return t('theme.mat.chair'); }, group: '가구', w: 48, d: 48, h: 40, color: '#7999b0', action: 'sit' },
  { kind: 'bookshelf', get label() { return t('theme.mat.bookshelf'); }, group: '가구', w: 96, d: 48, h: 64, color: '#b88c6c', action: 'read' },
  { kind: 'coffee', get label() { return t('theme.mat.coffee'); }, group: '생활', w: 96, d: 72, h: 62, color: '#ba9d83', action: 'brew', menu: 'coffee' },
  { kind: 'vending', get label() { return t('theme.mat.vending'); }, group: '생활', w: 72, d: 72, h: 95, color: '#d78d7f', action: 'drink' },
  { kind: 'arcade', get label() { return t('theme.mat.arcade'); }, group: '생활', w: 72, d: 72, h: 80, color: '#9a8cb9', action: 'arcade' },
  { kind: 'plant', get label() { return t('theme.mat.plant'); }, group: '장식', w: 48, d: 48, h: 60, color: '#8cae74', action: 'water' },
  { kind: 'lamp', get label() { return t('theme.mat.lamp'); }, group: '장식', w: 48, d: 48, h: 90, color: '#e2c481' },
  { kind: 'rug', get label() { return t('theme.mat.rug'); }, group: '장식', w: 192, d: 144, h: 1, color: '#b7a1c2', walkable: true },
  { kind: 'mat', get label() { return t('theme.mat.mat'); }, group: '생활', w: 96, d: 72, h: 1, color: '#8bafbf', action: 'stretch', walkable: true },
  { kind: 'entry', get label() { return t('theme.mat.entry'); }, group: '생활', w: 48, d: 48, h: 2, color: '#e6bf76', walkable: true },
];
export const MATERIALS = Object.fromEntries(CATALOG.map(m => [m.kind, m]));
export const isFloor = item => MATERIALS[item.kind]?.group === '바닥';
export const isWall = item => MATERIALS[item.kind]?.group === '구조';
// group 값(바닥/구조/가구/생활/장식)과 편집기 필터(전체/환경)는 로직 키라 한국어 그대로 두고, 화면에 보이는 글자만 바꾼다.
const GROUP_TEXT = {
  전체: () => t('theme.group.all'), 바닥: () => t('theme.group.floor'), 구조: () => t('theme.group.structure'), 가구: () => t('theme.group.furniture'),
  생활: () => t('theme.group.living'), 장식: () => t('theme.group.decor'), 환경: () => t('theme.group.environment'),
};
export const groupLabel = group => GROUP_TEXT[group]?.() ?? group;
