import {
  addDays,
  addMonths,
  endOfMonth,
  endOfWeek,
  format,
  isBefore,
  isSameDay,
  isSameMonth,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';
import { enUS, sl as slLocale } from 'date-fns/locale';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Chip, Muted } from '@/components/ui';
import { theme } from '@/constants/theme';
import { useLocale } from '@/i18n';

function dayKey(d: Date): string {
  return format(startOfDay(d), 'yyyy-MM-dd');
}

function buildCalendarDays(month: Date): Date[] {
  const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
  const end = endOfWeek(endOfMonth(month), { weekStartsOn: 1 });
  const days: Date[] = [];
  let cur = start;
  while (cur <= end) {
    days.push(cur);
    cur = addDays(cur, 1);
  }
  return days;
}

type Props = {
  selected: string[];
  onChange: (days: string[]) => void;
  hint?: string;
  /** These days stay selected and cannot be removed here. */
  lockedDays?: string[];
};

export function DateMultiField({ selected, onChange, hint, lockedDays = [] }: Props) {
  const { locale } = useLocale();
  const dfLocale = locale === 'sl' ? slLocale : enUS;
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const days = useMemo(() => buildCalendarDays(month), [month]);
  const weekLabels = useMemo(
    () => days.slice(0, 7).map((d) => format(d, 'EEEEEE', { locale: dfLocale })),
    [days, dfLocale]
  );
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const lockedSet = useMemo(() => new Set(lockedDays), [lockedDays]);
  const today = startOfDay(new Date());

  function toggle(day: Date) {
    const key = dayKey(day);
    if (isBefore(startOfDay(day), today)) return;
    if (lockedSet.has(key)) return;
    if (selectedSet.has(key)) onChange(selected.filter((d) => d !== key));
    else onChange([...selected, key].sort());
  }

  return (
    <View>
      <View style={styles.calCard}>
        <View style={styles.monthRow}>
          <Pressable onPress={() => setMonth((m) => subMonths(m, 1))} style={styles.monthBtn}>
            <Text style={styles.monthBtnText}>‹</Text>
          </Pressable>
          <Text style={styles.monthLabel}>{format(month, 'LLLL yyyy', { locale: dfLocale })}</Text>
          <Pressable onPress={() => setMonth((m) => addMonths(m, 1))} style={styles.monthBtn}>
            <Text style={styles.monthBtnText}>›</Text>
          </Pressable>
        </View>
        <View style={styles.weekHeader}>
          {weekLabels.map((label, i) => (
            <Text key={`${label}-${i}`} style={styles.weekDay}>
              {label}
            </Text>
          ))}
        </View>
        <View style={styles.grid}>
          {days.map((day) => {
            const inMonth = isSameMonth(day, month);
            const key = dayKey(day);
            const picked = selectedSet.has(key);
            const past = isBefore(startOfDay(day), today);
            const isToday = isSameDay(day, today);
            return (
              <Pressable
                key={day.toISOString()}
                disabled={past}
                onPress={() => toggle(day)}
                style={[
                  styles.dayCell,
                  picked && styles.daySelected,
                  isToday && !picked && styles.dayToday,
                  past && styles.dayPast,
                ]}>
                <Text
                  style={[
                    styles.dayText,
                    !inMonth && styles.dayMuted,
                    picked && styles.dayTextSelected,
                    past && styles.dayMuted,
                  ]}>
                  {format(day, 'd')}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      {hint ? <Muted>{hint}</Muted> : null}
      {selected.length ? (
        <View style={styles.chips}>
          {selected.map((key) => {
            const d = new Date(`${key}T12:00:00`);
            const locked = lockedSet.has(key);
            return (
              <Chip
                key={key}
                label={locked ? format(d, 'd. MMM', { locale: dfLocale }) : `${format(d, 'd. MMM', { locale: dfLocale })} ×`}
                active
                onPress={() => {
                  if (locked) return;
                  onChange(selected.filter((x) => x !== key));
                }}
              />
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  calCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.space.md,
    marginBottom: theme.space.sm,
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    ...theme.shadow.card,
  },
  monthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  monthBtn: { padding: 8, minWidth: 40, alignItems: 'center' },
  monthBtnText: { fontSize: 24, color: theme.colors.primary, fontWeight: '600' },
  monthLabel: {
    flex: 1,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '700',
    color: theme.colors.text,
    textTransform: 'capitalize',
  },
  weekHeader: { flexDirection: 'row', marginBottom: 4 },
  weekDay: {
    flex: 1,
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '700',
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  dayCell: {
    width: '14.28%',
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
  },
  daySelected: { backgroundColor: theme.colors.primary },
  dayToday: { borderWidth: 1.5, borderColor: theme.colors.primary },
  dayPast: { opacity: 0.35 },
  dayText: { fontSize: 15, color: theme.colors.text, fontWeight: '600' },
  dayMuted: { color: theme.colors.textMuted, fontWeight: '500' },
  dayTextSelected: { color: '#fff', fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: theme.space.md },
});
