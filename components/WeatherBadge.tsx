import { format } from 'date-fns';
import { enUS, sl as slLocale } from 'date-fns/locale';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { theme } from '@/constants/theme';
import { forecastAt, forecastDays, weatherMark, type DailyForecast, type WeatherForecast } from '@/lib/weather';

export function WeatherBadge({
  latitude,
  longitude,
  startsAt,
  inline,
}: {
  latitude: number;
  longitude: number;
  startsAt: string;
  inline?: boolean;
}) {
  const [forecast, setForecast] = useState<WeatherForecast | null>(null);

  useEffect(() => {
    let live = true;
    void forecastAt(latitude, longitude, startsAt).then((next) => {
      if (live) setForecast(next);
    });
    return () => {
      live = false;
    };
  }, [latitude, longitude, startsAt]);

  if (!forecast) return null;

  return (
    <View style={[styles.badge, inline ? null : styles.corner]} pointerEvents="none">
      <Text style={styles.mark}>{weatherMark(forecast.code)}</Text>
      <Text style={styles.temp}>{forecast.temp}°</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: theme.colors.surface,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  corner: {
    position: 'absolute',
    top: 8,
    right: 10,
    zIndex: 2,
  },
  temp: {
    color: theme.colors.primaryDark,
    fontSize: 13,
    fontWeight: '700',
  },
  mark: {
    fontSize: 16,
    lineHeight: 20,
  },
});

export function WeatherWeek({
  latitude,
  longitude,
  eventDay,
  locale,
}: {
  latitude: number;
  longitude: number;
  eventDay?: string | null;
  locale: 'sl' | 'en';
}) {
  const [days, setDays] = useState<DailyForecast[]>([]);
  const dfLocale = locale === 'sl' ? slLocale : enUS;

  useEffect(() => {
    let live = true;
    void forecastDays(latitude, longitude).then((next) => {
      if (live) setDays(next);
    });
    return () => {
      live = false;
    };
  }, [latitude, longitude]);

  if (!days.length) return null;

  return (
    <View style={weekStyles.row}>
      {days.map((day) => {
        const marked = eventDay != null && day.day === eventDay;
        const when = new Date(`${day.day}T12:00:00`);
        const label = format(when, 'EEE', { locale: dfLocale });
        const dateLabel = format(when, 'd. MMM', { locale: dfLocale });
        return (
          <View key={day.day} style={[weekStyles.day, marked ? weekStyles.dayMarked : null]}>
            <Text style={[weekStyles.label, marked ? weekStyles.labelMarked : null]} numberOfLines={1}>
              {label}
            </Text>
            <Text style={[weekStyles.date, marked ? weekStyles.labelMarked : null]} numberOfLines={1}>
              {dateLabel}
            </Text>
            <Text style={weekStyles.mark}>{weatherMark(day.code)}</Text>
            <Text style={weekStyles.high}>{day.max}°</Text>
            <Text style={weekStyles.low}>{day.min}°</Text>
          </View>
        );
      })}
    </View>
  );
}

const weekStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 8,
  },
  day: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    paddingVertical: 8,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  dayMarked: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primarySoft,
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    color: theme.colors.textMuted,
    textTransform: 'capitalize',
  },
  date: {
    fontSize: 10,
    fontWeight: '600',
    color: theme.colors.textMuted,
  },
  labelMarked: {
    color: theme.colors.primaryDark,
  },
  mark: {
    fontSize: 18,
    lineHeight: 22,
  },
  high: {
    fontSize: 13,
    fontWeight: '700',
    color: theme.colors.text,
  },
  low: {
    fontSize: 12,
    color: theme.colors.textMuted,
  },
});
