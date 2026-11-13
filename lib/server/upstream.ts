/** Server-side settings for the public OpenStreetMap services this app calls. */

const contact = process.env.CONTACT_EMAIL?.trim();

/** Both Nominatim and Overpass ask callers to identify the application. */
export const USER_AGENT = `flood-thai/0.1 (${contact || 'local development'})`;

export const OVERPASS_URLS: readonly string[] = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

export const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
/** Photon: search over the same OpenStreetMap data, but it matches part of a name, which Nominatim often misses. */
export const PHOTON_URL = process.env.PHOTON_URL || 'https://photon.komoot.io';

/** Small in-memory cache with insertion-order eviction. Per server process. */
export class LruCache<T> {
  private readonly items = new Map<string, T>();
  constructor(private readonly limit: number) {}

  get(key: string): T | undefined {
    const value = this.items.get(key);
    if (value !== undefined) {
      this.items.delete(key);
      this.items.set(key, value);
    }
    return value;
  }

  set(key: string, value: T): void {
    this.items.delete(key);
    this.items.set(key, value);
    if (this.items.size > this.limit) {
      const oldest = this.items.keys().next();
      if (!oldest.done) this.items.delete(oldest.value);
    }
  }
}

/** Runs tasks one at a time with a minimum gap between starts. Nominatim allows 1 request per second. */
export class Throttle {
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;
  constructor(private readonly gapMs: number) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      const wait = this.last + this.gapMs - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.last = Date.now();
      return task();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
