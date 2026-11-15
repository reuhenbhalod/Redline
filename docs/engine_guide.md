# Engine guide: using the Redline data

Everything the route engine needs is in `data/`. This guide explains what each file holds, how to turn it into routes and times, and the cases the Engine must handle. Every case below is implemented and tested in [`examples/engine_quickstart.py`](../examples/engine_quickstart.py). Start by running it:

```bash
.venv/bin/python examples/engine_quickstart.py     # ~2 s; writes examples/out/routes.json + time_home.bin
```

Expected output (current data):

```
full: 3120 m, 186 min (budget 450), why: ['H->A: avoids 150 m of steep or rough ground (no-go)', ...]
skipA: 2566 m, 117 min (budget 450), ...
time home from A: 52 min, from B: 42 min
abort path home from depot: 537 cells
reroute around hazard at [1075, 990]: 114 cells re-routed, hazard cells crossed: 0, ...
```

Copy the functions you need into the real Engine (`pipeline/07_routes.py`). The script writes to `examples/out/`, never to `data/`.

---

## 1. Files you read

| File | What you use from it |
| --- | --- |
| `data/grids.npz` | the 2000 × 2000 arrays: elevation, slope, roughness, sand, rocky, no-go, units, minerals |
| `data/grids_readme.json` | dtype, units and the ID tables for every array |
| `data/safety_params.json` | walking speed, speed factors, slope limits, suit budget, reserve, work times; each with source and basis |
| `data/site.json` | stop positions: `habitat.px`, `stop_a.px`, `depot_center.px` |
| `data/depot.json` | the 10 tubes: name, sample ID, drop sol, `px` |
| `data/bounds.json` | grid size, pixel size, CRS (you only need it to convert to lon/lat) |
| `data/env_data.json` | only if the Engine needs storm status (`space_weather.solar_alert`) |

You **write** `data/routes.json` and `data/time_home.bin` (Section 9).

## 2. Coordinates (read this first)

- Every position in the JSON files is a pixel **`[x, y]`**: origin top-left, **x east, y south**, 1 px = **2 m** on the ground in both directions (true scale).
- numpy arrays are indexed **`[row, col]` = `[y, x]`**. Convert in one place only:

```python
def rc(px):            # [x, y] -> (row, col)
    return int(round(px[1])), int(round(px[0]))

def xy(row, col):      # (row, col) -> [x, y]
    return [int(col), int(row)]
```

- Paths in `routes.json` go back out as `[x, y]`. The App does the Leaflet flip (`latlng = [2000 - y, x]`). **The Engine never flips y.**
- Distances: one straight step = 2 m, one diagonal step = 2√2 m ≈ 2.83 m.

## 3. The arrays in `grids.npz`

```python
g = np.load("data/grids.npz")
slope = g["slope_deg"].astype(np.float32)   # stored as float16: cast before math
```

| Array | dtype | Meaning | Notes |
| --- | --- | --- | --- |
| `elevation_m` | float32 | elevation (m, Mars geoid), rounded to 1 cm | DTM vertical precision ~0.2–0.5 m |
| `slope_deg` | float16 | max slope in the 2 m cell (from a 1 m grid) | conservative: steep spots are kept |
| `rough_m` | float16 | local relief: std of detrended height in an 8 m window | misses single rocks under ~1–2 m |
| `sand` | uint8 | 0 none, 1 small bedforms (ripples), 2 large bedforms (ridges) | from the Mars 2020 team's geologic map |
| `rocky` | uint8 | 1 = blocky / talus / rough fractured units | |
| `nogo` | uint8 | 1 = slope > 20°, roughness > 0.5 m, or no data | 3.0% of the box |
| `geo_unit` | uint16 | geologic unit ID → name in `grids_readme.json["units"]` | for "why" text and stop panels |
| `mineral` | uint8 | CRISM class ID → `grids_readme.json["minerals"]`; 0 unidentified, 254 uncertain, 255 no coverage | 36 m data: don't route on it |
| `mineral_conf` | uint8 | 2 high, 1 medium, 0 n/a | |
| `thermal_inertia` | float16 | context only, NaN outside coverage | 100 m data: **don't route on it** |

**Rules:**
- **Sand is never no-go.** The depot itself sits on mapped bedforms; if you block sand, the depot is unreachable. Sand only slows the crew.
- `nogo` is precomputed with the limits in `safety_params.json`. If someone changes a limit, rerun `pipeline/06_export.py` (it rebuilds `nogo` and re-checks that all stops connect). Don't recompute no-go differently in the Engine.

## 4. Safety parameters

```python
P = {k: v["value"] for k, v in json.load(open("data/safety_params.json"))["params"].items()}
```

| Key | Value | Use |
| --- | --- | --- |
| `walk_speed_flat_kmh` | 2.0 | planning speed on flat ground (Apollo 15 average) |
| `slope_speed_model` | Tobler shape | speed vs grade (Section 6) |
| `speed_factor_sand_small` / `_large` / `_rocky` | 0.85 / 0.6 / 0.75 | multiply speed on those cells |
| `suit_budget_min` / `reserve_min` | 480 / 30 | **usable budget = 450 min** |
| `work_min_science_stop` / `work_min_depot` | 45 / 40 | time spent at A and B |
| `max_walkback_km` | 10 | sanity limit; our whole box is 4 km |

Each entry has `basis`: `primary`, `secondary` or `assumption`. Anything marked `assumption` must be shown as an assumption in the UI (the App can read `safety_params.json["assumptions"]`).

All times are **Earth minutes** (suit consumables are measured in Earth time).

## 5. Building the routing cost grid

Cost = minutes to cross one 2 m cell.

```python
def tobler(v_flat, grade):                 # grade = rise/run, signed (+ uphill)
    return v_flat * np.exp(-3.5 * abs(grade + 0.05)) / np.exp(-3.5 * 0.05)

g_ = np.tan(np.radians(slope))
v = np.minimum(tobler(2.0, g_), tobler(2.0, -g_))    # worse of up/down: routing ignores direction
v *= terrain_factor                                   # sand / rocky multipliers
cost = (2 / 1000) / v * 60                            # minutes per cell
cost[nogo] = 1e9                                      # BLOCKED
```

- **Why "worse of up/down":** `skimage` routing can't use direction-dependent costs. Using the slower direction keeps routing conservative. Accurate times come from Section 6.
- **Use a large finite number (1e9) for blocked cells, not `np.inf`.** `route_through_array` needs finite costs, and with `inf` the error is confusing. After routing, check the path doesn't touch a blocked cell (Section 10).
- `fully_connected=True, geometric=True` lets the path move diagonally and charges diagonals √2.

## 6. Routing a leg and timing it

```python
path, _ = route_through_array(cost, rc(a_px), rc(b_px), fully_connected=True, geometric=True)
```

Then compute the **real** walking time along the path with signed grade from elevation (uphill is slower than downhill):

```python
step = np.hypot(*np.diff(p, axis=0).T) * 2.0
rise = np.diff(z[p[:, 0], p[:, 1]])
v = tobler(2.0, rise / step) * terrain_factor[p[1:, 0], p[1:, 1]]
minutes = ((step / 1000) / v * 60).sum()
```

Current legs: H→A 1,449 m / 48.8 min, A→B 388 m / 13.5 min, B→H 1,283 m / 38.4 min walking. Each leg routes in ≤ 0.2 s.

**Grid quirk:** many different grid paths have exactly the same length (a detour that keeps the same mix of straight and diagonal steps). Compare routes by **time** or by cells changed, not by distance.

## 7. Stops and route variants

```python
stops = {"H": site["habitat"]["px"], "A": site["stop_a"]["px"], "B": site["depot_center"]["px"]}
```

| Variant | Stops | Distance | Est. time (walk + work) |
| --- | --- | --- | --- |
| `full` | H → A → B → H | 3,120 m | 186 min |
| `skipA` | H → B → H | 2,566 m | 117 min |

- **Depot:** route to `depot_center`. The 10 tubes are all within 35 m of it (`depot.json` has each tube's `px` if the App wants to draw them or the sim wants a walk between tubes).
- Est. time = walking time (Section 6) + `work_min` at each stop you arrive at (none for the final H).
- `fits_budget` = `est_min <= 450`.

## 8. "Why" lines

The route explains itself by comparing it with a straight line between the same two stops:

```
H->A: avoids 150 m of steep or rough ground (no-go)
H->A: avoids 300 m of blocky rock
B->H: avoids 196 m of large sand ridges
```

For each hazard mask (no-go, large sand, rocky), count the meters the straight line crosses minus the meters the route crosses, and keep the ones ≥ 20 m. Unit names (`geo_unit`) can make it richer, e.g. "stays off the Delta blocky unit".

## 9. Time to walk home, and the abort path

One search from the habitat gives the time home from every cell:

```python
m = MCP_Geometric(cost, fully_connected=True)
t_home, _ = m.find_costs([rc(H)])          # ~0.7 s
t_home[t_home >= 1e9] = np.inf             # unreachable
path_home = m.traceback(rc(any_px))        # abort: safest path home from anywhere, no new search
```

Current: 52 min home from A, 42 min from B.

**Export format for `time_home.bin`** (what the App and backpack read):

- `uint16`, little-endian, row-major, **1000 × 1000** (4 m cells, 2 MB)
- value = minutes home, rounded **up**, and each 4 m cell takes the **max** of its four 2 m cells (conservative)
- `65535` = unreachable
- lookup: `value[floor(y_px / 2)][floor(x_px / 2)]`

The full 2 m grid would be 8 MB, which is too heavy for the browser. Describe the format in `routes.json` (the quickstart writes a `time_home` block).

**Note:** `t_home` uses the routing cost (worse of up/down), so it's slightly pessimistic, which is the safe direction for an air alarm.

## 10. Cases the Engine must handle

| Case | What to do |
| --- | --- |
| **Normal plan** | precompute `full` and `skipA`; write both to `routes.json` |
| **Replan (behind schedule)** | at each stop: `elapsed + remaining_est > 450` → switch to the next shorter variant that still reaches B (`skipA`), and show why. The browser only switches variants; it never pathfinds |
| **Abort (storm, air, suit fault)** | path home = `traceback` from the current cell on the time-home search (Section 9). Precompute aborts from each stop, and from points along the route if the sim needs them |
| **Rover sees a new hazard** | add a no-go disk (radius + 4 m buffer) to an extra mask, rebuild cost, re-route the remaining legs. **Only add hazards, never remove orbital ones.** Tested: 114 cells re-routed, 0 hazard cells crossed |
| **Stop on a no-go cell** | shouldn't happen (export checks it), but assert `cost[rc(stop)] < 1e9` at startup |
| **No safe path** | after routing, if any path cell has cost ≥ 1e9, there is no safe route: raise, don't draw it |
| **Path along the box edge** | fine; there is no data outside the box, so the route cannot leave it |
| **Solar storm** | `env_data.json["space_weather"]["solar_alert"]` true → status red, abort case |

**Replan demo warning:** the full walk uses 186 of 450 minutes, so slowing the walk alone won't trigger a replan unless walking pace drops by ~3.6× (101 min walking × k + 85 min work > 450). Two options:
1. Trigger it with **high air use** instead (consumption multiplier on the suit budget, which the spec lists as a fallback case), or
2. Shorten the demo budget explicitly and label it as a demo setting.

## 11. What you write: `data/routes.json`

```json
{ "variants": [
    { "id": "full", "stops": ["H", "A", "B", "H"], "distance_m": 3120, "est_min": 186,
      "fits_budget": true,
      "path": [[1298, 868], [1297, 868], ...],
      "why": ["H->A: avoids 150 m of steep or rough ground (no-go)", ...],
      "legs": [{ "from": "H", "to": "A", "distance_m": 1449, "walk_min": 48.8, "why": [...] }, ...] },
    { "id": "skipA", ... } ],
  "time_home_file": "time_home.bin",
  "time_home": { "dtype": "uint16 little-endian", "shape": [1000, 1000], "cell_m": 4, "unreachable": 65535,
                 "index": "value[row][col], row = floor(y_px / 2), col = floor(x_px / 2)" } }
```

`path` is `[x, y]` pixels, one per 2 m cell (1,340 points for `full`, fine for Leaflet). `legs` and `fits_budget` are additions to the original contract; the App can ignore them.

## 12. Assumptions to state in the UI

- Walking speeds come from Apollo (Moon, 1/6 g); Mars is 0.38 g. No suited Mars data exists.
- Slope speed curve is the shape of Tobler's hiking function (Earth).
- Sand / rocky speed factors, roughness limit, and work times are our assumptions.
- 20° slope limit is a lunar traverse guideline from a secondary source.
- The DTM cannot see single rocks under ~1–2 m: rover cameras (live hazards) cover that.

## 13. Checklist before you hand off

- [ ] `rc()` / `xy()` are the only place x/y and row/col swap
- [ ] slope and roughness cast to float32
- [ ] sand only slows, never blocks
- [ ] every path checked for blocked cells
- [ ] times from signed grade along the path (Section 6), not from the routing cost
- [ ] `time_home.bin` is uint16, 1000 × 1000, rounded up, 65535 = unreachable
- [ ] `routes.json` paths are `[x, y]`, not flipped
- [ ] `examples/engine_quickstart.py` still runs after any data change

Questions about the data: see `README.md` → Data pipeline, `data/provenance.json`, and `docs/architecture.md`.
