const seoulClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const WEATHER_NAMES = { clear: '맑음', cloudy: '흐림', fog: '안개', rain: '비', snow: '눈' };

export class OfficeEnvironment {
  constructor({ now = Date.now } = {}) { this.now = now; this.weather = null; }

  setWeather(weather) { this.weather = weather; this.cachedMinute = null; }

  snapshot() {
    const now = this.now(), minute = Math.floor(now / 60000);
    if (minute === this.cachedMinute) return this.cached;
    this.cachedMinute = minute;
    const clock = seoulClock.format(now), hour = Number(clock.slice(0, 2));
    const night = hour >= 18 || hour < 7;
    const weather = this.weather;
    const available = !!weather?.available && Number.isFinite(weather.observedAt) && now - weather.observedAt <= 3600000;
    const condition = available ? weather.condition : 'unknown';
    const neon = (hour >= 22 || hour < 7) && available && condition !== 'rain';
    const status = available ? `${WEATHER_NAMES[condition] || '확인 중'} · ${Math.round(weather.temperature)}°${weather.stale ? ' · 갱신 지연' : ''}` : '날씨 연결 대기';
    this.cached = { night, neon, condition, cloudCover: available ? weather.cloudCover : 0,
      label: `서울 ${clock} · ${night ? '밤' : '낮'} · ${status}`, weatherAvailable: available };
    return this.cached;
  }
}
