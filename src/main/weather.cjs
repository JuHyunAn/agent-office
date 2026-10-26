'use strict';

const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=37.5665&longitude=126.9780&current=temperature_2m,weather_code,precipitation,snowfall,cloud_cover&timezone=Asia%2FSeoul';
const REFRESH_MS = 10 * 60 * 1000;
const MAX_AGE_MS = 60 * 60 * 1000;

function normalizeWeather(body, now) {
  const c = body?.current;
  const observedAt = Date.parse(`${c?.time}+09:00`);
  if (!Number.isFinite(observedAt) || observedAt > now + 5 * 60000 || now - observedAt > MAX_AGE_MS
    || !Number.isInteger(c?.weather_code) || c.weather_code < 0 || c.weather_code > 99
    || !Number.isFinite(c.temperature_2m) || !Number.isFinite(c.precipitation)
    || !Number.isFinite(c.snowfall) || !Number.isFinite(c.cloud_cover)) throw new Error('Invalid weather response');
  const code = c.weather_code;
  const snow = c.snowfall > 0 || [71, 73, 75, 77, 85, 86].includes(code);
  const rain = c.precipitation > 0 || [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(code);
  return { location: '서울', observedAt, fetchedAt: now, temperature: c.temperature_2m,
    cloudCover: Math.max(0, Math.min(100, c.cloud_cover)),
    condition: snow ? 'snow' : rain ? 'rain' : code === 45 || code === 48 ? 'fog' : code >= 2 ? 'cloudy' : 'clear' };
}

function createWeatherService({ fetcher = fetch, now = Date.now } = {}) {
  let cached = null, nextFetch = 0, pending = null, failed = false;
  const result = () => ({ ...cached, location: '서울', available: !!cached && now() - cached.observedAt <= MAX_AGE_MS,
    stale: failed || !cached || now() - cached.observedAt > MAX_AGE_MS });
  return async function getWeather() {
    if (pending) return pending;
    if (now() < nextFetch) return result();
    pending = (async () => {
      try {
        const response = await fetcher(WEATHER_URL, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error(`Weather HTTP ${response.status}`);
        cached = normalizeWeather(await response.json(), now());
        failed = false;
        nextFetch = now() + REFRESH_MS;
      } catch {
        failed = true;
        nextFetch = now() + 60000;
      }
      return result();
    })();
    try { return await pending; } finally { pending = null; }
  };
}

module.exports = { createWeatherService, normalizeWeather };
