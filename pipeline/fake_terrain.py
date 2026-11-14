"""Fake hilly terrain so the engine can be built before real layers arrive.

Writes the same .npy files Data will deliver (slope_deg, sand, rough, nogo)
plus a fake stops.json with the contract shape.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter, uniform_filter

import config as cfg


def make_dtm(size: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    dtm = np.zeros((size, size), np.float32)
    f = size / 2000  # keep slopes realistic on smaller test grids
    for _ in range(14):  # rolling hills
        cx, cy = rng.uniform(0, size, 2)
        sig = rng.uniform(0.03, 0.12) * size
        amp = rng.uniform(-30, 60) * f
        dtm += amp * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * sig**2))
    # A delta-front scarp running roughly SW-NE, with a gentle ramp through it.
    d = (xx - yy * 0.6 - size * 0.35) / (0.02 * size)
    gap = np.exp(-((yy - size * 0.55) ** 2) / (2 * (0.04 * size) ** 2))
    dtm += 35 * f * np.tanh(d) * (1 - 0.85 * gap)
    dtm += gaussian_filter(rng.normal(0, 3 * f, (size, size)), 3)  # small-scale texture
    return dtm


def make_layers(size: int = cfg.GRID_SIZE_PX, seed: int = 7):
    rng = np.random.default_rng(seed + 1)
    dtm = make_dtm(size, seed)
    gy, gx = np.gradient(dtm, cfg.PIXEL_M)
    slope = np.degrees(np.arctan(np.hypot(gx, gy))).astype(np.float32)

    sand = np.zeros((size, size), np.float32)
    yy, xx = np.mgrid[0:size, 0:size]
    for _ in range(6):
        cx, cy = rng.uniform(0.15, 0.85, 2) * size
        a, b = rng.uniform(0.03, 0.09, 2) * size
        sand[((xx - cx) / a) ** 2 + ((yy - cy) / b) ** 2 < 1] = 1
    sand = gaussian_filter(sand, size * 0.004).clip(0, 1)

    m = uniform_filter(dtm, 9)
    rough = np.sqrt(np.maximum(uniform_filter(dtm**2, 9) - m**2, 0))
    rough = (rough / (np.percentile(rough, 99) + 1e-6)).clip(0, 1).astype(np.float32)

    nogo = np.zeros((size, size), bool)
    s = size // 40
    nogo[int(size * 0.2): int(size * 0.2) + s, int(size * 0.7): int(size * 0.7) + 3 * s] = True  # data gap
    return dtm, slope, sand, rough, nogo


def fake_stops(size: int):
    f = size / 2000
    def px(x, y):
        return [int(x * f), int(y * f)]
    return [
        {"id": "H", "name": "Habitat", "px": px(620, 1330), "kind": "base"},
        {"id": "A", "name": "Delta outcrop", "px": px(1000, 980), "kind": "science",
         "work_min": 45, "why": "FAKE: layered carbonates", "expect": "", "photos": [], "sol": 0},
        {"id": "B", "name": "Three Forks depot", "px": px(1350, 760), "kind": "depot",
         "work_min": 30, "why": "FAKE: sample tubes", "expect": "", "photos": [], "sol": 0},
    ]


def write_fake(out_dir: str | Path, size: int = cfg.GRID_SIZE_PX, seed: int = 7) -> Path:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    dtm, slope, sand, rough, nogo = make_layers(size, seed)
    np.save(out / "dtm.npy", dtm)
    np.save(out / "slope_deg.npy", slope)
    np.save(out / "sand.npy", sand)
    np.save(out / "rough.npy", rough)
    np.save(out / "nogo.npy", nogo)
    (out / "stops.json").write_text(json.dumps(fake_stops(size), indent=2))
    return out


if __name__ == "__main__":
    print("wrote", write_fake("work/fake"))
