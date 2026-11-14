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


# --- Variants ----------------------------------------------------------------

def to_xy(path_rc: np.ndarray, simplify_px: float) -> np.ndarray:
    p = np.asarray(path_rc, dtype=float)
    if simplify_px > 0 and len(p) > 2:
        p = approximate_polygon(p, tolerance=simplify_px)
    return p[:, ::-1].round().astype(int)  # [row, col] -> [x, y]


def build_variant(vdef: dict, legs: dict, layers: Layers, stops: dict[str, dict], cfg=default_cfg) -> dict:
    seq = vdef["stops"]
    path: list[list[int]] = []
    leg_out, why = [], []
    walk_total = dist_total = 0.0
    for a, b in zip(seq, seq[1:]):
        leg = legs[(a, b)]
        xy = to_xy(leg.path_rc, cfg.PATH_SIMPLIFY_PX).tolist()
        start_index = max(len(path) - 1, 0)
        path.extend(xy if not path else xy[1:])  # don't repeat the shared stop point
        leg_out.append({
            "from": a, "to": b,
            "distance_m": round(leg.distance_m, 1),
            "walk_min": round(leg.walk_min, 1),
            "max_slope_deg": round(leg.max_slope_deg, 1),
            "path_start": start_index,
            "path_end": len(path) - 1,
        })
        if (b, a) not in [(l["from"], l["to"]) for l in leg_out[:-1]]:  # same leg walked back
            why.extend(why_lines(leg, layers, stops, cfg))
        walk_total += leg.walk_min
        dist_total += leg.distance_m

    work_total = sum(work_min(stops[s], cfg) for s in seq[1:-1])
    return {
        "id": vdef["id"],
        "stops": seq,
        "distance_m": round(dist_total, 1),
        "est_min": round(walk_total + work_total, 1),
        "walk_min": round(walk_total, 1),
        "work_min": round(work_total, 1),
        "max_slope_deg": round(max(l["max_slope_deg"] for l in leg_out), 1),
        "path": path,
        "legs": leg_out,
        "why": why,
    }


def plan_routes(layers: Layers, stops_list: list[dict], cfg=default_cfg):
    """Run the whole engine. Returns (routes_json_dict, time_home_bytes, warnings)."""
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

    pairs = {(a, b) for v in variants for a, b in zip(v["stops"], v["stops"][1:])}
    cost = cost_grid(layers, cfg)
    legs = solve_legs(cost, layers, stops, sorted(pairs), cfg)
    out_variants = [build_variant(v, legs, layers, stops, cfg) for v in variants]

    th = time_home(layers, stops[cfg.HABITAT_ID]["px"], cfg)
    th_bytes, th_meta = encode_time_home(th, cfg.TIME_HOME_STRIDE)

    routes = {
        "variants": out_variants,
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
