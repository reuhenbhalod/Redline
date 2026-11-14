import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
import config as cfg  # noqa: E402
import engine  # noqa: E402
import fake_terrain  # noqa: E402


def flat(n=60):
    z = np.zeros((n, n), np.float32)
    return engine.Layers(slope_deg=z.copy(), sand=z.copy(), rough=z.copy(), nogo=np.zeros((n, n), bool))


def stops(h, a, b):
    return [
        {"id": "H", "name": "Habitat", "px": list(h), "kind": "base"},
        {"id": "A", "name": "Outcrop", "px": list(a), "kind": "science", "work_min": 0},
        {"id": "B", "name": "Depot", "px": list(b), "kind": "depot", "work_min": 10},
    ]


def test_hard_slope_and_missing_data_are_infinite():
    L = flat(40)
    L.slope_deg[2, 2] = cfg.SLOPE_HARD_DEG
    L.slope_deg[3, 3] = np.nan
    c = engine.cost_grid(L)
    assert np.isinf(c[2, 2]) and np.isinf(c[3, 3])
    assert np.isinf(c[2 + cfg.NOGO_BUFFER_PX, 2])  # safety buffer
    assert c[10, 10] > c[39, 39]  # soft margin near no-go
    assert c[39, 39] == pytest.approx(1.0, abs=1e-3)


def test_flat_leg_is_straight_with_correct_distance_and_time():
    L = flat()
    routes, *_ = engine.plan_routes(L, stops((5, 30), (55, 30), (30, 5)))
    full = routes["variants"][0]
    leg = full["legs"][0]
    assert leg["distance_m"] == pytest.approx(50 * cfg.PIXEL_M)
    speed = cfg.V_FLAT_KMH * 1000 / 60
    assert leg["walk_min"] == pytest.approx(100 / speed, abs=0.1)
    # straight path simplifies to its two endpoints, in [x, y]
    assert full["path"][0] == [5, 30] and full["path"][1] == [55, 30]


def test_route_goes_around_a_wall_and_explains_it():
    L = flat()
    L.nogo[10:60, 25:40] = True  # 30 m thick wall, open only at the top
    routes, *_ = engine.plan_routes(L, stops((5, 50), (55, 50), (30, 2)))
    full = routes["variants"][0]
    pts = np.array(full["path"])
    assert pts[:, 1].min() < 10  # went north around the wall
    assert not any(L.nogo[y, x] for x, y in pts)
    assert any("no-go" in w for w in full["why"])


def test_work_min_uses_default_for_placeholder_zero():
    L = flat()
    routes, *_ = engine.plan_routes(L, stops((5, 30), (55, 30), (30, 5)))
    full = next(v for v in routes["variants"] if v["id"] == "full")
    assert full["work_min"] == cfg.DEFAULT_WORK_MIN["science"] + 10


def test_stop_on_nogo_is_snapped():
    L = flat()
    L.nogo[28:33, 28:33] = True
    routes, *_ = engine.plan_routes(L, stops((5, 5), (30, 30), (50, 50)))
    x, y = routes["stops_px"]["A"]
    assert not L.nogo[y, x]
    assert any("moved" in w for w in routes["warnings"])


def test_time_home_zero_at_habitat_and_grows():
    L = flat()
    th = engine.time_home(L, (5, 5))
    assert th[5, 5] == 0
    assert th[50, 50] > th[20, 20] > 0
    data, meta = engine.encode_time_home(th, 2)
    assert data.dtype == np.dtype("<u2") and data.shape == (30, 30)
    assert meta["width"] == 30


def test_unreachable_stop_raises():
    L = flat()
    L.nogo[:, 30] = True
    with pytest.raises(RuntimeError, match="no safe path"):
        engine.plan_routes(L, stops((5, 5), (50, 5), (5, 50)))


def test_routes_json_matches_contract_on_fake_terrain(tmp_path):
    grid = fake_terrain.write_fake(tmp_path, size=400)
    L = engine.load_layers(grid)
    st = json.loads((grid / "stops.json").read_text())
    routes, th_bytes, *_ = engine.plan_routes(L, st)
    json.dumps(routes)  # serializable
    assert routes["time_home_file"] == "time_home.bin"
    assert len(th_bytes) == routes["time_home"]["width"] * routes["time_home"]["height"] * 2
    ids = [v["id"] for v in routes["variants"]]
    assert ids == ["full", "skipA"]
    for v in routes["variants"]:
        for key in ("stops", "distance_m", "est_min", "path", "why"):
            assert key in v
        assert all(len(p) == 2 and all(isinstance(c, int) for c in p) for p in v["path"])
        assert all(0 <= x < 400 and 0 <= y < 400 for x, y in v["path"])
    full, short = routes["variants"]
    assert short["est_min"] < full["est_min"]


# --- Component 8: timelines and replan options -------------------------------

def planned(L=None):
    L = L or flat()
    routes, *_ = engine.plan_routes(L, stops((5, 30), (55, 30), (30, 5)))
    return {v["id"]: v for v in routes["variants"]}


def test_timeline_is_parallel_monotonic_and_ends_at_est_min():
    for v in planned().values():
        assert len(v["path"]) == len(v["t_min"]) == len(v["home_min"])
        assert v["t_min"][0] == 0
        assert all(b >= a for a, b in zip(v["t_min"], v["t_min"][1:]))
        assert v["t_min"][-1] == pytest.approx(v["est_min"], abs=0.1)
        assert v["home_min"][0] == 0 and v["home_min"][-1] == 0


def test_work_stop_is_a_repeated_point_with_dwell_time():
    full = planned()["full"]
    a = next(s for s in full["stop_plan"] if s["id"] == "A")
    i = a["path_index"]
    assert full["path"][i] == full["path"][i + 1] == [55, 30]
    assert full["t_min"][i + 1] - full["t_min"][i] == pytest.approx(cfg.DEFAULT_WORK_MIN["science"], abs=0.01)
    assert a["depart_min"] - a["arrive_min"] == pytest.approx(cfg.DEFAULT_WORK_MIN["science"], abs=0.01)


def test_replan_options_at_each_stop():
    v = planned()
    full = v["full"]
    at = {r["at"]: [o["kind"] for o in r["options"]] for r in full["replan"]}
    assert at["H"] == ["planned", "drop"]
    assert at["A"] == ["planned", "skip_work", "abort"]
    assert at["B"] == ["planned"]  # depot work is never cut; going home is already the plan


def test_replan_minutes_line_up_with_plan_and_variants():
    v = planned()
    full = v["full"]
    for r in full["replan"]:
        sp = full["stop_plan"][r["stop_index"]]
        assert r["options"][0]["minutes"] == pytest.approx(sp["remaining_min"], abs=0.1)
    drop_at_h = next(o for o in full["replan"][0]["options"] if o["kind"] == "drop")
    assert drop_at_h["stops"] == v["skipA"]["stops"]
    assert drop_at_h["minutes"] == pytest.approx(v["skipA"]["est_min"], abs=0.1)
    skip = next(o for o in full["replan"][1]["options"] if o["kind"] == "skip_work")
    assert skip["saves_min"] == pytest.approx(cfg.DEFAULT_WORK_MIN["science"], abs=0.1)
    abort = full["replan"][1]["options"][-1]
    assert abort["abort"] and abort["stops"] == ["A", "H"]


# --- Engine hardening and stretch features ------------------------------------

def test_path_keeps_buffer_from_nogo_and_drawn_path_never_cuts_it():
    L = flat(80)
    L.nogo[20:80, 38:42] = True
    routes, *_ = engine.plan_routes(L, stops((10, 70), (70, 70), (40, 5)))
    blocked = engine.walk_blocked_mask(engine.blocked_mask(L))
    from skimage.draw import line
    for v in routes["variants"]:
        p = v["path"]
        for (x0, y0), (x1, y1) in zip(p, p[1:]):
            rr, cc = line(y0, x0, y1, x1)
            assert not blocked[rr, cc].any()


def test_sand_and_rough_slow_walking():
    v_flat = engine.speed_m_per_min(0.0)
    assert engine.speed_m_per_min(0.0, sand=1.0) == pytest.approx(v_flat * (1 - cfg.SAND_SLOWDOWN))
    assert engine.speed_m_per_min(0.0, rough=1.0) == pytest.approx(v_flat * (1 - cfg.ROUGH_SLOWDOWN))


def test_uphill_slower_than_downhill_with_dtm():
    L = flat()
    yy, xx = np.mgrid[0:60, 0:60]
    L.dtm = (xx * 0.2 * cfg.PIXEL_M).astype(np.float32)  # 20% grade rising to the east
    L.slope_deg[:] = np.degrees(np.arctan(0.2))
    up = engine.leg_clock(np.array([[30, c] for c in range(5, 55)]), L)[-1]
    down = engine.leg_clock(np.array([[30, c] for c in range(54, 4, -1)]), L)[-1]
    assert up > down * 1.3  # Tobler: ~1.4x at a 20% grade
    flat_v = engine.speed_m_per_min(0.0, grade=0.0)
    assert flat_v == pytest.approx(cfg.V_FLAT_KMH * 1000 / 60)


def test_why_is_capped_with_summary_and_full_detail_kept():
    full = planned()["full"]
    assert len(full["why"]) <= cfg.WHY_MAX_LINES
    assert "km" in full["why"][0] and "min" in full["why"][0]
    assert len(full["why_detail"]) >= 1


def test_checkpoints_mid_leg():
    L = flat(400)
    routes, *_ = engine.plan_routes(L, stops((20, 380), (380, 380), (200, 20)))
    full = next(v for v in routes["variants"] if v["id"] == "full")
    cps = full["checkpoints"]
    assert cps, "expected mid-leg checkpoints"
    for c in cps:
        j = c["path_index"]
        assert full["path"][j] != full["path"][j + 1]  # never inside a work dwell
        assert full["t_min"][j] <= c["t_min"] <= full["t_min"][j + 1]
        kinds = [o["kind"] for o in c["options"]]
        assert kinds[0] == "planned"
        planned_min = c["options"][0]["minutes"]
        assert planned_min == pytest.approx(full["est_min"] - c["t_min"], abs=0.2)
        for o in c["options"][1:]:
            assert o["path"][0] == c["px"]
    # on the way to A (science) you can drop A; on the way home there is nothing to drop
    first = cps[0]
    assert first["next_stop"] == "A"
    assert [o["kind"] for o in first["options"]] == ["planned", "drop", "abort"]
    drop = first["options"][1]
    assert drop["stops"] == ["@", "B", "H"] and drop["minutes"] < first["options"][0]["minutes"]


def test_hazard_demo_detours_around_the_rock_field():
    L = flat(120)
    c = engine.config_copy(cfg, HAZARD_DEMO={"variant": "full", "leg": ["A", "B"], "at_frac": [0.4, 0.5, 0.6],
                                             "radius_m": 12, "warn_m": 20})
    routes, *_ = engine.plan_routes(L, stops((10, 100), (60, 60), (110, 10)), c)
    full = next(v for v in routes["variants"] if v["id"] == "full")
    hz = full["hazard_demo"]
    hx, hy = hz["hazard_px"]
    for x, y in hz["path"]:
        assert (x - hx) ** 2 + (y - hy) ** 2 > hz["radius_px"] ** 2
    assert hz["path"][0] == full["path"][hz["trigger_path_index"]]
    assert hz["path"][-1] == routes["stops_px"]["B"]
    assert hz["extra_m"] > 0 and hz["extra_min"] > 0


def test_validate_routes_accepts_good_and_catches_bad():
    L = flat()
    routes, *_ = engine.plan_routes(L, stops((5, 30), (55, 30), (30, 5)))
    assert engine.validate_routes(routes, (60, 60)) == []
    routes["variants"][0]["t_min"] = routes["variants"][0]["t_min"][:-1]
    del routes["variants"][1]["why"]
    errs = engine.validate_routes(routes, (60, 60))
    assert any("lengths differ" in e for e in errs) and any("missing why" in e for e in errs)


def test_validate_layers_and_bounds():
    L = flat()
    L.slope_deg[0, 0] = 150  # percent, not degrees
    with pytest.raises(ValueError, match="out of range"):
        engine.validate_layers(L)
    L = flat()
    engine.check_bounds({"width_px": 60, "height_px": 60, "pixel_m": cfg.PIXEL_M}, L)
    with pytest.raises(ValueError):
        engine.check_bounds({"width_px": 2000, "height_px": 2000, "pixel_m": cfg.PIXEL_M}, L)


def test_roughness_from_dtm_when_rough_missing(tmp_path):
    rng = np.random.default_rng(0)
    dtm = np.zeros((50, 50), np.float32)
    dtm[:, 25:] = rng.normal(0, 2, (50, 25))
    np.save(tmp_path / "slope_deg.npy", np.zeros((50, 50), np.float32))
    np.save(tmp_path / "dtm.npy", dtm)
    L = engine.load_layers(tmp_path)
    assert L.rough[:, 35:].mean() > L.rough[:, :15].mean() + 0.3


@pytest.mark.parametrize("scenario", fake_terrain.SCENARIOS)
def test_fake_scenarios_route(tmp_path, scenario):
    grid = fake_terrain.write_fake(tmp_path, size=300, scenario=scenario)
    L = engine.load_layers(grid)
    st = json.loads((grid / "stops.json").read_text())
    routes, *_ = engine.plan_routes(L, st)
    assert engine.validate_routes(routes, (300, 300)) == []


def test_time_home_matches_walk_home_with_dtm():
    """Time-home grid is the fastest way home, so never slower than the planned leg home."""
    import fake_terrain as ft
    dtm, slope, sand, rough, nogo = ft.make_layers(300)
    L = engine.Layers(slope, sand, rough, nogo, dtm=dtm)
    routes, *_ = engine.plan_routes(L, ft.fake_stops(300))
    full = next(v for v in routes["variants"] if v["id"] == "full")
    last = full["legs"][-1]
    b = next(s for s in full["stop_plan"] if s["id"] == last["from"])
    assert b["home_min"] <= last["walk_min"] * 1.02
    assert b["home_min"] >= last["walk_min"] * 0.7
    # downhill-aware: a crew on a hill gets home faster than the symmetric model says
    sym = engine.time_home_from(engine.build_terrain(engine.Layers(slope, sand, rough, nogo)), full["stop_plan"][0]["id"] and routes["stops_px"]["H"])
    x, y = routes["stops_px"][last["from"]]
    assert b["home_min"] < sym[y, x]
