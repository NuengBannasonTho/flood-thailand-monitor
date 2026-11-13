'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import { CloseCircle, Loader, Scan } from 'reicon-react';
import { fetchRoads, reversePlace } from '@/lib/api';
import { ANALYSIS, type Bounds } from '@/lib/config';
import { boxAround, boxContains } from '@/lib/geo';
import { type Endpoint, MapController, type MapStop, type SeqSnapshot, type ViewInfo } from '@/lib/map/controller';
import type { Place } from '@/lib/places';
import { cellAt, type DemGrid, loadDem } from '@/lib/sim/dem';
import { buildField, countBelow, depthOf, findFloodBase, type FloodBase, type FloodField, type FloodMode, makeScratch, sortedWithin } from '@/lib/sim/flood';
import { MODES } from '@/lib/sim/modes';
import { directions, type Step } from '@/lib/sim/directions';
import { blockedLeg, buildGraph, type EdgeDepths, edgeDepths, nearestVertex, planRoutes, type RoadGraph, roadStatus, WET } from '@/lib/sim/roads';
import { VEHICLES, vehicleById, type VehicleId } from '@/lib/sim/vehicles';
import { FIRST_STOPS, MAX_STOPS, newStop, type Stop, stopLabel, stopLetters } from '@/lib/stops';
import { noSavedTrips, removeTrip, type SavedTrip, savedTrips, saveTrip, startSavedTrips, tripKey } from '@/lib/trips';
import { LevelCard } from './LevelCard';
import { MapTools } from './MapTools';
import { RoutePanel } from './RoutePanel';
import { SavedTrips } from './SavedTrips';
import { SearchBar } from './SearchBar';
import { TripDock } from './Timeline';
import { cn, TipProvider } from './ui/kit';
import { VehicleCard } from './VehicleCard';

interface ReadyArea {
  box: Bounds;
  grid: DemGrid;
  source: FloodBase;
  graph: RoadGraph;
  /** flood fields already worked out for this area, by cause; null = that cause cannot happen here */
  fields: Map<FloodMode, FloodField | null>;
}

type Analysis = { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string } | ({ status: 'ready' } & ReadyArea);

interface Notice {
  id: number;
  text: string;
}

const DESKTOP = '(min-width: 1024px)';
/** room kept around the route's ends when an area is chosen for them */
const END_MARGIN_M = 400;
/** how the panels leave and return in full screen */
const SLIDE = 'lg:transition-[translate,opacity] lg:duration-300 lg:ease-out motion-reduce:transition-none';
const INITIAL: Record<FloodMode, number> = { river: MODES.river.initial, sea: MODES.sea.initial, rain: MODES.rain.initial };

function clampValue(mode: FloodMode, v: number): number {
  const { max, step } = MODES[mode];
  return Math.round(Math.min(max, Math.max(0, v)) / step) * step;
}

/** The flood field for one cause in one area, worked out on first use and kept. */
function fieldFor(area: ReadyArea, mode: FloodMode): FloodField | null {
  const known = area.fields.get(mode);
  if (known !== undefined) return known;
  const field = buildField(area.grid, mode, area.source);
  area.fields.set(mode, field);
  return field;
}

/** Follows `value` only once it has stopped changing for `ms`. Route finding uses this: it is the heavy part. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/**
 * Follows `value`, but changes at most once per `ms`. Road status uses this: it keeps up with a
 * moving slider or rising water without being recomputed on every frame.
 */
function useThrottled<T>(value: T, ms: number): T {
  const [slow, setSlow] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const wait = Math.max(0, last.current + ms - performance.now());
    const id = window.setTimeout(() => {
      last.current = performance.now();
      setSlow(value);
    }, wait);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return slow;
}

/** Subscribes to one derived value of the sequence, so playback does not re-render the whole app. */
function useSeq<T extends boolean | number>(controller: MapController | null, pick: (s: SeqSnapshot) => T, fallback: T): T {
  const subscribe = useCallback((listener: () => void) => (controller ? controller.seq.subscribe(listener) : () => undefined), [controller]);
  const get = (): T => (controller ? pick(controller.seq.get()) : fallback);
  return useSyncExternalStore(subscribe, get, () => fallback);
}

function Hud({ controller, destination, full }: { controller: MapController; destination: string; full: boolean }): ReactElement | null {
  const snap = useSyncExternalStore(controller.seq.subscribe, controller.seq.get, controller.seq.get);
  if (!snap.ready || !snap.engaged) return null;
  const left = snap.remaining >= 1000 ? `${(snap.remaining / 1000).toFixed(1)} กม.` : `${Math.round(snap.remaining / 10) * 10} ม.`;
  return (
    <div className={cn('pointer-events-none absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2.5 rounded-full bg-ink px-4 py-2 text-[13px] whitespace-nowrap text-white shadow-chip lg:bottom-auto', full ? 'lg:top-4' : 'lg:top-[72px] lg:left-[calc(50%+10px)]')}>
      {snap.remaining < 15 ? (
        <span>ถึง{destination}แล้ว</span>
      ) : (
        <>
          <span className="tabular-nums">เหลือ {left}</span>
          <span className={cn('size-1.5 rounded-full', snap.depth > WET ? 'bg-water' : 'bg-ok')} />
          <span className="text-white/80 tabular-nums">{snap.depth > WET ? `น้ำลึก ${Math.round(snap.depth * 100)} ซม.` : 'ถนนแห้ง'}</span>
        </>
      )}
    </div>
  );
}

export function FloodApp(): ReactElement {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const noticeId = useRef(0);

  const [controller, setController] = useState<MapController | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [view, setView] = useState<ViewInfo | null>(null);
  const [analysis, setAnalysis] = useState<Analysis>({ status: 'idle' });
  const [mode, setMode] = useState<FloodMode>('river');
  const [values, setValues] = useState<Record<FloodMode, number>>(INITIAL);
  const [terrain, setTerrain] = useState(true);
  /** panels hidden, the map has the whole screen */
  const [full, setFull] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [vehicleId, setVehicleId] = useState<VehicleId>('car');
  const [stops, setStops] = useState<readonly Stop[]>(FIRST_STOPS);
  /** id of the stop being pinned on the map */
  const [picking, setPicking] = useState<string | null>(null);
  /** the place last chosen from search, marked on the map until the search box is cleared */
  const [searched, setSearched] = useState<Place | null>(null);
  const [selected, setSelected] = useState(0);
  const [rising, setRising] = useState(false);
  const [notices, setNotices] = useState<readonly Notice[]>([]);
  const value = values[mode];
  const valueRef = useRef(value);
  valueRef.current = value;
  const setValue = useCallback((next: number): void => setValues((all) => ({ ...all, [mode]: clampValue(mode, next) })), [mode]);

  const vehicle = vehicleById(vehicleId);
  const area = analysis.status === 'ready' ? analysis : null;
  // Latest values for handlers that must stay stable: the cards they go to are memoised.
  const stopsRef = useRef(stops);
  stopsRef.current = stops;
  /** the area simulated now, or being loaded */
  const targetBox = useRef<Bounds | null>(null);
  const trips = useSyncExternalStore(savedTrips.subscribe, savedTrips.get, noSavedTrips);
  useEffect(() => startSavedTrips(), []);
  const seqReady = useSeq(controller, (s) => s.ready, false);

  const notify = useCallback((text: string): void => {
    const id = ++noticeId.current;
    setNotices((list) => (list.some((n) => n.text === text) ? list : [...list.slice(-2), { id, text }]));
    window.setTimeout(() => setNotices((list) => list.filter((n) => n.id !== id)), 9000);
  }, []);

  /* ---------------- analysing an area ---------------- */

  /** Simulates `area`, or what the map shows when no area is given. */
  const analyse = useCallback(
    (map: MapController, area?: Bounds): void => {
      const box = area ?? map.analysisBox();
      if (!box) return;
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;
      targetBox.current = box;
      setRising(false);
      setPicking(null);
      setAnalysis({ status: 'loading' });
      Promise.all([loadDem(box, abort.signal), fetchRoads(box, abort.signal)])
        .then(([grid, roads]) => {
          if (abort.signal.aborted) return;
          const source = findFloodBase(grid, makeScratch(grid));
          const next: ReadyArea = { box, grid, source, graph: buildGraph(roads, grid), fields: new Map() };
          // The sea is only a choice where the area has sea in it.
          if (fieldFor(next, 'sea') === null) setMode((m) => (m === 'sea' ? 'river' : m));
          setAnalysis({ status: 'ready', ...next });
          // Stops outside the new area are emptied; points only passed through are dropped.
          setStops((list) => list.flatMap((st) => (!st.point || boxContains(box, st.point.lng, st.point.lat) ? [st] : st.via ? [] : [{ ...st, point: null }])));
          setSelected(0);
        })
        .catch((error: unknown) => {
          if (abort.signal.aborted) return;
          targetBox.current = null;
          setAnalysis({ status: 'error', message: error instanceof Error ? error.message : 'โหลดข้อมูลพื้นที่ไม่สำเร็จ' });
        });
    },
    [],
  );

  /**
   * Takes a new list of stops. When a stop lies outside the simulated area, the simulation moves to
   * cover them all, or when they are too far apart, just `focus`: the place set last.
   */
  const applyStops = useCallback(
    (next: readonly Stop[], focus: Endpoint | null): void => {
      setStops(next);
      setPicking(null);
      setSelected(0);
      const placed = next.flatMap((st) => (st.point ? [st.point] : []));
      const target = targetBox.current;
      if (!controller || placed.length === 0 || (target && placed.every((p) => boxContains(target, p.lng, p.lat)))) return;
      const all = boxAround(placed, ANALYSIS.maxWidthM, ANALYSIS.maxHeightM, END_MARGIN_M);
      const box = all ?? (focus ? boxAround([focus], ANALYSIS.maxWidthM, ANALYSIS.maxHeightM, 0) : null);
      if (!box) return;
      if (!all && focus) notify(`จุดต่าง ๆ ห่างกันเกินกว่าจะจำลองในพื้นที่เดียว (ไม่เกิน ${ANALYSIS.maxWidthM / 1000} × ${ANALYSIS.maxHeightM / 1000} กม.) จึงย้ายไปจำลองรอบ ${focus.name} จุดที่อยู่นอกพื้นที่ใหม่จะถูกล้าง`);
      controller.showBox(box);
      analyse(controller, box);
    },
    [controller, analyse, notify],
  );

  /** Names the stop after what is at its spot, unless it has moved on since. */
  const nameStop = useCallback((id: string, lng: number, lat: number): void => {
    reversePlace(lng, lat)
      .then((place) => {
        if (place) setStops((list) => list.map((st) => (st.id === id && st.point?.lng === lng && st.point.lat === lat ? { ...st, point: { ...st.point, name: place.name } } : st)));
      })
      .catch(() => undefined); // the pin works without a name
  }, []);

  /** Puts a stop at a spot on the map. */
  const placeStop = useCallback(
    (id: string, lng: number, lat: number, name: string): void => {
      const point = { lng, lat, name };
      applyStops(stopsRef.current.map((st) => (st.id === id ? { ...st, point } : st)), point);
      nameStop(id, lng, lat);
    },
    [applyStops, nameStop],
  );

  const pickRef = useRef<(lng: number, lat: number) => void>(() => undefined);
  pickRef.current = (lng, lat) => {
    if (picking) placeStop(picking, lng, lat, 'จุดที่ปัก');
  };
  const moveRef = useRef<(id: string, lng: number, lat: number) => void>(() => undefined);
  moveRef.current = (id, lng, lat) => placeStop(id, lng, lat, 'จุดที่ปัก');
  /** The route was dragged off a segment: it now has to pass the drop point on that leg. */
  const dragRef = useRef<(index: number, lng: number, lat: number) => void>(() => undefined);

  /* ---------------- map lifecycle ---------------- */

  useEffect(() => {
    const el = mapRef.current;
    if (!el) return undefined;
    let created: MapController;
    try {
      created = new MapController(el, {
        onReady: () => setMapReady(true),
        onView: setView,
        onPick: (lng, lat) => pickRef.current(lng, lat),
        onMoveStop: (id, lng, lat) => moveRef.current(id, lng, lat),
        onRouteDrag: (index, lng, lat) => dragRef.current(index, lng, lat),
        onError: notify,
      });
    } catch {
      notify('เบราว์เซอร์นี้เปิดแผนที่ 3 มิติ (WebGL) ไม่ได้ ลองใช้ Chrome, Edge หรือ Safari รุ่นใหม่');
      return undefined;
    }
    setController(created);
    return () => {
      abortRef.current?.abort();
      created.dispose();
      setController(null);
      setMapReady(false);
    };
  }, [analyse, notify]);

  /* ---------------- simulation, derived from state ---------------- */

  const field = useMemo(() => (area ? fieldFor(area, mode) : null), [area, mode]);
  // What the slider sets: a water surface above sea level for river and sea, millimetres for rain.
  const setting = mode === 'river' && area ? area.source.base + value : value;
  // Under water inside the simulated area: the flood is worked out further out, but roads end at its edge.
  const within = useMemo(() => (area && field ? sortedWithin(field, area.grid, area.box) : null), [area, field]);
  const areaKm2 = area && within ? (countBelow(within, setting) * area.grid.cellM ** 2) / 1e6 : 0;

  // The water itself is drawn on the GPU and follows `setting` every frame. The road overlay follows
  // a few times a second, and routes wait until the level stops moving: neither may stall a frame.
  const statusSetting = useThrottled(setting, 420);
  const routeSetting = useSettled(setting, 240);
  const statusDepths = useMemo<EdgeDepths | null>(() => (area && field ? edgeDepths(area.graph, (cell) => depthOf(field, cell, statusSetting)) : null), [area, field, statusSetting]);
  const depths = useMemo<EdgeDepths | null>(() => (area && field ? edgeDepths(area.graph, (cell) => depthOf(field, cell, routeSetting)) : null), [area, field, routeSetting]);
  const depthAt = useMemo(() => {
    if (!area || !field) return null;
    const { grid } = area;
    return (lng: number, lat: number): number => depthOf(field, cellAt(grid, lng, lat), routeSetting);
  }, [area, field, routeSetting]);
  const status = useMemo(() => (area && statusDepths ? roadStatus(area.graph, statusDepths, vehicle) : null), [area, statusDepths, vehicle]);
  const wadeKm = useMemo(() => {
    if (!area || !statusDepths) return 0;
    let metres = 0;
    for (const e of area.graph.edges) if (statusDepths.max[e.id] > WET) metres += e.len;
    return Math.max(0, metres / 1000 - (status?.shutKm ?? 0));
  }, [area, statusDepths, status]);

  const outside = area !== null && stops.some((st) => st.point !== null && !boxContains(area.box, st.point.lng, st.point.lat));
  /** the stops routing goes through: placed ones, each at its nearest junction, repeats dropped */
  const plan = useMemo(() => {
    const first = stops[0]?.point;
    const last = stops[stops.length - 1]?.point;
    if (!area || outside || !first || !last) return null;
    const list: { stop: Stop; index: number; vertex: number }[] = [];
    stops.forEach((st, index) => {
      if (!st.point) return;
      const vertex = nearestVertex(area.graph, st.point.lng, st.point.lat);
      if (list[list.length - 1]?.vertex !== vertex) list.push({ stop: st, index, vertex });
    });
    return list.length >= 2 ? list : null;
  }, [area, stops, outside]);
  // Renaming a stop must not route again: routes follow the junctions only.
  const vertexKey = plan ? plan.map((p) => p.vertex).join(',') : '';
  const vertices = useMemo(() => (vertexKey ? vertexKey.split(',').map(Number) : null), [vertexKey]);

  const routes = useMemo(() => (area && depths && vertices ? planRoutes(area.graph, vertices, depths, vehicle) : []), [area, depths, vertices, vehicle]);
  const sel = selected < routes.length ? selected : 0;
  const dryLength = useMemo(() => {
    if (!area || !vertices) return null;
    const n = area.graph.edges.length;
    const dry: EdgeDepths = { max: new Float32Array(n), min: new Float32Array(n) };
    return planRoutes(area.graph, vertices, dry, vehicle)[0]?.length ?? null;
  }, [area, vertices, vehicle]);
  const reach = useMemo(() => {
    if (!area || !depths || !vertices) return null;
    const result: Partial<Record<VehicleId, boolean>> = {};
    // The chosen vehicle's answer is already known from its routes.
    for (const v of VEHICLES) result[v.id] = v.id === vehicle.id ? routes.length > 0 : blockedLeg(area.graph, vertices, depths, v) === -1;
    return result;
  }, [area, depths, vertices, vehicle, routes]);

  const letters = useMemo(() => stopLetters(stops), [stops]);
  const nameOf = useCallback((index: number): string => letters[index] ?? stopLabel(stops, index), [letters, stops]);
  const blocked = useMemo(() => {
    if (!area || !depths || !vertices || !plan || routes.length > 0 || vertices.length < 3) return null;
    const leg = blockedLeg(area.graph, vertices, depths, vehicle);
    return leg < 0 ? null : { from: nameOf(plan[leg].index), to: nameOf(plan[leg + 1].index) };
  }, [area, depths, vertices, plan, routes, vehicle, nameOf]);

  const route = routes[sel] ?? null;
  const steps = useMemo<Step[]>(() => {
    if (!area || !depths || !route || !plan || plan.length !== route.legStart.length + 1) return [];
    const at = plan.map((p, k) => ({ at: k === 0 ? 0 : k < plan.length - 1 ? route.legStart[k] : route.coords.length - 1, via: p.stop.via }));
    return directions(area.graph, route, depths, vehicle, at);
  }, [area, depths, route, plan, vehicle]);
  const stepStops = useMemo(() => (plan ? plan.map((p) => ({ letter: letters[p.index], name: p.stop.point?.name ?? '' })) : []), [plan, letters]);

  dragRef.current = (index, lng, lat) => {
    if (!route || !plan) return;
    if (stopsRef.current.length >= MAX_STOPS) {
      notify(`เส้นทางหนึ่งมีจุดได้ไม่เกิน ${MAX_STOPS} จุด ลบจุดที่ไม่ใช้ก่อน`);
      return;
    }
    // The leg the dragged segment belongs to ends at the stop the new point goes in front of.
    let leg = 0;
    while (leg + 1 < route.legStart.length && route.legStart[leg + 1] <= index) leg++;
    const before = plan[leg + 1]?.stop.id;
    const list = stopsRef.current;
    const at = list.findIndex((st) => st.id === before);
    if (at < 0) return;
    const via = newStop(true, { lng, lat, name: 'จุดที่ผ่าน' });
    applyStops([...list.slice(0, at), via, ...list.slice(at)], via.point);
    nameStop(via.id, lng, lat);
  };

  const mapStops = useMemo<MapStop[]>(
    () => stops.flatMap((st, i) => (st.point ? [{ id: st.id, letter: letters[i], name: st.point.name, lng: st.point.lng, lat: st.point.lat }] : [])),
    [stops, letters],
  );
  const placed = stops.filter((st) => st.point !== null);
  const currentTrip = stops[0]?.point && stops[stops.length - 1]?.point ? placed.map((st) => ({ via: st.via, point: st.point as Endpoint })) : null;
  const savedMatch = currentTrip ? trips.find((t) => tripKey(t.stops) === tripKey(currentTrip)) : undefined;
  const savedRef = useRef({ currentTrip, savedMatch, vehicleId });
  savedRef.current = { currentTrip, savedMatch, vehicleId };

  /* ---------------- pushing state to the map ---------------- */

  useEffect(() => {
    if (controller && mapReady) controller.setFlood(area?.grid ?? null, field, setting, area?.box ?? null);
  }, [controller, mapReady, area, field, setting]);
  useEffect(() => {
    if (controller && mapReady) controller.setAnalysisBox(area?.box ?? null);
  }, [controller, mapReady, area]);
  useEffect(() => {
    if (controller && mapReady) controller.setRoadStatus(status);
  }, [controller, mapReady, status]);
  useEffect(() => {
    if (controller && mapReady) controller.setRoutes(routes, sel, vehicle, depthAt);
  }, [controller, mapReady, routes, sel, vehicle, depthAt]);
  useEffect(() => {
    if (controller && mapReady) controller.setStops(mapStops);
  }, [controller, mapReady, mapStops]);
  // A step marked on the map belongs to the route it came from.
  useEffect(() => controller?.showStep(null), [controller, route]);
  useEffect(() => {
    if (controller && mapReady) controller.setSearchPin(searched);
  }, [controller, mapReady, searched]);
  useEffect(() => controller?.setPicking(picking !== null), [controller, picking]);
  useEffect(() => controller?.setTerrain(terrain), [controller, terrain]);

  useEffect(() => {
    if (!controller) return undefined;
    const wide = matchMedia(DESKTOP);
    // Desktop: flood column on the left (392 px), journey column on the right (372 px), status chips on top,
    // trip dock below. Full screen keeps only the trip dock.
    const apply = (): void => {
      const bottom = seqReady && timelineOpen ? 212 : seqReady ? 84 : 24;
      if (wide.matches) controller.setPadding(full ? { left: 24, right: 24, top: 24, bottom } : { left: 392, right: 372, top: 72, bottom });
      else controller.setPadding({ left: 0, right: 0, top: full ? 0 : 64, bottom: 0 });
    };
    wide.addEventListener('change', apply);
    apply();
    return () => wide.removeEventListener('change', apply);
  }, [controller, seqReady, timelineOpen, full]);

  useEffect(() => {
    if (!full) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) setFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  /* watch-it-rise run: the setting climbs at a steady rate until its stop */
  useEffect(() => {
    if (!rising) return undefined;
    const { riseTo, riseRate, step } = MODES[mode];
    const start = valueRef.current >= riseTo - step ? 0 : valueRef.current;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number): void => {
      const next = Math.min(riseTo, start + ((now - t0) / 1000) * riseRate);
      setValue(next);
      if (next >= riseTo) setRising(false);
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [rising, mode, setValue]);

  useEffect(() => {
    if (!controller) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement;
      if (e.code !== 'Space' || (el instanceof HTMLElement && el.closest('button, input, [role="slider"], [role="radio"]'))) return;
      e.preventDefault();
      setRising(false);
      controller.toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller]);

  /* ---------------- handlers ---------------- */

  // Handlers are stable so the memoised cards below skip re-rendering while the water level animates.
  /** A place from the search bar: the whole area around it is simulated, and the camera frames it. */
  const goTo = useCallback(
    (place: Place): void => {
      if (!controller) return;
      setSearched(place);
      const box = boxAround([place], ANALYSIS.maxWidthM, ANALYSIS.maxHeightM, 0);
      if (!box) return;
      controller.showBox(box);
      analyse(controller, box);
    },
    [controller, analyse],
  );
  const clearSearched = useCallback((): void => setSearched(null), []);
  const toggleFull = useCallback((on: boolean): void => {
    setFull(on);
    if (on) setPicking(null); // the prompt for picking lives in a hidden panel
  }, []);
  /** A stop chosen from search. Search covers all of Thailand, so the place may lie outside the simulated area. */
  const setStopPoint = useCallback(
    (id: string, point: Endpoint): void => applyStops(stopsRef.current.map((st) => (st.id === id ? { ...st, point } : st)), point),
    [applyStops],
  );
  const removeStop = useCallback((id: string): void => {
    setPicking((p) => (p === id ? null : p));
    setSelected(0);
    // A trip keeps two rows; below that the row stays and only its place goes.
    setStops((list) => (list.length > 2 ? list.filter((st) => st.id !== id) : list.map((st) => (st.id === id ? { ...st, point: null } : st))));
  }, []);
  const addStop = useCallback((): void => {
    setStops((list) => (list.length >= MAX_STOPS ? list : [...list.slice(0, -1), newStop(), ...list.slice(-1)]));
  }, []);
  const reorderStops = useCallback((next: Stop[]): void => {
    setStops(next);
    setSelected(0);
  }, []);
  const swapStops = useCallback((): void => {
    setStops((list) => [...list].reverse());
    setSelected(0);
  }, []);
  const focusStep = useCallback((step: Step | null): void => controller?.showStep(step ? step.at : null), [controller]);
  const toggleSave = useCallback((): void => {
    const { currentTrip: trip, savedMatch: match, vehicleId: vid } = savedRef.current;
    if (match) removeTrip(match.id);
    else if (trip) saveTrip(trip, vid);
  }, []);
  const loadTrip = useCallback(
    (trip: SavedTrip): void => {
      setVehicleId(trip.vehicle);
      applyStops(
        trip.stops.map((st) => newStop(st.via, st.point)),
        trip.stops[0].point,
      );
    },
    [applyStops],
  );
  const chooseVehicle = useCallback((id: VehicleId): void => {
    setVehicleId(id);
    setSelected(0);
  }, []);
  const showThailand = useCallback((): void => controller?.showThailand(), [controller]);
  const startTrip = useCallback((): void => {
    setRising(false);
    setPicking(null);
    controller?.play(true);
  }, [controller]);

  const movedAway = area !== null && view !== null && !boxContains(area.box, view.lng, view.lat);
  const canAnalyse = controller !== null && mapReady && view?.canAnalyse === true && analysis.status !== 'loading';
  const showCta = canAnalyse && (analysis.status !== 'ready' || movedAway);

  return (
    <TipProvider delayDuration={250}>
      <main className="relative flex h-dvh flex-col lg:block">
        <div className={cn('relative min-h-0 lg:absolute lg:inset-0', full ? 'flex-1' : 'flex-[0_0_50%]')}>
          <div ref={mapRef} className="size-full" />

          {/* Mobile: search and status stack over the map. Desktop: search heads the left column, status sits centred over the map. */}
          <div className="absolute top-3 right-3 left-3 z-20 flex flex-col items-start gap-2 lg:contents">
            <div inert={full} className={cn('w-full lg:absolute lg:top-4 lg:left-4 lg:z-20 lg:w-[360px]', SLIDE, full && 'max-lg:hidden lg:pointer-events-none lg:-translate-y-3 lg:opacity-0')}>
              <SearchBar onSelect={goTo} onClear={clearSearched} className="w-full" />
            </div>

            <div className={cn('flex flex-col items-start gap-2 lg:pointer-events-none lg:absolute lg:top-4 lg:z-20 lg:items-center lg:*:pointer-events-auto lg:*:max-w-[460px]', full ? 'lg:right-20 lg:left-20' : 'lg:right-[424px] lg:left-[392px]')}>
            {analysis.status === 'loading' ? (
              <div className="flex items-center gap-2 rounded-full bg-surface px-4 py-2 text-[13px] shadow-chip" role="status">
                <Loader size={16} className="animate-spin" />
                กำลังโหลดความสูงภูมิประเทศและถนนของพื้นที่นี้
              </div>
            ) : null}
            {analysis.status === 'error' ? (
              <div className="rounded-tile bg-surface p-3.5 text-[13px] shadow-chip" role="alert">
                <p className="font-semibold text-danger">จำลองพื้นที่นี้ไม่สำเร็จ</p>
                <p className="mt-0.5">{analysis.message}</p>
              </div>
            ) : null}
            {showCta && controller ? (
              <button type="button" onClick={() => analyse(controller)} className="flex h-11 items-center gap-2 rounded-full bg-ink px-5 text-[13.5px] font-medium text-white shadow-chip transition-colors hover:bg-ink-soft">
                <Scan size={17} />
                {analysis.status === 'ready' ? 'จำลองน้ำท่วมพื้นที่นี้แทน' : analysis.status === 'error' ? 'ลองอีกครั้ง' : 'จำลองน้ำท่วมพื้นที่นี้'}
              </button>
            ) : null}
            {mapReady && analysis.status === 'idle' && view && !view.canAnalyse ? (
              <p className="rounded-full bg-surface/95 px-4 py-2 text-[13px] text-muted shadow-chip">ค้นหาเมือง หรือซูมเข้าไปใกล้ ๆ เพื่อเริ่มจำลองน้ำท่วม</p>
            ) : null}
            {notices.map((n) => (
              <div key={n.id} className="flex items-start gap-2 rounded-tile bg-ink py-2.5 pr-2 pl-4 text-[13px] text-white shadow-chip" role="alert">
                <span className="min-w-0 flex-1">{n.text}</span>
                <button type="button" aria-label="ปิดข้อความ" onClick={() => setNotices((list) => list.filter((x) => x.id !== n.id))} className="grid size-6 shrink-0 place-items-center text-white/60 hover:text-white">
                  <CloseCircle size={16} />
                </button>
              </div>
            ))}
            </div>
          </div>

          <MapTools
            terrain={terrain}
            onTerrain={setTerrain}
            full={full}
            onFull={toggleFull}
            onShowThailand={showThailand}
            className={cn('absolute right-3 bottom-8 z-10 lg:top-4 lg:bottom-auto lg:transition-[right] lg:duration-300 lg:ease-out motion-reduce:transition-none', full ? 'lg:right-4' : 'lg:right-[372px]')}
          />
          {controller ? <Hud controller={controller} destination={stops[stops.length - 1]?.point?.name ?? 'ปลายทาง'} full={full} /> : null}
        </div>

        {/* Full screen on mobile keeps the sheet only for the trip dock */}
        <div className={cn('scroll-thin relative z-10 -mt-5 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-t-card bg-canvas p-3 lg:contents', full && (seqReady ? 'max-lg:flex-none' : 'max-lg:hidden'))}>
          {/* Desktop: the flood on the left, the journey on the right. On mobile both columns dissolve into one stack: vehicle, flood, route, note. */}
          <div
            inert={full}
            className={cn(
              'scroll-thin contents lg:absolute lg:top-[84px] lg:left-4 lg:z-10 lg:flex lg:max-h-[calc(100dvh-100px)] lg:w-[360px] lg:flex-col lg:gap-3 lg:overflow-y-auto lg:rounded-card',
              SLIDE,
              full && 'max-lg:hidden lg:pointer-events-none lg:-translate-x-[calc(100%+24px)] lg:opacity-0',
            )}
          >
            <LevelCard
              ready={area !== null}
              mode={mode}
              available={{ river: true, rain: true, sea: area ? area.fields.get('sea') !== null : true }}
              value={value}
              surface={area && mode !== 'rain' ? setting : null}
              areaKm2={areaKm2}
              shutKm={status?.shutKm ?? 0}
              wadeKm={wadeKm}
              rising={rising}
              onMode={(next) => {
                setRising(false);
                setMode(next);
                setSelected(0);
              }}
              onValue={(next) => {
                setRising(false);
                setValue(next);
              }}
              onToggleRise={() => {
                controller?.pause();
                setRising((v) => !v);
              }}
            />
            <p className="px-2 pb-1 text-[11.5px] leading-relaxed text-muted max-lg:order-last lg:rounded-tile lg:bg-surface/90 lg:px-4 lg:py-3 lg:backdrop-blur-sm">
              แบบจำลองอย่างง่าย: น้ำล้นตลิ่งและน้ำทะเลหนุนแผ่จากแหล่งน้ำไปทุกจุดที่ต่ำกว่าผิวน้ำและน้ำไหลถึง ส่วนฝนตกหนักคือน้ำขังในแอ่งที่ไม่มีทางระบาย ไม่คิดอัตราการไหล ท่อระบายน้ำ เครื่องสูบ หรือคันกั้นน้ำที่เล็กกว่า 40 ม. ห้ามใช้ตัดสินใจในสถานการณ์จริง
              {process.env.APP_VERSION ? <span className="mt-1 block tabular-nums">เวอร์ชัน {process.env.APP_VERSION}</span> : null}
            </p>
          </div>

          <div
            inert={full}
            className={cn(
              'scroll-thin contents lg:absolute lg:top-4 lg:right-4 lg:z-10 lg:flex lg:max-h-[calc(100dvh-32px)] lg:w-[340px] lg:flex-col lg:gap-3 lg:overflow-y-auto lg:rounded-card',
              SLIDE,
              full && 'max-lg:hidden lg:pointer-events-none lg:translate-x-[calc(100%+24px)] lg:opacity-0',
            )}
          >
            <VehicleCard value={vehicleId} reach={reach} onChange={chooseVehicle} className="max-lg:order-first" />
            <RoutePanel
              ready={area !== null}
              searchable={mapReady}
              stops={stops}
              picking={picking}
              near={area?.box ?? null}
              outside={outside}
              routes={routes}
              selected={sel}
              dryLength={dryLength}
              vehicle={vehicle}
              reach={reach}
              blocked={blocked}
              steps={steps}
              stepStops={stepStops}
              saved={savedMatch !== undefined}
              canSave={currentTrip !== null}
              onPick={setPicking}
              onRemove={removeStop}
              onSet={setStopPoint}
              onReorder={reorderStops}
              onAdd={addStop}
              onSwap={swapStops}
              onToggleSave={toggleSave}
              onSelect={setSelected}
              onVehicle={chooseVehicle}
              onStep={focusStep}
              onGo={startTrip}
            />
            <SavedTrips trips={trips} onLoad={loadTrip} onRemove={removeTrip} />
          </div>

          {controller && seqReady ? (
            <TripDock
              controller={controller}
              open={timelineOpen}
              onOpenChange={setTimelineOpen}
              className={cn('lg:absolute lg:bottom-4 lg:z-10', full ? 'lg:left-1/2 lg:w-[min(680px,calc(100%-32px))] lg:-translate-x-1/2' : 'lg:right-[372px] lg:left-[392px]')}
            />
          ) : null}
        </div>
      </main>
    </TipProvider>
  );
}
