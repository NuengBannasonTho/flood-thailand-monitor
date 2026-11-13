export interface Place {
  name: string;
  detail: string;
  lng: number;
  lat: number;
}

/** One page of search results; `next` is the offset of the following page, or null at the end. */
export interface PlacePage {
  places: Place[];
  next: number | null;
}

/** Identity used to drop repeats when pages are joined, and as a React key. */
export const placeKey = (p: Place): string => `${p.name}|${p.lng}|${p.lat}`;

/** Shape guard for /api/geocode and /api/reverse responses. */
export const isPlace = (v: unknown): v is Place => {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p.name === 'string' && typeof p.detail === 'string' && typeof p.lng === 'number' && typeof p.lat === 'number';
};

/**
 * Shortcuts to towns with a record of serious flooding. Coordinates are town centres, good to about
 * a kilometre: they only aim the camera. Anything else is found through search.
 */
export const QUICK_PLACES: readonly Place[] = [
  { name: 'หาดใหญ่', detail: 'สงขลา', lng: 100.4747, lat: 7.0086 },
  { name: 'เชียงใหม่', detail: 'ริมแม่น้ำปิง', lng: 98.9995, lat: 18.7877 },
  { name: 'แม่สาย', detail: 'เชียงราย', lng: 99.8762, lat: 20.4335 },
  { name: 'เชียงราย', detail: 'ริมแม่น้ำกก', lng: 99.8325, lat: 19.9105 },
  { name: 'อยุธยา', detail: 'เกาะเมือง', lng: 100.5689, lat: 14.3532 },
  { name: 'นครสวรรค์', detail: 'ปากน้ำโพ', lng: 100.1372, lat: 15.703 },
  { name: 'สุโขทัย', detail: 'ริมแม่น้ำยม', lng: 99.823, lat: 17.0078 },
  { name: 'อุบลราชธานี', detail: 'ริมแม่น้ำมูล', lng: 104.8587, lat: 15.2287 },
  { name: 'นครศรีธรรมราช', detail: 'ตัวเมือง', lng: 99.9631, lat: 8.4304 },
  { name: 'กรุงเทพมหานคร', detail: 'ริมแม่น้ำเจ้าพระยา', lng: 100.4935, lat: 13.7525 },
];
