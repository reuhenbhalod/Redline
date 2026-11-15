# Marswalk web app: module interfaces

This is the contract between `app.js` (scaffold) and the four feature modules. Each module is written
by a different agent. Do not edit files you do not own, and do not change this contract on your own.
If you need a field that is missing, compute it locally inside your module.

Serve the repo root (`python3 -m http.server 8000` from the repo) and open `/web/index.html`.
Data comes from `../data/` by default. Override it with `?data=<path relative to /web/>`. More URL params:
`?mode=planner|tablet|rover` picks the view, `?stop=A` opens a stop preview, `?variant=skipA` picks the planned variant, and `?budget=demo` starts with the
DEMO budget (`?budget=<minutes>` sets any demo value). Demo deep links: `?t=<min>` seeks after load, `?fault=link,air,storm,hazard`
turns faults on from the start, `?slow=1` turns on slow pace, `?demo=1` opens the DEMO drawer.

**Real data (Nov 14).** `data/` now holds the pipeline's real files. New files are optional for `app.js`, so an old
fake folder still loads (`?data=<folder>`; the browser logs 404s for the missing new files, which is expected there).
There is no `env.json` any more: the environment comes from `env_data.json`, the budget from `safety_params.json`.

## File ownership

| File(s) | Owner | Notes |
| --- | --- | --- |
| `index.html`, `style.css`, `app.js`, `util.js`, `INTERFACES.md`, `README.md` | scaffold (frozen) | You may *import* from `util.js`. Never import `app.js`; use the `ctx` you are given. |
| `map.js`, `map.css` | map agent | Leaflet map inside `#map` |
| `panels.js`, `panels.css` | panels agent | Side panel inside `#side-panel` |
| `hud.js`, `hud.css` | HUD agent | Helmet HUD inside `#hud` |
| `sim.js`, `tests/sim.test.mjs` (+ `tests/index.js` imports) | sim agent | No DOM and no CSS. It is the **only writer of `state.sim`**. |
| `tablet.js`, `tablet.css` | tablet view | Astronaut tablet inside `#tablet` (mode `tablet`). Read-only; emits `replan:confirm`, `toast`. |
| `rover.js`, `rover.css` | rover view | Rover view inside `#rover` (mode `rover`). Read-only. |
| `minimap.js` | shared | SVG mini map on the basemap that follows a point (used by tablet and rover). |
| `planner.js`, `planner.css` | planner chrome | Layer rail, GO TO search, legend, route sheet and stop dossier (mockups). Writes `layersOn`, `roverPathOn`, `depotOn`, `selectedStopId`, `plannedVariantId` (idle only), `playing`; emits `map:focus`. The map's own layer control is hidden. `panels.js` still renders into `#side-panel`, which sits inside `#sheet-wrap`: its banners and replan card show above the sheet, its route/stop cards are replaced by the sheet, and safety/env/alerts/credits open under "Mission details". |
| `demo.js` | demo console | Extra wiring for `#demo-drawer` (play, speed buttons, crew switch `state.tabletCrew`, stop-preview shortcut, scrubber stop markers, jump to the scenario's view). |

**Redesign (Nov 14, `docs/ui-redesign.md`).** Three views: `planner`, `tablet`, `rover` (top-bar tabs, keys 1–3, Esc returns
to the planner). The helmet HUD view (`hud.js`, `hud.css`, `#hud`) was removed; the HUD rows below are historical. The sim controls and fault toggles moved into the **DEMO** drawer
(`#demo-drawer`, key `d`) with the same element ids. New tokens in `style.css`: `--signal` (teal accent),
`--signal-ink`, `--glass`, `--map-tint` (CSS filter for the basemap only), `--label-ls`, and the `.mlabel` class.

Shared CSS from `style.css` you may use: tokens `--basis-primary`, `--basis-secondary`, `--basis-assumption`,
`--demo`, `--demo-bg`, `--rover-path`, `--tube` (plus the older ones), the `.badge` / `.badge-demo` classes, and the
basis badge `<span class="basis" data-basis="primary|secondary|assumption|demo">PRIMARY</span>` (text from
`basisLabel(basis)` in util.js).

Rules for every module:
- Plain ES modules with no build step. The only global is `window.L` (Leaflet 1.9.4, loaded before `app.js`). Add no other CDNs.
- Only touch DOM inside your own container. Prefix your CSS classes (`map-`, `pn-`, `hud-`) and scope rules
  under `#map`, `#side-panel` or `#hud`. Use the color tokens from `style.css` (`var(--ok)`, `var(--route-active)` and so on).
- Treat state as immutable. Replace nested objects and never mutate them.
- Subscribers run on every `setState` (the sim writes about 60 times a second while playing). Check `changed`
  and do cheap updates, such as `marker.setLatLng`, instead of rebuilding.
- The modules must work while `state.sim === null`, which happens when the sim stub is loaded. In that case show the planned view
  from `ctx.data` and `ctx.config`.
- Label assumptions in the UI. Every number that comes from `ctx.config` (budget, reserve, speed, thresholds)
  is an assumption. `ctx.config.assumptions` is the list to show.
- Everything a module renders from data strings must go through `esc()` from util.js, or be set with `textContent`.

## Coordinates (the one rule)

- All positions are grid pixels `[x, y]` on the `width_px × height_px` grid, with **y pointing down**. Values may be fractional.
- Conversion to Leaflet uses **only** `pxToLatLng(px)` and `latLngToPx(ll)` from `util.js` (`L.CRS.Simple`,
  `lat = -(y + 0.5)`, `lng = x + 0.5`, which is the center of cell (x, y)). The basemap and layer overlays use
  `imageBounds(w, h)`, which returns `[[-h, 0], [0, w]]`. Never write your own conversion.
- 1 Leaflet map unit = 1 px = `ctx.config.pixelM` meters, so an `L.circle` radius in px is `meters / pixelM`.
- Bearings use `bearingDeg(a, b)`: 0 = map-up = "north", 90 = east (+x).
- HUD SVG mini-maps can use px directly, as in `viewBox="0 0 2000 2000"`, because y points down in SVG as well.

## util.js exports

`pxToLatLng`, `latLngToPx`, `imageBounds`, `pathToLatLngs`, `clamp`, `lerp`, `lerpPx`, `distPx`, `distM(a,b,pixelM)`,
`cumulativeDistM(path,pixelM)` → Float64Array, `pathLengthM(path,pixelM,i0,i1)`, `searchSorted(arr,v)`,
`interpolateOnPath(path,tMin,t)` → `{px,i,frac,atStart,atEnd,stationary}`, `interpolateArray(tMin,values,t)`,
`distanceAt(cumM,i,frac)`, `positionAtDistance(path,cumM,dM)` → `{px,i,frac}`, `nearestPathIndex(path,px)`,
`bearingDeg(a,b)`, `cardinal(deg)` → "NE", `fmtMin(min)` → "h:mm", `fmtMinLong(min)` → "1 h 15 min",
`fmtDistM(m)` → "340 m" / "4.98 km", `esc(str)`.

New for the real data:
- `pxToLonLat(px, geo)` → `[lon, lat]` or null, `lonLatToPx([lon, lat], geo)` → `[x, y]`, `fmtLonLat([lon, lat], digits=5)` →
  "18.45851° N, 77.40609° E". `geo` is `ctx.data.geo`. This is **linear interpolation between the bounds.json corners**
  (say "approx." or "linear" next to a readout). It reproduces `site.json` lon/lat to about 1e-6°. For the cursor, use
  `pxToLonLat(latLngToPx(e.latlng), data.geo)`.
- `effectiveBudget(state, config)` → `{ budgetMin, reserveMin, usableMin, demo, realBudgetMin, label, note }`. **Every module
  that shows or uses the suit budget calls this** instead of reading `config.budgetMin` (which is always the real budget).
  When `demo` is true, show `note` (= `DEMO_BUDGET_NOTE` = "DEMO SETTING, not the real suit budget") next to the number.
- `DEMO_BUDGET_NOTE`, `basisLabel(basis)` → "PRIMARY" | "SECONDARY" | "ASSUMPTION" | "DEMO".

## ctx (passed to every init)

```js
ctx = {
  data: {
    base,            // absolute URL of the data folder, ending in '/'
    url(name),       // absolute URL of a data file, e.g. data.url('basemap.png'), data.url(layer.file)
    bounds,          // bounds.json as is (real: crs, center_lonlat, corners_lonlat {nw,ne,se,sw}, no "fake")
    geo,             // { nw, ne, se, sw: [lon, lat], widthPx, heightPx, center: [lon, lat], crs, fake, method } | null
                     //   for pxToLonLat / lonLatToPx. Old fake corners [[nw],[se]] are expanded to all four.

    layers,          // ARRAY (adapted from layers.json {grid, context_map, layers:[...]}; an old plain array also works),
                     // sorted in display order:
                     // [{ id, file, label, legend: [{color, label}], source, native_res, time_frame, note,
                     //    group: 'terrain' | 'science' | 'other', trek_context }]
                     // real ids: slope, rough, rocky, sand, nogo (terrain); geology, minerals, ti (science)
    layerGroups,     // [{ id: 'terrain', label: 'Terrain', layerIds: [...] }, { id: 'science', label: 'Science', layerIds: [...] }]
                     //   (only groups/ids that exist in the data; an 'other' group is appended for unknown ids)
    layersMeta,      // { grid: {width_px, height_px, pixel_m} | null, contextMap: { source, layers: [string] } | null }

    stops,           // stops.json array (H base, A science, B depot). Real fields: id, name, kind, px, why, expect,
                     //   rock_unit, minerals (A), work_min (A, B), sol, photos [URL], tubes (B: a count, 10)
    stopsById,       // { H: stop, A: stop, B: stop }
    routes,          // routes.json (variants full/skipA with path, t_min, home_min, stop_plan, legs, replan[],
                     //   checkpoints[], hazard_demo, why, why_detail, fits_budget; params; time_home; assumptions; warnings; sources)
    variantsById,    // { full: variant, skipA: variant }

    site,            // site.json as is | null (habitat, stop_a {sol, stack_unit, clay_frac, depot_samples_cored_here, hirise_slope_p90_deg, ...},
                     //   stop_a_shortlist, depot_center, depot_samples_cored, criteria {stop_a, habitat}, status)
    depot: {
      center: { px, lon, lat, spreadM } | null,          // site.json depot_center (tubes spread ~35 m)
      tubes: [{                                          // depot.json, 10 entries, plus where each was cored (site.json)
        name, sampleId, dropSol, dropLmst, px, lon, lat,
        closeup, closeupDem, credit,                     // close-up ortho image URL (PDS), DEM image URL, credit line
        fromWaypoint: { sol, site, drive } | null,
        coredSol: number | null, coredLonLat: [lon, lat] | null,   // may lie outside the 4 km box
      }],
    },
    roverPath: null | {                                  // rover_path.json (Perseverance's real traverse in the box)
      source,                                            // "NASA/JPL-Caltech Mars 2020 MMGIS traverse and waypoints"
      segments: [{ sol, px: [[x, y], ...] }],            // 200 segments, one per sol, sols 14..753, ~11.7k points total
      waypoints: [{ sol, site, drive, px, elev_m }],
      solRange: [minSol, maxSol],
    },
    photosByStop: {                                      // photos.json, adapted. Always has every stop id.
      [stopId]: {
        note,                                            // e.g. H: "no rover images at this spot; images from rover positions within 400 m ..."
        radiusM, parkedSols: [sol],
        featured: [{ url, caption, credit }],            // show first (A: 1 mosaic, B: 2 mosaics + ..., H: none)
        candidates: [{ sol, camera, url, thumb, fullRes, dateUtc, credit, imageId }],   // thumbnail strip (13-24 per stop)
        fromStops: boolean,                              // true = no photos.json; featured came from stop.photos (no captions)
      },
    },
    env: {                                               // built from env_data.json (fallback env.json, else defaults)
      source: 'env_data' | 'env' | 'default', missing: boolean, fake: boolean,
      // legacy keys (same meaning as the old env.json; sim and hud read these today)
      dust: 'low' | 'moderate' | 'high' | 'unknown',     // word from dustTau.estimate via config.dustTauLevels (app thresholds)
      solar_alert: boolean,                              // = spaceWeather.solarAlert
      radiation_note: string,                            // one-line summary
      suit: {}, assumptions: [],                         // empty for real data (budget comes from safety_params)
      // new keys (null when not available)
      dustTau: { estimate, range: [lo, hi], isEstimate, method, source, timeFrame } | null,     // real: 0.34 (0.16-0.53)
      weather: { airTempC: {min, max}, groundTempC: {min, max}, pressurePa,
                 hourly: [{ hour, airTempC, groundTempC, pressurePa }],   // 24 entries, LTST hour
                 perSol: [...raw per_sol rows], wind: null, windNote, source, timeFrame } | null,
      radiation: { doseUGyPerDay, doseSiliconUGyPerDay, standIn, note, reference, source, timeFrame, perDay } | null,
                                                         // standIn true = Curiosity RAD at Gale, NOT Jezero: always say so
      spaceWeather: { solarAlert, cmeArrivals30d: [{ arrivalUtc, glancingBlow, minorImpact, cmeIds, link, simulation }],
                      upcoming: [], source, timeFrame, fetchedUtc, window: [from, to] } | null,   // NASA DONKI
    },
    safety: {                                            // safety_params.json
      params: { [key]: { value, unit, basis, source, note } },   // raw
      list: [{ key, value, unit, basis: 'primary' | 'secondary' | 'assumption', source, note }],   // 15 entries, file order
      assumptions: [string],                             // the file's own "assumptions" list (also merged into config.assumptions)
      marsG, missing: boolean,
    },
    provenance: null | { sources: [{ name, url, license, credit, processing }], literature: [string], aiUse: string },
    credits: [string],       // unique credit lines: photos (featured + candidates), tube close-ups, provenance sources
    tables: { units: { id: name }, minerals: { id: name }, arrays: { name: description }, limits: {...} },  // grids_readme.json
    timeHome,        // { width, height, stridePx, scaleMin, nodata, values: Uint16Array }  (real: 1000x1000, scale 1 min)
    fake,            // true if bounds.json, routes.json or env.json has "fake": true. Real data: false (badge hidden).
    raw: { bounds, layers, site, depot, photos, roverPath, envData, env, safety, provenance, gridsReadme },  // untouched files (debug)
  },
  config: {
    budgetMin, reserveMin,           // REAL suit budget and reserve: safety_params.json (480 / 30, both basis primary),
                                     //   else env.suit, else routes.params. Use effectiveBudget(state, config) for the one in force.
    budgetSource,                    // 'safety_params' | 'env' | 'routes' | 'default'
    demoBudgetMin: 240,              // the DEMO budget value offered by the top-bar select
    budgetOptions: [{ value: null, label: 'Real 480 min', demo: false }, { value: 240, label: 'Demo 240 min', demo: true }],
    pixelM, widthPx, heightPx,
    vFlatKmh, slopeSoftDeg, slopeHardDeg, weights,   // from safety_params.json when present (real: 2.0 km/h, 15°, 20°)
    dustTauLevels: [{ max: 0.6, word: 'low' }, { max: 1.0, word: 'moderate' }, { max: Infinity, word: 'high' }],
    slowPaceFactor: 0.8,             // walking speed multiplier when slowPace is on
    highAirBurnFactor: 1.6,          // air burn multiplier when faults.highAir is on
    turnaroundMarginMin: 10,         // turn-around alert when air.leftMin <= timeHome + reserve + this
    roverAheadM: 100, crewSpacingM: 4,
    posErrM: 1.5,                    // 1-sigma crew position error with the link up
    drGrowthMPerMin: 1.2,            // uncertainty growth while the link is lost
    drDriftMPerMin: 0.6,             // drift of the displayed dot while the link is lost
    assumptions: [{ text, source: 'routes' | 'safety' | 'env' | 'app', basis: 'primary' | 'secondary' | 'assumption' | 'demo',
                    bases?: [{ basis, keys: [safety_params key] }] }],  // routes.json lines: basis per key they mention (util.assumptionBasis)
                                     // routes.json + safety_params.json "assumptions" + app ones (budget line is 'primary';
                                     // demo budget and demo factors are 'demo')
    warnings: [string],              // routes.json warnings
    replanRule: string,              // routes.json replan_rule (show it in the Replan card or under Assumptions)
  },
  getState(), setState(patchOrFn), subscribe(fn) -> unsubscribe,  // fn(state, prev, changed:Set<string>)
  on(name, fn) -> unsubscribe, off(name, fn), emit(name, payload),
  timeHomeAt(x, y) | timeHomeAt([x, y]) -> minutes | null,       // from time_home.bin; null = unreachable/off-grid
  setMode('planner' | 'tablet' | 'rover'),
  toast({ level: 'info'|'ok'|'warn'|'danger', title, text, timeoutMs }),
  els: { map, sidePanel, tablet, rover, toasts },               // containers (HTMLElements)
  modules: {},                                                   // init return values (debug only)
}
```
`window.marswalk === ctx` exists for console debugging only, so modules must not use it.

## Init signatures

All are named exports. They may be sync or async, and their return value goes into `ctx.modules[name]`.
`app.js` calls them in this order: **initSim → initMap → initPanels → initTablet → initRover → initPlanner → initDemo**. Each call is wrapped in a try/catch,
and a failure shows a toast. Every module should render once from `getState()` inside init and then subscribe.

```js
export function initSim(ctx)    // sim.js   — must set a complete state.sim synchronously before returning
export function initMap(ctx)    // map.js   — may return { map }  (the L.Map)
export function initPanels(ctx) // panels.js
export function initHud(ctx)    // hud.js
```

## State shape

Top-level keys are shallow-merged by `setState`.

| Key | Type | Writers | Readers |
| --- | --- | --- | --- |
| `mode` | `'planner' \| 'tablet' \| 'rover'` | app.js (top bar, `h` key, Esc), any module via `ctx.setMode` | all. `app.js` toggles `body[data-mode]` and `#hud[hidden]`. map.js calls `invalidateSize()` when the mode returns to planner. hud.js renders only while in HUD mode. |
| `plannedVariantId` | `string` (`'full'`, `'skipA'`) | panels.js (variant picker), map.js (click on a variant polyline) | sim, map, panels, hud. **The sim applies it only while `sim.status === 'idle'`** (it rebuilds `sim.active` from it). Otherwise it ignores it until the next reset. The panels should disable the picker unless the sim is idle. |
| `selectedStopId` | `string \| null` | map.js (marker click), panels.js (stop list, close button) | panels (stop preview), map (highlight marker) |
| `layersOn` | `{ [layerId]: boolean }` (keys from layers.json, all false at start) | planner.js (layer rail); map.js | map, panels (optional) |
| `playing` | `boolean` | app.js (Play button, space key, Reset sets false). sim.js sets false on a pending replan, at done and at abort-done, and sets true after a confirm. | sim, top bar |
| `speed` | `number`, x real time (60, 120, **300**, 600, 1200) | app.js | sim. Sim minutes per real second = `speed / 60`. |
| `slowPace` | `boolean` | app.js | sim (and panels/hud for a "SLOW PACE" note) |
| `faults` | `{ linkLost: boolean, highAir: boolean, storm: boolean, hazard: boolean }` | app.js | sim (it reacts), others display them |
| `demoBudgetMin` | `number \| null` (null = real budget; `?budget=demo` starts at `config.demoBudgetMin`) | app.js (top-bar select `#sel-budget`, enabled only while `sim.status === 'idle'`). panels.js may add a mirror control in the Safety card that writes the same key, also only while idle. | everyone, always through `effectiveBudget(state, config)`. sim uses it for `air.budgetMin`, the replan rule and the turn-around check. Top bar shows a `DEMO BUDGET 240 MIN` badge while it is set (just `DEMO` at 1440 px and below; the dashed select still reads "Demo 240 min"). |
| `roverPathOn` | `boolean` (false at start) | planner.js (layer rail); map.js | map; others optional |
| `depotOn` | `boolean` (true at start) | map.js only (its layer control). Below zoom 1 the tubes show as one "10 tubes" badge (click zooms to the depot). | map; others optional |
| `sim` | `SimState \| null` | **sim.js only** | everyone |

### SimState (`state.sim`), written only by sim.js and always as a whole new object

```js
{
  t: number,                 // actual sim clock, minutes since leaving the habitat
  routeT: number,            // progress on the active route's own clock (sim-internal; behind = t - routeT)
  status: 'idle' | 'walking' | 'working' | 'awaiting_confirm' | 'returning' | 'done' | 'aborted',
  //  idle = t == 0, not started. working = standing at a stop doing work. returning = on a return-home /
  //  abort route. done = back at H after the plan. aborted = back at H after an abort.
  statusText: string,        // e.g. "Walking to Delta outcrop", "Working at Three Forks depot, 12 min left"
  paceFactor: number,        // 1 or config.slowPaceFactor (applies to walking only, not work time)

  active: {                  // the route the crew is following now
    id: string,              // 'full' | 'skipA' | 'full@A:skip_work' | 'return@93.2' ...
    kind: 'planned' | 'skip_work' | 'drop' | 'abort' | 'return',
    label: string,           // "Full plan H→A→B→H", "Skip work at Delta outcrop", "Abort: home from A"
    variantId: string,       // the routes.json variant it came from
    stops: string[],         // stop ids of this route, from where it started, e.g. ['A','B','H']
    path: [[x, y]],          // this route's path, from where it started (draw it highlighted)
    tMin: number[],          // parallel to path, on the routeT clock
    homeMin: number[],       // parallel to path
    stopMarks: [{ id, pathIndex, arriveMin, departMin }],  // routeT clock
    why: string[],           // why-lines for this route (variant.why or option.why)
    distanceM: number,
  },
  trail: [[x, y]],           // where the crew actually walked (true positions, appended about every 5 px)
  progress: { i, frac, distanceAlongM, remainingM },   // on active.path

  nextStop: null | {
    id, name, px,
    distanceM,               // along the active path
    straightM,               // straight line from EV1's displayed px
    bearingDeg,              // from EV1's displayed px to the stop (the HUD arrow)
    etaT,                    // projected actual arrival time (sim clock)
    plannedArriveT,          // planned arrival on the ACTIVE route's clock (stop_plan before a reroute, the rebased new route after); absent on a return/abort
  },
  headingDeg: number,        // direction of travel (bearing of the current segment)
  working: null | { stopId, leftMin },

  crew: [                    // always two entries. EV1 leads and EV2 is config.crewSpacingM behind along the path.
    { id: 'EV1', label: 'EV1', px: [x, y], truePx: [x, y], uncertaintyM: number },
    { id: 'EV2', label: 'EV2', px: [x, y], truePx: [x, y], uncertaintyM: number },
  ],
  // px = what the suit believes (draw this). truePx = ground truth (map may draw a faint ghost while the link is lost).
  rover: { px: [x, y], linkOk: boolean, aheadM: number },  // about roverAheadM ahead along active.path, clamped at the end

  air: {
    budgetMin, reserveMin,     // budgetMin = effectiveBudget(state, config).budgetMin (the DEMO value when set)
    budgetDemo: boolean,       // NEW: true while the demo budget is in force (views label it)
    usedMin,                 // integral of burnFactor dt
    leftMin,                 // budgetMin - usedMin
    burnFactor,              // 1 or config.highAirBurnFactor
    timeHomeMin,             // walk time home from EV1's displayed px: timeHomeAt() first, else active.homeMin interpolated
    timeHomeSource: 'grid' | 'route' | 'none',
    wayHomeMin, homeAirMin, neededMin, paceFactor,
                             // homeAirMin = max(timeHomeMin, wayHomeMin) * burnFactor / pace; neededMin = homeAirMin + reserveMin
    marginMin,               // leftMin - neededMin  (< 0 means past the turn-around point)
    level: 'ok' | 'warn' | 'danger',   // warn when marginMin < 2 * turnaroundMarginMin, danger when <= turnaroundMarginMin
    turnaround: boolean,     // true once the turn-around alert has fired
  },
  schedule: {
    behindMin,               // t - routeT (>= 0)
    plannedReturnT,          // planned variant est_min
    projectedReturnT,        // t + remaining active minutes (with pace and work)
  },
  env: {
    dust: string,            // data.env.dust ('low' | 'moderate' | 'high' | 'unknown')
    dustTau: number | null,  // NEW: data.env.dustTau.estimate
    solarAlert: boolean,     // data.env.solar_alert || faults.storm
    stormActive: boolean,    // faults.storm
    level: 'ok' | 'warn' | 'danger',
    text: string,            // "Dust low (τ 0.34) · no solar alert" / "STORM: walk aborted, heading home"
  },
  link: { ok: boolean, lostSinceT: number | null },  // mirrors !faults.linkLost; suit-only mode when !ok
  home: { px, bearingDeg, straightM, timeHomeMin, path: [[x, y]] }, // best known way home (show it in suit-only mode or during a storm)

  visited: string[],         // stop ids reached, in order (the starting H is not included)
  dropped: string[],         // stop ids dropped by a replan (map greys them out)
  replans: ReplanRecord[],   // one record per decision at a stop, including 'planned'
  pendingReplan: ReplanProposal | null,   // non-null means a reroute is waiting for the astronaut (sim is paused)
  hazard: { px, radiusPx, t, leg } | null, // rock field confirmed by the rover camera (map draws it)
  hazardArmed: boolean,                   // Rock field demo on and its trigger is still ahead
  checkpoints: [{ at, px }],              // upcoming mid-leg checkpoints on the active route (route clock). On real data this
                                          //   can include checkpoints of other variants on shared segments (9 on the full route, not 7)
  alerts: Alert[],           // oldest first, at most about 30
}
```

```js
Alert = {
  id: string, t: number,
  level: 'info' | 'ok' | 'warn' | 'danger',
  kind: 'replan' | 'link' | 'air' | 'storm' | 'arrive' | 'done' | 'info',
  title: string, text: string,
  active: boolean,           // e.g. the link-lost alert stays active until the link is restored
}
// HUD banner = the newest alert with active === true (or a pending replan).

ReplanProposal = {
  id: string,                      // unique, e.g. 'A@59.8'
  trigger: 'schedule' | 'air' | 'storm' | 'hazard',   // checkpoint proposals also set checkpoint: true, atStopId: null
  atStopId: string | null,         // null when proposed mid-leg (air / storm)
  atStopName: string,
  arrivedT: number,                // actual T (sim clock) when the rule was applied
  plannedArriveT: number | null,   // active route's planned arrival (same clock as behindMin = t - routeT)
  behindMin: number,
  kind: 'skip_work' | 'drop' | 'abort' | 'return',
  label: string,                   // "Skip the 45-min work at Delta outcrop"
  option: object,                  // the raw routes.json replan option (or a synthesized one with the same shape)
  minutes: number,                 // option.minutes
  savesMin: number,                // option.saves_min
  why: string[],                   // option.why
  path: [[x, y]],                  // the proposed path (map: dashed --route-proposed, HUD: highlight)
  safety: {
    projectedReturnT: number,      // arrivedT + minutes (pace-adjusted if the sim chooses)
    budgetMin, reserveMin,
    marginMin: number,             // budgetMin - reserveMin - projectedReturnT
    airLeftAtReturnMin: number,    // air.leftMin - minutes * burnFactor
    text: string,                  // "Back by 4:19 with 41 min of air to spare (30 min reserve kept)"; while the demo budget is on it
                                   //   ends "Against the 240 min demo budget (DEMO SETTING, not the real suit budget; real 480 min)"
  },
  rejected: [{ kind, label, projectedReturnT, overByMin }],  // options that failed the rule, in order
}

ReplanRecord = { id, t, atStopId, kind, label, confirmedT: number | null, trigger }
```

## Events (`ctx.emit` / `ctx.on`)

| Event | Payload | Emitted by | Handled by |
| --- | --- | --- | --- |
| `sim:reset` | none | app.js (Reset button, `r` key) | sim: rebuilds from `plannedVariantId`, `t = 0`, `status = 'idle'`, keeps the toggles |
| `sim:seek` | `{ t }` | app.js (scrubber) | sim: reset, then fast-forward in steps of 0.25 min or less with the current toggles until `t` is reached, stopping early at a pending replan. No toasts while seeking (emit alerts with `toast: false`). |
| `replan:confirm` | `{ id }` (the `pendingReplan.id`) | panels.js and hud.js (Confirm buttons; HUD also on the `Enter` key) | sim: switch `active` to the proposal, append to `dropped`, set `confirmedT`, clear `pendingReplan`, set `playing: true` |
| `replan:proposed` | `ReplanProposal` | sim | optional (for example, the HUD flashes) |
| `replan:applied` | `ReplanRecord` | sim | optional |
| `alert` | `Alert` (+ optional `toast: false`) | sim, whenever it pushes an alert | app.js shows a toast unless `toast === false` |
| `map:focus` | `{ px, zoom? }` | panels.js (clicking a stop), hud.js (optional) | map: `panTo(pxToLatLng(px))` |
| `toast` | `{ level, title, text, timeoutMs }` | anyone | app.js |
| `app:ready` | `ctx` | app.js after all inits | optional |

Keyboard (app.js): `h` toggles Planner/HUD, `Esc` leaves the HUD, `space` toggles play/pause, `r` resets.
The HUD may also add `Enter` to confirm a pending replan. No other module binds global keys.

## Module responsibilities

### sim.js (no DOM)
- **Clock.** A `requestAnimationFrame` loop runs while `state.playing`. The step is `dt = realSeconds * speed / 60` sim minutes, capped at 3 per
  frame and split into sub-steps of 0.25 min or less so that arrivals are never skipped. The sim writes `state.sim` once per frame.
  It does nothing while `pendingReplan` is set or the walk is done.
- **Motion.** `t += dt`. `routeT += dt * (segment is stationary ? 1 : paceFactor)`. The position is
  `interpolateOnPath(active.path, active.tMin, routeT)`, and work stops (repeated points) hold still. EV2 sits `crewSpacingM` behind,
  and the rover sits `roverAheadM` ahead along `active.path` (using `cumulativeDistM` + `positionAtDistance`).
- **Air.** `usedMin += dt * burnFactor` and `leftMin = budgetMin - usedMin`. `timeHomeMin` comes from `ctx.timeHomeAt(EV1.px)` (the
  suit's estimate, so it works for the drifted dot). If that returns null, use `interpolateArray(active.tMin, active.homeMin, routeT)`.
- **Replan rule** (`config.replanRule`). When `routeT` reaches a stopMark's `arriveMin` for an unvisited stop (not the start),
  clamp to it and add the stop to `visited`. Then find the replan entry for that stop: in any variant, the entry `r` with `r.at === stopId` whose
  `r.options[0].stops` equals the active route's remaining stops from that stop, or else the entry in `active.variantId` with that `at`.
  Take the first option where `T + option.minutes + reserve <= budget` **and** `option.minutes * burnFactor + reserve <= air.leftMin`.
  If none fits, take the abort option. If the result is `planned`, record it and continue (status `working` during the work).
  Otherwise set `pendingReplan`, set `status 'awaiting_confirm'` and `playing: false`, then emit `replan:proposed` and an `alert` of kind `replan`.
  On `replan:confirm`, build `active` from the option. The option's `t_min` is relative to arrival, so add the `routeT` at arrival, and
  derive the stopMarks by matching stop px against the path.
- **High air use.** When `air.leftMin <= homeAirMin + reserveMin + turnaroundMarginMin` and the crew is not already returning, set
  `air.turnaround = true`, raise a danger alert ("Turn around: air for the walk home is getting short"), and propose a `return`
  route (trigger `'air'`). If the crew is at a stop, use that stop's abort option. Mid-leg, pick the faster of (a) the active remainder
  with the remaining work removed and (b) backtracking along `trail` to the last visited stop and then that stop's abort option (or straight back to H).
  The `why` lines say which one was chosen and why.
- **Storm.** When `faults.storm` becomes true: `env.level = 'danger'`, a danger alert, and an immediate `return` proposal (trigger `'storm'`,
  `kind: 'abort'`) built the same way. Turning the storm off clears `env` back to normal but does not resume the plan.
  When the crew reaches H on a return route, the status is `aborted`.
- **Link lost.** While `faults.linkLost` is on: `link.ok = false`, `rover.linkOk = false`, an active danger alert of kind `link`
  ("Rover link lost: suit-only mode"), `uncertaintyM` growing by `drGrowthMPerMin`, and each crew `px` drifting away from `truePx` by
  `drDriftMPerMin` in a fixed pseudo-random direction (dead reckoning). When the link is restored, `px` snaps back to `truePx`,
  `uncertaintyM` returns to `posErrM`, the link alert goes inactive, and an ok alert reads "Rover link restored: position fixed".
- **Planner idle.** While idle, a change to `plannedVariantId` rebuilds `active`. Reset and seek are described under Events.

### map.js (`#map`, Leaflet)
- `L.map(ctx.els.map, { crs: L.CRS.Simple, minZoom: -3, maxZoom: 3, zoomSnap: 0.25, attributionControl: false })`,
  fitted to `imageBounds(widthPx, heightPx)`.
- Basemap: `L.imageOverlay(data.url('basemap.png'), imageBounds(w,h))`. Overlays: one `imageOverlay` per `data.layers[i]` (its
  `data.url(layer.file)`), shown when `layersOn[id]`. Layer toggles and legends are a custom Leaflet control (top-right) that
  writes `layersOn`. Each overlay is labeled with its legend, and threshold legends say "assumption".
- Stops: markers labeled H, A and B, colored by kind (`--stop-base`, `--stop-science`, `--stop-depot`). A click sets
  `selectedStopId`, and the selected stop is highlighted. Stops in `sim.dropped` are greyed out, and stops in `sim.visited` get a check mark.
- Routes: every variant is drawn faintly (`--route-alt`), and `plannedVariantId` is highlighted (`--route-planned`). A click on a polyline
  sets `plannedVariantId`, but only while the sim is idle. When `sim.active.kind !== 'planned'`, `sim.active.path` is drawn in
  `--route-active` (`--route-home` for abort and return). `sim.pendingReplan.path` is drawn dashed in `--route-proposed`. `sim.trail` is a thin breadcrumb.
- Crew: EV1 and EV2 are `circleMarker`s (`--crew-1`, `--crew-2`) at `crew[i].px`, each with an `L.circle` of radius
  `uncertaintyM / pixelM`. While the link is lost, a faint ghost appears at `truePx` (optional). The rover (`--rover`) is dimmed while the link is lost.
- Shows a small scale bar (m) and a "map up = north (assumption)" note. Pans on `map:focus`. Optional "follow crew" toggle.

### panels.js (`#side-panel`)
1. **Route.** A variant picker (enabled only while the sim is idle) with `distance_m`, `est_min`, `walk_min`/`work_min`, `max_slope_deg`,
   and a `fits_budget` badge, plus the why-lines of the active route (`sim.active.why`, or the planned variant's `why`).
2. **Stop preview** for `selectedStopId`: name and kind, photos (`<img>` with `onerror` swapping in a "photo unavailable" placeholder and a
   link), sol, why (science goal), expect, minerals, rock_unit, work_min, and the planned arrive/depart/home times from the planned variant's
   `stop_plan` (plus the actual arrival from `sim.replans`/`sim.visited` when known). It has a close button, and clicking it emits `map:focus`.
3. **Safety check.** An air budget bar showing air left vs. (time home + reserve), the time to walk home, the margin, dust and solar status
   (`sim.env`, or `data.env` when idle), the radiation note, warnings (`config.warnings`, variants with `fits_budget: false`, and
   `env.missing`), and the assumptions list (`config.assumptions`, plus `config.replanRule` under a disclosure). Before the sim starts,
   it uses the planned numbers: `est_min + reserve` vs. budget.
4. **Replan card**, shown when `sim.pendingReplan` is set: behind-schedule minutes, the chosen option label, its why-lines, minutes saved,
   why it is safe (`safety.text`), the rejected options, and a **Confirm reroute** button that emits `replan:confirm {id}`.
   The panel also shows a history of `sim.replans`.
5. **Alerts log** from `sim.alerts`.

### hud.js (`#hud`, full-screen SVG on a dark background, styled like a helmet or wrist display)
- Renders only while `state.mode === 'hud'` (and re-renders when the mode switches to HUD). Builds the SVG once and then updates attributes.
- Arrow toward `sim.nextStop.bearingDeg` (or `sim.home.bearingDeg` in suit-only mode or while returning), the next stop's name, the
  distance left, and the ETA. Large readouts for **air left** and **time to walk home** with `air.level` coloring and a margin bar.
- A mini-map or route strip: `active.path`, the `trail`, the stops, both crew dots with uncertainty rings, the rover dot, and the
  pending proposal path highlighted.
- An alerts banner (the newest active alert). In suit-only mode it says "ROVER LINK LOST · SUIT-ONLY" and shows the way home.
  A storm turns it red.
- A replan card when `pendingReplan` is set, with a big Confirm button (and the `Enter` key) that emits `replan:confirm`.
- Small assumption footnotes (budget and reserve from `effectiveBudget`) and a FAKE DATA tag when `data.fake` (top left,
  under the SLOW PACE tag; the top right holds the env chips).
- hud.js also exports the pure helper `hudEnvChips(simEnv, dataEnv, hourLtst)` → the temperature / dust / solar chips
  (works with the old `env.json` shape too: dust and solar only).

## Real-data tasks (Nov 14): what each module must now do

Everything above still holds; this section adds to it. Each agent edits only its own files (see File ownership).
The data shapes are under `ctx` above; look at the real values with `window.marswalk.data` in the console.
Labels: anything with `basis: "assumption"` is tagged ASSUMPTION, `secondary` is SECONDARY, `primary` is PRIMARY
(with its `source` on hover or in a disclosure), and anything demo-only (the Demo budget, Slow pace, High air use) is
tagged DEMO. Credit NASA where images or data are shown (use the `credit` strings). No NASA logos.

### The demo budget story (all modules)
The real budget is 480 min with a 30 min reserve (450 usable). The full plan takes ~186 min, so "Slow pace" alone can
never trigger a replan. The top bar has a **Demo budget** select (`Real 480 min` default / `Demo 240 min`) that writes
`state.demoBudgetMin`. Checked against the real `routes.json` with `slowPaceFactor` 0.8:
- Demo 240, on time: the plan fits; back at about T+3:06 with ~54 min of air left; no alert.
- Demo 240, slow pace: the first checkpoint (planned T+0:15, actual ~T+0:19, ~4 min behind) proposes
  **"Skip the 45-min work at Delta outcrop"** (the planned option misses by ~1 min). After Confirm the crew still works at
  the depot and gets home at about T+2:46 with ~74 min of air left (reserve kept).
- Real 480, slow pace: no replan (back with ~269 min left). Under 225 min on-time runs hit the turn-around alert at B,
  which is why the demo value is 240 (235 gives a wider slow-pace miss of ~6 min if the 1-min margin proves fragile).
Wherever a budget number is shown while `effectiveBudget(...).demo` is true, it must carry `DEMO_BUDGET_NOTE`
("DEMO SETTING, not the real suit budget") or a DEMO tag with that text on hover, and show the real value next to it.

### sim.js + tests (sim agent)
1. Budget: read `effectiveBudget(getState(), config)` instead of `config.budgetMin` everywhere (air, replan rule,
   turn-around, `safety` texts, seek clamp). While `status === 'idle'`, a change of `demoBudgetMin` rebuilds `sim.air`
   (and emits nothing else). After the walk starts, the select is disabled; if the key still changes, apply it from the
   next step (no reset). Set `air.budgetDemo` and mention "demo budget" in replan `safety.text` when it is in force.
2. Env: `sim.env.dust` from `data.env.dust`, add `sim.env.dustTau`, solar alert from `data.env.solar_alert` (DONKI). The
   text becomes e.g. "Dust low (τ 0.34) · no solar alert".
3. Everything else is unchanged. Do not read `env.json` or `data.env.suit`.
4. `tests/sim.test.mjs` must pass on the REAL data: never assume the old 300 min budget. Set the budget explicitly per
   scenario (pass `demoBudgetMin` in the test state, or the budget arguments to the pure functions): demo 240 for the
   slow-pace story (checkpoint proposes skip_work at A, then done with reserve kept), real 480 elsewhere (on-time and
   slow pace: no replan). Re-derive the hard-coded times (the old fake T+0:42 etc.) from `routes.json`. Add tests for
   any new pure logic, and a test for `effectiveBudget` / `pxToLonLat` (corner + `site.json` habitat round trip, 1e-5°).
   Several old tests currently fail on the real data (e.g. "expected checkpoints on the route", a test expecting
   `awaiting_confirm`): they assumed the 300 min fake budget.

### map.js + map.css (map agent)
1. **Overlays:** all 8 `data.layers`, grouped by `data.layerGroups` (headings "Terrain": slope, rough, rocky, sand, nogo;
   "Science": geology, minerals, ti). Each has a toggle, an opacity slider, and its legend (geology has 21 entries and
   minerals 20: make those legends scroll or collapse). Show `source`, `native_res`, `time_frame` and `note` on hover or
   in an info line under the open layer. Legend items or notes that mention "assumption" get the ASSUMPTION tag.
   Keep `layersOn` (keys = layer ids). Put the base imagery credit (`data.layersMeta.contextMap`, and the HiRISE
   orthomosaic credit from `data.provenance`) in a small attribution line.
2. **Depot tubes:** when `depotOn`, draw the 10 `data.depot.tubes` as small markers (`--tube`) around B; popup with
   name, sample ID, drop sol (and cored sol), lon/lat, and the close-up image (`<img>` with `loading="lazy"`, an
   `onerror` fallback to a link) with its credit. They overlap at low zoom: show them from zoom >= 0 or cluster into one
   "10 tubes" marker below that.
3. **Perseverance traverse:** toggle "Perseverance traverse (real)" writing `roverPathOn`; draw `data.roverPath.segments`
   as thin polylines (`--rover-path`) with tooltips "Sol N", and a few sol labels (e.g. every ~50 sols, plus the depot
   sols 648-692 and stop A's sols 455-534). Source line from `roverPath.source`. Skip silently if `roverPath` is null.
4. **Lon/lat readout:** on `mousemove` show `fmtLonLat(pxToLonLat(latLngToPx(e.latlng), data.geo))` plus the px and the
   time home (`ctx.timeHomeAt`), labelled "approx. (linear between corners)". Hide it when `data.geo` is null.
5. Keep routes, stops, crew, rover, checkpoints, rock field, proposed path, scale bar exactly as now. The layer control
   now holds more: keep it collapsible so it does not cover the route. (Done: it starts collapsed when the map is
   narrower than 1000 px, i.e. on 1280 px laptops.)

### panels.js + panels.css (panels agent)
1. **Stop preview** (`selectedStopId`): name, kind, rock unit, minerals, why, expect, sol, work time, planned/actual times
   as now. Photos from `data.photosByStop[id]`: featured images first (large, with caption and credit), then a
   thumbnail strip of `candidates` (thumb, "Sol N · CAMERA", click opens `url` in a new tab; credit under the strip).
   When `note` is set (H), show it above the strip ("no rover images at this spot; ..."). Keep the `onerror` fallback.
   For A, add facts from `data.site.stop_a` when present (cored sample "Bearwallow", clay fraction, slope p90).
   For B, a **depot tube list** from `data.depot.tubes` (name, sample ID, drop sol, close-up link with credit).
2. **Safety card:** the budget from `effectiveBudget(state, config)`: real "480 min suit budget, 30 min reserve (450
   usable)" with PRIMARY badges and their sources (`data.safety.params.suit_budget_min/reserve_min`). When demo: a
   clear DEMO block ("Demo 240 min: DEMO SETTING, not the real suit budget; real 480 min") and optionally a mirror
   select writing `demoBudgetMin` (disabled unless idle). The air bar uses the effective budget. Then a
   **Safety parameters** disclosure listing `data.safety.list` (value + unit, basis badge, source on hover/expand,
   note). Keep warnings, replan rule and `config.assumptions` (render each with its `basis` badge, not all as ASSUMPTION).
   Show `apollo_time_in_suit_min` (300, historical reference) next to the budget if you like.
3. **Environment card** from `data.env` (fall back to the old one-liners when `source !== 'env_data'`):
   dust τ estimate and range (tag "estimate", method on hover), air and ground temperature min/max (°C), pressure (Pa),
   wind note ("not available: MEDA wind sensor damaged in 2022"), radiation dose with a **"Curiosity stand-in"** tag and
   its note, solar alert status, and the recent Mars CME arrivals (DONKI, last 30 days: date, glancing/minor impact,
   link). Each block shows its `timeFrame` and `source` in small text. An optional tiny hourly temperature sparkline.
4. **Data and credits** section (collapsed by default) from `data.provenance.sources` (name linked to url, license,
   credit), `literature`, `aiUse`, and `data.credits` (photo credits).
5. Remove the "env.json missing" warning for real data (`env.missing` is false); keep it for `source === 'default'`.

### hud.js + hud.css (HUD agent)
1. Budget: use `sim.air.budgetMin` / `effectiveBudget(state, config)`. While demo, show a small persistent
   "DEMO BUDGET 240" tag near the air readout (amber dashed, `--demo`), and the footnote reads
   "Budget 240 min: DEMO SETTING, not the real suit budget (real 480)". Otherwise "Budget 480 / reserve 30 min".
2. Env strip, glanceable: air temperature (now: pick the `weather.hourly` entry for a fixed local hour of 13:00 LTST,
   or show the min/max range), dust word + τ, solar alert (DONKI) — e.g. "-16°C · DUST LOW τ0.34 · NO SOLAR ALERT".
   Storm / solar alert turns it red as now. Radiation is not needed on the HUD.
3. Keep everything else. No FAKE tag for real data (it follows `data.fake`).
