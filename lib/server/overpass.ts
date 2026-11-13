import type { Bounds } from '../config';
import { ROAD_CLASSES, type RoadPayload, type RoadPayloadEdge } from '../sim/roads';

interface OsmNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
}

interface OsmWay {
  type: 'way';
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const isNode = (v: unknown): v is OsmNode => isRecord(v) && v.type === 'node' && typeof v.id === 'number' && typeof v.lat === 'number' && typeof v.lon === 'number';

const isWay = (v: unknown): v is OsmWay =>
  isRecord(v) && v.type === 'way' && typeof v.id === 'number' && Array.isArray(v.nodes) && v.nodes.every((n) => typeof n === 'number') && (v.tags === undefined || isRecord(v.tags));

/** Overpass QL for every drivable road in a box, with the nodes needed to draw them. */
export function roadQuery(box: Bounds): string {
  const classes = ROAD_CLASSES.join('|');
  const bbox = [box.south, box.west, box.north, box.east].map((v) => v.toFixed(5)).join(',');
  return `[out:json][timeout:40];way["highway"~"^(${classes})$"]["area"!="yes"](${bbox});out body;>;out skel qt;`;
}

function onewayOf(tags: Record<string, string>): -1 | 0 | 1 {
  const value = tags.oneway;
  if (value === '-1' || value === 'reverse') return -1;
  if (value === 'yes' || value === 'true' || value === '1') return 1;
  if (value === 'no') return 0;
  if (tags.junction === 'roundabout' || tags.highway === 'motorway' || tags.highway === 'motorway_link') return 1;
  return 0;
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/**
 * Turns raw Overpass JSON into a routable network: ways are cut at every junction, so each edge
 * runs between two junctions and carries its own geometry.
 */
export function compactRoads(raw: unknown): RoadPayload {
  if (!isRecord(raw) || !Array.isArray(raw.elements)) throw new Error('Unexpected Overpass response');
  const nodes = new Map<number, OsmNode>();
  const ways: OsmWay[] = [];
  for (const el of raw.elements) {
    if (isNode(el)) nodes.set(el.id, el);
    else if (isWay(el)) ways.push(el);
  }

  const uses = new Map<number, number>();
  for (const way of ways) {
    way.nodes.forEach((id, i) => {
      // Way ends always become junctions, so count them twice.
      const weight = i === 0 || i === way.nodes.length - 1 ? 2 : 1;
      uses.set(id, (uses.get(id) ?? 0) + weight);
    });
  }

  const vertexOf = new Map<number, number>();
  const vx: number[] = [];
  const vy: number[] = [];
  const vertex = (node: OsmNode): number => {
    let index = vertexOf.get(node.id);
    if (index === undefined) {
      index = vx.length;
      vertexOf.set(node.id, index);
      vx.push(round6(node.lon));
      vy.push(round6(node.lat));
    }
    return index;
  };

  const names: string[] = [];
  const nameIndex = new Map<string, number>();
  const edges: RoadPayloadEdge[] = [];

  for (const way of ways) {
    const tags = way.tags ?? {};
    const cls = ROAD_CLASSES.findIndex((c) => c === tags.highway);
    if (cls < 0) continue;
    const label = tags['name:th'] || tags.name || tags.ref || '';
    let n = -1;
    if (label) {
      const known = nameIndex.get(label);
      if (known === undefined) {
        n = names.length;
        nameIndex.set(label, n);
        names.push(label);
      } else {
        n = known;
      }
    }
    const o = onewayOf(tags);
    const br: 0 | 1 = tags.bridge && tags.bridge !== 'no' ? 1 : 0;

    let start: OsmNode | null = null;
    let geometry: number[] = [];
    for (const id of way.nodes) {
      const node = nodes.get(id);
      if (!node) {
        // A node outside the download: end the current piece here.
        start = null;
        geometry = [];
        continue;
      }
      geometry.push(round6(node.lon), round6(node.lat));
      if (!start) {
        start = node;
        continue;
      }
      if ((uses.get(id) ?? 0) > 1) {
        if (start.id !== node.id) edges.push({ a: vertex(start), b: vertex(node), g: geometry, c: cls, n, o, br });
        start = node;
        geometry = [round6(node.lon), round6(node.lat)];
      }
    }
  }
  return { vx, vy, edges, names };
}
