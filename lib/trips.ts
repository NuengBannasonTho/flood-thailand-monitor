import type { Endpoint } from './map/controller';
import { VEHICLES, type VehicleId } from './sim/vehicles';
import { Store } from './store';

/** A trip kept in this browser: its stops in order and the vehicle. */
export interface SavedTrip {
  id: string;
  stops: { via: boolean; point: Endpoint }[];
  vehicle: VehicleId;
  savedAt: number;
}

const KEY = 'flood-thai:trips';
const LIMIT = 30;
const EMPTY: readonly SavedTrip[] = [];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isEndpoint = (v: unknown): v is Endpoint => isRecord(v) && typeof v.lng === 'number' && typeof v.lat === 'number' && typeof v.name === 'string';
const isTrip = (v: unknown): v is SavedTrip =>
  isRecord(v) &&
  typeof v.id === 'string' &&
  typeof v.savedAt === 'number' &&
  VEHICLES.some((x) => x.id === v.vehicle) &&
  Array.isArray(v.stops) &&
  v.stops.length >= 2 &&
  v.stops.every((s) => isRecord(s) && typeof s.via === 'boolean' && isEndpoint(s.point));

/** Saved trips, newest first. Empty until `startSavedTrips` reads storage, so the server render matches. */
export const savedTrips = new Store<readonly SavedTrip[]>(EMPTY);
export const noSavedTrips = (): readonly SavedTrip[] => EMPTY;

function read(): SavedTrip[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isTrip) : [];
  } catch {
    return []; // storage blocked or corrupt: start empty
  }
}

function write(list: readonly SavedTrip[]): void {
  savedTrips.set(list);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // storage full or blocked: the list still works until the page closes
  }
}

/** Reads storage and follows changes made in other tabs. Returns the cleanup. */
export function startSavedTrips(): () => void {
  savedTrips.set(read());
  const onStorage = (e: StorageEvent): void => {
    if (e.key === KEY) savedTrips.set(read());
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

/** Identity of a trip's stops, to tell whether the current one is already saved. */
export const tripKey = (stops: readonly { via: boolean; point: Endpoint }[]): string =>
  stops.map((s) => `${s.via ? '~' : ''}${s.point.lng.toFixed(5)},${s.point.lat.toFixed(5)}`).join(';');

export function saveTrip(stops: SavedTrip['stops'], vehicle: VehicleId): void {
  const key = tripKey(stops);
  const rest = savedTrips.get().filter((t) => tripKey(t.stops) !== key);
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  write([{ id, stops, vehicle, savedAt: Date.now() }, ...rest].slice(0, LIMIT));
}

export function removeTrip(id: string): void {
  write(savedTrips.get().filter((t) => t.id !== id));
}
