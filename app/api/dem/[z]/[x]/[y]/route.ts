import { DEM_TILE_URL } from '@/lib/config';
import { jsonError, USER_AGENT } from '@/lib/server/upstream';

export const dynamic = 'force-dynamic';

/**
 * Same-origin copy of one elevation tile. The browser normally reads tiles straight from the tile
 * host; this is the fallback for when a network or CORS rule blocks that.
 */
export async function GET(_request: Request, context: { params: Promise<{ z: string; x: string; y: string }> }): Promise<Response> {
  const { z, x, y } = await context.params;
  const zoom = Number(z);
  const col = Number(x);
  const row = Number(y.replace(/\.png$/, ''));
  const valid = [zoom, col, row].every(Number.isInteger) && zoom >= 0 && zoom <= 15 && col >= 0 && row >= 0 && col < 2 ** zoom && row < 2 ** zoom;
  if (!valid) return jsonError('เลขไทล์ไม่ถูกต้อง', 400);
  const url = DEM_TILE_URL.replace('{z}', String(zoom)).replace('{x}', String(col)).replace('{y}', String(row));
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20_000), cache: 'no-store' });
    if (!res.ok) return jsonError(`ต้นทางตอบ HTTP ${res.status}`, 502);
    return new Response(await res.arrayBuffer(), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800, immutable' } });
  } catch (error) {
    return jsonError(`โหลดไทล์ความสูงไม่สำเร็จ (${error instanceof Error ? error.message : String(error)})`, 502);
  }
}
