"""D5: environment data -> data/env_data.json. Every value carries its source and time frame (finding 12).

- MEDA (Perseverance, Jezero), depot season sols 650-690 (every 5th sol):
  air and ground temperature (calibrated TIRS), pressure (derived PS), relative humidity (derived RHS),
  hourly profile by local true solar time, and a DUST ESTIMATE from the semidiurnal pressure tide:
  (S2 / S0) [%] = 1.6 tau + 0.3  (Wilson et al. 2008; applied at Jezero by Sanchez-Lavega et al. 2023,
  JGR Planets, doi:10.1029/2022JE007480). Wind: not available (MEDA wind sensor damaged in 2022).
- RAD (Curiosity at Gale, STAND-IN): mean total dose rate on Earth dates matching the depot campaign,
  read with HTTP range requests (only the dose bytes of each 67 MB file).
- DONKI (live): WSA-ENLIL CME simulations with a predicted Mars impact, last 30 days + upcoming.
"""
import json, os, re, sys, time
from datetime import datetime, timedelta, timezone, date
from pathlib import Path
import numpy as np
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as C

S = requests.Session(); S.headers["User-Agent"] = "marswalk-data-pipeline/0.1 (NASA Space Apps 2026)"
CACHE = C.RAW / "env"; CACHE.mkdir(exist_ok=True)
MEDA_SOLS = list(range(650, 691, 5))
DEPOT_DATES = (date(2022, 12, 21), date(2023, 1, 28))   # Earth dates of the depot campaign (sols ~653-690)
RAD_SAMPLE_EVERY_DAYS = 5


def cached(url, name):
    p = CACHE / name
    if not p.exists():
        r = S.get(url, timeout=180); r.raise_for_status(); p.write_bytes(r.content); time.sleep(0.2)
    return p


def listing(url):
    return re.findall(r'href="([^"?/]+)"', S.get(url, timeout=60).text)


def meda_folder(kind, sol):
    lo = (sol // 120) * 120 if sol >= 180 else None
    # MEDA bins: 0-89, 90-179, then 120-sol bins starting at 180
    bins = [(0, 89), (90, 179)] + [(a, a + 119) for a in range(180, 3000, 120)]
    a, b = next((a, b) for a, b in bins if a <= sol <= b)
    return f"{C.MEDA_ROOT}/{kind}/sol_{a:04d}_{b:04d}/sol_{sol:04d}/"


def read_csv(p, cols):
    import csv
    out = {c: [] for c in cols}; ltst = []
    with open(p) as f:
        for row in csv.DictReader(f):
            try:
                h, m, s = row["LTST"].split()[1].split(":")
                t = int(h) + int(m) / 60 + float(s) / 3600
                vals = [float(row[c]) for c in cols]
            except (ValueError, KeyError, IndexError):
                continue
            ltst.append(t)
            for c, v in zip(cols, vals): out[c].append(v)
    return np.array(ltst), {c: np.array(v) for c, v in out.items()}


def harmonics(t_hours, p):
    """Least-squares fit of mean + diurnal + semidiurnal; returns S0, S1, S2 (Pa)."""
    w = 2 * np.pi * t_hours / 24
    A = np.column_stack([np.ones_like(w), np.cos(w), np.sin(w), np.cos(2 * w), np.sin(2 * w), np.cos(3 * w), np.sin(3 * w)])
    c, *_ = np.linalg.lstsq(A, p, rcond=None)
    return c[0], np.hypot(c[1], c[2]), np.hypot(c[3], c[4])


def meda():
    per_sol, hourly = [], {k: [[] for _ in range(24)] for k in ("air_k", "ground_k", "pressure_pa")}
    for sol in MEDA_SOLS:
        try:
            files = {}
            for kind, key in (("data_calibrated_env", "CAL_TIRS"), ("data_calibrated_env", "CAL_ATS"),
                              ("data_derived_env", "DER_PS"), ("data_derived_env", "DER_RHS")):
                folder = meda_folder(kind, sol)
                f = next(x for x in listing(folder) if key in x and x.endswith(".CSV"))
                files[key] = cached(folder + f, f)
        except (StopIteration, requests.HTTPError) as e:
            print(f"  sol {sol}: MEDA files missing ({e.__class__.__name__}), skipped"); continue
        tt, T = read_csv(files["CAL_TIRS"], ["GROUND_TEMP"])   # TIRS ground temperature
        ta, A = read_csv(files["CAL_ATS"], ["ATS_LOCAL_TEMP1", "ATS_LOCAL_TEMP2", "ATS_LOCAL_TEMP3"])
        air = np.median(np.vstack([A[k] for k in A]), axis=0)  # mast-mounted ATS 1-3 (TIRS AIR_TEMP reads warm)
        tp, P = read_csv(files["DER_PS"], ["PRESSURE"])
        th, H = read_csv(files["DER_RHS"], ["LOCAL_RELATIVE_HUMIDITY"])
        if len(tp) < 20000:   # need most of the sol for a tide fit
            print(f"  sol {sol}: only {len(tp)} pressure samples, tide fit skipped")
            s0 = s2 = tau = None
        else:
            s0, s1, s2 = harmonics(tp, P["PRESSURE"])
            tau = (100 * s2 / s0 - 0.3) / 1.6
        rec = {"sol": sol,
               "air_temp_c": {"min": round(float(np.percentile(air, 1)) - 273.15, 1), "max": round(float(np.percentile(air, 99)) - 273.15, 1)},
               "ground_temp_c": {"min": round(float(np.percentile(T["GROUND_TEMP"], 1)) - 273.15, 1),
                                 "max": round(float(np.percentile(T["GROUND_TEMP"], 99)) - 273.15, 1)},
               "pressure_pa_mean": round(float(P["PRESSURE"].mean()), 1),
               "rel_humidity_pct_max": round(float(H["LOCAL_RELATIVE_HUMIDITY"].max()), 1) if len(th) else None,
               "tide_s2_pct": round(float(100 * s2 / s0), 3) if s0 else None,
               "dust_tau_estimate": round(float(tau), 2) if tau is not None else None}
        per_sol.append(rec)
        for key, (t, v) in {"air_k": (ta, air), "ground_k": (tt, T["GROUND_TEMP"]), "pressure_pa": (tp, P["PRESSURE"])}.items():
            for h in range(24):
                m = (t >= h) & (t < h + 1)
                if m.any(): hourly[key][h].append(float(v[m].mean()))
        print(f"  sol {sol}: air {rec['air_temp_c']} C, ground {rec['ground_temp_c']} C, p {rec['pressure_pa_mean']} Pa, tau~{rec['dust_tau_estimate']}")
    prof = [{"ltst_hour": h,
             "air_temp_c": round(np.mean(hourly["air_k"][h]) - 273.15, 1) if hourly["air_k"][h] else None,
             "ground_temp_c": round(np.mean(hourly["ground_k"][h]) - 273.15, 1) if hourly["ground_k"][h] else None,
             "pressure_pa": round(np.mean(hourly["pressure_pa"][h]), 1) if hourly["pressure_pa"][h] else None} for h in range(24)]
    taus = [r["dust_tau_estimate"] for r in per_sol if r["dust_tau_estimate"] is not None]
    return per_sol, prof, taus


def rad():
    """Mean RAD total dose rate (B silicon, E plastic) on sampled days within the depot campaign dates."""
    dirs = [d for d in listing(f"{C.RAD_ROOT}/") if d.startswith("SOL_")] or \
           [m for m in re.findall(r"SOL_\d{5}_\d{5}", S.get(f"{C.RAD_ROOT}/", timeout=60).text)]
    targets, d = [], DEPOT_DATES[0]
    while d <= DEPOT_DATES[1]:
        targets.append(d); d += timedelta(days=RAD_SAMPLE_EVERY_DAYS)
    files = {}
    for dd in sorted(set(dirs)):
        a, b = (int(x) for x in dd.split("_")[1:])
        if not (3600 <= a <= 3800 or 3600 <= b <= 3800):   # MSL sols covering Dec 2022 - Jan 2023
            continue
        html = S.get(f"{C.RAD_ROOT}/{dd}/", timeout=60).text
        for f in set(re.findall(r"RAD_RDR_(\d{4})_(\d{3})_\d\d_\d\d_(\d{4})_V\d\d\.LBL", html)):
            day = date(int(f[0]), 1, 1) + timedelta(days=int(f[1]) - 1)
            files[day] = (dd, f"RAD_RDR_{f[0]}_{f[1]}", int(f[2]), html)
    rows = []
    for t in targets:
        day = min(files, key=lambda x: abs((x - t).days))
        if abs((day - t).days) > 2: continue
        dd, prefix, msl_sol, html = files[day]
        base = re.search(rf"({prefix}_\d\d_\d\d_{msl_sol}_V\d\d)\.LBL", html).group(1)
        lbl = cached(f"{C.RAD_ROOT}/{dd}/{base}.LBL", base + ".LBL").read_text(errors="ignore")
        offs = re.findall(r"\^OBS(\d+)_TOT_DOSE_([BE])_ELEMENT\s*=\s*\(\s*\"[^\"]+\",\s*(\d+)\s*<BYTES>\)", lbl)
        assert offs and "microGray / Hour" in lbl, "RAD label format changed"
        vals = {"B": [], "E": []}
        url = f"{C.RAD_ROOT}/{dd}/{base}.TXT"
        for i in range(0, len(offs), 40):   # batched multi-range requests
            chunk = offs[i:i + 40]
            rng = ",".join(f"{int(o) - 1}-{int(o) + 5}" for _, _, o in chunk)
            r = S.get(url, headers={"Range": f"bytes={rng}"}, timeout=120)
            if r.status_code != 206:
                raise RuntimeError(f"range request not honored ({r.status_code})")
            if len(chunk) == 1:
                parts = [r.content]
            else:
                bnd = re.search(r"boundary=([^;\s]+)", r.headers["Content-Type"]).group(1).encode()
                parts = [p.split(b"\r\n\r\n", 1)[1].rsplit(b"\r\n", 1)[0] for p in r.content.split(b"--" + bnd)[1:-1]]
            for (_, det, _), raw in zip(chunk, parts):
                try:
                    v = float(raw.decode().strip())
                    if v > 0: vals[det].append(v)
                except ValueError:
                    pass
        rec = {"earth_date": day.isoformat(), "msl_sol": msl_sol, "n_obs": len(vals["E"]),
               "dose_B_uGy_per_day": round(24 * float(np.mean(vals["B"])), 1) if vals["B"] else None,
               "dose_E_uGy_per_day": round(24 * float(np.mean(vals["E"])), 1) if vals["E"] else None}
        rows.append(rec); print(f"  RAD {rec}")
    return rows


def donki():
    key = os.environ.get("NASA_API_KEY", "DEMO_KEY")
    now = datetime.now(timezone.utc)
    start, end = (now - timedelta(days=30)).date(), (now + timedelta(days=1)).date()
    r = S.get(f"{C.DONKI_ROOT}/WSAEnlilSimulations", params={"startDate": start, "endDate": end, "api_key": key}, timeout=120)
    r.raise_for_status(); sims = r.json()
    (CACHE / f"donki_wsaenlil_{now:%Y%m%d}.json").write_text(json.dumps(sims))
    arrivals = {}
    for s in sims:
        for i in s.get("impactList") or []:
            if i.get("location") == "Mars":
                cmes = [c.get("CMEID") for c in s.get("cmeInputs", [])]
                k = (i["arrivalTime"], tuple(cmes))
                arrivals[k] = {"arrival_utc": i["arrivalTime"], "glancing_blow": i.get("isGlancingBlow"),
                               "minor_impact": i.get("isMinorImpact"), "cme_ids": cmes, "simulation": s.get("simulationID"),
                               "link": s.get("link")}
    arr = sorted(arrivals.values(), key=lambda a: a["arrival_utc"])
    def t(a): return datetime.strptime(a["arrival_utc"], "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)
    upcoming = [a for a in arr if t(a) >= now - timedelta(hours=12)]
    alert = any(not a["glancing_blow"] for a in upcoming if t(a) <= now + timedelta(days=3))
    print(f"  DONKI: {len(sims)} simulations, {len(arr)} predicted Mars arrivals in 30 days, {len(upcoming)} upcoming, alert={alert}"
          + ("  (DEMO_KEY: set NASA_API_KEY for a real key)" if key == "DEMO_KEY" else ""))
    return {"fetched_utc": now.isoformat(timespec="minutes"), "window": [str(start), str(end)],
            "mars_cme_arrivals_30d": arr, "upcoming": upcoming, "solar_alert": alert}


def main():
    print("MEDA (depot season)"); per_sol, prof, taus = meda()
    print("RAD (Curiosity stand-in)"); rad_rows = rad()
    print("DONKI (live)"); dk = donki()
    E = [r["dose_E_uGy_per_day"] for r in rad_rows if r["dose_E_uGy_per_day"]]
    B = [r["dose_B_uGy_per_day"] for r in rad_rows if r["dose_B_uGy_per_day"]]
    env = {
        "weather": {
            "air_temp_c": {"min": min(r["air_temp_c"]["min"] for r in per_sol), "max": max(r["air_temp_c"]["max"] for r in per_sol)},
            "ground_temp_c": {"min": min(r["ground_temp_c"]["min"] for r in per_sol), "max": max(r["ground_temp_c"]["max"] for r in per_sol)},
            "pressure_pa": round(float(np.mean([r["pressure_pa_mean"] for r in per_sol])), 1),
            "hourly_profile": prof, "per_sol": per_sol,
            "wind": None, "wind_note": "not available: MEDA wind sensor damaged in 2022",
            "source": "MEDA, Perseverance (PDS Atmospheres): calibrated ATS air temperature (median of mast sensors 1-3), calibrated TIRS ground temperature, derived pressure and humidity; min/max are 1st/99th percentiles",
            "time_frame": f"sols {MEDA_SOLS[0]}-{MEDA_SOLS[-1]} (Dec 2022 - Jan 2023, depot season), every 5th sol"},
        "dust": {
            "tau_estimate": round(float(np.median(taus)), 2) if taus else None,
            "tau_range": [min(taus), max(taus)] if taus else None,
            "method": "semidiurnal pressure tide from MEDA pressure: (S2/S0)[%] = 1.6*tau + 0.3",
            "source": "Wilson et al. 2008 relation, applied at Jezero by Sanchez-Lavega et al. 2023, JGR Planets, doi:10.1029/2022JE007480",
            "time_frame": "depot season (same sols as weather)", "is_estimate": True},
        "radiation": {
            "dose_uGy_per_day": round(float(np.mean(E)), 1) if E else None,
            "dose_silicon_uGy_per_day": round(float(np.mean(B)), 1) if B else None,
            "per_day": rad_rows,
            "reference": "Hassler et al. 2014, Science 343, doi:10.1126/science.1244797: 210 +/- 40 uGy/day (GCR, Gale crater)",
            "source": "MSL RAD RDR (PDS PPI), total dose E (plastic, tissue-like) and B (silicon)",
            "time_frame": f"Earth dates {DEPOT_DATES[0]} to {DEPOT_DATES[1]} (same as the depot campaign), sampled every {RAD_SAMPLE_EVERY_DAYS} days",
            "stand_in": True,
            "note": "Curiosity at Gale, not Jezero; Jezero sits ~2 km higher (thinner air shield), so true dose is likely somewhat higher"},
        "space_weather": dk | {"source": "NASA CCMC DONKI, WSA-ENLIL simulations with a predicted Mars impact", "time_frame": "live at fetch time"},
    }
    (C.DATA / "env_data.json").write_text(json.dumps(env, indent=2))
    print("wrote data/env_data.json")


if __name__ == "__main__":
    main()
