# Redline

Marswalk Planner for NASA Space Apps 2026 ("Interplanetary Survival Guide: Martian Map"). Full design: [docs/architecture.md](docs/architecture.md).

## Data pipeline

Everything the Engine and the App read is in `data/`, built by `pipeline/` from NASA and USGS sources.

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python pipeline/run.py          # full rebuild (~5 min, reads ~1.8 GB of HiRISE remotely)
.venv/bin/python pipeline/run.py 03       # rebuild from a stage onward
NASA_API_KEY=... .venv/bin/python pipeline/05_env.py   # DONKI with a real key (DEMO_KEY otherwise)
```

| Stage | Does | Writes |
| --- | --- | --- |
| `00_fetch.py` | downloads small sources, verifies md5 / structure | `raw/`, `raw/manifest.json` |
| `01_site.py` | tube positions, stop A shortlist, habitat, 4 km box, local true-scale CRS | `bounds.json`, `depot.json`, `site.json` |
| `02_terrain.py` | HiRISE window crop, 1 m local DTM, slope, roughness, basemap | `basemap.png`, `pipeline/work/terrain.npz` |
| `03_layers.py` | Stack map sand/rocky/units, CRISM minerals, THEMIS, final stop A | `pipeline/work/layers.npz`, `site.json` |
| `04_rover.py` | rover path, stop photos, tube close-ups | `rover_path.json`, `photos.json`, `depot.json` |
| `05_env.py` | MEDA weather + dust estimate, RAD stand-in, DONKI | `env_data.json` |
| `06_export.py` | overlay PNGs, legends, grids, safety params, provenance, QA checks | `layers/*.png`, `layers.json`, `grids.npz`, `safety_params.json`, `provenance.json` |

### The site

- **Habitat (H)** px `[1298, 868]`: smooth crater floor, mean slope 0.8° within 100 m, 1.2 km from the depot.
- **Stop A** px `[702, 955]`: delta-front outcrop ("Delta thinly layered") where Perseverance cored **Bearwallow** (sol 516). CRISM: olivine + smectite (clay-bearing). 357 m from the depot.
- **Stop B, Three Forks depot** center px `[762, 1123]`: 10 tubes within 35 m, positions from PDS drop sols.
- Grid: 2000 × 2000 px, 2 m/px, true scale, origin top-left, x east, y south. Leaflet `CRS.Simple`: `latlng = [2000 - y, x]`.

### Notes for the other roles

- **Engine:** start with the [Engine guide](docs/engine_guide.md) and run `examples/engine_quickstart.py`. Load `data/grids.npz` (see `grids_readme.json`) and `data/safety_params.json`. `nogo` is slope > 20°, roughness > 0.5 m or no data. **Sand is a cost, never a no-go**: the depot itself sits on mapped bedforms. Speed model and factors are in `safety_params.json` (`slope_speed_model`, `speed_factor_*`).
- **App:** overlays in `data/layers/` with legends and sources in `layers.json`. Rover path in `rover_path.json`. Photos per stop in `photos.json` (`featured` = official mosaics, `candidates` = filtered raw frames; pick in Story). Tube close-ups in `depot.json`.
- **Story:** `env_data.json` has every number with its source and time frame. Dust is an **estimate** (τ ≈ 0.34, range 0.16–0.53). Radiation is Curiosity at Gale (**stand-in**, ~219 µGy/day). Space weather is live from DONKI.

### Validation (in `pipeline/qa/`)

- Rover-logged elevation vs our DTM at 248 waypoints: median residual 3 cm, so the coordinate chain lands on the right cells.
- Perseverance's own drive path: 0.29% of its cells in the box are no-go, so the hazard mask agrees with real drivable ground.
- Habitat, stop A and all 10 tubes are connected through walkable cells.
- 1 px = 2.0000 m east-west and north-south (true-scale check).

## NASA data used

Challenge resources: **JPL Mars Trek** (context layers) and **Perseverance raw images** (stop photos). Also:
HiRISE DTM and 25 cm orthomosaic (USGS Mars 2020 TRN products) · CTX DTM · Mars 2020 waypoints and traverse (MMGIS) · Mars 2020 Three Forks Depot Bundle (PDS Geosciences) · MEDA (PDS Atmospheres) · MSL RAD (PDS PPI) · DONKI (NASA CCMC) · CRISM-derived mineral map (Parente et al., Zenodo) · THEMIS-derived thermal inertia (Edwards & Buz, Zenodo) · Mars 2020 Science Team photogeologic map (Stack et al. 2020). Full list with URLs, licenses and processing: [`data/provenance.json`](data/provenance.json).

## Credits

HiRISE: NASA/JPL/University of Arizona. CTX: NASA/JPL/MSSS. USGS Astrogeology (Mars 2020 TRN products). Perseverance images: NASA/JPL-Caltech (Mastcam-Z: NASA/JPL-Caltech/ASU). Stack et al. 2020 (CC-BY-4.0). Parente, Saranathan, Itoh, Tarnas (CC-BY-4.0). Edwards & Buz (CC-BY-4.0). PDS Geosciences, Atmospheres and PPI nodes. NASA CCMC DONKI.

## AI use

The data pipeline code was written with AI assistance (Claude). All data values come from the listed sources; every processing step is in `pipeline/` and reproducible with one command.

## Route engine (`pipeline/04_routes.py`)

Turns the aligned terrain layers into a cost grid, finds the cheapest safe path for each leg,
precomputes every route variant, and writes `routes.json` + `time_home.bin` for the web app.

```bash
pip install -r requirements.txt
python pipeline/04_routes.py --fake --preview     # fake hilly terrain -> work/fake/out/
python pipeline/04_routes.py                      # real layers in work/grid/ -> data/
python -m pytest tests
```

**Inputs** (from the Data pipeline, all 2000×2000 and aligned to the 2 m grid, in `work/grid/`):

| File | Type | Meaning |
| --- | --- | --- |
| `slope_deg.npy` | float32, degrees, NaN = no data | required |
| `sand.npy` | float32 0..1, 1 = soft sand | optional |
| `rough.npy` | float32 0..1, 1 = very rough | optional |
| `nogo.npy` | bool | optional, extra no-go cells |

Plus `data/stops.json` (contract shape) and optionally `data/env.json` for the suit budget.

**Outputs** in `data/`: `routes.json` (contract shape, plus `legs`, `walk_min`, `work_min`,
`max_slope_deg`, `fits_budget` per variant) and `time_home.bin` (little-endian uint16, tenths of a
minute, 65535 = unreachable, downsampled by `time_home.stride_px`; see `routes.json → time_home`).

All weights, thresholds and walking-speed assumptions live in `pipeline/config.py`.
