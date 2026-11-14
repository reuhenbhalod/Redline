"""D0: download every small source into raw/ and verify it.

Big rasters (HiRISE DTM and orthomosaic) are NOT downloaded here; D2 reads only
our box from them remotely. Re-running skips files that already verify.

Verification:
- Zenodo and Caltech files: md5 from the repository's own API.
- JSON/CSV feeds (no published checksum): parse and check expected structure.
Writes raw/manifest.json (url, size, sha256, checked) for provenance.
"""
import hashlib, json, sys, zipfile, csv, io
from pathlib import Path
from datetime import datetime, timezone
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import config as C

S = requests.Session()
S.headers["User-Agent"] = "marswalk-data-pipeline/0.1 (NASA Space Apps 2026)"
MANIFEST = C.RAW / "manifest.json"
manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}


def digest(path: Path, algo: str) -> str:
    h = hashlib.new(algo)
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dest: Path, md5: str | None = None, check=None) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    ok = dest.exists() and (md5 is None or digest(dest, "md5") == md5)
    if not ok:
        print(f"  downloading {dest.relative_to(C.ROOT)}")
        with S.get(url, stream=True, timeout=120) as r:
            r.raise_for_status()
            tmp = dest.with_suffix(dest.suffix + ".part")
            with open(tmp, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
        tmp.replace(dest)
        if md5 and digest(dest, "md5") != md5:
            raise SystemExit(f"md5 mismatch for {dest}")
    if check:
        check(dest)
    manifest[str(dest.relative_to(C.ROOT))] = {
        "url": url, "bytes": dest.stat().st_size, "sha256": digest(dest, "sha256"),
        "verified": "md5" if md5 else ("structure" if check else "none"),
        "fetched_utc": manifest.get(str(dest.relative_to(C.ROOT)), {}).get("fetched_utc")
        or datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    print(f"  ok  {dest.relative_to(C.ROOT)}  ({dest.stat().st_size:,} B, {manifest[str(dest.relative_to(C.ROOT))]['verified']})")
    return dest


def zenodo(record: int, folder: str, keep: set[str] | None = None):
    meta = S.get(f"https://zenodo.org/api/records/{record}", timeout=60).json()
    for f in meta["files"]:
        if keep and f["key"] not in keep:
            continue
        algo, val = f["checksum"].split(":")
        assert algo == "md5"
        download(f["links"]["self"], C.RAW / folder / f["key"], md5=val)


def caltech(record: str, key: str, folder: str) -> Path:
    entries = S.get(f"https://authors.library.caltech.edu/api/records/{record}/files", timeout=60).json()["entries"]
    e = next(x for x in entries if x["key"] == key)
    algo, val = e["checksum"].split(":")
    assert algo == "md5"
    return download(e["links"]["content"], C.RAW / folder / key, md5=val)


# ---- structure checks for feeds without checksums -------------------------
def check_waypoints(p: Path):
    feats = json.loads(p.read_text())["features"]
    assert len(feats) >= 700, len(feats)
    need = {"sol", "lon", "lat", "site", "drive"}
    assert need <= set(feats[0]["properties"]), feats[0]["properties"].keys()

def check_traverse(p: Path):
    feats = json.loads(p.read_text())["features"]
    assert len(feats) > 100 and feats[0]["geometry"]["type"] == "LineString"

def check_drops(p: Path):
    rows = list(csv.DictReader(io.StringIO(p.read_text())))
    assert len(rows) == 10, len(rows)
    assert {"Sample Designation", "Sample Name"} <= set(rows[0])


def check_raster(p: Path):
    import rasterio
    with rasterio.open(p) as d:
        assert d.crs and "Equirectangular" in d.crs.to_wkt(), d.crs
        a = d.read(1, out_shape=(64, 64))  # full decode of a thumbnail
        assert a.size and d.width > 100 and d.height > 100


def main():
    print("THEMIS thermal inertia (Zenodo)")
    zenodo(C.ZENODO_THEMIS, "themis")
    print("CRISM mineral map (Zenodo)")
    zenodo(C.ZENODO_CRISM, "crism")
    print("Stack et al. 2020 photogeologic map (Caltech)")
    z = caltech(C.CALTECH_STACK, C.STACK_ZIP, "stack")
    with zipfile.ZipFile(z) as zf:
        for name in zf.namelist():           # flat archive; refuse path tricks
            assert "/" not in name and ".." not in name, name
        zf.extractall(z.parent)
    print("Perseverance waypoints and traverse (MMGIS)")
    download(C.M20_WAYPOINTS_URL, C.RAW / "m20" / "M20_waypoints.json", check=check_waypoints)
    download(C.M20_TRAVERSE_URL, C.RAW / "m20" / "M20_traverse.json", check=check_traverse)
    print("Three Forks depot drop events (PDS Geosciences)")
    download(C.DEPOT_DROPS_URL, C.RAW / "depot" / "sample_drop_timestamps.csv", check=check_drops)
    print("CTX DTM backup (USGS)")
    # S3 ETag is multipart (not an md5), so verify by opening the raster instead.
    download(C.CTX_DTM_URL, C.RAW / "ctx" / Path(C.CTX_DTM_URL).name, check=check_raster)
    MANIFEST.write_text(json.dumps(manifest, indent=2))
    print(f"manifest: {len(manifest)} files -> {MANIFEST.relative_to(C.ROOT)}")


if __name__ == "__main__":
    main()
