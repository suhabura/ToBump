import { activityVenuePoint } from '@/lib/types';

export type WeatherForecast = { temp: number; code: number };
export type DailyForecast = { day: string; code: number; max: number; min: number };

const cache = new Map<string, Promise<WeatherForecast | null>>();
const dailyCache = new Map<string, Promise<DailyForecast[]>>();

export function weatherMark(code: number): string {
  if (code === 0) return '☀️';
  if (code === 1) return '🌤️';
  if (code === 2) return '⛅';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if (code >= 95) return '⛈️';
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return '❄️';
  if (code >= 51 && code <= 57) return '🌦️';
  if (code >= 61) return '🌧️';
  return '☁️';
}

export function eventWeatherPoint(
  activity: { show_weather?: boolean | null } & Parameters<typeof activityVenuePoint>[0]
): { latitude: number; longitude: number } | null {
  if (!activity.show_weather) return null;
  return activityVenuePoint(activity);
}

function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function fetchForecast(lat: number, lon: number, start: Date): Promise<WeatherForecast | null> {
  const day = dayKey(start);
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,weather_code&timezone=auto&start_date=${day}&end_date=${day}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = (await res.json()) as {
    hourly?: { time?: string[]; temperature_2m?: Array<number | null>; weather_code?: Array<number | null> };
  };
  const times = json.hourly?.time ?? [];
  const temps = json.hourly?.temperature_2m ?? [];
  const codes = json.hourly?.weather_code ?? [];
  if (!times.length) return null;
  const target = start.getTime();
  let best = 0;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (let i = 0; i < times.length; i++) {
    const at = new Date(times[i]).getTime();
    if (Number.isNaN(at)) continue;
    const diff = Math.abs(at - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  const temp = temps[best];
  const code = codes[best];
  if (temp == null || code == null) return null;
  return { temp: Math.round(temp), code };
}

export function forecastDays(lat: number, lon: number): Promise<DailyForecast[]> {
  const key = `${lat.toFixed(2)}:${lon.toFixed(2)}:7d`;
  const hit = dailyCache.get(key);
  if (hit) return hit;
  const job = fetchDaily(lat, lon).catch(() => []);
  dailyCache.set(key, job);
  return job;
}

async function fetchDaily(lat: number, lon: number): Promise<DailyForecast[]> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=7&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = (await res.json()) as {
    daily?: {
      time?: string[];
      weather_code?: Array<number | null>;
      temperature_2m_max?: Array<number | null>;
      temperature_2m_min?: Array<number | null>;
    };
  };
  const days = json.daily?.time ?? [];
  const codes = json.daily?.weather_code ?? [];
  const highs = json.daily?.temperature_2m_max ?? [];
  const lows = json.daily?.temperature_2m_min ?? [];
  const out: DailyForecast[] = [];
  for (let i = 0; i < days.length; i++) {
    const code = codes[i];
    const max = highs[i];
    const min = lows[i];
    if (!days[i] || code == null || max == null || min == null) continue;
    out.push({ day: days[i].slice(0, 10), code, max: Math.round(max), min: Math.round(min) });
  }
  return out;
}

export function forecastAt(lat: number, lon: number, startsAt: string): Promise<WeatherForecast | null> {
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return Promise.resolve(null);
  const key = `${lat.toFixed(2)}:${lon.toFixed(2)}:${dayKey(start)}:${start.getHours()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const job = fetchForecast(lat, lon, start).catch(() => null);
  cache.set(key, job);
  return job;
}
