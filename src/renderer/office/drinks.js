const image = id => new URL(`../assets/drinks/${id}.png`, import.meta.url).href;

// The menu and carried item share one image, including non-coffee drinks.
export const DRINKS = [
  { id: 'americano', label: '아메리카노', image: image('americano'), color: '#f1dfbd', liquid: '#654634', iced: false },
  { id: 'latte', label: '카페 라테', image: image('latte'), color: '#a5cbb9', liquid: '#c9a377', iced: false },
  { id: 'cappuccino', label: '카푸치노', image: image('cappuccino'), color: '#d7a8b6', liquid: '#efdbb3', iced: false },
  { id: 'iced-latte', label: '아이스 라테', image: image('iced-latte'), color: '#99c9df', liquid: '#b88a63', iced: true },
  { id: 'lemonade', label: '레몬에이드', image: image('lemonade'), color: '#e8d882', liquid: '#e9d286', iced: true },
  { id: 'soda', label: '오렌지 소다', image: image('soda'), color: '#e5a267', liquid: '#db8b46', iced: true },
];
