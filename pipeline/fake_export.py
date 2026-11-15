"""Write a complete FAKE data/ folder with every contract file, so the web app can be built
before Data and Story deliver. Real pipeline outputs overwrite these files.

    python pipeline/fake_export.py            # -> work/fakedata/  (open the app with ?data=../work/fakedata/)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import engine_config as cfg  # noqa: E402
import engine  # noqa: E402
import fake_terrain  # noqa: E402


def save_rgba(path: Path, rgba: np.ndarray):
    import matplotlib.image as mpimg
    path.parent.mkdir(parents=True, exist_ok=True)
    mpimg.imsave(path, np.clip(rgba, 0, 1))


def hillshade(dtm: np.ndarray, az=315, alt=40) -> np.ndarray:
    gy, gx = np.gradient(dtm, cfg.PIXEL_M)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    az, alt = np.radians(az), np.radians(alt)
    return np.clip(np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect), 0, 1)


def main(out_dir="work/fakedata", size=cfg.GRID_SIZE_PX):
    if (Path(out_dir) / "grids.npz").exists():
        raise SystemExit(f"{out_dir} holds REAL pipeline data (grids.npz); refusing to overwrite it with fake files")
    import matplotlib
    matplotlib.use("Agg")

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    dtm, slope, sand, rough, nogo = fake_terrain.make_layers(size)
    layers = engine.Layers(slope, sand, rough, nogo, dtm=dtm)

    # basemap: Mars-tinted hillshade
    hs = hillshade(dtm)[..., None]
    tint = np.array([0.80, 0.55, 0.38])
    base = np.concatenate([0.15 + 0.85 * hs * tint, np.ones((size, size, 1))], axis=2)
    save_rgba(out / "basemap.png", base)

    # overlays
    s = (np.clip(slope / cfg.SLOPE_HARD_DEG, 0, 1))
    rgba = matplotlib.colormaps["magma_r"](s)
    rgba[..., 3] = np.clip((slope - 5) / 15, 0, 0.75)
    save_rgba(out / "layers/slope.png", rgba)

    rgba = np.zeros((size, size, 4)); rgba[..., :3] = [0.98, 0.85, 0.35]
    rgba[..., 3] = sand * 0.6
    save_rgba(out / "layers/sand.png", rgba)

    yy, xx = np.mgrid[0:size, 0:size]
    rng = np.random.default_rng(3)
    mineral = np.zeros((size, size), int)
    stops = fake_terrain.fake_stops(size)
    ax, ay = stops[1]["px"]
    centers = [(ax + 40, ay - 30, 1), (ax - 80, ay + 60, 2)] + [
        (*rng.uniform(0.1, 0.9, 2) * size, rng.integers(1, 4)) for _ in range(8)]
    for cx, cy, k in centers:
        r = rng.uniform(0.02, 0.05) * size
        mineral[(xx - cx) ** 2 + (yy - cy) ** 2 < r * r] = k
    colors = {1: [0.20, 0.75, 0.55], 2: [0.35, 0.55, 0.95], 3: [0.85, 0.35, 0.75]}
    rgba = np.zeros((size, size, 4))
    for k, c in colors.items():
        rgba[mineral == k, :3] = c
        rgba[mineral == k, 3] = 0.55
    save_rgba(out / "layers/minerals.png", rgba)

    (out / "bounds.json").write_text(json.dumps({
        "width_px": size, "height_px": size, "pixel_m": cfg.PIXEL_M,
        "crs": "FAKE: Mars 2000 equirectangular", "corners_lonlat": [[77.38, 18.47], [77.46, 18.39]],
        "fake": True,
    }, indent=1))
    (out / "layers.json").write_text(json.dumps([
        {"id": "slope", "file": "layers/slope.png", "label": "Slope",
         "legend": [{"color": "#fcfdbf", "label": "5°"}, {"color": "#de4968", "label": f"{cfg.SLOPE_SOFT_DEG:g}° soft limit"},
                    {"color": "#000004", "label": f"{cfg.SLOPE_HARD_DEG:g}°+ no-go"}]},
        {"id": "sand", "file": "layers/sand.png", "label": "Soft sand (low thermal inertia)",
         "legend": [{"color": "#fad959", "label": "soft sand"}]},
        {"id": "minerals", "file": "layers/minerals.png", "label": "Minerals (CRISM)",
         "legend": [{"color": "#33bf8c", "label": "carbonate"}, {"color": "#598cf2", "label": "Fe/Mg clay"},
                    {"color": "#d959bf", "label": "olivine"}]},
    ], indent=1))

    stops[0].update({"why": "Pressurized habitat on flat ground", "expect": "", "photos": [], "sol": 0})
    stops[1].update({
        "why": "FAKE: layered delta-front sediments where CRISM shows carbonates, which form in water and can preserve signs of past life.",
        "expect": "FAKE: fine layers in the outcrop face; sample the carbonate-rich band near the base.",
        "minerals": "carbonate, Fe/Mg clay", "rock_unit": "FAKE: delta front (Dl)",
        "photos": ["https://mars.nasa.gov/mars2020-raw-images/pub/ods/surface/sol/00550/ids/edr/browse/ncam/NLF_0550_0715749396_532ECM_N0261222NCAM00709_01_295J01_320.jpg"],
        "sol": 550})
    stops[2].update({
        "why": "FAKE: Three Forks sample depot. Retrieve the cached tubes for return to Earth.",
        "expect": "FAKE: 10 sample tubes on flat ground, about 5 m apart.",
        "minerals": "", "rock_unit": "FAKE: crater floor (Cf)", "photos": [], "sol": 650})

    env = {"dust": "low", "solar_alert": False,
           "radiation_note": "FAKE: dose rate is a Curiosity RAD stand-in from Gale Crater",
           "suit": {"budget_min": cfg.SUIT_BUDGET_MIN, "reserve_min": cfg.SUIT_RESERVE_MIN},
           "assumptions": ["FAKE env.json: Story replaces this file",
                           "Two crew walk with one support rover",
                           f"Suit time budget {cfg.SUIT_BUDGET_MIN} min with a {cfg.SUIT_RESERVE_MIN} min reserve"],
           "fake": True}
    (out / "env.json").write_text(json.dumps(env, indent=1))

    routes, th_bytes, _, snapped, _ = engine.plan_routes(layers, stops)
    engine.finalize(routes, cfg.SUIT_BUDGET_MIN, cfg.SUIT_RESERVE_MIN)
    routes["fake"] = True
    engine.write_outputs(out, routes, th_bytes, (size, size))
    px = {s["id"]: s["px"] for s in snapped}
    for s in stops:
        s["px"] = px[s["id"]]
    (out / "stops.json").write_text(json.dumps(stops, indent=1, ensure_ascii=False))
    print("wrote fake contract files to", out.resolve())


if __name__ == "__main__":
    main(*sys.argv[1:2])
