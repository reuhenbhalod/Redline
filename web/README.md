# Redline: web app

A static web app for planning and flying a two-person Mars EVA at Jezero crater. It has two views, switched with the top-bar tabs or the keys `1` and `2` (`Esc` returns to the planner):

| View | What it is |
| --- | --- |
| **Planner** | Mission control: the HiRISE map with a layer rail, a GO TO search, the route sheet with a mission brief and safety strip, stop dossiers, and "Mission details" (safety, environment, credits). |
| **Astronaut tablet** | What the crew carries: next stop, air left vs. time home, route strip, a "what you'll see" photo, rover scouting status, a live mini map, and four glove-sized buttons. It also has a reroute side card and link-lost and storm modes. |

The helmet HUD, the rover view and the DEMO console were removed on Nov 14.

## The demo walk

Press **Play**. The default speed is 600× (10 sim minutes per real second), so the ~3-hour walk takes about 3 minutes. `events.js` scripts the situations below on top of the sim's own logic, and each one fires once per walk:

| Sim time | What happens | Where it comes from |
| --- | --- | --- |
| ~T+0:06 | O2 use climbs on the ascent (silently turns on `faults.highAir`) | events.js |
| ~T+0:14 | **Pop-up: high O2 use, simulated suit telemetry.** After Understood, the crew walks at 0.8× pace. | events.js; numbers from `sim.air` and `config` |
| ~T+0:35 | Pace back to normal | events.js |
| Arrival at A | **Pop-up: solar storm forecast.** Writes `state.stormForecast` and shows the top-bar storm chip and the tablet banner "be inside by T+h:mm". It is modeled on the strongest recent DONKI CME arrival at Mars (`pickModelCme`); the timing is simulated. | events.js + sim.js |
| At A | Toast: dust devil sighted | events.js |
| A→B, ~T+1:36 | **The rover camera confirms a rock field.** A detour is proposed (live A* on `walk_time.bin`) and the walk pauses until someone presses **Accept new route**. The old route stays in red. | sim.js + pathfind.js |
| Leave B / home leg | Toasts: tubes loaded, storm check | events.js |
| Throughout | "Science along the way" toasts (5 on the full route) where the mapped unit or CRISM mineral changes | science.js + `route_science.json` |
| ~T+3:13 | Home, about 10 min before the storm deadline | |

The top bar has only Play / Pause, Restart (↺, key `r`) and the clock with a status chip. Playing again after the walk ends starts it over. You can still reach other faults through the URL for testing.

## Run it

There is no build step and no install. Leaflet 1.9.4 comes from unpkg.

```sh
cd <repo root>            # serve the repo root, not web/: the data lives in ../data/
python3 -m http.server 8000
open http://localhost:8000/web/index.html
```

Photos, tube close-ups and CME links load from NASA servers (PDS, mars.nasa.gov, DONKI). Everything else is local.

| Param | Effect |
| --- | --- |
| `?mode=planner\|tablet` | Start in that view |
| `?t=<min>` | Seek the sim to that time after load (it stops early at an unconfirmed reroute, e.g. `?t=97` stops at the rock field at T+1:36) |
| `?events=0` | Turn off the scripted walk events (no pop-ups; clean screenshots) |
| `?fault=link,air,storm` | Turn faults on from the start. The rock field is on by default; `?fault=nohazard` turns it off |
| `?slow=1` | Slow pace (0.8×) from the start |
| `?stop=A` | Open the stop dossier for A (or B, H) |
| `?variant=skipA` | Start with the backup route (H→B→H) as the plan |
| `?data=<path>` | Load data from another folder, relative to `/web/` (default `../data/`). An old fake folder shows a FAKE DATA badge. |

Useful links: `?mode=tablet&t=40&events=0` (mid-walk), `?mode=tablet&t=97&events=0` (rock-field reroute), `?mode=tablet&fault=link&t=30&events=0` (link lost), `?mode=planner&stop=A` (dossier). Without `events=0`, a seek past T+0:14 opens the O2 pop-up on arrival.

If a required data file is missing or broken, a full-screen card names the file and shows how to serve the app.

Tests: run `node --test web/tests` from the repo root. They cover the sim's pure logic on the real `data/` files.

## Deploying (GitHub Pages)

Pages serves `main` from the repo root, and the root `index.html` redirects to `web/` (keeping the query string). Browsers may cache each file for 10 minutes. If a new `index.html` is mixed with an old cached module, the app won't start. **Before pushing any change under `web/`, run** `python3 tools/stamp_version.py`. It puts a fresh `?v=` on every stylesheet, on `app.js` and, through an import map, on every module import.

## Data files used

| File | Written by | Used for |
| --- | --- | --- |
| `routes.json`, `time_home.bin` | Engine (`07_routes.py`) | Route variants, stop plans, replan options, checkpoints, rock-field `hazard_demo`; minutes home from every cell |
| `stops.json` | Engine | H / A / B: name, kind, work time, why / expect, rock unit, minerals, sol, photos |
| `walk_grid.json` + `walk_time.bin` | `08_walk_grid.py` | Walking-time grid (1000 × 1000 cells of 4 m, uint8 deciseconds per axis step, 255 = no-go) for live detours. Optional: without it, the sim uses the precomputed rock-field detour. |
| `route_science.json` | `09_route_science.py` | Science prompts along each variant (5 on `full`, 4 on `skipA`). Optional: without it, science.js stays off. |
| `basemap.png`, `bounds.json` | Pipeline | HiRISE orthomosaic; corner lon/lat for the cursor readout (linear between corners) |
| `layers.json` + `layers/*.png` | Pipeline | 8 overlays (slope, rough, rocky, sand, no-go; geology, minerals, thermal inertia), each with a legend and source |
| `site.json`, `depot.json` | Pipeline | Habitat and stop A facts; the 10 Three Forks tubes (sample ID, drop sol, close-up, credit) |
| `photos.json` | Pipeline | Featured mosaics and rover image candidates near each stop (dossier, tablet "what you'll see") |
| `rover_path.json` | Pipeline | Perseverance's real traverse in the box, per sol |
| `env_data.json` | Pipeline | MEDA weather, dust τ estimate, radiation (Curiosity RAD stand-in), DONKI CME arrivals |
| `safety_params.json` | Pipeline | Suit budget 480 min, reserve 30 min, speeds, slope limits, work times, each with a basis (primary / secondary / assumption) and a source |
| `provenance.json`, `grids_readme.json` | Pipeline | Data and credits section; unit and mineral ID tables |

## Controls

### Top bar

| Control | Key | What it does |
| --- | --- | --- |
| Planner / Astronaut tablet | `1` / `2`, `Esc` | Switch views |
| Play / Pause | space | Run or pause the sim. It is disabled while a reroute waits for confirmation. It reads "Replay" after the walk. |
| Restart (↺) | `r` | Back to T+0:00 at the habitat. Clears the scripted events, the storm forecast and the science log. |
| Storm chip | | Shown after the storm forecast: time left to be inside (simulated) |
| Clock and status chip | | Sim time since leaving the habitat, and idle / walking / working / awaiting confirm / returning / done / aborted |

### Planner

- **Layer rail** (left): Slope, No-go, Sand, Rock, Rough, Mineral, Geology, Thermal, Rover path (Perseverance's real traverse) and Tubes (the 10 depot tubes). Each layer that is on shows its legend and source. Thresholds are tagged ASSUMPTION or SECONDARY.
- **GO TO**: jump to a stop or a sample tube.
- **Map**: stops H / A / B (click for the dossier), the planned route (bold) and the backup, crew EV1 / EV2 with uncertainty rings, and the rover about 100 m ahead. During the walk, the walked part is dim. A proposed reroute is dashed. The confirmed rock field is a red circle, and abandoned route pieces stay red. The map also shows crew-marked hazards and science-prompt hexagons (dimmed once fired). The cursor readout shows approximate lon/lat (linear between corners), grid px and minutes home.
- **Route sheet** (right): plan title, a mission brief while idle (SCIENCE / RETRIEVE lines from the data, plus a "Why here ▸" toggle), totals (time, km, % of suit time), a stop list with VIEW links, why-lines (cuts / avoids), the backup variant, **START EVA**, and a safety strip. The strip shows suit / plan / reserve, a storm chip (`STORM T+h:mm` from `sim.env.stormForecast`) and the EVA radiation dose. During the walk, the replan card (**Confirm reroute**) and the replan log sit above the sheet.
- **Stop dossier**: Perseverance images with credits, why / what to expect, rock unit, CRISM minerals, km from H, arrival / work / time home, **Show on map** and **Skip stop**. B adds the depot tube table.
- **Mission details** (collapsed): safety parameters with basis badges and sources, environment (dust τ ESTIMATE, MEDA temperatures, radiation CURIOSITY STAND-IN, DONKI CME arrivals), alerts log, and data and credits.

### Astronaut tablet

- Left column: next stop (arrow, distance, arrival vs. plan) or "working at…", **air left / time home** with a margin bar and the simulated EVA dose, a route strip, **What you'll see** (one real Perseverance frame for the next stop, tap to enlarge), and rover scouting status.
- Banners: link lost, storm, hazard, air, or "Solar storm · be inside by T+h:mm (in h:mm)".
- Buttons: **Mark hazard** (emits `hazard:mark`; routes keep 40 m clear of it), **Take photo** (pins a camera marker on the mini map), **Pause / Resume walk**, **Way home**. In link-lost mode the buttons are **Start walking home**, **Wait for link** and **I see a landmark**.
- Reroute card (side panel): what was found, the suggested route, **Accept new route**, and why it is safe.

### The replan rule

When the crew reaches a stop or mid-leg checkpoint at actual time T, the sim takes the first precomputed option (planned → skip work → drop the next stop → abort home) for which **T + option minutes + reserve ≤ budget** and air left covers it. Option minutes are counted at the crew's current pace. If no option fits, it takes abort. Anything other than "planned" pauses the sim until someone confirms. Hazards (the rover-confirmed rock field, or a hazard the crew marks on the route ahead) propose a live detour. `pathfind.js` computes it with A* on `walk_time.bin` around a keep-out circle and rejoins the route. If the grid is missing, the sim falls back to the precomputed `hazard_demo` detour.

## Files

| File | Role |
| --- | --- |
| `index.html`, `style.css` | Page shell, top bar, event pop-up, toasts, colour tokens |
| `app.js` | Loads data, state store and event bus, top bar, keyboard, mode switch, toasts, boot order |
| `util.js` | The single pixel ↔ Leaflet coordinate helper, path maths, formatting, `effectiveBudget` |
| `sim.js` | Sim clock, motion, air, replan rule, faults, hazards and detours, radiation dose. No DOM; the only writer of `state.sim`. |
| `pathfind.js` | A* detours on the walking-time grid (`parseWalkGrid`, `findDetour`, `pathSeconds`) |
| `smooth.js` | Display-only smoothing of moving markers (`createSmoother`); never changes sim state |
| `events.js` | Scripted walk events (O2 pop-up, storm forecast, toasts); writes `stormForecast` |
| `science.js` | "Science along the way" prompts and planner-map hexagons; writes `scienceLog` |
| `map.js` / `map.css` | Leaflet map |
| `planner.js` / `planner.css` | Planner chrome: layer rail, GO TO, legend, route sheet, mission brief, stop dossier, safety strip |
| `panels.js` / `panels.css` | Side panel inside the sheet: banners, replan card and log, safety, environment, alerts, credits |
| `tablet.js` / `tablet.css` | Astronaut tablet |
| `minimap.js` | SVG mini map used by the tablet |
| `INTERFACES.md` | The contract between modules (state shape, events, coordinates, data shapes) |
| `tests/` | `node --test` unit tests for the sim |
