"""Step 4: cost grid, legs, route variants, time-home grid -> routes.json + time_home.bin.

Real layers (from Data, steps 1-3):
    python pipeline/04_routes.py --grid work/grid --stops data/stops.json --out data

Fake hilly terrain (no Data needed):
    python pipeline/04_routes.py --fake --preview
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import config as cfg  # noqa: E402
import engine  # noqa: E402
import fake_terrain  # noqa: E402


def load_env_budget(env_path: Path):
    if env_path.exists():
        suit = json.loads(env_path.read_text()).get("suit", {})
        if suit.get("budget_min"):
            return float(suit["budget_min"]), float(suit.get("reserve_min", cfg.SUIT_RESERVE_MIN))
    return float(cfg.SUIT_BUDGET_MIN), float(cfg.SUIT_RESERVE_MIN)


def write_preview(path: Path, layers: engine.Layers, routes: dict, th: np.ndarray):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(1, 2, figsize=(16, 8))
    ax = axes[0]
    ax.imshow(layers.slope_deg, cmap="gray_r", vmin=0, vmax=cfg.SLOPE_HARD_DEG)
    ax.imshow(np.ma.masked_less(layers.sand, cfg.SAND_SOFT_MIN), cmap="autumn", alpha=0.35)
    ax.imshow(np.ma.masked_where(~engine.blocked_mask(layers), np.ones(layers.shape)), cmap="Reds", alpha=0.6, vmin=0, vmax=1)
    for v, color in zip(routes["variants"], ["tab:cyan", "tab:green", "tab:purple"]):
        p = np.array(v["path"])
        ax.plot(p[:, 0], p[:, 1], color=color, lw=2, label=f"{v['id']}: {v['distance_m']:.0f} m, {v['est_min']:.0f} min")
    for sid, (x, y) in routes["stops_px"].items():
        ax.plot(x, y, "wo", ms=9, mec="k")
        ax.annotate(sid, (x, y), xytext=(6, 6), textcoords="offset points", color="w", weight="bold")
    ax.set_title("Routes over slope (gray), soft sand (orange), no-go (red)")
    ax.legend(loc="lower right")

    im = axes[1].imshow(np.where(np.isfinite(th), th, np.nan), cmap="viridis")
    axes[1].set_title("Minutes to walk home")
    fig.colorbar(im, ax=axes[1], shrink=0.8)
    fig.tight_layout()
    fig.savefig(path, dpi=80)
    plt.close(fig)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fake", action="store_true", help="generate fake terrain into work/fake and route on it")
    ap.add_argument("--size", type=int, default=cfg.GRID_SIZE_PX, help="fake grid size (px)")
    ap.add_argument("--grid", default="work/grid", help="folder with slope_deg.npy [sand, rough, nogo].npy")
    ap.add_argument("--stops", default="data/stops.json")
    ap.add_argument("--env", default="data/env.json", help="read suit budget from here if present")
    ap.add_argument("--out", default=None, help="output folder (default: data, or work/fake/out with --fake)")
    ap.add_argument("--preview", action="store_true", help="also write routes_preview.png for eyeballing")
    args = ap.parse_args(argv)

    if args.fake:
        grid = fake_terrain.write_fake("work/fake", size=args.size)
        stops_path = grid / "stops.json"
        out = Path(args.out or "work/fake/out")
    else:
        grid, stops_path, out = Path(args.grid), Path(args.stops), Path(args.out or "data")
    out.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    layers = engine.load_layers(grid)
    stops = json.loads(Path(stops_path).read_text())
    routes, th_bytes, th, _, _ = engine.plan_routes(layers, stops)

    budget, reserve = load_env_budget(Path(args.env))
    for v in routes["variants"]:
        v["fits_budget"] = v["est_min"] + reserve <= budget
    routes["params"]["suit_budget_min"] = budget
    routes["params"]["suit_reserve_min"] = reserve

    (out / "routes.json").write_text(json.dumps(routes, indent=1, ensure_ascii=False))
    (out / "time_home.bin").write_bytes(th_bytes)
    if args.preview:
        write_preview(out / "routes_preview.png", layers, routes, th)

    print(f"grid {layers.shape[1]}x{layers.shape[0]} from {grid}, done in {time.time() - t0:.1f}s")
    for v in routes["variants"]:
        print(f"  {v['id']:6s} {'-'.join(v['stops']):10s} {v['distance_m']:7.0f} m  {v['est_min']:6.1f} min"
              f"  max slope {v['max_slope_deg']:.1f}°  fits budget: {v['fits_budget']}")
        for w in v["why"]:
            print(f"         · {w}")
    for w in routes["warnings"]:
        print("  WARNING:", w)
    print(f"wrote {out / 'routes.json'}, {out / 'time_home.bin'}" + (", routes_preview.png" if args.preview else ""))


if __name__ == "__main__":
    main()
