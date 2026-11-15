# Marswalk Planner: web app

A static web app for planning and flying a two-person Mars EVA. It has a **Planner** mode (map, routes, stop previews,
safety check) and a **Helmet HUD** mode (the view an astronaut would see). A built-in sim walks the crew along the
route so the replan and fallback logic can be demonstrated.

> **`../data/` now holds the REAL data** from the pipeline (HiRISE terrain, Stack et al. geology, CRISM minerals,
> Perseverance photos and traverse, the Three Forks depot tubes, MEDA weather, DONKI space weather) and the Engine's
> routes. The app still loads an old fake folder through `?data=` and then shows a **FAKE DATA** badge
> (`"fake": true` in `bounds.json`, `routes.json` or `env.json`). See `INTERFACES.md` for the data shapes.

## Run it

No build step and no install. Leaflet 1.9.4 comes from unpkg.

```sh
cd <repo root>            # serve the repo root, not web/, because the data lives in ../data/
python3 -m http.server 8000
open http://localhost:8000/web/index.html
```

`data/` must hold the pipeline and Engine output (see "Data files" below). Photos, tube close-ups and the CME links
load from NASA servers (PDS, mars.nasa.gov, DONKI), so the photo strips need a network connection; everything else is local.

URL options:

| Param | Effect |
| --- | --- |
| `?data=<path>` | Load data from another folder, relative to `/web/` (default `../data/`) |
| `?mode=hud` | Start in HUD mode |
| `?variant=skipA` | Start with another route variant as the plan |
| `?budget=demo` | Start with the DEMO budget (240 min); `?budget=<minutes>` sets another demo value |

If a data file is missing or broken, a full-screen card names the file and shows how to serve the app.

Tests for the sim logic (no browser needed): `node --test web/tests` from the repo root. They read the real
`data/routes.json`, `data/safety_params.json`, `data/bounds.json` and `data/site.json`, and set the budget explicitly in every
scenario (real 480 min, or the demo 240 min).

## Data files used

| File | Written by | Used for |
| --- | --- | --- |
| `routes.json`, `time_home.bin` | Engine | Route variants, stop plans, replan options, checkpoints, rock-field detour; minutes home from every cell |
| `stops.json` | Engine | H / A / B: name, kind, work time, why / expect, rock unit, minerals, sol |
| `basemap.png`, `bounds.json` | Pipeline | HiRISE orthomosaic; corner lon/lat for the cursor readout (linear between corners) |
| `layers.json` + `layers/*.png` | Pipeline | 8 overlays: Terrain (slope, rough, rocky, sand, no-go), Science (geology, minerals, thermal inertia), with legends and sources |
| `site.json`, `depot.json` | Pipeline | Habitat and stop A facts; the 10 Three Forks depot tubes (sample ID, drop sol, close-up image, credit) |
| `photos.json` | Pipeline | Featured mosaics and rover image candidates near each stop |
| `rover_path.json` | Pipeline | Perseverance's real traverse in the box, per sol |
| `env_data.json` | Pipeline | MEDA weather, dust τ estimate, radiation (Curiosity RAD stand-in), DONKI space weather |
| `safety_params.json` | Pipeline | Suit budget 480 min, reserve 30 min, speeds, slope limits, each with its basis (primary / secondary / assumption) and source |
| `provenance.json`, `grids_readme.json` | Pipeline | Data and credits section; unit and mineral ID tables |

There is no `env.json` any more. An old fake folder (old shapes, with `env.json`) still loads through `?data=`: the
browser then logs 404s for the missing new files, which is expected there.

## Controls

### Top bar

| Control | Key | What it does |
| --- | --- | --- |
| Planner / HUD | `h` (Esc leaves the HUD) | Switch between the planner and the helmet HUD |
| Play / Pause | space | Run or pause the sim clock. It is disabled while a reroute is waiting for confirmation. |
| Speed (60× … 1200×) | | Sim minutes per real second = speed / 60. 300× runs about 5 sim minutes per second. |
| Reset | `r` | Back to T+0:00 at the habitat. The toggles stay as they are. |
| Scrubber | | Jump to a sim time. The sim replays from 0, re-applying each fault / pace toggle at the time it happened and re-confirming reroutes you already confirmed. It stops early at a reroute that was never confirmed. Scrubbing back drops anything recorded after the target and sets the toggles to what was in force then. |
| Clock and status chip | | Sim time since leaving the habitat, and idle / walking / working / awaiting confirm / returning / done / aborted |
| Budget (Real 480 min / Demo 240 min) | | The suit budget the sim uses. **Demo 240 min is a DEMO SETTING, not the real suit budget**: with the real 480 min (30 min reserve) the ~3 h plan always fits, so slow pace could never trigger a replan. A `DEMO BUDGET` badge shows while it is on. Change it only before Play (Reset first). |
| Slow pace | | The crew walks at 0.8× the planned speed and falls behind. The replan rule fires at the next mid-leg checkpoint or stop where the plan stops fitting |
| Cut rover link | | Fallback demo: suit-only mode with dead reckoning and a growing uncertainty circle. Turn it off to snap the dot back to the true position. |
| High air use | | Fallback demo: air burns at 1.6×. The turn-around alert fires when air left gets close to the air the walk home needs (walk home × 1.6) + reserve. |
| Storm | | Fallback demo: dust or solar storm. The status turns red and the walk is aborted with the shortest safe route home. |
| Rock field | | Demo: the rover camera confirms a rock field ahead on Delta outcrop → Three Forks. When the crew reaches the trigger point (about 100 m before it), the precomputed detour from `routes.json → hazard_demo` is proposed, the rock field is drawn on the map, and the route rejoins the plan at the depot. Turn it on before the crew passes the trigger. |

### Map (planner)

- **Layers** (top right, collapsible; it starts collapsed when the map is narrower than 1000 px): 8 overlays in two
  groups, **Terrain** (slope, rough ground, rocky and blocky ground, sand, no-go) and **Science** (rock and surface units,
  CRISM minerals, thermal inertia). Each has a toggle, an opacity slider, a legend (long legends fold away) and its source,
  resolution and time frame on hover and under the open layer. Thresholds are tagged ASSUMPTION or SECONDARY.
- **Real rover data** (same control): **Perseverance traverse (real)** draws the rover's actual drives with sol labels
  (A's sols 455–534 and the depot's 650–692 are highlighted). **Depot sample tubes (10)** (on by default) shows a
  "10 tubes" badge when zoomed out and the 10 tubes from zoom 1; click a tube for its sample ID, drop sol, where it was
  cored and the close-up image with its credit.
- **Cursor readout** (bottom right): lon/lat (approx., linear between the `bounds.json` corners), grid px and minutes home.
- **Credits line** (bottom right): basemap and context imagery credits.
- **Stops**: H = habitat (base), A = science stop, B = sample depot. Click one to preview it. Visited stops get a check
  mark, and dropped stops are greyed out and struck through.
- **Routes**: the planned variant is bold and the other variant is faint and dashed. Hover a route for its distance and
  time. Click a route to make it the plan (only before the walk starts). During the sim, the route being followed
  is split into a walked part (dim) and the remaining part (bright). It is orange after a replan and red for a return
  home. A proposed reroute is dashed blue.
- **Crew**: EV1 and EV2 with uncertainty circles, plus the rover dot about 100 m ahead. While the link is lost, a faint
  ghost shows the true position.
- **Fit / Follow crew** buttons (top left), and a scale bar in metres (1 px = 2 m, map up = north on the equirectangular grid).

### Side panel (planner)

1. **Fault banners**: storm, turn-around, link lost, high air use and slow pace.
2. **Replan card** (when a reroute is proposed): minutes behind, the chosen option, why, minutes saved, why it is safe,
   the options that did not fit, and **Confirm reroute**. Below it is a log of every decision.
3. **Route plan**: the variant picker (distance, time, walk and work time, max slope, fits-budget badge) and the
   why-lines of the active route.
4. **Stops**: a preview of the selected stop: featured mosaics (caption and credit), a strip of nearby rover images
   ("Sol N / camera", click to open full size; a link replaces any image that fails to load), science goal, what to
   expect, rock unit, minerals, work time (with its basis badge), sol, approximate lon/lat, and planned vs. actual times.
   A adds site facts (Bearwallow core, clay fraction, slope). B adds the **depot tube table** (click a tube to centre the map on it).
5. **Safety check**: the real budget (480 min suit budget, 30 min reserve, 450 usable, PRIMARY with sources), the
   **Demo budget** mirror select, an air budget bar, time to walk home (from `time_home.bin` at the crew's position),
   margin, burn rate, warnings, the **Safety parameters** list (value, basis badge, source) and the **assumptions** list,
   each with its own basis, plus the replan rule.
6. **Environment**: dust τ 0.34 (range 0.16–0.53, ESTIMATE), MEDA air and ground temperature with an hourly chart,
   pressure, the wind note (sensor damaged), radiation (CURIOSITY STAND-IN, Gale not Jezero), and DONKI space weather
   (solar alert, Mars CME arrivals in the last 30 days).
7. **Data and credits** (collapsed): every data source with licence and credit, literature, AI use, image credits.
8. **Alerts log**.

### HUD

A full-screen, dark visor-style SVG display with:

- A compass with a big arrow to the next stop. In suit-only mode, during a storm or on a return route, the arrow turns red and points home.
- The next stop, distance left along the route, straight-line distance and ETA vs. plan.
- **Air left** and **time to walk home** in large numbers, with a margin bar.
- A mini-map (click it to zoom to a 600 m local view).
- A route strip with planned stop times.
- Environment chips (top right): air temperature at 13:00 LTST (MEDA), dust word + τ, solar alert (DONKI).
- A `DEMO BUDGET 240` tag under the air bar and an amber footnote while the demo budget is on.
- An alerts banner.
- The replan card with a big **CONFIRM REROUTE** button. Enter also confirms.

The top bar stays visible, so the sim and fault toggles still work from the HUD.

## Demo script (real data)

This is the walkthrough the integration check runs (`pw-int/walk.mjs`). Times are from the real `data/routes.json`.

**Why there is a Demo budget.** The real suit budget is 480 min with a 30 min reserve (450 usable). The full plan
H→A→B→H takes 3:06, so on the real budget slow pace and high air use never trigger a replan (slow pace ends at T+3:31
with 269 min left). The **Demo 240 min** budget is a DEMO SETTING, not the real suit budget: it shrinks the budget so the
replan logic can be shown. Every place that shows it says so.

1. **Plan.** Open the planner. The HiRISE basemap, stops H, A and B, both route variants, and the 10-tube badge at B.
   The side panel shows the full plan (3.13 km, 3:06) fitting the real 480 min budget.
2. **Explore the data.** Open **Layers**, turn on Slope + No-go, then Rock and surface units or Minerals. Turn on the
   **Perseverance traverse**. Zoom into B to see the 10 tubes and click one for its close-up.
3. **Preview a stop.** Click **A** (Delta outcrop): Mastcam-Z mosaic, nearby rover images, science goal, Bearwallow core,
   planned arrival T+0:49. Click **B** for the tube table.
4. **Fall behind (demo budget).** Pick **Demo 240 min** in the top bar (a DEMO badge appears), turn on **Slow pace**,
   set 1200× and press **Play**. At the first mid-leg checkpoint (T+0:19, about 4 min behind) the sim pauses and proposes
   **"Skip the 45-min work at Delta outcrop"**: at 0.8× the full plan would miss the 240 min demo budget by about 1 min.
   The card says why it is safe ("Back by 2:46 ... 30 min reserve kept ... Against the 240 min demo budget (DEMO
   SETTING ...)"). Press **Confirm reroute**: the crew passes A, works at the depot and is home at T+2:46 with 74 min of
   air left (reserve kept). On time at 240 the plan fits (home T+3:06, 54 min left, no alert).
5. **Helmet view.** Press `h`. Arrow to the next stop, distance, air left vs. time home, the DEMO BUDGET tag, the
   environment chips (-26°C · DUST LOW τ0.34 · NO SOLAR ALERT) and the route strip.
6. **Fallbacks** (Reset first; these work at the real 480 min unless noted).
   - **Rock field.** Turn it on, Play. At T+1:36 the rover camera confirms a rock field on A→B and the precomputed
     detour (+2 min) is proposed. Confirm: home at T+3:08.
   - **Storm** (around T+0:30). Dust and solar turn red and "Storm: back to Habitat" is proposed. Confirm (Enter in the
     HUD): home at T+1:00, status **aborted**.
   - **Cut rover link** (around T+0:20). "ROVER LINK LOST · SUIT-ONLY": the dot drifts by dead reckoning, the uncertainty
     ring grows, the HUD arrow points home. Turn the link back on and the dot snaps back.
   - **High air use** needs the **Demo 240 min** budget (at 480 even a 1.6× burn fits). From the start: at T+0:15 the
     air check proposes "Drop Delta outcrop"; confirm and the crew is home at T+1:57 with 52 min left.

### The replan rule

When the crew arrives at a stop at actual time T, the sim takes the first precomputed option (planned → skip work →
drop the next stop → abort home) where **T + option minutes + reserve ≤ budget** and the air left covers it. If none
fits, it takes abort. Anything other than "planned" pauses the sim until the astronaut confirms.

The sim applies the rule to each option's minutes **at the crew's current pace** (walking stretched by 1/pace, work
unchanged), and the air check uses those minutes × the burn rate. With nominal pace this is exactly the routes.json
rule. When even the chosen option eats into the reserve, the card heading switches from "Why it is safe" to
"Best available: NOT within budget" and says whether air would run out.

## Files

| File | Role |
| --- | --- |
| `index.html`, `style.css` | Page shell, top bar, layout, colour tokens |
| `app.js` | Loads data, state store and event bus, top bar, keyboard, mode switch, toasts |
| `util.js` | The single pixel ↔ Leaflet coordinate helper (`pxToLatLng` / `latLngToPx` / `imageBounds`), path maths and formatting |
| `sim.js` | Sim clock, motion, air, replan rule, fault reactions. It has no DOM and is the only writer of `state.sim`. |
| `map.js` / `map.css` | Leaflet map |
| `panels.js` / `panels.css` | Side panel |
| `hud.js` / `hud.css` | Helmet HUD |
| `INTERFACES.md` | The contract between the modules (state shape, events, coordinates, data shapes) |
| `tests/` | `node --test` unit tests for the sim |
