# Marswalk Planner: web app

A static web app for planning and flying a two-person Mars EVA. It has a **Planner** mode (map, routes, stop previews,
safety check) and a **Helmet HUD** mode (the view an astronaut would see). A built-in sim walks the crew along the
route so the replan and fallback logic can be demonstrated.

> **The data in `../data/` is FAKE until the pipeline runs.** It has the same shape as the real contract
> (see "Data contracts" in the architecture doc), but the terrain, stops, photos and times are made up. The app shows a
> **FAKE DATA** badge whenever `bounds.json` or `routes.json` has `"fake": true`. When the pipeline writes real data
> into `data/`, the app picks it up with no code changes.

## Run it

No build step and no install. Leaflet 1.9.4 comes from unpkg.

```sh
cd <repo root>            # serve the repo root, not web/, because the data lives in ../data/
python3 pipeline/fake_export.py   # only if data/ is empty: writes FAKE contract files
python3 -m http.server 8000
open http://localhost:8000/web/index.html
```

URL options:

| Param | Effect |
| --- | --- |
| `?data=<path>` | Load data from another folder, relative to `/web/` (default `../data/`) |
| `?mode=hud` | Start in HUD mode |
| `?variant=skipA` | Start with another route variant as the plan |

If a data file is missing or broken, a full-screen card names the file and shows how to serve the app.

Tests for the sim logic (no browser needed): `node --test web/tests` from the repo root. They read `data/routes.json`, so
run `pipeline/fake_export.py` (or the real pipeline) first.

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
| Slow pace | | The crew walks at 0.8× the planned speed and falls behind. The replan rule fires at the next mid-leg checkpoint or stop where the plan stops fitting |
| Cut rover link | | Fallback demo: suit-only mode with dead reckoning and a growing uncertainty circle. Turn it off to snap the dot back to the true position. |
| High air use | | Fallback demo: air burns at 1.6×. The turn-around alert fires when air left gets close to the air the walk home needs (walk home × 1.6) + reserve. |
| Storm | | Fallback demo: dust or solar storm. The status turns red and the walk is aborted with the shortest safe route home. |
| Rock field | | Demo: the rover camera confirms a rock field ahead on Delta outcrop → Three Forks. When the crew reaches the trigger point (about 100 m before it), the precomputed detour from `routes.json → hazard_demo` is proposed, the rock field is drawn on the map, and the route rejoins the plan at the depot. Turn it on before the crew passes the trigger. |

### Map (planner)

- **Layers** (top right): toggle slope, soft sand and minerals overlays. Each has a legend and an opacity slider.
  Legend items that are thresholds are tagged *assumption*.
- **Stops**: H = habitat (base), A = science stop, B = sample depot. Click one to preview it. Visited stops get a check
  mark, and dropped stops are greyed out and struck through.
- **Routes**: the planned variant is bold and the other variant is faint and dashed. Hover a route for its distance and
  time. Click a route to make it the plan (only before the walk starts). During the sim, the route being followed
  is split into a walked part (dim) and the remaining part (bright). It is orange after a replan and red for a return
  home. A proposed reroute is dashed blue.
- **Crew**: EV1 and EV2 with uncertainty circles, plus the rover dot about 100 m ahead. While the link is lost, a faint
  ghost shows the true position.
- **Fit / Follow crew** buttons (top left), and a scale bar in metres (1 px = 2 m, map up = north, an assumption).

### Side panel (planner)

1. **Fault banners**: storm, turn-around, link lost, high air use and slow pace.
2. **Replan card** (when a reroute is proposed): minutes behind, the chosen option, why, minutes saved, why it is safe,
   the options that did not fit, and **Confirm reroute**. Below it is a log of every decision.
3. **Route plan**: the variant picker (distance, time, walk and work time, max slope, fits-budget badge) and the
   why-lines of the active route.
4. **Stops**: a preview of the selected stop with photos (a placeholder appears if a photo fails to load), science goal,
   what to expect, sol, minerals, rock unit, work time, and planned vs. actual arrival.
5. **Safety check**: an air budget bar (air left vs. time home + reserve), time to walk home (from `time_home.bin`
   at the crew's position), margin, burn rate, dust / solar / radiation status, warnings, and the full **assumptions**
   list (suit budget, reserve, walking speed, slope limits, demo factors) with the replan rule.
6. **Alerts log**.

### HUD

A full-screen, dark visor-style SVG display with:

- A compass with a big arrow to the next stop. In suit-only mode, during a storm or on a return route, the arrow turns red and points home.
- The next stop, distance left along the route, straight-line distance and ETA vs. plan.
- **Air left** and **time to walk home** in large numbers, with a margin bar.
- A mini-map (click it to zoom to a 600 m local view).
- A route strip with planned stop times.
- An alerts banner.
- The replan card with a big **CONFIRM REROUTE** button. Enter also confirms.

The top bar stays visible, so the sim and fault toggles still work from the HUD.

## Demo script

This is the walkthrough the integration test runs (`pw-int/walk.mjs`). It takes about 3 minutes live at 1200×.

1. **Plan.** Open the planner. The basemap, stops H, A and B, and both route variants are shown. The side panel shows
   the full plan (about 5.0 km, 4:00) inside the 5 h suit budget, with its why-lines (what hazards the route avoids).
2. **Preview a stop.** Click **A** (Delta outcrop) to see its science goal, what to expect, minerals and the planned
   arrival at T+0:42.
3. **Fall behind.** Turn on **Slow pace**, set the speed to 1200× and press **Play**. At the first mid-leg checkpoint
   (about T+0:19, 4 min behind) the sim pauses and proposes **"Skip the 45-min work at Delta outcrop"**: at the crew's
   real 0.8× pace the full plan would eat into the reserve. Checkpoints (small blue dots on the route) re-check the rule
   every 15 planned minutes, so the decision comes before the crew walks all the way to A. The card shows the option that did not fit and that the crew is
   still back with the reserve kept. The proposed path is dashed blue. Press **Confirm reroute**. The active route
   becomes `full@cp15:skip_work`; the crew still retrieves the tubes at Three Forks and gets home with about 33 min of air
   to spare. (Exact times follow `data/routes.json`; at harsher paces the rule can also cut the depot work or abort.)
4. **Helmet view.** Press `h`. The HUD shows the arrow to B, the distance left, air left vs. time home, and the route strip.
5. **Fallbacks.**
   - **Cut rover link.** The banner reads "ROVER LINK LOST · SUIT-ONLY". The arrow turns red and points home. The dot
     drifts by dead reckoning and the uncertainty ring grows. Time home is read from `time_home.bin` at the drifted
     position. Turn the link back on and the dot snaps back.
   - **High air use** (Reset, Play to about T+0:50, then turn it on). Air burns at 1.6×. The air the walk home needs is
     the walk home (the slower of the time-home grid and the way home the sim can route) × 1.6, stretched further at slow
     pace. When air left gets within 10 min of that + reserve, the **turn-around** alert fires. If the crew is at a stop or still heading out, a return route is proposed. If they are already on
     the last leg home, the alert says to keep walking.
   - **Reset, Play, then Storm** (around T+1:40). Dust and solar turn red, the walk is aborted, and a "Storm: back via
     Delta outcrop" return is proposed (back the way the crew came, faster than pressing on). Confirm it (Enter in the
     HUD) and the crew walks home. The status ends as **aborted**.

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
| `INTERFACES.md` | The contract between the modules (state shape, events, coordinates) |
| `tests/` | `node --test` unit tests for the sim |
