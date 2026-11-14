"""Shared helpers: coordinate transforms, CRISM decoding, Stack map loading."""
import json, csv
import numpy as np
from pyproj import Transformer
import config as C

# ---- coordinates ------------------------------------------------------------
_geog_to_src = Transformer.from_crs(C.MARS_GEOG, C.SOURCE_EQC, always_xy=True)
_src_to_geog = Transformer.from_crs(C.SOURCE_EQC, C.MARS_GEOG, always_xy=True)

def lonlat_to_src(lon, lat):
    """lon/lat -> source raster coordinates (eqc, lat_ts=0). Never use waypoint easting/northing (finding 2)."""
    return _geog_to_src.transform(lon, lat)

def src_to_lonlat(x, y):
    return _src_to_geog.transform(x, y)

def ground_dist_m(lon1, lat1, lon2, lat2):
    """Great-circle distance on the Mars sphere (m)."""
    p1, p2, dl = np.radians(lat1), np.radians(lat2), np.radians(np.asarray(lon2) - lon1)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * C.MARS_R * np.arcsin(np.sqrt(a))

class Grid:
    """The 2000x2000 local true-scale grid. Pixel [x, y]: origin top-left, x east, y south."""
    def __init__(self, bounds: dict):
        self.b = bounds
        self.crs = bounds["crs"]
        self.n = bounds["width_px"]; self.px = bounds["pixel_m"]
        self.xmin, self.ymax = bounds["local_xmin_m"], bounds["local_ymax_m"]
        self._g2l = Transformer.from_crs(C.MARS_GEOG, self.crs, always_xy=True)
        self._l2g = Transformer.from_crs(self.crs, C.MARS_GEOG, always_xy=True)

    def lonlat_to_px(self, lon, lat):
        x, y = self._g2l.transform(lon, lat)
        return (np.asarray(x) - self.xmin) / self.px, (self.ymax - np.asarray(y)) / self.px

    def px_to_lonlat(self, col, row):
        return self._l2g.transform(self.xmin + np.asarray(col) * self.px, self.ymax - np.asarray(row) * self.px)

    @property
    def transform(self):
        from rasterio.transform import from_origin
        return from_origin(self.xmin, self.ymax, self.px, self.px)

# ---- CRISM (finding 3) ------------------------------------------------------
# From the Parente et al. readme, slide 5. id 0 = not identified.
CRISM_CLASSES = [
    # id, name, high-confidence RGB, medium-confidence RGB, group
    (1, "Olivine", (255, 0, 0), (153, 0, 0), "olivine"),
    (2, "Mg-carbonate", (0, 255, 0), (0, 153, 0), "carbonate"),
    (3, "Fe/Mg-smectite", (0, 255, 255), (0, 153, 153), "clay"),
    (4, "Olivine + smectite", (255, 128, 114), (153, 77, 68), "clay"),
    (5, "Olivine/smectite + 2.2 µm", (128, 128, 0), (77, 77, 0), "clay"),
    (6, "Carbonate + 2.2 µm", (255, 215, 0), (153, 129, 0), "carbonate"),
    (7, "High-Ca pyroxene", (255, 128, 0), (153, 77, 0), "pyroxene"),
    (8, "Low-Ca pyroxene", (218, 165, 32), (130, 99, 19), "pyroxene"),
    (9, "Kaolinite", (139, 69, 19), (83, 41, 11), "clay"),
    (10, "Mg-smectite 2", (0, 0, 255), (0, 0, 153), "clay"),
]
CLAY_IDS = {c[0] for c in CRISM_CLASSES if c[4] == "clay"}
CARB_IDS = {c[0] for c in CRISM_CLASSES if c[4] == "carbonate"}
CRISM_UNCERTAIN = 254   # color between key colors (resampling blend at class edges)
CRISM_NO_COVERAGE = 255  # white: outside the 4 CRISM scenes
CRISM_TOL = 40           # max RGB distance to accept a key color (on-key pixels drift <= ~10)

def crism_decode(rgb: np.ndarray):
    """rgb (3, H, W) uint8 -> (class_id, confidence, color_dist), each (H, W).
    class_id: 0 = covered but not identified (black), 1-10 mineral, 254 uncertain blend, 255 no coverage (white).
    confidence: 2 = high, 1 = medium, 0 = n/a."""
    keys, ids, conf = [(0, 0, 0)], [0], [0]
    for cid, _, hi, med, _ in CRISM_CLASSES:
        keys += [hi, med]; ids += [cid, cid]; conf += [2, 1]
    K = np.array(keys, float)
    px = rgb.reshape(3, -1).T.astype(float)
    d2 = ((px[:, None, :] - K[None]) ** 2).sum(-1)
    k = d2.argmin(1); dist = np.sqrt(d2.min(1))
    cls = np.array(ids, np.uint8)[k]; cf = np.array(conf, np.uint8)[k]
    blend = dist > CRISM_TOL
    cls[blend] = CRISM_UNCERTAIN; cf[blend] = 0
    white = (px == 255).all(1)
    cls[white] = CRISM_NO_COVERAGE; cf[white] = 0
    shape = rgb.shape[1:]
    return cls.reshape(shape), cf.reshape(shape), dist.reshape(shape)

def crism_fractions(win: np.ndarray) -> dict:
    """Fractions over covered, decodable pixels only (excludes no-coverage and uncertain)."""
    valid = win[(win != CRISM_NO_COVERAGE) & (win != CRISM_UNCERTAIN)]
    n = max(valid.size, 1)
    return {"clay": float(np.isin(valid, list(CLAY_IDS)).sum() / n),
            "carbonate": float(np.isin(valid, list(CARB_IDS)).sum() / n),
            "unidentified": float((valid == 0).sum() / n),
            "coverage": float((win != CRISM_NO_COVERAGE).sum() / max(win.size, 1)),
            "uncertain": float((win == CRISM_UNCERTAIN).sum() / max(win.size, 1))}

# ---- Stack et al. 2020 map (finding 11) -------------------------------------
def load_stack():
    """Returns list of (geojson geometry, label, surface, bedrock); skips empty geometries.
    Label = surface unit if present, else bedrock unit."""
    import shapefile
    sf = shapefile.Reader(str(C.RAW / "stack" / C.STACK_SHP))
    out, skipped = [], 0
    for i, rec in enumerate(sf.records()):
        try:
            shp = sf.shape(i)
        except Exception:
            skipped += 1; continue
        if not shp.points:
            skipped += 1; continue
        surf, bed = (rec["SurfUName"] or "").strip(), (rec["BedrkUName"] or "").strip()
        out.append((shp.__geo_interface__, surf or bed, surf, bed))
    return out, skipped

SAND_UNITS = {"Aeolian bedforms, small": 1, "Aeolian bedforms, large": 2}
ROCKY_UNITS = {"Delta blocky", "Talus", "Crater rim blocky", "Crater floor fractured rough"}

# ---- Rover data --------------------------------------------------------------
def load_waypoints():
    return [f["properties"] for f in json.loads((C.RAW / "m20" / "M20_waypoints.json").read_text())["features"]]

def load_drops():
    rows = list(csv.DictReader(open(C.RAW / "depot" / "sample_drop_timestamps.csv")))
    for r in rows:
        r["drop_sol"] = int(r["MARS_SURFACE Timestamp (LMST)"].split("SOL-")[1][:4])
    return rows
