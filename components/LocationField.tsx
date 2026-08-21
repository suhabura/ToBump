import { useEffect, useRef, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Location from 'expo-location';
import { Button, Input, Muted } from '@/components/ui';
import {
  SI_CENTER,
  distanceMeters,
  formatDistance,
  mapsUrl,
  reverseGeocode,
  searchPlaces,
  type GeoPlace,
  type GeoPoint,
} from '@/lib/geo';
import { useT } from '@/i18n';
import { theme } from '@/constants/theme';

type Props = {
  label: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  onChange: (next: { address: string; latitude: number | null; longitude: number | null }) => void;
  required?: boolean;
  /** Za prikaz razdalje (npr. od profila). */
  relativeTo?: GeoPoint | null;
};

export function LocationField({
  label,
  address,
  latitude,
  longitude,
  onChange,
  required,
  relativeTo,
}: Props) {
  const t = useT();
  const [query, setQuery] = useState(address);
  const [focused, setFocused] = useState(false);
  const [results, setResults] = useState<GeoPlace[]>([]);
  const [searching, setSearching] = useState(false);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bias, setBias] = useState<GeoPoint | null>(
    latitude != null && longitude != null ? { latitude, longitude } : SI_CENTER
  );
  const picking = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setQuery(address);
  }, [address]);

  useEffect(() => {
    if (latitude != null && longitude != null) {
      setBias({ latitude, longitude });
    }
  }, [latitude, longitude]);

  // Soft GPS bias for better nearby rankings (does not require picking "My location")
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status !== 'granted') return;
        const pos =
          (await Location.getLastKnownPositionAsync()) ??
          (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
        if (!cancelled && pos) {
          setBias({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
        }
      } catch {
        /* keep SI / profile bias */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = query.trim();
    if (!focused || q.length < 2) {
      setResults([]);
      return;
    }
    if (latitude != null && longitude != null && q === address.trim()) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(async () => {
      setSearching(true);
      setError(null);
      try {
        const places = await searchPlaces(q, { bias });
        setResults(places);
      } catch {
        setError(t.location.searchFailed);
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 320);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, focused, address, latitude, longitude, bias, t.location.searchFailed]);

  function pick(place: GeoPlace) {
    picking.current = true;
    setQuery(place.label);
    onChange({
      address: place.label,
      latitude: place.latitude,
      longitude: place.longitude,
    });
    setResults([]);
    setFocused(false);
  }

  async function useMyLocation() {
    setGpsLoading(true);
    setError(null);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setError(t.location.allowAccess);
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const point = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
      setBias(point);
      const label = await reverseGeocode(point);
      setQuery(label);
      onChange({ address: label, latitude: point.latitude, longitude: point.longitude });
    } catch {
      setError(t.location.gpsFailed);
    } finally {
      setGpsLoading(false);
    }
  }

  const hasCoords = latitude != null && longitude != null && !Number.isNaN(latitude) && !Number.isNaN(longitude);
  const dist =
    hasCoords && relativeTo
      ? formatDistance(distanceMeters(relativeTo, { latitude: latitude!, longitude: longitude! }))
      : null;

  return (
    <View style={styles.wrap}>
      <Input
        label={required ? `${label} *` : label}
        value={query}
        onChangeText={(text) => {
          setQuery(text);
          if (text.trim() !== address.trim()) {
            onChange({ address: text, latitude: null, longitude: null });
          }
        }}
        placeholder={t.location.placeholder}
        onFocus={() => {
          picking.current = false;
          setFocused(true);
        }}
        onBlur={() => {
          setTimeout(() => {
            if (!picking.current) setFocused(false);
            picking.current = false;
          }, Platform.OS === 'web' ? 250 : 150);
        }}
      />
      {focused && query.trim().length >= 2 ? (
        <View style={styles.list}>
          {searching ? <Text style={styles.hint}>{t.location.searching}</Text> : null}
          {!searching && results.length === 0 ? (
            <Text style={styles.hint}>{t.location.noResults}</Text>
          ) : null}
          {results.map((r) => (
            <Pressable
              key={`${r.latitude},${r.longitude},${r.label}`}
              style={styles.item}
              onPressIn={() => pick(r)}
              {...(Platform.OS === 'web'
                ? {
                    onMouseDown: (e: { preventDefault?: () => void }) => {
                      e.preventDefault?.();
                      pick(r);
                    },
                  }
                : {})}>
              <Text style={styles.itemText}>{r.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={styles.actions}>
        <Button
          label={gpsLoading ? t.location.gettingGps : t.location.myLocation}
          variant="secondary"
          onPress={useMyLocation}
        />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {hasCoords ? (
        <Muted>
          {t.location.coords}: {latitude!.toFixed(5)}, {longitude!.toFixed(5)}
          {dist ? ` · ${dist}` : ''}
          {' · '}
          <Text
            style={styles.link}
            onPress={() => Linking.openURL(mapsUrl({ latitude: latitude!, longitude: longitude! }))}>
            {t.location.openMaps}
          </Text>
        </Muted>
      ) : (
        <Muted>{t.location.pickHint}</Muted>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { zIndex: 20, marginBottom: theme.space.md },
  list: {
    marginTop: -8,
    marginBottom: 8,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.sm,
    overflow: 'hidden',
    maxHeight: 280,
  },
  item: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  itemText: { fontSize: 14, color: theme.colors.text },
  hint: { padding: 12, color: theme.colors.textMuted },
  actions: { marginBottom: 8 },
  error: { color: theme.colors.danger, marginBottom: 6, fontWeight: '600' },
  link: { color: theme.colors.primary, fontWeight: '600' },
});
