import type { Bounds } from '../config';
import { boxContains, haversine } from '../geo';
import type { Place, PlacePage } from '../places';
import { nominatimSearch } from './nominatim';
import { photonSearch } from './photon';
import { LruCache } from './upstream';

export const SEARCH_PAGE = 10;
/** Most places kept for one search; pages are cut from these. */
export const SEARCH_MAX = 40;
/** What each source is asked for. Nominatim's own ceiling is 40. */
const PER_SOURCE = 25;

const cache = new LruCache<Place[]>(200);

const squash = (name: string): string => name.toLowerCase().replace(/[\s.,\-()]/g, '');

/**
 * Joins lists in order, leaving out a place already listed: one at the same spot, or one with the
 * same name close by (a building and the grounds around it, or the same place from two sources).
 */
export function mergePlaces(lists: readonly (readonly Place[])[]): Place[] {
  const out: Place[] = [];
  for (const list of lists) {
    for (const p of list) {
      const seen = out.some((q) => {
        const d = haversine(p.lng, p.lat, q.lng, q.lat);
        return d < 40 || (d < 600 && squash(p.name) === squash(q.name));
      });
      if (!seen) out.push(p);
    }
  }
  return out;
}

/** Places inside `box` first, each group in its original order. */
export function insideFirst(places: readonly Place[], box: Bounds): Place[] {
  const inside = places.filter((p) => boxContains(box, p.lng, p.lat));
  return [...inside, ...places.filter((p) => !boxContains(box, p.lng, p.lat))];
}

/**
 * Every place both sources find, Nominatim's first. Nominatim matches whole names and addresses;
 * Photon also matches the start of a name ("เซ็นทรัล" finds every branch). If one source fails,
 * the other still answers.
 */
async function searchAll(query: string, near: Bounds | null): Promise<Place[]> {
  const area = near ? [near.west, near.south, near.east, near.north].map((v) => v.toFixed(3)).join(',') : '';
  const key = `${area}:${query.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const results = await Promise.allSettled([nominatimSearch(query, PER_SOURCE, near), photonSearch(query, PER_SOURCE, near)]);
  const found = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  if (found.length === 0) {
    const reason = results.map((r) => (r.status === 'rejected' && r.reason instanceof Error ? r.reason.message : 'error')).join(', ');
    throw new Error(reason);
  }
  const merged = mergePlaces(found);
  const places = (near ? insideFirst(merged, near) : merged).slice(0, SEARCH_MAX);
  // A partial answer is not kept, so the next search asks the failed source again.
  if (found.length === results.length) cache.set(key, places);
  return places;
}

/** One page of results from across Thailand. `near` (the simulated area) puts places inside it first. */
export async function searchPlaces(query: string, offset = 0, near: Bounds | null = null): Promise<PlacePage> {
  const all = await searchAll(query, near);
  const end = offset + SEARCH_PAGE;
  return { places: all.slice(offset, end), next: end < all.length ? end : null };
}
