import { activityVenuePoint } from '@/lib/types';

export type WeatherForecast = { temp: number; code: number };

const cache = new Map<string, Promise<WeatherForecast | null>>();

export function weatherIcon(code: number): 'sun-o' | 'cloud' | 'umbrella' {
  if (code <= 1) return 'sun-o';
  if (code >= 51) return 'umbrella';
  return 'cloud';
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
