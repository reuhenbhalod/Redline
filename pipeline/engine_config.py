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
W_SLOPE = 4.0
W_SAND = 6.0
W_ROUGH = 2.0

# --- Walking model (ASSUMPTIONS) ---------------------------------------------
# Speed follows Tobler's hiking function shape: v = V_FLAT * exp(-TOBLER_K * tan(slope)).
# V_FLAT is already reduced for suit mass; the crew walks unloaded (rover carries tools).
V_FLAT_KMH = 2.0
TOBLER_K = 3.5

# Work time at each stop when stops.json doesn't give one (minutes).
DEFAULT_WORK_MIN = {"base": 0, "science": 45, "depot": 30}

# --- Suit budget (ASSUMPTION; env.json from Story overrides these) -----------
SUIT_BUDGET_MIN = 300        # Apollo-era five-hour time-in-suit reference
SUIT_RESERVE_MIN = 30

# --- Route variants ----------------------------------------------------------
# Ordered longest plan first. The browser's replan steps down this list.
HABITAT_ID = "H"
VARIANTS = [
    {"id": "full", "stops": ["H", "A", "B", "H"]},
    {"id": "skipA", "stops": ["H", "B", "H"]},
]

# --- Export ------------------------------------------------------------------
PATH_SIMPLIFY_PX = 1.0       # Douglas-Peucker tolerance for routes.json paths
WHY_MIN_M = 20.0             # only mention an avoided hazard if the detour skips this much of it
TIME_HOME_STRIDE = 2         # time_home.bin is downsampled by this factor (2 -> 1000x1000)
