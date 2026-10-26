import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { OfficeEnvironment } from '../src/renderer/office/environment.js';

const { createWeatherService, normalizeWeather } = createRequire(import.meta.url)('../src/main/weather.cjs');
const noon = Date.parse('2026-10-26T12:00:00+09:00');
const response = (changes = {}) => ({ current: { time: '2026-10-26T12:00', weather_code: 0,
  temperature_2m: 14.5, precipitation: 0, snowfall: 0, cloud_cover: 20, ...changes } });

test('서울 시각의 18:00과 07:00에서 낮·밤이 바뀐다', () => {
  let time = Date.parse('2026-10-26T17:59:59+09:00');
  const env = new OfficeEnvironment({ now: () => time });
  assert.equal(env.snapshot().night, false);
  time += 1000;
  assert.equal(env.snapshot().night, true);
  assert.match(env.snapshot().label, /서울 18:00 · 밤/);
  time = Date.parse('2026-10-27T06:59:59+09:00');
  assert.equal(env.snapshot().night, true);
  time += 1000;
  assert.equal(env.snapshot().night, false);
});

test('강수 코드·강수량을 판별하고 눈을 비보다 우선한다', () => {
  for (const code of [51, 55, 61, 65, 66, 80, 82, 95, 99]) assert.equal(normalizeWeather(response({ weather_code: code }), noon).condition, 'rain');
  for (const code of [71, 73, 75, 77, 85, 86]) assert.equal(normalizeWeather(response({ weather_code: code, precipitation: 1 }), noon).condition, 'snow');
  assert.equal(normalizeWeather(response({ snowfall: 0.1, precipitation: 1 }), noon).condition, 'snow');
  assert.equal(normalizeWeather(response({ precipitation: 0.1 }), noon).condition, 'rain');
  assert.equal(normalizeWeather(response({ weather_code: 3 }), noon).condition, 'cloudy');
  assert.equal(normalizeWeather(response({ weather_code: 45 }), noon).condition, 'fog');
});

test('네온 야경은 서울 22시부터 자정을 지나 07시 직전까지 적용된다', () => {
  let time;
  const env = new OfficeEnvironment({ now: () => time });
  for (const [clock, expected] of [['21:59:59', false], ['22:00:00', true], ['23:59:59', true], ['00:00:00', true], ['06:59:59', true], ['07:00:00', false]]) {
    time = Date.parse(`2026-10-26T${clock}+09:00`);
    env.setWeather({ available: true, observedAt: time, condition: 'clear', temperature: 14 });
    assert.equal(env.snapshot().neon, expected, clock);
  }
});

test('같은 분에도 비가 시작되면 네온이 꺼지고 비가 그치면 다시 켜진다', () => {
  let time = Date.parse('2026-10-26T22:30:00+09:00');
  const env = new OfficeEnvironment({ now: () => time });
  for (const condition of ['clear', 'rain', 'cloudy', 'fog', 'snow', 'rain']) {
    env.setWeather({ available: true, observedAt: time, condition, temperature: 14 });
    assert.equal(env.snapshot().neon, condition !== 'rain', condition);
  }
  env.setWeather({ available: true, observedAt: time, condition: 'clear', temperature: 14 });
  time += 61 * 60000;
  assert.equal(env.snapshot().condition, 'unknown');
  assert.equal(env.snapshot().neon, false);
});

test('누락·잘못된 응답과 한 시간 이상 지난 관측은 사용하지 않는다', () => {
  for (const body of [{}, response({ weather_code: null }), response({ temperature_2m: null }), response({ time: 'bad' }),
    response({ time: '2026-10-26T13:00' }), response({ time: '2026-10-26T10:00' })]) {
    assert.throws(() => normalizeWeather(body, noon), /Invalid weather/);
  }
});

test('날씨 호출을 합치고 10분 동안 캐시한다', async () => {
  let time = noon, calls = 0;
  const weather = createWeatherService({ now: () => time, fetcher: async (url, options) => {
    calls++; assert.match(url, /latitude=37.5665/); assert.match(url, /timezone=Asia%2FSeoul/); assert.ok(options.signal);
    return { ok: true, json: async () => response() };
  } });
  const [first, second] = await Promise.all([weather(), weather()]);
  assert.equal(calls, 1); assert.deepEqual(first, second); assert.equal(first.available, true);
  time += 9 * 60000; await weather(); assert.equal(calls, 1);
  time += 60000; await weather(); assert.equal(calls, 2);
});

test('조회 실패 시 최근 관측만 유지하고 한 시간이 지나면 강수를 중지한다', async () => {
  let time = noon, fail = false, calls = 0;
  const weather = createWeatherService({ now: () => time, fetcher: async () => {
    calls++; if (fail) throw new Error('offline');
    return { ok: true, json: async () => response({ weather_code: 61 }) };
  } });
  const env = new OfficeEnvironment({ now: () => time });
  env.setWeather(await weather()); assert.equal(env.snapshot().condition, 'rain');
  fail = true; time += 10 * 60000; env.setWeather(await weather());
  assert.equal(env.snapshot().condition, 'rain'); assert.match(env.snapshot().label, /갱신 지연/);
  await weather(); assert.equal(calls, 2);
  time += 51 * 60000;
  assert.equal(env.snapshot().condition, 'unknown');
  env.setWeather(await weather()); assert.equal(env.snapshot().weatherAvailable, false);
  assert.match(env.snapshot().label, /날씨 연결 대기/);
});

test('첫 호출 HTTP 실패에도 낮·밤은 유지된다', async () => {
  const weather = createWeatherService({ now: () => noon, fetcher: async () => ({ ok: false, status: 503 }) });
  const env = new OfficeEnvironment({ now: () => noon });
  env.setWeather(await weather());
  assert.equal(env.snapshot().night, false); assert.equal(env.snapshot().condition, 'unknown');
});
