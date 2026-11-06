import { t } from '../../shared/i18n.js';

const image = id => new URL(`../assets/drinks/${id}.png`, import.meta.url).href;

// The menu and carried item share one image, including non-coffee drinks.
// label 은 getter 라 언어가 바뀌면 메뉴·들고 있는 컵 표시가 바로 따라간다(복사하면 그 시점 값).
export const DRINKS = [
  { id: 'americano', get label() { return t('office.drink.americano'); }, image: image('americano'), color: '#f1dfbd', liquid: '#654634', iced: false },
  { id: 'latte', get label() { return t('office.drink.latte'); }, image: image('latte'), color: '#a5cbb9', liquid: '#c9a377', iced: false },
  { id: 'cappuccino', get label() { return t('office.drink.cappuccino'); }, image: image('cappuccino'), color: '#d7a8b6', liquid: '#efdbb3', iced: false },
  { id: 'iced-latte', get label() { return t('office.drink.icedLatte'); }, image: image('iced-latte'), color: '#99c9df', liquid: '#b88a63', iced: true },
  { id: 'lemonade', get label() { return t('office.drink.lemonade'); }, image: image('lemonade'), color: '#e8d882', liquid: '#e9d286', iced: true },
  { id: 'soda', get label() { return t('office.drink.soda'); }, image: image('soda'), color: '#e5a267', liquid: '#db8b46', iced: true },
];
