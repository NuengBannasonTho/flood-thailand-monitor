/** Public endpoints and limits shared by client and server. All services here work without an API key. */

export const MAP_STYLE_URL = process.env.NEXT_PUBLIC_MAP_STYLE_URL || 'https://tiles.openfreemap.org/styles/positron';

/** Terrarium-encoded elevation tiles (AWS Open Data "Terrain Tiles"). */
export const DEM_TILE_URL = process.env.NEXT_PUBLIC_DEM_TILE_URL || 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const DEM_TILE_SIZE = 256;
/** Tile zoom used for flood analysis: about 37 m per cell at Thai latitudes, close to the 30 m the source data resolves. */
export const DEM_ANALYSIS_ZOOM = 12;
export const DEM_ATTRIBUTION = 'ความสูงภูมิประเทศ: Terrain Tiles (Mapzen, AWS Open Data)';

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export const THAILAND: Bounds = { west: 97.3, south: 5.5, east: 105.7, north: 20.5 };
export const THAILAND_VIEW = { center: [101.0, 13.2] as [number, number], zoom: 5.1 };

/**
 * The simulated area: what the screen shows, cut to at most this size around its centre. 20 x 14 km
 * loads in about a second even in central Bangkok (65,000 road segments); 30 x 20 km took 3 s there.
 */
export const ANALYSIS = {
  /** below this zoom the view is too large to analyse */
  minZoom: 11,
  maxWidthM: 20_000,
  maxHeightM: 14_000,
} as const;

