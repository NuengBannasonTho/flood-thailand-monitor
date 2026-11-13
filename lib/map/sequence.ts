import { bearing as bearingOf, haversine } from '../geo';
import { type Route, WET } from '../sim/roads';
import type { Vehicle } from '../sim/vehicles';

export type EaseName = 'io' | 'lin' | 'in' | 'out';
export type Keyframe = readonly [u: number, value: number, ease?: EaseName];

export interface SeqTrack {
  name: string;
  unit: string;
  kf: readonly Keyframe[];
  lo: number;
  hi: number;
}

export interface TripPose {
  lng: number;
  lat: number;
  /** compass heading of travel, degrees */
  heading: number;
  /** metres travelled */
  s: number;
  /** water depth under the vehicle, metres */
  depth: number;
}

export interface Trip {
  route: Route;
  /** duration of the whole sequence, seconds */
  duration: number;
  centroid: { lng: number; lat: number };
  bounds: [[number, number], [number, number]];
  tracks: readonly [car: SeqTrack, zoom: SeqTrack, pitch: SeqTrack, orbit: SeqTrack];
  /** wet or dry, sampled evenly along the timeline */
  wet: boolean[];
  poseAt(progress: number): TripPose;
}

export const EASE: Record<EaseName, (k: number) => number> = {
  io: (k) => k * k * (3 - 2 * k),
  lin: (k) => k,
  in: (k) => k * k,
  out: (k) => 1 - (1 - k) * (1 - k),
};

export function evalTrack(kfs: readonly Keyframe[], u: number): number {
  const first = kfs[0];
  if (u <= first[0]) return first[1];
  for (let i = 1; i < kfs.length; i++) {
    const [t1, v1, ease] = kfs[i];
    if (u <= t1) {
      const [t0, v0] = kfs[i - 1];
      return v0 + (v1 - v0) * EASE[ease ?? 'io']((u - t0) / (t1 - t0));
    }
  }
  return kfs[kfs.length - 1][1];
}

/** points along the route are resampled to this spacing so the camera turns smoothly, metres */
const SPACING = 12;
const SMOOTH = 8;
const WET_SAMPLES = 240;
const WET_SLOWDOWN = 1 / 0.35;

/**
 * Prepares a route for playback: even spacing, smoothed heading, slower progress through water,
 * and the keyframed camera tracks shown on the timeline. `overviewZoom` frames the whole route;
 * `depthAt` gives the water depth at a coordinate.
 */
export function buildTrip(route: Route, vehicle: Vehicle, depthAt: (lng: number, lat: number) => number, overviewZoom: number): Trip {
  const lng: number[] = [];
  const lat: number[] = [];
  const dist: number[] = [];
  const bridge: boolean[] = [];
  let travelled = 0;
  route.coords.forEach(([x, y], i) => {
    if (i === 0) {
      lng.push(x);
      lat.push(y);
      dist.push(0);
      bridge.push(route.onBridge[0] ?? false);
      return;
    }
    const [px, py] = route.coords[i - 1];
    const seg = haversine(px, py, x, y);
    const steps = Math.max(1, Math.round(seg / SPACING));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      lng.push(px + (x - px) * t);
      lat.push(py + (y - py) * t);
      dist.push(travelled + seg * t);
      bridge.push(route.onBridge[i] ?? false);
    }
    travelled += seg;
  });
  const n = lng.length;

  // The ground under a bridge may be deep water; the deck is not.
  const depth = lng.map((x, i) => (bridge[i] ? 0 : depthAt(x, lat[i])));
  const clock = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const slow = vehicle.draft === 0 && Math.max(depth[i], depth[i - 1]) > WET;
    clock[i] = clock[i - 1] + (dist[i] - dist[i - 1]) * (slow ? WET_SLOWDOWN : 1);
  }
  const total = clock[n - 1] || 1;

  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    let h = a === b ? 0 : bearingOf(lng[a], lat[a], lng[b], lat[b]);
    if (i > 0) {
      while (h - raw[i - 1] > 180) h -= 360;
      while (h - raw[i - 1] < -180) h += 360;
    }
    raw[i] = h;
  }
  const heading = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let q = Math.max(0, i - SMOOTH); q <= Math.min(n - 1, i + SMOOTH); q++) {
      sum += raw[q];
      count++;
    }
    heading[i] = sum / count;
  }

  const poseAt = (progress: number): TripPose => {
    const t = Math.min(1, Math.max(0, progress)) * total;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (clock[mid] <= t) lo = mid;
      else hi = mid;
    }
    const f = clock[hi] > clock[lo] ? (t - clock[lo]) / (clock[hi] - clock[lo]) : 0;
    const mix = (a: number, b: number): number => a + (b - a) * f;
    return { lng: mix(lng[lo], lng[hi]), lat: mix(lat[lo], lat[hi]), heading: mix(heading[lo], heading[hi]), s: mix(dist[lo], dist[hi]), depth: mix(depth[lo], depth[hi]) };
  };

  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (let i = 0; i < n; i++) {
    west = Math.min(west, lng[i]);
    east = Math.max(east, lng[i]);
    south = Math.min(south, lat[i]);
    north = Math.max(north, lat[i]);
  }

  const car: SeqTrack = { name: 'ตำแหน่ง', unit: '%', kf: [[0, 0], [0.1, 0], [0.2, 0.07, 'in'], [0.8, 0.93, 'lin'], [0.9, 1, 'out'], [1, 1]], lo: 0, hi: 1 };
  const zoom: SeqTrack = { name: 'ระยะกล้อง', unit: 'zoom', kf: [[0, overviewZoom], [0.16, 16.4], [0.5, 16], [0.84, 16.6], [1, 15.2]], lo: Math.min(overviewZoom, 15) - 0.5, hi: 17 };
  const pitch: SeqTrack = { name: 'มุมก้ม', unit: '°', kf: [[0, 25], [0.16, 62], [0.5, 56], [0.84, 64], [1, 48]], lo: 15, hi: 70 };
  const orbit: SeqTrack = { name: 'มุมหมุน', unit: '°', kf: [[0, 35], [0.16, 0], [0.5, -22], [0.84, 16], [1, 80]], lo: -30, hi: 85 };

  const wet: boolean[] = [];
  for (let i = 0; i < WET_SAMPLES; i++) wet.push(poseAt(evalTrack(car.kf, i / (WET_SAMPLES - 1))).depth > WET);

  return {
    route,
    duration: Math.min(30, Math.max(12, 9 + route.length / 300)),
    centroid: { lng: (west + east) / 2, lat: (south + north) / 2 },
    bounds: [
      [west, south],
      [east, north],
    ],
    tracks: [car, zoom, pitch, orbit],
    wet,
    poseAt,
  };
}
