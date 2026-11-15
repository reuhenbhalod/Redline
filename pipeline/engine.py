"""Route engine: cost grid, legs, route variants, time-home grid, replan options.

Runs offline. Nothing here runs in the browser.

Conventions:
  * Arrays are indexed [row, col] = [y, x].
  * Everything written to JSON is pixel [x, y] on the grid (the data contract).
  * North is up (row 0 is the northern edge), as in the equirectangular DTM.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from itertools import combinations
from pathlib import Path

import numpy as np
from scipy.ndimage import binary_dilation, distance_transform_edt, uniform_filter
from skimage.draw import line as draw_line
from skimage.graph import MCP_Flexible, MCP_Geometric
from skimage.measure import approximate_polygon

import engine_config as default_cfg

HERE = "@"  # pseudo-stop id for "the crew's current position" in mid-leg options


# --- Inputs ------------------------------------------------------------------

@dataclass
class Layers:
    """Engine inputs, all the same (H, W) shape and aligned cell for cell."""
    slope_deg: np.ndarray            # float, degrees; NaN = missing data
    sand: np.ndarray                 # float 0..1, 1 = soft sand
    rough: np.ndarray                # float 0..1, 1 = very rough ground
    nogo: np.ndarray                 # bool, True = never walk here (data gaps, known hazards)
    dtm: np.ndarray | None = None    # float meters (optional): uphill/downhill timing, roughness
    speed_factor: np.ndarray | None = None  # per-cell speed multiplier (real data: sand / rocky factors)

    @property
    def shape(self):
        return self.slope_deg.shape


def roughness_from_dtm(dtm: np.ndarray, win: int = 9) -> np.ndarray:
    """0..1 roughness: local elevation spread, normalized by its 99th percentile."""
    z = np.nan_to_num(dtm.astype(np.float64), nan=float(np.nanmean(dtm)))
    m = uniform_filter(z, win)
    sd = np.sqrt(np.maximum(uniform_filter(z * z, win) - m * m, 0))
    return (sd / (np.percentile(sd, 99) + 1e-9)).clip(0, 1).astype(np.float32)


def load_layers(grid_dir: str | Path) -> Layers:
    """Load engine inputs from .npy files. Only slope_deg.npy is required."""
    d = Path(grid_dir)
    slope = np.load(d / "slope_deg.npy").astype(np.float32)

    def opt(name, dtype):
        p = d / f"{name}.npy"
        if not p.exists():
            return None
        a = np.load(p).astype(dtype)
        if a.shape != slope.shape:
            raise ValueError(f"{p} has shape {a.shape}, expected {slope.shape}")
        return a

    dtm = opt("dtm", np.float32)
    rough = opt("rough", np.float32)
    if rough is None:
        rough = roughness_from_dtm(dtm) if dtm is not None else np.zeros_like(slope)
    sand = opt("sand", np.float32)
    nogo = opt("nogo", bool)
    return Layers(
        slope_deg=slope,
        sand=sand if sand is not None else np.zeros_like(slope),
        rough=rough,
        nogo=nogo if nogo is not None else np.zeros(slope.shape, bool),
        dtm=dtm,
    )


def validate_layers(layers: Layers, cfg=default_cfg) -> list[str]:
    """Check value ranges. Raises on hard errors, returns warnings for suspicious data."""
    warnings = []
    s = layers.slope_deg
    fin = np.isfinite(s)
    if not fin.any():
        raise ValueError("slope_deg has no valid cells")
    if s[fin].min() < -1e-3 or s[fin].max() > 90 + 1e-3:
        raise ValueError(f"slope_deg out of range 0..90 (min {s[fin].min():.2f}, max {s[fin].max():.2f}); is it in radians or percent?")
    for name in ("sand", "rough"):
        a = getattr(layers, name)
        af = a[np.isfinite(a)]
        if af.size and (af.min() < -1e-3 or af.max() > 1 + 1e-3):
            warnings.append(f"{name} outside 0..1 (min {af.min():.2f}, max {af.max():.2f}); clipped")
    if 0 < s[fin].max() < 1.6:
        warnings.append("slope_deg max is under 1.6; it may be in radians")
    nogo_frac = blocked_mask(layers, cfg).mean()
    if nogo_frac > 0.3:
        warnings.append(f"{nogo_frac:.0%} of the grid is no-go; check thresholds and data gaps")
    missing = (~fin).mean()
    if missing > 0.05:
        warnings.append(f"{missing:.0%} of slope cells are missing data")
    return warnings


def check_bounds(bounds: dict, layers: Layers, cfg=default_cfg) -> None:
    """Make sure bounds.json describes the same grid the engine is routing on."""
    h, w = layers.shape
    if (bounds.get("width_px"), bounds.get("height_px")) != (w, h):
        raise ValueError(f"bounds.json says {bounds.get('width_px')}x{bounds.get('height_px')}, layers are {w}x{h}")
    if abs(float(bounds.get("pixel_m", cfg.PIXEL_M)) - cfg.PIXEL_M) > 1e-6:
        raise ValueError(f"bounds.json pixel_m {bounds.get('pixel_m')} != config PIXEL_M {cfg.PIXEL_M}")


# --- Grids -------------------------------------------------------------------

def blocked_mask(layers: Layers, cfg=default_cfg) -> np.ndarray:
    """True where the ground itself is no-go (before any safety buffer)."""
    s = layers.slope_deg
    return (
        layers.nogo
        | ~np.isfinite(s)
        | (np.nan_to_num(s, nan=90.0) > cfg.SLOPE_HARD_DEG)
        | ~np.isfinite(layers.sand)
        | ~np.isfinite(layers.rough)
    )


def walk_blocked_mask(blocked: np.ndarray, cfg=default_cfg) -> np.ndarray:
    """No-go grown by the safety buffer, so paths never skim cliff edges."""
    if cfg.NOGO_BUFFER_PX > 0 and blocked.any():
        return binary_dilation(blocked, iterations=int(cfg.NOGO_BUFFER_PX))
    return blocked.copy()


def _clean(a):
    return np.nan_to_num(a, nan=0.0).clip(0, 1)


def terrain_factor(layers: "Layers", cfg=default_cfg) -> np.ndarray:
    """Per-cell walking-speed multiplier from ground type (1.0 = normal ground)."""
    if layers.speed_factor is not None:
        return layers.speed_factor.astype(np.float64)
    return (1 - cfg.SAND_SLOWDOWN * _clean(layers.sand)) * (1 - cfg.ROUGH_SLOWDOWN * _clean(layers.rough))


def speed_m_per_min(slope_deg, cfg=default_cfg, sand=0.0, rough=0.0, grade=None, factor=None):
    """Suited walking speed (m/min).

    Without `grade`: Tobler shape on the slope magnitude (direction unknown).
    With `grade` (signed rise over run along the direction of travel): true Tobler,
    so going uphill is slower than coming down. Normalized so flat ground = V_FLAT_KMH.
    Sand and rough ground slow the walk further.
    """
    v0 = cfg.V_FLAT_KMH * 1000 / 60
    max_tan = math.tan(math.radians(cfg.SLOPE_HARD_DEG))
    if grade is None:
        t = np.tan(np.radians(np.clip(np.nan_to_num(slope_deg, nan=0.0), 0, cfg.SLOPE_HARD_DEG)))
        f = np.exp(-cfg.TOBLER_K * t)
    else:
        g = np.clip(grade, -max_tan, max_tan)
        f = np.exp(-cfg.TOBLER_K * np.abs(g + cfg.TOBLER_OFFSET)) / math.exp(-cfg.TOBLER_K * cfg.TOBLER_OFFSET)
    terrain = factor if factor is not None else (1 - cfg.SAND_SLOWDOWN * _clean(sand)) * (1 - cfg.ROUGH_SLOWDOWN * _clean(rough))
    return v0 * f * terrain


@dataclass
class Terrain:
    """Everything derived from the layers once, shared by every step."""
    layers: Layers
    blocked: np.ndarray        # true no-go
    walk_blocked: np.ndarray   # no-go + safety buffer
    cost: np.ndarray           # cost per cell, inf = walk_blocked
    time: np.ndarray           # minutes per axis-aligned cell step, inf = walk_blocked
    cfg: object = field(default=default_cfg, repr=False)

    @property
    def shape(self):
        return self.layers.shape


def build_terrain(layers: Layers, cfg=default_cfg) -> Terrain:
    blocked = blocked_mask(layers, cfg)
    walk_blocked = walk_blocked_mask(blocked, cfg)
    return Terrain(layers, blocked, walk_blocked, _cost(layers, blocked, walk_blocked, cfg),
                   _time(layers, walk_blocked, cfg), cfg)


def _cost(layers, blocked, walk_blocked, cfg):
    slope = np.nan_to_num(layers.slope_deg, nan=0.0)
    cost = (
        1.0
        + cfg.W_SLOPE * (slope / cfg.SLOPE_SOFT_DEG) ** 2
        + cfg.W_SAND * _clean(layers.sand)
        + cfg.W_ROUGH * _clean(layers.rough)
    ).astype(np.float64)
    if cfg.W_MARGIN > 0 and blocked.any():
        dist = distance_transform_edt(~blocked)
        cost += cfg.W_MARGIN * np.exp(-dist / cfg.MARGIN_PX)
    cost[walk_blocked] = np.inf
    return cost


def _time(layers, walk_blocked, cfg):
    t = (cfg.PIXEL_M / speed_m_per_min(layers.slope_deg, cfg, factor=terrain_factor(layers, cfg))).astype(np.float64)
    t[walk_blocked] = np.inf
    return t


def cost_grid(layers: Layers, cfg=default_cfg) -> np.ndarray:
    """Walking cost per cell (unitless, >= 1). No-go cells (with buffer) are +inf."""
    return build_terrain(layers, cfg).cost


def time_grid(layers: Layers, cfg=default_cfg) -> np.ndarray:
    return build_terrain(layers, cfg).time


def time_home_from(terrain: Terrain, habitat_xy) -> np.ndarray:
    """Fastest walking time (minutes) from every cell back to the habitat. Unreachable = +inf.

    With a DTM (and ASYMMETRIC_WALK), each step is timed in the direction of the walk
    home, so a downhill return is faster than the outbound climb, matching leg times.
    Otherwise uses the direction-free speed model.
    """
    x, y = habitat_xy
    L, cfg = terrain.layers, terrain.cfg
    if L.dtm is None or not cfg.ASYMMETRIC_WALK:
        mcp = MCP_Geometric(terrain.time, fully_connected=True)
        minutes, _ = mcp.find_costs([(y, x)])
        return minutes
    h, w = terrain.shape
    idx = np.arange(h * w, dtype=np.float64).reshape(h, w)  # each cell's "cost" is its own index
    idx[terrain.walk_blocked] = np.inf
    mcp = _HomeMCP(idx, L, cfg)
    minutes, _ = mcp.find_costs([(y, x)])
    return minutes - idx[y, x]  # MCP counts the start cell's value once


class _HomeMCP(MCP_Flexible):
    """Dijkstra outward from the habitat, timing each step for walking back toward it."""

    def __init__(self, idx, layers: Layers, cfg):
        super().__init__(idx, fully_connected=True)
        self.z = np.nan_to_num(layers.dtm.astype(np.float64), nan=0.0).ravel()
        self.terr = terrain_factor(layers, cfg).ravel().astype(np.float64)
        self.v0 = cfg.V_FLAT_KMH * 1000 / 60
        self.k, self.off, self.pm = cfg.TOBLER_K, cfg.TOBLER_OFFSET, cfg.PIXEL_M
        self.norm = math.exp(-cfg.TOBLER_K * cfg.TOBLER_OFFSET)
        self.maxg = math.tan(math.radians(cfg.SLOPE_HARD_DEG))

    def travel_cost(self, old_cost, new_cost, offset_length):
        a, b = int(old_cost), int(new_cost)  # a is nearer home; the crew walks b -> a
        d = offset_length * self.pm
        g = min(self.maxg, max(-self.maxg, (self.z[a] - self.z[b]) / d))
        v = self.v0 * math.exp(-self.k * abs(g + self.off)) / self.norm * 0.5 * (self.terr[a] + self.terr[b])
        return d / v


def time_home(layers: Layers, habitat_xy, cfg=default_cfg) -> np.ndarray:
    return time_home_from(build_terrain(layers, cfg), habitat_xy)


def encode_time_home(minutes: np.ndarray, stride: int):
    """Pack the time-home grid for the browser and backpack (conservative, per docs/engine_guide.md 9).

    Each stride x stride block takes the MAX of its cells, rounded UP to whole minutes,
    as little-endian uint16; 65535 = unreachable (any unreachable cell makes the block unreachable).
    """
    h, w = minutes.shape
    H, W = -(-h // stride), -(-w // stride)
    pad = np.full((H * stride, W * stride), np.inf)
    pad[:h, :w] = minutes
    m = pad.reshape(H, stride, W, stride).max(axis=(1, 3))
    out = np.full(m.shape, 65535, dtype="<u2")
    ok = np.isfinite(m)
    out[ok] = np.clip(np.ceil(m[ok] - 1e-9), 0, 65534).astype("<u2")
    meta = {
        # format as specified in docs/engine_guide.md section 9
        "dtype": "uint16 little-endian",
        "shape": [int(H), int(W)],
        "cell_m": None,  # filled in by plan_routes (stride * pixel_m)
        "unreachable": 65535,
        "index": f"value[row][col], row = floor(y_px / {stride}), col = floor(x_px / {stride}); minutes, rounded up, max of the block",
        # same information in the keys the web app reads
        "width": int(W),
        "height": int(H),
        "stride_px": int(stride),
        "scale_min": 1.0,
        "nodata": 65535,
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


def leg_clock(path_rc: np.ndarray, layers: Layers, cfg=default_cfg) -> np.ndarray:
    """Cumulative walking minutes at each cell of a full-resolution path.

    With a DTM and ASYMMETRIC_WALK, uses the signed grade along the direction of
    travel, so the same leg can take different times in each direction.
    """
    p = np.asarray(path_rc)
    if len(p) < 2:
        return np.zeros(len(p))
    r, c = p[:, 0], p[:, 1]
    step_m = np.hypot(*np.diff(p, axis=0).T) * cfg.PIXEL_M
    mid = lambda a: (a[:-1] + a[1:]) / 2
    slope = mid(np.nan_to_num(layers.slope_deg[r, c], nan=0.0))
    fac = mid(terrain_factor(layers, cfg)[r, c]) if layers.speed_factor is not None else None
    sand, rough = mid(_clean(layers.sand[r, c])), mid(_clean(layers.rough[r, c]))
    grade = None
    if layers.dtm is not None and cfg.ASYMMETRIC_WALK:
        z = layers.dtm[r, c].astype(np.float64)
        grade = np.nan_to_num(np.diff(z) / step_m, nan=0.0)
    v = speed_m_per_min(slope, cfg, sand, rough, grade, factor=fac)
    return np.r_[0.0, np.cumsum(step_m / v)]


def make_leg(a: str, b: str, path_rc: np.ndarray, layers: Layers, cfg=default_cfg) -> Leg:
    p = np.asarray(path_rc)
    dist = float((np.hypot(*np.diff(p, axis=0).T) * cfg.PIXEL_M).sum()) if len(p) > 1 else 0.0
    smax = float(np.nan_to_num(layers.slope_deg[p[:, 0], p[:, 1]], nan=0.0).max()) if len(p) else 0.0
    return Leg(a, b, p, dist, float(leg_clock(p, layers, cfg)[-1]) if len(p) else 0.0, smax)


class LegSolver:
    """Cheapest paths between stops (and from any point to a stop), solved lazily.

    One Dijkstra per target stop, cached. Cost is direction-free, so the path
    from X to stop S is the traceback from S to X, reversed. Walking time is
    recomputed per direction.
    """

    def __init__(self, terrain: Terrain, stops: dict[str, dict]):
        self.t, self.stops = terrain, stops
        self._mcp: dict[str, tuple] = {}
        self.legs: dict[tuple[str, str], Leg] = {}

    def _from(self, sid: str):
        if sid not in self._mcp:
            x, y = self.stops[sid]["px"]
            m = MCP_Geometric(self.t.cost, fully_connected=True)
            cum, _ = m.find_costs([(y, x)])
            self._mcp[sid] = (m, cum)
        return self._mcp[sid]

    def path_to(self, xy, sid: str, label: str = HERE) -> np.ndarray:
        """Cell path from pixel xy to stop sid."""
        x, y = xy
        m, cum = self._from(sid)
        if not np.isfinite(cum[y, x]):
            raise RuntimeError(f"no safe path from {label} to {sid}")
        return np.array(m.traceback((y, x)))[::-1]

    def leg(self, a: str, b: str) -> Leg:
        if (a, b) not in self.legs:
            if (b, a) in self.legs:
                path = self.legs[(b, a)].path_rc[::-1].copy()
            else:
                path = self.path_to(self.stops[a]["px"], b, label=a)
            self.legs[(a, b)] = make_leg(a, b, path, self.t.layers, self.t.cfg)
        return self.legs[(a, b)]

    def leg_from(self, xy, b: str) -> Leg:
        return make_leg(HERE, b, self.path_to(xy, b), self.t.layers, self.t.cfg)


class _Legs:
    """Mapping view: extra (point) legs first, then the solver."""

    def __init__(self, solver: LegSolver, extra: dict | None = None):
        self.solver, self.extra = solver, extra or {}

    def __getitem__(self, key):
        return self.extra[key] if key in self.extra else self.solver.leg(*key)


def solve_legs(cost_or_terrain, layers: Layers, stops: dict[str, dict], pairs, cfg=default_cfg) -> dict:
    """Back-compat helper: solve the given (a, b) pairs, return {(a, b): Leg}."""
    terrain = cost_or_terrain if isinstance(cost_or_terrain, Terrain) else build_terrain(layers, cfg)
    solver = LegSolver(terrain, stops)
    return {(a, b): solver.leg(a, b) for a, b in pairs}


# --- Why-lines ---------------------------------------------------------------

_COMPASS = ["east", "northeast", "north", "northwest", "west", "southwest", "south", "southeast"]


def compass(dx: float, dy: float) -> str:
    """Compass word for a pixel offset (north = -y)."""
    ang = math.degrees(math.atan2(-dy, dx)) % 360
    return _COMPASS[int((ang + 22.5) // 45) % 8]


def _name(stops, sid):
    return "your position" if sid == HERE else stops[sid].get("name", sid)


def why_items(leg: Leg, terrain: Terrain, stops: dict[str, dict]) -> list[tuple[float, str]]:
    """(meters avoided, sentence) pairs explaining a leg against the straight line."""
    cfg, layers = terrain.cfg, terrain.layers
    ax, ay = stops[leg.a]["px"]
    bx, by = stops[leg.b]["px"]
    straight_m = math.hypot(bx - ax, by - ay) * cfg.PIXEL_M
    if straight_m == 0:
        return []
    rr, cc = draw_line(ay, ax, by, bx)
    m_per_line_cell = straight_m / max(len(rr) - 1, 1)

    blocked = terrain.blocked
    slope = np.nan_to_num(layers.slope_deg, nan=90.0)
    hazards = [
        ("no-go ground", blocked),
        ("steep slope", (slope >= cfg.SLOPE_SOFT_DEG) & ~blocked),
        (getattr(cfg, "SAND_LABEL", "soft sand"), (np.nan_to_num(layers.sand) >= cfg.SAND_SOFT_MIN) & ~blocked),
        ("blocky rock", (np.nan_to_num(layers.rough) >= 0.99) & ~blocked),
    ]
    pr, pc = leg.path_rc[:, 0], leg.path_rc[:, 1]
    step_m = np.r_[0, np.hypot(*np.diff(leg.path_rc, axis=0).T)] * cfg.PIXEL_M
    arrow = f"{leg.a}→{leg.b}" if leg.a != HERE else f"→{leg.b}"
    out = []
    for label, mask in hazards:
        on_line = mask[rr, cc]
        line_m = on_line.sum() * m_per_line_cell
        route_m = step_m[mask[pr, pc]].sum()
        if line_m - route_m < cfg.WHY_MIN_M:
            continue
        hy, hx = rr[on_line].mean(), cc[on_line].mean()
        ref = leg.a if math.hypot(hx - ax, hy - ay) <= math.hypot(hx - bx, hy - by) else leg.b
        rx, ry = stops[ref]["px"]
        where = f"{compass(hx - rx, hy - ry)} of {_name(stops, ref)}"
        if math.hypot(hx - rx, hy - ry) * cfg.PIXEL_M < 15:
            where = f"at {_name(stops, ref)}"
        if route_m < 1:
            out.append((line_m - route_m, f"{arrow}: avoids {line_m:.0f} m of {label} {where}"))
        else:
            out.append((line_m - route_m,
                        f"{arrow}: cuts {label} from {line_m:.0f} m on the direct line to {route_m:.0f} m ({where})"))
    extra = leg.distance_m / straight_m - 1
    if not out:
        out.append((0.0, f"{arrow}: nearly direct, {extra:.0%} longer than a straight line"))
    else:
        out.append((0.0, f"{arrow}: detour adds {leg.distance_m - straight_m:.0f} m ({extra:.0%})"))
    return out


def why_lines(leg: Leg, layers_or_terrain, stops: dict[str, dict], cfg=default_cfg) -> list[str]:
    terrain = layers_or_terrain if isinstance(layers_or_terrain, Terrain) else build_terrain(layers_or_terrain, cfg)
    return [t for _, t in why_items(leg, terrain, stops)]


def route_why(seq: list[str], legs, terrain: Terrain, stops: dict, summary: str | None = None):
    """(why, why_detail): a short list (summary + biggest hazards) and every line."""
    items, seen = [], set()
    for a, b in zip(seq, seq[1:]):
        if (b, a) in seen or (a, b) in seen:  # same leg walked back
            continue
        seen.add((a, b))
        items.extend(why_items(legs[(a, b)], terrain, stops))
    detail = [t for _, t in items]
    top = [t for s, t in sorted(items, key=lambda it: -it[0]) if s > 0]
    head = [summary] if summary else []
    n = terrain.cfg.WHY_MAX_LINES - len(head)
    why = head + (top[:n] if top else detail[:n])
    return why, detail


# --- Route assembly and timelines --------------------------------------------

def simplify_idx(path_rc: np.ndarray, tol: float, blocked: np.ndarray | None = None) -> np.ndarray:
    """Indices of the path cells kept by Douglas-Peucker simplification.

    With `blocked`, any simplified segment that would cut a blocked cell is split
    until it doesn't, so the drawn route never crosses no-go ground.
    """
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
    if blocked is None:
        return np.array(idx)

    out = [idx[0]]

    def refine(i, k):
        if k - i > 1:
            rr, cc = draw_line(p[i, 0], p[i, 1], p[k, 0], p[k, 1])
            if blocked[rr, cc].any():
                m = (i + k) // 2
                refine(i, m)
                refine(m, k)
                return
        out.append(k)

    for i, k in zip(idx, idx[1:]):
        refine(i, k)
    return np.array(out)


def _home_at(th: np.ndarray, x: int, y: int):
    v = th[y, x]
    return round(float(v), 1) if np.isfinite(v) else None


def assemble(seq: list[str], legs, terrain: Terrain, stops: dict, th: np.ndarray,
             work_first: float = 0.0, no_work: frozenset = frozenset()) -> dict:
    """Join legs into one timed route starting at clock 0 at seq[0].

    The crew dwells `work_first` minutes at seq[0], then the stop's work time at each
    intermediate stop. A dwell is written as the stop point repeated with a later time,
    so linear interpolation of position over `t_min` keeps the crew still while working.
    """
    cfg, layers = terrain.cfg, terrain.layers
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
        for i in simplify_idx(leg.path_rc, cfg.PATH_SIMPLIFY_PX, terrain.walk_blocked)[1:]:
            r, c = leg.path_rc[i]
            add(c, r, clock + cum[i])
        clock += float(cum[-1])
        sp = {"id": b, "path_index": len(path) - 1, "arrive_min": round(clock, 2)}
        dwell = 0.0 if k == len(seq) - 2 or b in no_work else work_min(stops[b], cfg)
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
        "max_slope_deg": round(max((l["max_slope_deg"] for l in leg_out), default=0.0), 1),
    }


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


def _option_head(spec, here, saves, stops, cfg):
    name = lambda s: _name(stops, s)
    kind = spec["kind"]
    if kind == "planned":
        return "Continue as planned"
    if kind == "skip_work":
        at = spec.get("skip_at", here)
        return f"Cut the {work_min(stops[at], cfg):.0f}-min work at {name(at)}, saves {saves:.0f} min"
    if kind == "drop":
        return f"Drop {', '.join(name(s) for s in spec['dropped'])}, saves {saves:.0f} min"
    dropped = ", ".join(name(s) for s in spec["dropped"])
    return f"Abort: walk straight home from {name(here)}" + (f", drops {dropped}" if dropped else "")


def build_option(spec: dict, here: str, planned_min: float, legs, terrain, stops, th) -> dict:
    cfg = terrain.cfg
    skip = frozenset([spec["skip_at"]]) if spec.get("skip_at") else frozenset()
    r = assemble(spec["seq"], legs, terrain, stops, th, work_first=spec["work_here"], no_work=skip)
    saves = 0.0 if spec["kind"] == "planned" else round(planned_min - r["total_min"], 1)
    head = _option_head(spec, here, saves, stops, cfg)
    why = [head]
    if spec["kind"] != "planned":
        why += route_why(spec["seq"], legs, terrain, stops)[0][: cfg.WHY_MAX_LINES - 1]
    return {
        "kind": spec["kind"],
        "stops": spec["seq"],
        "work_here_min": spec["work_here"],
        "minutes": r["total_min"],
        "saves_min": saves,
        "distance_m": r["distance_m"],
        "path": r["path"],
        "t_min": r["t_min"],
        "home_min": r["home_min"],
        "abort": spec["kind"] == "abort",
        **({"skip_at": spec["skip_at"]} if spec.get("skip_at") else {}),
        "why": why,
    }


def _order(opts):
    """Planned first, then longest to shortest, abort last."""
    return [opts[0]] + sorted([o for o in opts[1:] if not o["abort"]], key=lambda o: -o["minutes"]) \
        + [o for o in opts if o["abort"]]


def checkpoints(r: dict, seq: list[str], solver: LegSolver, terrain: Terrain, stops: dict, th) -> list[dict]:
    """Mid-leg decision points every CHECKPOINT_MIN planned minutes while walking.

    Options mirror the stop-level ones, starting from the crew's position:
    planned (no path; it is the rest of the main path), skip_work (go on, but cut
    the work at the next science stop), drop (skip upcoming science stops),
    abort (head home now).
    """
    cfg = terrain.cfg
    if not cfg.CHECKPOINT_MIN:
        return []
    path, t = r["path"], r["t_min"]
    total, home = r["total_min"], seq[-1]
    out, k = [], 1
    while k * cfg.CHECKPOINT_MIN < total:
        target = k * cfg.CHECKPOINT_MIN
        k += 1
        # segment j -> j+1 that contains the target time; skip work dwells (repeated point)
        j = max(jj for jj in range(len(t) - 1) if t[jj] <= target)
        if path[j] == path[j + 1] or t[j + 1] <= t[j]:
            continue
        f = (target - t[j]) / (t[j + 1] - t[j])
        xy = [int(round(path[j][0] + f * (path[j + 1][0] - path[j][0]))),
              int(round(path[j][1] + f * (path[j + 1][1] - path[j][1])))]
        if terrain.walk_blocked[xy[1], xy[0]]:
            xy = path[j]
        i = j
        ahead = [sp["id"] for sp in r["stop_plan"] if sp["path_index"] > i]
        here_stops = {**stops, HERE: {"id": HERE, "name": "your position", "px": xy, "kind": "point"}}
        planned_min = round(total - target, 1)
        specs = []
        nxt = ahead[0]
        if stops[nxt].get("kind") == "science" and work_min(stops[nxt], cfg) > 0:
            specs.append({"kind": "skip_work", "seq": [HERE] + ahead, "work_here": 0.0, "skip_at": nxt})
        kept = [s for s in ahead if stops[s].get("kind") != "science"]
        if kept != ahead:
            specs.append({"kind": "drop", "seq": [HERE] + kept, "work_here": 0.0,
                          "dropped": [s for s in ahead if s not in kept]})
        if ahead != [home]:
            specs.append({"kind": "abort", "seq": [HERE, home], "work_here": 0.0, "dropped": ahead[:-1]})
        extra = {(HERE, s["seq"][1]): solver.leg_from(xy, s["seq"][1]) for s in specs}
        legs = _Legs(solver, extra)
        opts = [{"kind": "planned", "stops": [HERE] + ahead, "minutes": planned_min, "saves_min": 0.0,
                 "from_path_index": i, "abort": False, "why": ["Continue as planned"]}]
        opts += [build_option(s, HERE, planned_min, legs, terrain, here_stops, th) for s in specs]
        out.append({"path_index": i, "t_min": round(float(target), 2), "px": xy, "next_stop": ahead[0],
                    "options": _order(opts)})
    return out


def hazard_demo(r: dict, spec: dict, solver: LegSolver, terrain: Terrain, stops: dict, th) -> dict | None:
    """Simulate the rover camera confirming a rock field ahead on one leg.

    `at_frac` is where along the leg the hazard sits: a number, or a list of
    candidates, in which case the one causing the longest detour is used (so the
    demo reroute is visible). The reroute starts `warn_m` before the hazard (the
    rover scouts ~100 m ahead) and goes to the leg's end stop.
    """
    fracs = spec["at_frac"] if isinstance(spec["at_frac"], (list, tuple)) else [spec["at_frac"]]
    best = None
    for f in fracs:
        d = _hazard_at(r, {**spec, "at_frac": f}, solver, terrain, stops, th)
        if d and (best is None or d["extra_min"] > best["extra_min"]):
            best = d
    return best


def _hazard_at(r: dict, spec: dict, solver: LegSolver, terrain: Terrain, stops: dict, th) -> dict | None:
    cfg = terrain.cfg
    a, b = spec["leg"]
    leg = next((l for l in r["legs"] if (l["from"], l["to"]) == (a, b)), None)
    if leg is None:
        return None
    s, e = leg["path_start"], leg["path_end"]
    pts = np.array(r["path"][s:e + 1], dtype=float)
    seg = np.hypot(*np.diff(pts, axis=0).T) * cfg.PIXEL_M
    cum = np.r_[0, np.cumsum(seg)]
    if cum[-1] == 0:
        return None
    d_haz = spec["at_frac"] * cum[-1]
    j = int(np.searchsorted(cum, d_haz))
    j = min(max(j, 1), len(pts) - 1)
    f = (d_haz - cum[j - 1]) / max(seg[j - 1], 1e-9)
    hx, hy = pts[j - 1] + f * (pts[j] - pts[j - 1])
    radius_px = spec["radius_m"] / cfg.PIXEL_M
    trig = int(np.searchsorted(cum, max(d_haz - spec["warn_m"] - spec["radius_m"], 0), side="right")) - 1
    trig = max(trig, 0)
    ti = s + trig
    tx, ty = r["path"][ti]

    h, w = terrain.shape
    y0, y1 = int(max(hy - radius_px - 1, 0)), int(min(hy + radius_px + 2, h))
    x0, x1 = int(max(hx - radius_px - 1, 0)), int(min(hx + radius_px + 2, w))
    yy, xx = np.mgrid[y0:y1, x0:x1]
    disk = (xx - hx) ** 2 + (yy - hy) ** 2 <= radius_px ** 2
    cost2 = terrain.cost.copy()
    cost2[y0:y1, x0:x1][disk] = np.inf
    bx, by = stops[b]["px"]
    m = MCP_Geometric(cost2, fully_connected=True)
    cumc, _ = m.find_costs([(by, bx)])
    if not np.isfinite(cumc[ty, tx]) or (tx - hx) ** 2 + (ty - hy) ** 2 <= radius_px ** 2:
        return None
    detour = make_leg(HERE, b, np.array(m.traceback((ty, tx)))[::-1], terrain.layers, cfg)
    here_stops = {**stops, HERE: {"id": HERE, "name": "your position", "px": [tx, ty], "kind": "point"}}
    rr = assemble([HERE, b], {(HERE, b): detour}, terrain, here_stops, th)
    arrive_b = next(sp["arrive_min"] for sp in r["stop_plan"] if sp["path_index"] == e)
    planned = round(arrive_b - r["t_min"][ti], 1)
    full = solver.leg(a, b).path_rc  # measure the planned remainder on the same full-res cells
    k = int(np.flatnonzero((full[:, 0] == ty) & (full[:, 1] == tx))[0])
    planned_m = float((np.hypot(*np.diff(full[k:], axis=0).T) * cfg.PIXEL_M).sum())
    extra_min = round(rr["total_min"] - planned, 1)
    extra_m = round(detour.distance_m - planned_m, 1)
    return {
        "leg": [a, b],
        "at_frac": spec["at_frac"],
        "hazard_px": [round(float(hx), 1), round(float(hy), 1)],
        "radius_px": round(radius_px, 1),
        "trigger_path_index": ti,
        "trigger_t_min": r["t_min"][ti],
        "trigger_px": [tx, ty],
        "rejoin_path_index": e,
        "path": rr["path"], "t_min": rr["t_min"], "home_min": rr["home_min"],
        "minutes": rr["total_min"], "planned_minutes": planned,
        "extra_min": extra_min, "extra_m": extra_m,
        "why": [f"Rover camera confirmed a rock field {spec['warn_m']:.0f} m ahead on {_name(stops, a)}→{_name(stops, b)} "
                f"(3 frames)", f"Detour to {_name(stops, b)} adds {max(extra_m, 0):.0f} m and {max(extra_min, 0):.0f} min",
                "Orbital hazards stay on the map; camera detections only add hazards"],
    }


# --- Variants -----------------------------------------------------------------

def _summary(r, est_min):
    return (f"{r['distance_m'] / 1000:.1f} km, {est_min:.0f} min, steepest {r['max_slope_deg']:.0f}°")


def build_variant(vdef: dict, solver: LegSolver, terrain: Terrain, stops: dict, th: np.ndarray) -> dict:
    cfg = terrain.cfg
    seq = vdef["stops"]
    legs = _Legs(solver)
    r = assemble(seq, legs, terrain, stops, th)
    total = r["total_min"]
    for sp in r["stop_plan"]:
        x, y = stops[sp["id"]]["px"]
        sp["home_min"] = _home_at(th, x, y)
        sp["remaining_min"] = round(max(total - sp["arrive_min"], 0.0), 1)

    replan = []
    for d in replan_specs(seq, stops, cfg):
        sp = r["stop_plan"][d["index"]]
        planned = sp["remaining_min"]
        opts = [build_option(o, d["at"], planned, legs, terrain, stops, th) for o in d["options"]]
        replan.append({"at": d["at"], "stop_index": d["index"], "path_index": sp["path_index"],
                       "options": _order(opts)})

    why, detail = route_why(seq, legs, terrain, stops, summary=_summary(r, total))
    out = {
        "id": vdef["id"],
        "stops": seq,
        "distance_m": r["distance_m"],
        "est_min": total,
        "walk_min": r["walk_min"],
        "work_min": round(sum(work_min(stops[s], cfg) for s in seq[1:-1]), 1),
        "max_slope_deg": r["max_slope_deg"],
        "path": r["path"],
        "t_min": r["t_min"],
        "home_min": r["home_min"],
        "legs": r["legs"],
        "stop_plan": r["stop_plan"],
        "replan": replan,
        "checkpoints": checkpoints(r, seq, solver, terrain, stops, th),
        "why": why,
        "why_detail": detail,
    }
    hz = cfg.HAZARD_DEMO
    if hz and hz.get("variant") == vdef["id"]:
        demo = hazard_demo(r, hz, solver, terrain, stops, th)
        if demo:
            out["hazard_demo"] = demo
    return out


REPLAN_RULE = (
    "Each variant's path, t_min and home_min are parallel arrays: t_min is planned minutes since "
    "leaving the habitat, home_min is minutes to walk home from that point. Interpolate position "
    "linearly over t_min (a repeated point is a work stop). When the crew arrives at a stop at actual "
    "time T, look up replan[] for that stop and take the first option where "
    "T + option.minutes + reserve <= budget (options are ordered planned first, abort last). If none "
    "fits, take the abort option. An option's t_min is relative to arrival at that stop: add T. "
    "checkpoints[] apply the same rule mid-leg when the crew passes path_index at actual time T; "
    "checkpoint px lies on the segment path[path_index] -> path[path_index + 1] at t_min; its "
    "'planned' option has no path (it is the rest of the main path from that point). "
    "hazard_demo (optional) is a scripted rover-camera reroute: when the crew reaches "
    "trigger_path_index, offer its path (t_min relative to that moment), which rejoins the plan at "
    "rejoin_path_index."
)


def plan_routes(layers: Layers, stops_list: list[dict], cfg=default_cfg):
    """Run the whole engine. Returns (routes, time_home_bytes, time_home_grid, stops_list, legs)."""
    warnings = validate_layers(layers, cfg)
    terrain = build_terrain(layers, cfg)
    stops_list = [dict(s) for s in stops_list]
    warnings += snap_stops(stops_list, terrain.walk_blocked)
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

    solver = LegSolver(terrain, stops)
    th = time_home_from(terrain, stops[cfg.HABITAT_ID]["px"])
    th_bytes, th_meta = encode_time_home(th, cfg.TIME_HOME_STRIDE)
    th_meta["cell_m"] = cfg.TIME_HOME_STRIDE * cfg.PIXEL_M
    out_variants = [build_variant(v, solver, terrain, stops, th) for v in variants]

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
            "nogo_buffer_m": cfg.NOGO_BUFFER_PX * cfg.PIXEL_M,
            "weights": {"slope": cfg.W_SLOPE, "sand": cfg.W_SAND, "rough": cfg.W_ROUGH, "margin": cfg.W_MARGIN},
            "v_flat_kmh": cfg.V_FLAT_KMH,
            "sand_slowdown": cfg.SAND_SLOWDOWN,
            "rough_slowdown": cfg.ROUGH_SLOWDOWN,
            "asymmetric_walk": bool(layers.dtm is not None and cfg.ASYMMETRIC_WALK),
        },
        "assumptions": [
            f"Slope above {cfg.SLOPE_SOFT_DEG:g}° is costly and {cfg.SLOPE_HARD_DEG:g}° or more is no-go",
            f"Routes keep {cfg.NOGO_BUFFER_PX * cfg.PIXEL_M:g} m away from no-go ground",
            f"Suited walking speed {cfg.V_FLAT_KMH:g} km/h on flat ground, slower on slopes (Tobler-style), "
            f"up to {cfg.SAND_SLOWDOWN:.0%} slower in soft sand",
            "Cost weights are tuning knobs, not physics",
            ("Walking times include uphill vs downhill (Tobler)" if layers.dtm is not None and cfg.ASYMMETRIC_WALK
             else "Walking times ignore uphill vs downhill (no elevation model given)"),
        ],
        "warnings": warnings,
    }
    return routes, th_bytes.tobytes(), th, stops_list, solver.legs


# --- Output checks -------------------------------------------------------------

def _check_timed(obj, where, w, h, errors, need_path=True):
    path, t, home = obj.get("path"), obj.get("t_min"), obj.get("home_min")
    if not need_path and path is None:
        return
    if not isinstance(path, list) or not path:
        errors.append(f"{where}: path missing or empty")
        return
    if not (len(path) == len(t or []) == len(home or [])):
        errors.append(f"{where}: path/t_min/home_min lengths differ ({len(path)}/{len(t or [])}/{len(home or [])})")
    for p in path:
        if not (isinstance(p, list) and len(p) == 2 and all(isinstance(c, int) for c in p)
                and 0 <= p[0] < w and 0 <= p[1] < h):
            errors.append(f"{where}: bad path point {p}")
            break
    if t and any(b < a for a, b in zip(t, t[1:])):
        errors.append(f"{where}: t_min is not non-decreasing")


def validate_routes(routes: dict, grid_wh: tuple[int, int]) -> list[str]:
    """Contract check for routes.json. Returns a list of errors (empty = OK)."""
    w, h = grid_wh
    errors = []
    for key in ("variants", "time_home_file", "time_home", "replan_rule"):
        if key not in routes:
            errors.append(f"missing top-level key {key}")
    for v in routes.get("variants", []):
        vid = v.get("id", "?")
        for key in ("id", "stops", "distance_m", "est_min", "path", "why", "t_min", "home_min",
                    "stop_plan", "replan", "legs"):
            if key not in v:
                errors.append(f"variant {vid}: missing {key}")
        _check_timed(v, f"variant {vid}", w, h, errors)
        if v.get("t_min") and abs(v["t_min"][-1] - v.get("est_min", 0)) > 0.2:
            errors.append(f"variant {vid}: t_min ends at {v['t_min'][-1]} but est_min is {v.get('est_min')}")
        for d in v.get("replan", []):
            for o in d.get("options", []):
                _check_timed(o, f"variant {vid} replan@{d.get('at')} {o.get('kind')}", w, h, errors)
        for c in v.get("checkpoints", []):
            for o in c.get("options", []):
                _check_timed(o, f"variant {vid} checkpoint@{c.get('path_index')} {o.get('kind')}", w, h, errors,
                             need_path=False)
        if "hazard_demo" in v:
            _check_timed(v["hazard_demo"], f"variant {vid} hazard_demo", w, h, errors)
    return errors


# --- Finishing and writing -----------------------------------------------------

def finalize(routes: dict, budget: float, reserve: float) -> dict:
    for v in routes["variants"]:
        v["fits_budget"] = bool(v["est_min"] + reserve <= budget)
    routes["params"]["suit_budget_min"] = budget
    routes["params"]["suit_reserve_min"] = reserve
    return routes


def write_outputs(out_dir, routes: dict, th_bytes: bytes, grid_wh, cfg=default_cfg) -> int:
    """Validate, then write routes.json and time_home.bin. Returns routes.json size in bytes."""
    import json
    errors = validate_routes(routes, grid_wh)
    if errors:
        raise ValueError("routes.json failed the contract check:\n  " + "\n  ".join(errors[:20]))
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    text = json.dumps(routes, separators=(",", ":"), ensure_ascii=False)
    if len(text) > cfg.MAX_ROUTES_KB * 1024:
        routes.setdefault("warnings", []).append(
            f"routes.json is {len(text) / 1024:.0f} KB (limit {cfg.MAX_ROUTES_KB} KB); raise PATH_SIMPLIFY_PX or CHECKPOINT_MIN")
        text = json.dumps(routes, separators=(",", ":"), ensure_ascii=False)
    (out / "routes.json").write_text(text)
    (out / "time_home.bin").write_bytes(th_bytes)
    return len(text)


# --- Coarse-grid fallback ------------------------------------------------------

def config_copy(cfg=default_cfg, **overrides):
    from types import SimpleNamespace
    d = {k: getattr(cfg, k) for k in dir(cfg) if k.isupper()}
    d.update(overrides)
    return SimpleNamespace(**d)


def coarsen_layers(layers: Layers, k: int) -> Layers:
    """Block-reduce by k: slope takes the max (never hides a cliff), sand/rough/dtm the mean, no-go any."""
    h, w = layers.shape
    H, W = h // k, w // k

    def blocks(a):
        return a[: H * k, : W * k].reshape(H, k, W, k)

    return Layers(
        slope_deg=blocks(layers.slope_deg).max(axis=(1, 3)),
        sand=blocks(layers.sand).mean(axis=(1, 3)),
        rough=blocks(layers.rough).mean(axis=(1, 3)),
        nogo=blocks(layers.nogo).any(axis=(1, 3)),
        dtm=None if layers.dtm is None else blocks(layers.dtm).mean(axis=(1, 3)),
        speed_factor=None if layers.speed_factor is None else blocks(layers.speed_factor).min(axis=(1, 3)),
    )


_PX_KEYS = {"path", "px", "hazard_px", "trigger_px"}


def scale_routes(obj, k: int):
    """Scale every pixel coordinate in a routes dict from a coarse grid back to the full grid."""
    if isinstance(obj, dict):
        for key, v in obj.items():
            if key in _PX_KEYS and isinstance(v, list):
                if v and isinstance(v[0], list):
                    obj[key] = [[c * k + k // 2 for c in p] for p in v]
                else:
                    obj[key] = [c * k + k // 2 for c in v]
            elif key == "stops_px":
                obj[key] = {s: [c * k + k // 2 for c in p] for s, p in v.items()}
            elif key == "radius_px":
                obj[key] = round(v * k, 1)
            else:
                scale_routes(v, k)
    elif isinstance(obj, list):
        for v in obj:
            scale_routes(v, k)
    return obj


def plan_routes_coarse(layers: Layers, stops_list: list[dict], k: int, cfg=default_cfg):
    """Plan on a grid coarsened by k (the 'pathfinding too slow' fallback), output in full-grid pixels."""
    ccfg = config_copy(cfg, PIXEL_M=cfg.PIXEL_M * k, PATH_SIMPLIFY_PX=max(cfg.PATH_SIMPLIFY_PX / k, 0.5),
                       NOGO_BUFFER_PX=max(1, round(cfg.NOGO_BUFFER_PX / k)), MARGIN_PX=cfg.MARGIN_PX / k)
    coarse_stops = [{**s, "px": [int(s["px"][0]) // k, int(s["px"][1]) // k]} for s in stops_list]
    routes, th_bytes, th, snapped, legs = plan_routes(coarsen_layers(layers, k), coarse_stops, ccfg)
    scale_routes(routes, k)
    routes["time_home"]["stride_px"] *= k
    routes["params"]["pixel_m"] = cfg.PIXEL_M
    routes["params"]["coarsened_by"] = k
    routes["warnings"].append(f"planned on a {cfg.PIXEL_M * k:g} m grid (coarsened by {k})")
    snapped = [{**s, "px": [c * k + k // 2 for c in s["px"]]} for s in snapped]
    return routes, th_bytes, th, snapped, legs


# --- Real data (docs/engine_guide.md) -----------------------------------------------

SAND_LEVEL = {0: 0.0, 1: 0.5, 2: 1.0}  # sand class -> 0..1 for the cost grid (1 = large ridges)


def load_real(data_dir="data", cfg=default_cfg):
    """Load the Data pipeline's files. Returns (layers, stops_list, cfg_for_this_data, info).

    Numbers come from data/safety_params.json, so they always match the pipeline:
    hard/soft slope, flat walking speed, sand and rocky speed factors, suit budget,
    reserve and work times. Sand only slows the crew and never blocks; no-go is the
    pipeline's precomputed mask.
    """
    import json
    d = Path(data_dir)
    g = np.load(d / "grids.npz")
    P = {k: v["value"] for k, v in json.loads((d / "safety_params.json").read_text())["params"].items()}
    site = json.loads((d / "site.json").read_text())
    photos = json.loads((d / "photos.json").read_text()) if (d / "photos.json").exists() else {}
    tubes = json.loads((d / "depot.json").read_text()) if (d / "depot.json").exists() else []

    sand_cls = g["sand"].astype(np.int16)
    rocky = g["rocky"].astype(bool)
    factor = np.ones(sand_cls.shape, np.float32)
    factor[sand_cls == 1] *= P["speed_factor_sand_small"]
    factor[sand_cls == 2] *= P["speed_factor_sand_large"]
    factor[rocky] *= P["speed_factor_rocky"]
    rough_m = g["rough_m"].astype(np.float32)
    layers = Layers(
        slope_deg=g["slope_deg"].astype(np.float32),
        sand=np.vectorize(SAND_LEVEL.get, otypes=[np.float32])(sand_cls) if sand_cls.max() <= 2 else (sand_cls > 0).astype(np.float32),
        # cost: blocky units count fully, otherwise relief relative to the no-go limit
        rough=np.maximum(rocky.astype(np.float32), np.nan_to_num(rough_m / P["rough_hard_m"]).clip(0, 0.9)),
        nogo=g["nogo"].astype(bool),
        dtm=g["elevation_m"].astype(np.float32),
        speed_factor=factor,
    )
    rcfg = config_copy(
        cfg,
        SLOPE_SOFT_DEG=float(P["slope_soft_deg"]), SLOPE_HARD_DEG=float(P["slope_hard_deg"]),
        V_FLAT_KMH=float(P["walk_speed_flat_kmh"]),
        SUIT_BUDGET_MIN=float(P["suit_budget_min"]), SUIT_RESERVE_MIN=float(P["reserve_min"]),
        DEFAULT_WORK_MIN={"base": 0, "science": float(P["work_min_science_stop"]), "depot": float(P["work_min_depot"])},
        SAND_LABEL="sand ridges",
    )

    def pics(k, n=6):
        e = photos.get(k) or {}
        feat = [p["url"] for p in e.get("featured", []) if p.get("url")]
        cand = [p.get("url") for p in e.get("candidates", []) if p.get("url")]
        return (feat + cand)[:n]

    def sol_of(k):
        e = photos.get(k) or {}
        return (e.get("candidates") or [{}])[0].get("sol")

    h, a, b = site["habitat"], site["stop_a"], site["depot_center"]
    minerals = []
    if a.get("clay_frac"):
        minerals.append(f"Clay-bearing ({a['clay_frac']:.0%} of identified CRISM cells within 75 m)")
    if a.get("carb_frac"):
        minerals.append(f"carbonate ({a['carb_frac']:.0%} of the work area)")
    cored = ", ".join(a.get("depot_samples_cored_here") or [])
    stops = [
        {"id": "H", "name": "Habitat", "kind": "base", "px": h["px"],
         "why": f"Pressurized habitat on flat ground ({h.get('mean_slope_100m_deg', '?')}° mean slope within 100 m), "
                f"{h.get('stack_unit', '')}, {h.get('dist_to_depot_m', '?')} m from the depot".strip(", "),
         "expect": (photos.get("H") or {}).get("note") or "", "rock_unit": h.get("stack_unit", ""),
         "photos": pics("H"), "sol": sol_of("H")},
        {"id": "A", "name": "Delta outcrop", "kind": "science", "px": a["px"],
         "work_min": float(P["work_min_science_stop"]), "sol": a.get("sol"),
         "why": f"{a.get('stack_unit', 'Delta')} bedrock at the delta front, where CRISM maps clay minerals that form in water "
                f"and can preserve signs of past life" + (f". Perseverance cored {cored} here" if cored else ""),
         "expect": f"Layered sediments; slopes under {a.get('hirise_slope_p90_deg', '?')}° across the work area "
                   f"(90th percentile), no sand",
         "minerals": ", ".join(minerals), "rock_unit": a.get("stack_unit", ""), "photos": pics("A")},
        {"id": "B", "name": "Three Forks depot", "kind": "depot", "px": b["px"],
         "work_min": float(P["work_min_depot"]), "sol": 653,
         "why": f"Three Forks sample depot: retrieve the {len(tubes) or 10} cached sample tubes for return to Earth",
         "expect": f"{len(tubes) or 10} tubes spread over about {b.get('tube_spread_m', 35)} m on flat ground",
         "rock_unit": "", "photos": pics("B"), "tubes": len(tubes)},
    ]
    info = {"params": P, "site": site, "tubes": tubes}
    return layers, stops, rcfg, info
