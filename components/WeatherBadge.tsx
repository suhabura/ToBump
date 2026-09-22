import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { theme } from '@/constants/theme';
import { forecastAt, weatherIcon, type WeatherForecast } from '@/lib/weather';

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
      <FontAwesome name={weatherIcon(forecast.code)} size={13} color={theme.colors.primaryDark} />
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
});
