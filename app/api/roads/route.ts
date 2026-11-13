import { ANALYSIS, type Bounds } from '@/lib/config';
import { boxAreaKm2, parseBox } from '@/lib/geo';
import { compactRoads, roadQuery } from '@/lib/server/overpass';
import { roadsFromTiles } from '@/lib/server/roadtiles';
import { jsonError, LruCache, OVERPASS_URLS, USER_AGENT } from '@/lib/server/upstream';
import type { RoadPayload } from '@/lib/sim/roads';

export const dynamic = 'force-dynamic';

/** An area can hold 65,000 road segments, so only a few are kept. */
const cache = new LruCache<RoadPayload>(8);
/** Slack on top of the client's limit, for rounding. */
const MAX_AREA_KM2 = ((ANALYSIS.maxWidthM * ANALYSIS.maxHeightM) / 1e6) * 1.15;

/** Fallback only: the public Overpass servers often queue a request for 30–40 s, or time out. */
async function roadsFromOverpass(box: Bounds): Promise<RoadPayload> {
  const body = new URLSearchParams({ data: roadQuery(box) });
  let lastError = 'ไม่ทราบสาเหตุ';
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(45_000),
        cache: 'no-store',
      });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      return compactRoads(await res.json());
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError);
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function GET(request: Request): Promise<Response> {
  const box = parseBox(new URL(request.url).searchParams.get('bbox'));
  if (!box) return jsonError('พิกัดพื้นที่ไม่ถูกต้อง หรืออยู่นอกประเทศไทย', 400);
  if (boxAreaKm2(box) > MAX_AREA_KM2) return jsonError('พื้นที่ใหญ่เกินไป ซูมเข้าอีกแล้วลองใหม่', 400);

  const key = [box.west, box.south, box.east, box.north].map((v) => v.toFixed(4)).join(',');
  const cached = cache.get(key);
  if (cached) return Response.json(cached, { headers: { 'Cache-Control': 'private, max-age=3600' } });

  // Vector tiles first: the same CDN as the base map, well under a second. Overpass only if they fail.
  let payload: RoadPayload;
  try {
    payload = await roadsFromTiles(box);
  } catch (tileError) {
    try {
      payload = await roadsFromOverpass(box);
    } catch (overpassError) {
      return jsonError(`โหลดข้อมูลถนนไม่สำเร็จ (ไทล์แผนที่: ${message(tileError)} · Overpass: ${message(overpassError)}) ลองใหม่อีกครั้งในอีกสักครู่`, 502);
    }
  }
  cache.set(key, payload);
  return Response.json(payload, { headers: { 'Cache-Control': 'private, max-age=3600' } });
}
