"""D1: site and grid.

1. Tube positions: each tube's drop sol (PDS depot bundle) joined to the rover's
   last waypoint before that sol (no drive happens on a drop sol in the data).
2. Stop A shortlist: Perseverance waypoints from the delta campaign (sols 400-640)
   on a Stack "Delta" bedrock unit, not on bedforms, scored by CRISM clay fraction.
3. Habitat: flat (CTX 20 m slope), smooth ground, 1-2 km from the depot, chosen so
   habitat + stop A + depot fit inside the 4 km box with a margin.
4. Box + local true-scale CRS centered on those points -> data/bounds.json.
Outputs: data/bounds.json, data/depot.json, data/site.json, pipeline/qa/site_overview.png
"""
import json, sys
from pathlib import Path
import numpy as np
import rasterio
from rasterio import features
from rasterio.transform import from_origin
from rasterio.windows import from_bounds

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as C
import common as U

MARGIN_M = 300            # keep every stop this far inside the box edge
A_DIST = (300, 2000)      # stop A distance from depot center (m)
H_DIST = (1000, 2000)     # habitat distance from depot center (m)
H_MAX_SLOPE = 2.0         # deg, mean slope within 100 m of habitat (CTX)
CLAY_RADIUS_M = 75


def tubes():
    wps = sorted(U.load_waypoints(), key=lambda p: (int(p["sol"]), int(p["site"]), int(p["drive"])))
    out = []
    for d in U.load_drops():
        s = d["drop_sol"]
        assert not any(int(p["sol"]) == s for p in wps), f"waypoint on drop sol {s}: position ambiguous"
        prev = [p for p in wps if int(p["sol"]) < s][-1]
        out.append({"name": d["Sample Name"], "sample_id": d["Sample Designation"], "drop_sol": s,
                    "drop_lmst": d["MARS_SURFACE Timestamp (LMST)"],
                    "lon": prev["lon"], "lat": prev["lat"],
                    "from_waypoint": {"sol": int(prev["sol"]), "site": prev["site"], "drive": prev["drive"]}})
    return out


def stack_raster(cx, cy, half=6000, res=4.0):
    """Rasterize the Stack map around (cx, cy) in source eqc. Returns (labels array, id->label, transform)."""
    polys, skipped = U.load_stack()
    labels = sorted({p[1] for p in polys} | {p[3] for p in polys if p[3]})
    lid = {l: i + 1 for i, l in enumerate(labels)}
    T = from_origin(cx - half, cy + half, res, res)
    n = int(2 * half / res)
    lab = features.rasterize(((g, lid[l]) for g, l, _, _ in polys), out_shape=(n, n), transform=T, fill=0, dtype="uint16")
    bed = features.rasterize(((g, lid[b]) for g, _, _, b in polys if b), out_shape=(n, n), transform=T, fill=0, dtype="uint16")
    return lab, bed, {v: k for k, v in lid.items()}, T, skipped


def sample(arr, T, x, y):
    r, c = rasterio.transform.rowcol(T, x, y)
    return arr[r, c] if 0 <= r < arr.shape[0] and 0 <= c < arr.shape[1] else 0


def main():
    # ---- 1. tubes ----
    tb = tubes()
    dlon, dlat = float(np.mean([t["lon"] for t in tb])), float(np.mean([t["lat"] for t in tb]))
    spread = max(U.ground_dist_m(dlon, dlat, t["lon"], t["lat"]) for t in tb)
    print(f"depot center {dlon:.5f}E {dlat:.5f}N, tubes within {spread:.0f} m of center")
    dx, dy = U.lonlat_to_src(dlon, dlat)

    lab, bed, names, ST, skipped = stack_raster(dx, dy)
    print(f"Stack map rasterized ({skipped} empty geometries skipped)")

    with rasterio.open(C.RAW / "crism" / "jezeroFinal.tif") as d:
        cid, conf, cdist = U.crism_decode(d.read())
        CT = d.transform
    cov = cid != U.CRISM_NO_COVERAGE
    unc = (cid[cov] == U.CRISM_UNCERTAIN).mean()
    print(f"CRISM: {cov.mean():.0%} of file covered, {unc:.1%} of covered pixels are edge blends (uncertain)")
    assert unc < 0.15, "too many undecodable CRISM colors"
    rpx = int(round(CLAY_RADIUS_M / abs(CT.a)))

    def crism_stats(x, y):
        r, c = rasterio.transform.rowcol(CT, x, y)
        f = U.crism_fractions(cid[max(r - rpx, 0): r + rpx + 1, max(c - rpx, 0): c + rpx + 1])
        return f["clay"], f["carbonate"], f["unidentified"], f["coverage"]

    # ---- 2. stop A shortlist ----
    # Where each depot sample was cored: the rover does not drive on coring sols, so the
    # coring position is the last waypoint before the coring sol (same rule as the tubes).
    wps_sorted = sorted(U.load_waypoints(), key=lambda p: (int(p["sol"]), int(p["site"]), int(p["drive"])))
    cored = []
    for t in tb:
        s = int(t["sample_id"].split("-")[1])
        prev = [p for p in wps_sorted if int(p["sol"]) <= s][-1]
        cored.append({"name": t["name"], "sample_id": t["sample_id"], "cored_sol": s, "lon": prev["lon"], "lat": prev["lat"]})
    seen, cands = [], []
    for p in U.load_waypoints():
        s = int(p["sol"])
        if not 400 <= s <= 640:
            continue
        if any(U.ground_dist_m(p["lon"], p["lat"], q[0], q[1]) < 15 for q in seen):
            continue
        seen.append((p["lon"], p["lat"]))
        dist = float(U.ground_dist_m(dlon, dlat, p["lon"], p["lat"]))
        if not A_DIST[0] <= dist <= A_DIST[1]:
            continue
        x, y = U.lonlat_to_src(p["lon"], p["lat"])
        surf, bedrock = names.get(sample(lab, ST, x, y), ""), names.get(sample(bed, ST, x, y), "")
        if not bedrock.startswith("Delta") or surf in U.SAND_UNITS:
            continue
        clay, carb, none, coverage = crism_stats(x, y)
        if coverage < 0.8:   # stop A must sit inside CRISM coverage
            continue
        here = [k["name"] for k in cored if U.ground_dist_m(k["lon"], k["lat"], p["lon"], p["lat"]) < 20]
        cands.append({"sol": s, "site": p["site"], "drive": p["drive"], "lon": p["lon"], "lat": p["lat"],
                      "dist_to_depot_m": round(dist), "stack_unit": surf, "stack_bedrock": bedrock,
                      "clay_frac": round(clay, 3), "carb_frac": round(carb, 3), "crism_none_frac": round(none, 3),
                      "crism_coverage": round(coverage, 3),
                      "depot_samples_cored_here": here,
                      "score": round(clay + (0.15 if here else 0), 3)})
    cands.sort(key=lambda c: -c["score"])
    assert cands, "no stop A candidates"
    print("stop A shortlist:")
    for c in cands[:8]:
        print(f"  sol {c['sol']:>3}  {c['dist_to_depot_m']:>5} m  clay {c['clay_frac']:.2f} carb {c['carb_frac']:.2f}"
              f"  {c['stack_bedrock']}{'  [cored here: ' + ', '.join(c['depot_samples_cored_here']) + ']' if c['depot_samples_cored_here'] else ''}")
    print("depot samples cored inside the box area:")
    for k in cored:
        dd = float(U.ground_dist_m(dlon, dlat, k["lon"], k["lat"]))
        if dd < 2500: print(f"  {k['name']:<15} sol {k['cored_sol']}  {dd:.0f} m from depot")
    A = cands[0]

    # ---- 3. habitat ----
    with rasterio.open(next((C.RAW / "ctx").glob("*.tif"))) as d:
        w = from_bounds(dx - 3000, dy - 3000, dx + 3000, dy + 3000, d.transform)
        z = d.read(1, window=w).astype(float); WT = d.window_transform(w)
        z[z < -1e30] = np.nan
    res = abs(WT.a); ground_dx = res * np.cos(np.radians(dlat))  # source eqc x is stretched (finding 1)
    gy, gx = np.gradient(z, res, ground_dx)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    from scipy.ndimage import uniform_filter
    k = max(int(round(200 / res)), 3)  # 100 m radius
    mslope = uniform_filter(np.nan_to_num(slope, nan=90), k)
    rows, cols = np.mgrid[0:z.shape[0]:2, 0:z.shape[1]:2]
    xs, ys = rasterio.transform.xy(WT, rows.ravel(), cols.ravel())
    best = None
    ax_, ay_ = U.lonlat_to_src(A["lon"], A["lat"])
    for x, y, r, c in zip(xs, ys, rows.ravel(), cols.ravel()):
        if mslope[r, c] > H_MAX_SLOPE:
            continue
        lon, lat = U.src_to_lonlat(x, y)
        dist = U.ground_dist_m(dlon, dlat, lon, lat)
        if not H_DIST[0] <= dist <= H_DIST[1]:
            continue
        unit = names.get(sample(lab, ST, x, y), "")
        if unit in U.SAND_UNITS or unit in U.ROCKY_UNITS or unit.startswith("Delta") or not unit:
            continue
        pts = [(lon, lat), (A["lon"], A["lat"])] + [(t["lon"], t["lat"]) for t in tb]
        lons, lats = [p[0] for p in pts], [p[1] for p in pts]
        ew = U.ground_dist_m(min(lons), np.mean(lats), max(lons), np.mean(lats))
        ns = U.ground_dist_m(0, min(lats), 0, max(lats))
        if max(ew, ns) > C.BOX_M - 2 * MARGIN_M:
            continue
        cost = mslope[r, c] + abs(dist - 1500) / 1000  # flattest, ~1.5 km out
        if best is None or cost < best[0]:
            best = (cost, lon, lat, float(mslope[r, c]), float(dist), unit)
    assert best, "no habitat site fits"
    H = {"lon": best[1], "lat": best[2], "mean_slope_100m_deg": round(best[3], 2),
         "dist_to_depot_m": round(best[4]), "stack_unit": best[5], "slope_source": "CTX 20 m DTM (confirmed in D2 with HiRISE)"}
    print(f"habitat {H['lon']:.5f}E {H['lat']:.5f}N  slope {H['mean_slope_100m_deg']} deg  {H['dist_to_depot_m']} m from depot  ({H['stack_unit']})")

    # ---- 4. box + local CRS ----
    pts = [(H["lon"], H["lat"]), (A["lon"], A["lat"])] + [(t["lon"], t["lat"]) for t in tb]
    lon0 = round((min(p[0] for p in pts) + max(p[0] for p in pts)) / 2, 6)
    lat0 = round((min(p[1] for p in pts) + max(p[1] for p in pts)) / 2, 6)
    half = C.BOX_M / 2
    bounds = {"width_px": C.GRID_PX, "height_px": C.GRID_PX, "pixel_m": C.PIXEL_M,
              "crs": C.local_crs(lon0, lat0), "center_lonlat": [lon0, lat0],
              "local_xmin_m": -half, "local_ymax_m": half,
              "origin": "top-left", "x": "east", "y": "south",
              "note": "pixel [x, y]; Leaflet CRS.Simple: latlng = [height_px - y, x]"}
    g = U.Grid(bounds)
    bounds["corners_lonlat"] = {k: [round(v, 6) for v in g.px_to_lonlat(c, r)]
                                for k, (c, r) in {"nw": (0, 0), "ne": (C.GRID_PX, 0), "se": (C.GRID_PX, C.GRID_PX), "sw": (0, C.GRID_PX)}.items()}
    # true-scale check (finding 1): 1 px east and 1 px south are both 2 m on the ground
    lo1, la1 = g.px_to_lonlat(1000, 1000); lo2, la2 = g.px_to_lonlat(1001, 1000); lo3, la3 = g.px_to_lonlat(1000, 1001)
    ew, ns = float(U.ground_dist_m(lo1, la1, lo2, la2)), float(U.ground_dist_m(lo1, la1, lo3, la3))
    assert abs(ew - 2) < 1e-3 and abs(ns - 2) < 1e-3, (ew, ns)
    print(f"local CRS center {lon0}E {lat0}N; 1 px = {ew:.4f} m E-W, {ns:.4f} m N-S")

    def px(lon, lat):
        c, r = g.lonlat_to_px(lon, lat); return [round(float(c), 1), round(float(r), 1)]
    for t in tb:
        t["px"] = px(t["lon"], t["lat"])
    for p in [H, A] + [{"px": t["px"]} for t in tb]:
        if "lon" in p: p["px"] = px(p["lon"], p["lat"])
        assert MARGIN_M / 2 <= min(p["px"]) and max(p["px"]) <= C.GRID_PX - MARGIN_M / 2, p
    for c in cands:
        c["px"] = px(c["lon"], c["lat"])

    # DTM coverage of the box (HiRISE header only; gap check is in D2)
    with rasterio.open("/vsicurl/" + C.HIRISE_DTM_URL) as d:
        b = d.bounds
    corners = [U.lonlat_to_src(*v) for v in bounds["corners_lonlat"].values()]
    assert all(b.left < x < b.right and b.bottom < y < b.top for x, y in corners), "box outside HiRISE DTM"
    print("box inside HiRISE DTM extent")

    (C.DATA / "bounds.json").write_text(json.dumps(bounds, indent=2))
    (C.DATA / "depot.json").write_text(json.dumps(tb, indent=2))
    (C.DATA / "site.json").write_text(json.dumps({
        "habitat": H, "depot_center": {"lon": dlon, "lat": dlat, "px": px(dlon, dlat), "tube_spread_m": round(float(spread))},
        "stop_a": A, "stop_a_shortlist": cands[:10], "depot_samples_cored": cored,
        "criteria": {"stop_a": f"Perseverance waypoint sols 400-640, {A_DIST[0]}-{A_DIST[1]} m from depot, Stack Delta bedrock, "
                     f"not on bedforms, ranked by CRISM clay fraction within {CLAY_RADIUS_M} m (+0.15 if a depot sample was cored there)",
                     "habitat": f"CTX mean slope within 100 m <= {H_MAX_SLOPE} deg, {H_DIST[0]}-{H_DIST[1]} m from depot, "
                     "not on bedforms/rocky/delta units, all stops fit the box with a 300 m margin"},
        "status": "D1 draft; stop A final pick in D3 after HiRISE slope"}, indent=2))
    print("wrote data/bounds.json, data/depot.json, data/site.json")
    overview(g, tb, H, A, cands)


def overview(g, tb, H, A, cands):
    """QA: CTX hillshade on the local grid + Stack sand + rover traverse + stops."""
    import matplotlib; matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from rasterio.warp import reproject, Resampling
    n = 400; T = from_origin(g.xmin, g.ymax, 10, 10)
    dem = np.full((n, n), np.nan, np.float32)
    with rasterio.open(next((C.RAW / "ctx").glob("*.tif"))) as d:
        reproject(rasterio.band(d, 1), dem, dst_transform=T, dst_crs=g.crs, dst_nodata=np.nan, resampling=Resampling.bilinear)
    ls = matplotlib.colors.LightSource(315, 35)
    fig, ax = plt.subplots(figsize=(9, 9))
    ax.imshow(ls.hillshade(np.nan_to_num(dem, nan=np.nanmean(dem)), dx=10, dy=10), cmap="gray", extent=(0, 2000, 2000, 0))
    polys, _ = U.load_stack()
    from pyproj import Transformer
    tf = Transformer.from_crs(C.SOURCE_EQC, g.crs, always_xy=True)
    for geom, l, _, _ in polys:
        if l not in U.SAND_UNITS: continue
        rings = geom["coordinates"] if geom["type"] == "Polygon" else [r for p in geom["coordinates"] for r in p]
        for ring in rings[:1] if geom["type"] == "Polygon" else rings:
            xs, ys = tf.transform(*zip(*ring))
            cx, cy = (np.array(xs) - g.xmin) / g.px, (g.ymax - np.array(ys)) / g.px
            if (cx.max() < 0) or (cx.min() > 2000) or (cy.max() < 0) or (cy.min() > 2000): continue
            ax.fill(cx, cy, color="orange", alpha=0.35, lw=0)
    tr = json.loads((C.RAW / "m20" / "M20_traverse.json").read_text())["features"]
    for f in tr:
        lon, lat = zip(*[p[:2] for p in f["geometry"]["coordinates"]])
        c, r = g.lonlat_to_px(np.array(lon), np.array(lat))
        ax.plot(c, r, color="cyan", lw=0.8)
    for c in cands[:8]:
        ax.plot(*c["px"], "o", mfc="none", mec="yellow", ms=7)
    ax.plot(*zip(*[t["px"] for t in tb]), "r.", ms=5, label="tubes")
    ax.plot(*A["px"], "y*", ms=16, label=f"stop A (sol {A['sol']})")
    ax.plot(*H["px"], "ws", ms=10, label="habitat")
    ax.set_xlim(0, 2000); ax.set_ylim(2000, 0); ax.legend(loc="lower right")
    ax.set_title("D1 site overview (CTX hillshade, Stack bedforms orange, rover path cyan)")
    fig.savefig(C.QA / "site_overview.png", dpi=110, bbox_inches="tight"); plt.close(fig)
    print("wrote pipeline/qa/site_overview.png")


if __name__ == "__main__":
    main()
