"""Compare cost-weight settings side by side (implementation plan 11.3).

    python pipeline/tune_weights.py --fake                 # fake terrain
    python pipeline/tune_weights.py --grid work/grid --stops data/stops.json

Writes work/tune/weights.png (one panel per weight set) and prints a table:
distance, walking time, meters of soft sand and steep slope on the route.
Pick a set, copy its weights into config.py, and record why in the plan.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import config as cfg  # noqa: E402
import engine  # noqa: E402
import fake_terrain  # noqa: E402

WEIGHT_SETS = {
    "current": {},
    "distance-first": {"W_SLOPE": 1.0, "W_SAND": 1.0, "W_ROUGH": 0.5, "W_MARGIN": 0.5},
    "avoid-sand": {"W_SAND": 15.0},
    "avoid-slope": {"W_SLOPE": 10.0},
    "cautious": {"W_SLOPE": 8.0, "W_SAND": 12.0, "W_ROUGH": 4.0, "W_MARGIN": 4.0, "NOGO_BUFFER_PX": 4},
}


def route_stats(seq, solver, terrain):
    c = terrain.cfg
    L = terrain.layers
    dist = walk = sand_m = steep_m = 0.0
    paths = []
    for a, b in zip(seq, seq[1:]):
        leg = solver.leg(a, b)
        p = leg.path_rc
        step = np.r_[0, np.hypot(*np.diff(p, axis=0).T)] * c.PIXEL_M
        sand_m += step[np.nan_to_num(L.sand[p[:, 0], p[:, 1]]) >= c.SAND_SOFT_MIN].sum()
        steep_m += step[np.nan_to_num(L.slope_deg[p[:, 0], p[:, 1]]) >= c.SLOPE_SOFT_DEG].sum()
        dist += leg.distance_m
        walk += leg.walk_min
        paths.append(p)
    return {"distance_m": dist, "walk_min": walk, "sand_m": sand_m, "steep_m": steep_m}, np.vstack(paths)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fake", action="store_true")
    ap.add_argument("--scenario", default="default", choices=list(fake_terrain.SCENARIOS))
    ap.add_argument("--grid", default="work/grid")
    ap.add_argument("--stops", default="data/stops.json")
    ap.add_argument("--variant", default="full")
    ap.add_argument("--out", default="work/tune")
    args = ap.parse_args(argv)

    if args.fake:
        grid = fake_terrain.write_fake(Path("work/fake") / ("" if args.scenario == "default" else args.scenario),
                                       scenario=args.scenario)
        stops_path = grid / "stops.json"
    else:
        grid, stops_path = Path(args.grid), Path(args.stops)
    layers = engine.load_layers(grid)
    stops_list = json.loads(stops_path.read_text())
    seq = next(v["stops"] for v in cfg.VARIANTS if v["id"] == args.variant)

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    n = len(WEIGHT_SETS)
    fig, axes = plt.subplots(1, n, figsize=(5 * n, 5.4))
    print(f"{'set':16s} {'dist m':>8s} {'walk min':>9s} {'sand m':>7s} {'steep m':>8s}")
    for ax, (name, over) in zip(axes, WEIGHT_SETS.items()):
        c = engine.config_copy(cfg, **over)
        terrain = engine.build_terrain(layers, c)
        st = [dict(s) for s in stops_list]
        engine.snap_stops(st, terrain.walk_blocked)
        solver = engine.LegSolver(terrain, {s["id"]: s for s in st})
        stats, path = route_stats(seq, solver, terrain)
        print(f"{name:16s} {stats['distance_m']:8.0f} {stats['walk_min']:9.1f} {stats['sand_m']:7.0f} {stats['steep_m']:8.0f}")
        ax.imshow(layers.slope_deg, cmap="gray_r", vmin=0, vmax=c.SLOPE_HARD_DEG)
        ax.imshow(np.ma.masked_less(layers.sand, c.SAND_SOFT_MIN), cmap="autumn", alpha=0.35)
        ax.plot(path[:, 1], path[:, 0], color="tab:cyan", lw=1.5)
        for s in st:
            ax.plot(*s["px"], "wo", ms=6, mec="k")
        ax.set_title(f"{name}\n{stats['distance_m']:.0f} m, {stats['walk_min']:.0f} min walk, "
                     f"{stats['sand_m']:.0f} m sand", fontsize=9)
        ax.set_axis_off()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    fig.tight_layout()
    fig.savefig(out / "weights.png", dpi=70)
    print("wrote", out / "weights.png")


if __name__ == "__main__":
    main()
