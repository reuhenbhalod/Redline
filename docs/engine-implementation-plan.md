# Route Engine: Implementation Plan

Owner: Engine · Branch: `engine/route-engine` · Hand-off: `routes.json` by **Sat 6 pm**

The engine runs offline in Python. It turns aligned terrain layers into a cost grid, finds the
cheapest safe path for each leg, precomputes every route variant plus the time-home grid, and
writes the files the web app reads. Until Data delivers (Sat 2 pm), it runs on fake terrain
from `pipeline/fake_terrain.py`.

Status key: `[x]` done on the branch · `[ ]` to do · *(stretch)* = only if time allows.

## Build order at a glance

| # | Component | Depends on | Status | Target |
| --- | --- | --- | --- | --- |
| 1 | Fake terrain and test fixtures | none | mostly done | Sat AM |
| 2 | Inputs and validation | 1 | mostly done | Sat AM |
| 3 | Cost grid | 2 | done, untuned | Sat AM |
| 4 | Walking time model | 2 | done, untuned | Sat AM |
| 5 | Leg pathfinding | 3, 4 | done | Sat AM |
| 6 | Route variants | 5 | done | Sat noon |
| 7 | Time-home grid | 4 | done | Sat noon |
| 8 | Replan support data for the app | 6, 7 | to do | Sat 2 pm |
| 9 | Why-lines (explanations) | 5, 6 | first pass done | Sat 4 pm |
| 10 | Export and contract checks | 6–9 | mostly done | Sat 4 pm |
| 11 | Visual QA and tuning | 10 | preview done | Sat 4–6 pm |
| 12 | Real-data cutover | Data hand-off | to do | Sat 2–6 pm |
| 13 | Live hazard reroute demo *(stretch)* | 5, 12 | to do | Sun AM |

Go/no-go (Sat 6 pm): a route drawn on the real Three Forks elevation map. Components 1–7, 10 and 12
are on that critical path. Everything else can slip to Sunday morning or be cut.

---

## 1. Fake terrain and test fixtures

Goal: realistic stand-in layers so the engine can be built and tested before real data exists.

- [x] 1.1 Rolling hills from Gaussian bumps on a 2000×2000, 2 m grid (`make_dtm`)
- [x] 1.2 A delta-front cliff with one walkable gap, so routes have to find a pass
- [x] 1.3 Soft sand patches, roughness from local elevation variance, and a missing-data block
- [x] 1.4 Scale feature heights with grid size so small test grids keep realistic slopes
- [x] 1.5 Fake `stops.json` (H, A, B) placed so `full` is over budget and `skipA` fits
- [ ] 1.6 Fixed seeds plus 2–3 named scenarios (`easy`, `cliff`, `sand_maze`) for tests and demos
- [ ] 1.7 Let the App teammate have the fake `routes.json` (copy it to `data/` behind a flag, or share it)

Done when: `04_routes.py --fake` produces both variants, and each scenario has a test.

## 2. Inputs and validation

Goal: load Data's layers and the stops, and fail loudly on anything misaligned.

- [x] 2.1 Load `slope_deg.npy` (required) plus `sand`, `rough`, `nogo` (optional, default empty)
- [x] 2.2 Check that every layer has the same shape as slope
- [x] 2.3 Treat NaN or missing values in any layer as no-go
- [x] 2.4 Load `stops.json`; reject stops outside the grid
- [x] 2.5 Snap any stop on a no-go cell to the nearest walkable cell, with a warning
- [x] 2.6 Read the suit budget and reserve from `env.json` when present, else from config
- [ ] 2.7 Check value ranges: slope 0–90°, sand and rough 0–1; warn on suspicious stats (e.g. >30% no-go)
- [ ] 2.8 Read `bounds.json` and check the grid size and `pixel_m` match `config.py`
- [ ] 2.9 Optional `dtm.npy` input: compute roughness in the engine if Data doesn't ship `rough.npy`
- [ ] 2.10 **Agree the input format with Data** (see Open questions)

Done when: a bad or misaligned input stops the run with a clear message.

## 3. Cost grid

Goal: one walking cost per 2 m cell, `cost = 1 + w_s·slope + w_t·sand + w_r·rough`, with no-go = ∞.

- [x] 3.1 Slope penalty `(slope / SLOPE_SOFT_DEG)²`
- [x] 3.2 Sand and roughness terms, clipped to 0–1
- [x] 3.3 No-go mask: slope ≥ hard limit, data gaps, extra `nogo` cells
- [x] 3.4 All weights and thresholds in `config.py`
- [ ] 3.5 Safety buffer: widen no-go by N cells (dilate the mask) so paths don't skim cliff edges
- [ ] 3.6 Optional soft margin: extra cost that fades out near no-go cells
- [ ] 3.7 Export the cost grid as a debug PNG for tuning

Done when: the cost image shows cliffs and sand as clearly more expensive, and no-go as blocked.

## 4. Walking time model

Goal: realistic minutes per leg, separate from cost. Cost picks the path; time drives the air budget.

- [x] 4.1 Speed `V_FLAT · exp(−k · tan(slope))`, 2 km/h on flat ground (suited, unloaded)
- [x] 4.2 Minutes per cell, used for both leg time and time home
- [x] 4.3 Work time per stop: from `stops.json`, else a config default by kind
- [ ] 4.4 Slow walking on sand and rough ground too (multiply speed by a factor)
- [ ] 4.5 Sanity check against the Apollo walking-pace references; cite the source in assumptions
- [ ] 4.6 *(stretch)* Uphill/downhill asymmetry (true Tobler) using the elevation gradient direction

Done when: a flat 1 km leg takes about 30 min, and sloped legs take visibly longer.

## 5. Leg pathfinding

Goal: the cheapest safe path between each pair of stops.

- [x] 5.1 Dijkstra from each start stop (`MCP_Geometric`, 8-connected), then trace back to each end stop
- [x] 5.2 Reuse A→B reversed for B→A (cost is the same in both directions)
- [x] 5.3 Clear error when no safe path exists
- [x] 5.4 Per-leg distance, walking time and max slope along the path
- [ ] 5.5 Timing check on the real grid; fall back to a 5 m grid if one leg takes over 1 min
- [ ] 5.6 Path smoothing for display (current: Douglas-Peucker at 1 px), checked so it never cuts a no-go cell

Done when: every leg on fake and real terrain avoids no-go cells, and the full run takes under 1 min.

## 6. Route variants

Goal: precompute every plan the browser can switch between, so replanning never runs pathfinding live.

- [x] 6.1 Variants defined in config: `full` (H‑A‑B‑H) and `skipA` (H‑B‑H)
- [x] 6.2 Join legs into one path without repeating the shared stop points
- [x] 6.3 Per-variant totals: distance, walking time, work time, estimated minutes, max slope
- [x] 6.4 Per-leg index ranges into the path, so the app knows which stretch is which leg
- [x] 6.5 `fits_budget` per variant (estimate plus reserve within the suit budget)
- [ ] 6.6 Variants sorted longest first, and the browser rule spelled out: step down to the next variant that still reaches B
- [ ] 6.7 *(stretch)* "Abort home" variants: the shortest route home from each stop, for storms

Done when: the app can switch variants by id, and the totals add up.

## 7. Time-home grid

Goal: for every cell, the fastest walking time back to the habitat.

- [x] 7.1 One Dijkstra from the habitat over the minutes-per-cell grid
- [x] 7.2 Pack as uint16 tenths of a minute, 65535 = unreachable, downsampled 2× (about 2 MB)
- [x] 7.3 Describe the format in `routes.json → time_home`
- [ ] 7.4 Check the file in the browser: read one pixel in JS and compare to Python
- [ ] 7.5 Decide whether the app needs the full grid or only values along each route (see 8.2)

Done when: the app shows the same time-home number as Python for a test point.

## 8. Replan support data for the app

Goal: precompute everything `sim.js` needs, so the replan rule in the browser is just arithmetic.

- [ ] 8.1 Cumulative time along each variant's path (minutes elapsed at each path point, work stops included)
- [ ] 8.2 Time home at each path point (sampled from the time-home grid), for the air bar
- [ ] 8.3 At each stop: planned arrival time, time home from that stop, and slack against the budget
- [ ] 8.4 Replan table: at each stop, which variant to switch to if behind schedule, and the reason text
- [ ] 8.5 Agree field names with the App teammate before Sat 2 pm

Done when: `sim.js` can drive the astronaut and fire the replan using only `routes.json`.

## 9. Why-lines (explanations)

Goal: each route explains itself in plain sentences on screen.

- [x] 9.1 Compare each leg with the straight line between its stops
- [x] 9.2 Report avoided no-go ground, steep slope and soft sand in meters, with a compass direction
- [x] 9.3 Report the detour length and percent
- [x] 9.4 Skip repeats when a variant walks the same leg back
- [ ] 9.5 Better wording: name the nearest landmark or stop, merge lines, cap at 3 per variant
- [ ] 9.6 Variant-level summary for the replan card, e.g. "skipA saves 62 min and stays under 11°"
- [ ] 9.7 Hand-check every line against the preview image (directions must be right)

Done when: someone reading only the why-lines can say what the route avoids and where.

## 10. Export and contract checks

Goal: files the app can trust.

- [x] 10.1 Write `routes.json` (contract fields plus extras) and `time_home.bin`
- [x] 10.2 Paths as integer pixel [x, y], inside the grid
- [x] 10.3 Assumptions and warnings lists in `routes.json`
- [ ] 10.4 Write the engine's fields into `stops.json` (snapped `px`) without overwriting Story's text
- [ ] 10.5 Contract test: a schema check run on every export, which fails CI if a field is missing
- [ ] 10.6 Size check: `routes.json` under ~500 KB and `time_home.bin` under ~2 MB for fast loading

Done when: the app loads the export with no code changes, both for fake and real data.

## 11. Visual QA and tuning

Goal: routes that look right to a human on the real map.

- [x] 11.1 Preview PNG: routes over slope, sand and no-go, plus the time-home map
- [ ] 11.2 Draw the preview over `basemap.png` once Data delivers it
- [ ] 11.3 Weight sweep: run 3–5 weight sets, compare routes side by side, pick one, record why
- [ ] 11.4 Checklist per route: no cliff cutting, no needless zig-zags, sand avoided unless the detour is huge
- [ ] 11.5 Record the final weights and thresholds as assumptions, with sources where we have them

Done when: the team agrees the route on the real map looks sensible.

## 12. Real-data cutover

Goal: switch from fake to real layers with no code changes.

- [ ] 12.1 Get the first real `work/grid/` from Data; run 2.7–2.8 checks
- [ ] 12.2 Place real stops: habitat on flat ground, A on the CRISM carbonate/clay outcrop, B at the Three Forks tubes
- [ ] 12.3 Run the engine; check routes against rover tracks and the basemap
- [ ] 12.4 Fix alignment problems in pixel coordinates first (the risks table's early sign)
- [ ] 12.5 Retune weights (11.3) and the suit budget so `full` fits normally and `skipA` covers the slow-pace demo
- [ ] 12.6 Commit `data/routes.json` and `time_home.bin`; hand off to App by 6 pm
- [ ] 12.7 Fallback if late: CTX 20 m elevation, or a hand-drawn route (per the risks table)

Done when: the go/no-go check passes.

## 13. Live hazard reroute demo *(stretch)*

Goal: show the rover's "hazard seen ahead → reroute" without a live engine in the browser.

- [ ] 13.1 Pick a point on the `full` route and inject a fake rock hazard (no-go disk)
- [ ] 13.2 Re-solve from that point to the next stop; export as a `hazard` variant with its trigger point
- [ ] 13.3 Why-line: "rock field confirmed by rover camera, detour adds N m"

---

## Open questions for the team

1. **Data → Engine format.** The engine needs number grids (`slope_deg.npy`, `sand.npy` 0–1,
   `nogo.npy`), not just the PNGs in the contract. Who turns THEMIS thermal inertia into a 0–1 sand
   value, and with what threshold? Does Data ship `rough.npy` or `dtm.npy`?
2. **Replan fields (8.x).** Confirm names and shapes with App before they build `sim.js`.
3. **`stops.json` ownership.** Story writes the text; Engine writes the snapped `px`. Agree who
   commits the file last.
4. **Suit budget.** Story owns `env.json`. The budget decides whether `full` fits, so set it together.
