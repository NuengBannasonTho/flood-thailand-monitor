import { describe, expect, it } from 'vitest';
import { emptyGrid, tileRangeFor } from '../lib/sim/dem';
import { classifyTurn, directions } from '../lib/sim/directions';
import { blockedLeg, buildGraph, type EdgeDepths, nearestVertex, planRoutes, ROAD_CLASSES, type RoadPayload } from '../lib/sim/roads';
import { vehicleById } from '../lib/sim/vehicles';
import { moveStop, newStop, stopLabel, stopLetters } from '../lib/stops';

/*
 * A 3 x 3 street grid about 220 m apart. Rows (west to east) are ถนนแถว0..2 from south to north,
 * columns (south to north) are ซอย0..2 from west to east.
 */
const W = 100.46;
const S = 7.0;
const D = 0.002;
const id = (i: number, j: number): number => j * 3 + i;

function streets(): RoadPayload {
  const vx: number[] = [];
  const vy: number[] = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) (vx.push(W + i * D), vy.push(S + j * D));
  const names = ['ถนนแถว0', 'ถนนแถว1', 'ถนนแถว2', 'ซอย0', 'ซอย1', 'ซอย2'];
  const edges: RoadPayload['edges'] = [];
  const road = ROAD_CLASSES.indexOf('residential');
  const add = (a: number, b: number, n: number): void => {
    edges.push({ a, b, g: [vx[a], vy[a], vx[b], vy[b]], c: road, n, o: 0, br: 0 });
  };
  for (let j = 0; j < 3; j++) for (let i = 0; i < 2; i++) add(id(i, j), id(i + 1, j), j);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) add(id(i, j), id(i, j + 1), 3 + i);
  return { vx, vy, edges, names };
}

const grid = emptyGrid(tileRangeFor({ west: W - 0.001, south: S - 0.001, east: W + 3 * D, north: S + 3 * D }));
const graph = buildGraph(streets(), grid);
const dry: EdgeDepths = { max: new Float32Array(graph.edges.length), min: new Float32Array(graph.edges.length) };
const car = vehicleById('car');
const at = (i: number, j: number): number => nearestVertex(graph, W + i * D, S + j * D);

describe('routes through several stops', () => {
  it('joins the legs into one route, each leg starting where the last one ended', () => {
    const [route, ...rest] = planRoutes(graph, [at(0, 0), at(2, 0), at(2, 2)], dry, car);
    expect(rest).toHaveLength(0);
    expect(route.legStart).toHaveLength(2);
    expect(route.coords[0]).toEqual([W, S]);
    expect(route.coords[route.legStart[1]]).toEqual([W + 2 * D, S]);
    expect(route.coords[route.coords.length - 1]).toEqual([W + 2 * D, S + 2 * D]);
    // every edge starts on a junction
    route.edgeStart.forEach((start) => expect(graph.vx).toContain(route.coords[start][0]));
    expect(route.length).toBeGreaterThan(4 * 200);
  });

  it('offers alternatives between two stops, and none when a leg is cut', () => {
    expect(planRoutes(graph, [at(0, 0), at(2, 2)], dry, car).length).toBeGreaterThan(1);
    // flood every street into the north-east corner
    const deep: EdgeDepths = { max: Float32Array.from(dry.max), min: Float32Array.from(dry.min) };
    for (const e of graph.edges) if (e.a === at(2, 2) || e.b === at(2, 2)) deep.max[e.id] = 1;
    expect(planRoutes(graph, [at(0, 0), at(1, 1), at(2, 2)], deep, car)).toEqual([]);
    expect(blockedLeg(graph, [at(0, 0), at(1, 1), at(2, 2)], deep, car)).toBe(1);
    expect(blockedLeg(graph, [at(0, 0), at(1, 1), at(2, 2)], dry, car)).toBe(-1);
  });
});

describe('turn-by-turn directions', () => {
  it('sets off east, turns left onto the road north, and arrives', () => {
    const [route] = planRoutes(graph, [at(0, 0), at(2, 0), at(2, 2)], dry, car);
    const steps = directions(graph, route, dry, car, [
      { at: 0, via: false },
      { at: route.legStart[1], via: true },
      { at: route.coords.length - 1, via: false },
    ]);
    expect(steps.map((s) => s.kind)).toEqual(['depart', 'turn', 'arrive']);
    expect(steps[0]).toMatchObject({ road: 'ถนนแถว0', stop: 0 });
    expect(steps[0].heading).toBeCloseTo(90, 0);
    expect(steps[1]).toMatchObject({ turn: 'left', road: 'ซอย2' });
    expect(steps[0].length).toBeCloseTo(steps[1].length, -1);
    expect(steps[2]).toMatchObject({ kind: 'arrive', stop: 2 });
  });

  it('stops at a stop and sets off again from it', () => {
    const [route] = planRoutes(graph, [at(0, 0), at(2, 0), at(2, 2)], dry, car);
    const steps = directions(graph, route, dry, car, [
      { at: 0, via: false },
      { at: route.legStart[1], via: false },
      { at: route.coords.length - 1, via: false },
    ]);
    expect(steps.map((s) => s.kind)).toEqual(['depart', 'stop', 'depart', 'arrive']);
    expect(steps[1].stop).toBe(1);
    expect(steps[2]).toMatchObject({ road: 'ซอย2', stop: 1 });
  });

  it('names turns by their angle, positive to the right', () => {
    expect([10, -40, 90, -100, 150, 178].map(classifyTurn)).toEqual(['straight', 'slight-left', 'right', 'left', 'sharp-right', 'uturn']);
  });
});

describe('the list of stops', () => {
  it('letters stops in order, skipping points only passed through', () => {
    const list = [newStop(), newStop(true), newStop(), newStop()];
    expect(stopLetters(list)).toEqual(['A', null, 'B', 'C']);
    expect(list.map((_, i) => stopLabel(list, i))).toEqual(['จุดเริ่มต้น', 'จุดที่ผ่าน', 'จุดแวะ', 'ปลายทาง']);
  });

  it('moves a row', () => {
    const [a, b, c] = [newStop(), newStop(), newStop()];
    expect(moveStop([a, b, c], 0, 2).map((s) => s.id)).toEqual([b.id, c.id, a.id]);
  });
});

describe('short doglegs', () => {
  it('folds a turn of a few metres into the next one', () => {
    // a jog: east 220 m, north 20 m onto an unnamed link, east again on another road
    const vx = [W, W + D, W + D, W + 2 * D];
    const vy = [S, S, S + 0.00018, S + 0.00018];
    const road = ROAD_CLASSES.indexOf('residential');
    const payload: RoadPayload = {
      vx,
      vy,
      names: ['ถนนหนึ่ง', 'ถนนสอง'],
      edges: [
        { a: 0, b: 1, g: [vx[0], vy[0], vx[1], vy[1]], c: road, n: 0, o: 0, br: 0 },
        { a: 1, b: 2, g: [vx[1], vy[1], vx[2], vy[2]], c: road, n: -1, o: 0, br: 0 },
        { a: 2, b: 3, g: [vx[2], vy[2], vx[3], vy[3]], c: road, n: 1, o: 0, br: 0 },
      ],
    };
    const g = buildGraph(payload, grid);
    const none: EdgeDepths = { max: new Float32Array(3), min: new Float32Array(3) };
    const [route] = planRoutes(g, [0, 3], none, car);
    const steps = directions(g, route, none, car, [
      { at: 0, via: false },
      { at: route.coords.length - 1, via: false },
    ]);
    expect(steps.map((s) => s.kind)).toEqual(['depart', 'turn', 'arrive']);
    // left 20 m then right again is, taken together, straight on
    expect(steps[1]).toMatchObject({ road: 'ถนนสอง', turn: 'straight' });
  });
});

describe('snapping a stop to the road network', () => {
  it('skips a stray fragment, even when it is nearer', () => {
    const payload = streets();
    // a two-junction stub just off the grid's north-east corner, linked to nothing
    const a = payload.vx.push(W + 2.5 * D) - 1;
    payload.vy.push(S + 2.5 * D);
    const b = payload.vx.push(W + 2.6 * D) - 1;
    payload.vy.push(S + 2.5 * D);
    payload.edges.push({ a, b, g: [payload.vx[a], payload.vy[a], payload.vx[b], payload.vy[b]], c: ROAD_CLASSES.indexOf('residential'), n: -1, o: 0, br: 0 });
    const g = buildGraph(payload, grid);
    const v = nearestVertex(g, W + 2.55 * D, S + 2.5 * D);
    expect(v).toBe(id(2, 2));
    expect(g.snap[a]).toBe(0);
  });
});
