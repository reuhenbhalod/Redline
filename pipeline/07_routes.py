"""Step 7 (Engine): cost grid, legs, route variants, replan options, time-home grid.

Real data from the Data pipeline (data/grids.npz, site.json, safety_params.json, photos.json):
    python pipeline/07_routes.py --preview          # -> data/routes.json, data/time_home.bin, data/stops.json

Fake hilly terrain (no Data needed):
    python pipeline/07_routes.py --fake --preview
    python pipeline/07_routes.py --fake --scenario sand_maze --preview

Older .npy grid folder:
    python pipeline/07_routes.py --grid work/grid --stops data/stops.json

If pathfinding is too slow:
    python pipeline/07_routes.py --coarsen 3        # plan on a 6 m grid, output full-grid pixels
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import engine_config as cfg  # noqa: E402
import engine  # noqa: E402
import fake_terrain  # noqa: E402


def load_env_budget(env_path: Path):
    if env_path.exists():
        suit = json.loads(env_path.read_text()).get("suit", {})
        if suit.get("budget_min"):
            return float(suit["budget_min"]), float(suit.get("reserve_min", cfg.SUIT_RESERVE_MIN))
    return float(cfg.SUIT_BUDGET_MIN), float(cfg.SUIT_RESERVE_MIN)


def write_back_stops(stops_path: Path, snapped: list[dict]) -> list[str]:
    """Engine owns stops[].px; keep every other field (Story's text) as it is."""
    original = json.loads(stops_path.read_text())
    by_id = {s["id"]: s["px"] for s in snapped}
    changed = []
    for s in original:
        if s["id"] in by_id and list(s["px"]) != by_id[s["id"]]:
            changed.append(f"{s['id']}: {s['px']} -> {by_id[s['id']]}")
            s["px"] = by_id[s["id"]]
    if changed:
        stops_path.write_text(json.dumps(original, indent=1, ensure_ascii=False))
    return changed


def write_preview(path: Path, layers: engine.Layers, routes: dict, th: np.ndarray, cost: np.ndarray):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(1, 3, figsize=(24, 8))
    ax = axes[0]
    ax.imshow(layers.slope_deg, cmap="gray_r", vmin=0, vmax=cfg.SLOPE_HARD_DEG)
    ax.imshow(np.ma.masked_less(layers.sand, cfg.SAND_SOFT_MIN), cmap="autumn", alpha=0.35)
    ax.imshow(np.ma.masked_where(~engine.blocked_mask(layers), np.ones(layers.shape)), cmap="Reds", alpha=0.6, vmin=0, vmax=1)
    for v, color in zip(routes["variants"], ["tab:cyan", "tab:green", "tab:purple"]):
        p = np.array(v["path"])
        ax.plot(p[:, 0], p[:, 1], color=color, lw=2, label=f"{v['id']}: {v['distance_m']:.0f} m, {v['est_min']:.0f} min")
        for c in v.get("checkpoints", []):
            ax.plot(*c["px"], marker="|", color=color, ms=10, mew=2)
        hz = v.get("hazard_demo")
        if hz:
            ax.add_patch(plt.Circle(hz["hazard_px"], hz["radius_px"], color="tab:red", fill=False, lw=2))
            q = np.array(hz["path"])
            ax.plot(q[:, 0], q[:, 1], color="tab:red", lw=1.5, ls="--", label=f"hazard detour +{hz['extra_min']:.0f} min")
    for sid, (x, y) in routes["stops_px"].items():
        ax.plot(x, y, "wo", ms=9, mec="k")
        ax.annotate(sid, (x, y), xytext=(6, 6), textcoords="offset points", color="w", weight="bold")
    ax.set_title("Routes over slope (gray), soft sand (orange), no-go (red); ticks = checkpoints")
    ax.legend(loc="lower right")

    im = axes[1].imshow(np.log10(np.where(np.isfinite(cost), cost, np.nan)), cmap="magma")
    axes[1].set_title("Cost grid (log10; blank = no-go incl. buffer)")
    fig.colorbar(im, ax=axes[1], shrink=0.8)

    im = axes[2].imshow(np.where(np.isfinite(th), th, np.nan), cmap="viridis")
    axes[2].set_title("Minutes to walk home")
    fig.colorbar(im, ax=axes[2], shrink=0.8)
    fig.tight_layout()
    fig.savefig(path, dpi=70)
    plt.close(fig)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fake", action="store_true", help="generate fake terrain into work/fake and route on it")
    ap.add_argument("--scenario", default="default", choices=list(fake_terrain.SCENARIOS), help="fake terrain scenario")
    ap.add_argument("--size", type=int, default=cfg.GRID_SIZE_PX, help="fake grid size (px)")
    ap.add_argument("--data", default="data", help="Data pipeline output folder (grids.npz, site.json, ...)")
    ap.add_argument("--grid", default=None, help="folder with slope_deg.npy [sand, rough, nogo, dtm].npy (instead of --data)")
    ap.add_argument("--stops", default="data/stops.json")
    ap.add_argument("--env", default="data/env.json", help="read suit budget from here if present")
    ap.add_argument("--bounds", default="data/bounds.json", help="check the grid against this if present")
    ap.add_argument("--out", default=None, help="output folder (default: data, or work/fake/out with --fake)")
    ap.add_argument("--coarsen", type=int, default=1, help="plan on a grid coarsened by this factor")
    ap.add_argument("--no-write-stops", action="store_true", help="don't write snapped px back into stops.json")
    ap.add_argument("--preview", action="store_true", help="also write routes_preview.png for eyeballing")
    args = ap.parse_args(argv)

    real = not args.fake and args.grid is None and (Path(args.data) / "grids.npz").exists()
    rcfg = cfg
    timings = {}
    t0 = time.time()
    if real:
        grid = Path(args.data) / "grids.npz"
        layers, stops, rcfg, info = engine.load_real(args.data)
        out = Path(args.out or args.data)
        engine.check_bounds(json.loads((Path(args.data) / "bounds.json").read_text()), layers, rcfg)
    else:
        if args.fake:
            fake_dir = Path("work/fake") / ("" if args.scenario == "default" else args.scenario)
            grid = fake_terrain.write_fake(fake_dir, size=args.size, scenario=args.scenario)
            stops_path = grid / "stops.json"
            out = Path(args.out or fake_dir / "out")
            bounds_path = None
        else:
            grid, stops_path, out = Path(args.grid or "work/grid"), Path(args.stops), Path(args.out or "data")
            bounds_path = Path(args.bounds)
        layers = engine.load_layers(grid)
        if bounds_path and bounds_path.exists():
            engine.check_bounds(json.loads(bounds_path.read_text()), layers)
        stops = json.loads(Path(stops_path).read_text())
    timings["load"] = time.time() - t0

    t1 = time.time()
    if args.coarsen > 1:
        routes, th_bytes, th, snapped, _ = engine.plan_routes_coarse(layers, stops, args.coarsen, rcfg)
    else:
        routes, th_bytes, th, snapped, _ = engine.plan_routes(layers, stops, rcfg)
    timings["plan"] = time.time() - t1

    if real:
        budget, reserve = float(rcfg.SUIT_BUDGET_MIN), float(rcfg.SUIT_RESERVE_MIN)
    else:
        budget, reserve = load_env_budget(Path(args.env))
    engine.finalize(routes, budget, reserve)
    if real:
        routes["sources"] = ["data/grids.npz", "data/safety_params.json", "data/site.json"]
    size = engine.write_outputs(out, routes, th_bytes, (layers.shape[1], layers.shape[0]), rcfg)
    if real:
        # Engine owns stops.json (positions from site.json, photos from photos.json, snapped px)
        (out / "stops.json").write_text(json.dumps(snapped, indent=1, ensure_ascii=False))
        moved = [w for w in routes["warnings"] if "moved" in w]
    else:
        moved = [] if args.no_write_stops else write_back_stops(Path(stops_path), snapped)
    if args.preview:
        cost = engine.cost_grid(layers, rcfg) if args.coarsen == 1 else engine.cost_grid(engine.coarsen_layers(layers, args.coarsen), rcfg)
        prev_dir = Path("pipeline/qa") if real else out
        prev_dir.mkdir(parents=True, exist_ok=True)
        write_preview(prev_dir / "routes_preview.png", layers, routes, th if args.coarsen == 1 else np.kron(th, np.ones((args.coarsen,) * 2)), cost)

    print(f"grid {layers.shape[1]}x{layers.shape[0]} from {grid}: load {timings['load']:.1f}s, plan {timings['plan']:.1f}s")
    if timings["plan"] > 60 and args.coarsen == 1:
        print("  SLOW: try --coarsen 3 (6 m grid)")
    for v in routes["variants"]:
        print(f"  {v['id']:6s} {'-'.join(v['stops']):10s} {v['distance_m']:7.0f} m  {v['est_min']:6.1f} min"
              f"  max slope {v['max_slope_deg']:.1f}°  fits budget: {v['fits_budget']}"
              f"  checkpoints: {len(v.get('checkpoints', []))}")
        for w in v["why"]:
            print(f"         · {w}")
        if "hazard_demo" in v:
            hz = v["hazard_demo"]
            print(f"         ! hazard demo on {'→'.join(hz['leg'])}: detour +{hz['extra_m']:.0f} m, +{hz['extra_min']:.1f} min")
    for w in routes["warnings"]:
        print("  WARNING:", w)
    for m in moved:
        print("  stops.json px updated:", m)
    if real:
        print(f"wrote {out / 'stops.json'}")
    print(f"wrote {out / 'routes.json'} ({size / 1024:.0f} KB), {out / 'time_home.bin'}"
          + (f", {'pipeline/qa' if real else out}/routes_preview.png" if args.preview else ""))


if __name__ == "__main__":
    main()
