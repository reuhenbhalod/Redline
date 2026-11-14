"""Shared pipeline config. Every number here is a tuning knob or a stated assumption.

Data owns the box / grid section; Engine owns the routing section.
Anything marked ASSUMPTION must be labeled as such in the UI.
"""

# --- Grid (shared with Data) -------------------------------------------------
GRID_SIZE_PX = 2000          # grid is GRID_SIZE_PX x GRID_SIZE_PX
PIXEL_M = 2.0                # meters per grid cell

# --- Terrain thresholds (ASSUMPTIONS) ----------------------------------------
SLOPE_SOFT_DEG = 15.0        # above this, walking gets much more expensive
SLOPE_HARD_DEG = 25.0        # at or above this, the cell is no-go
SAND_SOFT_MIN = 0.5          # sand layer value (0..1) counted as "soft sand" in why-lines

# --- Cost grid weights (tuning knobs, not physics) ---------------------------
# cost = 1 + W_SLOPE * (slope / SLOPE_SOFT_DEG)^2 + W_SAND * sand + W_ROUGH * rough
#          + W_MARGIN * exp(-distance_to_no_go / MARGIN_PX)
W_SLOPE = 4.0
W_SAND = 6.0
W_ROUGH = 2.0
W_MARGIN = 2.0               # soft push away from cliff edges and data gaps
MARGIN_PX = 5.0              # how fast that push fades (cells)
NOGO_BUFFER_PX = 2           # hard buffer: no-go grows by this many cells (2 px = 4 m)

# --- Walking model (ASSUMPTIONS) ---------------------------------------------
# Speed follows Tobler's hiking function: v = V_FLAT * exp(-K |grade + 0.05|) / exp(-K * 0.05),
# using the slope magnitude when no DTM is given (so uphill and downhill are treated alike).
# V_FLAT is already reduced for suit mass; the crew walks unloaded (rover carries tools).
V_FLAT_KMH = 2.0
TOBLER_K = 3.5
TOBLER_OFFSET = 0.05         # Tobler's fastest grade is a slight downhill (-5%)
ASYMMETRIC_WALK = True       # use the DTM (if provided) so uphill and downhill differ on legs
SAND_SLOWDOWN = 0.4          # speed x (1 - SAND_SLOWDOWN * sand)
ROUGH_SLOWDOWN = 0.3         # speed x (1 - ROUGH_SLOWDOWN * rough)

# Work time at each stop when stops.json doesn't give one (minutes).
DEFAULT_WORK_MIN = {"base": 0, "science": 45, "depot": 30}

# --- Suit budget (ASSUMPTION; env.json from Story overrides these) -----------
SUIT_BUDGET_MIN = 300        # Apollo-era five-hour time-in-suit reference
SUIT_RESERVE_MIN = 30

# --- Route variants ----------------------------------------------------------
# The full plan first. In-walk replans use the per-stop / checkpoint options in routes.json.
HABITAT_ID = "H"
VARIANTS = [
    {"id": "full", "stops": ["H", "A", "B", "H"]},
    {"id": "skipA", "stops": ["H", "B", "H"]},
]

# --- Mid-leg replan checkpoints and the hazard demo ----------------------------
CHECKPOINT_MIN = 15          # a replan checkpoint every this many planned minutes while walking
HAZARD_DEMO = {              # rover camera "sees" a rock field ahead on this leg (set None to disable)
    "variant": "full", "leg": ["A", "B"], "at_frac": [0.2, 0.3, 0.4, 0.5, 0.6, 0.7], "radius_m": 60, "warn_m": 100,
}

# --- Export ------------------------------------------------------------------
PATH_SIMPLIFY_PX = 1.0       # Douglas-Peucker tolerance for routes.json paths
WHY_MIN_M = 20.0             # only mention an avoided hazard if the detour skips this much of it
WHY_MAX_LINES = 4            # summary + top hazards per route (all lines stay in why_detail)
MAX_ROUTES_KB = 800          # warn if routes.json grows past this
TIME_HOME_STRIDE = 2         # time_home.bin is downsampled by this factor (2 -> 1000x1000)
