import { bearing, haversine } from '../geo';
import { edgeCost, type EdgeDepths, type RoadGraph, type Route } from './roads';
import type { Vehicle } from './vehicles';

export type Turn = 'straight' | 'slight-left' | 'slight-right' | 'left' | 'right' | 'sharp-left' | 'sharp-right' | 'uturn';

export interface Step {
  /** depart: setting off from a stop; turn: a change of road or direction; stop / arrive: reaching a stop or the end */
  kind: 'depart' | 'turn' | 'stop' | 'arrive';
  /** how to take the junction, for 'turn' */
  turn: Turn | null;
  /** compass heading on leaving this point, degrees clockwise from north */
  heading: number;
  /** the road followed from here, null when it has no name */
  road: string | null;
  /** distance (metres) and time (seconds) until the next step */
  length: number;
  time: number;
  /** deepest water before the next step, metres */
  maxDepth: number;
  /** where the step happens, and its index in the route's coordinates */
  at: [number, number];
  index: number;
  /** the stop it starts from or reaches, as an index into the stops given; null for turns */
  stop: number | null;
}

/** A stop along the route: where it is reached in `route.coords`, and whether it is only a point to pass through. */
export interface StopAt {
  at: number;
  via: boolean;
}

/** headings at a junction are measured over this much road on each side, metres; less is noise */
const LOOK = 20;
/** a turn followed this soon by another is folded into it, metres: a dogleg is one manoeuvre */
const SHORT = 35;

/** Heading of the road leaving coordinate `i` (dir 1) or arriving at it (dir -1). */
function headingAt(coords: readonly [number, number][], i: number, dir: 1 | -1): number {
  const [x, y] = coords[i];
  let j = i;
  let run = 0;
  while (run < LOOK && j + dir >= 0 && j + dir < coords.length) {
    const [px, py] = coords[j];
    j += dir;
    run += haversine(px, py, coords[j][0], coords[j][1]);
  }
  if (j === i) return 0;
  return dir === 1 ? bearing(x, y, coords[j][0], coords[j][1]) : bearing(coords[j][0], coords[j][1], x, y);
}

/** Signed turn at coordinate `i`, degrees: positive to the right. */
function turnAt(coords: readonly [number, number][], i: number): number {
  return ((headingAt(coords, i, 1) - headingAt(coords, i, -1) + 540) % 360) - 180;
}

export function classifyTurn(angle: number): Turn {
  const a = Math.abs(angle);
  const side = angle > 0 ? 'right' : 'left';
  if (a < 25) return 'straight';
  if (a < 60) return `slight-${side}`;
  if (a < 140) return side;
  if (a < 170) return `sharp-${side}`;
  return 'uturn';
}

/**
 * Turn-by-turn steps for a route. A step lasts while the road keeps its name and does not turn
 * sharply; an unnamed stretch joins the step before it while it runs roughly straight on. `stops`
 * lists every stop in travel order, the first at 0 and the last at the route's end; points only
 * passed through produce no step of their own.
 */
export function directions(graph: RoadGraph, route: Route, depths: EdgeDepths, vehicle: Vehicle, stops: readonly StopAt[]): Step[] {
  const { coords, edgeStart } = route;
  if (route.edges.length === 0 || coords.length < 2) return [];
  const steps: Step[] = [];
  const begin = (kind: Step['kind'], at: number, road: string | null, stop: number | null, turn: Turn | null): Step => ({
    kind,
    turn,
    heading: headingAt(coords, at, 1),
    road,
    length: 0,
    time: 0,
    maxDepth: 0,
    at: coords[at],
    index: at,
    stop,
  });

  let current = begin('depart', 0, graph.edges[route.edges[0]].name, 0, null);
  let next = 1;
  let previous: string | null = null;
  route.edges.forEach((ei, i) => {
    const e = graph.edges[ei];
    const start = edgeStart[i];
    if (i > 0) {
      // Stops reached at this junction; the last stop is the route's end, handled after the loop.
      let stopped = false;
      while (next < stops.length - 1 && stops[next].at <= start) {
        if (!stops[next].via) {
          steps.push(current, { ...begin('stop', start, null, next, null), heading: 0 });
          current = begin('depart', start, e.name, next, null);
          stopped = true;
        }
        next++;
      }
      if (!stopped) {
        const angle = turnAt(coords, start);
        const turn = classifyTurn(angle);
        const sameRoad = e.name !== null && e.name === previous && Math.abs(angle) < 60;
        const onStraight = e.name === null && turn === 'straight';
        if (!sameRoad && !onStraight) {
          steps.push(current);
          current = begin('turn', start, e.name, null, turn);
        }
      }
    }
    current.length += e.len;
    current.time += edgeCost(e, depths, vehicle);
    current.maxDepth = Math.max(current.maxDepth, depths.max[ei]);
    // An unnamed stretch taken into a named step keeps that name, so the road can carry on after it.
    previous = e.name ?? current.road;
  });
  steps.push(current, { ...begin('arrive', coords.length - 1, null, stops.length - 1, null), heading: 0 });
  return foldShort(steps, coords);
}

/**
 * Folds a turn that lasts only a few metres into the turn after it, which then takes the two as one
 * (a short connector, or a road that changes name just before a junction).
 */
function foldShort(steps: readonly Step[], coords: readonly [number, number][]): Step[] {
  const out: Step[] = [];
  /** a short turn waiting to be folded into the next one */
  let held: Step | null = null;
  for (const raw of steps) {
    let step = raw;
    if (held && step.kind === 'turn') {
      const angle = ((headingAt(coords, step.index, 1) - headingAt(coords, held.index, -1) + 540) % 360) - 180;
      step = { ...step, turn: classifyTurn(angle), at: held.at, index: held.index, length: held.length + step.length, time: held.time + step.time, maxDepth: Math.max(held.maxDepth, step.maxDepth) };
    } else if (held) {
      out.push(held);
    }
    held = null;
    if (step.kind === 'turn' && step.length < SHORT) held = step;
    else out.push(step);
  }
  if (held) out.push(held);
  return out;
}
