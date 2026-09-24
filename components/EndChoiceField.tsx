import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Chip } from '@/components/ui';
import { DateTimeField } from '@/components/DateTimeField';
import { formatDuration } from '@/lib/recurrence';
import { useT } from '@/i18n';
import { theme } from '@/constants/theme';

export type EndChoice = {
  mode: 'none' | 'clock' | 'duration';
  minutes: number | null;
  endHour: number | null;
  endMinute: number | null;
};

export function noEnd(): EndChoice {
  return { mode: 'none', minutes: null, endHour: null, endMinute: null };
}

export function durationEnd(minutes = 90): EndChoice {
  const snapped = Math.max(15, Math.round(minutes / 15) * 15);
  return { mode: 'duration', minutes: snapped, endHour: null, endMinute: null };
}

export function clockEnd(hour: number, minute: number): EndChoice {
  return {
    mode: 'clock',
    minutes: null,
    endHour: Math.min(23, Math.max(0, hour)),
    endMinute: Math.min(59, Math.max(0, Math.round(minute / 15) * 15)),
  };
}

/** Minutes from start until the chosen end. Null when there is no end, or the gap is under 15 minutes. */
export function resolveEndMinutes(start: Date, end: EndChoice): number | null {
  if (end.mode === 'none') return null;
  if (end.mode === 'duration') {
    return end.minutes != null && end.minutes >= 15 ? end.minutes : null;
  }
  if (end.endHour == null || end.endMinute == null) return null;
  const endAt = new Date(start);
  endAt.setHours(end.endHour, end.endMinute, 0, 0);
  if (endAt.getTime() <= start.getTime()) endAt.setDate(endAt.getDate() + 1);
  const minutes = Math.round((endAt.getTime() - start.getTime()) / 60_000);
  return minutes >= 15 ? minutes : null;
}

function clockFromStart(start: Date | null): EndChoice {
  const base = start ? new Date(start.getTime() + 90 * 60_000) : new Date();
  if (!start) base.setHours(20, 0, 0, 0);
  return clockEnd(base.getHours(), base.getMinutes());
}

export function EndChoiceField({
  value,
  onChange,
  start,
}: {
  value: EndChoice;
  onChange: (next: EndChoice) => void;
  start: Date | null;
}) {
  const t = useT();
  const [open, setOpen] = useState(value.mode !== 'none');
  const show = open || value.mode !== 'none';

  if (!show) {
    return (
      <Text style={styles.link} onPress={() => setOpen(true)}>
        {t.form.addEnd}
      </Text>
    );
  }

  const clockValue = new Date(start ?? new Date());
  if (value.mode === 'clock' && value.endHour != null && value.endMinute != null) {
    clockValue.setHours(value.endHour, value.endMinute, 0, 0);
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.choices}>
        <Chip
          label={t.form.endClock}
          active={value.mode === 'clock'}
          onPress={() => onChange(value.mode === 'clock' ? value : clockFromStart(start))}
        />
        <Chip
          label={t.form.endApprox}
          active={value.mode === 'duration'}
          onPress={() => onChange(value.mode === 'duration' ? value : durationEnd(value.minutes ?? 90))}
        />
        <Chip
          label={t.form.noEnd}
          active={false}
          onPress={() => {
            setOpen(false);
            onChange(noEnd());
          }}
        />
      </View>
      {value.mode === 'clock' ? (
        <DateTimeField
          label={t.form.endClock}
          value={clockValue}
          mode="time"
          minimumDate={new Date(2000, 0, 1)}
          onChange={(d) => {
            if (!d) return;
            onChange(clockEnd(d.getHours(), d.getMinutes()));
          }}
        />
      ) : null}
      {value.mode === 'duration' ? (
        <View style={styles.duration}>
          <Text style={styles.durationValue}>{formatDuration(value.minutes ?? 90)}</Text>
          <View style={styles.steps}>
            <Chip label="−1h" active={false} onPress={() => onChange(durationEnd(Math.max(15, (value.minutes ?? 90) - 60)))} />
            <Chip label="−30m" active={false} onPress={() => onChange(durationEnd(Math.max(15, (value.minutes ?? 90) - 30)))} />
            <Chip label="−15m" active={false} onPress={() => onChange(durationEnd(Math.max(15, (value.minutes ?? 90) - 15)))} />
            <Chip label="+15m" active={false} onPress={() => onChange(durationEnd((value.minutes ?? 90) + 15))} />
            <Chip label="+30m" active={false} onPress={() => onChange(durationEnd((value.minutes ?? 90) + 30))} />
            <Chip label="+1h" active={false} onPress={() => onChange(durationEnd((value.minutes ?? 90) + 60))} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  link: {
    color: theme.colors.primary,
    fontWeight: '600',
    fontSize: 15,
    textDecorationLine: 'underline',
    marginBottom: theme.space.md,
  },
  wrap: { marginBottom: theme.space.md, width: '100%' },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8, width: '100%' },
  duration: { width: '100%' },
  durationValue: {
    fontSize: 18,
    fontWeight: '800',
    color: theme.colors.text,
    marginBottom: 8,
  },
  steps: { flexDirection: 'row', flexWrap: 'wrap', width: '100%', gap: 6 },
});
