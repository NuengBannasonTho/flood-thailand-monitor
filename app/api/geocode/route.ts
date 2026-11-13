import { boxAreaKm2, parseBox } from '@/lib/geo';
import { SEARCH_MAX, searchPlaces } from '@/lib/server/search';
import { jsonError } from '@/lib/server/upstream';

export const dynamic = 'force-dynamic';

/** `near` is a simulated area, which is far smaller than this. */
const MAX_NEAR_KM2 = 2_500;

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const query = (params.get('q') ?? '').trim();
  const offset = Number(params.get('offset') ?? 0);
  const nearParam = params.get('near');
  const near = nearParam === null ? null : parseBox(nearParam);
  if (query.length < 2 || query.length > 80) return jsonError('พิมพ์ชื่อสถานที่ 2 ถึง 80 ตัวอักษร', 400);
  if (!Number.isInteger(offset) || offset < 0 || offset >= SEARCH_MAX) return jsonError('ลำดับผลค้นหาไม่ถูกต้อง', 400);
  if (nearParam !== null && (!near || boxAreaKm2(near) > MAX_NEAR_KM2)) return jsonError('ขอบเขตพื้นที่ค้นหาไม่ถูกต้อง', 400);
  try {
    return Response.json(await searchPlaces(query, offset, near));
  } catch (error) {
    return jsonError(`ค้นหาสถานที่ไม่สำเร็จ (${error instanceof Error ? error.message : String(error)})`, 502);
  }
}
