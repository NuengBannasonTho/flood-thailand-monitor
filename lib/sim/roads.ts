import { haversine } from '../geo';
import { cellAt, type DemGrid } from './dem';
import type { Vehicle } from './vehicles';

export const ROAD_CLASSES = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'unclassified',
  'residential',
  'living_street',
  'motorway_link',
  'trunk_link',
  'primary_link',
  'secondary_link',
  'tertiary_link',
] as const;

export type RoadClass = (typeof ROAD_CLASSES)[number];

/** Free-flow speeds by road class, km/h. Rough urban figures for Thailand. */
const SPEED_KMH: Record<RoadClass, number> = {
  motorway: 90,
  trunk: 70,
  primary: 55,
  secondary: 45,
  tertiary: 40,
  unclassified: 30,
  residential: 25,
  living_street: 12,
  motorway_link: 50,
  trunk_link: 45,
  primary_link: 40,
  secondary_link: 35,
  tertiary_link: 30,
};

/** Compact road network sent by /api/roads. */
export interface RoadPayload {
  /** junction longitudes and latitudes */
  vx: number[];
  vy: number[];
  edges: RoadPayloadEdge[];
  names: string[];
}

export interface RoadPayloadEdge {
  a: number;
  b: number;
  /** full geometry including both ends: lng, lat, lng, lat, ... */
  g: number[];
  /** index into ROAD_CLASSES */
  c: number;
  /** index into names, or -1 */
  n: number;
  /** 1 = one-way a to b, -1 = one-way b to a, 0 = both ways */
  o: -1 | 0 | 1;
  /** 1 when the way is a bridge: it stays above the flood */
  br: 0 | 1;
}

export interface RoadEdge {
  id: number;
  a: number;
  b: number;
  cls: RoadClass;
  name: string | null;
  oneway: -1 | 0 | 1;
  bridge: boolean;
  /** metres */
  len: number;
  /** lng, lat pairs */
  pts: Float64Array;
  /** the same geometry as GeoJSON coordinates, built once so status updates allocate nothing */
  line: [number, number][];
  /** DEM cell under each flood sample, -1 outside the grid */
  cells: Int32Array;
}

export interface RoadGraph {
  vx: Float64Array;
  vy: Float64Array;
  edges: RoadEdge[];
  /** per junction: the edges that touch it */
  adj: number[][];
  /** per junction: 1 when it is on a network big enough to snap a stop to (see `mainNetworks`) */
  snap: Uint8Array;
}

export interface EdgeDepths {
  /** deepest and shallowest water along each edge, metres */
  max: Float32Array;
  min: Float32Array;
}

export interface Route {
  edges: number[];
  /** lng, lat pairs in travel order */
  coords: [number, number][];
  /** per edge: index in `coords` where it starts; it ends where the next one starts */
  edgeStart: number[];
  /** per leg between two stops: index in `coords` where it starts. One leg, [0], without stops. */
  legStart: number[];
  /** per coordinate: true when the stretch leading to it is a bridge, which stays above the flood */
  onBridge: boolean[];
  /** metres */
  length: number;
  /** seconds */
  time: number;
  maxDepth: number;
  wetLength: number;
  /** names of the longest named roads on the way, longest first */
  roads: string[];
}

/** water shallower than this counts as a dry road, metres */
export const WET = 0.05;
const WET_SPEED_FACTOR = 0.35;
/** flood samples along an edge are at most this far apart, metres */
const SAMPLE_STEP = 25;

export function buildGraph(payload: RoadPayload, grid: DemGrid): RoadGraph {
  const vx = Float64Array.from(payload.vx);
  const vy = Float64Array.from(payload.vy);
  const adj: number[][] = Array.from({ length: vx.length }, () => []);
  const edges: RoadEdge[] = [];
  for (const raw of payload.edges) {
    const cls = ROAD_CLASSES[raw.c];
    if (!cls || raw.g.length < 4 || raw.a >= vx.length || raw.b >= vx.length) continue;
    const pts = Float64Array.from(raw.g);
    const line: [number, number][] = [];
    const cells: number[] = [];
    let len = 0;
    for (let i = 0; i < pts.length; i += 2) {
      if (i > 0) {
        const seg = haversine(pts[i - 2], pts[i - 1], pts[i], pts[i + 1]);
        len += seg;
        const steps = Math.floor(seg / SAMPLE_STEP);
        for (let s = 1; s <= steps; s++) {
          const t = s / (steps + 1);
          cells.push(cellAt(grid, pts[i - 2] + (pts[i] - pts[i - 2]) * t, pts[i - 1] + (pts[i + 1] - pts[i - 1]) * t));
        }
      }
      cells.push(cellAt(grid, pts[i], pts[i + 1]));
      line.push([pts[i], pts[i + 1]]);
    }
    const id = edges.length;
    edges.push({ id, a: raw.a, b: raw.b, cls, name: raw.n >= 0 ? (payload.names[raw.n] ?? null) : null, oneway: raw.o, bridge: raw.br === 1, len, pts, line, cells: Int32Array.from(cells) });
    adj[raw.a].push(id);
    adj[raw.b].push(id);
  }
  return { vx, vy, edges, adj, snap: mainNetworks(vx.length, edges, adj) };
}

/** a network smaller than this share of the largest one, or than MAIN_MIN junctions, is a stray fragment */
const MAIN_SHARE = 0.02;
const MAIN_MIN = 30;

/**
 * Marks the junctions on the area's main road networks. The data also holds stray fragments: a
 * campus or estate road whose links out are service roads, which are not loaded, or a piece cut
 * off at the area's edge. A stop snapped to one of those could never be reached.
 */
function mainNetworks(n: number, edges: readonly RoadEdge[], adj: readonly number[][]): Uint8Array {
  const comp = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0 || adj[s].length === 0) continue;
    const id = sizes.length;
    let size = 0;
    comp[s] = id;
    stack.push(s);
    while (stack.length > 0) {
      const u = stack.pop() as number;
      size++;
      for (const ei of adj[u]) {
        const e = edges[ei];
        const v = e.a === u ? e.b : e.a;
        if (comp[v] < 0) {
          comp[v] = id;
          stack.push(v);
        }
      }
    }
    sizes.push(size);
  }
  const largest = Math.max(...sizes, 0);
  const floor = Math.min(largest, Math.max(largest * MAIN_SHARE, MAIN_MIN));
  const snap = new Uint8Array(n);
  for (let v = 0; v < n; v++) if (comp[v] >= 0 && sizes[comp[v]] >= floor) snap[v] = 1;
  return snap;
}

/** Deepest and shallowest water along every edge, given the water depth at any DEM cell. */
export function edgeDepths(graph: RoadGraph, depthAtCell: (cell: number) => number): EdgeDepths {
  const n = graph.edges.length;
  const depths: EdgeDepths = { max: new Float32Array(n), min: new Float32Array(n) };
  for (const e of graph.edges) {
    let max = 0;
    let min = Infinity;
    if (e.bridge) {
      min = 0;
    } else {
      for (let i = 0; i < e.cells.length; i++) {
        const d = depthAtCell(e.cells[i]);
        if (d > max) max = d;
        if (d < min) min = d;
      }
    }
    depths.max[e.id] = max;
    depths.min[e.id] = min === Infinity ? 0 : min;
  }
  return depths;
}

/** Travel time over one edge in seconds, or Infinity when this vehicle cannot use it. */
export function edgeCost(e: RoadEdge, depths: EdgeDepths, vehicle: Vehicle): number {
  if (vehicle.banned.includes(e.cls)) return Infinity;
  if (vehicle.draft > 0) {
    // A boat follows flooded streets only, and cannot pass under or over a bridge deck.
    return depths.min[e.id] >= vehicle.draft ? e.len / (vehicle.maxKmh / 3.6) : Infinity;
  }
  const depth = depths.max[e.id];
  if (depth > vehicle.wade) return Infinity;
  const kmh = Math.min(SPEED_KMH[e.cls], vehicle.maxKmh) * (depth > WET ? WET_SPEED_FACTOR : 1);
  return e.len / (kmh / 3.6);
}

/** The nearest junction on one of the area's main road networks. */
export function nearestVertex(graph: RoadGraph, lng: number, lat: number): number {
  let best = -1;
  let bestD = Infinity;
  const k = Math.cos((lat * Math.PI) / 180);
  for (let i = 0; i < graph.vx.length; i++) {
    if (graph.snap[i] === 0) continue;
    const dx = (graph.vx[i] - lng) * k;
    const dy = graph.vy[i] - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Binary min-heap of vertex ids keyed by a cost array. */
class MinHeap {
  private readonly items: number[] = [];
  constructor(private readonly key: Float64Array) {}

  get size(): number {
    return this.items.length;
  }

  push(v: number): void {
    const a = this.items;
    let i = a.length;
    a.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.key[a[p]] <= this.key[v]) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = v;
  }

  pop(): number {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last !== undefined) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && this.key[a[c + 1]] < this.key[a[c]]) c++;
        if (this.key[a[c]] >= this.key[last]) break;
        a[i] = a[c];
        i = c;
      }
      a[i] = last;
    }
    return top;
  }
}

interface Path {
  edges: number[];
  vertices: number[];
}

/** Fastest any road can be driven by this vehicle, m/s: no route can beat the straight line at this speed. */
const topSpeed = (vehicle: Vehicle): number => (vehicle.draft > 0 ? vehicle.maxKmh : Math.min(vehicle.maxKmh, Math.max(...Object.values(SPEED_KMH)))) / 3.6;

/**
 * Fastest path by A*: the straight-line distance at `speed` (m/s) never overestimates the time
 * left, so the answer is the same as Dijkstra's, found while looking at far fewer junctions.
 */
function shortest(graph: RoadGraph, from: number, to: number, cost: Float64Array, respectOneway: boolean, speed: number): Path | null {
  const n = graph.vx.length;
  const dist = new Float64Array(n).fill(Infinity);
  const estimate = new Float64Array(n).fill(Infinity);
  const prevEdge = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new MinHeap(estimate);
  // Flat-earth metres to the target, a hair short so it stays a lower bound.
  const tx = graph.vx[to];
  const ty = graph.vy[to];
  const mx = 111_320 * Math.cos((ty * Math.PI) / 180) * 0.995;
  const my = 110_574 * 0.995;
  const left = (v: number): number => Math.hypot((graph.vx[v] - tx) * mx, (graph.vy[v] - ty) * my) / speed;
  dist[from] = 0;
  estimate[from] = left(from);
  heap.push(from);
  while (heap.size > 0) {
    const u = heap.pop();
    if (done[u]) continue;
    if (u === to) break;
    done[u] = 1;
    for (const ei of graph.adj[u]) {
      const c = cost[ei];
      if (c === Infinity) continue;
      const e = graph.edges[ei];
      const forward = e.a === u;
      if (respectOneway && ((forward && e.oneway === -1) || (!forward && e.oneway === 1))) continue;
      const v = forward ? e.b : e.a;
      const nd = dist[u] + c;
      if (nd < dist[v]) {
        dist[v] = nd;
        estimate[v] = nd + left(v);
        prevEdge[v] = ei;
        heap.push(v);
      }
    }
  }
  if (dist[to] === Infinity) return null;
  const edges: number[] = [];
  const vertices: number[] = [to];
  for (let v = to; v !== from; ) {
    const ei = prevEdge[v];
    const e = graph.edges[ei];
    v = e.a === v ? e.b : e.a;
    edges.push(ei);
    vertices.push(v);
  }
  return { edges: edges.reverse(), vertices: vertices.reverse() };
}

function describe(graph: RoadGraph, path: Path, depths: EdgeDepths, vehicle: Vehicle): Route {
  const coords: [number, number][] = [];
  const onBridge: boolean[] = [];
  let length = 0;
  let time = 0;
  let maxDepth = 0;
  let wetLength = 0;
  const edgeStart: number[] = [];
  path.edges.forEach((ei, idx) => {
    const e = graph.edges[ei];
    const forward = e.a === path.vertices[idx];
    const count = e.pts.length / 2;
    edgeStart.push(Math.max(0, coords.length - 1));
    for (let q = idx === 0 ? 0 : 1; q < count; q++) {
      const k = (forward ? q : count - 1 - q) * 2;
      coords.push([e.pts[k], e.pts[k + 1]]);
      onBridge.push(e.bridge);
    }
    length += e.len;
    time += edgeCost(e, depths, vehicle);
    const depth = depths.max[ei];
    if (depth > maxDepth) maxDepth = depth;
    if (depth > WET) wetLength += e.len;
  });
  return { edges: path.edges, coords, edgeStart, legStart: [0], onBridge, length, time, maxDepth, wetLength, roads: mainRoads(graph, path.edges) };
}

/** Names of the longest named roads among `edges`, longest first. */
function mainRoads(graph: RoadGraph, edges: readonly number[]): string[] {
  const byName = new Map<string, number>();
  for (const ei of edges) {
    const e = graph.edges[ei];
    if (e.name) byName.set(e.name, (byName.get(e.name) ?? 0) + e.len);
  }
  return [...byName.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 3)
    .map(([name]) => name);
}

/** One route through consecutive legs; each leg starts where the one before it ends. */
export function joinRoutes(graph: RoadGraph, legs: readonly Route[]): Route {
  const out: Route = { edges: [], coords: [], edgeStart: [], legStart: [], onBridge: [], length: 0, time: 0, maxDepth: 0, wetLength: 0, roads: [] };
  for (const leg of legs) {
    // The first point of a leg repeats the last point of the one before.
    const skip = out.coords.length === 0 ? 0 : 1;
    const base = out.coords.length - skip;
    out.legStart.push(Math.max(0, base));
    for (const start of leg.edgeStart) out.edgeStart.push(base + start);
    out.edges.push(...leg.edges);
    out.coords.push(...leg.coords.slice(skip));
    out.onBridge.push(...leg.onBridge.slice(skip));
    out.length += leg.length;
    out.time += leg.time;
    out.maxDepth = Math.max(out.maxDepth, leg.maxDepth);
    out.wetLength += leg.wetLength;
  }
  out.roads = mainRoads(graph, out.edges);
  return out;
}

/** Up to three distinct routes this vehicle can complete, fastest first. */
export function findRoutes(graph: RoadGraph, from: number, to: number, depths: EdgeDepths, vehicle: Vehicle): Route[] {
  const out: Route[] = [];
  if (from < 0 || to < 0 || from === to) return out;
  const respectOneway = vehicle.draft === 0;
  const cost = new Float64Array(graph.edges.length);
  for (const e of graph.edges) cost[e.id] = edgeCost(e, depths, vehicle);
  const speed = topSpeed(vehicle);
  for (let attempt = 0; attempt < 6 && out.length < 3; attempt++) {
    const path = shortest(graph, from, to, cost, respectOneway, speed);
    if (!path) break;
    const route = describe(graph, path, depths, vehicle);
    const duplicate = out.some((other) => {
      const seen = new Set(other.edges);
      let shared = 0;
      for (const ei of route.edges) if (seen.has(ei)) shared += graph.edges[ei].len;
      return shared / route.length > 0.7;
    });
    const fastest = out[0];
    if (!duplicate && (!fastest || route.time < fastest.time * 2.2)) out.push(route);
    for (const ei of path.edges) cost[ei] *= 1.7;
  }
  return out.sort((x, y) => x.time - y.time);
}

/**
 * Routes through `stops` (junctions, in order). With two stops, up to three alternatives as
 * findRoutes gives; with more, the fastest way through every leg, joined into one route. Empty when
 * any leg cannot be done. A stop on the same junction as the one before it adds nothing.
 */
export function planRoutes(graph: RoadGraph, stops: readonly number[], depths: EdgeDepths, vehicle: Vehicle): Route[] {
  const points = stops.filter((v, i) => i === 0 || v !== stops[i - 1]);
  if (points.length < 2 || points.some((v) => v < 0)) return [];
  if (points.length === 2) return findRoutes(graph, points[0], points[1], depths, vehicle);
  const cost = costs(graph, depths, vehicle);
  const legs: Route[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const path = shortest(graph, points[i], points[i + 1], cost, vehicle.draft === 0, topSpeed(vehicle));
    if (!path) return [];
    legs.push(describe(graph, path, depths, vehicle));
  }
  return [joinRoutes(graph, legs)];
}

/** Index of the first leg between `stops` this vehicle cannot do, or -1 when every leg works. */
export function blockedLeg(graph: RoadGraph, stops: readonly number[], depths: EdgeDepths, vehicle: Vehicle): number {
  const cost = costs(graph, depths, vehicle);
  for (let i = 0; i + 1 < stops.length; i++) {
    if (stops[i] !== stops[i + 1] && !shortest(graph, stops[i], stops[i + 1], cost, vehicle.draft === 0, topSpeed(vehicle))) return i;
  }
  return -1;
}

function costs(graph: RoadGraph, depths: EdgeDepths, vehicle: Vehicle): Float64Array {
  const cost = new Float64Array(graph.edges.length);
  for (const e of graph.edges) cost[e.id] = edgeCost(e, depths, vehicle);
  return cost;
}

/** True when this vehicle has any way through. Cheaper than findRoutes. */
export function canReach(graph: RoadGraph, from: number, to: number, depths: EdgeDepths, vehicle: Vehicle): boolean {
  if (from < 0 || to < 0 || from === to) return false;
  const cost = new Float64Array(graph.edges.length);
  for (const e of graph.edges) cost[e.id] = edgeCost(e, depths, vehicle);
  return shortest(graph, from, to, cost, vehicle.draft === 0, topSpeed(vehicle)) !== null;
}

export interface RoadStatus {
  /** flooded but passable for the vehicle, and closed: arrays of [lng, lat] lines */
  wade: [number, number][][];
  shut: [number, number][][];
  shutKm: number;
}

/** Flooded road segments split by whether the vehicle can still use them. */
export function roadStatus(graph: RoadGraph, depths: EdgeDepths, vehicle: Vehicle): RoadStatus {
  const wade: [number, number][][] = [];
  const shut: [number, number][][] = [];
  let shutM = 0;
  for (const e of graph.edges) {
    const depth = depths.max[e.id];
    if (depth <= WET) continue;
    const closed = vehicle.draft > 0 ? depths.min[e.id] < vehicle.draft : depth > vehicle.wade;
    if (closed) {
      shut.push(e.line);
      shutM += e.len;
    } else {
      wade.push(e.line);
    }
  }
  return { wade, shut, shutKm: shutM / 1000 };
}
