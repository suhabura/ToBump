/** ISO weekdays: 1=Monday … 7=Sunday */
export type RecurrenceRule = {
  weekday: number;
  hour: number;
  minute: number;
  /** Duration for this weekday in minutes */
  duration_minutes: number;
};

export const WEEKDAY_OPTIONS = [
  { value: 1, short: 'Mo', label: 'Monday' },
  { value: 2, short: 'Tu', label: 'Tuesday' },
  { value: 3, short: 'We', label: 'Wednesday' },
  { value: 4, short: 'Th', label: 'Thursday' },
  { value: 5, short: 'Fr', label: 'Friday' },
  { value: 6, short: 'Sa', label: 'Saturday' },
  { value: 7, short: 'Su', label: 'Sunday' },
] as const;

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

export function formatRecurrence(rules: RecurrenceRule[]): string {
  if (!rules?.length) return '';
  const parts = [...rules]
    .sort((a, b) => a.weekday - b.weekday)
    .map((r) => {
      const day = WEEKDAY_OPTIONS.find((w) => w.value === r.weekday)?.label ?? `Day ${r.weekday}`;
      return `${day} ${formatTime(r.hour, r.minute)} (${formatDuration(r.duration_minutes)})`;
    });
  if (parts.length === 1) return `Every ${parts[0]}`;
  return `Every ${parts.join(' · ')}`;
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
