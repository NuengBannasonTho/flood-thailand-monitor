import { type Bounds, DEM_ANALYSIS_ZOOM, DEM_TILE_SIZE, DEM_TILE_URL } from '../config';
import { latToTileY, lngToTileX, metresPerPixel, tileXToLng, tileYToLat } from '../geo';

/** A mosaic of whole elevation tiles. Pixels are uniform in Web Mercator, row 0 is north. */
export interface DemGrid {
  zoom: number;
  /** tile column / row of the top-left tile */
  tx0: number;
  ty0: number;
  width: number;
  height: number;
  /** metres above mean sea level; sea floor is clamped to 0 */
  elev: Float32Array;
  bounds: Bounds;
  /** ground size of one cell at the grid's centre latitude, metres */
  cellM: number;
}

export interface TileRange {
  zoom: number;
  tx0: number;
  ty0: number;
  cols: number;
  rows: number;
}

export function tileRangeFor(box: Bounds, zoom: number = DEM_ANALYSIS_ZOOM): TileRange {
  const tx0 = Math.floor(lngToTileX(box.west, zoom));
  const tx1 = Math.floor(lngToTileX(box.east, zoom));
  const ty0 = Math.floor(latToTileY(box.north, zoom));
  const ty1 = Math.floor(latToTileY(box.south, zoom));
  return { zoom, tx0, ty0, cols: tx1 - tx0 + 1, rows: ty1 - ty0 + 1 };
}

/** Terrarium encoding: elevation = (R * 256 + G + B / 256) - 32768. Writes one tile into the mosaic. */
export function decodeTerrariumInto(rgba: Uint8ClampedArray, elev: Float32Array, gridWidth: number, offsetX: number, offsetY: number, tileSize: number = DEM_TILE_SIZE): void {
  for (let y = 0; y < tileSize; y++) {
    const row = (offsetY + y) * gridWidth + offsetX;
    for (let x = 0; x < tileSize; x++) {
      const i = (y * tileSize + x) * 4;
      const metres = rgba[i] * 256 + rgba[i + 1] + rgba[i + 2] / 256 - 32768;
      elev[row + x] = metres > 0 ? metres : 0;
    }
  }
}

export function emptyGrid(range: TileRange): DemGrid {
  const width = range.cols * DEM_TILE_SIZE;
  const height = range.rows * DEM_TILE_SIZE;
  const bounds: Bounds = {
    west: tileXToLng(range.tx0, range.zoom),
    east: tileXToLng(range.tx0 + range.cols, range.zoom),
    north: tileYToLat(range.ty0, range.zoom),
    south: tileYToLat(range.ty0 + range.rows, range.zoom),
  };
  const cellM = metresPerPixel((bounds.north + bounds.south) / 2, range.zoom, DEM_TILE_SIZE);
  return { zoom: range.zoom, tx0: range.tx0, ty0: range.ty0, width, height, elev: new Float32Array(width * height), bounds, cellM };
}

/** Where `box` lies in the grid, in cells (fractions allowed), cut to the grid. */
export function cellBox(grid: DemGrid, box: Bounds): { x0: number; y0: number; x1: number; y1: number } {
  const x = (lng: number): number => Math.min(grid.width, Math.max(0, (lngToTileX(lng, grid.zoom) - grid.tx0) * DEM_TILE_SIZE));
  const y = (lat: number): number => Math.min(grid.height, Math.max(0, (latToTileY(lat, grid.zoom) - grid.ty0) * DEM_TILE_SIZE));
  return { x0: x(box.west), y0: y(box.north), x1: x(box.east), y1: y(box.south) };
}

/** Cell index under a coordinate, or -1 outside the grid. */
export function cellAt(grid: DemGrid, lng: number, lat: number): number {
  const x = Math.floor((lngToTileX(lng, grid.zoom) - grid.tx0) * DEM_TILE_SIZE);
  const y = Math.floor((latToTileY(lat, grid.zoom) - grid.ty0) * DEM_TILE_SIZE);
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return -1;
  return y * grid.width + x;
}

/** Straight from the tile host; if the browser is not allowed to (network or CORS), through this app's own server. */
async function fetchTile(zoom: number, x: number, y: number, signal: AbortSignal): Promise<Response> {
  const direct = DEM_TILE_URL.replace('{z}', String(zoom)).replace('{x}', String(x)).replace('{y}', String(y));
  try {
    const res = await fetch(direct, { signal, mode: 'cors' });
    if (res.ok) return res;
  } catch (error) {
    if (signal.aborted) throw error;
  }
  return fetch(`/api/dem/${zoom}/${x}/${y}`, { signal });
}

async function fetchTilePixels(zoom: number, x: number, y: number, signal: AbortSignal): Promise<Uint8ClampedArray> {
  const res = await fetchTile(zoom, x, y, signal);
  if (!res.ok) throw new Error(`โหลดข้อมูลความสูงภูมิประเทศไม่สำเร็จ (HTTP ${res.status}) ตรวจการเชื่อมต่ออินเทอร์เน็ต`);
  // No colour or alpha conversion: the pixel bytes are the data.
  const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = DEM_TILE_SIZE;
  canvas.height = DEM_TILE_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('เบราว์เซอร์นี้อ่านข้อมูลภาพไม่ได้');
  ctx.drawImage(bitmap, 0, 0, DEM_TILE_SIZE, DEM_TILE_SIZE);
  bitmap.close();
  return ctx.getImageData(0, 0, DEM_TILE_SIZE, DEM_TILE_SIZE).data;
}

/** Downloads and decodes every elevation tile that touches `box`. Browser only. */
export async function loadDem(box: Bounds, signal: AbortSignal): Promise<DemGrid> {
  const range = tileRangeFor(box);
  const grid = emptyGrid(range);
  const jobs: Promise<void>[] = [];
  for (let r = 0; r < range.rows; r++) {
    for (let c = 0; c < range.cols; c++) {
      jobs.push(fetchTilePixels(range.zoom, range.tx0 + c, range.ty0 + r, signal).then((rgba) => decodeTerrariumInto(rgba, grid.elev, grid.width, c * DEM_TILE_SIZE, r * DEM_TILE_SIZE)));
    }
  }
  await Promise.all(jobs);
  return grid;
}
