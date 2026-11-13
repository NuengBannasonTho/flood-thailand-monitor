import { type Bounds, THAILAND } from './config';

const EARTH_CIRCUMFERENCE = 40_075_016.686;
const R = 6_371_008.8;
const RAD = Math.PI / 180;

/** Fractional tile column of a longitude at zoom `z` (Web Mercator, XYZ scheme). */
export const lngToTileX = (lng: number, z: number): number => ((lng + 180) / 360) * 2 ** z;

/** Fractional tile row of a latitude at zoom `z`. */
export const latToTileY = (lat: number, z: number): number => {
  const s = Math.sin(lat * RAD);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
};

export const tileXToLng = (x: number, z: number): number => (x / 2 ** z) * 360 - 180;

export const tileYToLat = (y: number, z: number): number => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return Math.atan(Math.sinh(n)) / RAD;
};

/** Ground size of one tile pixel in metres. */
export const metresPerPixel = (lat: number, z: number, tileSize: number): number => (EARTH_CIRCUMFERENCE * Math.cos(lat * RAD)) / (tileSize * 2 ** z);

export function haversine(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLng = (lng2 - lng1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Compass bearing in degrees, clockwise from north. */
export function bearing(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const y = Math.sin((lng2 - lng1) * RAD) * Math.cos(lat2 * RAD);
  const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lng2 - lng1) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** A box of at most `maxW` x `maxH` metres around `center`, never larger than `view`. */
export function clampBox(view: Bounds, center: { lng: number; lat: number }, maxW: number, maxH: number): Bounds {
  const dLat = (maxH / 2 / R) / RAD;
  const dLng = (maxW / 2 / (R * Math.cos(center.lat * RAD))) / RAD;
  return {
    west: Math.max(view.west, center.lng - dLng),
    east: Math.min(view.east, center.lng + dLng),
    south: Math.max(view.south, center.lat - dLat),
    north: Math.min(view.north, center.lat + dLat),
  };
}

export const boxContains = (b: Bounds, lng: number, lat: number): boolean => lng >= b.west && lng <= b.east && lat >= b.south && lat <= b.north;

export function boxAreaKm2(b: Bounds): number {
  const midLat = (b.south + b.north) / 2;
  return (haversine(b.west, midLat, b.east, midLat) * haversine(b.west, b.south, b.west, b.north)) / 1e6;
}

/** Reads "west,south,east,north" from a query string. Null when malformed or not in and around Thailand. */
export function parseBox(value: string | null): Bounds | null {
  const parts = (value ?? '').split(',').map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null;
  const [west, south, east, north] = parts;
  if (west >= east || south >= north) return null;
  if (west < THAILAND.west - 1 || east > THAILAND.east + 1 || south < THAILAND.south - 1 || north > THAILAND.north + 1) return null;
  return { west, south, east, north };
}

const WORLD: Bounds = { west: -180, south: -90, east: 180, north: 90 };

/**
 * A `maxW` x `maxH` metre box centred on `points`, keeping `margin` metres clear around them. Null when
 * the points are too far apart to fit.
 */
export function boxAround(points: readonly { lng: number; lat: number }[], maxW: number, maxH: number, margin: number): Bounds | null {
  if (points.length === 0) return null;
  const lngs = points.map((p) => p.lng);
  const lats = points.map((p) => p.lat);
  const west = Math.min(...lngs);
  const east = Math.max(...lngs);
  const south = Math.min(...lats);
  const north = Math.max(...lats);
  const center = { lng: (west + east) / 2, lat: (south + north) / 2 };
  if (haversine(west, center.lat, east, center.lat) + 2 * margin > maxW || haversine(center.lng, south, center.lng, north) + 2 * margin > maxH) return null;
  return clampBox(WORLD, center, maxW, maxH);
}
