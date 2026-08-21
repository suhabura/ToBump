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
  /** Show “My location” (default true — profile). */
  showMyLocation?: boolean;
  /**
   * Venue mode: Enter confirms free text without coordinates.
   * Draft typing does not count as selected until Enter or a suggestion pick.
   */
  allowManualConfirm?: boolean;
  /** Live draft text (for verified-provider chips while typing). */
  onDraftChange?: (text: string) => void;
};

export function LocationField({
  label,
  address,
  latitude,
  longitude,
  onChange,
  required,
  relativeTo,
  showMyLocation = true,
  allowManualConfirm = false,
  onDraftChange,
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
    // Manual selection without coords: don't keep searching the confirmed label
    if (allowManualConfirm && address.trim() && q === address.trim() && latitude == null) {
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
  }, [query, focused, address, latitude, longitude, bias, allowManualConfirm, t.location.searchFailed]);

  function pick(place: GeoPlace) {
    picking.current = true;
    setQuery(place.label);
    onChange({
      address: place.label,
      latitude: place.latitude,
      longitude: place.longitude,
    });
    onDraftChange?.(place.label);
    setResults([]);
    setFocused(false);
  }

  function confirmManual() {
    const n = query.trim();
    if (!n) return;
    picking.current = true;
    onChange({ address: n, latitude: null, longitude: null });
    onDraftChange?.(n);
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
      onDraftChange?.(label);
    } catch {
      setError(t.location.gpsFailed);
    } finally {
      setGpsLoading(false);
    }
  }

  const hasCoords = latitude != null && longitude != null && !Number.isNaN(latitude) && !Number.isNaN(longitude);
  const hasSelection = Boolean(address.trim());
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
          onDraftChange?.(text);
          if (allowManualConfirm) {
            if (address.trim() && text.trim() !== address.trim()) {
              onChange({ address: '', latitude: null, longitude: null });
            }
          } else if (text.trim() !== address.trim()) {
            onChange({ address: text, latitude: null, longitude: null });
          }
        }}
        placeholder={
          allowManualConfirm ? t.location.venuePlaceholder : t.location.placeholder
        }
        returnKeyType="done"
        onSubmitEditing={() => {
          if (allowManualConfirm) confirmManual();
        }}
        onKeyPress={(e) => {
          if (allowManualConfirm && e.nativeEvent.key === 'Enter') {
            e.preventDefault?.();
            confirmManual();
          }
        }}
        blurOnSubmit={allowManualConfirm}
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
            <Text style={styles.hint}>
              {allowManualConfirm ? t.location.noResultsManual : t.location.noResults}
            </Text>
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

      {showMyLocation ? (
        <View style={styles.actions}>
          <Button
            label={gpsLoading ? t.location.gettingGps : t.location.myLocation}
            variant="secondary"
            onPress={useMyLocation}
          />
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {allowManualConfirm ? (
        hasSelection ? (
          <View style={styles.selectedBox}>
            <Text style={styles.selectedLabel}>{t.location.selected}</Text>
            <Text style={styles.selectedValue}>{address}</Text>
            {hasCoords ? (
              <Muted>
                {t.location.coords}: {latitude!.toFixed(5)}, {longitude!.toFixed(5)}
                {dist ? ` · ${dist}` : ''}
                {' · '}
                <Text
                  style={styles.link}
                  onPress={() =>
                    Linking.openURL(mapsUrl({ latitude: latitude!, longitude: longitude! }))
                  }>
                  {t.location.openMaps}
                </Text>
              </Muted>
            ) : (
              <Muted>{t.location.manualNoCoords}</Muted>
            )}
          </View>
        ) : (
          <Muted>{t.location.venueHint}</Muted>
        )
      ) : hasCoords ? (
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
  selectedBox: {
    marginTop: 4,
    padding: 12,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    gap: 4,
  },
  selectedLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
  },
  selectedValue: {
    fontSize: 15,
    fontWeight: '700',
    color: theme.colors.text,
  },
});
