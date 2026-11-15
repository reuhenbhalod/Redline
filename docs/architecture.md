# Redline: System Architecture

Nov 14, 2026 · @Reuhen

## Overview

Two astronauts walk from their habitat in Jezero Crater to the Three Forks sample depot, stopping at a delta outcrop for science. Our app plans that walk from NASA orbital and rover data, guides it, and replans when things change.

**Science objective.** Study the layered sedimentary rocks at the delta front. We pick a layered delta outcrop where the CRISM map shows clay-bearing minerals (olivine with smectite, kaolinite, Fe/Mg smectite), minerals that form in water and can preserve signs of past life, ideally a spot Perseverance itself visited in 2022 (sols 415–600, all within about 200–600 m of the depot). Then retrieve the Three Forks sample tubes for return to Earth. Each stop panel says what to look at and what to sample.

*Why clays, not carbonates:* our check of the CRISM map found carbonates cover only about 1.4% of a 4 km box around Three Forks (most lie 3–5+ km west). Clay-bearing classes cover about 45%. Carbonates are presented as the target of a later, longer walk.

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

Every dataset gets cropped to one 4 km by 4 km box around the habitat, Three Forks, and the delta outcrop. It is then reprojected onto one **local, true-scale 2 m grid** (2000 by 2000 cells). Every source below was opened and checked against the Three Forks area on Nov 14. The links are the exact files, not landing pages.

### Locked data sources

| # | Layer | Dataset (exact source) | Native res / format | Role | Pipeline output |
| --- | --- | --- | --- | --- | --- |
| 1 | Elevation | HiRISE DTM mosaic, Mars 2020 TRN (USGS): `JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40.tif` on `https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/HiRISE/` (1.84 GB) | 1 m posting (~3 m effective), float32 | slope, roughness, cost grid, time home | grids.npz, slope.png, rough.png |
| 2 | Base image | HiRISE orthomosaic, same S3 folder: `JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first.tif` (7.36 GB) | 25 cm, uint8 | basemap | basemap.png |
| 3 | Backup elevation | CTX DTM, same bucket `mosaic/mars2020_trn/CTX/` (`JEZ_ctx_B_soc_008_DTM_..._20m_...tif`, ~10 MB) | 20 m | only if HiRISE fails | — |
| 4 | Geology, sand, rocky ground | **Stack et al. 2020, Photogeologic Map of the Perseverance Rover Field Site** (Space Sci Rev 216:127, CC-BY-4.0), shapefile in the Caltech supplement `11214_2020_739_MOESM3_ESM.zip` (authors.library.caltech.edu/records/a7qs5-xhq84) | 1:5000 polygons, drawn on the same HiRISE base | sand (aeolian bedforms), rocky ground, rock units for stop panels | sand.png, geology.png, grids.npz |
| 5 | Minerals | CRISM dominant mineralogy map, Parente et al. (Zenodo 5575824, CC-BY-4.0), `jezeroFinal.tif` plus readme | 36 m, **RGB color-coded** classes, 4 CRISM scenes | science stop choice, stop panel | minerals.png, grids.npz |
| 6 | Thermal inertia | THEMIS TI of Jezero, Edwards & Buz (Zenodo 4931348, CC-BY-4.0), `Jezero_Thermal_Inertia_v1.tiff` | 100 m | **context only** (see finding 6) | ti.png |
| 7 | Rover path | M20 waypoints and traverse (mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json, M20_traverse.json) | 708 waypoints with lon/lat, sol, site/drive | path overlay, sols for photos, stop A candidates | rover_path.json |
| 8 | Depot tubes | **PDS Geosciences: Mars 2020 Three Forks Depot Bundle** (`urn-nasa-pds-mars2020_sample_depot_three_forks`): `data/sample_drop_events/sample_drop_timestamps.csv` plus `data/ortho_mosaics/` (rover close-up orthos and elevation models per tube) | 10 tubes, drop sols 653–690 | tube positions (joined to waypoints by sol), close-up imagery | depot.json |
| 9 | Photos | Perseverance raw images JSON API (`mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json&sol=N`) | per sol | stop photos (filtered) | photos.json |
| 10 | Weather | MEDA, PDS Atmospheres (`pds-atmospheres.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda/`): derived pressure and humidity plus calibrated temperatures, depot-season sols | one CSV per sol per sensor | env inputs | env_data.json |
| 11 | Radiation | MSL RAD RDR (PDS PPI, `MSL-M-RAD-3-RDR-V1.0`), Curiosity at Gale, **labeled as a stand-in** | dose per time step | radiation note | env_data.json |
| 12 | Space weather | NASA DONKI API (`api.nasa.gov/DONKI/`): WSA-ENLIL simulations filtered to `impactList.location == "Mars"`, plus FLR/SEP | event list | solar storm status, live | env_data.json |
| 13 | Context map | JPL Mars Trek: "MRO HiRISE, Jezero Mosaic, Controlled" and "MRO CTX, Jezero Mosaic, Controlled" layers | tiles | zoomed-out view only | tile URL in layers.json |

Dropped: the generic USGS geologic hub link, and SIM 3464 (Sun & Stack 2020). SIM 3464 is 1:75,000 and its own readme says it is offset 100–200 m from the operations mosaics, which is 50–100 cells on our grid. The science.nasa.gov depot map image is kept only as a visual reference for checking tube positions.

### Verified findings and the fixes built into the pipeline

These come from opening the real files. Each fix is mandatory, not optional.

| # | Finding | Fix |
| --- | --- | --- |
| 1 | All rasters use Equirectangular with standard parallel 0. At 18.45°N, east-west "meters" are only 0.949 m on the ground, so distances are 5.4% too long and east-west slopes too gentle. | Reproject everything to a local true-scale grid: `+proj=eqc +lat_ts=<box center lat> +lon_0=<box center lon> +R=3396190 +units=m` (error under 0.01% across 4 km). Slope, distances, routes and times are only computed on this grid. |
| 2 | Waypoint `easting`/`northing` fields use a different, cos(lat)-scaled projection. | Never use them. Always convert from `lon`/`lat` with pyproj. |
| 3 | CRISM map is an RGB image. White (34% of the file) means **no coverage**, black means covered but unidentified, and 21,000 distinct colors exist because class edges were blended during resampling. | Decode to the nearest key color (10 minerals × 2 confidence levels); white → `255` no coverage; colors more than 40 RGB units from any key → `254` uncertain (7.9% of covered pixels). Fractions ignore both. Resample class IDs with **nearest neighbor only**. |
| 4 | Depot position was a guess. | Tube positions = waypoint position at each tube's drop sol (from `sample_drop_timestamps.csv`). The depot is about 100 m across, centered near 77.408°E, 18.453°N. |
| 5 | Carbonates are rare near the depot (1.4% of the 4 km box). | Stop A targets clays plus delta layering (see Overview). |
| 6 | THEMIS TI in the box is 154–288 (median 221) with no low-inertia patches, so a threshold can't find sand. | Sand comes from Stack et al. "Aeolian bedforms, large/small" polygons. Large bedforms count as both soft ground and ridges. THEMIS is shown as context. |
| 7 | Raw-image feed is noisy (sol 646: 479 images, 195 from an engineering camera, many thumbnails). | Keep only full frames from NAVCAM and MCZ (Mastcam-Z) cameras, pick the best few per stop, keep the credit line. Waypoint panoramas are blocked to scripts (HTTP 403), so they are not used. |
| 8 | MEDA has no wind or dust products for the depot sols, and TIRS `AIR_TEMP` reads up to +18 °C on some sols (an infrared retrieval, not the mast sensors). | Air temperature from ATS mast sensors 1–3 (median), ground from TIRS, 1st/99th percentiles. Dust **estimated** from the MEDA semidiurnal pressure tide: (S2/S0)[%] = 1.6τ + 0.3 (Wilson et al. 2008, applied at Jezero by Sánchez-Lavega et al. 2023, doi:10.1029/2022JE007480). Wind: not available. |
| 9 | HiRISE DTM effective resolution is ~3 m, so 2 m slope is noisy. | Light Gaussian smoothing before slope. Slope computed at native resolution on the local grid, then aggregated to 2 m (keeps steep spots). Note it in the assumptions. |
| 10 | Orthomosaic is not tiled: a 4 km crop downloads ~1.4 GB (DTM ~340 MB). Images are stitched, so brightness seams are possible. | Read only the window through `/vsicurl/` with rasterio, cache the crop in `raw/`, check the basemap by eye. |
| 11 | Stack map has two fields per polygon (surface unit, bedrock unit), 2,082 polygons with an empty surface unit, and one empty geometry. | Label = surface unit if present, else bedrock unit. Skip empty geometries. |
| 12 | Data comes from different times: terrain is timeless, rover and weather data are from 2022–23, RAD from a Curiosity period, DONKI is live 2026. | Stated scenario: **terrain timeless, weather typical of the depot season (sols 650–690), radiation from Curiosity as a stand-in, space weather live from DONKI.** Each value carries its time frame in env_data.json and the UI shows it. |
| 13 | Slope limits, walking speed and suit budget had no source. | Data owns `pipeline/safety_params.py`: every number has a citation or is explicitly marked as an assumption. |
| 14 | Licenses. | Zenodo THEMIS and CRISM and the Stack map are CC-BY-4.0, so attribution is required. Raw images credit "NASA/JPL-Caltech". USGS HiRISE/CTX products and PDS data are public domain. All go into provenance.json and the README. |

### Pipeline steps

1. **Pick the box.** Tube positions from the depot bundle plus waypoints. Choose stop A from clay-bearing CRISM pixels inside Stack delta units, preferring spots Perseverance visited. Choose a flat habitat site. Center the 4 km box on all three and define the local CRS.
2. **Crop.** Read the DTM and orthomosaic windows remotely with rasterio over `/vsicurl/` and cache them in `raw/`.
3. **One grid.** Warp every raster to the local CRS at 2 m on the same box (bilinear for elevation and image, nearest for class maps). Rasterize the Stack polygons onto the same grid.
4. **Rover points.** Convert waypoint and traverse lon/lat to grid pixels. The HiRISE images predate the landing, so there are no rover tracks to check against; instead compare the rover-logged elevation (`elev_geoid`) with the DTM at each waypoint.
5. **Derive layers.** Slope (degrees), roughness (detrended height variation over a 6–10 m window), sand and rocky masks from the Stack map, CRISM class IDs, and a no-go mask (slope over the hard limit, or missing data).
6. **Export.** Colored transparent PNGs, numeric grids for Engine (`grids.npz`), JSON files, and provenance.

Thresholds (slope soft and hard limits, roughness limit) live in `safety_params.py` with sources. Anything without a source is labeled as an assumption in the UI.

## Data workstream phases

Each phase ends with a check. The next phase starts only when that check passes.

| Phase | Work | Deliverables | Done when |
| --- | --- | --- | --- |
| **D0. Setup** | Repo skeleton, Python venv (rasterio with bundled GDAL, numpy, scipy, scikit-image, pyproj, matplotlib, pyshp, Pillow, requests), `raw/` gitignored, download the small sources (Stack map, CRISM, THEMIS, waypoints, traverse, depot CSV), get a DONKI API key | `pipeline/config.py`, `pipeline/00_fetch.py` | All small sources download with one command and match the expected checksums or sizes |
| **D1. Site and grid** | Tube positions from drop sols, stop A shortlist (clays plus delta units plus Perseverance visits), habitat site, the box, the local CRS | `bounds.json`, `depot.json`, draft `stops` positions, `qa/site_overview.png` | All three points are inside the box and inside DTM coverage. Distances between stops measured on the local grid |
| **D2. Terrain** | DTM and orthomosaic crop, reproject, smooth, slope, roughness, no-go mask | `basemap.png`, `slope.png`, `rough.png`, `grids.npz` (elevation, slope, roughness, no-go) | No gaps. Slope statistics are plausible. The east-west versus north-south scale check passes. Waypoints sit on the rover tracks in `qa/alignment_*.png` |
| **D3. Science and hazard layers** | Rasterize the Stack map (sand, rocky, units), decode CRISM, THEMIS for context, choose the final stop A | `sand.png`, `geology.png`, `minerals.png`, `ti.png`, `layers.json` (legends, resolution, source, time frame), `grids.npz` updated | Bedform polygons line up with ripples on the basemap. CRISM decoding leaves no unknown colors. Stop A is fixed and justified |
| **D4. Rover and imagery** | Traverse and waypoints in pixels, filtered raw images for stop A and the depot, depot close-up orthos | `rover_path.json`, `photos.json` (URLs, sol, camera, credit) | Every stop has at least 3 good photos, and every URL loads |
| **D5. Environment** | MEDA (depot-season sols), RAD stand-in summary, DONKI Mars impacts, dust scenario with citation | `env_data.json`, each value with source and time frame | Story can fill `env.json` without looking up anything else |
| **D6. Safety parameters** | Cited slope limits, walking speed versus slope, suit time budget, reserve, walk-back distance | `pipeline/safety_params.py`, assumptions list | Every number has a citation or an "assumption" label |
| **D7. QA and handoff** | One-command rebuild, sanity checks (Perseverance's own drive path should rarely cross no-go cells), `provenance.json`, README data credits, NASA Data field text | `make data` (or `python -m pipeline.run`), `provenance.json`, README section | A clean rebuild from scratch passes all checks, and Engine and App load the files without changes |

### Build results (Nov 14, `data` branch)

All phases D0–D7 are built and committed. Results and what the build taught us:

| # | Finding during the build | What we did |
| --- | --- | --- |
| 15 | Tubes are within 35 m of 77.4082°E, 18.4528°N. No waypoint exists on any drop sol or coring sol (the rover stays put). | Position = last waypoint before the sol, for both drops and coring sites. |
| 16 | At 36 m, CRISM shows the whole delta front by the depot as one class (olivine + smectite), so it cannot rank outcrops. | Stop A ranked by Stack delta unit, a depot sample cored there, and HiRISE slope. Final: sol-460 waypoint, "Delta thinly layered", where **Bearwallow** was cored, 357 m from the depot, work-area slope p90 7.2°. |
| 17 | Habitat: smooth crater floor, CTX mean slope 0.8° within 100 m, 1.2 km from the depot. The rover never parked within 150 m. | Habitat photos come from rover positions within 400 m, labeled as such in photos.json. |
| 18 | The depot itself sits on mapped bedforms. | Sand is a walking cost, never a no-go. |
| 19 | Mastcam-Z raw frames come as `EBY` (color) and `ECM` (grayscale) copies, plus sky, sun, calibration-target and noise subframes. | Keep color full frames, drop sky/deck/subframes, content-check every thumbnail. Featured images are the official PDS Mastcam-Z mosaics (delta front sols 466–474, depot sols 650/670/693). |
| 20 | RAD files are ~67 MB per sol. | Read only the dose bytes with HTTP range requests using offsets from the label. Result: ~219 µGy/day, consistent with Hassler et al. 2014 (210 ± 40). |
| 21 | Slope hard limit 20° (lunar traverse guideline, secondary source) puts 3.0% of the box in no-go. | Validated: 0.29% of Perseverance's own path cells are no-go; habitat, stop A and all 10 tubes are connected. |
| 22 | Rover-logged elevation vs DTM at 248 waypoints: median residual 3 cm. | Confirms the lon/lat → grid chain (likely the same DTM underlies rover localization, so this checks our coordinates, not the DTM itself). |
| 23 | The box contains the landing site (sol 13, Octavia E. Butler Landing). | Story point. |

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

**Pixel convention (fixed):** origin at the top-left (north-west) corner, x grows east, y grows south, one pixel = 2 m on the ground (true scale, local CRS). Leaflet's `L.CRS.Simple` has y growing up, so `map.js` converts once with `latlng = [height_px - y, x]`. The pipeline never flips.

| File | Holds | Written by |
| --- | --- | --- |
| basemap.png | HiRISE image, 2000 by 2000 | Data |
| layers/slope.png, rough.png, sand.png, rocky.png, geology.png, minerals.png, ti.png, nogo.png | transparent color overlays, same size | Data |
| bounds.json | grid size, pixel size, local CRS, corner coordinates, convention | Data |
| layers.json | legend, source, native resolution and time frame for each overlay | Data |
| grids.npz | numeric 2000 by 2000 arrays for Engine: elevation_m, slope_deg, rough_m, sand (0/1/2 = none/small/large bedforms), rocky (0/1), geo_unit (ID), mineral (ID), nogo (0/1) | Data |
| depot.json | the 10 tubes: name, sample ID, drop sol, px, close-up image | Data |
| rover_path.json | Perseverance traverse and waypoints in px, with sols | Data |
| photos.json | filtered raw-image candidates per stop: URL, sol, camera, credit | Data |
| env_data.json | MEDA, RAD and DONKI values, each with source and time frame | Data |
| provenance.json | every source: URL, version, license, credit line, what we did to it | Data |
| site.json | habitat, stop A (with shortlist and criteria), depot center, where depot samples were cored | Data |
| safety_params.json | every limit and speed/time parameter with source and basis (primary / secondary / assumption) | Data |
| grids_readme.json | dtype, units and ID tables for each array in grids.npz | Data |
| stops.json | habitat and science stops, photos, notes | Engine and Story |
| routes.json | every route variant with path, distance, time | Engine |
| env.json | dust, solar alert, radiation note, suit budget | Story (from env_data.json) |

`grids.npz` and the raw crops are pipeline-side files. Only the small web files are committed for GitHub Pages.

The shapes (numbers here are placeholders):

```json
// bounds.json
{ "width_px": 2000, "height_px": 2000, "pixel_m": 2,
  "crs": "+proj=eqc +lat_ts=<lat0> +lon_0=<lon0> +R=3396190 +units=m",
  "origin": "top-left", "x": "east", "y": "south",
  "corners_lonlat": { "nw": [0, 0], "ne": [0, 0], "se": [0, 0], "sw": [0, 0] } }

// layers.json (one entry per overlay)
[ { "id": "sand", "file": "layers/sand.png", "label": "Sand ripples and dunes",
    "source": "Stack et al. 2020 photogeologic map", "native_res_m": "1:5000 map",
    "time_frame": "timeless", "legend": [{ "color": "#e0b050", "label": "Large bedforms" }] } ]

// depot.json
[ { "name": "Malay", "sample_id": "M2020-00337-08", "drop_sol": 653, "px": [0, 0],
    "closeup": "<PDS ortho mosaic browse URL>" } ]

// env_data.json (each value carries its source and time frame)
{ "weather": { "air_temp_c": { "min": 0, "max": 0 }, "pressure_pa": 0,
               "source": "MEDA", "time_frame": "sols 650-690 (depot season)" },
  "dust": { "tau": 0, "source": "<citation>", "time_frame": "scenario value" },
  "radiation": { "dose_uGy_per_day": 0, "source": "MSL RAD", "time_frame": "<sols>", "stand_in": true },
  "space_weather": { "mars_cme_arrivals": [], "source": "DONKI WSA-ENLIL", "time_frame": "live, fetched <date>" } }

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

- **Pipeline:** Python 3, rasterio (bundles GDAL 3.12, so no separate GDAL install; reads remote windows over `/vsicurl/`), numpy, scipy (smoothing), scikit-image (pathfinding and time to walk home), pyproj (lon/lat to pixels), pyshp (Stack map shapefile), matplotlib (colormaps to PNG), requests (APIs).
- **App:** Leaflet (map), plain JavaScript modules, SVG for the HUD.
- **Hosting:** GitHub Pages serving `web/` and `data/`. This is the public submission link.

```
marswalk/
  pipeline/
    config.py        source URLs, box, local CRS, grid size, cost weights
    safety_params.py slope/roughness limits, walking speed, suit budget, each with a citation
    00_fetch.py      download small sources, cache API responses
    01_site.py       tube positions, stop A, habitat, box, local CRS (D1)
    02_terrain.py    remote crop, reproject, slope, roughness, no-go (D2)
    03_layers.py     Stack map, CRISM decode, THEMIS (D3)
    04_rover.py      traverse, photos, depot close-ups (D4)
    05_env.py        MEDA, RAD, DONKI (D5)
    06_export.py     PNGs, JSON, grids.npz, provenance.json (D7)
    07_routes.py     cost grid, legs, variants, time-home grid (Engine)
    qa/              alignment and sanity-check images
    run.py           rebuild everything with one command
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
| Data | all sources and APIs, crop, align, layers, grids.npz, depot, photos, env data, safety parameters, provenance (phases D0–D7) | basemap and layers by Sat 2 pm |
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
| Three Forks outside the DTM | depot point lands on blank data | Checked Nov 14: the depot is well inside, and the 4 km box has no gaps |
| Layers don't line up | waypoints miss the rover tracks on the basemap | check on one grid in pixel coordinates before anything else; never use the waypoint easting/northing fields |
| Distances or slopes off by ~5% | east-west and north-south measurements of the same feature disagree | everything runs on the local true-scale CRS, never the source projection |
| CRISM colors decoded wrong | unknown colors or speckled class boundaries | nearest-key decoding, nearest-neighbor resampling only |
| An API is down during the demo | DONKI or raw-image calls fail | every API response is cached into static JSON; the app never calls an API live |
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
- [ ] Credits (from provenance.json): HiRISE (NASA/JPL/University of Arizona) and USGS Mars 2020 TRN products; Stack et al. 2020 map (CC-BY-4.0); Edwards & Buz THEMIS TI and Parente et al. CRISM map (Zenodo, CC-BY-4.0); NASA/JPL-Caltech for raw images and waypoints; PDS Geosciences (depot bundle), PDS Atmospheres (MEDA), PDS PPI (RAD); NASA CCMC DONKI
- [ ] Time frames stated: terrain timeless, weather from the depot season, radiation from Curiosity (stand-in), space weather live
- [ ] AI use described in the project description; any AI images or video watermarked; no NASA logos
- [ ] Every teammate registered for the Seattle event and listed on the team page
- [ ] Submitted before the Seattle site closes (Sunday 11:59 pm local at the latest)
