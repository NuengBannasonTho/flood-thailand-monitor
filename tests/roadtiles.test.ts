import { describe, expect, it } from 'vitest';
import { clipLine, type NameLine, networkFromLines, type TileLine } from '../lib/server/roadtiles';
import { ROAD_CLASSES } from '../lib/sim/roads';

const RES = ROAD_CLASSES.indexOf('residential');
/** Tile units straight through as degrees, so the output is easy to read. */
const plain = (x: number, y: number): [number, number] => [x, y];
const road = (pts: number[], extra: Partial<TileLine> = {}): TileLine => ({ pts, cls: RES, oneway: 0, bridge: false, grade: '', ...extra });

/** Edges meeting at each vertex. */
const degrees = (p: ReturnType<typeof networkFromLines>): number[] => {
  const d = new Array<number>(p.vx.length).fill(0);
  for (const e of p.edges) {
    d[e.a]++;
    d[e.b]++;
  }
  return d;
};

describe('road network from vector tiles', () => {
  it('keeps only the part of a line inside the tile', () => {
    expect(clipLine([-10, 5, 10, 5, 10, 20], { x0: 0, y0: 0, x1: 100, y1: 100 })).toEqual([[0, 5, 10, 5, 10, 20]]);
    // leaves and comes back: two pieces
    expect(clipLine([10, 10, 150, 10, 150, 50, 10, 50], { x0: 0, y0: 0, x1: 100, y1: 100 })).toEqual([
      [10, 10, 100, 10],
      [100, 50, 10, 50],
    ]);
  });

  it('joins two roads that cross at grade, even without a shared point', () => {
    const net = networkFromLines([road([0, 50, 100, 50]), road([50, 0, 50, 100])], [], plain);
    expect(net.edges).toHaveLength(4);
    expect(Math.max(...degrees(net))).toBe(4);
  });

  it('does not join a bridge to the road under it', () => {
    const net = networkFromLines([road([0, 50, 100, 50]), road([50, 0, 50, 100], { bridge: true, grade: 'bridge:1' })], [], plain);
    expect(net.edges).toHaveLength(2);
    expect(Math.max(...degrees(net))).toBe(1);
  });

  it('joins a road that stops a few units short of another', () => {
    // the side road ends 3 units before the main road, whose junction point was simplified away
    const net = networkFromLines([road([0, 50, 100, 50]), road([50, 0, 50, 47])], [], plain);
    expect(net.edges).toHaveLength(3);
    expect(Math.max(...degrees(net))).toBe(3);
  });

  it('connects the pieces of a road cut at a tile edge', () => {
    // the two tiles computed the edge point a unit apart
    const net = networkFromLines([road([0, 50, 4096, 50]), road([4096, 51, 8000, 50])], [], plain);
    const d = degrees(net);
    expect(net.edges).toHaveLength(2);
    expect(d.filter((n) => n === 2)).toHaveLength(1);
  });

  it('keeps one-way direction and bridges, and names edges from the name layer', () => {
    const names: NameLine[] = [{ pts: [0, 52, 100, 52], name: 'ถนนทดสอบ' }];
    const net = networkFromLines([road([0, 50, 100, 50], { oneway: -1, bridge: true, grade: 'bridge:1' })], names, plain);
    expect(net.edges).toHaveLength(1);
    expect(net.edges[0]).toMatchObject({ o: -1, br: 1 });
    expect(net.names[net.edges[0].n]).toBe('ถนนทดสอบ');
  });
});
