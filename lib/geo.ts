export type GeoPoint = {
  latitude: number;
  longitude: number;
};

export type GeoPlace = GeoPoint & {
  label: string;
};

/** Razdalja v metrih (Haversine). */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
}

/** Lowercase + strip diacritics for loose venue matching (e.g. Vogu → Rekreacijsko društvo Vogu). */
export function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Rank how well a venue matches typed text. Lower = better; null = no match.
 * Matches whole words and substrings so "Vogu" finds "Rekreacijsko društvo Vogu".
 */
export function venueMatchScore(query: string, name: string, address?: string | null): number | null {
  const q = normalizeSearchText(query);
  if (q.length < 1) return null;
  const hay = normalizeSearchText(`${name} ${address ?? ''}`);
  if (!hay) return null;

  const words = hay.split(' ').filter(Boolean);
  const qTokens = q.split(' ').filter(Boolean);

  if (hay === q) return 0;
  if (words.some((w) => w === q)) return 1;
  if (words.some((w) => w.startsWith(q))) return 2;
  if (hay.includes(q)) return 3;
  if (qTokens.length > 1 && qTokens.every((t) => hay.includes(t) || words.some((w) => w.startsWith(t)))) {
    return 4;
  }
  // Partial token: query is contained in any word (already covered by hay.includes) —
  // also allow word contained in query for short names typed longer
  if (words.some((w) => w.length >= 2 && (q.includes(w) || w.includes(q)))) return 5;
  return null;
}

/**
 * Iskanje lokacij prek Google Geocoding API (če je ključ),
 * sicer OpenStreetMap Nominatim (lat/lng združljivi z Google Maps).
 */
export async function searchPlaces(query: string): Promise<GeoPlace[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const googleKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (googleKey) {
    try {
      const url =
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}` +
        `&language=en&region=si&key=${googleKey}`;
      const res = await fetch(url);
      const json = (await res.json()) as {
        status: string;
        results?: { formatted_address: string; geometry: { location: { lat: number; lng: number } } }[];
      };
      if (json.status === 'OK' && json.results?.length) {
        return json.results.slice(0, 8).map((r) => ({
          label: r.formatted_address,
          latitude: r.geometry.location.lat,
          longitude: r.geometry.location.lng,
        }));
      }
    } catch {
      // fallback na Nominatim
    }
  }

  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?format=json&limit=8&addressdetails=0&q=${encodeURIComponent(q)}`,
    { headers: { 'Accept-Language': 'en', 'User-Agent': 'ToBumpMobile/1.0' } }
  );
  const json = (await res.json()) as { display_name: string; lat: string; lon: string }[];
  return (json ?? []).map((r) => ({
    label: r.display_name,
    latitude: Number(r.lat),
    longitude: Number(r.lon),
  }));
}

export async function reverseGeocode(point: GeoPoint): Promise<string> {
  const googleKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (googleKey) {
    try {
      const url =
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${point.latitude},${point.longitude}` +
        `&language=en&key=${googleKey}`;
      const res = await fetch(url);
      const json = (await res.json()) as {
        status: string;
        results?: { formatted_address: string }[];
      };
      if (json.status === 'OK' && json.results?.[0]) {
        return json.results[0].formatted_address;
      }
    } catch {
      /* fallback */
    }
  }

  const res = await fetch(
    `https://nominatim.openstreetmap.org/reverse?format=json&lat=${point.latitude}&lon=${point.longitude}`,
    { headers: { 'Accept-Language': 'en', 'User-Agent': 'ToBumpMobile/1.0' } }
  );
  const json = (await res.json()) as { display_name?: string };
  return json.display_name ?? `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`;
}

export function mapsUrl(point: GeoPoint): string {
  return `https://www.google.com/maps?q=${point.latitude},${point.longitude}`;
}
