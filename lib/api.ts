import type { Bounds } from './config';
import { isPlace, type Place, type PlacePage } from './places';
import type { RoadPayload } from './sim/roads';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isNumberArray = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => typeof n === 'number');

function isRoadPayload(v: unknown): v is RoadPayload {
  return isRecord(v) && isNumberArray(v.vx) && isNumberArray(v.vy) && v.vx.length === v.vy.length && Array.isArray(v.edges) && Array.isArray(v.names);
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(isRecord(body) && typeof body.error === 'string' ? body.error : `คำขอไม่สำเร็จ (HTTP ${res.status})`);
  return body;
}

export async function fetchRoads(box: Bounds, signal: AbortSignal): Promise<RoadPayload> {
  const bbox = [box.west, box.south, box.east, box.north].map((v) => v.toFixed(5)).join(',');
  const body = await getJson(`/api/roads?bbox=${bbox}`, signal);
  if (!isRoadPayload(body)) throw new Error('ข้อมูลถนนที่ได้รับมีรูปแบบไม่ถูกต้อง');
  return body;
}

/** Searches all of Thailand; places inside `near` come first. */
export async function searchPlaces(query: string, signal: AbortSignal, offset = 0, near: Bounds | null = null): Promise<PlacePage> {
  const area = near ? `&near=${[near.west, near.south, near.east, near.north].map((v) => v.toFixed(5)).join(',')}` : '';
  const body = await getJson(`/api/geocode?q=${encodeURIComponent(query)}&offset=${offset}${area}`, signal);
  if (!isRecord(body)) return { places: [], next: null };
  return { places: Array.isArray(body.places) ? body.places.filter(isPlace) : [], next: typeof body.next === 'number' ? body.next : null };
}

export async function reversePlace(lng: number, lat: number): Promise<Place | null> {
  const body = await getJson(`/api/reverse?lng=${lng.toFixed(6)}&lat=${lat.toFixed(6)}`);
  return isRecord(body) && isPlace(body.place) ? body.place : null;
}
