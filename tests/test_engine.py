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
    L = flat(10)
    L.slope_deg[2, 2] = cfg.SLOPE_HARD_DEG
    L.slope_deg[3, 3] = np.nan
    c = engine.cost_grid(L)
    assert np.isinf(c[2, 2]) and np.isinf(c[3, 3])
    assert c[0, 0] == 1.0


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
