# Marswalk web app: module interfaces

This is the contract between `app.js` (scaffold) and the four feature modules. Each module is written
by a different agent. Do not edit files you do not own, and do not change this contract on your own.
If you need a field that is missing, compute it locally inside your module.

Serve the repo root (`python3 -m http.server 8000` from the repo) and open `/web/index.html`.
Data comes from `../data/` by default. Override it with `?data=<path relative to /web/>`. More URL params:
`?mode=hud` starts in HUD mode, and `?variant=skipA` picks the planned variant.

## File ownership

| File(s) | Owner | Notes |
| --- | --- | --- |
| `index.html`, `style.css`, `app.js`, `util.js`, `INTERFACES.md` | scaffold (frozen) | You may *import* from `util.js`. Never import `app.js`; use the `ctx` you are given. |
| `map.js`, `map.css` | map agent | Leaflet map inside `#map` |
| `panels.js`, `panels.css` | panels agent | Side panel inside `#side-panel` |
| `hud.js`, `hud.css` | HUD agent | Helmet HUD inside `#hud` |
| `sim.js` | sim agent | No DOM and no CSS. It is the **only writer of `state.sim`**. |

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

## ctx (passed to every init)

```js
ctx = {
  data: {
    base,            // absolute URL of the data folder, ending in '/'
    url(name),       // absolute URL of a data file, e.g. data.url('basemap.png'), data.url(layer.file)
    bounds,          // bounds.json
    layers,          // layers.json: [{ id, file, label, legend: [{color, label}] }]
    stops,           // stops.json array (H base, A science, B depot ...)
    stopsById,       // { H: stop, A: stop, B: stop }
    routes,          // routes.json (variants, replan_rule, params, assumptions, warnings, time_home ...)
    variantsById,    // { full: variant, skipA: variant }
    env,             // env.json (or a default with env.missing = true)
    timeHome,        // { width, height, stridePx, scaleMin, nodata, values: Uint16Array }
    fake,            // true if bounds.json or routes.json has "fake": true (the top bar shows a FAKE DATA badge)
  },
  config: {
    budgetMin, reserveMin,           // env.suit overrides routes.params (300 / 30 in the fake data)
    pixelM, widthPx, heightPx,
    vFlatKmh, slopeSoftDeg, slopeHardDeg, weights,
    slowPaceFactor: 0.8,             // walking speed multiplier when slowPace is on
    highAirBurnFactor: 1.6,          // air burn multiplier when faults.highAir is on
    turnaroundMarginMin: 10,         // turn-around alert when air.leftMin <= timeHome + reserve + this
    roverAheadM: 100, crewSpacingM: 4,
    posErrM: 1.5,                    // 1-sigma crew position error with the link up
    drGrowthMPerMin: 1.2,            // uncertainty growth while the link is lost
    drDriftMPerMin: 0.6,             // drift of the displayed dot while the link is lost
    assumptions: [{ text, source: 'routes' | 'env' | 'app' }],
    warnings: [string],              // routes.json warnings
    replanRule: string,              // routes.json replan_rule (show it in the Replan card or under Assumptions)
  },
  getState(), setState(patchOrFn), subscribe(fn) -> unsubscribe,  // fn(state, prev, changed:Set<string>)
  on(name, fn) -> unsubscribe, off(name, fn), emit(name, payload),
  timeHomeAt(x, y) | timeHomeAt([x, y]) -> minutes | null,       // from time_home.bin; null = unreachable/off-grid
  setMode('planner' | 'hud'),
  toast({ level: 'info'|'ok'|'warn'|'danger', title, text, timeoutMs }),
  els: { map, sidePanel, hud, toasts },                          // containers (HTMLElements)
  modules: {},                                                   // init return values (debug only)
}
```
`window.marswalk === ctx` exists for console debugging only, so modules must not use it.

## Init signatures

All are named exports. They may be sync or async, and their return value goes into `ctx.modules[name]`.
`app.js` calls them in this order: **initSim → initMap → initPanels → initHud**. Each call is wrapped in a try/catch,
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
| `mode` | `'planner' \| 'hud'` | app.js (top bar, `h` key, Esc), any module via `ctx.setMode` | all. `app.js` toggles `body[data-mode]` and `#hud[hidden]`. map.js calls `invalidateSize()` when the mode returns to planner. hud.js renders only while in HUD mode. |
| `plannedVariantId` | `string` (`'full'`, `'skipA'`) | panels.js (variant picker), map.js (click on a variant polyline) | sim, map, panels, hud. **The sim applies it only while `sim.status === 'idle'`** (it rebuilds `sim.active` from it). Otherwise it ignores it until the next reset. The panels should disable the picker unless the sim is idle. |
| `selectedStopId` | `string \| null` | map.js (marker click), panels.js (stop list, close button) | panels (stop preview), map (highlight marker) |
| `layersOn` | `{ [layerId]: boolean }` (keys from layers.json, all false at start) | map.js only | map, panels (optional) |
| `playing` | `boolean` | app.js (Play button, space key, Reset sets false). sim.js sets false on a pending replan, at done and at abort-done, and sets true after a confirm. | sim, top bar |
| `speed` | `number`, x real time (60, 120, **300**, 600, 1200) | app.js | sim. Sim minutes per real second = `speed / 60`. |
| `slowPace` | `boolean` | app.js | sim (and panels/hud for a "SLOW PACE" note) |
| `faults` | `{ linkLost: boolean, highAir: boolean, storm: boolean }` | app.js | sim (it reacts), others display them |
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
    plannedArriveT,          // from the planned variant's stop_plan (absent for H at the end of an abort, for example)
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
    budgetMin, reserveMin,
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
    dust: string,            // env.json dust ('low' | 'moderate' | 'high' | ...)
    solarAlert: boolean,     // env.json solar_alert || faults.storm
    stormActive: boolean,    // faults.storm
    level: 'ok' | 'warn' | 'danger',
    text: string,            // "Dust low · no solar alert" / "STORM: walk aborted, heading home"
  },
  link: { ok: boolean, lostSinceT: number | null },  // mirrors !faults.linkLost; suit-only mode when !ok
  home: { px, bearingDeg, straightM, timeHomeMin, path: [[x, y]] }, // best known way home (show it in suit-only mode or during a storm)

  visited: string[],         // stop ids reached, in order (the starting H is not included)
  dropped: string[],         // stop ids dropped by a replan (map greys them out)
  replans: ReplanRecord[],   // one record per decision at a stop, including 'planned'
  pendingReplan: ReplanProposal | null,   // non-null means a reroute is waiting for the astronaut (sim is paused)
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
  trigger: 'schedule' | 'air' | 'storm',
  atStopId: string | null,         // null when proposed mid-leg (air / storm)
  atStopName: string,
  arrivedT: number,                // actual T (sim clock) when the rule was applied
  plannedArriveT: number | null,   // from the planned variant's stop_plan
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
    text: string,                  // "Back by 4:19 with 41 min of air to spare (30 min reserve kept)"
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
- Small assumption footnotes (budget and reserve from `config`) and a FAKE DATA tag when `data.fake`.
