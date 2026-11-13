import { describe, expect, it } from 'vitest';
import { compactRoads, roadQuery } from '../lib/server/overpass';
import { cellAt, decodeTerrariumInto, emptyGrid, tileRangeFor, type DemGrid } from '../lib/sim/dem';
import { buildField, depthOf, findFloodBase, makeScratch, wetCount } from '../lib/sim/flood';
import { rainClass } from '../lib/sim/modes';
import { buildGraph, canReach, edgeDepths, findRoutes, nearestVertex, roadStatus } from '../lib/sim/roads';
import { vehicleById } from '../lib/sim/vehicles';

/** One tile around Chiang Mai, shaped as a valley: a river down the middle, ground rising 1 m per 10 cells. */
function valleyGrid(): DemGrid {
  const grid = emptyGrid(tileRangeFor({ west: 98.99, east: 98.995, south: 18.785, north: 18.79 }));
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) grid.elev[y * grid.width + x] = 300 + Math.abs(x - 128) / 10;
  }
  return grid;
}

const lngOfColumn = (grid: DemGrid, col: number): number => grid.bounds.west + ((col + 0.5) / grid.width) * (grid.bounds.east - grid.bounds.west);
const midLat = (grid: DemGrid): number => (grid.bounds.north + grid.bounds.south) / 2;

describe('terrarium decoding', () => {
  it('decodes elevation and clamps the sea floor to zero', () => {
    const rgba = new Uint8ClampedArray(256 * 256 * 4);
    // 310.5 m = 33078.5 -> R 129, G 54, B 128; -20 m = 32748 -> R 127, G 236, B 0
    rgba.set([129, 54, 128, 255], 0);
    rgba.set([127, 236, 0, 255], 4);
    const elev = new Float32Array(256 * 256);
    decodeTerrariumInto(rgba, elev, 256, 0, 0);
    expect(elev[0]).toBeCloseTo(310.5, 3);
    expect(elev[1]).toBe(0);
  });

  it('maps coordinates to cells inside the mosaic only', () => {
    const grid = valleyGrid();
    expect(grid.width).toBe(256);
    expect(grid.cellM).toBeGreaterThan(35);
    expect(grid.cellM).toBeLessThan(38);
    expect(cellAt(grid, lngOfColumn(grid, 10), midLat(grid)) % grid.width).toBe(10);
    expect(cellAt(grid, grid.bounds.west - 0.01, midLat(grid))).toBe(-1);
  });
});

describe('river overflow', () => {
  const grid = valleyGrid();
  const base = findFloodBase(grid, makeScratch(grid));
  const field = buildField(grid, 'river', base);
  if (!field) throw new Error('river field missing');
  const row = 100 * grid.width;

  it('takes the river as the base level and the water source', () => {
    expect(base.base).toBeGreaterThanOrEqual(300);
    expect(base.base).toBeLessThan(300.3);
    expect(base.seeds.length).toBeGreaterThan(grid.height);
    expect([...base.seeds].every((cell) => Math.abs((cell % grid.width) - 128) <= 8)).toBe(true);
  });

  it('floods wider as the water rises, and reports depth', () => {
    expect(wetCount(field, base.base + 3)).toBeGreaterThan(wetCount(field, base.base + 1) * 2);
    expect(depthOf(field, row + 128, base.base + 3)).toBeCloseTo(base.base + 3 - 300, 3);
    expect(depthOf(field, row + 128 + 60, base.base + 3)).toBe(0);
    expect(depthOf(field, -1, base.base + 3)).toBe(0);
    expect(depthOf(field, row + 128, base.base)).toBe(0); // no rise, no flood
  });

  it('reaches cells in order of distance from the river, so the front can travel as a wave', () => {
    expect(field.rank[row + 128]).toBeLessThan(field.rank[row + 140]);
    expect(field.rank[row + 140]).toBeLessThan(field.rank[row + 160]);
    expect(field.rank[row + 116]).toBeLessThan(field.rank[row + 96]);
    const sorted = Array.from(field.sorted);
    expect(sorted.every((v, i) => i === 0 || v >= sorted[i - 1])).toBe(true);
  });

  it('keeps low ground dry until the water tops the ridge in front of it', () => {
    const walled = valleyGrid();
    for (let y = 0; y < walled.height; y++) {
      walled.elev[y * walled.width + 150] = 305; // dike, 5 m above the river
      for (let x = 151; x < walled.width; x++) walled.elev[y * walled.width + x] = 301; // low land behind it
    }
    const source = findFloodBase(walled, makeScratch(walled));
    const behindDike = buildField(walled, 'river', source);
    if (!behindDike) throw new Error('river field missing');
    const pocket = 100 * walled.width + 170;
    expect(depthOf(behindDike, 100 * walled.width + 140, source.base + 2)).toBeGreaterThan(0);
    expect(depthOf(behindDike, pocket, source.base + 2)).toBe(0);
    expect(depthOf(behindDike, pocket, 305.5)).toBeCloseTo(4.5, 3);
  });
});

describe('sea level and local rain', () => {
  it('offers the sea only where the area has sea in it', () => {
    const inland = valleyGrid();
    expect(buildField(inland, 'sea', findFloodBase(inland, makeScratch(inland)))).toBeNull();

    const coast = valleyGrid();
    for (let y = 0; y < coast.height; y++) {
      for (let x = 0; x < coast.width; x++) coast.elev[y * coast.width + x] = x < 40 ? 0 : (x - 40) / 20; // sea in the west, land rising 1 m per 20 cells
    }
    const sea = buildField(coast, 'sea', findFloodBase(coast, makeScratch(coast)));
    if (!sea) throw new Error('sea field missing');
    const row = 50 * coast.width;
    expect(depthOf(sea, row + 60, 2)).toBeCloseTo(1, 3);
    expect(depthOf(sea, row + 100, 2)).toBe(0);
    expect(wetCount(sea, 2)).toBeGreaterThan(wetCount(sea, 1));
  });

  it('ponds rain in closed basins, deepest at the bottom and never above the rim', () => {
    const grid = valleyGrid();
    // A bowl 2 m deep, away from the river, on ground that otherwise drains.
    const cx = 60;
    const cy = 100;
    for (let y = cy - 12; y <= cy + 12; y++) {
      for (let x = cx - 12; x <= cx + 12; x++) {
        const r = Math.hypot(x - cx, y - cy);
        if (r <= 10) grid.elev[y * grid.width + x] -= 2 * (1 - r / 10);
      }
    }
    const rain = buildField(grid, 'rain', findFloodBase(grid, makeScratch(grid)));
    if (!rain) throw new Error('rain field missing');
    const bottom = cy * grid.width + cx;
    const slope = cy * grid.width + 200;
    expect(depthOf(rain, slope, 400)).toBe(0); // open slope drains
    expect(depthOf(rain, bottom, 0)).toBe(0);
    const light = depthOf(rain, bottom, 30);
    const heavy = depthOf(rain, bottom, 120);
    expect(light).toBeGreaterThan(0);
    expect(heavy).toBeGreaterThan(light);
    expect(depthOf(rain, bottom, 400)).toBeLessThanOrEqual(rain.q[bottom] + 1e-6);
    // The bowl sits on a slope: its downhill rim is 1 m above the bottom, so that is where it spills.
    expect(rain.q[bottom]).toBeCloseTo(1, 1);
    expect(wetCount(rain, 120)).toBeGreaterThan(wetCount(rain, 30));
  });

  it('names rain by the Thai Meteorological Department classes', () => {
    expect(rainClass(10)).toBe('ฝนเล็กน้อย');
    expect(rainClass(35)).toBe('ฝนปานกลาง');
    expect(rainClass(35.1)).toBe('ฝนหนัก');
    expect(rainClass(90)).toBe('ฝนหนัก');
    expect(rainClass(90.1)).toBe('ฝนหนักมาก');
  });
});

describe('roads and routing', () => {
  const grid = valleyGrid();
  const lat = midLat(grid);
  const latN = lat + 0.008;
  // West bank (col 60) to east bank (col 196). Two crossings: a low road at `lat`, a bridge at `latN`.
  const overpass = {
    elements: [
      { type: 'node', id: 1, lon: lngOfColumn(grid, 60), lat },
      { type: 'node', id: 2, lon: lngOfColumn(grid, 128), lat },
      { type: 'node', id: 3, lon: lngOfColumn(grid, 196), lat },
      { type: 'node', id: 4, lon: lngOfColumn(grid, 60), lat: latN },
      { type: 'node', id: 5, lon: lngOfColumn(grid, 196), lat: latN },
      { type: 'way', id: 10, nodes: [1, 2, 3], tags: { highway: 'secondary', name: 'ถนนริมน้ำ' } },
      { type: 'way', id: 11, nodes: [1, 4], tags: { highway: 'tertiary' } },
      { type: 'way', id: 12, nodes: [4, 5], tags: { highway: 'tertiary', bridge: 'yes', name: 'สะพานข้ามแม่น้ำ' } },
      { type: 'way', id: 13, nodes: [5, 3], tags: { highway: 'tertiary' } },
      { type: 'way', id: 14, nodes: [1, 99], tags: { highway: 'footway' } },
    ],
  };
  const payload = compactRoads(overpass);
  const graph = buildGraph(payload, grid);
  const from = nearestVertex(graph, lngOfColumn(grid, 60), lat);
  const to = nearestVertex(graph, lngOfColumn(grid, 196), lat);
  const source = findFloodBase(grid, makeScratch(grid));
  const river = buildField(grid, 'river', source);
  if (!river) throw new Error('river field missing');
  const depthsAt = (g: typeof graph, rise: number) => edgeDepths(g, (cell) => depthOf(river, cell, source.base + rise));

  it('builds a query and a junction graph from Overpass data', () => {
    expect(roadQuery({ west: 98.9, south: 18.7, east: 99, north: 18.8 })).toContain('(18.70000,98.90000,18.80000,99.00000)');
    expect(payload.vx.length).toBe(4);
    expect(payload.edges.length).toBe(4);
    expect(payload.names).toContain('สะพานข้ามแม่น้ำ');
    expect(graph.edges.find((e) => e.bridge)?.cls).toBe('tertiary');
  });

  it('uses the direct road when dry', () => {
    const depths = depthsAt(graph, 0);
    const [best] = findRoutes(graph, from, to, depths, vehicleById('car'));
    expect(best.roads).toEqual(['ถนนริมน้ำ']);
    expect(best.maxDepth).toBe(0);
  });

  it('sends a car over the bridge once the low road is too deep, and lets a boat use the flooded road', () => {
    // A 4 m rise leaves 4 m at the river and dry ground beyond 40 cells either side.
    const depths = depthsAt(graph, 4);
    const [car] = findRoutes(graph, from, to, depths, vehicleById('car'));
    expect(car.roads).toContain('สะพานข้ามแม่น้ำ');
    expect(car.maxDepth).toBe(0);
    expect(car.onBridge.length).toBe(car.coords.length);
    expect(car.onBridge.some(Boolean)).toBe(true);
    const status = roadStatus(graph, depths, vehicleById('car'));
    expect(status.shut.length).toBe(1);
    expect(status.shutKm).toBeGreaterThan(1);
    // The low road is only partly under water, so a boat cannot run its whole length either.
    expect(canReach(graph, from, to, depths, vehicleById('boat'))).toBe(false);
  });

  it('closes everything to a motorbike before a truck', () => {
    const noBridge = buildGraph(compactRoads({ elements: overpass.elements.filter((e) => e.id !== 12) }), grid);
    const a = nearestVertex(noBridge, lngOfColumn(grid, 60), lat);
    const b = nearestVertex(noBridge, lngOfColumn(grid, 196), lat);
    const depths = depthsAt(noBridge, 0.6);
    expect(canReach(noBridge, a, b, depths, vehicleById('motorbike'))).toBe(false);
    expect(canReach(noBridge, a, b, depths, vehicleById('truck'))).toBe(true);
  });
});
