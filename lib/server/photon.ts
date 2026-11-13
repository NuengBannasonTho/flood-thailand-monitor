import { type Bounds, THAILAND } from '../config';
import type { Place } from '../places';
import { PHOTON_URL, Throttle, USER_AGENT } from './upstream';

/** The public Photon server asks for fair use, so requests are spaced out. */
const throttle = new Throttle(250);

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/** A Photon GeoJSON feature as a place, or null when it lacks a point, a name, or lies outside Thailand. */
export function photonPlace(feature: unknown): Place | null {
  if (typeof feature !== 'object' || feature === null) return null;
  const { geometry, properties } = feature as { geometry?: unknown; properties?: unknown };
  if (typeof geometry !== 'object' || geometry === null || typeof properties !== 'object' || properties === null) return null;
  const coords = (geometry as { coordinates?: unknown }).coordinates;
  if (!Array.isArray(coords) || typeof coords[0] !== 'number' || typeof coords[1] !== 'number') return null;
  const [lng, lat] = coords;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;

  const p = properties as Record<string, unknown>;
  const country = text(p.countrycode);
  if (country && country.toUpperCase() !== 'TH') return null;
  const street = text(p.street);
  // A street or a house has no name of its own; show its address instead.
  const name = text(p.name) ?? (street ? [street, text(p.housenumber)].filter(Boolean).join(' ') : undefined);
  if (!name) return null;
  const detail = [street, text(p.district), text(p.city), text(p.county), text(p.state)]
    .filter((v, i, all): v is string => v !== undefined && v !== name && all.indexOf(v) === i)
    .slice(0, 3)
    .join(' · ');
  return { name, detail, lng, lat };
}

/** Places matching `query` anywhere in Thailand; with `near`, places close to that area rank higher. */
export async function photonSearch(query: string, limit: number, near: Bounds | null): Promise<Place[]> {
  const url = new URL('/api/', PHOTON_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('bbox', [THAILAND.west, THAILAND.south, THAILAND.east, THAILAND.north].join(','));
  if (near) {
    url.searchParams.set('lon', ((near.west + near.east) / 2).toFixed(5));
    url.searchParams.set('lat', ((near.south + near.north) / 2).toFixed(5));
    url.searchParams.set('zoom', '12');
  }
  const res = await throttle.run(() => fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(8_000), cache: 'no-store' }));
  if (!res.ok) throw new Error(`Photon HTTP ${res.status}`);
  const body: unknown = await res.json();
  const features = typeof body === 'object' && body !== null && Array.isArray((body as { features?: unknown }).features) ? (body as { features: unknown[] }).features : [];
  return features.map(photonPlace).filter((p): p is Place => p !== null);
}
