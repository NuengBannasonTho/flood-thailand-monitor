import { describe, expect, it } from 'vitest';
import { cellBox, emptyGrid, tileRangeFor } from '../lib/sim/dem';
import { countBelow, type FloodField, NEVER, sortedWithin, wetCount } from '../lib/sim/flood';

describe('flooded area inside the simulated box', () => {
  const grid = emptyGrid(tileRangeFor({ west: 100.45, south: 6.98, east: 100.5, north: 7.03 }));
  const { width, height, bounds } = grid;
  // every cell floods at 1 m, except the right half, which never does
  const thr = new Float32Array(width * height).map((_, i) => (i % width < width / 2 ? 1 : NEVER));
  const field: FloodField = { mode: 'river', thr, rank: new Float32Array(thr.length), p: new Float32Array(0), q: new Float32Array(0), sorted: Float32Array.from(thr.filter((t) => t < NEVER)), zero: 0 };

  it('finds the box in cells', () => {
    const whole = cellBox(grid, bounds);
    expect(whole).toEqual({ x0: 0, y0: 0, x1: width, y1: height });
    const outside = cellBox(grid, { west: bounds.west - 1, south: bounds.south - 1, east: bounds.east + 1, north: bounds.north + 1 });
    expect(outside).toEqual(whole);
  });

  it('counts only the cells inside the box', () => {
    // the north-west quarter of the grid: all of it floods
    const quarter = { west: bounds.west, north: bounds.north, east: (bounds.west + bounds.east) / 2, south: bounds.south + (bounds.north - bounds.south) * 0.5 };
    const inside = sortedWithin(field, grid, quarter);
    const { x0, y0, x1, y1 } = cellBox(grid, quarter);
    expect(inside.length).toBe(Math.round(x1 - x0) * Math.round(y1 - y0));
    expect(countBelow(inside, 2)).toBe(inside.length);
    expect(countBelow(inside, 0.5)).toBe(0);
    // the whole grid counts more than the box does
    expect(wetCount(field, 2)).toBeGreaterThan(inside.length);
  });
});
