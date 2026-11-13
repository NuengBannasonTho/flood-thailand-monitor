import type { Bounds } from '../config';
import { cellBox, type DemGrid } from './dem';

/**
 * Flood causes this app can model, following the Thai Meteorological Department's grouping:
 * river overflow, standing water after heavy local rain, and high sea level at the coast.
 * Flash floods from mountain run-off need a flow model and are not simulated.
 */
export type FloodMode = 'river' | 'sea' | 'rain';

export interface FloodBase {
  /** base water level of the area, metres above mean sea level */
  base: number;
  /** cells of the main water body: where rising river water spreads from */
  seeds: Int32Array;
}

/**
 * Everything about one cause of flooding in one area, worked out once. After this, the flood at any
 * setting is a per-cell comparison: no searching, which is what keeps the slider and animation fast.
 *
 * The "setting" is the water surface in metres above sea level for `river` and `sea`, and the
 * 24-hour rainfall in millimetres for `rain`.
 */
export interface FloodField {
  mode: FloodMode;
  /** setting above which each cell is under water; NEVER when it cannot flood */
  thr: Float32Array;
  /** order in which water reaches each cell, 0..1; 2 for cells that never flood */
  rank: Float32Array;
  /** river and sea: ground elevation, m. rain: metres of depth gained per mm of rain past the threshold */
  p: Float32Array;
  /** rain only: the deepest this cell's basin can pond, m */
  q: Float32Array;
  /** thresholds of every cell that can flood, ascending */
  sorted: Float32Array;
  /** setting that means "no flood" */
  zero: number;
}

export interface FloodScratch {
  wet: Uint8Array;
  queue: Int32Array;
}

/** Cells within this height of the base level belong to the water body, metres. */
const SEED_BAND = 0.5;
export const NEVER = 1e9;
const ALWAYS = -1e9;
/** A basin smaller than this many cells is treated as noise in the elevation data. */
const MIN_BASIN_CELLS = 4;
const MIN_POND_DEPTH = 0.05;
/** Assumed: each basin collects run-off from this many times its own area. */
const CATCHMENT_FACTOR = 6;
/** Fewer sea cells than this and the area is treated as inland. */
const MIN_SEA_CELLS = 200;

export const makeScratch = (grid: DemGrid): FloodScratch => ({ wet: new Uint8Array(grid.elev.length), queue: new Int32Array(grid.elev.length) });

/** Visits the 4-connected region of `start` among cells that pass `open`, marking them in `mark`. Returns its size. */
function fillRegion(grid: DemGrid, start: number, mark: Uint8Array, queue: Int32Array, tail0: number, open: (cell: number) => boolean): number {
  const { width, height } = grid;
  let head = tail0;
  let tail = tail0;
  mark[start] = 1;
  queue[tail++] = start;
  while (head < tail) {
    const k = queue[head++];
    const x = k % width;
    if (x > 0 && !mark[k - 1] && open(k - 1)) {
      mark[k - 1] = 1;
      queue[tail++] = k - 1;
    }
    if (x < width - 1 && !mark[k + 1] && open(k + 1)) {
      mark[k + 1] = 1;
      queue[tail++] = k + 1;
    }
    if (k >= width && !mark[k - width] && open(k - width)) {
      mark[k - width] = 1;
      queue[tail++] = k - width;
    }
    if (k < width * (height - 1) && !mark[k + width] && open(k + width)) {
      mark[k + width] = 1;
      queue[tail++] = k + width;
    }
  }
  return tail - tail0;
}

/**
 * Finds where an area's river water comes from.
 *
 * Base level is the 1st percentile of ground elevation: a plain minimum would latch on to one noisy
 * pixel, while the lowest percent is the river, canal or sea in practice. The source is the largest
 * connected patch of ground at that level (plus any patch at least a quarter its size, for a river
 * the data shows in pieces). Isolated low pits such as ponds are not sources.
 */
export function findFloodBase(grid: DemGrid, scratch: FloodScratch): FloodBase {
  const { elev } = grid;
  const sample: number[] = [];
  const stride = Math.max(1, Math.floor(elev.length / 50_000));
  for (let i = 0; i < elev.length; i += stride) sample.push(elev[i]);
  sample.sort((a, b) => a - b);
  const base = sample[Math.floor(sample.length * 0.01)] ?? 0;

  const top = base + SEED_BAND;
  const low = (cell: number): boolean => elev[cell] <= top;
  const { wet: mark, queue } = scratch;
  mark.fill(0);
  const patches: { start: number; size: number }[] = [];
  let tail = 0;
  for (let i = 0; i < elev.length; i++) {
    if (mark[i] || !low(i)) continue;
    const size = fillRegion(grid, i, mark, queue, tail, low);
    patches.push({ start: tail, size });
    tail += size;
  }
  const largest = patches.reduce((m, p) => Math.max(m, p.size), 0);
  const seeds: number[] = [];
  for (const p of patches) {
    if (p.size * 4 >= largest) for (let i = p.start; i < p.start + p.size; i++) seeds.push(queue[i]);
  }
  return { base, seeds: Int32Array.from(seeds) };
}

/**
 * Spreads outward from `seeds`, always advancing through the lowest ground available. For every
 * cell this gives the lowest water surface that can reach it (the highest point on its easiest
 * path from a seed), and the order in which cells are reached. Ties are served first-come, so on
 * flat ground the order runs outward in rings, which is what makes the flood front look like a wave.
 *
 * `openSeeds` marks seeds as already water (their level is "always"); otherwise a seed's level is
 * its own ground elevation.
 */
function spread(grid: DemGrid, seeds: Int32Array, openSeeds: boolean): { level: Float32Array; order: Int32Array } {
  const { elev, width, height } = grid;
  const n = elev.length;
  const level = new Float32Array(n).fill(NEVER);
  const seq = new Int32Array(n);
  const seen = new Uint8Array(n);
  const order = new Int32Array(n);
  const heap = new Int32Array(n);
  let size = 0;
  let counter = 0;
  let reached = 0;

  const before = (a: number, b: number): boolean => level[a] < level[b] || (level[a] === level[b] && seq[a] < seq[b]);
  const push = (cell: number, value: number): void => {
    seen[cell] = 1;
    level[cell] = value;
    seq[cell] = counter++;
    let i = size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(cell, heap[parent])) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = cell;
  };
  const pop = (): number => {
    const top = heap[0];
    const last = heap[--size];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= size) break;
      if (child + 1 < size && before(heap[child + 1], heap[child])) child++;
      if (!before(heap[child], last)) break;
      heap[i] = heap[child];
      i = child;
    }
    heap[i] = last;
    return top;
  };

  for (const seed of seeds) if (!seen[seed]) push(seed, openSeeds ? ALWAYS : elev[seed]);
  while (size > 0) {
    const cell = pop();
    order[reached++] = cell;
    const here = level[cell];
    const x = cell % width;
    if (x > 0 && !seen[cell - 1]) push(cell - 1, Math.max(here, elev[cell - 1]));
    if (x < width - 1 && !seen[cell + 1]) push(cell + 1, Math.max(here, elev[cell + 1]));
    if (cell >= width && !seen[cell - width]) push(cell - width, Math.max(here, elev[cell - width]));
    if (cell < width * (height - 1) && !seen[cell + width]) push(cell + width, Math.max(here, elev[cell + width]));
  }
  return { level, order: order.subarray(0, reached) };
}

/** Water that rises from a body of water (river or sea) and spreads over connected low ground. */
function risingField(grid: DemGrid, mode: 'river' | 'sea', seeds: Int32Array, zero: number): FloodField {
  const { level, order } = spread(grid, seeds, true);
  const n = grid.elev.length;
  const rank = new Float32Array(n).fill(2);
  const sorted = new Float32Array(order.length);
  order.forEach((cell, i) => {
    rank[cell] = i / order.length;
    sorted[i] = level[cell];
  });
  return { mode, thr: level, rank, p: grid.elev, q: new Float32Array(0), sorted, zero };
}

/**
 * Standing water after heavy local rain. Rain cannot drain from a closed basin, so each basin fills
 * from its lowest point. Assumptions, both rough: a basin collects run-off from CATCHMENT_FACTOR
 * times its own area, and nothing soaks in, is pumped out or flows through drains.
 */
function rainField(grid: DemGrid, base: FloodBase): FloodField {
  const { elev, width, height } = grid;
  const n = elev.length;

  // Water leaves through the edge of the area and into the river: fill every basin to its spill point.
  const outlets: number[] = [];
  for (let x = 0; x < width; x++) outlets.push(x, (height - 1) * width + x);
  for (let y = 1; y < height - 1; y++) outlets.push(y * width, y * width + width - 1);
  for (const seed of base.seeds) outlets.push(seed);
  const { level: spill } = spread(grid, Int32Array.from(outlets), false);

  const thr = new Float32Array(n).fill(NEVER);
  const rank = new Float32Array(n).fill(2);
  const p = new Float32Array(n);
  const q = new Float32Array(n);
  const mark = new Uint8Array(n);
  const queue = new Int32Array(n);
  const ponded = (cell: number): boolean => spill[cell] - elev[cell] > MIN_POND_DEPTH;
  const wetCells: number[] = [];

  for (let start = 0; start < n; start++) {
    if (mark[start] || !ponded(start)) continue;
    const size = fillRegion(grid, start, mark, queue, 0, ponded);
    if (size < MIN_BASIN_CELLS) continue;
    const cells = Array.from(queue.subarray(0, size)).sort((a, b) => elev[a] - elev[b]);
    const brim = spill[cells[0]];
    let capacity = 0;
    for (const cell of cells) capacity += brim - elev[cell];
    const mmPerVolume = 1000 / (CATCHMENT_FACTOR * size);
    const rainToFill = capacity * mmPerVolume;
    let below = 0; // volume of the basin beneath the current cell's elevation, in cell-metres
    cells.forEach((cell, i) => {
      if (i > 0) below += (elev[cell] - elev[cells[i - 1]]) * i;
      const rainToReach = below * mmPerVolume;
      const deepest = brim - elev[cell];
      thr[cell] = rainToReach;
      q[cell] = deepest;
      // Depth grows linearly from 0 when the water arrives to `deepest` when the basin is full.
      p[cell] = deepest / Math.max(rainToFill - rainToReach, 1e-3);
      wetCells.push(cell);
    });
  }

  wetCells.sort((a, b) => thr[a] - thr[b] || elev[a] - elev[b]);
  const sorted = new Float32Array(wetCells.length);
  wetCells.forEach((cell, i) => {
    rank[cell] = i / wetCells.length;
    sorted[i] = thr[cell];
  });
  return { mode: 'rain', thr, rank, p, q, sorted, zero: 0 };
}

/** Builds the field for one cause. Returns null when the cause cannot apply here (no sea in the area). */
export function buildField(grid: DemGrid, mode: FloodMode, base: FloodBase): FloodField | null {
  if (mode === 'river') return risingField(grid, 'river', base.seeds, base.base);
  if (mode === 'rain') return rainField(grid, base);
  const sea: number[] = [];
  for (let i = 0; i < grid.elev.length; i++) if (grid.elev[i] <= 0) sea.push(i);
  return sea.length >= MIN_SEA_CELLS ? risingField(grid, 'sea', Int32Array.from(sea), 0) : null;
}

/** Water depth at a cell for a given setting, metres; 0 when dry or outside the grid. */
export function depthOf(field: FloodField, cell: number, setting: number): number {
  if (cell < 0 || setting <= field.zero) return 0;
  const reach = field.thr[cell];
  if (!(setting > reach)) return 0;
  if (field.mode === 'rain') return Math.min(field.q[cell], field.p[cell] * (setting - reach));
  return Math.max(0, setting - field.p[cell]);
}

/** Number of cells under water at a setting. */
/**
 * Thresholds of the cells inside `box` that can flood, ascending. The water is worked out over the
 * whole grid, since it arrives from wherever the river is; this counts the simulated area only.
 */
export function sortedWithin(field: FloodField, grid: DemGrid, box: Bounds): Float32Array {
  const { x0, y0, x1, y1 } = cellBox(grid, box);
  const out: number[] = [];
  for (let y = Math.round(y0); y < Math.round(y1); y++) {
    for (let x = Math.round(x0); x < Math.round(x1); x++) {
      const t = field.thr[y * grid.width + x];
      if (t < NEVER) out.push(t);
    }
  }
  return Float32Array.from(out).sort();
}

export function wetCount(field: FloodField, setting: number): number {
  return countBelow(field.sorted, setting);
}

/** How many of the ascending thresholds `a` lie below `setting`: the cells under water. */
export function countBelow(a: Float32Array, setting: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < setting) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
