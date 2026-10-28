export const ENVIRONMENT_OPTIONS = {
  weather: { label: '날씨', values: { auto: '자동 · 서울', clear: '맑음', cloudy: '흐림', rain: '비', snow: '눈' } },
  time: { label: '낮/밤', values: { auto: '자동 · 서울', day: '낮', sunset: '일몰', night: '밤' } },
  lighting: { label: '분위기 조명', values: { standard: '기본', citypop: '시티팝' } },
};
export function environmentSettings(value) {
  return Object.fromEntries(Object.entries(ENVIRONMENT_OPTIONS).map(([key, option]) => [key, Object.hasOwn(option.values, value?.[key]) ? value[key] : Object.keys(option.values)[0]]));
}
export function resolveEnvironment(doc, actual = {}) {
  const settings = environmentSettings(doc.environment);
  const night = settings.time === 'auto' ? !!actual.night : settings.time === 'night';
  const sunset = !night && (settings.time === 'auto' ? !!actual.sunset : settings.time === 'sunset');
  const condition = settings.weather === 'auto' ? actual.condition : settings.weather;
  const citypop = settings.lighting === 'citypop';
  const manual = settings.time !== 'auto' || settings.weather !== 'auto';
  const weatherName = ENVIRONMENT_OPTIONS.weather.values[condition] || '날씨 연결 대기';
  const label = manual ? `사용자 설정 · ${night ? '밤' : sunset ? '일몰' : '낮'} · ${weatherName}${citypop ? ' · 시티팝 조명' : ''}` : `${actual.label || '서울 · 날씨 연결 대기'}${citypop ? ' · 시티팝 조명' : ''}`;
  return { ...actual, night, sunset, condition, citypop, label };
}
