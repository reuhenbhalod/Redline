# Marswalk Planner: System Architecture

Nov 14, 2026 · @Reuhen

## Overview

Two astronauts walk from their habitat in Jezero Crater to the Three Forks sample depot, stopping at a delta outcrop for science. Our app plans that walk from NASA orbital and rover data, guides it, and replans when things change.

**Science objective.** Study the layered sedimentary rocks at the delta front. We pick the outcrop where the CRISM map shows carbonates or clays, minerals that form in water and can preserve signs of past life. Then retrieve the Three Forks sample tubes for return to Earth. Each stop panel says what to look at and what to sample.

The app does five things:

1. **Plan.** The crew picks stops and the route engine draws the lowest-cost safe path around steep slopes and soft sand.
2. **Preview.** Each stop shows real Perseverance photos taken at or near that spot.
3. **Check safety.** An air budget with the time to walk home, and dust and solar storm status.
4. **Guide.** The wrist display shows the next stop, the distance, the air left, and the astronaut's position.
5. **Replan.** If the crew falls behind, the app drops a stop and switches to a shorter safe route.

**Design rule:** all heavy work (big map files, pathfinding) runs once in Python before the demo. The web app is static and only reads small files, so it loads fast and can be hosted on GitHub Pages for the submission link.

## System diagram

&#91;embedded content: system architecture · 3 zones, 9 parts\]

Data is prepared once before the walk and loaded onto the rover. During the walk, the rover's cameras feed computer vision and localization, the live loop decides, and the result goes by radio to the backpack computer and the wrist display, where the astronaut confirms any reroute.

## Data pipeline

Every dataset gets cropped to one 4 km by 4 km box around the habitat, Three Forks, and the delta outcrop, then snapped onto the same 2 m grid as the elevation map.

| Layer | Dataset | Resolution | Pipeline output |
| --- | --- | --- | --- |
| Context map | [Mars Trek](https://trek.nasa.gov/mars/) ([tile API](https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars)) | global to regional | zoomed-out view around the walk |
| Elevation (slope) | [HiRISE DTM mosaic, Mars 2020 TRN (USGS)](https://www.usgs.gov/data/mars-2020-terrain-relative-navigation-hirise-dtm-mosaic) | 1 m/pixel | slope.png, cost grid |
| Base image | [HiRISE orthomosaic (USGS)](https://astrogeology.usgs.gov/search/map/Mars/Mars2020/JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first) | 25 cm/pixel, resampled to 2 m | basemap.png |
| Backup elevation | [CTX DEM, Jezero products (USGS)](https://astrogeology.usgs.gov/search/map/mars-2020-jezero-crater-landing-site-products) | 20 m/pixel | only if HiRISE fails |
| Soft sand | [THEMIS thermal inertia of Jezero (Zenodo)](https://zenodo.org/record/4931348) | about 100 m/pixel | sand.png, cost grid |
| Minerals | [CRISM dominant mineralogy map (Zenodo)](https://zenodo.org/record/5575824) | CRISM targeted images | minerals.png, science stop choice |
| Rock units | [USGS-NASA geologic maps](https://astrogeology-usgs.hub.arcgis.com/pages/interactive-maps-mars) | map units | geology.png |
| Rover path | [M20 waypoints](https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json) and [traverse](https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json) | one point per stop | path overlay, sols for photos |
| Photos | [Perseverance raw images](https://mars.nasa.gov/mars2020/multimedia/raw-images/) | per sol | photo URLs in stops.json |
| Depot | [Three Forks depot map](https://science.nasa.gov/resource/perseverances-three-forks-sample-depot-map/), [PDS depot bundle](https://pds-geosciences.wustl.edu/missions/mars2020/) | tube positions | stop B in stops.json |
| Weather | [MEDA derived CSVs (PDS Atmospheres)](https://atmos.nmsu.edu/data_and_services/atmospheres_data/PERSEVERANCE/meda_08192021.html) | one file per sol | env.json |
| Radiation | [RAD dose rate (PDS PPI)](https://search-pdsppi.igpp.ucla.edu/search/view/?f=yes&id=pds://PPI/MSL-M-RAD-3-RDR-V1.0/DATA), Curiosity at Gale Crater, labeled as a stand-in | dose per time step | env.json |
| Solar storms | NASA DONKI space weather database | event alerts | env.json |

Steps, run in order:

1. **Pick the box.** Find Three Forks in the waypoints logged while the depot was built (Dec 2022 to Jan 2023). Center a 4 km square that also holds a flat habitat site and the delta outcrop.
2. **Crop.** Run `gdal_translate -projwin` on the DTM and orthomosaic. For the 6.9 GB orthomosaic, read it remotely with `/vsicurl/` instead of downloading it whole.
3. **One grid.** Run `gdalwarp` on THEMIS and CRISM using the DTM's projection, a 2 m pixel size, and the same box. Result: every layer is a 2000 by 2000 array that lines up cell for cell.
4. **Rover points.** Convert waypoint lon/lat into grid pixels with `pyproj` (Mars geographic CRS to the DTM's CRS). Overlay them on the basemap first to check the alignment.
5. **Derive layers.** Slope in degrees from `np.gradient` on the DTM. Soft sand where thermal inertia falls below a threshold. A no-go mask where slope passes the hard limit or data is missing.
6. **Export.** Color the layers with matplotlib colormaps into transparent PNGs, and write bounds.json so the web map knows the image size.

Thresholds (slope soft and hard limits, the sand cutoff) are assumptions. Label them as assumptions in the UI and cite a source for any we find.

## Route engine

The engine turns the layers into one cost grid, finds the cheapest path for each leg, and precomputes every route variant the demo needs. It runs offline as part of the pipeline; nothing here runs in the browser.

**Cost grid.** Each 2 m cell gets a walking cost. No-go cells get infinite cost. The weights are tuning knobs, not physics, so keep them in one config file.

```latex
\text{cost} = 1 + w_s \cdot \text{slope penalty} + w_t \cdot \text{soft sand} + w_r \cdot \text{rough ground}
```

**Pathfinding.** `skimage.graph.route_through_array(cost, start, end, fully_connected=True, geometric=True)` returns the path cells and total cost for one leg. Run it per leg: habitat to A, A to B, B to habitat.

**Route variants.** Precompute a route for each stop set: the full plan (H, A, B, H) and the short plan (H, B, H). The browser's replan just switches between these, so it never has to run pathfinding live.

**Time and air.** Time per leg = distance divided by a walking speed that drops with slope and is reduced for suit mass, plus a fixed work time at each stop. The rover carries the tools and the sample tubes, so the crew walks unloaded. The suit's time budget is an assumption we state on screen. For reference, Apollo planners treated a [five hour time-in-suit limit](https://ntrs.nasa.gov/api/citations/19700009560/downloads/19700009560.pdf) as the main constraint on rover-assisted traverses.

**Time to walk home.** Run `skimage.graph.MCP_Geometric(cost).find_costs([habitat])` once. It gives the cheapest walking time from every cell back to the habitat. The air budget shows that number for the crew's current position and alerts when time home plus the reserve gets close to the air left. No ring is drawn on the map. NASA has assumed about [10 km as the max excursion](https://core.ac.uk/works/15254764) that a suited crew could walk back from if a rover failed.

**Replan rule (browser).** A sim clock moves the astronaut along the route. At each stop, if the projected return time plus a reserve goes past the budget, switch to the next shorter variant that still reaches the depot, and show why.

## Positioning and computer vision

There is no GPS on Mars, so the rover finds itself on the HiRISE map and the astronaut's position is derived from the rover. The rover walks ahead of the astronaut the whole time, and its computer runs all the vision work.

**Hardware split.**

| Unit | Carries | Runs |
| --- | --- | --- |
| Rover (scouts about 100 m ahead) | front stereo camera (hazards ahead), rear stereo camera (crew), 360° mast camera, UWB radio, main computer, tools and sample tubes | computer vision, localization, live loop (cost grid, replanning), agent |
| Each astronaut's backpack (two crew) | suit computer (about 128 GB storage), motion sensors, UWB tag | dead reckoning, snapshot storage, route cache, air budget and time-home check |
| Each astronaut's wrist | display | next stop, route, both crew dots with uncertainty, air left, alerts |

The backpack computer is not powerful enough to run computer vision, so the rover does it.

**Where is the rover?** At each stop, or every few hundred meters, the rover takes a 360° panorama, flattens it into a top-down view using stereo depth, and slides it over the HiRISE crop around its estimated position. The best match is its position. This is the same idea as NASA's Mars Global Localization on Perseverance, which finds the rover to about 25 cm. Between fixes the rover tracks its own wheel turns and camera motion.

**Where are the astronauts?** The rover scouts about 100 m ahead of the two-person crew. Its rear camera finds each astronaut in the frame, which gives the direction. Each suit carries a UWB tag, which gives the distance to the rover. At 100 m stereo depth alone is too coarse, so UWB carries the distance and the camera carries the direction. Each astronaut's position = rover position + their offset, shown as two dots on the map. If a rock blocks the camera, UWB keeps the distance and the suit's dead reckoning fills in the direction. Expect about 1–2 m of error at 100 m (a 1° direction error alone is 1.7 m), close to the 2 m grid. This is an assumption to state.

**Scouting hazards ahead.** The rover's front stereo camera sees ground the crew will reach later. At 2 km/h, 100 m is about 3 minutes of walking. When computer vision confirms a hazard across 3 frames, it is placed on the grid, the live loop checks whether either astronaut's route crosses it, and if so a reroute appears on both wrist displays minutes before the crew gets there. Camera detections only add hazards; they never remove ones known from orbit. This directly answers the brief's call to avoid obstacles such as large rock formations.

**Snapshot loop.**

1. The rover cameras take 1–2 snapshots per second.
2. Computer vision on the rover finds the astronaut (distance, direction) and hazards ahead (rocks, sand, cracks), each placed on the 2 m grid.
3. Results go to the live loop as JSON: astronaut position and uncertainty, new hazards, confidence.
4. The live loop updates the cost grid, checks the route and the time to walk home, and replans if needed.
5. The new state goes over radio to the backpack computer, which drives the wrist display. The astronaut confirms any reroute.

**If the radio link to the rover drops.** The backpack keeps the last route, keeps the blue dot moving by dead reckoning (drifting slowly), and keeps running the air budget and time-home check on its own. The wrist display switches to suit-only mode and shows the way home. If the rover fails entirely, the astronaut stops and turns a slow full circle so the helmet camera can capture a panorama for a manual fix.

**Safety model.** The rover is the brain and the suit is the lifeline. The rover does the heavy work: vision, exact position, new hazards, replanning. The suit keeps the minimum needed to get home without the rover: the route, dead reckoning, and the air budget with the time to walk home. No safety-critical check depends on the radio. Pitch line: *"The rover thinks, the suit keeps you alive. If the link drops, the suit still gets the crew home."*

**Real-time updates while walking and turning.** These rates are design targets, not measured.

| What updates | Where it runs | How often |
| --- | --- | --- |
| Blue dot moves with each step and turn | backpack motion sensors (gyro for heading, since Mars has no magnetic field for a compass) | 50–100 times a second |
| Position corrected from the rover camera | rover | 1–2 times a second |
| Hazard seen → reroute offered on the wrist | rover live loop | about 2 seconds (3-frame confirmation, then replan) |
| Air left and time to walk home | backpack | every second |
| Exact fix against the HiRISE map | rover | at each stop or every few hundred meters |
| Radio delay, rover to suit | local link | milliseconds, not Earth's 4–24 minutes |

The dot never waits on the rover. It moves from the suit's own sensors, and each rover update nudges it back into place.

**Assumptions to state in the pitch:** the support rover carries rear stereo cameras like Perseverance's rear Hazcams; UWB ranging as backup; the backpack computer handles storage and dead reckoning but not vision.

**Demo:** the rover-view image is simulated by cutting a patch of HiRISE at a real Perseverance waypoint and adding noise. The drifted guess is offset 15–30 m. `cv2.matchTemplate` finds the true spot, and the astronaut dot sits a fixed 10 m behind the rover dot.

## Fallbacks

Each level takes over when the one above it fails, so the crew always has a way home. The suit computer is the main fallback.

&#91;embedded content: fallback ladder · 4 levels\]

| What fails | Fallback |
| --- | --- |
| Radio link to the rover | Suit computer keeps the route, the position dot and the air budget running on its own; the wrist shows a "rover link lost" banner |
| Rover breaks down completely | Suit computer plus the saved route home; the crew walks back together |
| Rover camera or computer vision misses something | Orbital hazards (slope, sand) are always on the map; the crew can tap the wrist to mark a hazard; every reroute needs the astronaut's OK |
| Position drifts or can't be fixed | The uncertainty circle grows and hazard buffers widen; the astronaut does a slow 360° turn for a manual map match, or confirms a known landmark at a stop |
| One astronaut's suit computer or wrist fails | Buddy system: the partner's wrist shows both crew dots and guides both |
| Air use higher than planned | Turn-around alert, then return home, dropping the remaining stops |
| Dust or solar storm starts mid-walk | Status turns red, walk aborted, shortest safe route home shown |
| Radio to the habitat drops | Nothing critical lost: the suit and rover don't need the habitat during the walk |
| All electronics fail | Printed cuff checklist on the sleeve: route sketch, landmarks, bearing home |

**For the demo, show two:** cut the rover link (the banner appears and the dot keeps moving) and trigger high air use (the turn-around alert fires). The rest go on one slide as this table.

## Data contracts

The pipeline and the web app only talk through these files in `data/`, so both sides can build in parallel against fake files with the same shape. All positions are pixel coordinates \[x, y\] on the 2000 by 2000 grid, never lon/lat. That kills most alignment bugs.

| File | Holds | Written by |
| --- | --- | --- |
| basemap.png | HiRISE image, 2000 by 2000 | Data |
| layers/slope.png, sand.png, minerals.png | transparent color overlays, same size | Data |
| bounds.json | grid size, pixel size, CRS, corner coordinates | Data |
| layers.json | legend for each overlay | Data |
| stops.json | habitat and science stops, photos, notes | Engine and Story |
| routes.json | every route variant with path, distance, time | Engine |
| env.json | dust, solar alert, radiation note, suit budget | Story |

The shapes (numbers here are placeholders):

```json
// bounds.json
{ "width_px": 2000, "height_px": 2000, "pixel_m": 2,
  "crs": "<from the DTM>", "corners_lonlat": [[0, 0], [0, 0]] }

// stops.json
[ { "id": "H", "name": "Habitat", "px": [0, 0], "kind": "base" },
  { "id": "A", "name": "Delta outcrop", "px": [0, 0], "kind": "science",
    "work_min": 0, "why": "", "expect": "", "photos": ["<raw image URL>"], "sol": 0 },
  { "id": "B", "name": "Three Forks depot", "px": [0, 0], "kind": "depot",
    "work_min": 0, "why": "", "expect": "", "photos": [], "sol": 0 } ]

// routes.json
{ "variants": [
  { "id": "full",  "stops": ["H", "A", "B", "H"], "distance_m": 0, "est_min": 0,
    "path": [[0, 0], [1, 1]], "why": ["avoids sand east of A"] },
  { "id": "skipA", "stops": ["H", "B", "H"], "distance_m": 0, "est_min": 0,
    "path": [], "why": [] } ],
  "time_home_file": "time_home.bin" }

// env.json
{ "dust": "low", "solar_alert": false, "radiation_note": "",
  "suit": { "budget_min": 0, "reserve_min": 0 }, "assumptions": [] }
```

The `why` lines on each route are what makes the tool explain itself. The engine fills them from which cells the path avoided (sand patches, steep zones).

## Web app

One static page with two modes: the habitat planner (map plus side panel) and the helmet HUD (full screen). A play button runs the sim clock that drives the demo.

| Screen | Shows | Reads |
| --- | --- | --- |
| Habitat planner | basemap, layer toggles, stops, chosen route, distance and time | basemap.png, layers/, stops.json, routes.json |
| Stop preview | rover photos for the clicked stop, science goal, minerals and rock unit there, what to sample, what to expect | stops.json |
| Safety check | air budget bar with time to walk home, dust and solar status, warnings | routes.json, env.json |
| Helmet HUD | arrow to next stop, distance left, air left, time to walk home | routes.json, env.json, sim state |
| Replan alert | behind schedule card, the suggested shorter route, why it's safe | routes.json, sim state |

Components, one file each:

- **map.js:** Leaflet with `L.CRS.Simple`. The basemap is an `imageOverlay` from \[0, 0\] to \[2000, 2000\], overlays stack on top, routes are polylines, stops are markers. Pixel coordinates go straight in, no projection math.
- **panels.js:** stop preview and safety check in the side panel.
- **hud.js:** the HUD drawn in SVG over a dark background, reading from the sim state.
- **sim.js:** the sim clock. It moves the astronaut along the active route, burns down the air budget, and applies the replan rule. For the demo, a "slow pace" toggle makes the crew fall behind at stop A so the replan fires on cue.
- **app.js:** loads the JSON files, holds the state (active variant, sim time, mode), and wires the parts together.

## Tech stack and repo structure

Python for the pipeline, plain HTML and JavaScript with Leaflet for the app, GitHub Pages for hosting. No backend, no framework, nothing to deploy but files.

- **Pipeline:** Python 3, GDAL command line tools, rasterio, numpy, scikit-image (pathfinding and time to walk home), pyproj (lon/lat to pixels), matplotlib (colormaps to PNG).
- **App:** Leaflet (map), plain JavaScript modules, SVG for the HUD.
- **Hosting:** GitHub Pages serving `web/` and `data/`. This is the public submission link.

```
marswalk/
  pipeline/
    config.py        box corners, grid size, thresholds, cost weights
    01_crop.py       crop DTM, orthomosaic, THEMIS, CRISM to the box
    02_grid.py       warp everything onto the 2 m grid
    03_layers.py     slope, sand, minerals, no-go mask
    04_routes.py     cost grid, legs, variants, time-home grid
    05_export.py     PNGs, bounds.json, routes.json
  data/              generated files the app reads (commit the small ones)
  web/
    index.html
    app.js  map.js  panels.js  hud.js  sim.js
    style.css
  README.md          how to run it, data credits, AI use note
```

Keep raw downloads out of git (add `raw/` to `.gitignore`). Only the cropped outputs in `data/` get committed.

## Team split and timeline

Four roles work in parallel against the data contracts. The gate is a route on the real map by 6 pm Saturday, and submitting at 7 pm Sunday leaves a buffer.

| Role | Owns | Hands off |
| --- | --- | --- |
| Data | crop, align, layer PNGs, bounds.json | basemap and layers by Sat 2 pm |
| Engine | cost grid, legs, route variants, time-home grid | routes.json by Sat 6 pm |
| App | map, panels, HUD, sim and replan | working site on GitHub Pages |
| Story | stop text and photos, env.json, assumptions, video, write-up | the submission |

Nobody waits on anyone. Engine starts on a fake hilly elevation grid (a few Gaussian bumps in numpy) until Data delivers. App starts on fake JSON files with the contract shapes.

The night gap is real: anything unfinished at 9 pm Saturday gets cut down Sunday morning, not added to.

## Risks and fallbacks

The go/no-go check is **Saturday 6 pm: is there a route drawn on the real elevation map of Three Forks?** Yes, keep going with photos, HUD, and replan. No, hand-draw the route over the real image and layers and put the time into the safety check, HUD, and story.

| Risk | Early sign | Fallback |
| --- | --- | --- |
| HiRISE files too slow to get | crop not done by 1 pm | CTX 20 m elevation for slope, Mars Trek tiles for the picture |
| Three Forks outside the DTM | depot point lands on blank data | move the box, or switch to the CTX elevation |
| Layers don't line up | waypoints miss the rover tracks on the basemap | check on one grid in pixel coordinates before anything else |
| Pathfinding too slow | one leg takes minutes | resample the grid to 5 m |
| Route looks wrong | path cuts through obvious sand or cliffs | tune the weights in config.py, show the layer it avoided |
| Out of time for HUD or replan | not started by Sunday 9 am | static HUD mock, replan as a scripted switch between the two variants |
| Seattle site ends early | check the event page today | shift every Sunday task earlier |

## Demo and submission

The 30-second video follows one Marswalk: plan, preview, safety check, HUD, replan. The replan moment gets the most screen time.

- [ ] Public link works in a logged-out browser (GitHub Pages)
- [ ] Demo: 30-second video or up to 7 slides, English captions if anyone speaks another language
- [ ] One slide or caption stating the assumptions: two crew, a rover, the suit budget, slope and sand thresholds
- [ ] NASA Data field: the challenge's own resources first (Mars Trek, Perseverance raw images), then every other dataset with its link
- [ ] Credits: HiRISE credit line, USGS, the Zenodo authors for the THEMIS and CRISM maps
- [ ] AI use described in the project description; any AI images or video watermarked; no NASA logos
- [ ] Every teammate registered for the Seattle event and listed on the team page
- [ ] Submitted before the Seattle site closes (Sunday 11:59 pm local at the latest)
