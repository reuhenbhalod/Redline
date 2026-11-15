"""Export the walking-time grid the web app uses to reroute live (around rover-camera rock fields and
hazards the crew marks), so the browser routes with the same terrain model as the planner.

    .venv/bin/python pipeline/08_walk_grid.py     # -> data/walk_time.bin + data/walk_grid.json

walk_time.bin: uint8, row-major, (2000/STRIDE)^2 cells. Value = deciseconds to cross one cell along an axis
at the suited walking speed on that ground (slope, sand, roughness; the same model as engine._time).
255 = no-go (slope / roughness / no data, grown by the safety buffer). Coarse cells are no-go if any fine
cell is; otherwise the mean time of the fine cells.
"""
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import engine  # noqa: E402

STRIDE = 2


def main(data="data"):
    layers, _stops, rcfg, _info = engine.load_real(data)
    t = engine.build_terrain(layers, rcfg).time          # minutes per fine-cell step, inf = no-go
    h, w = t.shape
    H, W = h // STRIDE, w // STRIDE
    blk = t[:H * STRIDE, :W * STRIDE].reshape(H, STRIDE, W, STRIDE)
    bad = ~np.isfinite(blk).all(axis=(1, 3))
    sec = np.where(np.isfinite(blk), blk, 0).mean(axis=(1, 3)) * 60 * STRIDE    # s per coarse cell
    ds = np.clip(np.round(sec * 10), 1, 254).astype(np.uint8)
    ds[bad] = 255
    out = Path(data)
    (out / "walk_time.bin").write_bytes(ds.tobytes())
    meta = {"file": "walk_time.bin", "width": W, "height": H, "stride_px": STRIDE, "cell_m": rcfg.PIXEL_M * STRIDE,
            "unit": "deciseconds per axis step; 255 = no-go", "source": "pipeline/08_walk_grid.py (engine terrain time model)"}
    (out / "walk_grid.json").write_text(json.dumps(meta, indent=2))
    flat = np.median(ds[~bad])
    print(f"wrote {out/'walk_time.bin'} {W}x{H}, no-go {bad.mean():.1%}, median {flat/10:.1f} s/cell")


if __name__ == "__main__":
    main(*sys.argv[1:])
