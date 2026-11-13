import type { FeatureCollection as GeoFeatureCollection, Geometry } from 'geojson';
import { type ExpressionSpecification, type GeoJSONSource, type LngLatBoundsLike, Map as MapLibreMap, type MapMouseEvent, Marker, type PointLike } from 'maplibre-gl';
import { ANALYSIS, type Bounds, DEM_ATTRIBUTION, DEM_TILE_SIZE, DEM_TILE_URL, MAP_STYLE_URL, THAILAND, THAILAND_VIEW } from '../config';
import { clampBox } from '../geo';
import type { DemGrid } from '../sim/dem';
import type { FloodField } from '../sim/flood';
import type { RoadStatus, Route } from '../sim/roads';
import type { Vehicle } from '../sim/vehicles';
import { Store } from '../store';
import { VehicleView } from '../three/vehicle-view';
import { buildTrip, EASE, evalTrack, type SeqTrack, type Trip } from './sequence';
import { type LineBatch, LineLayer, type Rgb } from './line-layer';
import { WaterLayer } from './water-layer';

export interface ViewInfo {
  zoom: number;
  lng: number;
  lat: number;
  /** true when the view is close enough to analyse */
  canAnalyse: boolean;
}

export interface SeqSnapshot {
  /** normalised time 0..1 */
  u: number;
  duration: number;
  playing: boolean;
  ready: boolean;
  /** true while the sequence drives the camera */
  engaged: boolean;
  remaining: number;
  depth: number;
  rate: number;
}

export interface Endpoint {
  lng: number;
  lat: number;
  name: string;
}

/** A stop as the map shows it: lettered, or a small dot for a point the route only passes through. */
export interface MapStop {
  id: string;
  /** A, B, C…; null for a point to pass through */
  letter: string | null;
  name: string;
  lng: number;
  lat: number;
}

export interface MapCallbacks {
  onReady: () => void;
  onView: (view: ViewInfo) => void;
  onPick: (lng: number, lat: number) => void;
  /** a stop's marker was dragged to a new place */
  onMoveStop: (id: string, lng: number, lat: number) => void;
  /** the route was dragged off its segment starting at coordinate `index` and dropped here */
  onRouteDrag: (index: number, lng: number, lat: number) => void;
  onError: (message: string) => void;
}

interface Camera {
  lng: number;
  lat: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

type FeatureCollection = GeoFeatureCollection<Geometry>;

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
const rgb = (hex: string): Rgb => [Number.parseInt(hex.slice(1, 3), 16) / 255, Number.parseInt(hex.slice(3, 5), 16) / 255, Number.parseInt(hex.slice(5, 7), 16) / 255];
const COLORS = { ink: rgb('#1b1c27'), alt: rgb('#9a9db0'), wade: rgb('#f5a524'), shut: rgb('#ef5350'), casing: rgb('#ffffff'), box: '#1b1c27' } as const;
/** Layer types the map bakes into the terrain's tile textures when 3D relief is on. */
const DRAPED: ReadonlySet<string> = new Set(['background', 'fill', 'line', 'raster', 'hillshade', 'color-relief']);
const MARKER_PX = 132;
const IDLE: SeqSnapshot = { u: 0, duration: 0, playing: false, ready: false, engaged: false, remaining: 0, depth: 0, rate: 1 };

/** Local names first: in Thailand that is Thai script. */
const LOCAL_NAME: ExpressionSpecification = ['coalesce', ['get', 'name:th'], ['get', 'name'], ['get', 'name:latin'], ['get', 'name_en'], ''];


/** Owns the MapLibre map, every layer this app adds, the vehicle marker and the travel sequence. */
export class MapController {
  readonly seq = new Store<SeqSnapshot>(IDLE);

  private readonly map: MapLibreMap;
  private readonly callbacks: MapCallbacks;
  private readonly reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private ready = false;
  private disposed = false;
  private picking = false;
  private firstLabelLayer: string | undefined;

  private readonly water = new WaterLayer();
  private readonly lines = new LineLayer();
  private floodField: FloodField | null = null;
  private terrainOn = true;

  private readonly stopMarkers = new Map<string, { marker: Marker; key: string }>();
  private stopPoints: [number, number][] = [];
  private stepMarker: Marker | null = null;

  /* dragging the route to make it pass somewhere: mouse only, like other web maps */
  private routeLine: [number, number][] | null = null;
  /** the route projected to the screen, dropped whenever the camera moves */
  private routeOnScreen: { x: number; y: number }[] | null = null;
  private readonly routeHandle: Marker;
  private handleShown = false;
  /** segment under the pointer, -1 when none */
  private hoverSegment = -1;
  private routeDrag: { index: number; x: number; y: number } | null = null;
  private searchPin: Marker | null = null;
  private readonly vehicleEl: HTMLDivElement;
  private readonly vehicleMarker: Marker;
  private vehicleView: VehicleView | null = null;
  private vehicleShown = false;

  private trip: Trip | null = null;
  private blend: { from: Camera; t0: number } | null = null;
  private last = 0;
  private raf = 0;
  private reported = new Set<string>();

  constructor(container: HTMLElement, callbacks: MapCallbacks) {
    this.callbacks = callbacks;
    this.map = new MapLibreMap({
      container,
      style: MAP_STYLE_URL,
      center: THAILAND_VIEW.center,
      zoom: THAILAND_VIEW.zoom,
      minZoom: 4,
      maxZoom: 18,
      maxPitch: 70,
      maxBounds: [
        [THAILAND.west - 9, THAILAND.south - 6],
        [THAILAND.east + 9, THAILAND.north + 6],
      ],
      attributionControl: { compact: true, customAttribution: `${DEM_ATTRIBUTION} · เส้นทางและชื่อสถานที่: © OpenStreetMap contributors` },
    });

    this.vehicleEl = document.createElement('div');
    this.vehicleEl.className = 'vehicle-marker';
    const canvas = document.createElement('canvas');
    canvas.width = MARKER_PX;
    canvas.height = MARKER_PX;
    this.vehicleEl.appendChild(canvas);
    this.vehicleMarker = new Marker({ element: this.vehicleEl, anchor: 'center' });
    try {
      this.vehicleView = new VehicleView(canvas, MARKER_PX, 12);
    } catch {
      this.vehicleView = null; // no second WebGL context: the trip still plays, without the model
    }

    this.map.on('load', () => this.onLoad());
    this.map.on('error', (e) => this.report(e.error instanceof Error ? e.error.message : 'ไม่ทราบสาเหตุ'));
    this.map.on('moveend', () => {
      // The sequence moves the camera every frame; report the view only when it is the user's doing.
      if (!this.seq.get().playing) this.emitView();
    });
    this.map.on('click', (e) => {
      if (this.picking) this.callbacks.onPick(e.lngLat.lng, e.lngLat.lat);
    });
    const handle = document.createElement('div');
    handle.className = 'route-handle';
    this.routeHandle = new Marker({ element: handle, anchor: 'center' });
    this.map.on('move', () => {
      this.routeOnScreen = null;
    });
    this.map.on('mousemove', (e) => this.hoverRoute(e));
    this.map.on('mousedown', (e) => this.grabRoute(e));
    this.map.on('mouseout', () => {
      if (!this.routeDrag) this.dropHandle();
    });
    // A drag, wheel or pinch from the user takes the camera back from the sequence.
    for (const type of ['dragstart', 'wheel', 'touchstart', 'rotatestart', 'pitchstart'] as const) {
      this.map.on(type, (e) => {
        if ('originalEvent' in e && e.originalEvent) this.release();
      });
    }
    this.raf = requestAnimationFrame(this.frame);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.vehicleView?.dispose();
    this.map.remove();
  }

  /* ---------------- setup ---------------- */

  private report(message: string): void {
    // One notice per kind of failure is enough: a broken tile source fails on every tile.
    const kind = /terrarium|elevation/i.test(message) ? 'dem' : /openfreemap|tiles|style/i.test(message) ? 'map' : message.slice(0, 40);
    if (this.reported.has(kind)) return;
    this.reported.add(kind);
    const text = kind === 'dem' ? 'โหลดข้อมูลความสูงภูมิประเทศไม่ได้ ภูมิประเทศ 3 มิติจะไม่แสดง' : kind === 'map' ? 'โหลดแผนที่ฐานไม่ได้ ตรวจการเชื่อมต่ออินเทอร์เน็ต' : `แผนที่แจ้งข้อผิดพลาด: ${message}`;
    this.callbacks.onError(text);
  }

  private onLoad(): void {
    if (this.disposed) return;
    const map = this.map;
    const layers = map.getStyle().layers;
    this.firstLabelLayer = this.raiseOverlays(layers.map((l) => ({ id: l.id, type: l.type })));

    for (const layer of layers) {
      if (layer.type !== 'symbol') continue;
      const field = layer.layout?.['text-field'];
      if (field !== undefined && JSON.stringify(field).includes('name')) map.setLayoutProperty(layer.id, 'text-field', LOCAL_NAME);
    }

    const dem = { type: 'raster-dem' as const, tiles: [DEM_TILE_URL], tileSize: DEM_TILE_SIZE, maxzoom: 13, encoding: 'terrarium' as const };
    map.addSource('fs-terrain', dem);
    map.addSource('fs-hillshade', dem);
    map.addLayer(
      { id: 'fs-hillshade', type: 'hillshade', source: 'fs-hillshade', paint: { 'hillshade-exaggeration': 0.32, 'hillshade-shadow-color': '#5d6474', 'hillshade-highlight-color': '#ffffff', 'hillshade-accent-color': '#8a90a0' } },
      this.firstLabelLayer,
    );
    if (this.terrainOn) map.setTerrain({ source: 'fs-terrain', exaggeration: 1 });

    map.addSource('fs-box', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'fs-box', type: 'line', source: 'fs-box', paint: { 'line-color': COLORS.box, 'line-width': 1.5, 'line-dasharray': [2, 3], 'line-opacity': 0.55 } }, this.firstLabelLayer);
    // Above everything baked into the terrain, below buildings and labels: water first, then roads and routes.
    for (const layer of [this.water, this.lines]) {
      layer.onFail = (message) => this.callbacks.onError(message);
      layer.setTerrain(this.terrainOn);
      map.addLayer(layer, this.firstLabelLayer);
    }

    const buildings = layers.find((l) => 'source-layer' in l && l['source-layer'] === 'building');
    if (buildings && 'source' in buildings && typeof buildings.source === 'string') {
      map.addLayer(
        {
          id: 'fs-buildings',
          type: 'fill-extrusion',
          source: buildings.source,
          'source-layer': 'building',
          minzoom: 14,
          paint: {
            'fill-extrusion-color': '#ffffff',
            'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
            'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
            'fill-extrusion-opacity': 0.9,
          },
        },
        this.firstLabelLayer,
      );
    }

    this.ready = true;
    this.callbacks.onReady();
    this.emitView();
  }

  /**
   * Moves labels and other layers drawn above the terrain to the top of the style, keeping their
   * order, and returns the first of them.
   *
   * With 3D relief the map bakes fills, lines and rasters into one texture per terrain tile, and it
   * keeps those textures between frames only while all such layers are adjacent. A style that puts
   * a label layer between two of them makes the map redraw every terrain tile on every frame, which
   * is what makes an animated map stutter.
   */
  private raiseOverlays(layers: readonly { id: string; type: string }[]): string | undefined {
    const overlays = layers.filter((l) => !DRAPED.has(l.type));
    const lastDraped = layers.findLastIndex((l) => DRAPED.has(l.type));
    const interleaved = overlays.some((l) => layers.indexOf(l) < lastDraped);
    if (interleaved) for (const layer of overlays) this.map.moveLayer(layer.id);
    return overlays[0]?.id;
  }

  private emitView(): void {
    const c = this.map.getCenter();
    const zoom = this.map.getZoom();
    this.callbacks.onView({ zoom, lng: c.lng, lat: c.lat, canAnalyse: zoom >= ANALYSIS.minZoom });
  }

  private source(id: string): GeoJSONSource | null {
    const s = this.ready ? this.map.getSource<GeoJSONSource>(id) : undefined;
    return s && s.type === 'geojson' ? s : null;
  }

  /* ---------------- camera ---------------- */

  /** Space covered by floating cards, so the map centres on what stays visible. */
  setPadding(padding: { left: number; right: number; top: number; bottom: number }): void {
    this.map.setPadding(padding);
  }

  /** Flies to show the whole of `box`. */
  showBox(box: Bounds): void {
    this.release();
    // The fit is worked out looking straight down; the tilt then shrinks the far edge, so back off a little.
    const fit = this.map.cameraForBounds([
      [box.west, box.south],
      [box.east, box.north],
    ]);
    const zoom = (fit?.zoom ?? 13) - 0.3;
    this.map.flyTo({ center: [(box.west + box.east) / 2, (box.south + box.north) / 2], zoom, pitch: 45, bearing: 0, speed: 1.4, essential: !this.reduceMotion });
  }

  showThailand(): void {
    this.release();
    const bounds: LngLatBoundsLike = [
      [THAILAND.west, THAILAND.south],
      [THAILAND.east, THAILAND.north],
    ];
    this.map.fitBounds(bounds, { pitch: 0, bearing: 0, duration: this.reduceMotion ? 0 : 1600 });
  }

  /** The area an analysis would cover right now, or null when zoomed too far out. */
  analysisBox(): Bounds | null {
    if (this.map.getZoom() < ANALYSIS.minZoom) return null;
    const b = this.map.getBounds();
    const c = this.map.getCenter();
    return clampBox({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }, c, ANALYSIS.maxWidthM, ANALYSIS.maxHeightM);
  }

  setPicking(on: boolean): void {
    this.picking = on;
    this.dropHandle();
    this.map.getCanvas().style.cursor = on ? 'crosshair' : '';
  }

  /** Flies to one step of the directions and marks it, or clears the mark. */
  showStep(at: [number, number] | null): void {
    this.stepMarker?.remove();
    this.stepMarker = null;
    if (!at) return;
    const el = document.createElement('div');
    el.className = 'step-dot';
    this.stepMarker = new Marker({ element: el, anchor: 'center' }).setLngLat(at).addTo(this.map);
    this.release();
    this.map.flyTo({ center: at, zoom: Math.max(this.map.getZoom(), 16.5), speed: 1.4, essential: !this.reduceMotion });
  }

  /* ---------------- data layers ---------------- */

  setAnalysisBox(box: Bounds | null): void {
    const data: FeatureCollection = box
      ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[box.west, box.north], [box.east, box.north], [box.east, box.south], [box.west, box.south], [box.west, box.north]] } }] }
      : EMPTY;
    this.source('fs-box')?.setData(data);
  }

  /**
   * Shows the flood for one area and cause at one setting. Changing only the setting costs nothing
   * on the CPU: the water front then travels to its new position. Pass nulls to remove the flood.
   */
  /** The flood over `grid`, drawn inside `clip` (the simulated area) only. */
  setFlood(grid: DemGrid | null, field: FloodField | null, setting: number, clip: Bounds | null): void {
    if (!this.ready) return;
    this.lines.setGrid(grid);
    if (!grid || !field) {
      this.floodField = null;
      this.water.clear();
      return;
    }
    if (this.floodField !== field) {
      this.floodField = field;
      this.water.setField(grid, field, clip);
    }
    this.water.setTarget(setting);
  }

  /** 3D relief costs frame rate on slower machines; the flood and routes work the same without it. */
  setTerrain(on: boolean): void {
    this.terrainOn = on;
    this.water.setTerrain(on);
    this.lines.setTerrain(on);
    if (this.ready) this.map.setTerrain(on ? { source: 'fs-terrain', exaggeration: 1 } : null);
  }

  setRoadStatus(status: RoadStatus | null): void {
    const batches: LineBatch[] = [];
    if (status?.wade.length) batches.push({ lines: status.wade, color: COLORS.wade, width: 3 });
    if (status?.shut.length) batches.push({ lines: status.shut, color: COLORS.shut, width: 3 });
    this.lines.set('roads', batches);
  }

  /** Shows the stops. Each marker can be dragged to move its stop. */
  setStops(stops: readonly MapStop[]): void {
    const keep = new Set<string>();
    for (const stop of stops) {
      keep.add(stop.id);
      const key = `${stop.letter}|${stop.name}|${stop.lng}|${stop.lat}`;
      const had = this.stopMarkers.get(stop.id);
      if (had?.key === key) continue;
      had?.marker.remove();
      this.stopMarkers.set(stop.id, { marker: this.stopMarker(stop), key });
    }
    for (const [id, { marker }] of this.stopMarkers) {
      if (keep.has(id)) continue;
      marker.remove();
      this.stopMarkers.delete(id);
    }
    this.stopPoints = stops.map((s) => [s.lng, s.lat]);
  }

  private stopMarker(stop: MapStop): Marker {
    const el = document.createElement('div');
    if (stop.letter) {
      el.className = 'map-pin';
      const badge = document.createElement('b');
      badge.textContent = stop.letter;
      el.append(badge, document.createTextNode(stop.name));
    } else {
      el.className = 'via-pin';
    }
    el.setAttribute('aria-label', `${stop.letter ? `จุด ${stop.letter}` : 'จุดที่ผ่าน'}: ${stop.name} (ลากเพื่อย้าย)`);
    el.title = stop.letter ? 'ลากเพื่อย้ายจุดนี้' : `ผ่าน ${stop.name} · ลากเพื่อย้าย`;
    const marker = new Marker({ element: el, draggable: true, ...(stop.letter ? { anchor: 'bottom', offset: [0, -6] } : { anchor: 'center' }) })
      .setLngLat([stop.lng, stop.lat])
      .addTo(this.map);
    marker.on('dragend', () => {
      const p = marker.getLngLat();
      this.callbacks.onMoveStop(stop.id, p.lng, p.lat);
    });
    return marker;
  }

  /* ---------------- dragging the route ---------------- */

  private canDragRoute(): boolean {
    const s = this.seq.get();
    return this.routeLine !== null && !this.picking && !s.playing && !s.engaged;
  }

  private dropHandle(): void {
    this.hoverSegment = -1;
    if (this.handleShown) {
      this.routeHandle.remove();
      this.handleShown = false;
    }
    if (!this.picking) this.map.getCanvas().style.cursor = '';
  }

  /** The route segment nearest a screen point, and the nearest point on it. */
  private nearestSegment(p: { x: number; y: number }): { index: number; x: number; y: number; dist: number } | null {
    const line = this.routeLine;
    if (!line || line.length < 2) return null;
    this.routeOnScreen ??= line.map((c) => this.map.project(c));
    const pts = this.routeOnScreen;
    let best: { index: number; x: number; y: number; dist: number } | null = null;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
      const x = a.x + dx * t;
      const y = a.y + dy * t;
      const dist = Math.hypot(p.x - x, p.y - y);
      if (!best || dist < best.dist) best = { index: i, x, y, dist };
    }
    return best;
  }

  private hoverRoute(e: MapMouseEvent): void {
    if (this.routeDrag) {
      this.routeHandle.setLngLat(e.lngLat);
      return;
    }
    const target = e.originalEvent.target;
    if (!this.canDragRoute() || (target instanceof Element && target.closest('.maplibregl-marker'))) {
      if (this.hoverSegment >= 0) this.dropHandle();
      return;
    }
    const hit = this.nearestSegment(e.point);
    // Grabbing right beside a stop would only add a point on top of it.
    const nearStop = hit !== null && this.stopPoints.some((c) => {
      const q = this.map.project(c);
      return Math.hypot(q.x - hit.x, q.y - hit.y) < 18;
    });
    if (!hit || hit.dist > 9 || nearStop) {
      if (this.hoverSegment >= 0) this.dropHandle();
      return;
    }
    this.hoverSegment = hit.index;
    this.routeHandle.setLngLat(this.map.unproject([hit.x, hit.y] as PointLike));
    if (!this.handleShown) {
      this.routeHandle.addTo(this.map);
      this.handleShown = true;
    }
    this.map.getCanvas().style.cursor = 'grab';
  }

  private grabRoute(e: MapMouseEvent): void {
    if (this.hoverSegment < 0 || e.originalEvent.button !== 0 || !this.canDragRoute()) return;
    e.preventDefault(); // keeps the map from panning
    this.routeDrag = { index: this.hoverSegment, x: e.originalEvent.clientX, y: e.originalEvent.clientY };
    this.map.getCanvas().style.cursor = 'grabbing';
    const release = (up: MouseEvent): void => {
      window.removeEventListener('mouseup', release);
      const drag = this.routeDrag;
      this.routeDrag = null;
      this.dropHandle();
      // A press without a real move is a click, not a drag.
      if (!drag || Math.hypot(up.clientX - drag.x, up.clientY - drag.y) < 5) return;
      const rect = this.map.getCanvasContainer().getBoundingClientRect();
      const p = this.map.unproject([up.clientX - rect.left, up.clientY - rect.top]);
      this.callbacks.onRouteDrag(drag.index, p.lng, p.lat);
    };
    window.addEventListener('mouseup', release);
  }

  /** Marks the place chosen from search, or clears the mark. Clicks pass through it to the map, so it never blocks picking A/B. */
  setSearchPin(place: Endpoint | null): void {
    this.searchPin?.remove();
    this.searchPin = null;
    if (!place) return;
    const el = document.createElement('div');
    el.className = 'place-pin';
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', `สถานที่ที่ค้นหา: ${place.name}`);
    const label = document.createElement('span');
    label.className = 'place-pin-label';
    label.textContent = place.name;
    const stem = document.createElement('span');
    stem.className = 'place-pin-stem';
    el.append(label, stem);
    this.searchPin = new Marker({ element: el, anchor: 'bottom' }).setLngLat([place.lng, place.lat]).addTo(this.map);
  }

  /* ---------------- routes and the travel sequence ---------------- */

  /** Shows the routes and prepares the selected one for playback with this vehicle. `depthAt` gives water depth at a coordinate. */
  setRoutes(routes: readonly Route[], selected: number, vehicle: Vehicle, depthAt: ((lng: number, lat: number) => number) | null): void {
    const chosen = routes[selected];
    const others = routes.filter((_, i) => i !== selected).map((r) => r.coords);
    const batches: LineBatch[] = [];
    if (others.length) batches.push({ lines: others, color: COLORS.alt, width: 4.5 });
    if (chosen) batches.push({ lines: [chosen.coords], color: COLORS.casing, width: 10 }, { lines: [chosen.coords], color: COLORS.ink, width: 6 });
    this.lines.set('routes', batches);
    this.routeLine = chosen && chosen.coords.length > 1 ? chosen.coords : null;
    this.routeOnScreen = null;
    if (!this.routeLine) this.dropHandle();

    const route = routes[selected];
    this.blend = null;
    if (!route || !depthAt || route.coords.length < 2) {
      this.trip = null;
      this.showVehicle(false);
      this.seq.set({ ...IDLE, rate: this.seq.get().rate });
      return;
    }
    const overview = this.map.cameraForBounds(
      [
        [Math.min(...route.coords.map((c) => c[0])), Math.min(...route.coords.map((c) => c[1]))],
        [Math.max(...route.coords.map((c) => c[0])), Math.max(...route.coords.map((c) => c[1]))],
      ],
      { padding: 60 },
    );
    const trip = buildTrip(route, vehicle, depthAt, Math.min(15, Math.max(11, overview?.zoom ?? 13)));
    this.trip = trip;
    this.vehicleView?.setVehicle(vehicle.id);
    const start = trip.poseAt(0);
    // Moving a marker makes the map read back from the GPU to test it against the terrain: skip a move to where it already is.
    const at = this.vehicleShown ? this.vehicleMarker.getLngLat() : null;
    if (!at || at.lng !== start.lng || at.lat !== start.lat) this.vehicleMarker.setLngLat([start.lng, start.lat]);
    this.showVehicle(true);
    this.poseVehicle(start.heading, 0, start.depth);
    this.seq.set({ u: 0, duration: trip.duration, playing: false, ready: true, engaged: false, remaining: route.length, depth: start.depth, rate: this.seq.get().rate });
  }

  get tracks(): readonly SeqTrack[] | null {
    return this.trip ? this.trip.tracks : null;
  }

  get wetSpans(): readonly boolean[] {
    return this.trip ? this.trip.wet : [];
  }

  play(fromStart = false): void {
    if (!this.trip) return;
    const current = this.seq.get();
    const u = fromStart || current.u >= 1 ? 0 : current.u;
    this.map.stop();
    this.blend = { from: this.cameraNow(), t0: performance.now() };
    this.last = performance.now();
    this.seq.set({ ...current, u, playing: true });
  }

  pause(): void {
    if (this.seq.get().playing) this.seq.set({ ...this.seq.get(), playing: false });
  }

  toggle(): void {
    if (this.seq.get().playing) this.pause();
    else this.play();
  }

  seek(u: number): void {
    if (!this.trip) return;
    this.blend = null;
    this.map.stop();
    this.seq.set({ ...this.seq.get(), playing: false });
    this.show(u);
  }

  cycleRate(): void {
    const rate = this.seq.get().rate;
    this.seq.set({ ...this.seq.get(), rate: rate === 1 ? 2 : rate === 2 ? 0.5 : 1 });
  }

  /** Hands the camera back to the user. */
  private release(): void {
    const s = this.seq.get();
    if (s.playing || s.engaged) this.seq.set({ ...s, playing: false, engaged: false });
    this.blend = null;
  }

  private showVehicle(on: boolean): void {
    if (on === this.vehicleShown) return;
    this.vehicleShown = on;
    if (on) this.vehicleMarker.addTo(this.map);
    else this.vehicleMarker.remove();
  }

  private poseVehicle(heading: number, speed: number, depth: number): void {
    const relative = ((heading - this.map.getBearing()) * Math.PI) / 180;
    this.vehicleView?.setPose({ yaw: Math.PI / 2 - relative, elevation: ((90 - this.map.getPitch()) * Math.PI) / 180 });
    this.vehicleView?.setMotion({ speed, wading: speed > 0 && depth > 0.05 });
    const scale = Math.min(1.9, Math.max(0.75, 2 ** (this.map.getZoom() - 15.7)));
    this.vehicleEl.style.setProperty('--vehicle-scale', scale.toFixed(3));
  }

  private cameraNow(): Camera {
    const c = this.map.getCenter();
    return { lng: c.lng, lat: c.lat, zoom: this.map.getZoom(), pitch: this.map.getPitch(), bearing: this.map.getBearing() };
  }

  private show(uRaw: number): void {
    const trip = this.trip;
    if (!trip) return;
    const u = Math.min(1, Math.max(0, uRaw));
    const [car, zoom, pitch, orbit] = trip.tracks;
    const progress = evalTrack(car.kf, u);
    const pose = trip.poseAt(progress);
    const mix = EASE.io(Math.min(1, u / 0.14));
    const target: Camera = {
      lng: trip.centroid.lng + (pose.lng - trip.centroid.lng) * mix,
      lat: trip.centroid.lat + (pose.lat - trip.centroid.lat) * mix,
      zoom: evalTrack(zoom.kf, u),
      pitch: evalTrack(pitch.kf, u),
      bearing: pose.heading + evalTrack(orbit.kf, u),
    };
    let cam = target;
    if (this.blend) {
      const k = EASE.io(Math.min(1, (performance.now() - this.blend.t0) / 900));
      if (k >= 1) {
        this.blend = null;
      } else {
        const f = this.blend.from;
        const turn = ((((target.bearing - f.bearing) % 360) + 540) % 360) - 180;
        cam = { lng: f.lng + (target.lng - f.lng) * k, lat: f.lat + (target.lat - f.lat) * k, zoom: f.zoom + (target.zoom - f.zoom) * k, pitch: f.pitch + (target.pitch - f.pitch) * k, bearing: f.bearing + turn * k };
      }
    }
    this.map.jumpTo({ center: [cam.lng, cam.lat], zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing });
    this.vehicleMarker.setLngLat([pose.lng, pose.lat]);
    const moving = progress > 0 && progress < 1 && this.seq.get().playing;
    this.poseVehicle(pose.heading, moving ? 1 : 0, pose.depth);
    this.seq.set({ ...this.seq.get(), u, engaged: true, remaining: trip.route.length - pose.s, depth: pose.depth });
  }

  private readonly frame = (now: number): void => {
    if (this.disposed) return;
    const state = this.seq.get();
    if (state.playing && this.trip) {
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.show(state.u + (dt * state.rate) / state.duration);
      if (this.seq.get().u >= 1) this.seq.set({ ...this.seq.get(), playing: false });
    } else if (this.trip && this.vehicleShown && !state.engaged) {
      // parked at the start: keep it facing the right way as the user turns the map
      const start = this.trip.poseAt(evalTrack(this.trip.tracks[0].kf, state.u));
      this.poseVehicle(start.heading, 0, start.depth);
    }
    if (this.vehicleShown) this.vehicleView?.render(now);
    this.raf = requestAnimationFrame(this.frame);
  };
}
