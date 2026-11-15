"""09_route_science: "science along the way" prompts for every route variant.

Walks each variant's path in data/routes.json over data/grids.npz and finds the places where the rock/surface
unit (Stack et al. 2020 map) or the orbital mineral class (CRISM, Parente et al.) changes in a meaningful way.
Each becomes a short field-geology observation prompt the crew gets while walking (web/science.js).

Rules (kept deliberately conservative):
- the path is resampled every grid pixel (2 m); a majority filter ~40 m wide removes single-pixel flicker
  and any run shorter than MIN_RUN_M is folded into its neighbours
- mineral ids 0 (unidentified), 254 (uncertain) and 255 (no CRISM coverage) are never treated as a mineral
- nothing within STOP_SKIP_M of a stop (stops have their own science) and nothing in the first/last bit of the walk
- the same class is only prompted again after REPEAT_GAP_MIN of planned time (then as a "compare" prompt)
- at most MAX_PER_ROUTE prompts, at least MIN_SPACING_MIN apart, chosen by scientific interest

Run from the repo root:  .venv/bin/python pipeline/09_route_science.py
Output: data/route_science.json  {variants: {id: [{px, t_min, next_stop, kind, from, to, title, prompt, source, ...}]}, sources, note}
"""
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
OUT = DATA / "route_science.json"

PIXEL_M = 2.0
MIN_RUN_M = 40.0          # ignore runs shorter than this (noise, pixel edges)
SMOOTH_M = 40.0           # majority-filter window
STOP_SKIP_M = 60.0        # stops have their own science
MAX_PER_ROUTE = 6
MIN_SPACING_MIN = 15.0    # planned walk minutes between two prompts
MIN_SCORE_KEEP = 2        # skip low-interest changes (e.g. onto thin cover)
MAX_SAME_CLASS = 2        # a class is prompted at most twice per route (the second as a comparison)
REPEAT_GAP_MIN = 45.0     # same class prompted again only after this long (as a comparison)
NONE = 0                  # "no class" after masking

SRC_UNIT = "Stack et al. 2020, Photogeologic map of the Perseverance rover field site, Space Sci. Rev. 216:127 (CC-BY-4.0)"
SRC_MIN = "Parente et al., CRISM dominant mineralogy of Jezero crater, Zenodo 5575824 (CC-BY-4.0)"

# ---- prompt text -------------------------------------------------------------------------------------------
# Short field tasks: what to look at / photograph, and why it matters. Orbital maps are ~tens of metres per
# pixel, so the wording says "the map suggests" and asks the crew to check it on the ground.
UNIT_TEXT = {
    "Delta thinly layered": ("Onto thinly layered delta rock",
        "Look for fine layering and grain-size changes; photograph a layer edge with a scale. Thin layers record how water flowed into the lake."),
    "Delta thickly layered": ("Onto thickly layered delta rock",
        "Photograph bed thickness and any cross-bedding. Thick beds can mark stronger river flow building the delta."),
    "Delta layered rough": ("Onto rough layered delta rock",
        "Note where layers break into blocks; photograph a clean face. Shows how the delta layers erode today."),
    "Delta truncated curvilinear layered": ("Onto curved delta layers",
        "Photograph the curved layer traces from a distance. Curved, cut-off layers can record shifting river channels."),
    "Delta blocky": ("Onto blocky delta debris",
        "Check whether blocks are bedrock or loose boulders; photograph a few with a scale. Boulders may have been carried in by floods."),
    "Aeolian bedforms, large": ("Crossing large wind ripples",
        "Photograph ripple crests and note their direction; check for coarse grains on the crests. Records today's winds."),
    "Aeolian bedforms, small": ("Crossing small wind ripples",
        "Note ripple spacing and direction in a photo. A quick record of present-day wind at the site."),
    "Undifferentiated smooth": ("Back on the smooth crater floor",
        "Look for bedrock poking through the loose cover; photograph any exposed patch. Tells us what lies under the regolith."),
    "Moderate Cover Us": ("Onto covered ground",
        "Note how thick the loose cover looks and whether pebbles differ from the bedrock around them."),
    "Minor Cover Us": ("Onto thinly covered ground",
        "Look for bedrock under the thin cover; photograph any exposed patch."),
    "Crater floor fractured 1": ("Onto fractured crater-floor rock",
        "Photograph the fracture pattern and the rock texture (grains, vesicles). Helps tell lava from sedimentary rock."),
    "Crater floor fractured 2": ("Onto fractured crater-floor rock",
        "Photograph the fracture pattern and the rock texture (grains, vesicles). Helps tell lava from sedimentary rock."),
    "Crater floor fractured rough": ("Onto rough fractured floor",
        "Photograph a fresh face and the fracture spacing; note any coatings or veins."),
    "Talus": ("Crossing talus",
        "Note the rock types in the loose debris; they sample the slope above you."),
}
UNIT_FALLBACK = ("Onto {to}", "Photograph the change in rock or surface type here with a scale; note texture and colour.")

MIN_TEXT = {
    "Olivine": ("Orbital olivine signal",
        "Look for dark or greenish grains in the rock. Olivine alters quickly in water, so fresh olivine limits how long water acted here."),
    "Mg-carbonate": ("Orbital carbonate signal",
        "Look for light-toned rock or coatings and photograph them close up. Carbonates form with water and can preserve signs of past life."),
    "Fe/Mg-smectite": ("Orbital clay signal",
        "Look for fine-grained, crumbly or recessive layers. Smectite clays form when water alters rock."),
    "Olivine + smectite": ("Orbital olivine + clay signal",
        "Look for dark grains with softer, altered rims. A mix of olivine and clay suggests rock that water only partly changed."),
    "Olivine/smectite + 2.2 µm": ("Orbital altered-olivine signal",
        "Look for light-toned or bleached patches in dark rock. The 2.2 µm band hints at extra alteration by water."),
    "Carbonate + 2.2 µm": ("Orbital carbonate + clay signal",
        "Photograph light-toned rock close up. Carbonate with hydrated minerals is a key target in the search for past life."),
    "High-Ca pyroxene": ("Orbital pyroxene signal",
        "Note the rock texture (crystals, vesicles). Pyroxene marks volcanic rock: a baseline to compare with the water-altered rocks."),
    "Low-Ca pyroxene": ("Orbital low-Ca pyroxene signal",
        "Note grain size and colour of the dark rock; low-Ca pyroxene points to older volcanic material."),
    "Kaolinite": ("Orbital kaolinite signal",
        "Is the signal from bedrock or from loose light-toned pebbles? Photograph both. Kaolinite usually needs long leaching by water."),
    "Mg-smectite 2": ("Orbital Mg-clay signal",
        "Look for fine-grained, light-toned material. Mg-clays form when water alters rock."),
}

# interest score: higher wins when prompts compete for the same stretch of walk
UNIT_SCORE = {"Delta thinly layered": 9, "Delta thickly layered": 8, "Delta truncated curvilinear layered": 8,
              "Delta layered rough": 7, "Delta blocky": 6, "Crater floor fractured 1": 6, "Crater floor fractured 2": 6,
              "Crater floor fractured rough": 5, "Aeolian bedforms, large": 5, "Aeolian bedforms, small": 4,
              "Talus": 3, "Undifferentiated smooth": 2, "Moderate Cover Us": 1, "Minor Cover Us": 1}
MIN_SCORE = {"Mg-carbonate": 9, "Carbonate + 2.2 µm": 9, "Kaolinite": 8, "Fe/Mg-smectite": 7, "Mg-smectite 2": 7,
             "Olivine + smectite": 7, "Olivine/smectite + 2.2 µm": 7, "Olivine": 6, "High-Ca pyroxene": 4, "Low-Ca pyroxene": 4}


def densify(path, t_min):
    """Resample a pixel path every ~1 px; returns points (N,2) and planned minutes (N,)."""
    p = np.asarray(path, float); t = np.asarray(t_min, float)
    pts, ts = [p[0]], [t[0]]
    for i in range(len(p) - 1):
        n = max(1, int(np.ceil(np.hypot(*(p[i + 1] - p[i])))))
        f = np.arange(1, n + 1) / n
        pts.extend(p[i] + (p[i + 1] - p[i]) * f[:, None]); ts.extend(t[i] + (t[i + 1] - t[i]) * f)
    pts = np.array(pts); ts = np.array(ts)
    step = np.r_[0, np.hypot(*np.diff(pts, axis=0).T)]
    keep = step > 1e-6; keep[0] = True       # drop zero-length steps (stationary work at a stop)
    pts, ts = pts[keep], ts[keep]
    cum = np.r_[0, np.cumsum(np.hypot(*np.diff(pts, axis=0).T))] * PIXEL_M
    return pts, ts, cum


def majority(a, win):
    out = a.copy(); h = win // 2
    for i in range(len(a)):
        w = a[max(0, i - h): i + h + 1]
        v, c = np.unique(w, return_counts=True)
        out[i] = v[np.argmax(c)]
    return out


def runs(a, cum):
    """[(value, start_idx, end_idx_excl, length_m)]"""
    out, s = [], 0
    for i in range(1, len(a) + 1):
        if i == len(a) or a[i] != a[s]:
            out.append([int(a[s]), s, i, float(cum[i - 1] - cum[s])]); s = i
    return out


def fold_short(rs, min_m):
    """Fold runs shorter than min_m into the previous (or next) run, then merge equal neighbours."""
    changed = True
    while changed and len(rs) > 1:
        changed = False
        for k, r in enumerate(rs):
            if r[3] < min_m:
                j = k - 1 if k > 0 else k + 1
                a, b = sorted((k, j))
                lo, hi = rs[a], rs[b]
                keep = rs[j][0]
                merged = [keep, lo[1], hi[2], lo[3] + hi[3]]
                rs = rs[:a] + [merged] + rs[b + 1:]
                changed = True
                break
    out = []
    for r in rs:
        if out and out[-1][0] == r[0]:
            out[-1] = [r[0], out[-1][1], r[2], out[-1][3] + r[3]]
        else:
            out.append(r)
    return out


def main():
    g = np.load(DATA / "grids.npz")
    readme = json.loads((DATA / "grids_readme.json").read_text())
    routes = json.loads((DATA / "routes.json").read_text())
    units = {int(k): v for k, v in readme["units"].items()}
    minerals = {int(k): v for k, v in readme["minerals"].items()}
    gu, mi, mc = g["geo_unit"], g["mineral"], g["mineral_conf"]
    H, W = gu.shape
    stops_px = routes.get("stops_px", {})
    win = max(3, int(SMOOTH_M / PIXEL_M) | 1)

    result = {}
    for v in routes["variants"]:
        pts, ts, cum = densify(v["path"], v["t_min"])
        xi = np.clip(np.rint(pts[:, 0]).astype(int), 0, W - 1)
        yi = np.clip(np.rint(pts[:, 1]).astype(int), 0, H - 1)
        stop_xy = np.array([stops_px[s] for s in dict.fromkeys(v["stops"]) if s in stops_px], float)
        d_stop = np.min(np.hypot(pts[:, None, 0] - stop_xy[None, :, 0], pts[:, None, 1] - stop_xy[None, :, 1]), axis=1) * PIXEL_M

        u = majority(gu[yi, xi].astype(int), win)
        m_raw = mi[yi, xi].astype(int)
        m = np.where((m_raw == 0) | (m_raw >= 254), NONE, m_raw)
        m = majority(m, win)
        conf = mc[yi, xi].astype(int)

        cands = []
        for kind, arr, names in (("unit", u, units), ("mineral", m, minerals)):
            rs = fold_short(runs(arr, cum), MIN_RUN_M)
            prev_named = None
            for k, (val, s, e, length) in enumerate(rs):
                if kind == "mineral" and val == NONE:
                    continue
                name = names.get(val)
                if name is None:
                    continue
                frm = prev_named
                prev_named = name
                if k == 0 or frm == name:
                    continue                                   # start of the walk, or same class after a gap
                # entry point: first sample of the run that is clear of the stops
                idx = next((i for i in range(s, e) if d_stop[i] > STOP_SKIP_M), None)
                if idx is None or cum[idx] - cum[s] > max(MIN_RUN_M, 0.5 * length):
                    continue
                t = float(ts[idx])
                if kind == "unit":
                    title, prompt = UNIT_TEXT.get(name, UNIT_FALLBACK)
                    title = title.format(to=name)
                    score = UNIT_SCORE.get(name, 3)
                    source = SRC_UNIT
                    extra = {}
                else:
                    title, prompt = MIN_TEXT.get(name, (f"Orbital {name} signal", "Photograph the rock here close up."))
                    cvals = conf[s:e][conf[s:e] > 0]
                    c = int(np.bincount(cvals).argmax()) if len(cvals) else 0
                    clabel = {2: "high", 1: "medium"}.get(c, "low")
                    score = MIN_SCORE.get(name, 3) + (1 if c == 2 else 0)
                    prompt = f"{prompt} (Orbital CRISM, {clabel} confidence: verify on the ground.)"
                    source = f"{SRC_MIN}; {clabel} confidence"
                    extra = {"confidence": clabel}
                # the stop the crew is walking toward here: lets the app ignore an out-and-back path crossing
                nxt = next((sp["id"] for sp in v.get("stop_plan", [])[1:] if sp["arrive_min"] >= t), v["stops"][-1])
                cands.append({
                    "px": [round(float(pts[idx, 0]), 1), round(float(pts[idx, 1]), 1)],
                    "t_min": round(t, 2), "along_m": round(float(cum[idx]), 1), "next_stop": nxt,
                    "kind": kind, "from": frm, "to": name, "run_m": round(length),
                    "title": title, "prompt": prompt, "source": source, "_score": score, **extra,
                })

        # choose by interest, keep spacing, cap the count
        # (greedy: a class already chosen loses 3 points, and needs REPEAT_GAP_MIN from its first prompt)
        chosen, pool = [], [c for c in cands if c["_score"] >= MIN_SCORE_KEEP]
        while pool and len(chosen) < MAX_PER_ROUTE:
            def ok(c):
                same = [o for o in chosen if o["to"] == c["to"]]
                return (all(abs(c["t_min"] - o["t_min"]) >= MIN_SPACING_MIN for o in chosen)
                        and len(same) < MAX_SAME_CLASS
                        and all(abs(c["t_min"] - o["t_min"]) >= REPEAT_GAP_MIN for o in same))
            pool = [c for c in pool if ok(c)]
            if not pool:
                break
            adj = lambda c: c["_score"] - 3 * sum(o["to"] == c["to"] for o in chosen)
            best = max(pool, key=lambda c: (adj(c), -c["t_min"]))
            chosen.append(best); pool.remove(best)
        chosen.sort(key=lambda c: c["t_min"])
        seen = set()
        for i, c in enumerate(chosen):
            c.pop("_score")
            c["id"] = f"{v['id']}-{i + 1}"
            if c["to"] in seen:
                c["title"] += " again"
                c["prompt"] = "Compare with the earlier patch: same rock? " + c["prompt"]
            seen.add(c["to"])
        result[v["id"]] = chosen

    out = {
        "variants": result,
        "sources": [SRC_UNIT, SRC_MIN],
        "note": ("Route-side observation prompts where the mapped rock/surface unit or the orbital mineral class changes "
                 f"along the planned path (runs under {MIN_RUN_M:.0f} m ignored, nothing within {STOP_SKIP_M:.0f} m of a stop, "
                 "CRISM 'unidentified', 'uncertain' and 'no coverage' never used). Orbital maps are tens of metres per pixel: "
                 "each prompt is a suggestion to check on the ground, not a confirmed detection. Generated by pipeline/09_route_science.py."),
        "params": {"min_run_m": MIN_RUN_M, "smooth_m": SMOOTH_M, "stop_skip_m": STOP_SKIP_M, "max_per_route": MAX_PER_ROUTE,
                   "min_spacing_min": MIN_SPACING_MIN, "repeat_gap_min": REPEAT_GAP_MIN},
    }
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}")
    for vid, items in result.items():
        print(f"  {vid}: {len(items)} prompts")
        for c in items:
            print(f"    ->{c['next_stop']} T+{c['t_min']:6.1f}  {c['along_m']:6.0f} m  {c['kind']:7s} {str(c['from'])[:24]:24s} -> {c['to'][:26]:26s} "
                  f"run {c['run_m']:4d} m  {c['title']}")


if __name__ == "__main__":
    main()
