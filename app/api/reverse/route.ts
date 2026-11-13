import { THAILAND } from '@/lib/config';
import { reversePlace } from '@/lib/server/nominatim';
import { jsonError } from '@/lib/server/upstream';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const lng = Number(params.get('lng'));
  const lat = Number(params.get('lat'));
  const inside = Number.isFinite(lng) && Number.isFinite(lat) && lng >= THAILAND.west - 1 && lng <= THAILAND.east + 1 && lat >= THAILAND.south - 1 && lat <= THAILAND.north + 1;
  if (!inside) return jsonError('พิกัดไม่ถูกต้อง', 400);
  try {
    return Response.json({ place: await reversePlace(lng, lat) });
  } catch (error) {
    return jsonError(`หาชื่อสถานที่ไม่สำเร็จ (${error instanceof Error ? error.message : String(error)})`, 502);
  }
}
