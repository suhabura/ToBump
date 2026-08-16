import {
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  startOfDay,
  addDays,
  addMonths,
  subMonths,
  isSameDay,
  isSameMonth,
  isBefore,
  setHours,
  setMinutes,
  setSeconds,
  setMilliseconds,
} from 'date-fns';
import { enUS } from 'date-fns/locale';
import { useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { theme } from '@/constants/theme';
import { useT } from '@/i18n';

const MINUTE_STEP = 15;

type Props = {
  label: string;
  value: Date | null;
  onChange: (date: Date | null) => void;
  optional?: boolean;
  /** Disallow picking a datetime before this (default: now). */
  minimumDate?: Date;
  /** date = day only (no time); datetime = day + time (default) */
  mode?: 'datetime' | 'date';
};

export function DateTimeField({
  label,
  value,
  onChange,
  optional,
  minimumDate,
  mode = 'datetime',
}: Props) {
  const t = useT();
  const min = minimumDate ?? new Date();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(value ?? min);
  const [draft, setDraft] = useState(value ?? nextSlot(min));

  const display = value
    ? mode === 'date'
      ? format(value, 'EEE, d MMM yyyy', { locale: enUS })
      : format(value, 'EEE, d MMM yyyy · HH:mm', { locale: enUS })
    : optional
      ? t.common.notSet
      : mode === 'date'
        ? 'Pick date'
        : 'Pick date and time';

  function openPicker() {
    const base = value && !isBefore(value, startOfDay(min)) ? value : mode === 'date' ? startOfDay(min) : nextSlot(min);
    setDraft(base);
    setMonth(base);
    setOpen(true);
  }

  function selectDay(day: Date) {
    if (isPastDay(day, min)) return;
    setDraft((prev) => {
      if (mode === 'date') {
        return startOfDay(day);
      }
      let next = setMinutes(setHours(day, prev.getHours()), prev.getMinutes());
      next = snapMinutes(next);
      if (isBefore(next, min)) next = nextSlot(min);
      return next;
    });
  }

  function bumpHour(delta: number) {
    setDraft((prev) => clampToMin(addHoursSafe(prev, delta), min));
  }

  function bumpMinute(delta: number) {
    setDraft((prev) => clampToMin(addMinutesSafe(prev, delta * MINUTE_STEP), min));
  }

  function setTime(h: number, m: number) {
    setDraft((prev) => {
      let next = setMinutes(setHours(prev, h), m);
      next = snapMinutes(next);
      return clampToMin(next, min);
    });
  }

  function confirm() {
    if (mode === 'date') {
      const day = startOfDay(draft);
      if (isPastDay(day, min) && !isSameDay(day, min)) return;
      onChange(day);
      setOpen(false);
      return;
    }
    const next = clampToMin(snapMinutes(draft), min);
    if (isBefore(next, min)) return;
    onChange(next);
    setOpen(false);
  }

  function clear() {
    onChange(null);
    setOpen(false);
  }

  const days = useMemo(() => buildCalendarDays(month), [month]);
  const canPrevMonth = !isBefore(endOfMonth(subMonths(month, 1)), startOfDay(min));
  const quickTimes = useMemo(() => buildQuickTimes(draft, min), [draft, min]);
  const hour = draft.getHours();
  const minute = draft.getMinutes();

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <Pressable style={styles.field} onPress={openPicker}>
        <Text style={[styles.fieldText, !value && styles.placeholder]}>{display}</Text>
        <Text style={styles.chevron}>▾</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitle}>{label}</Text>

            <View style={styles.monthRow}>
              <Pressable
                onPress={() => canPrevMonth && setMonth((m) => subMonths(m, 1))}
                style={[styles.monthBtn, !canPrevMonth && styles.monthBtnDisabled]}
                disabled={!canPrevMonth}>
                <Text style={[styles.monthBtnText, !canPrevMonth && styles.muted]}>‹</Text>
              </Pressable>
              <Text style={styles.monthLabel}>{format(month, 'LLLL yyyy', { locale: enUS })}</Text>
              <Pressable onPress={() => setMonth((m) => addMonths(m, 1))} style={styles.monthBtn}>
                <Text style={styles.monthBtnText}>›</Text>
              </Pressable>
            </View>

            <View style={styles.weekHeader}>
              {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
                <Text key={`${d}-${i}`} style={styles.weekDay}>
                  {d}
                </Text>
              ))}
            </View>

            <View style={styles.grid}>
              {days.map((day) => {
                const selected = isSameDay(day, draft);
                const inMonth = isSameMonth(day, month);
                const past = isPastDay(day, min);
                return (
                  <Pressable
                    key={day.toISOString()}
                    disabled={past}
                    style={[styles.dayCell, selected && !past && styles.daySelected, past && styles.dayDisabled]}
                    onPress={() => selectDay(day)}>
                    <Text
                      style={[
                        styles.dayText,
                        !inMonth && styles.dayMuted,
                        past && styles.dayPast,
                        selected && !past && styles.dayTextSelected,
                      ]}>
                      {format(day, 'd')}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {mode === 'datetime' ? (
              <>
                <Text style={styles.timeLabel}>Time</Text>
                <View style={styles.steppers}>
                  <View style={styles.stepper}>
                    <Pressable style={styles.stepBtn} onPress={() => bumpHour(1)}>
                      <Text style={styles.stepBtnText}>▲</Text>
                    </Pressable>
                    <Text style={styles.stepValue}>{String(hour).padStart(2, '0')}</Text>
                    <Pressable style={styles.stepBtn} onPress={() => bumpHour(-1)}>
                      <Text style={styles.stepBtnText}>▼</Text>
                    </Pressable>
                    <Text style={styles.stepHint}>hr</Text>
                  </View>
                  <Text style={styles.colon}>:</Text>
                  <View style={styles.stepper}>
                    <Pressable style={styles.stepBtn} onPress={() => bumpMinute(1)}>
                      <Text style={styles.stepBtnText}>▲</Text>
                    </Pressable>
                    <Text style={styles.stepValue}>{String(minute).padStart(2, '0')}</Text>
                    <Pressable style={styles.stepBtn} onPress={() => bumpMinute(-1)}>
                      <Text style={styles.stepBtnText}>▼</Text>
                    </Pressable>
                    <Text style={styles.stepHint}>min</Text>
                  </View>
                </View>

                {quickTimes.length > 0 ? (
                  <View style={styles.quickTimes}>
                    {quickTimes.map((qt) => {
                      const active = hour === qt.h && minute === qt.m;
                      return (
                        <Pressable
                          key={`${qt.h}:${qt.m}`}
                          style={[styles.quickChip, active && styles.quickChipActive]}
                          onPress={() => setTime(qt.h, qt.m)}>
                          <Text style={[styles.quickChipText, active && styles.quickChipTextActive]}>
                            {String(qt.h).padStart(2, '0')}:{String(qt.m).padStart(2, '0')}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
              </>
            ) : null}

            <View style={styles.actions}>
              {optional ? (
                <Pressable onPress={clear} style={styles.actionGhost}>
                  <Text style={styles.actionGhostText}>{t.common.clear}</Text>
                </Pressable>
              ) : (
                <View />
              )}
              <View style={styles.actionsRight}>
                <Pressable onPress={() => setOpen(false)} style={styles.actionGhost}>
                  <Text style={styles.actionGhostText}>{t.common.cancel}</Text>
                </Pressable>
                <Pressable onPress={confirm} style={styles.actionPrimary}>
                  <Text style={styles.actionPrimaryText}>{t.common.ok}</Text>
                </Pressable>
              </View>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function snapMinutes(d: Date) {
  const m = d.getMinutes();
  const snapped = Math.round(m / MINUTE_STEP) * MINUTE_STEP;
  if (snapped === 60) return setMinutes(setHours(d, d.getHours() + 1), 0);
  return setMinutes(d, snapped);
}

function nextSlot(from: Date) {
  const base = setMilliseconds(setSeconds(from, 0), 0);
  const mins = base.getMinutes();
  const rem = mins % MINUTE_STEP;
  if (rem === 0 && base.getSeconds() === 0 && from.getMilliseconds() === 0 && !isBefore(base, from)) {
    return base;
  }
  const add = rem === 0 ? MINUTE_STEP : MINUTE_STEP - rem;
  return setMinutes(base, mins + add);
}

function clampToMin(d: Date, min: Date) {
  return isBefore(d, min) ? nextSlot(min) : d;
}

function isPastDay(day: Date, min: Date) {
  return isBefore(startOfDay(day), startOfDay(min));
}

function addHoursSafe(d: Date, delta: number) {
  return setHours(d, (d.getHours() + delta + 24) % 24);
}

function addMinutesSafe(d: Date, delta: number) {
  const total = d.getHours() * 60 + d.getMinutes() + delta;
  const wrapped = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  return setMinutes(setHours(d, Math.floor(wrapped / 60)), wrapped % 60);
}

function buildQuickTimes(day: Date, min: Date) {
  const candidates = [
    { h: 9, m: 0 },
    { h: 12, m: 0 },
    { h: 15, m: 0 },
    { h: 17, m: 0 },
    { h: 18, m: 0 },
    { h: 19, m: 0 },
    { h: 20, m: 0 },
    { h: 21, m: 0 },
  ];
  return candidates.filter((t) => {
    const at = setMinutes(setHours(day, t.h), t.m);
    return !isBefore(at, min);
  });
}

function buildCalendarDays(month: Date) {
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

const styles = StyleSheet.create({
  wrap: { marginBottom: theme.space.md },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.colors.textMuted,
    marginBottom: 6,
  },
  field: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  fieldText: { fontSize: 16, color: theme.colors.text, flex: 1 },
  placeholder: { color: theme.colors.textMuted },
  chevron: { color: theme.colors.textMuted, fontSize: 16, marginLeft: 8 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    padding: 20,
  },
  sheet: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: 16,
    maxWidth: 420,
    width: '100%',
    alignSelf: 'center',
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: 12,
  },
  monthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  monthBtn: { padding: 8, minWidth: 40, alignItems: 'center' },
  monthBtnDisabled: { opacity: 0.35 },
  monthBtnText: { fontSize: 24, color: theme.colors.primary, fontWeight: '600' },
  muted: { color: theme.colors.textMuted },
  monthLabel: {
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
  dayDisabled: { opacity: 0.35 },
  dayText: { fontSize: 15, color: theme.colors.text },
  dayMuted: { color: theme.colors.textMuted },
  dayPast: { color: theme.colors.textMuted, textDecorationLine: 'line-through' },
  dayTextSelected: { color: '#fff', fontWeight: '700' },
  timeLabel: {
    marginTop: 12,
    marginBottom: 8,
    fontWeight: '600',
    color: theme.colors.textMuted,
    fontSize: 13,
  },
  steppers: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 12,
  },
  stepper: { alignItems: 'center', minWidth: 72 },
  stepBtn: {
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.background,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  stepBtnText: { fontSize: 14, color: theme.colors.primary, fontWeight: '700' },
  stepValue: {
    fontSize: 36,
    fontWeight: '800',
    color: theme.colors.text,
    fontVariant: ['tabular-nums'],
    marginVertical: 4,
  },
  stepHint: { fontSize: 11, color: theme.colors.textMuted, fontWeight: '600', marginTop: 2 },
  colon: { fontSize: 32, fontWeight: '700', color: theme.colors.text, marginBottom: 18 },
  quickTimes: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center' },
  quickChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  quickChipActive: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  quickChipText: { fontSize: 13, color: theme.colors.text, fontWeight: '600' },
  quickChipTextActive: { color: '#fff' },
  actions: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  actionsRight: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  actionGhost: { paddingHorizontal: 12, paddingVertical: 10 },
  actionGhostText: { color: theme.colors.textMuted, fontWeight: '600' },
  actionPrimary: {
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: theme.radius.sm,
  },
  actionPrimaryText: { color: '#fff', fontWeight: '700' },
});
