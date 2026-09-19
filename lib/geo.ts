export type GeoPoint = {
  latitude: number;
  longitude: number;
};

export type GeoPlace = GeoPoint & {
  label: string;
  source?: 'google' | 'photon' | 'nominatim' | 'device';
};

/** Approximate Slovenia bounding box (for search bias). */
export const SI_BBOX = {
  minLon: 13.35,
  minLat: 45.4,
  maxLon: 16.65,
  maxLat: 46.9,
};

export const SI_CENTER: GeoPoint = { latitude: 46.15, longitude: 14.8 };

const UA = 'ToBumpMobile/1.0 (https://tobump-mobile.expo.app; contact@tobump.app)';

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
  if (words.some((w) => w.length >= 2 && (q.includes(w) || w.includes(q)))) return 5;
  return null;
}

function googleKey(): string | undefined {
  const k = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY?.trim();
  return k || undefined;
}

function formatPhotonLabel(props: Record<string, unknown>): string {
  const parts = [
    props.name,
    props.street,
    props.housenumber,
    props.city || props.town || props.village || props.locality || props.district,
    props.county,
    props.state,
    props.country,
  ]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean);
  // Deduplicate consecutive repeats
  const uniq: string[] = [];
  for (const p of parts) {
    if (!uniq.length || normalizeSearchText(uniq[uniq.length - 1]) !== normalizeSearchText(p)) {
      uniq.push(p);
    }
  }
  return uniq.join(', ') || String(props.name ?? 'Place');
}

function inSlovenia(p: GeoPoint): boolean {
  return (
    p.longitude >= SI_BBOX.minLon &&
    p.longitude <= SI_BBOX.maxLon &&
    p.latitude >= SI_BBOX.minLat &&
    p.latitude <= SI_BBOX.maxLat
  );
}

function dedupePlaces(places: GeoPlace[]): GeoPlace[] {
  const seen = new Set<string>();
  const out: GeoPlace[] = [];
  for (const p of places) {
    if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) continue;
    const key = `${p.latitude.toFixed(4)},${p.longitude.toFixed(4)},${normalizeSearchText(p.label).slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function rankPlaces(places: GeoPlace[], query: string, bias?: GeoPoint | null): GeoPlace[] {
  const q = normalizeSearchText(query);
  const qTokens = q.split(' ').filter(Boolean);
  const placeToken = qTokens.length > 1 ? qTokens[qTokens.length - 1]! : '';
  return [...places].sort((a, b) => {
    const score = (p: GeoPlace) => {
      let s = 0;
      if (inSlovenia(p)) s += 50;
      const label = normalizeSearchText(p.label);
      if (label === q) s += 40;
      if (placeToken && label.includes(placeToken)) s += 45;
      if (qTokens.every((t) => label.includes(t))) s += 30;
      else s += qTokens.filter((t) => label.includes(t)).length * 8;
      if (p.source === 'google') s += 20;
      if (bias) {
        const d = distanceMeters(bias, p);
        s += Math.max(0, 25 - d / 2000);
      }
      return s;
    };
    return score(b) - score(a);
  });
}

/** Places API (New) — works from the browser with HTTP-referrer API keys. */
async function searchGooglePlacesNew(query: string, bias?: GeoPoint | null): Promise<GeoPlace[]> {
  const key = googleKey();
  if (!key) return [];
  const center = bias ?? SI_CENTER;
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location',
      },
      body: JSON.stringify({
        textQuery: query,
        languageCode: 'sl',
        regionCode: 'SI',
        maxResultCount: 8,
        locationBias: {
          circle: {
            center: { latitude: center.latitude, longitude: center.longitude },
            radius: 80_000,
          },
        },
      }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      places?: {
        displayName?: { text?: string };
        formattedAddress?: string;
        location?: { latitude: number; longitude: number };
      }[];
    };
    return (json.places ?? [])
      .filter((p) => p.location?.latitude != null && p.location?.longitude != null)
      .map((p) => {
        const name = p.displayName?.text?.trim() ?? '';
        const addr = p.formattedAddress?.trim() ?? '';
        return {
          label: addr && name && addr.toLowerCase().includes(name.toLowerCase())
            ? addr
            : [name, addr].filter(Boolean).join(', '),
          latitude: p.location!.latitude,
          longitude: p.location!.longitude,
          source: 'google' as const,
        };
      });
  } catch {
    return [];
  }
}

async function searchGooglePlaces(query: string, bias?: GeoPoint | null): Promise<GeoPlace[]> {
  const key = googleKey();
  if (!key) return [];

  // Legacy Text Search — works in native; browsers usually block it (CORS).
  try {
    let url =
      `https://maps.googleapis.com/maps/api/place/textsearch/json` +
      `?query=${encodeURIComponent(query)}` +
      `&region=si&language=sl&key=${key}`;
    if (bias) {
      url += `&location=${bias.latitude},${bias.longitude}&radius=80000`;
    } else {
      url += `&location=${SI_CENTER.latitude},${SI_CENTER.longitude}&radius=120000`;
    }
    const res = await fetch(url);
    const json = (await res.json()) as {
      status: string;
      results?: {
        name: string;
        formatted_address: string;
        geometry: { location: { lat: number; lng: number } };
      }[];
    };
    if ((json.status === 'OK' || json.status === 'ZERO_RESULTS') && json.results) {
      return json.results.slice(0, 8).map((r) => ({
        label: r.formatted_address?.includes(r.name)
          ? r.formatted_address
          : `${r.name}, ${r.formatted_address}`,
        latitude: r.geometry.location.lat,
        longitude: r.geometry.location.lng,
        source: 'google' as const,
      }));
    }
  } catch {
    /* try geocoding */
  }

  try {
    const url =
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}` +
      `&language=sl&region=si&key=${key}`;
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
        source: 'google' as const,
      }));
    }
  } catch {
    /* fall through */
  }
  return [];
}

async function searchPhoton(query: string, bias?: GeoPoint | null, useBbox = true): Promise<GeoPlace[]> {
  const center = bias && inSlovenia(bias) ? bias : SI_CENTER;
  const bbox = `${SI_BBOX.minLon},${SI_BBOX.minLat},${SI_BBOX.maxLon},${SI_BBOX.maxLat}`;
  const url =
    `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}` +
    `&lang=sl&limit=10&lat=${center.latitude}&lon=${center.longitude}` +
    (useBbox ? `&bbox=${bbox}` : '');
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      features?: {
        geometry: { coordinates: [number, number] };
        properties: Record<string, unknown>;
      }[];
    };
    const places = (json.features ?? []).map((f) => ({
      label: formatPhotonLabel(f.properties),
      latitude: f.geometry.coordinates[1],
      longitude: f.geometry.coordinates[0],
      source: 'photon' as const,
    }));
    if (places.length || !useBbox) return places;
    return searchPhoton(query, bias, false);
  } catch {
    return useBbox ? searchPhoton(query, bias, false) : [];
  }
}

/** CORS-friendly geocoder (cities, towns, named places). */
async function searchOpenMeteo(query: string): Promise<GeoPlace[]> {
  try {
    const url =
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}` +
      `&count=8&language=sl&format=json`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = (await res.json()) as {
      results?: {
        name: string;
        latitude: number;
        longitude: number;
        country?: string;
        admin1?: string;
      }[];
    };
    return (json.results ?? []).map((r) => ({
      label: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
      latitude: r.latitude,
      longitude: r.longitude,
      source: 'nominatim' as const,
    }));
  } catch {
    return [];
  }
}

async function searchNominatim(
  query: string,
  opts?: { bias?: GeoPoint | null; bounded?: boolean }
): Promise<(GeoPlace & { osmClass?: string; osmType?: string })[]> {
  const bias = opts?.bias;
  let url =
    `https://nominatim.openstreetmap.org/search?format=json&addressdetails=0&limit=8` +
    `&countrycodes=si&q=${encodeURIComponent(query)}`;
  if (bias) {
    const d = 0.12;
    const viewbox = [
      bias.longitude - d,
      bias.latitude + d,
      bias.longitude + d,
      bias.latitude - d,
    ].join(',');
    url += `&viewbox=${viewbox}`;
    if (opts?.bounded) url += `&bounded=1`;
  }
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'Accept-Language': 'sl,en', 'User-Agent': UA },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      display_name: string;
      lat: string;
      lon: string;
      class?: string;
      type?: string;
    }[];
    return (json ?? []).map((r) => ({
      label: r.display_name,
      latitude: Number(r.lat),
      longitude: Number(r.lon),
      source: 'nominatim' as const,
      osmClass: r.class,
      osmType: r.type,
    }));
  } catch {
    return [];
  }
}

function isSettlement(p: GeoPlace & { osmClass?: string; osmType?: string }): boolean {
  if (p.osmClass === 'place') return true;
  if (p.osmClass === 'boundary') return true;
  if (p.osmType && /suburb|village|town|city|hamlet|neighbourhood|municipality/i.test(p.osmType)) {
    return true;
  }
  // Photon / unlabeled: prefer shorter admin-looking labels with postcode
  return /\b\d{4}\b/.test(p.label);
}

async function expandMultiToken(query: string, bias?: GeoPoint | null): Promise<GeoPlace[]> {
  const tokens = query.trim().split(/\s+/).filter((t) => t.length >= 2);
  if (tokens.length < 2) return [];

  const placeToken = tokens[tokens.length - 1]!;
  const keyword = tokens.slice(0, -1).join(' ');
  const asciiKeyword = normalizeSearchText(keyword);
  const nearRadiusM = 12_000;

  const rawPlaces = [
    ...(await searchNominatim(placeToken, { bias })),
    ...(await searchPhoton(placeToken, bias)),
  ].filter((p) => normalizeSearchText(p.label).includes(normalizeSearchText(placeToken)));

  const settlements = rawPlaces.filter(isSettlement);
  const placeHits = dedupePlaces(settlements.length ? settlements : rawPlaces).slice(0, 5);

  const near: GeoPlace[] = [];
  // Only probe near the best 2 settlements to avoid unrelated clubs
  for (const place of placeHits.slice(0, 2)) {
    const [p1, p2, n1] = await Promise.all([
      searchPhoton(keyword, place),
      asciiKeyword !== normalizeSearchText(keyword)
        ? searchPhoton(asciiKeyword, place)
        : Promise.resolve([]),
      searchNominatim(keyword, { bias: place, bounded: true }),
    ]);
    for (const p of [...p1, ...p2, ...n1]) {
      if (distanceMeters(place, p) <= nearRadiusM) near.push(p);
    }
  }

  return dedupePlaces([...placeHits, ...near]);
}

export type SearchPlacesOptions = {
  /** Prefer results near this point (GPS / existing profile coords). */
  bias?: GeoPoint | null;
};

/**
 * Place / address search biased to Slovenia.
 * Queries Google Places (New) and map geocoders in parallel so web clients
 * still get Maps-like suggestions when the legacy Places JSON API is blocked.
 */
export async function searchPlaces(
  query: string,
  options?: SearchPlacesOptions
): Promise<GeoPlace[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const bias = options?.bias ?? SI_CENTER;

  const [googleNew, googleLegacy, photon, openMeteo] = await Promise.all([
    searchGooglePlacesNew(q, bias),
    searchGooglePlaces(q, bias),
    searchPhoton(q, bias),
    searchOpenMeteo(q),
  ]);

  const merged = dedupePlaces([...googleNew, ...googleLegacy, ...photon, ...openMeteo]);
  if (merged.length) {
    return rankPlaces(merged, q, bias).slice(0, 10);
  }

  const nominatim = await searchNominatim(q, { bias });
  const expanded =
    normalizeSearchText(q).split(' ').filter(Boolean).length > 1
      ? await expandMultiToken(q, bias)
      : [];
  return rankPlaces(dedupePlaces([...nominatim, ...expanded]), q, bias).slice(0, 10);
}

export async function reverseGeocode(point: GeoPoint): Promise<string> {
  const key = googleKey();
  if (key) {
    try {
      const url =
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${point.latitude},${point.longitude}` +
        `&language=sl&key=${key}`;
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

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${point.latitude}&lon=${point.longitude}&accept-language=sl`,
      { headers: { Accept: 'application/json', 'Accept-Language': 'sl,en', 'User-Agent': UA } }
    );
    const json = (await res.json()) as { display_name?: string };
    if (json.display_name) return json.display_name;
  } catch {
    /* ignore */
  }
  return `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`;
}

export function mapsUrl(point: GeoPoint): string {
  return `https://www.google.com/maps?q=${point.latitude},${point.longitude}`;
}
