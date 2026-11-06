import { t, getLang } from '../../shared/i18n.js';

const seoulClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const WEATHER_KEYS = { clear: 'office.env.clear', cloudy: 'office.env.cloudy', fog: 'office.env.fog', rain: 'office.env.rain', snow: 'office.env.snow' };

export class OfficeEnvironment {
  constructor({ now = Date.now } = {}) { this.now = now; this.weather = null; }

  setWeather(weather) { this.weather = weather; this.cachedMinute = null; }

  snapshot() {
    const now = this.now(), minute = Math.floor(now / 60000);
    const lang = getLang();
    if (minute === this.cachedMinute && lang === this.cachedLang) return this.cached; // 언어가 바뀌면 문구를 다시 만든다
    this.cachedMinute = minute; this.cachedLang = lang;
    const clock = seoulClock.format(now), hour = Number(clock.slice(0, 2));
    const night = hour >= 18 || hour < 7;
    const sunset = hour >= 15 && hour < 18;
    const weather = this.weather;
    const available = !!weather?.available && Number.isFinite(weather.observedAt) && now - weather.observedAt <= 3600000;
    const condition = available ? weather.condition : 'unknown';
    const status = available ? t('office.env.weather', { name: t(WEATHER_KEYS[condition] || 'office.env.checking'), temp: Math.round(weather.temperature), stale: weather.stale ? t('office.env.stale') : '' }) : t('office.env.waiting');
    this.cached = { night, sunset, neon: false, condition, cloudCover: available ? weather.cloudCover : 0,
      label: t('office.env.label', { clock, phase: t(night ? 'office.env.night' : sunset ? 'office.env.sunset' : 'office.env.day'), status }), weatherAvailable: available };
    return this.cached;
  }
}
