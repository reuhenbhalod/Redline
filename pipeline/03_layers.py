"""D3: science and hazard layers on the local 2 m grid.

- Stack et al. 2020 map -> sand (0 none / 1 small / 2 large bedforms), rocky (0/1), geo_unit (ID)
- CRISM -> mineral class ID (decoded at native 36 m, nearest-neighbor resampling only)
- THEMIS TI -> context layer (bilinear; 100 m data)
- Final stop A: best shortlist candidate whose HiRISE slope and roughness are walkable
Outputs: pipeline/work/layers.npz, pipeline/work/units.json, data/site.json (stop A final),
         pipeline/qa/layers_*.png
"""
import json, sys
from pathlib import Path
import numpy as np
import rasterio
from rasterio import features
from rasterio.warp import reproject, Resampling, transform_geom

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as C
import common as U
import safety_params as P

WORK = C.ROOT / "pipeline" / "work"


def stack_layers(g):
    polys, skipped = U.load_stack()
    units = sorted({l for _, l, _, _ in polys})
    uid = {u: i + 1 for i, u in enumerate(units)}
    shape = (g.n, g.n)
    local = [(transform_geom(C.SOURCE_EQC, g.crs, geom), l) for geom, l, _, _ in polys]
    geo = features.rasterize(((gm, uid[l]) for gm, l in local), out_shape=shape, transform=g.transform, fill=0, dtype="uint16")
    sand = features.rasterize(((gm, U.SAND_UNITS[l]) for gm, l in local if l in U.SAND_UNITS),
                              out_shape=shape, transform=g.transform, fill=0, dtype="uint8")
    rocky = features.rasterize(((gm, 1) for gm, l in local if l in U.ROCKY_UNITS),
                               out_shape=shape, transform=g.transform, fill=0, dtype="uint8")
    print(f"Stack map: {len(polys)} polygons ({skipped} empty skipped), {len(units)} unit labels; "
          f"unmapped {np.mean(geo==0):.1%}, sand {np.mean(sand>0):.1%} (large {np.mean(sand==2):.1%}), rocky {np.mean(rocky>0):.1%}")
    return geo, sand, rocky, {i: u for u, i in uid.items()}


def crism_layer(g):
    with rasterio.open(C.RAW / "crism" / "jezeroFinal.tif") as d:
        cid, conf, _ = U.crism_decode(d.read())
        out = np.full((g.n, g.n), U.CRISM_NO_COVERAGE, np.uint8)
        outc = np.zeros((g.n, g.n), np.uint8)
        for src, dst in ((cid, out), (conf, outc)):
            reproject(src, dst, src_transform=d.transform, src_crs=C.SOURCE_EQC, dst_transform=g.transform,
                      dst_crs=g.crs, resampling=Resampling.nearest)   # class IDs: nearest only (finding 3)
    vals, counts = np.unique(out, return_counts=True)
    names = {c[0]: c[1] for c in U.CRISM_CLASSES} | {0: "unidentified", 254: "uncertain", 255: "no coverage"}
    print("CRISM in box:", {names[v]: f"{c/out.size:.1%}" for v, c in zip(vals, counts)})
    return out, outc


def themis_layer(g):
    with rasterio.open(C.RAW / "themis" / "Jezero_Thermal_Inertia_v1.tiff") as d:
        out = np.full((g.n, g.n), np.nan, np.float32)
        reproject(rasterio.band(d, 1), out, dst_transform=g.transform, dst_crs=g.crs,
                  src_nodata=0, dst_nodata=np.nan, resampling=Resampling.bilinear)
    print(f"THEMIS TI in box: {np.nanmin(out):.0f}-{np.nanmax(out):.0f} (context only, 100 m data)")
    return out


def final_stop_a(g, terrain, sand):
    site = json.loads((C.DATA / "site.json").read_text())
    slope, rough, nogo = terrain["slope_deg"], terrain["rough_m"], terrain["nogo_terrain"]
    chosen = None
    for c in site["stop_a_shortlist"]:
        col, row = (int(round(v)) for v in c["px"])
        r = 5  # 10 m around the stop: a work area the crew can stand in
        win = np.s_[row - r:row + r + 1, col - r:col + r + 1]
        c["hirise_slope_p90_deg"] = round(float(np.percentile(slope[win], 90)), 1)
        c["hirise_rough_p90_m"] = round(float(np.percentile(rough[win], 90)), 2)
        c["nogo_frac"] = round(float(nogo[win].mean()), 3)
        c["sand_frac"] = round(float((sand[win] > 0).mean()), 3)
        ok = (c["hirise_slope_p90_deg"] <= P.v("slope_soft_deg") and c["nogo_frac"] == 0 and c["sand_frac"] < 0.5)
        c["walkable_work_area"] = ok
        if ok and chosen is None:
            chosen = c
    assert chosen, "no walkable stop A candidate"
    site["stop_a"] = chosen
    site["status"] = "D3: stop A final"
    (C.DATA / "site.json").write_text(json.dumps(site, indent=2))
    print(f"stop A final: sol {chosen['sol']} waypoint, {chosen['dist_to_depot_m']} m from depot, "
          f"{chosen['stack_bedrock']}, slope p90 {chosen['hirise_slope_p90_deg']} deg, cored here: {chosen['depot_samples_cored_here']}")
    return site


def qa(g, base, sand, rocky, mineral, site):
    import matplotlib; matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import ListedColormap
    fig, axs = plt.subplots(1, 3, figsize=(21, 7.4))
    axs[0].imshow(base, cmap="gray"); axs[0].imshow(np.ma.masked_equal(sand, 0), cmap=ListedColormap(["#ffb000", "#ff5000"]), alpha=0.45, vmin=1, vmax=2)
    axs[0].imshow(np.ma.masked_equal(rocky, 0), cmap=ListedColormap(["#00e0ff"]), alpha=0.35); axs[0].set_title("sand (orange) + rocky (cyan) from Stack map")
    lut = np.zeros((256, 4)); lut[255] = (1, 1, 1, 0); lut[254] = (.5, .5, .5, .5)
    for cid, _, hi, _, _ in U.CRISM_CLASSES: lut[cid] = (*np.array(hi) / 255, .6)
    axs[1].imshow(base, cmap="gray"); axs[1].imshow(lut[mineral]); axs[1].set_title("CRISM minerals (36 m), white areas = no coverage")
    # zoom: 300 m around stop A at full 2 m resolution to check bedform polygons against ripples
    col, row = (int(v) for v in site["stop_a"]["px"]); r = 150
    z = np.s_[max(row - r, 0):row + r, max(col - r, 0):col + r]
    axs[2].imshow(base[z], cmap="gray"); axs[2].contour(sand[z] > 0, levels=[0.5], colors="orange", linewidths=1)
    axs[2].set_title("zoom 600 m: bedform outlines vs ripples")
    for ax in axs[:2]:
        ax.plot(*site["habitat"]["px"], "ws", ms=8); ax.plot(*site["stop_a"]["px"], "y*", ms=12); ax.plot(*site["depot_center"]["px"], "r^", ms=8)
    fig.savefig(C.QA / "layers_overview.png", dpi=90, bbox_inches="tight"); plt.close(fig)
    print("wrote pipeline/qa/layers_overview.png")


def main():
    g = U.Grid(C.load_bounds())
    terrain = np.load(WORK / "terrain.npz")
    geo, sand, rocky, unit_names = stack_layers(g)
    mineral, mconf = crism_layer(g)
    ti = themis_layer(g)
    np.savez_compressed(WORK / "layers.npz", geo_unit=geo, sand=sand, rocky=rocky, mineral=mineral,
                        mineral_conf=mconf, thermal_inertia=ti)
    (WORK / "units.json").write_text(json.dumps(unit_names, indent=2))
    site = final_stop_a(g, terrain, sand)
    from PIL import Image
    qa(g, np.array(Image.open(C.DATA / "basemap.png")), sand, rocky, mineral, site)


if __name__ == "__main__":
    main()
