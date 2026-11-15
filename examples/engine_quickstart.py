"""Reference engine: shows every way the Engine is expected to use data/.

Run:  .venv/bin/python examples/engine_quickstart.py
Writes to examples/out/ (NOT data/), so it never overwrites the real Engine's files.
Every function here is described in docs/engine_guide.md.
"""
import json
from pathlib import Path
import numpy as np
from skimage.graph import route_through_array, MCP_Geometric

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = Path(__file__).resolve().parent / "out"; OUT.mkdir(exist_ok=True)
PIXEL_M = 2.0
BLOCKED = 1e9   # skimage needs finite costs; this is "never take this cell"


# ---------------------------------------------------------------- 1. load
def load():
    g = np.load(DATA / "grids.npz")
    grids = {k: g[k] for k in g.files}
    grids["slope_deg"] = grids["slope_deg"].astype(np.float32)   # stored as float16
    grids["rough_m"] = grids["rough_m"].astype(np.float32)
    params = {k: v["value"] for k, v in json.loads((DATA / "safety_params.json").read_text())["params"].items()}
    site = json.loads((DATA / "site.json").read_text())
    tubes = json.loads((DATA / "depot.json").read_text())
    return grids, params, site, tubes


def rc(px):
    """Pixel [x, y] (data files) -> array index (row, col). The ONLY place this conversion happens."""
    return int(round(px[1])), int(round(px[0]))


def xy(row, col):
    return [int(col), int(row)]


# ---------------------------------------------------------------- 2. cost grid
def speed_factor_terrain(grids, P):
    """Multiplier from ground type (sand, rocky). 1.0 = normal ground."""
    f = np.ones(grids["sand"].shape, np.float32)
    f[grids["sand"] == 1] *= P["speed_factor_sand_small"]
    f[grids["sand"] == 2] *= P["speed_factor_sand_large"]
    f[grids["rocky"] == 1] *= P["speed_factor_rocky"]
    return f


def tobler(v_flat, grade):
    """Tobler-shaped speed (km/h), normalized so grade 0 -> v_flat. grade = rise/run, signed (+ uphill)."""
    return v_flat * np.exp(-3.5 * np.abs(grade + 0.05)) / np.exp(-3.5 * 0.05)


def cost_grid(grids, P, extra_nogo=None):
    """Minutes to cross one 2 m cell, for ROUTING (direction-free).
    Uses the worse of uphill/downhill at the cell's max slope, so routing is conservative."""
    g = np.tan(np.radians(grids["slope_deg"]))
    v = np.minimum(tobler(P["walk_speed_flat_kmh"], g), tobler(P["walk_speed_flat_kmh"], -g))
    v = v * speed_factor_terrain(grids, P)
    cost = (PIXEL_M / 1000) / v * 60
    nogo = grids["nogo"].astype(bool)
    if extra_nogo is not None:
        nogo = nogo | extra_nogo
    cost[nogo] = BLOCKED
    return cost.astype(np.float64)


# ---------------------------------------------------------------- 3. one leg
def route_leg(cost, a_px, b_px):
    path, _ = route_through_array(cost, rc(a_px), rc(b_px), fully_connected=True, geometric=True)
    p = np.array(path)
    if (cost[p[:, 0], p[:, 1]] >= BLOCKED).any():
        raise ValueError(f"no safe path {a_px} -> {b_px}")
    return p


def leg_time_min(p, grids, P):
    """Accurate walking time along a path: signed grade from elevation, direction matters (Tobler)."""
    z = grids["elevation_m"]
    f = speed_factor_terrain(grids, P)
    step = np.hypot(*np.diff(p, axis=0).T) * PIXEL_M               # 2 m or 2.83 m
    rise = np.diff(z[p[:, 0], p[:, 1]])
    v = tobler(P["walk_speed_flat_kmh"], rise / step) * f[p[1:, 0], p[1:, 1]]
    return float(((step / 1000) / v * 60).sum()), float(step.sum())


def why_lines(p, a_px, b_px, grids):
    """Explain the route: what a straight line would have crossed that the route avoids."""
    n = int(max(abs(b_px[0] - a_px[0]), abs(b_px[1] - a_px[1]))) + 1
    cols = np.linspace(a_px[0], b_px[0], n).round().astype(int)
    rows = np.linspace(a_px[1], b_px[1], n).round().astype(int)
    out = []
    for name, mask in [("steep or rough ground (no-go)", grids["nogo"] == 1),
                       ("large sand ridges", grids["sand"] == 2),
                       ("blocky rock", grids["rocky"] == 1)]:
        straight = mask[rows, cols].sum() * PIXEL_M
        routed = mask[p[:, 0], p[:, 1]].sum() * PIXEL_M
        if straight - routed >= 20:
            out.append(f"avoids {straight - routed:.0f} m of {name}")
    return out


# ---------------------------------------------------------------- 4. variants
def plan(cost, grids, P, stops, order, work_min):
    legs, path, total_min, total_m, why = [], [], 0.0, 0.0, []
    for a, b in zip(order[:-1], order[1:]):
        p = route_leg(cost, stops[a], stops[b])
        t, d = leg_time_min(p, grids, P)
        w = why_lines(p, stops[a], stops[b], grids)
        legs.append({"from": a, "to": b, "distance_m": round(d), "walk_min": round(t, 1), "why": w})
        path += [xy(r, c) for r, c in (p if not path else p[1:])]
        total_min += t + work_min.get(b, 0); total_m += d; why += [f"{a}->{b}: {x}" for x in w]
    return {"stops": order, "distance_m": round(total_m), "est_min": round(total_min), "legs": legs, "path": path, "why": why}


# ---------------------------------------------------------------- 5. time home
def time_home(cost, home_px):
    """Minutes to walk home from every cell (routing cost). Also returns the MCP object for paths home."""
    m = MCP_Geometric(cost, fully_connected=True)
    t, _ = m.find_costs([rc(home_px)])
    t[t >= BLOCKED] = np.inf
    return t, m


def path_home(mcp, from_px):
    """Abort case: safest path home from anywhere, reusing the time-home search (no new search)."""
    return [xy(r, c) for r, c in reversed(mcp.traceback(rc(from_px)))]


def export_time_home(t, path, factor=2):
    """uint16 minutes, 65535 = unreachable, row-major, little-endian. factor=2 -> 4 m cells (1000x1000, 2 MB)."""
    h, w = t.shape
    tt = t.reshape(h // factor, factor, w // factor, factor).max(axis=(1, 3))   # max = conservative
    out = np.where(np.isfinite(tt), np.minimum(np.ceil(tt), 65534), 65535).astype("<u2")
    out.tofile(path)
    return {"file": path.name, "dtype": "uint16 little-endian", "shape": list(out.shape), "cell_m": PIXEL_M * factor,
            "unreachable": 65535, "index": f"value[row][col], row = floor(y_px / {factor}), col = floor(x_px / {factor})"}


# ---------------------------------------------------------------- 6. live hazard (rover CV)
def add_hazard(extra_nogo, center_px, radius_m, buffer_m=4.0):
    """Rover-confirmed hazard -> extra no-go disk (+ safety buffer). Only ever ADD, never remove orbital hazards."""
    r = (radius_m + buffer_m) / PIXEL_M
    rr, cc = np.ogrid[:extra_nogo.shape[0], :extra_nogo.shape[1]]
    extra_nogo |= (cc - center_px[0]) ** 2 + (rr - center_px[1]) ** 2 <= r ** 2
    return extra_nogo


# ---------------------------------------------------------------- demo
def main():
    grids, P, site, tubes = load()
    stops = {"H": site["habitat"]["px"], "A": site["stop_a"]["px"], "B": site["depot_center"]["px"]}
    work = {"A": P["work_min_science_stop"], "B": P["work_min_depot"]}
    cost = cost_grid(grids, P)
    for k, p in stops.items():
        assert cost[rc(p)] < BLOCKED, f"stop {k} is on a no-go cell"

    budget = P["suit_budget_min"] - P["reserve_min"]
    variants = []
    for vid, order in [("full", ["H", "A", "B", "H"]), ("skipA", ["H", "B", "H"])]:
        v = plan(cost, grids, P, stops, order, work) | {"id": vid}
        v["fits_budget"] = v["est_min"] <= budget
        variants.append(v)
        print(f"{vid}: {v['distance_m']} m, {v['est_min']} min (budget {budget}), why: {v['why'] or '-'}")

    t, mcp = time_home(cost, stops["H"])
    meta = export_time_home(t, OUT / "time_home.bin")
    print(f"time home from A: {t[rc(stops['A'])]:.0f} min, from B: {t[rc(stops['B'])]:.0f} min")
    home = path_home(mcp, stops["B"]); print(f"abort path home from depot: {len(home)} cells")

    # live hazard on the H->A leg: block a 15 m boulder in the middle of the full route and replan
    mid = variants[0]["path"][len(variants[0]["path"]) // 6]
    extra = add_hazard(np.zeros_like(grids["nogo"], bool), mid, radius_m=15)
    cost2 = cost_grid(grids, P, extra_nogo=extra)
    v2 = plan(cost2, grids, P, stops, ["H", "A", "B", "H"], work)
    before = {tuple(c) for c in variants[0]["path"]}; changed = sum(tuple(c) not in before for c in v2["path"])
    crosses = sum(extra[c[1], c[0]] for c in v2["path"])
    print(f"reroute around hazard at {mid}: {changed} cells re-routed, hazard cells crossed: {crosses}, "
          f"time {v2['est_min']} min ({v2['est_min'] - variants[0]['est_min']:+} min)")
    assert crosses == 0

    (OUT / "routes.json").write_text(json.dumps({"variants": [{k: v[k] for k in
        ("id", "stops", "distance_m", "est_min", "path", "why", "legs", "fits_budget")} for v in variants],
        "time_home_file": meta["file"], "time_home": meta}, indent=1))
    print(f"wrote {OUT.relative_to(ROOT)}/routes.json and time_home.bin")


if __name__ == "__main__":
    main()
