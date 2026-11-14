"""Export: colored transparent overlay PNGs, layers.json, grids.npz.

Reads pipeline/work/{terrain,layers}.npz and writes the contract files in data/.
Re-run after any earlier stage (or after safety_params changes: no-go is rebuilt here).
"""
import json, sys
from pathlib import Path
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as C
import common as U
import safety_params as P

WORK = C.ROOT / "pipeline" / "work"


def hexrgb(h):
    h = h.lstrip("#"); return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def classes_png(arr, classes, path):
    """classes: list of (value_or_mask_fn, hex, alpha, label). Returns legend."""
    rgba = np.zeros(arr.shape + (4,), np.uint8)
    for sel, color, alpha, _ in classes:
        m = sel(arr) if callable(sel) else (arr == sel)
        rgba[m] = (*hexrgb(color), int(alpha * 255))
    Image.fromarray(rgba, "RGBA").save(path, optimize=True)
    return [{"color": c, "label": l} for _, c, _, l in classes]


def main():
    g = U.Grid(C.load_bounds())
    t, L = np.load(WORK / "terrain.npz"), np.load(WORK / "layers.npz")
    units = {int(k): v for k, v in json.loads((WORK / "units.json").read_text()).items()}
    soft, hard, rh = P.v("slope_soft_deg"), P.v("slope_hard_deg"), P.v("rough_hard_m")
    nogo = (t["slope_deg"] > hard) | (t["rough_m"] > rh) | t["nodata"]   # sand is a cost, never no-go
    def basis_note(*keys):
        return "; ".join(f"{k} = {P.v(k)} ({P.PARAMS[k]['basis']})" for k in keys)
    layers = []

    def add(id_, label, source, native, time_frame, legend, note=""):
        layers.append({"id": id_, "file": f"layers/{id_}.png", "label": label, "source": source,
                       "native_res": native, "time_frame": time_frame, "legend": legend, "note": note})

    import matplotlib
    s = t["slope_deg"]
    add("slope", "Slope", "HiRISE DTM (USGS Mars 2020 TRN), slope computed on the local 1 m grid, 2x2 max",
        "1 m posting (~3 m effective)", "timeless",
        classes_png(s, [(lambda a: (a >= 10) & (a < soft), "#ffe066", .35, f"10-{soft:g}°"),
                        (lambda a: (a >= soft) & (a < hard), "#ff9a3c", .5, f"{soft:g}-{hard:g}° (slow)"),
                        (lambda a: a >= hard, "#e8202a", .65, f"> {hard:g}° (no-go)")], C.LAYERS / "slope.png"),
        basis_note("slope_soft_deg", "slope_hard_deg"))
    r = t["rough_m"]
    add("rough", "Rough ground", "HiRISE DTM, std of detrended height in an 8 m window", "~3 m effective", "timeless",
        classes_png(r, [(lambda a: (a >= .12) & (a < .2), "#7fd34e", .35, "0.12-0.2 m"),
                        (lambda a: (a >= .2) & (a < rh), "#22a884", .5, f"0.2-{rh:g} m"),
                        (lambda a: a >= rh, "#2a0f5c", .65, f"> {rh:g} m (no-go)")], C.LAYERS / "rough.png"),
        "does not resolve single rocks under ~1-2 m; see rocky units")
    add("sand", "Sand ripples and dunes", "Stack et al. 2020, Photogeologic map of the Perseverance field site (CC-BY-4.0)",
        "1:5000 map on 25 cm HiRISE", "timeless",
        classes_png(L["sand"], [(1, "#ffb000", .45, "Small bedforms"), (2, "#ff5000", .45, "Large bedforms (ridges)")], C.LAYERS / "sand.png"),
        "slow, soft ground: a walking cost, not a no-go (the depot itself is on bedforms)")
    add("rocky", "Rocky and blocky ground", "Stack et al. 2020 units: " + ", ".join(sorted(U.ROCKY_UNITS)),
        "1:5000 map", "timeless", classes_png(L["rocky"], [(1, "#00c8ff", .4, "Blocky / talus / rough fractured")], C.LAYERS / "rocky.png"))
    cm = matplotlib.colormaps["tab20"]
    uclasses = [(i, matplotlib.colors.to_hex(cm((i - 1) % 20)), .45, name) for i, name in sorted(units.items())]
    add("geology", "Rock and surface units", "Stack et al. 2020 (surface unit where mapped, else bedrock unit)",
        "1:5000 map", "timeless", classes_png(L["geo_unit"], uclasses, C.LAYERS / "geology.png"))
    mclasses = []
    for cid, name, hi, med, _ in U.CRISM_CLASSES:
        if (L["mineral"] == cid).any():
            mclasses.append((lambda a, c=cid: (a == c) & (L["mineral_conf"] == 2), matplotlib.colors.to_hex(np.array(hi) / 255), .65, f"{name} (high confidence)"))
            mclasses.append((lambda a, c=cid: (a == c) & (L["mineral_conf"] == 1), matplotlib.colors.to_hex(np.array(hi) / 255), .35, f"{name} (medium confidence)"))
    add("minerals", "Minerals (CRISM)", "Parente et al., CRISM dominant mineralogy of Jezero (Zenodo 5575824, CC-BY-4.0)",
        "36 m (4 CRISM scenes)", "orbital, 2007-2016 observations",
        classes_png(L["mineral"], mclasses, C.LAYERS / "minerals.png"),
        "transparent = not identified, no coverage, or edge blend; names are closest spectral matches (see readme)")
    ti = L["thermal_inertia"]; edges = [150, 175, 200, 225, 250, 275, 300]
    tcls = [(lambda a, lo=lo, hi=hi: (a >= lo) & (a < hi), matplotlib.colors.to_hex(matplotlib.colormaps["inferno"](i / 5)), .5, f"{lo}-{hi} TIU")
            for i, (lo, hi) in enumerate(zip(edges[:-1], edges[1:]))]
    add("ti", "Thermal inertia (context)", "Edwards & Buz, THEMIS TI of Jezero (Zenodo 4931348, CC-BY-4.0)", "100 m",
        "orbital", classes_png(ti, tcls, C.LAYERS / "ti.png"),
        "too coarse to find sand at walk scale (no low-inertia patches in the box); context only")
    add("nogo", "No-go", "slope > hard limit, roughness > hard limit, or no data", "2 m", "timeless",
        classes_png(nogo.astype(np.uint8), [(1, "#b00020", .55, "No-go")], C.LAYERS / "nogo.png"),
        basis_note("slope_hard_deg", "rough_hard_m"))

    for l in layers:
        l["trek_context"] = None
    (C.DATA / "layers.json").write_text(json.dumps({
        "grid": {"width_px": g.n, "height_px": g.n, "pixel_m": g.px},
        "context_map": {"source": "JPL Mars Trek", "layers": ["MRO HiRISE, Jezero Mosaic, Controlled", "MRO CTX, Jezero Mosaic, Controlled"]},
        "layers": layers}, indent=2, ensure_ascii=False))

    np.savez_compressed(C.DATA / "grids.npz",
                        elevation_m=np.round(t["elevation_m"], 2).astype(np.float32),   # DTM vertical precision is ~0.2-0.5 m
                        slope_deg=t["slope_deg"].astype(np.float16), rough_m=t["rough_m"].astype(np.float16),
                        sand=L["sand"], rocky=L["rocky"], geo_unit=L["geo_unit"], mineral=L["mineral"],
                        mineral_conf=L["mineral_conf"], thermal_inertia=L["thermal_inertia"].astype(np.float16), nogo=nogo.astype(np.uint8))
    (C.DATA / "grids_readme.json").write_text(json.dumps({
        "shape": [g.n, g.n], "index": "grid[row=y, col=x]; pixel [x, y] origin top-left, x east, y south, 2 m",
        "arrays": {"elevation_m": "float32, m (geoid), rounded to 1 cm", "slope_deg": "float16, deg", "rough_m": "float16, m",
                   "sand": "0 none, 1 small bedforms, 2 large bedforms", "rocky": "0/1",
                   "geo_unit": "ID -> unit name in 'units'", "mineral": "CRISM class ID -> 'minerals'; 0 unidentified, 254 uncertain, 255 no coverage",
                   "mineral_conf": "2 high, 1 medium, 0 n/a", "thermal_inertia": "float16 TIU, context only",
                   "nogo": "0/1 (slope/roughness/no data; sand is never no-go)"},
        "units": units, "minerals": {c[0]: c[1] for c in U.CRISM_CLASSES},
        "limits": {k: P.PARAMS[k] for k in ("slope_soft_deg", "slope_hard_deg", "rough_hard_m")}}, indent=2, ensure_ascii=False))
    (C.DATA / "safety_params.json").write_text(json.dumps({"params": P.PARAMS, "mars_g": P.MARS_G,
                                                           "assumptions": P.assumptions()}, indent=2, ensure_ascii=False))
    connectivity(nogo)
    traverse_check(g, nogo)
    provenance()
    sz = (C.DATA / "grids.npz").stat().st_size
    print(f"wrote {len(layers)} overlays, layers.json, grids.npz ({sz/1e6:.1f} MB), no-go {nogo.mean():.1%}")


def connectivity(nogo):
    """QA: habitat, stop A and every tube must sit in one connected walkable region (8-connected)."""
    from scipy import ndimage
    lab, n = ndimage.label(~nogo, structure=np.ones((3, 3)))
    site = json.loads((C.DATA / "site.json").read_text())
    pts = {"H": site["habitat"]["px"], "A": site["stop_a"]["px"]}
    pts |= {t["name"]: t["px"] for t in json.loads((C.DATA / "depot.json").read_text())}
    ids = {k: int(lab[int(round(p[1])), int(round(p[0]))]) for k, p in pts.items()}
    assert 0 not in ids.values(), f"a stop is on a no-go cell: {ids}"
    assert len(set(ids.values())) == 1, f"stops are not connected: {ids}"
    print(f"connectivity: habitat, stop A and all {len(pts) - 2} tubes are in one walkable region")


def traverse_check(g, nogo):
    """QA: Perseverance drove these paths, so very few of its path cells should be no-go."""
    tr = json.loads((C.RAW / "m20" / "M20_traverse.json").read_text())["features"]
    hits = tot = 0
    for f in tr:
        lon, lat = map(np.array, zip(*[q[:2] for q in f["geometry"]["coordinates"]]))
        # densify to ~1 m so we test the cells the rover actually crossed
        c, r = g.lonlat_to_px(lon, lat)
        for i in range(len(c) - 1):
            n = max(int(np.hypot(c[i + 1] - c[i], r[i + 1] - r[i]) * 2), 1)
            cc, rr = np.linspace(c[i], c[i + 1], n), np.linspace(r[i], r[i + 1], n)
            m = (cc >= 0) & (cc < g.n) & (rr >= 0) & (rr < g.n)
            tot += m.sum(); hits += nogo[rr[m].astype(int), cc[m].astype(int)].sum()
    frac = hits / max(tot, 1)
    out = {"rover_path_samples_in_box": int(tot), "on_nogo_frac": round(float(frac), 4)}
    (C.QA / "traverse_check.json").write_text(json.dumps(out, indent=2))
    print(f"traverse check: {frac:.2%} of Perseverance's path cells in the box are no-go")
    assert frac < 0.05, "no-go mask disagrees with where the rover actually drove"


SOURCES = [
    ("HiRISE DTM mosaic (Mars 2020 TRN)", C.HIRISE_DTM_URL, "Public domain (USGS/NASA)",
     "NASA/JPL/University of Arizona; USGS Astrogeology (Mars 2020 TRN products)",
     "window read for the box, reprojected to local true-scale grid, smoothed, slope/roughness/no-go"),
    ("HiRISE orthomosaic 25 cm (Mars 2020 TRN)", C.HIRISE_ORTHO_URL, "Public domain (USGS/NASA)",
     "NASA/JPL/University of Arizona; USGS Astrogeology", "window read, reprojected (average) to 2 m, contrast stretch -> basemap.png"),
    ("CTX DTM (Mars 2020 TRN), backup", C.CTX_DTM_URL, "Public domain (USGS/NASA)", "NASA/JPL/MSSS; USGS Astrogeology",
     "habitat flatness pre-screen and QA hillshade"),
    ("Stack et al. 2020, Photogeologic Map of the Perseverance Rover Field Site", "https://doi.org/10.1007/s11214-020-00739-x",
     "CC-BY-4.0", "Stack, K. M., et al. (2020), Space Science Reviews 216:127",
     "rasterized to 2 m: sand (bedforms), rocky units, geologic units"),
    ("CRISM dominant mineralogy of Jezero", "https://zenodo.org/records/5575824", "CC-BY-4.0",
     "Parente, M., Saranathan, A. M., Itoh, Y., Tarnas, J. D. (Zenodo 2021)",
     "RGB key decoded (white = no coverage, blends = uncertain), nearest-neighbor resampled class IDs"),
    ("THEMIS thermal inertia of Jezero", "https://zenodo.org/records/4931348", "CC-BY-4.0", "Edwards, C. S., Buz, J. (Zenodo 2021)",
     "bilinear resample to 2 m, context layer only"),
    ("Mars 2020 waypoints and traverse (MMGIS)", C.M20_WAYPOINTS_URL, "NASA (public)", "NASA/JPL-Caltech",
     "lon/lat converted to grid pixels (easting/northing fields ignored)"),
    ("Mars 2020 Three Forks Depot Bundle", C.DEPOT_BUNDLE, "Public domain (PDS)", "NASA/JPL-Caltech; PDS Geosciences Node",
     "tube drop sols joined to waypoints; close-up and Mastcam-Z mosaic browse images"),
    ("Perseverance raw images", "https://mars.nasa.gov/mars2020/multimedia/raw-images/", "NASA (public, credit required)",
     "NASA/JPL-Caltech (Mastcam-Z: NASA/JPL-Caltech/ASU)", "filtered (color full frames, no sky/deck), URL and content checked"),
    ("MEDA (Mars 2020)", C.MEDA_ROOT, "Public domain (PDS)", "NASA/JPL-Caltech/CAB; PDS Atmospheres Node",
     "depot-season sols: ATS air temp, TIRS ground temp, pressure, humidity, tide-based dust estimate"),
    ("MSL RAD RDR", C.RAD_ROOT, "Public domain (PDS)", "NASA/JPL-Caltech/SwRI; PDS PPI Node",
     "total dose E and B on depot-campaign Earth dates (stand-in for Jezero)"),
    ("DONKI WSA-ENLIL simulations", C.DONKI_ROOT, "NASA (public)", "NASA CCMC / M2M Space Weather Analysis Office",
     "CME arrivals predicted at Mars, last 30 days and upcoming"),
    ("JPL Mars Trek", "https://trek.nasa.gov/mars/", "NASA (public)", "NASA/JPL-Caltech", "zoomed-out context layers in the app"),
]


def provenance():
    manifest = json.loads((C.RAW / "manifest.json").read_text())
    (C.DATA / "provenance.json").write_text(json.dumps({
        "sources": [{"name": n, "url": u, "license": l, "credit": c, "processing": p} for n, u, l, c, p in SOURCES],
        "downloaded_files": manifest,
        "literature": [P.PARAMS[k]["source"] for k in P.PARAMS] + [
            "Wilson et al. 2008 / Sanchez-Lavega et al. 2023, JGR Planets, doi:10.1029/2022JE007480 (dust from pressure tide)",
            "Hassler et al. 2014, Science 343, doi:10.1126/science.1244797 (RAD surface dose reference)"],
        "ai_use": "Pipeline code written with AI assistance (Claude); all data values come from the listed NASA and USGS "
                  "sources, and every processing step is in pipeline/."}, indent=2, ensure_ascii=False))
    print("wrote data/provenance.json")


if __name__ == "__main__":
    main()
