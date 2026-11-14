"""Route engine: cost grid, legs, route variants, time-home grid.

Runs offline. Nothing here runs in the browser.

Conventions:
  * Arrays are indexed [row, col] = [y, x].
  * Everything written to JSON is pixel [x, y] on the grid (the data contract).
  * North is up (row 0 is the northern edge), as in the equirectangular DTM.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.ndimage import distance_transform_edt
from skimage.draw import line as draw_line
from skimage.graph import MCP_Geometric
from skimage.measure import approximate_polygon

import config as default_cfg


# --- Inputs ------------------------------------------------------------------

@dataclass
class Layers:
    """Engine inputs, all the same (H, W) shape and aligned cell for cell."""
    slope_deg: np.ndarray   # float, degrees; NaN = missing data
    sand: np.ndarray        # float 0..1, 1 = soft sand
    rough: np.ndarray       # float 0..1, 1 = very rough ground
    nogo: np.ndarray        # bool, True = never walk here (data gaps, known hazards)

    @property
    def shape(self):
        return self.slope_deg.shape


def load_layers(grid_dir: str | Path) -> Layers:
    """Load engine inputs from .npy files. Only slope_deg.npy is required."""
    d = Path(grid_dir)
    slope = np.load(d / "slope_deg.npy").astype(np.float32)

    def opt(name, fill, dtype):
        p = d / f"{name}.npy"
        if p.exists():
            a = np.load(p).astype(dtype)
            if a.shape != slope.shape:
                raise ValueError(f"{p} has shape {a.shape}, expected {slope.shape}")
            return a
        return np.full(slope.shape, fill, dtype=dtype)

    return Layers(
        slope_deg=slope,
        sand=opt("sand", 0.0, np.float32),
        rough=opt("rough", 0.0, np.float32),
        nogo=opt("nogo", False, bool),
    )


# --- Grids -------------------------------------------------------------------

def blocked_mask(layers: Layers, cfg=default_cfg) -> np.ndarray:
    """True where the crew may never walk."""
    s = layers.slope_deg
    return (
        layers.nogo
        | ~np.isfinite(s)
        | (np.nan_to_num(s, nan=90.0) >= cfg.SLOPE_HARD_DEG)
        | ~np.isfinite(layers.sand)
        | ~np.isfinite(layers.rough)
    )


def cost_grid(layers: Layers, cfg=default_cfg) -> np.ndarray:
    """Walking cost per cell (unitless, >= 1). No-go cells are +inf."""
    slope = np.nan_to_num(layers.slope_deg, nan=0.0)
    sand = np.nan_to_num(layers.sand, nan=0.0).clip(0, 1)
    rough = np.nan_to_num(layers.rough, nan=0.0).clip(0, 1)
    cost = (
        1.0
        + cfg.W_SLOPE * (slope / cfg.SLOPE_SOFT_DEG) ** 2
        + cfg.W_SAND * sand
        + cfg.W_ROUGH * rough
    ).astype(np.float64)
    cost[blocked_mask(layers, cfg)] = np.inf
    return cost


def speed_m_per_min(slope_deg, cfg=default_cfg):
    """Suited walking speed on a slope (Tobler shape, symmetric up/down)."""
    s = np.clip(np.nan_to_num(slope_deg, nan=0.0), 0, cfg.SLOPE_HARD_DEG)
    return cfg.V_FLAT_KMH * 1000 / 60 * np.exp(-cfg.TOBLER_K * np.tan(np.radians(s)))


def time_grid(layers: Layers, cfg=default_cfg) -> np.ndarray:
    """Minutes to cross one cell edge-to-edge (axis-aligned). No-go = +inf."""
    t = (cfg.PIXEL_M / speed_m_per_min(layers.slope_deg, cfg)).astype(np.float64)
    t[blocked_mask(layers, cfg)] = np.inf
    return t


def time_home(layers: Layers, habitat_xy, cfg=default_cfg) -> np.ndarray:
    """Fastest walking time (minutes) from every cell back to the habitat.

    Walking time is symmetric in this model, so a single Dijkstra from the
    habitat gives the time home from everywhere. Unreachable cells are +inf.
    """
    x, y = habitat_xy
    mcp = MCP_Geometric(time_grid(layers, cfg), fully_connected=True)
    minutes, _ = mcp.find_costs([(y, x)])
    return minutes


def encode_time_home(minutes: np.ndarray, stride: int):
    """Downsample and pack as little-endian uint16 tenths of a minute (65535 = unreachable)."""
    m = minutes[::stride, ::stride]
    out = np.full(m.shape, 65535, dtype="<u2")
    ok = np.isfinite(m)
    out[ok] = np.clip(np.round(m[ok] * 10), 0, 65534).astype("<u2")
    meta = {
        "width": int(m.shape[1]),
        "height": int(m.shape[0]),
        "stride_px": int(stride),
        "dtype": "uint16le",
        "scale_min": 0.1,
        "nodata": 65535,
        "index": "value at grid pixel [x, y] = data[(y // stride) * width + (x // stride)] * scale_min",
    }
    return out, meta


# --- Stops -------------------------------------------------------------------

def snap_stops(stops: list[dict], blocked: np.ndarray) -> list[str]:
    """Move any stop sitting on a no-go cell to the nearest walkable cell. Returns warnings."""
    if blocked.all():
        raise ValueError("every cell is no-go")
    _, (iy, ix) = distance_transform_edt(blocked, return_indices=True)
    warnings = []
    h, w = blocked.shape
    for s in stops:
        x, y = (int(round(v)) for v in s["px"])
        if not (0 <= x < w and 0 <= y < h):
            raise ValueError(f"stop {s['id']} at {s['px']} is outside the {w}x{h} grid")
        if blocked[y, x]:
            nx, ny = int(ix[y, x]), int(iy[y, x])
            warnings.append(f"stop {s['id']} was on a no-go cell, moved from [{x}, {y}] to [{nx}, {ny}]")
            x, y = nx, ny
        s["px"] = [x, y]
    return warnings


def work_min(stop: dict, cfg=default_cfg) -> float:
    v = stop.get("work_min")
    if v:  # missing or the 0 placeholder -> config default
        return float(v)
    return float(cfg.DEFAULT_WORK_MIN.get(stop.get("kind", ""), 0))


# --- Legs --------------------------------------------------------------------

@dataclass
class Leg:
    a: str
    b: str
    path_rc: np.ndarray       # (N, 2) [row, col], start to end
    distance_m: float
    walk_min: float
    max_slope_deg: float
    cost: float


def path_metrics(path_rc: np.ndarray, layers: Layers, cfg=default_cfg):
    """Distance (m), walking time (min) and max slope along a cell path."""
    p = np.asarray(path_rc)
    if len(p) < 2:
        return 0.0, 0.0, float(np.nan_to_num(layers.slope_deg[p[0, 0], p[0, 1]])) if len(p) else 0.0
    step_m = np.hypot(*np.diff(p, axis=0).T) * cfg.PIXEL_M
    s = np.nan_to_num(layers.slope_deg[p[:, 0], p[:, 1]], nan=0.0)
    seg_slope = (s[:-1] + s[1:]) / 2
    walk = float(np.sum(step_m / speed_m_per_min(seg_slope, cfg)))
    return float(step_m.sum()), walk, float(s.max())


def solve_legs(cost: np.ndarray, layers: Layers, stops: dict[str, dict], pairs, cfg=default_cfg) -> dict:
    """Cheapest path for each (a, b) pair. One Dijkstra per distinct start stop.

    Cost is isotropic, so (b, a) is (a, b) reversed and is reused.
    """
    legs: dict[tuple[str, str], Leg] = {}
    by_start: dict[str, set[str]] = {}
    for a, b in pairs:
        if (b, a) in legs or (a, b) in legs:
            continue
        by_start.setdefault(a, set()).add(b)

    for a, ends in by_start.items():
        ax, ay = stops[a]["px"]
        mcp = MCP_Geometric(cost, fully_connected=True)
        cum, _ = mcp.find_costs([(ay, ax)])
        for b in ends:
            if (b, a) in legs:
                continue
            bx, by = stops[b]["px"]
            if not np.isfinite(cum[by, bx]):
                raise RuntimeError(f"no safe path from {a} to {b}")
            path = np.array(mcp.traceback((by, bx)))
            dist, walk, smax = path_metrics(path, layers, cfg)
            legs[(a, b)] = Leg(a, b, path, dist, walk, smax, float(cum[by, bx]))

    for a, b in pairs:
        if (a, b) not in legs:
            r = legs[(b, a)]
            legs[(a, b)] = Leg(a, b, r.path_rc[::-1].copy(), r.distance_m, r.walk_min, r.max_slope_deg, r.cost)
    return legs


# --- Why-lines ---------------------------------------------------------------

_COMPASS = ["east", "northeast", "north", "northwest", "west", "southwest", "south", "southeast"]


def compass(dx: float, dy: float) -> str:
    """Compass word for a pixel offset (north = -y)."""
    ang = math.degrees(math.atan2(-dy, dx)) % 360
    return _COMPASS[int((ang + 22.5) // 45) % 8]


def why_lines(leg: Leg, layers: Layers, stops: dict[str, dict], cfg=default_cfg) -> list[str]:
    """Explain a leg by comparing it to the straight line between its stops."""
    ax, ay = stops[leg.a]["px"]
    bx, by = stops[leg.b]["px"]
    rr, cc = draw_line(ay, ax, by, bx)
    straight_m = math.hypot(bx - ax, by - ay) * cfg.PIXEL_M
    if straight_m == 0:
        return []
    m_per_line_cell = straight_m / max(len(rr) - 1, 1)

    blocked = blocked_mask(layers, cfg)
    slope = np.nan_to_num(layers.slope_deg, nan=90.0)
    hazards = [
        ("no-go ground", blocked),
        ("steep slope", (slope >= cfg.SLOPE_SOFT_DEG) & ~blocked),
        ("soft sand", (np.nan_to_num(layers.sand) >= cfg.SAND_SOFT_MIN) & ~blocked),
    ]

    pr, pc = leg.path_rc[:, 0], leg.path_rc[:, 1]
    step_m = np.r_[0, np.hypot(*np.diff(leg.path_rc, axis=0).T)] * cfg.PIXEL_M
    name = lambda sid: stops[sid].get("name", sid)
    out = []
    for label, mask in hazards:
        on_line = mask[rr, cc]
        line_m = on_line.sum() * m_per_line_cell
        route_m = step_m[mask[pr, pc]].sum()
        if line_m - route_m < cfg.WHY_MIN_M:
            continue
        # Where is the avoided hazard? Relative to whichever stop is closer.
        hy, hx = rr[on_line].mean(), cc[on_line].mean()
        ref = leg.a if math.hypot(hx - ax, hy - ay) <= math.hypot(hx - bx, hy - by) else leg.b
        rx, ry = stops[ref]["px"]
        where = compass(hx - rx, hy - ry)
        if route_m < 1:
            out.append(f"{leg.a}→{leg.b}: avoids {line_m:.0f} m of {label} {where} of {name(ref)}")
        else:
            out.append(
                f"{leg.a}→{leg.b}: cuts {label} from {line_m:.0f} m on the direct line to "
                f"{route_m:.0f} m ({where} of {name(ref)})"
            )

    extra = leg.distance_m / straight_m - 1
    if not out:
        out.append(f"{leg.a}→{leg.b}: nearly direct, {extra:.0%} longer than a straight line")
    else:
        out.append(f"{leg.a}→{leg.b}: detour adds {leg.distance_m - straight_m:.0f} m ({extra:.0%})")
    return out



# --- Route assembly and timelines --------------------------------------------

def leg_clock(path_rc: np.ndarray, layers: Layers, cfg=default_cfg) -> np.ndarray:
    """Cumulative walking minutes at each cell of a full-resolution path."""
    p = np.asarray(path_rc)
    if len(p) < 2:
        return np.zeros(len(p))
    step_m = np.hypot(*np.diff(p, axis=0).T) * cfg.PIXEL_M
    s = np.nan_to_num(layers.slope_deg[p[:, 0], p[:, 1]], nan=0.0)
    return np.r_[0.0, np.cumsum(step_m / speed_m_per_min((s[:-1] + s[1:]) / 2, cfg))]


def simplify_idx(path_rc: np.ndarray, tol: float) -> np.ndarray:
    """Indices of the path cells kept by Douglas-Peucker simplification."""
    p = np.asarray(path_rc)
    if tol <= 0 or len(p) <= 2:
        return np.arange(len(p))
    simp = approximate_polygon(p.astype(float), tolerance=tol).round().astype(int)
    idx, j = [], 0
    for v in simp:
        while j < len(p) and not (p[j] == v).all():
            j += 1
        if j == len(p):
            raise RuntimeError("simplified vertex is not on the path")
        idx.append(j)
    return np.array(idx)


def _home_at(th: np.ndarray, x: int, y: int):
    v = th[y, x]
    return round(float(v), 1) if np.isfinite(v) else None


def assemble(seq: list[str], legs: dict, layers: Layers, stops: dict, th: np.ndarray,
             cfg=default_cfg, work_first: float = 0.0) -> dict:
    """Join legs into one timed route starting at clock 0 at seq[0].

    The crew dwells `work_first` minutes at seq[0], then the stop's work time at each
    intermediate stop. A dwell is written as the stop point repeated with a later time,
    so linear interpolation of position over `t_min` keeps the crew still while working.
    """
    path, t_min, home_min, leg_out, stop_plan = [], [], [], [], []
    clock = 0.0

    def add(x, y, t):
        path.append([int(x), int(y)])
        t_min.append(round(float(t), 2))
        home_min.append(_home_at(th, int(x), int(y)))

    x0, y0 = stops[seq[0]]["px"]
    add(x0, y0, 0.0)
    sp = {"id": seq[0], "path_index": 0, "arrive_min": 0.0}
    if work_first:
        clock += work_first
        add(x0, y0, clock)
    sp["depart_min"] = round(clock, 2)
    stop_plan.append(sp)

    dist = walk = 0.0
    for k, (a, b) in enumerate(zip(seq, seq[1:])):
        leg = legs[(a, b)]
        cum = leg_clock(leg.path_rc, layers, cfg)
        start = len(path) - 1
        for i in simplify_idx(leg.path_rc, cfg.PATH_SIMPLIFY_PX)[1:]:
            r, c = leg.path_rc[i]
            add(c, r, clock + cum[i])
        clock += float(cum[-1])
        sp = {"id": b, "path_index": len(path) - 1, "arrive_min": round(clock, 2)}
        dwell = 0.0 if k == len(seq) - 2 else work_min(stops[b], cfg)
        if dwell:
            clock += dwell
            x, y = stops[b]["px"]
            add(x, y, clock)
        sp["depart_min"] = round(clock, 2)
        stop_plan.append(sp)
        leg_out.append({
            "from": a, "to": b,
            "distance_m": round(leg.distance_m, 1),
            "walk_min": round(leg.walk_min, 1),
            "max_slope_deg": round(leg.max_slope_deg, 1),
            "path_start": start,
            "path_end": sp["path_index"],
        })
        dist += leg.distance_m
        walk += leg.walk_min

    return {
        "path": path, "t_min": t_min, "home_min": home_min,
        "legs": leg_out, "stop_plan": stop_plan,
        "distance_m": round(dist, 1), "walk_min": round(walk, 1), "total_min": round(clock, 1),
    }


def route_why(seq: list[str], legs: dict, layers: Layers, stops: dict, cfg=default_cfg) -> list[str]:
    why, seen = [], set()
    for a, b in zip(seq, seq[1:]):
        if (b, a) in seen or (a, b) in seen:  # same leg walked back
            continue
        seen.add((a, b))
        why.extend(why_lines(legs[(a, b)], layers, stops, cfg))
    return why


# --- Replan options -----------------------------------------------------------

def replan_specs(seq: list[str], stops: dict, cfg=default_cfg) -> list[dict]:
    """Options at each decision point (arrival at each stop except the final one).

    Kinds, best first:
      planned   - carry on as planned
      skip_work - cut the work at this stop (science stops only), then carry on
      drop      - skip one or more remaining science stops
      abort     - walk straight home (drops everything left, depot included)
    Depot stops and depot work are never dropped except by abort.
    """
    from itertools import combinations

    out = []
    for i, here in enumerate(seq[:-1]):
        rest = seq[i + 1:]
        home = rest[-1]
        work_here = work_min(stops[here], cfg) if i > 0 else 0.0
        opts = [{"kind": "planned", "seq": [here] + rest, "work_here": work_here}]
        if work_here and stops[here].get("kind") == "science":
            opts.append({"kind": "skip_work", "seq": [here] + rest, "work_here": 0.0})
        optional = [s for s in rest[:-1] if stops[s].get("kind") == "science"]
        for r in range(1, len(optional) + 1):
            for drop in combinations(optional, r):
                kept = [s for s in rest if s not in drop]
                opts.append({"kind": "drop", "seq": [here] + kept, "work_here": work_here, "dropped": list(drop)})
        if len(rest) > 1 and here != home:
            opts.append({"kind": "abort", "seq": [here, home], "work_here": 0.0, "dropped": rest[:-1]})
        out.append({"at": here, "index": i, "options": opts})
    return out


def build_option(spec: dict, here: str, planned_min: float, legs, layers, stops, th, cfg) -> dict:
    r = assemble(spec["seq"], legs, layers, stops, th, cfg, work_first=spec["work_here"])
    name = lambda s: stops[s].get("name", s)
    saves = 0.0 if spec["kind"] == "planned" else round(planned_min - r["total_min"], 1)
    kind = spec["kind"]
    if kind == "planned":
        head = "Continue as planned"
    elif kind == "skip_work":
        head = f"Cut the {work_min(stops[here], cfg):.0f}-min work at {name(here)}, saves {saves:.0f} min"
    elif kind == "drop":
        head = f"Drop {', '.join(name(s) for s in spec['dropped'])}, saves {saves:.0f} min"
    else:
        dropped = ", ".join(name(s) for s in spec["dropped"])
        head = f"Abort: walk straight home from {name(here)}, drops {dropped}"
    return {
        "kind": kind,
        "stops": spec["seq"],
        "work_here_min": spec["work_here"],
        "minutes": r["total_min"],
        "saves_min": saves,
        "distance_m": r["distance_m"],
        "path": r["path"],
        "t_min": r["t_min"],
        "home_min": r["home_min"],
        "abort": kind == "abort",
        "why": [head] + ([] if kind == "planned" else route_why(spec["seq"], legs, layers, stops, cfg)),
    }


# --- Variants -----------------------------------------------------------------

def build_variant(vdef: dict, specs: list[dict], legs: dict, layers: Layers, stops: dict,
                  th: np.ndarray, cfg=default_cfg) -> dict:
    seq = vdef["stops"]
    r = assemble(seq, legs, layers, stops, th, cfg)
    total = r["total_min"]
    for sp in r["stop_plan"]:
        x, y = stops[sp["id"]]["px"]
        sp["home_min"] = _home_at(th, x, y)
        sp["remaining_min"] = round(max(total - sp["arrive_min"], 0.0), 1)

    replan = []
    for d in specs:
        sp = r["stop_plan"][d["index"]]
        planned = sp["remaining_min"]
        opts = [build_option(o, d["at"], planned, legs, layers, stops, th, cfg) for o in d["options"]]
        # planned first, then longest to shortest, abort last
        opts = [opts[0]] + sorted([o for o in opts[1:] if not o["abort"]], key=lambda o: -o["minutes"]) \
            + [o for o in opts if o["abort"]]
        replan.append({"at": d["at"], "stop_index": d["index"], "path_index": sp["path_index"], "options": opts})

    work_total = sum(work_min(stops[s], cfg) for s in seq[1:-1])
    return {
        "id": vdef["id"],
        "stops": seq,
        "distance_m": r["distance_m"],
        "est_min": total,
        "walk_min": r["walk_min"],
        "work_min": round(work_total, 1),
        "max_slope_deg": round(max(l["max_slope_deg"] for l in r["legs"]), 1),
        "path": r["path"],
        "t_min": r["t_min"],
        "home_min": r["home_min"],
        "legs": r["legs"],
        "stop_plan": r["stop_plan"],
        "replan": replan,
        "why": route_why(seq, legs, layers, stops, cfg),
    }


REPLAN_RULE = (
    "Each variant's path, t_min and home_min are parallel arrays: t_min is planned minutes since "
    "leaving the habitat, home_min is minutes to walk home from that point. Interpolate position "
    "linearly over t_min (a repeated point is a work stop). When the crew arrives at a stop at actual "
    "time T, look up replan[] for that stop and take the first option where "
    "T + option.minutes + reserve <= budget (options are ordered planned first, abort last). If none "
    "fits, take the abort option. An option's t_min is relative to arrival at that stop: add T."
)


def plan_routes(layers: Layers, stops_list: list[dict], cfg=default_cfg):
    """Run the whole engine. Returns (routes, time_home_bytes, time_home_grid, stops_list, legs)."""
    blocked = blocked_mask(layers, cfg)
    stops_list = [dict(s) for s in stops_list]
    warnings = snap_stops(stops_list, blocked)
    stops = {s["id"]: s for s in stops_list}

    variants = []
    for v in cfg.VARIANTS:
        missing = [s for s in v["stops"] if s not in stops]
        if missing:
            warnings.append(f"variant {v['id']} skipped, missing stops {missing}")
            continue
        variants.append(v)
    if not variants:
        raise ValueError("no route variant has all its stops in stops.json")

    specs = {v["id"]: replan_specs(v["stops"], stops, cfg) for v in variants}
    seqs = [v["stops"] for v in variants] + [o["seq"] for s in specs.values() for d in s for o in d["options"]]
    pairs = {(a, b) for seq in seqs for a, b in zip(seq, seq[1:])}

    cost = cost_grid(layers, cfg)
    legs = solve_legs(cost, layers, stops, sorted(pairs), cfg)
    th = time_home(layers, stops[cfg.HABITAT_ID]["px"], cfg)
    th_bytes, th_meta = encode_time_home(th, cfg.TIME_HOME_STRIDE)
    out_variants = [build_variant(v, specs[v["id"]], legs, layers, stops, th, cfg) for v in variants]

    routes = {
        "variants": out_variants,
        "replan_rule": REPLAN_RULE,
        "time_home_file": "time_home.bin",
        "time_home": th_meta,
        "stops_px": {s["id"]: s["px"] for s in stops_list},
        "params": {
            "pixel_m": cfg.PIXEL_M,
            "slope_soft_deg": cfg.SLOPE_SOFT_DEG,
            "slope_hard_deg": cfg.SLOPE_HARD_DEG,
            "weights": {"slope": cfg.W_SLOPE, "sand": cfg.W_SAND, "rough": cfg.W_ROUGH},
            "v_flat_kmh": cfg.V_FLAT_KMH,
        },
        "assumptions": [
            f"Slope above {cfg.SLOPE_SOFT_DEG:g}° is costly and {cfg.SLOPE_HARD_DEG:g}° or more is no-go",
            f"Suited walking speed {cfg.V_FLAT_KMH:g} km/h on flat ground, slower on slopes (Tobler-style)",
            "Cost weights are tuning knobs, not physics",
            "Walking time is the same in both directions on a slope",
        ],
        "warnings": warnings,
    }
    return routes, th_bytes.tobytes(), th, stops_list, legs
