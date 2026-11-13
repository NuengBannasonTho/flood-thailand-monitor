import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import type { Bounds } from '../config';
import { latToTileY, lngToTileX } from '../geo';
import { ROAD_CLASSES, type RoadPayload, type RoadPayloadEdge } from '../sim/roads';
import { USER_AGENT } from './upstream';

/*
 * Road network for an area, cut from the OpenFreeMap vector tiles that the base map already uses.
 *
 * The public Overpass servers queue every request for 30–40 s (even a one-node query) and often
 * time out; the tiles come from a CDN in well under a second. Tiles hold roads as merged, lightly
 * simplified lines, so the network is rebuilt here:
 *  - each line is clipped to its own tile, dropping the overlap every tile carries of its neighbours;
 *  - junctions are found wherever roads at the same grade share a point, cross, or one ends on
 *    another, because simplification can drop the shared OSM node from a straight road;
 *  - names come from the separate transportation_name layer, matched by position.
 */

const TILEJSON_URL = process.env.ROAD_TILES_URL || 'https://tiles.openfreemap.org/planet';
const ZOOM = 14;
const FETCH_CONCURRENCY = 8;

/* Distances below are in tile units: 4096 per z14 tile, about 0.6 m in Thailand. */
/** Points closer than this are the same point. */
const JOIN = 2;
/** A road that stops this close to another road is taken to meet it. */
const REACH = 5;
/** How far a road's name line may sit from the road itself. */
const NAME_REACH = 10;
/** Spatial hash cell. */
const CELL = 128;
/** Area kept around the requested box, metres: routes may run a little outside it. */
const MARGIN_M = 150;

const CLASS_OF: Record<string, (typeof ROAD_CLASSES)[number]> = {
  motorway: 'motorway',
  trunk: 'trunk',
  primary: 'primary',
  secondary: 'secondary',
  tertiary: 'tertiary',
  minor: 'residential',
};

/** One road line in global tile units (x, y, x, y, ...). */
export interface TileLine {
  pts: number[];
  /** index into ROAD_CLASSES */
  cls: number;
  oneway: -1 | 0 | 1;
  bridge: boolean;
  /** roads only meet mid-line when this matches: '' is at grade, else e.g. 'bridge:1' */
  grade: string;
}

export interface NameLine {
  pts: number[];
  name: string;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/* ---------------- geometry ---------------- */

/** Liang–Barsky: the part of a segment inside the rectangle, or null. */
function clipSegment(ax: number, ay: number, bx: number, by: number, r: Rect): [number, number, number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - r.x0, r.x1 - ax, ay - r.y0, r.y1 - ay];
  for (let k = 0; k < 4; k++) {
    if (p[k] === 0) {
      if (q[k] < 0) return null;
      continue;
    }
    const t = q[k] / p[k];
    if (p[k] < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return [ax + t0 * dx, ay + t0 * dy, ax + t1 * dx, ay + t1 * dy];
}

/** Splits a polyline into the pieces that lie inside the rectangle. */
export function clipLine(pts: readonly number[], r: Rect): number[][] {
  const pieces: number[][] = [];
  let cur: number[] = [];
  const flush = (): void => {
    if (cur.length >= 4) pieces.push(cur);
    cur = [];
  };
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const seg = clipSegment(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], r);
    if (!seg) {
      flush();
      continue;
    }
    const [ax, ay, bx, by] = seg;
    if (cur.length > 0 && (cur[cur.length - 2] !== ax || cur[cur.length - 1] !== ay)) flush();
    if (cur.length === 0) cur.push(ax, ay);
    cur.push(bx, by);
    if (bx !== pts[i + 2] || by !== pts[i + 3]) flush(); // the line leaves the rectangle here
  }
  flush();
  return pieces;
}

class SegmentIndex {
  private readonly cells = new Map<number, number[]>();
  readonly line: number[] = [];
  readonly seg: number[] = [];

  add(lineIndex: number, segIndex: number, ax: number, ay: number, bx: number, by: number, pad: number): number {
    const id = this.line.length;
    this.line.push(lineIndex);
    this.seg.push(segIndex);
    const cx0 = Math.floor((Math.min(ax, bx) - pad) / CELL);
    const cx1 = Math.floor((Math.max(ax, bx) + pad) / CELL);
    const cy0 = Math.floor((Math.min(ay, by) - pad) / CELL);
    const cy1 = Math.floor((Math.max(ay, by) + pad) / CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const key = cx * 2 ** 21 + cy;
        const list = this.cells.get(key);
        if (list) list.push(id);
        else this.cells.set(key, [id]);
      }
    }
    return id;
  }

  near(x: number, y: number): number[] {
    return this.cells.get(Math.floor(x / CELL) * 2 ** 21 + Math.floor(y / CELL)) ?? [];
  }

  buckets(): IterableIterator<number[]> {
    return this.cells.values();
  }
}

/** Closest point on segment a–b to p: [t along the segment, squared distance]. */
function project(px: number, py: number, ax: number, ay: number, bx: number, by: number): [number, number] {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const ex = ax + t * dx - px;
  const ey = ay + t * dy - py;
  return [t, ex * ex + ey * ey];
}

/* ---------------- network ---------------- */

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/**
 * Builds a routable network from road lines. `toLngLat` converts global tile units to degrees.
 * Pure, so it can be tested without the network.
 */
export function networkFromLines(input: readonly TileLine[], names: readonly NameLine[], toLngLat: (x: number, y: number) => [number, number]): RoadPayload {
  const lines = input.map((l) => ({ ...l, pts: l.pts.slice() }));

  // 1. Every vertex, so a road end can tell whether it already meets another road.
  const vertexAt = new Map<string, number[]>(); // JOIN-grid key -> line indices
  const vkey = (x: number, y: number): string => `${Math.round(x / JOIN)},${Math.round(y / JOIN)}`;
  lines.forEach((l, li) => {
    for (let i = 0; i < l.pts.length; i += 2) {
      const k = vkey(l.pts[i], l.pts[i + 1]);
      const list = vertexAt.get(k);
      if (list) list.push(li);
      else vertexAt.set(k, [li]);
    }
  });
  const sharedWithOther = (x: number, y: number, li: number): boolean => {
    const gx = Math.round(x / JOIN);
    const gy = Math.round(y / JOIN);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (vertexAt.get(`${gx + dx},${gy + dy}`)?.some((o) => o !== li)) return true;
    return false;
  };

  // 2. Segment index.
  const index = new SegmentIndex();
  lines.forEach((l, li) => {
    for (let i = 0; i + 3 < l.pts.length; i += 2) index.add(li, i / 2, l.pts[i], l.pts[i + 1], l.pts[i + 2], l.pts[i + 3], REACH);
  });
  const cuts: Map<number, number[]>[] = lines.map(() => new Map()); // per line: segment -> [t, x, y, ...]
  const cut = (li: number, si: number, t: number, x: number, y: number): void => {
    if (t <= 1e-6 || t >= 1 - 1e-6) return; // at a vertex already
    const list = cuts[li].get(si);
    if (list) list.push(t, x, y);
    else cuts[li].set(si, [t, x, y]);
  };
  const seg = (id: number): [number, number, number, number] => {
    const l = lines[index.line[id]].pts;
    const i = index.seg[id] * 2;
    return [l[i], l[i + 1], l[i + 2], l[i + 3]];
  };

  // 3. Roads at the same grade that cross or touch meet there.
  const seen = new Set<number>();
  for (const bucket of index.buckets()) {
    for (let p = 0; p < bucket.length; p++) {
      for (let q = p + 1; q < bucket.length; q++) {
        const a = Math.min(bucket[p], bucket[q]);
        const b = Math.max(bucket[p], bucket[q]);
        const la = index.line[a];
        const lb = index.line[b];
        if (la === lb || lines[la].grade !== '' || lines[lb].grade !== '') continue;
        const pair = a * 2 ** 26 + b;
        if (seen.has(pair)) continue;
        seen.add(pair);
        const [ax, ay, bx, by] = seg(a);
        const [cx, cy, dx, dy] = seg(b);
        const rx = bx - ax;
        const ry = by - ay;
        const sx = dx - cx;
        const sy = dy - cy;
        const den = rx * sy - ry * sx;
        if (Math.abs(den) < 1e-9) continue; // parallel
        const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
        const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
        const tolA = JOIN / Math.hypot(rx, ry);
        const tolB = JOIN / Math.hypot(sx, sy);
        if (t < -tolA || t > 1 + tolA || u < -tolB || u > 1 + tolB) continue;
        const x = ax + t * rx;
        const y = ay + t * ry;
        cut(la, index.seg[a], t, x, y);
        cut(lb, index.seg[b], u, x, y);
      }
    }
  }

  // 4. A road that stops just short of another road (or just past it) meets it.
  const ends: [number, number][] = [];
  lines.forEach((l, li) => {
    ends.push([li, 0], [li, l.pts.length - 2]);
  });
  for (const [li, at] of ends) {
    const l = lines[li];
    const x = l.pts[at];
    const y = l.pts[at + 1];
    if (sharedWithOther(x, y, li)) continue;
    let best = -1;
    let bestT = 0;
    let bestD = REACH * REACH;
    for (const id of index.near(x, y)) {
      const other = index.line[id];
      if (other === li || (lines[other].grade !== '' && lines[other].grade !== l.grade)) continue;
      const [ax, ay, bx, by] = seg(id);
      const [t, d] = project(x, y, ax, ay, bx, by);
      if (d < bestD) {
        bestD = d;
        best = id;
        bestT = t;
      }
    }
    if (best < 0) continue;
    const [ax, ay, bx, by] = seg(best);
    const px = ax + bestT * (bx - ax);
    const py = ay + bestT * (by - ay);
    l.pts[at] = px; // move the end onto the other road
    l.pts[at + 1] = py;
    cut(index.line[best], index.seg[best], bestT, px, py);
  }

  // 5. Insert the meeting points into each line.
  for (let li = 0; li < lines.length; li++) {
    const extra = cuts[li];
    if (extra.size === 0) continue;
    const src = lines[li].pts;
    const out: number[] = [src[0], src[1]];
    for (let i = 0; i + 3 < src.length; i += 2) {
      const list = extra.get(i / 2);
      if (list) {
        const order: number[] = [];
        for (let k = 0; k < list.length; k += 3) order.push(k);
        order.sort((p, q) => list[p] - list[q]);
        for (const k of order) out.push(list[k + 1], list[k + 2]);
      }
      out.push(src[i + 2], src[i + 3]);
    }
    lines[li].pts = out;
  }

  // 6. Points within JOIN of each other become one node.
  const nodeAt = new Map<string, number>();
  const nodeX: number[] = [];
  const nodeY: number[] = [];
  const nodeOf = (x: number, y: number): number => {
    const gx = Math.round(x / JOIN);
    const gy = Math.round(y / JOIN);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const id = nodeAt.get(`${gx + dx},${gy + dy}`);
        if (id !== undefined && Math.hypot(nodeX[id] - x, nodeY[id] - y) <= JOIN) return id;
      }
    }
    const id = nodeX.length;
    nodeX.push(x);
    nodeY.push(y);
    nodeAt.set(`${gx},${gy}`, id);
    return id;
  };
  const paths = lines.map((l) => {
    const ids: number[] = [];
    for (let i = 0; i < l.pts.length; i += 2) {
      const id = nodeOf(l.pts[i], l.pts[i + 1]);
      if (ids[ids.length - 1] !== id) ids.push(id);
    }
    return ids;
  });

  // 7. Junctions: line ends, and nodes used more than once.
  const uses = new Uint16Array(nodeX.length);
  for (const ids of paths) ids.forEach((id, i) => (uses[id] += i === 0 || i === ids.length - 1 ? 2 : 1));

  // 8. Names, matched to each edge by the point halfway along it.
  const nameIndex = new SegmentIndex();
  names.forEach((n, ni) => {
    for (let i = 0; i + 3 < n.pts.length; i += 2) nameIndex.add(ni, i / 2, n.pts[i], n.pts[i + 1], n.pts[i + 2], n.pts[i + 3], NAME_REACH);
  });
  const nameList: string[] = [];
  const nameId = new Map<string, number>();
  const nameNear = (x: number, y: number): number => {
    let best = -1;
    let bestD = NAME_REACH * NAME_REACH;
    for (const id of nameIndex.near(x, y)) {
      const n = names[nameIndex.line[id]].pts;
      const i = nameIndex.seg[id] * 2;
      const [, d] = project(x, y, n[i], n[i + 1], n[i + 2], n[i + 3]);
      if (d < bestD) {
        bestD = d;
        best = nameIndex.line[id];
      }
    }
    if (best < 0) return -1;
    const label = names[best].name;
    let k = nameId.get(label);
    if (k === undefined) {
      k = nameList.length;
      nameId.set(label, k);
      nameList.push(label);
    }
    return k;
  };

  // 9. Cut each line into edges between junctions.
  const vertexOf = new Map<number, number>();
  const vx: number[] = [];
  const vy: number[] = [];
  const vertex = (node: number): number => {
    let v = vertexOf.get(node);
    if (v === undefined) {
      v = vx.length;
      vertexOf.set(node, v);
      const [lng, lat] = toLngLat(nodeX[node], nodeY[node]);
      vx.push(round6(lng));
      vy.push(round6(lat));
    }
    return v;
  };
  const edges: RoadPayloadEdge[] = [];
  lines.forEach((l, li) => {
    const ids = paths[li];
    let start = 0;
    for (let i = 1; i < ids.length; i++) {
      if (uses[ids[i]] <= 1 && i < ids.length - 1) continue;
      if (ids[i] !== ids[start]) {
        const g: number[] = [];
        for (let k = start; k <= i; k++) {
          const [lng, lat] = toLngLat(nodeX[ids[k]], nodeY[ids[k]]);
          g.push(round6(lng), round6(lat));
        }
        const mid = ids[Math.floor((start + i) / 2)];
        const midNext = ids[Math.floor((start + i) / 2) + 1] ?? mid;
        const n = nameNear((nodeX[mid] + nodeX[midNext]) / 2, (nodeY[mid] + nodeY[midNext]) / 2);
        edges.push({ a: vertex(ids[start]), b: vertex(ids[i]), g, c: l.cls, n, o: l.oneway, br: l.bridge ? 1 : 0 });
      }
      start = i;
    }
  });
  return { vx, vy, edges, names: nameList };
}

/* ---------------- tiles ---------------- */

let template: { url: string; at: number } | null = null;

/** OpenFreeMap publishes a new planet every week; the TileJSON names the current one. */
async function tileTemplate(): Promise<string> {
  if (template && Date.now() - template.at < 3_600_000) return template.url;
  const res = await fetch(TILEJSON_URL, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(10_000), cache: 'no-store' });
  if (!res.ok) throw new Error(`TileJSON HTTP ${res.status}`);
  const body: unknown = await res.json();
  const tiles = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).tiles : null;
  const url = Array.isArray(tiles) && typeof tiles[0] === 'string' ? tiles[0] : null;
  if (!url) throw new Error('TileJSON lists no tiles');
  template = { url, at: Date.now() };
  return url;
}

async function fetchTile(url: string): Promise<ArrayBuffer | null> {
  let last = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(12_000), cache: 'no-store' });
      if (res.status === 204 || res.status === 404) return null; // nothing mapped here
      if (res.ok) return await res.arrayBuffer();
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`โหลดไทล์ถนนไม่สำเร็จ (${last})`);
}

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await run(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The road network inside `box`, from z14 vector tiles. */
export async function roadsFromTiles(box: Bounds): Promise<RoadPayload> {
  const url = await tileTemplate();
  const midLat = (box.south + box.north) / 2;
  const extent = 4096;
  const world = extent * 2 ** ZOOM;
  const unitsPerM = world / (40_075_016.686 * Math.cos((midLat * Math.PI) / 180));
  const pad = MARGIN_M * unitsPerM;
  const area: Rect = {
    x0: lngToTileX(box.west, ZOOM) * extent - pad,
    x1: lngToTileX(box.east, ZOOM) * extent + pad,
    y0: latToTileY(box.north, ZOOM) * extent - pad,
    y1: latToTileY(box.south, ZOOM) * extent + pad,
  };
  const tiles: [number, number][] = [];
  for (let tx = Math.floor(area.x0 / extent); tx <= Math.floor(area.x1 / extent); tx++) {
    for (let ty = Math.floor(area.y0 / extent); ty <= Math.floor(area.y1 / extent); ty++) tiles.push([tx, ty]);
  }

  const lines: TileLine[] = [];
  const names: NameLine[] = [];
  await mapLimit(tiles, FETCH_CONCURRENCY, async ([tx, ty]) => {
    const buf = await fetchTile(url.replace('{z}', String(ZOOM)).replace('{x}', String(tx)).replace('{y}', String(ty)));
    if (!buf) return;
    const tile = new VectorTile(new Pbf(new Uint8Array(buf)));
    const roads = tile.layers.transportation;
    const named = tile.layers.transportation_name;
    const scale = extent / (roads?.extent ?? named?.extent ?? extent);
    const own: Rect = {
      x0: Math.max(area.x0, tx * extent),
      x1: Math.min(area.x1, (tx + 1) * extent),
      y0: Math.max(area.y0, ty * extent),
      y1: Math.min(area.y1, (ty + 1) * extent),
    };
    const globalLines = (geometry: { x: number; y: number }[][]): number[][] =>
      geometry.map((part) => {
        const pts: number[] = [];
        for (const p of part) pts.push(tx * extent + p.x * scale, ty * extent + p.y * scale);
        return pts;
      });

    if (roads) {
      for (let i = 0; i < roads.length; i++) {
        const f = roads.feature(i);
        if (f.type !== 2) continue; // lines only
        const base = CLASS_OF[str(f.properties.class)];
        if (!base) continue;
        const name = f.properties.ramp === 1 && base !== 'residential' ? `${base}_link` : base;
        const cls = (ROAD_CLASSES as readonly string[]).indexOf(name);
        if (cls < 0) continue;
        const brunnel = str(f.properties.brunnel);
        const layer = typeof f.properties.layer === 'number' ? f.properties.layer : 0;
        const oneway: -1 | 0 | 1 = f.properties.oneway === 1 ? 1 : f.properties.oneway === -1 ? -1 : 0;
        const grade = brunnel === 'bridge' || brunnel === 'tunnel' || layer !== 0 ? `${brunnel}:${layer}` : '';
        for (const part of globalLines(f.loadGeometry())) {
          for (const pts of clipLine(part, own)) lines.push({ pts, cls, oneway, bridge: brunnel === 'bridge', grade });
        }
      }
    }
    if (named) {
      for (let i = 0; i < named.length; i++) {
        const f = named.feature(i);
        if (f.type !== 2) continue;
        const label = str(f.properties['name:th']) || str(f.properties.name) || str(f.properties.ref);
        if (!label) continue;
        for (const pts of globalLines(f.loadGeometry())) names.push({ pts, name: label });
      }
    }
  });

  const toLngLat = (x: number, y: number): [number, number] => {
    const lng = (x / world) * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / world))) * 180) / Math.PI;
    return [lng, lat];
  };
  return networkFromLines(lines, names, toLngLat);
}
