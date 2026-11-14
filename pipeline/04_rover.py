"""D4: rover path and imagery.

- rover_path.json: Perseverance traverse and waypoints inside the box, in pixels, with sols
- photos.json: per stop, featured images (official PDS Mastcam-Z mosaics) + filtered raw-image
  candidates from the sols the rover was parked within reach of the stop. Every URL is checked.
- depot.json: adds each tube's PDS close-up ortho mosaic browse image
Raw-image API responses are cached in raw/rawimages/ so re-runs and the demo never depend on the API.
"""
import json, re, sys, time
from pathlib import Path
import numpy as np
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as C
import common as U

S = requests.Session(); S.headers["User-Agent"] = "marswalk-data-pipeline/0.1 (NASA Space Apps 2026)"
CACHE = C.RAW / "rawimages"; CACHE.mkdir(exist_ok=True)
BROWSE = f"{C.DEPOT_BUNDLE}/browse"
KEEP_CAMS = {"MCZ_LEFT": 0, "NAVCAM_LEFT": 1, "FRONT_HAZCAM_LEFT_A": 2, "REAR_HAZCAM_LEFT": 3}  # rank: color mast first
STOP_RADIUS_M = {"H": 150, "A": 40, "B": 60}
PER_STOP = 24


def raw_sol(sol):
    p = CACHE / f"sol_{sol:04d}.json"
    if not p.exists():
        r = S.get(C.RAW_IMAGES_API.format(sol=sol), timeout=60); r.raise_for_status()
        p.write_text(r.text); time.sleep(0.3)
    return json.loads(p.read_text())["images"]


def url_ok(url):
    try:
        r = S.head(url, timeout=30, allow_redirects=True)
        return r.status_code == 200 and r.headers.get("Content-Type", "").startswith("image")
    except requests.RequestException:
        return False


def parked_sols(wps, lon, lat, radius):
    """Sols on which the rover's most recent waypoint was within `radius` m of the point."""
    sols, cur = [], None
    by_sol = {}
    for p in wps:
        by_sol.setdefault(int(p["sol"]), []).append(p)
    last = None
    for s in range(min(by_sol), max(by_sol) + 1):
        if s in by_sol: last = by_sol[s][-1]
        if last and U.ground_dist_m(lon, lat, last["lon"], last["lat"]) <= radius:
            sols.append(s)
    return sols


def usable(im):
    """Metadata filter: full-size processed color/stereo frames looking at the terrain."""
    cam, e = im["camera"]["instrument"], im["extended"]
    if cam not in KEEP_CAMS or im.get("sample_type") != "Full":
        return False
    if cam == "MCZ_LEFT" and "EBY" not in im["imageid"]:
        return False   # Mastcam-Z: EBY = color product, ECM = grayscale of the same frame
    if cam == "MCZ_LEFT" and im["camera"]["filter_name"] != "ZCAM_L0_RGB":
        return False   # narrow-band science filters
    try:
        w, h = (int(v) for v in e["dimension"].strip("()").split(","))
        el, az = float(e["mastEl"]), float(e["mastAz"]) % 360
    except (ValueError, KeyError):
        return cam.endswith("HAZCAM_LEFT_A") or cam == "REAR_HAZCAM_LEFT"
    if w < 1000:
        return False   # subframes, thumbnails, calibration crops
    if el > 5 or el < -70:
        return False   # sky / sun / straight down at the deck
    if 150 <= az <= 210 and el < -20:
        return False   # looking back at the rover deck (calibration target)
    return True


def looks_good(thumb_url):
    """Content check on the 320 px thumbnail: reject flat frames and noise-like frames."""
    from PIL import Image
    import io
    from scipy import ndimage
    try:
        im = np.asarray(Image.open(io.BytesIO(S.get(thumb_url, timeout=60).content)).convert("L"), float)
    except Exception:
        return False
    if im.std() < 12:
        return False
    hf = ndimage.laplace(im).var() / max(im.var(), 1e-6)
    return hf < 4.0


def candidates(sols):
    out, seen_ids = [], set()
    for s in sols:
        for im in raw_sol(s):
            cam = im["camera"]["instrument"]
            scene = re.sub(r"_(\d{3})E[A-Z]{2}_", r"_\1___", im["imageid"])  # same frame, different product
            if scene in seen_ids or not usable(im):
                continue
            seen_ids.add(scene)
            out.append({"sol": s, "camera": cam, "imageid": im["imageid"],
                        "url": im["image_files"].get("large") or im["image_files"]["full_res"],
                        "thumb": im["image_files"]["small"], "full_res": im["image_files"]["full_res"],
                        "date_utc": im.get("date_taken_utc"), "credit": im.get("credit") or "NASA/JPL-Caltech",
                        "mast_el_deg": im["extended"].get("mastEl")})
    # spread across sols and cameras: rank by camera, then round-robin over sols
    out.sort(key=lambda c: (KEEP_CAMS[c["camera"]], c["sol"]))
    picked, seen = [], {}
    for c in out:
        k = (c["camera"], c["sol"])
        if seen.get(k, 0) < 2:
            picked.append(c); seen[k] = seen.get(k, 0) + 1
    return picked


def main():
    g = U.Grid(C.load_bounds())
    site = json.loads((C.DATA / "site.json").read_text())
    wps = sorted(U.load_waypoints(), key=lambda p: (int(p["sol"]), int(p["site"]), int(p["drive"])))

    # ---- rover path ----
    tr = json.loads((C.RAW / "m20" / "M20_traverse.json").read_text())["features"]
    segs = []
    for f in tr:
        lon, lat = map(np.array, zip(*[q[:2] for q in f["geometry"]["coordinates"]]))
        c, r = g.lonlat_to_px(lon, lat)
        if ((c >= 0) & (c < g.n) & (r >= 0) & (r < g.n)).any():
            segs.append({"sol": f["properties"]["sol"], "px": [[round(float(a), 1), round(float(b), 1)] for a, b in zip(c, r)]})
    wpx = []
    for p in wps:
        c, r = g.lonlat_to_px(p["lon"], p["lat"])
        if 0 <= c < g.n and 0 <= r < g.n:
            wpx.append({"sol": int(p["sol"]), "site": p["site"], "drive": p["drive"], "px": [round(float(c), 1), round(float(r), 1)],
                        "elev_m": p.get("elev_geoid")})
    (C.DATA / "rover_path.json").write_text(json.dumps({
        "source": "NASA/JPL-Caltech Mars 2020 MMGIS traverse and waypoints", "segments": segs, "waypoints": wpx}))
    print(f"rover_path.json: {len(segs)} drive segments, {len(wpx)} waypoints in box (sols {wpx[0]['sol']}-{wpx[-1]['sol']})")

    # ---- photos per stop ----
    stops = {"H": site["habitat"], "A": site["stop_a"], "B": site["depot_center"]}
    featured = {
        "A": [("mosaics/mastcam_z_mosaic_sols_466_474_left_browse.png", "Mastcam-Z mosaic, sols 466-474 (delta front)")],
        "B": [(f"mosaics/mastcam_z_mosaic_sol_{s}_left_browse.png", f"Mastcam-Z mosaic of the depot, sol {s}") for s in (650, 670, 693)]
             + [("depot/m20_orbital_map_three_forks.png", "Orbital map of the Three Forks depot")],
    }
    photos = {}
    for sid, p in stops.items():
        sols = parked_sols(wps, p["lon"], p["lat"], STOP_RADIUS_M[sid])
        note = None
        if not sols:   # rover never parked here: use the nearest rover position, and say so
            near = min(wps, key=lambda q: float(U.ground_dist_m(p["lon"], p["lat"], q["lon"], q["lat"])))
            dist = float(U.ground_dist_m(p["lon"], p["lat"], near["lon"], near["lat"]))
            sols = parked_sols(wps, p["lon"], p["lat"], 400)
            note = (f"no rover images at this spot; images from rover positions within 400 m "
                    f"(nearest {dist:.0f} m away, sol {near['sol']}), similar smooth crater-floor terrain")
        if sid == "B":
            sols = [s for s in sols if 650 <= s <= 700]  # depot construction campaign
        cands = candidates(sols)
        ok = []
        for c in cands:
            if len(ok) >= PER_STOP: break
            if url_ok(c["url"]) and looks_good(c["thumb"]): ok.append(c)
        feat = []
        for path, caption in featured.get(sid, []):
            u = f"{BROWSE}/{path}"
            if url_ok(u):
                feat.append({"url": u, "caption": caption, "credit": "NASA/JPL-Caltech/ASU/MSSS (PDS Geosciences Three Forks Depot Bundle)"})
        photos[sid] = {"parked_sols": sols, "radius_m": STOP_RADIUS_M[sid], "note": note, "featured": feat, "candidates": ok}
        print(f"stop {sid}: parked on {len(sols)} sols, {len(feat)} featured, {len(ok)} raw candidates (URLs + content checked)" + (f"  [{note}]" if note else ""))
    (C.DATA / "photos.json").write_text(json.dumps(photos, indent=1))

    # ---- depot close-ups ----
    tubes = json.loads((C.DATA / "depot.json").read_text())
    idx = S.get(f"{BROWSE}/collection_browse_inventory.csv", timeout=60).text
    for t in tubes:
        folder = f"{t['sample_id'].lower()}_{t['name'].lower().replace(' ', '_')}"
        listing = S.get(f"{BROWSE}/ortho_mosaics/{folder}/", timeout=60).text
        import re
        pngs = sorted(set(re.findall(r'([A-Z0-9_]+_RZS_[A-Z0-9_]+\.png)"', listing)))
        dems = sorted(set(re.findall(r'([A-Z0-9_]+_DEM_[A-Z0-9_]+\.png)"', listing)))
        t["closeup"] = f"{BROWSE}/ortho_mosaics/{folder}/{pngs[0]}" if pngs else None
        t["closeup_dem"] = f"{BROWSE}/ortho_mosaics/{folder}/{dems[0]}" if dems else None
        if t["closeup"]:
            assert url_ok(t["closeup"]), t["closeup"]
        t["closeup_credit"] = "NASA/JPL-Caltech (PDS Geosciences Three Forks Depot Bundle)"
    (C.DATA / "depot.json").write_text(json.dumps(tubes, indent=2))
    print(f"depot.json: close-ups for {sum(1 for t in tubes if t['closeup'])}/{len(tubes)} tubes")
    contact_sheet(photos)


def contact_sheet(photos):
    """QA: thumbnails of every candidate so a human can pick the best 3+ per stop."""
    from PIL import Image, ImageDraw
    import io
    tiles = []
    for sid, p in photos.items():
        for i, c in enumerate([{"thumb": f["url"], "camera": "FEATURED", "sol": ""} for f in p["featured"]] + p["candidates"]):
            try:
                im = Image.open(io.BytesIO(S.get(c["thumb"], timeout=60).content)).convert("RGB")
            except Exception:
                continue
            im.thumbnail((240, 180)); t = Image.new("RGB", (240, 200), "black"); t.paste(im, (0, 0))
            ImageDraw.Draw(t).text((4, 184), f"{sid}{i} {c['camera'][:10]} {c['sol']}", fill="white")
            tiles.append(t)
    cols = 8; rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * 240, rows * 200), "gray")
    for i, t in enumerate(tiles):
        sheet.paste(t, ((i % cols) * 240, (i // cols) * 200))
    sheet.save(C.QA / "photos_contact_sheet.jpg", quality=80)
    print("wrote pipeline/qa/photos_contact_sheet.jpg")


if __name__ == "__main__":
    main()
