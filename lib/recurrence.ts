import { format } from 'date-fns';
import { enUS, sl as slLocale } from 'date-fns/locale';

/** ISO weekdays: 1=Monday … 7=Sunday */
export type RecurrenceRule = {
  weekday: number;
  hour: number;
  minute: number;
  /** Duration for this weekday in minutes */
  duration_minutes: number;
};

export type RecurrenceLocale = 'en' | 'sl';

export const WEEKDAY_OPTIONS = [
  { value: 1, short: 'Mo', label: 'Monday' },
  { value: 2, short: 'Tu', label: 'Tuesday' },
  { value: 3, short: 'We', label: 'Wednesday' },
  { value: 4, short: 'Th', label: 'Thursday' },
  { value: 5, short: 'Fr', label: 'Friday' },
  { value: 6, short: 'Sa', label: 'Saturday' },
  { value: 7, short: 'Su', label: 'Sunday' },
] as const;

const WEEKDAY_I18N: Record<RecurrenceLocale, { short: string[]; long: string[] }> = {
  en: {
    short: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    long: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  },
  sl: {
    short: ['Pon', 'Tor', 'Sre', 'Čet', 'Pet', 'Sob', 'Ned'],
    long: ['ponedeljek', 'torek', 'sreda', 'četrtek', 'petek', 'sobota', 'nedelja'],
  },
};

export function weekdayShort(weekday: number, locale: RecurrenceLocale = 'en'): string {
  return WEEKDAY_I18N[locale].short[weekday - 1] ?? `D${weekday}`;
}

export function weekdayLong(weekday: number, locale: RecurrenceLocale = 'en'): string {
  return WEEKDAY_I18N[locale].long[weekday - 1] ?? `Day ${weekday}`;
}

export function isoWeekday(d: Date): number {
  const js = d.getDay(); // 0=Sun
  return js === 0 ? 7 : js;
}

export function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h} h ${m} min`;
  if (h > 0) return `${h} h`;
  return `${m} min`;
}

export function formatRecurrenceDates(dates: string[], locale: RecurrenceLocale = 'en'): string {
  const loc = locale === 'sl' ? slLocale : enUS;
  const unique = Array.from(new Set(dates.filter(Boolean))).sort();
  if (!unique.length) return '';
  return unique
    .map((day) => format(new Date(`${day}T12:00:00`), locale === 'sl' ? 'd. MMM yyyy' : 'd MMM yyyy', { locale: loc }))
    .join(' · ');
}

export function combineDayAndTime(day: string, hours: number, minutes: number): Date {
  const [y, m, d] = day.split('-').map(Number);
  const x = new Date(y, (m || 1) - 1, d || 1, hours, minutes, 0, 0);
  return x;
}

export function formatRecurrence(rules: RecurrenceRule[], locale: RecurrenceLocale = 'en'): string {
  if (!rules?.length) return '';
  const sorted = [...rules].sort((a, b) => a.weekday - b.weekday);
  if (sorted.length === 1) {
    const r = sorted[0];
    const time = formatTime(r.hour, r.minute);
    const dur = formatDuration(r.duration_minutes);
    return locale === 'sl'
      ? `Vsak ${weekdayLong(r.weekday, 'sl')} ob ${time} · ${dur}`
      : `Every ${weekdayLong(r.weekday, 'en')} at ${time} · ${dur}`;
  }
  return sorted
    .map((r) => `${weekdayShort(r.weekday, locale)} ${formatTime(r.hour, r.minute)} (${formatDuration(r.duration_minutes)})`)
    .join(' · ');
}

export function formatFirstOccurrence(d: Date, locale: RecurrenceLocale = 'en'): string {
  const loc = locale === 'sl' ? slLocale : enUS;
  const pattern = locale === 'sl' ? "EEEE, d. MMMM yyyy 'ob' HH:mm" : "EEEE, d MMMM yyyy 'at' HH:mm";
  return format(d, pattern, { locale: loc });
}

export function normalizeRules(rules: RecurrenceRule[]): RecurrenceRule[] {
  const byDay = new Map<number, RecurrenceRule>();
  for (const r of rules) {
    if (r.weekday < 1 || r.weekday > 7) continue;
    const duration = Math.max(15, Math.round((r.duration_minutes || 90) / 15) * 15);
    byDay.set(r.weekday, {
      weekday: r.weekday,
      hour: Math.min(23, Math.max(0, Math.round(r.hour))),
      minute: Math.min(59, Math.max(0, Math.round(r.minute / 15) * 15)),
      duration_minutes: duration,
    });
  }
  return Array.from(byDay.values()).sort((a, b) => a.weekday - b.weekday);
}

/** Stari zapis (brez trajanja na dan) → rules. */
export function rulesFromLegacy(
  weekdays: number[],
  hour: number,
  minute: number,
  durationMinutes = 90
): RecurrenceRule[] {
  return normalizeRules(
    weekdays.map((weekday) => ({
      weekday,
      hour,
      minute,
      duration_minutes: durationMinutes,
    }))
  );
}

/** Dopolni manjkajoče duration_minutes iz fallbacka. */
export function hydrateRules(
  rules: Partial<RecurrenceRule>[] | null | undefined,
  fallbackDuration = 90
): RecurrenceRule[] {
  if (!rules?.length) return [];
  return normalizeRules(
    rules.map((r) => ({
      weekday: Number(r.weekday),
      hour: Number(r.hour),
      minute: Number(r.minute),
      duration_minutes: Number(r.duration_minutes) || fallbackDuration,
    }))
  );
}

function startOfLocalDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * First matching slot on or after `from` (local timezone), using each day's own time.
 * Skips slots more than 30s in the past. Respects optional series end date.
 */
export function firstOccurrence(
  from: Date,
  rules: RecurrenceRule[],
  opts?: { now?: Date; until?: Date | null }
): Date | null {
  const normalized = normalizeRules(rules);
  if (!normalized.length) return null;
  const byDay = new Map(normalized.map((r) => [r.weekday, r]));
  const now = opts?.now ?? new Date();
  const untilDay = opts?.until ? startOfLocalDay(opts.until) : null;
  const startDay = startOfLocalDay(from);

  for (let i = 0; i < 400; i++) {
    const day = new Date(startDay);
    day.setDate(startDay.getDate() + i);
    if (untilDay && day.getTime() > untilDay.getTime()) return null;
    const rule = byDay.get(isoWeekday(day));
    if (!rule) continue;
    const slot = new Date(day);
    slot.setHours(rule.hour, rule.minute, 0, 0);
    if (untilDay && startOfLocalDay(slot).getTime() > untilDay.getTime()) return null;
    if (slot.getTime() >= now.getTime() - 30_000) return slot;
  }
  return null;
}

export function ruleTimeAsDate(rule: RecurrenceRule): Date {
  const d = new Date();
  d.setHours(rule.hour, rule.minute, 0, 0);
  return d;
}

export function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export type SeriesSlot = {
  seriesId: string;
  day: string;
  startsAt: Date;
  durationMinutes: number;
};

type ExpandableActivity = {
  id: string;
  series_id?: string | null;
  is_recurring?: boolean;
  starts_at: string;
  ends_at?: string | null;
  duration_minutes?: number | null;
  recurrence_rules?: Partial<RecurrenceRule>[] | null;
  recurrence_weekdays?: number[];
  recurrence_until?: string | null;
  recurrence_dates?: string[];
};

export function isDateSeries(activity: Pick<ExpandableActivity, 'recurrence_dates'>): boolean {
  return (activity.recurrence_dates?.length ?? 0) >= 2;
}

export function isSeriesActivity(activity: ExpandableActivity): boolean {
  if (isDateSeries(activity)) return true;
  if (!activity.is_recurring) return false;
  const rules = hydrateRules(activity.recurrence_rules, activity.duration_minutes ?? 90);
  return rules.length > 0 || (activity.recurrence_weekdays?.length ?? 0) > 0;
}

/** Future slots in [rangeStart, rangeEnd] (local), excluding skipped YYYY-MM-DD days. */
export function expandSeriesSlots(
  activity: ExpandableActivity,
  rangeStart: Date,
  rangeEnd: Date,
  skipped: Set<string> = new Set()
): SeriesSlot[] {
  const seriesId = activity.series_id ?? activity.id;
  const seed = new Date(activity.starts_at);
  if (Number.isNaN(seed.getTime())) return [];
  const fallbackDuration =
    activity.duration_minutes && activity.duration_minutes > 0
      ? activity.duration_minutes
      : activity.ends_at
        ? Math.max(15, Math.round((new Date(activity.ends_at).getTime() - seed.getTime()) / 60_000))
        : 90;
  const from = startOfLocalDay(rangeStart);
  const to = startOfLocalDay(rangeEnd);
  const now = Date.now() - 30_000;
  const out: SeriesSlot[] = [];

  if (isDateSeries(activity)) {
    for (const day of activity.recurrence_dates ?? []) {
      if (skipped.has(day)) continue;
      const start = combineDayAndTime(day, seed.getHours(), seed.getMinutes());
      if (start.getTime() < now) continue;
      const key = localDayKey(start);
      if (startOfLocalDay(start) < from || startOfLocalDay(start) > to) continue;
      out.push({ seriesId, day: key, startsAt: start, durationMinutes: fallbackDuration });
    }
    return out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  }

  if (!activity.is_recurring) return out;
  const rules = hydrateRules(
    activity.recurrence_rules?.length
      ? activity.recurrence_rules
      : rulesFromLegacy(activity.recurrence_weekdays ?? [], seed.getHours(), seed.getMinutes(), fallbackDuration),
    fallbackDuration
  );
  if (!rules.length) return out;
  const byDay = new Map(rules.map((r) => [r.weekday, r]));
  const untilDay = activity.recurrence_until ? startOfLocalDay(new Date(`${activity.recurrence_until}T12:00:00`)) : null;

  for (let cursor = new Date(from); cursor.getTime() <= to.getTime(); cursor.setDate(cursor.getDate() + 1)) {
    const day = startOfLocalDay(cursor);
    if (untilDay && day.getTime() > untilDay.getTime()) break;
    const key = localDayKey(day);
    if (skipped.has(key)) continue;
    const rule = byDay.get(isoWeekday(day));
    if (!rule) continue;
    const start = new Date(day);
    start.setHours(rule.hour, rule.minute, 0, 0);
    if (start.getTime() < now) continue;
    out.push({ seriesId, day: key, startsAt: start, durationMinutes: rule.duration_minutes });
  }
  return out;
}
