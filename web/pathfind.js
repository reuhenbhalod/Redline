// pathfind.js — live detours on the walking-time grid (data/walk_time.bin from pipeline/08_walk_grid.py).
// Used by sim.js when the rover camera confirms a rock field or the crew walks toward a hazard they marked:
// A* from the crew's position to a rejoin point on the route, with circular keep-out zones blocked.
// Same terrain model as the planner (slope, sand, roughness, no-go + buffer), 4 m cells.

const NOGO = 255;

/** grid: { width, height, stridePx, cellM, values: Uint8Array (deciseconds per axis step, 255 = no-go) } */
export function parseWalkGrid(buf, meta) {
  const width = meta?.width ?? 1000, height = meta?.height ?? 1000;
  if (!buf || buf.byteLength !== width * height) return null;
  return { width, height, stridePx: meta?.stride_px ?? 2, cellM: meta?.cell_m ?? 4, values: new Uint8Array(buf) };
}

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

/**
 * Fastest path from fromPx to toPx (grid px) avoiding `zones` ([{px, radiusPx}]).
 * Returns { path: [[x,y],...] in grid px (first = fromPx, last = toPx), sec: [cumulative seconds] } or null.
 */
export function findDetour(grid, fromPx, toPx, zones = [], { marginCells = 160 } = {}) {
  if (!grid) return null;
  const { width: W, height: H, stridePx: S, values } = grid;
  const cell = (p) => [Math.min(W - 1, Math.max(0, Math.floor(p[0] / S))), Math.min(H - 1, Math.max(0, Math.floor(p[1] / S)))];
  const [sx, sy] = cell(fromPx), [tx, ty] = cell(toPx);
  const x0 = Math.max(0, Math.min(sx, tx) - marginCells), x1 = Math.min(W - 1, Math.max(sx, tx) + marginCells);
  const y0 = Math.max(0, Math.min(sy, ty) - marginCells), y1 = Math.min(H - 1, Math.max(sy, ty) + marginCells);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, N = bw * bh;
  const zc = zones.map((z) => ({ x: z.px[0] / S - 0.5, y: z.px[1] / S - 0.5, r2: (z.radiusPx / S) ** 2 }));
  const blocked = (x, y) => {
    if (values[y * W + x] === NOGO) return true;
    for (const z of zc) if ((x - z.x) ** 2 + (y - z.y) ** 2 <= z.r2) return true;
    return false;
  };
  const g = new Float64Array(N).fill(Infinity);
  const from = new Int32Array(N).fill(-1);
  const done = new Uint8Array(N);
  let minV = 255;
  for (let y = y0; y <= y1; y += 4) for (let x = x0; x <= x1; x += 4) { const v = values[y * W + x]; if (v < minV) minV = v; }
  const hMul = Math.max(1, minV) / 10;
  const heur = (x, y) => { const dx = Math.abs(x - tx), dy = Math.abs(y - ty); return hMul * (Math.max(dx, dy) + 0.4142 * Math.min(dx, dy)); };
  const idx = (x, y) => (y - y0) * bw + (x - x0);
  const s = idx(sx, sy), t = idx(tx, ty);
  g[s] = 0;
  const heap = new Heap();
  heap.push(heur(sx, sy), s);
  const D = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  while (heap.size) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === t) break;
    const ux = (u % bw) + x0, uy = ((u / bw) | 0) + y0;
    const cu = values[uy * W + ux] === NOGO ? 60 : values[uy * W + ux];   // the start cell may sit in a buffer
    for (const [dx, dy, len] of D) {
      const vx = ux + dx, vy = uy + dy;
      if (vx < x0 || vx > x1 || vy < y0 || vy > y1) continue;
      const v = idx(vx, vy);
      if (done[v]) continue;
      if (v !== t && blocked(vx, vy)) continue;
      if (len > 1 && (blocked(ux + dx, uy) || blocked(ux, uy + dy))) continue;   // no corner cutting past no-go
      const cv = values[vy * W + vx] === NOGO ? 60 : values[vy * W + vx];
      const ng = g[u] + 0.05 * (cu + cv) * len;     // seconds: mean of the two cells' deciseconds
      if (ng < g[v]) { g[v] = ng; from[v] = u; heap.push(ng + heur(vx, vy), v); }
    }
  }
  if (!Number.isFinite(g[t])) return null;
  const cells = [];
  for (let u = t; u !== -1; u = from[u]) cells.push(u);
  cells.reverse();
  // cells -> grid px (cell centres), keeping only corners; exact endpoints
  const pts = cells.map((u) => [((u % bw) + x0) * S + S / 2, (((u / bw) | 0) + y0) * S + S / 2]);
  const secs = cells.map((u) => g[u]);
  const P = [[fromPx[0], fromPx[1]]], T = [0];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    if ((b[0] - a[0]) * (c[1] - b[1]) === (b[1] - a[1]) * (c[0] - b[0])) continue;   // straight run
    P.push(b); T.push(secs[i]);
  }
  P.push([toPx[0], toPx[1]]); T.push(secs[secs.length - 1]);
  return { path: P, sec: T };
}

/** Seconds to walk a polyline (grid px) on the walking grid, sampled every half cell. */
export function pathSeconds(grid, path) {
  if (!grid || !path || path.length < 2) return 0;
  const { width: W, height: H, stridePx: S, values } = grid;
  let sec = 0;
  for (let j = 1; j < path.length; j++) {
    const [ax, ay] = path[j - 1], [bx, by] = path[j];
    const lenCells = Math.hypot(bx - ax, by - ay) / S;
    const n = Math.max(1, Math.ceil(lenCells * 2));
    for (let k = 0; k < n; k++) {
      const f = (k + 0.5) / n;
      const cx = Math.min(W - 1, Math.max(0, Math.floor((ax + f * (bx - ax)) / S)));
      const cy = Math.min(H - 1, Math.max(0, Math.floor((ay + f * (by - ay)) / S)));
      const v = values[cy * W + cx];
      sec += (v === NOGO ? 60 : v) / 10 * (lenCells / n);
    }
  }
  return sec;
}
