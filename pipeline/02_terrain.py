"""D2: terrain.

1. Read only our box (plus a pad) from the remote HiRISE DTM and orthomosaic, cache in raw/crops/.
2. Reproject to the local true-scale CRS: DTM at 1 m (work grid) and 2 m, ortho at 2 m (average).
3. Light smoothing (DTM effective resolution ~3 m), slope at 1 m, then 2x2 max -> 2 m (keeps steep spots).
4. Roughness: std of detrended height in an 8 m window (1 m grid), 2x2 mean -> 2 m.
5. No-go: slope over the hard limit, roughness over the hard limit, or no data.
Outputs: raw/crops/*.tif, pipeline/work/terrain.npz, data/basemap.png, pipeline/qa/terrain_*.png
"""
import json, sys, time
from pathlib import Path
import numpy as np
import rasterio
from rasterio.windows import from_bounds
from rasterio.warp import reproject, Resampling
from rasterio.transform import from_origin
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as C
import common as U
import safety_params as P

CROPS = C.RAW / "crops"; CROPS.mkdir(exist_ok=True)
WORK = C.ROOT / "pipeline" / "work"; WORK.mkdir(exist_ok=True)
PAD_M = 150
SMOOTH_SIGMA_M = 1.5
ROUGH_WIN_M = 8


def src_bbox(g):
    """Bounding box of the local grid in source eqc coordinates, padded."""
    c, r = np.meshgrid(np.linspace(0, g.n, 21), np.linspace(0, g.n, 21))
    lon, lat = g.px_to_lonlat(c.ravel(), r.ravel())
    x, y = U.lonlat_to_src(lon, lat)
    pad = PAD_M / np.cos(np.radians(g.b["center_lonlat"][1]))  # source x is stretched
    return min(x) - pad, min(y) - PAD_M, max(x) + pad, max(y) + PAD_M


def crop(url, name, bbox):
    out = CROPS / name
    if out.exists():
        print(f"  cached {out.relative_to(C.ROOT)}"); return out
    t = time.time()
    with rasterio.open("/vsicurl/" + url) as d:
        w = from_bounds(*bbox, d.transform).round_offsets().round_lengths()
        a = d.read(1, window=w)
        prof = d.profile | {"driver": "GTiff", "width": a.shape[1], "height": a.shape[0],
                            "transform": d.window_transform(w), "tiled": True, "compress": "deflate",
                            "blockxsize": 512, "blockysize": 512}
        prof.pop("blockysize_", None)
    with rasterio.open(out, "w", **prof) as o:
        o.write(a, 1)
    print(f"  cropped {out.relative_to(C.ROOT)} {a.shape} in {time.time()-t:.0f}s")
    return out


def to_local(src_path, g, res, resampling, dtype, nodata):
    n = int(round(g.n * g.px / res))
    dst = np.full((n, n), nodata, dtype)
    with rasterio.open(src_path) as s:
        reproject(rasterio.band(s, 1), dst, dst_transform=from_origin(g.xmin, g.ymax, res, res),
                  dst_crs=g.crs, src_nodata=s.nodata, dst_nodata=nodata, resampling=resampling)
    return dst


def block(a, f, k=2):
    h, w = a.shape
    return f(a.reshape(h // k, k, w // k, k), axis=(1, 3))


def main():
    g = U.Grid(C.load_bounds())
    bbox = src_bbox(g)
    print("cropping remote HiRISE (only our box is read)")
    dtm_p = crop(C.HIRISE_DTM_URL, "hirise_dtm_box.tif", bbox)
    ort_p = crop(C.HIRISE_ORTHO_URL, "hirise_ortho_box.tif", bbox)

    print("reprojecting to the local true-scale grid")
    z1 = to_local(dtm_p, g, 1.0, Resampling.bilinear, np.float32, np.nan)
    nodata1 = ~np.isfinite(z1)
    print(f"  DTM 1 m {z1.shape}, no-data {nodata1.mean():.4%}, elevation {np.nanmin(z1):.1f} to {np.nanmax(z1):.1f} m")
    assert nodata1.mean() < 0.001, "DTM gaps in the box"
    zf = np.where(nodata1, np.nanmean(z1), z1)

    zs = ndimage.gaussian_filter(zf, SMOOTH_SIGMA_M)
    gy, gx = np.gradient(zs, 1.0)                 # local grid: 1 px = 1 m both ways (finding 1)
    slope1 = np.degrees(np.arctan(np.hypot(gx, gy)))
    detr = zf - ndimage.gaussian_filter(zf, ROUGH_WIN_M / 2)
    m = ndimage.uniform_filter(detr, ROUGH_WIN_M); m2 = ndimage.uniform_filter(detr ** 2, ROUGH_WIN_M)
    rough1 = np.sqrt(np.maximum(m2 - m ** 2, 0))

    elev = block(zf, np.mean).astype(np.float32)
    slope = block(slope1, np.max).astype(np.float32)
    rough = block(rough1, np.mean).astype(np.float32)
    nodata = block(nodata1, np.any)
    nogo = (slope > P.v("slope_hard_deg")) | (rough > P.v("rough_hard_m")) | nodata
    print(f"  slope 2 m: median {np.median(slope):.1f}, p95 {np.percentile(slope,95):.1f}, >15 deg {np.mean(slope>15):.1%}, >25 deg {np.mean(slope>25):.1%}")
    print(f"  roughness: median {np.median(rough):.2f} m, p95 {np.percentile(rough,95):.2f} m")
    print(f"  no-go: {nogo.mean():.1%} of cells (PROVISIONAL limits until D6)")

    ortho = to_local(ort_p, g, 2.0, Resampling.average, np.float32, np.nan)
    print(f"  ortho 2 m no-data {np.isnan(ortho).mean():.4%}")
    lo, hi = np.nanpercentile(ortho, [0.5, 99.5])
    base = np.clip((np.nan_to_num(ortho, nan=lo) - lo) / (hi - lo) * 255, 0, 255).astype(np.uint8)
    from PIL import Image
    Image.fromarray(base).save(C.DATA / "basemap.png", optimize=True)

    np.savez_compressed(WORK / "terrain.npz", elevation_m=elev, slope_deg=slope, rough_m=rough,
                        nodata=nodata, nogo_terrain=nogo)
    meta = {"dtm": C.HIRISE_DTM_URL, "ortho": C.HIRISE_ORTHO_URL, "smooth_sigma_m": SMOOTH_SIGMA_M,
            "rough_window_m": ROUGH_WIN_M, "slope_aggregation": "1 m slope, 2x2 max",
            "limits_used": {k: P.PARAMS[k] for k in ("slope_hard_deg", "rough_hard_m")},
            "basemap_stretch": [float(lo), float(hi)]}
    (WORK / "terrain_meta.json").write_text(json.dumps(meta, indent=2))
    print("wrote data/basemap.png, pipeline/work/terrain.npz")
    qa(g, base, slope, rough, ort_p)


def elevation_check(g):
    """Alignment check that works with a pre-landing basemap: the rover's own logged elevation
    (elev_geoid) vs the HiRISE DTM at the same lon/lat. A horizontal shift would show up as
    scatter that grows with slope; a pure vertical datum offset shows up as a constant bias."""
    t = np.load(WORK / "terrain.npz"); elev, slope = t["elevation_m"], t["slope_deg"]
    rows = []
    for p in U.load_waypoints():
        c, r = g.lonlat_to_px(p["lon"], p["lat"])
        if 2 <= c < g.n - 2 and 2 <= r < g.n - 2 and p.get("elev_geoid") is not None:
            ci, ri = int(c), int(r)
            rows.append((float(p["elev_geoid"]), float(elev[ri, ci]), float(slope[ri, ci])))
    a = np.array(rows); d = a[:, 0] - a[:, 1]
    bias = np.median(d); res = d - bias
    flat, steep = np.abs(res[a[:, 2] < 5]), np.abs(res[a[:, 2] >= 5])
    out = {"waypoints_in_box": len(a), "median_offset_m": round(float(bias), 2),
           "abs_residual_p50_m": round(float(np.median(np.abs(res))), 2),
           "abs_residual_p90_m": round(float(np.percentile(np.abs(res), 90)), 2),
           "p50_flat_lt5deg_m": round(float(np.median(flat)), 2) if flat.size else None,
           "p50_steep_ge5deg_m": round(float(np.median(steep)), 2) if steep.size else None}
    (C.QA / "elevation_check.json").write_text(json.dumps(out, indent=2))
    print(f"  rover vs DTM elevation: {out}")


def qa(g, base, slope, rough, ort_p):
    import matplotlib; matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    site = json.loads((C.DATA / "site.json").read_text())
    tr = json.loads((C.RAW / "m20" / "M20_traverse.json").read_text())["features"]
    lines = []
    for f in tr:
        lon, lat = map(np.array, zip(*[p[:2] for p in f["geometry"]["coordinates"]]))
        lines.append(g.lonlat_to_px(lon, lat))
    # overview: basemap, slope, roughness
    fig, axs = plt.subplots(1, 3, figsize=(21, 7.4))
    for ax, img, title, kw in [(axs[0], base, "basemap + rover path", dict(cmap="gray")),
                               (axs[1], slope, "slope (deg)", dict(cmap="magma", vmin=0, vmax=30)),
                               (axs[2], rough, "roughness (m)", dict(cmap="viridis", vmin=0, vmax=0.6))]:
        im = ax.imshow(img, **kw)
        if ax is not axs[0]: fig.colorbar(im, ax=ax, fraction=0.046)
        for c, r in lines: ax.plot(c, r, color="cyan", lw=0.6)
        ax.plot(*site["habitat"]["px"], "ws", ms=8); ax.plot(*site["stop_a"]["px"], "y*", ms=12)
        ax.plot(*site["depot_center"]["px"], "r^", ms=8); ax.set_title(title)
        ax.set_xlim(0, g.n * g.px / 2); ax.set_ylim(g.n * g.px / 2, 0)
    fig.savefig(C.QA / "terrain_overview.png", dpi=90, bbox_inches="tight"); plt.close(fig)
    elevation_check(g)
    # alignment: native 25 cm ortho around tubes and stop A with the rover traverse on top
    pts = [("depot", site["depot_center"]), ("stop A", site["stop_a"])]
    fig, axs = plt.subplots(1, 2, figsize=(14, 7))
    with rasterio.open(ort_p) as d:
        for ax, (name, p) in zip(axs, pts):
            lon, lat = (p["lon"], p["lat"])
            x, y = U.lonlat_to_src(lon, lat); hx = 60 / np.cos(np.radians(lat))
            w = from_bounds(x - hx, y - 60, x + hx, y + 60, d.transform); a = d.read(1, window=w); T = d.window_transform(w)
            ax.imshow(a, cmap="gray", extent=(0, a.shape[1], a.shape[0], 0), aspect=a.shape[0] / a.shape[1] * (2 * hx) / 120 * (a.shape[1] / a.shape[0]))
            for f in tr:
                lo_, la_ = map(np.array, zip(*[q[:2] for q in f["geometry"]["coordinates"]]))
                xs, ys = U.lonlat_to_src(lo_, la_); cc, rr = ~T * (np.array(xs), np.array(ys))
                ax.plot(cc, rr, color="cyan", lw=1)
            if name == "depot":
                for t in json.loads((C.DATA / "depot.json").read_text()):
                    xs, ys = U.lonlat_to_src(t["lon"], t["lat"]); cc, rr = ~T * (xs, ys); ax.plot(cc, rr, "r+", ms=10)
            ax.set_xlim(0, a.shape[1]); ax.set_ylim(a.shape[0], 0); ax.set_title(f"{name}: 25 cm HiRISE, 120 m wide, rover path cyan")
    fig.savefig(C.QA / "terrain_alignment.png", dpi=90, bbox_inches="tight"); plt.close(fig)
    print("wrote pipeline/qa/terrain_overview.png, terrain_alignment.png")


if __name__ == "__main__":
    main()
