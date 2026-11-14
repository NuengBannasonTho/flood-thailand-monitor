# 🌊 flood-thai: stack and handover notes

<p>
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white">
  <img alt="TypeScript 7" src="https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white">
  <img alt="MapLibre GL JS 5" src="https://img.shields.io/badge/MapLibre_GL_JS-5-396CB2?logo=maplibre&logoColor=white">
  <img alt="three.js 0.187" src="https://img.shields.io/badge/three.js-0.187-000000?logo=threedotjs&logoColor=white">
  <img alt="Tailwind CSS 4" src="https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white">
  <img alt="Vitest 5" src="https://img.shields.io/badge/Vitest-5-6E9F18?logo=vitest&logoColor=white">
  <img alt="No API keys" src="https://img.shields.io/badge/API_keys-none-2f7fe0">
</p>

![Water rising from the river and spreading across the area](docs/demo-flood.gif)

| Routes at a chosen water level | Trip playback |
| --- | --- |
| ![Routes avoiding flooded roads](docs/routes.png) | ![Vehicle following the route in 3D](docs/trip.png) |

<sub>Captured in an automated browser test with synthetic terrain and roads, not real map data. The GIF is sped up.</sub>

What you need to build, run and extend this flood-simulation web app: tools, libraries, data services, and the parts that are written by hand. Versions are the ones installed in this project.

Thai version: `STACK.th.md`. Usage and model notes (Thai): `README.md`.

## 🧰 1. Prerequisites

| Item | Version | Purpose |
| --- | --- | --- |
| Node.js | 20.9 or newer (developed on 22) | Runs Next.js and all tooling |
| npm | Ships with Node.js | Installs dependencies |
| Browser with WebGL2 | Current Chrome, Edge, Firefox or Safari | Renders the map, the water and the 3D models |
| Internet access | - | Map tiles, elevation, roads and place names are fetched live |

Not needed: API keys, accounts with any service, a database, Docker.

```bash
npm install         # install
npm run dev         # development server at http://localhost:3000
npm run build       # production build
npm start           # serve the production build
npm test            # unit tests for the simulation
npm run typecheck
```

## 📦 2. Libraries

### Application framework

| Package | Version | Licence | Purpose |
| --- | --- | --- | --- |
| `next` | 16.4.6 | MIT | App Router pages, plus API routes that proxy the data services |
| `react`, `react-dom` | 19.3.1 | MIT | UI |
| `typescript` | 7.0.2 | Apache-2.0 | Strict mode across the project; no `any`, no unsafe casts |

### Map and 3D

| Package | Version | Licence | Purpose |
| --- | --- | --- | --- |
| `maplibre-gl` | 5.24.1 | BSD-3-Clause | Base map, 3D terrain, camera, and custom layers for water and lines |
| `three` | 0.187.0 | MIT | 3D vehicle models (car, pickup, truck, motorbike, long-tail boat) |

MapLibre 5 was chosen over 6 because version 6 needs extra worker-file setup when used with a bundler.

### UI and motion

| Package | Version | Licence | Purpose |
| --- | --- | --- | --- |
| `tailwindcss` + `@tailwindcss/postcss` | 4.3.5 | MIT | All styling; colour, radius and shadow tokens live in `app/globals.css` |
| `@animate-ui/react` | 2.4.3 | MIT + Commons Clause | Buttons, tooltips, slider, sliding numbers |
| `motion` | 14.13.0 | MIT | UI animation (used by animate-ui) |
| `radix-ui` | 1.8.1 | MIT | Accessible component behaviour |
| `reicon-react` | 1.2.6 | MIT | Icons (reicon.dev) |
| `@fontsource-variable/anuphan` | 5.3.0 | OFL-1.1 | Thai typeface, bundled locally rather than loaded from a CDN |

Licence note: the Commons Clause on animate-ui forbids reselling the library itself. Using it inside your own site is allowed, but read its LICENSE file before commercial use.

### Development

| Package | Version | Purpose |
| --- | --- | --- |
| `vitest` | 5.1.0 | Unit tests for flooding and routing (`tests/sim.test.ts`) |
| `@types/node`, `@types/react`, `@types/react-dom`, `@types/three`, `@types/geojson` | - | Type definitions |

## 🛰️ 3. Data services (free, no sign-up)

| Service | Provides | Called from | Conditions |
| --- | --- | --- | --- |
| OpenFreeMap (`positron` style) | Base map and place names for the whole country | Browser | Show OpenStreetMap attribution |
| AWS Terrain Tiles (Terrarium PNG) | Ground elevation, used for both 3D terrain and the flood model | Browser, with `/api/dem` as a same-origin fallback | Show data-source attribution |
| Overpass API | Road network from OpenStreetMap | Server, `/api/roads` | Fair use; identify yourself with a User-Agent |
| Nominatim | Place search and reverse geocoding | Server, `/api/geocode`, `/api/reverse` | At most 1 request per second; User-Agent required; no search-as-you-type |

The app already follows these: search fires on submit only, upstream calls are throttled and cached, and attribution is shown on the map.

All four are public services with no availability guarantee. They suit personal use and prototypes. For a site with real traffic, self-host or use a paid provider and point the app at it with the variables below. Check each service's current usage policy before going live; the conditions above were checked when the app was built, not re-verified since.

Elevation decoding: `elevation = R * 256 + G + B / 256 - 32768` (metres).

### Environment variables (all optional)

| Variable | Purpose |
| --- | --- |
| `CONTACT_EMAIL` | Added to the User-Agent sent to Nominatim and Overpass |
| `OVERPASS_URL` | Alternative Overpass server |
| `NOMINATIM_URL` | Alternative Nominatim server |
| `NEXT_PUBLIC_MAP_STYLE_URL` | Alternative base-map style |
| `NEXT_PUBLIC_DEM_TILE_URL` | Alternative elevation tile source |

Copy `.env.example` to `.env.local` and fill in what you need.

## ✍️ 4. Hand-written parts

| Part | Files | What it does |
| --- | --- | --- |
| Flood model | `lib/sim/flood.ts`, `lib/sim/dem.ts` | Loads elevation into a grid, finds the area's base level, and precomputes when each cell gets wet for each cause |
| Flood causes | `lib/sim/modes.ts` | Ranges, units and presets for river overflow, heavy local rain and sea surge, with Thai Meteorological Department rain classes |
| Road graph and routing | `lib/sim/roads.ts`, `lib/sim/vehicles.ts` | Dijkstra with per-vehicle wading limits; up to 3 alternative routes |
| Water layer | `lib/map/water-layer.ts` | GLSL shader that draws the water as moving layered bands |
| Line layer | `lib/map/line-layer.ts` | Draws flooded roads and routes above the water |
| Shared GL helpers | `lib/map/gl.ts` | Shader compilation, coordinate frame, elevation sampling |
| Map controller | `lib/map/controller.ts` | Owns the MapLibre map, layers, pins, vehicle marker and trip playback |
| Trip sequence | `lib/map/sequence.ts`, `components/Timeline.tsx` | Keyframed camera tracks and the collapsible timeline |
| Vehicle models | `lib/three/models.ts`, `lib/three/vehicle-view.ts` | Models built in code from primitives; no external model files |
| Service proxies | `lib/server/*`, `app/api/*` | Throttling, caching, and compacting road data before it reaches the browser |
| UI | `components/*`, `components/ui/kit.tsx` | Cards, panels and shared primitives |

## 🧩 5. How it fits together

1. The user searches or pans to a place. `FloodApp.tsx` asks the controller for the analysis box (at most about 10 x 7 km).
2. `loadDem` fetches elevation tiles at zoom 12 (about 37 m per cell) into one grid. `/api/roads` returns the road network for the same box.
3. `buildField` runs once per area and cause. It stores, per cell, the water level at which the cell floods and the order in which water reaches it.
4. Moving the slider only changes numbers passed to the shader. Nothing is recomputed on the CPU for the water itself.
5. Road status is recomputed at most every 420 ms. Routes are recomputed 240 ms after the level stops moving.
6. A trip is a set of keyframed camera tracks evaluated per frame; the vehicle is an HTML marker holding a small three.js canvas.

### ⚠️ Rendering rule you must keep

With 3D terrain on, MapLibre bakes background, fill, line, raster and hillshade layers into one texture per terrain tile and reuses it between frames. It can only do that while all such layers are adjacent in the layer order. If any other layer type (custom, symbol, fill-extrusion) sits between two of them, every terrain tile is redrawn on every frame and the map stutters.

This is why:

- water and route lines are custom layers placed above all baked layers, not ordinary line or raster layers;
- `raiseOverlays` in `controller.ts` moves the base style's labels to the top on load.

If you add a layer, either keep it inside the baked group (before `fs-water`) or draw it in a custom layer above it. This was measured in a headless browser: 2 redraws per tile per frame when the group was split, 0 when it was not.

Related: create WebGL resources inside a custom layer's `render`, not `onAdd`. MapLibre resets its GL state tracking after `render` only.

## 🚀 6. Starting a similar project from scratch

```bash
npx create-next-app@latest my-flood-map --typescript --tailwind --app
cd my-flood-map
npm install maplibre-gl three @animate-ui/react motion radix-ui reicon-react @fontsource-variable/anuphan
npm install -D vitest @types/three @types/geojson
```

Suggested order:

1. Show a MapLibre map with the OpenFreeMap style and terrain from AWS Terrain Tiles.
2. Load elevation for the viewed area into a grid; write the flood model with tests.
3. Draw the water as a custom layer.
4. Fetch roads from Overpass through an API route; write the router.
5. Add place search with Nominatim through an API route.
6. Add the trip animation and vehicle models.
7. Polish the UI.

## 🚧 7. Known limits and open work

Model limits:

- River and sea modes use one flat water surface per area. No flow rate, river slope, drains or pumps.
- Rain mode assumes each basin collects from 6 times its own area with no infiltration. This is a rough estimate.
- Flash floods are listed in the UI but not modelled.
- Elevation is about 37 m per cell, so narrow levees and walls are invisible. In very flat cities such as Bangkok, elevation error can exceed the water level being tested.
- Bridges are always treated as dry; all other roads sit at ground level.
- Wading limits (0.2, 0.3, 0.5, 0.8 m) and the boat's minimum depth (0.4 m) are estimates.
- Routing only works inside the analysed box.

Not for real flood decisions. It is an exploration tool.

Not yet verified:

- Calls to the four live services. The development environment could not reach them, so end-to-end tests ran against stand-in data only.
- Frame rate on a real GPU. Tests used software rendering.
- Label reordering against the real OpenFreeMap style.

Ideas for whoever continues:

- Real-time data: river gauge levels, rainfall radar or satellite flood extents. Most sources require an access agreement.
- A hydrodynamic model, or at least river slope, in place of the flat surface.
- Higher-resolution elevation for flat urban areas.
- Depth testing for the custom layers, so water and lines are hidden behind ridges in mountainous areas.
- Tests for the map layers; only the simulation is unit-tested today.
