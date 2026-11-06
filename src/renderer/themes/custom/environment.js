// 값의 키(auto·clear 등)는 저장되는 로직 값이고, 보이는 글자는 getter 라 언어가 바뀌면 바로 따라간다.
import { t } from '../../../shared/i18n.js';

export const ENVIRONMENT_OPTIONS = {
  weather: { get label() { return t('theme.env.weather'); }, values: { get auto() { return t('theme.env.autoSeoul'); }, get clear() { return t('office.env.clear'); }, get cloudy() { return t('office.env.cloudy'); }, get rain() { return t('office.env.rain'); }, get snow() { return t('office.env.snow'); } } },
  time: { get label() { return t('theme.env.time'); }, values: { get auto() { return t('theme.env.autoSeoul'); }, get day() { return t('office.env.day'); }, get sunset() { return t('office.env.sunset'); }, get night() { return t('office.env.night'); } } },
  lighting: { get label() { return t('theme.env.lighting'); }, values: { get standard() { return t('theme.env.standard'); }, get citypop() { return t('theme.env.citypop'); } } },
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
  const weatherName = ENVIRONMENT_OPTIONS.weather.values[condition] || t('office.env.waiting');
  const light = citypop ? t('theme.env.citypopLight') : '';
  const label = manual ? t('theme.env.manualLabel', { phase: t(night ? 'office.env.night' : sunset ? 'office.env.sunset' : 'office.env.day'), weather: weatherName, light }) : `${actual.label || t('theme.env.seoulWaiting')}${light}`;
  return { ...actual, night, sunset, condition, citypop, label };
}
