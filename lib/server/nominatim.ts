import type { Bounds } from '../config';
import type { Place } from '../places';
import { LruCache, NOMINATIM_URL, Throttle, USER_AGENT } from './upstream';

interface NominatimItem {
  lat: string;
  lon: string;
  name?: string;
  display_name: string;
}

const isItem = (v: unknown): v is NominatimItem => {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.lat === 'string' && typeof r.lon === 'string' && typeof r.display_name === 'string' && (r.name === undefined || typeof r.name === 'string');
};

/** Nominatim's public server allows at most one request per second per application. */
const throttle = new Throttle(1100);
const cache = new LruCache<Place[]>(200);

function toPlace(item: NominatimItem): Place | null {
  const lng = Number(item.lon);
  const lat = Number(item.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const parts = item.display_name.split(',').map((s) => s.trim());
  const name = item.name || parts[0] || 'ไม่ทราบชื่อ';
  const detail = parts
    .filter((p) => p !== name && p !== 'ประเทศไทย' && !/^\d{5}$/.test(p))
    .slice(0, 3)
    .join(' · ');
  return { name, detail, lng, lat };
}

async function call(path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(path, NOMINATIM_URL);
  for (const [k, v] of Object.entries({ format: 'jsonv2', 'accept-language': 'th', ...params })) url.searchParams.set(k, v);
  const res = await throttle.run(() => fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(12_000), cache: 'no-store' }));
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  return res.json();
}

/**
 * Places matching `query`. With `near`, places in that area rank higher; Nominatim still searches
 * the whole country.
 */
export async function nominatimSearch(query: string, limit: number, near: Bounds | null): Promise<Place[]> {
  // viewbox takes two opposite corners as lon,lat. Without bounded=1 it only raises the rank of places inside.
  const bias: Record<string, string> = near ? { viewbox: `${near.west},${near.north},${near.east},${near.south}` } : {};
  const raw = await call('/search', { q: query, countrycodes: 'th', limit: String(limit), ...bias });
  return Array.isArray(raw) ? raw.filter(isItem).map(toPlace).filter((p): p is Place => p !== null) : [];
}

export async function reversePlace(lng: number, lat: number): Promise<Place | null> {
  const key = `r:${lng.toFixed(4)},${lat.toFixed(4)}`;
  const hit = cache.get(key);
  if (hit) return hit[0] ?? null;
  const raw = await call('/reverse', { lon: lng.toFixed(6), lat: lat.toFixed(6), zoom: '17' });
  const place = isItem(raw) ? toPlace(raw) : null;
  cache.set(key, place ? [place] : []);
  return place;
}
