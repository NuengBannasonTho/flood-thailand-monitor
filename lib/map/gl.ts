import { DEM_TILE_SIZE } from '../config';
import { latToTileY, lngToTileX } from '../geo';
import type { DemGrid } from '../sim/dem';

const EARTH_CIRCUMFERENCE = 40_075_016.686;

/** Compiles and links a program; throws with the driver's own message when it fails. */
export function createProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string, label: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error(`${label}: program could not be created`);
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error(`${label}: shader could not be created`);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`${label}: ${gl.getShaderInfoLog(shader) ?? 'compile failed'}`);
    gl.attachShader(program, shader);
    gl.deleteShader(shader); // freed with the program
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`${label}: ${gl.getProgramInfoLog(program) ?? 'link failed'}`);
  return program;
}

/**
 * Where an analysed area sits in the map's Web Mercator space (0..1 across the world).
 * Geometry is stored relative to the area's north-west corner, so 32-bit floats stay accurate at
 * street zoom; the corner itself is added in double precision by `relativeMatrix`.
 */
export interface GridFrame {
  x0: number;
  y0: number;
  /** Mercator units per grid cell */
  cell: number;
  /** Mercator units per metre of height at this latitude */
  metre: number;
}

export function gridFrame(grid: DemGrid): GridFrame {
  const world = 2 ** grid.zoom;
  const midLat = (grid.bounds.north + grid.bounds.south) / 2;
  return {
    x0: lngToTileX(grid.bounds.west, grid.zoom) / world,
    y0: latToTileY(grid.bounds.north, grid.zoom) / world,
    cell: 1 / (world * DEM_TILE_SIZE),
    metre: 1 / (EARTH_CIRCUMFERENCE * Math.cos((midLat * Math.PI) / 180)),
  };
}

/** `out = main * translate(x, y, 0)`, computed in double precision before it becomes 32-bit floats. */
export function relativeMatrix(out: Float32Array, main: ArrayLike<number>, x: number, y: number): void {
  for (let k = 0; k < 16; k++) out[k] = main[k];
  for (let row = 0; row < 4; row++) out[12 + row] = main[row] * x + main[4 + row] * y + main[12 + row];
}

/** Ground height at a coordinate, interpolated between the four nearest cells. NaN outside the grid. */
export function elevationAt(grid: DemGrid, lng: number, lat: number): number {
  const gx = (lngToTileX(lng, grid.zoom) - grid.tx0) * DEM_TILE_SIZE - 0.5;
  const gy = (latToTileY(lat, grid.zoom) - grid.ty0) * DEM_TILE_SIZE - 0.5;
  if (gx < -0.5 || gy < -0.5 || gx > grid.width - 0.5 || gy > grid.height - 0.5) return Number.NaN;
  const x0 = Math.max(0, Math.min(grid.width - 1, Math.floor(gx)));
  const y0 = Math.max(0, Math.min(grid.height - 1, Math.floor(gy)));
  const x1 = Math.min(grid.width - 1, x0 + 1);
  const y1 = Math.min(grid.height - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, gx - x0));
  const fy = Math.max(0, Math.min(1, gy - y0));
  const top = grid.elev[y0 * grid.width + x0] * (1 - fx) + grid.elev[y0 * grid.width + x1] * fx;
  const bottom = grid.elev[y1 * grid.width + x0] * (1 - fx) + grid.elev[y1 * grid.width + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}
