import type { Endpoint } from './map/controller';

/** One row of the trip: a stop to reach, or (`via`) a point the route only has to pass through. */
export interface Stop {
  id: string;
  via: boolean;
  point: Endpoint | null;
}

/** Most rows a trip may have, stops and points passed through together. */
export const MAX_STOPS = 10;

let made = 0;
export const newStop = (via = false, point: Endpoint | null = null): Stop => ({ id: `stop-${++made}`, via, point });

/** Fixed ids for the first render, so the server and the browser agree. */
export const FIRST_STOPS: readonly Stop[] = [
  { id: 'start', via: false, point: null },
  { id: 'end', via: false, point: null },
];

/** A, B, C… for the stops in order; null for points passed through. */
export function stopLetters(stops: readonly Stop[]): (string | null)[] {
  let n = 0;
  return stops.map((s) => (s.via ? null : String.fromCharCode(65 + n++)));
}

export function stopLabel(stops: readonly Stop[], index: number): string {
  if (stops[index]?.via) return 'จุดที่ผ่าน';
  if (index === 0) return 'จุดเริ่มต้น';
  if (index === stops.length - 1) return 'ปลายทาง';
  return 'จุดแวะ';
}

/** Moves the row at `from` to `to`. */
export function moveStop(stops: readonly Stop[], from: number, to: number): Stop[] {
  const next = [...stops];
  const [row] = next.splice(from, 1);
  if (row) next.splice(Math.max(0, Math.min(next.length, to)), 0, row);
  return next;
}
