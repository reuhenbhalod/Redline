// util.js — shared, dependency-free helpers. Every module imports from here.
// Coordinates: a "px" is [x, y] on the data grid (2000x2000), y grows DOWN.
// Fractional px are allowed (interpolated positions). Integer px [x, y] refers to
// the CENTER of grid cell (x, y).

// ---------------------------------------------------------------------------
// Pixel <-> Leaflet LatLng (L.CRS.Simple). THE ONLY place this mapping lives.
// Cell (x, y) spans lng [x, x+1] and lat [-(y+1), -y]; its center is
// lat = -(y + 0.5), lng = x + 0.5. The basemap image overlay covers
// imageBounds(w, h) = [[-h, 0], [0, w]], so markers/paths sit on their cells.
// ---------------------------------------------------------------------------

/** [x, y] grid px -> [lat, lng] (plain array; Leaflet accepts it anywhere). */
export function pxToLatLng(px) {
  return [-(px[1] + 0.5), px[0] + 0.5];
}

/** L.LatLng | {lat,lng} | [lat, lng] -> [x, y] grid px (fractional). */
export function latLngToPx(ll) {
  const lat = Array.isArray(ll) ? ll[0] : ll.lat;
  const lng = Array.isArray(ll) ? ll[1] : ll.lng;
  return [lng - 0.5, -lat - 0.5];
}

/** Leaflet bounds for an image overlay covering the whole w x h grid. */
export function imageBounds(widthPx, heightPx) {
  return [[-heightPx, 0], [0, widthPx]];
}

/** path [[x,y],...] -> [[lat,lng],...] */
export function pathToLatLngs(path) {
  return path.map(pxToLatLng);
}

// ---------------------------------------------------------------------------
// Math basics
// ---------------------------------------------------------------------------
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, f) => a + (b - a) * f;
export const lerpPx = (a, b, f) => [lerp(a[0], b[0], f), lerp(a[1], b[1], f)];

/** Euclidean distance in grid px. */
export function distPx(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Euclidean distance in meters. */
export function distM(a, b, pixelM = 2) {
  return distPx(a, b) * pixelM;
}

/** Cumulative distance (meters) at each path vertex. Float64Array, [0] = 0. */
export function cumulativeDistM(path, pixelM = 2) {
  const out = new Float64Array(path.length);
  for (let i = 1; i < path.length; i++) out[i] = out[i - 1] + distM(path[i - 1], path[i], pixelM);
  return out;
}

/** Meters along path from vertex i0 to vertex i1 (inclusive indices, i0 <= i1). */
export function pathLengthM(path, pixelM = 2, i0 = 0, i1 = path.length - 1) {
  let d = 0;
  for (let i = Math.max(1, i0 + 1); i <= i1 && i < path.length; i++) d += distM(path[i - 1], path[i], pixelM);
  return d;
}

/** Index of the last element <= v in a sorted array (binary search). -1 if v < arr[0]. */
export function searchSorted(arr, v) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * Position on a path at time t, interpolating linearly over the parallel t_min array.
 * A repeated point (path[i] equals path[i+1]) is a work stop: the position holds still.
 * Returns { px:[x,y], i, frac, atStart, atEnd, stationary }
 *   i = segment start index (path[i] -> path[i+1]), frac in [0,1].
 *   stationary = true when the current segment has zero length (crew is working).
 */
export function interpolateOnPath(path, tMin, t) {
  const n = path.length;
  if (n === 0) return { px: [0, 0], i: 0, frac: 0, atStart: true, atEnd: true, stationary: true };
  if (n === 1 || t <= tMin[0]) return { px: [...path[0]], i: 0, frac: 0, atStart: true, atEnd: n === 1, stationary: false };
  if (t >= tMin[n - 1]) return { px: [...path[n - 1]], i: n - 2, frac: 1, atStart: false, atEnd: true, stationary: false };
  let i = clamp(searchSorted(tMin, t), 0, n - 2);
  // Skip forward past zero-duration segments so frac is well defined.
  while (i < n - 2 && tMin[i + 1] <= t && tMin[i + 1] === tMin[i]) i++;
  const span = tMin[i + 1] - tMin[i];
  const frac = span > 0 ? clamp((t - tMin[i]) / span, 0, 1) : 1;
  const a = path[i], b = path[i + 1];
  return {
    px: lerpPx(a, b, frac), i, frac, atStart: false, atEnd: false,
    stationary: a[0] === b[0] && a[1] === b[1],
  };
}

/** Interpolate any array parallel to tMin (e.g. home_min) at time t. */
export function interpolateArray(tMin, values, t) {
  const n = tMin.length;
  if (n === 0) return NaN;
  if (t <= tMin[0]) return values[0];
  if (t >= tMin[n - 1]) return values[n - 1];
  const i = clamp(searchSorted(tMin, t), 0, n - 2);
  const span = tMin[i + 1] - tMin[i];
  const f = span > 0 ? clamp((t - tMin[i]) / span, 0, 1) : 1;
  return lerp(values[i], values[i + 1], f);
}

/** Distance (m) along path at segment i + frac, using cumulative distances from cumulativeDistM. */
export function distanceAt(cumM, i, frac) {
  if (cumM.length === 0) return 0;
  if (i >= cumM.length - 1) return cumM[cumM.length - 1];
  return lerp(cumM[i], cumM[i + 1], frac);
}

/**
 * Point at distance dM (meters, clamped to [0, total]) along path.
 * Use it for "rover 100 m ahead" / "second crew 3 m behind":
 *   positionAtDistance(path, cum, distanceAt(cum, i, frac) + 100)
 * Returns { px, i, frac }.
 */
export function positionAtDistance(path, cumM, dM) {
  const n = path.length;
  if (n === 0) return { px: [0, 0], i: 0, frac: 0 };
  const total = cumM[n - 1];
  const d = clamp(dM, 0, total);
  if (n === 1 || d >= total) return { px: [...path[n - 1]], i: Math.max(0, n - 2), frac: 1 };
  let i = clamp(searchSorted(cumM, d), 0, n - 2);
  while (i < n - 2 && cumM[i + 1] === cumM[i]) i++;
  const span = cumM[i + 1] - cumM[i];
  const frac = span > 0 ? clamp((d - cumM[i]) / span, 0, 1) : 0;
  return { px: lerpPx(path[i], path[i + 1], frac), i, frac };
}

/** Index of the path vertex nearest to px. */
export function nearestPathIndex(path, px) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d = (path[i][0] - px[0]) ** 2 + (path[i][1] - px[1]) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/**
 * Compass bearing in degrees from px a to px b. 0 = north (up on the map, -y),
 * 90 = east (+x), 180 = south, 270 = west. Map-up is treated as north.
 */
export function bearingDeg(a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return 0;
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return (deg + 360) % 360;
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function cardinal(deg) {
  return CARDINALS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Minutes -> "h:mm" (e.g. 75.4 -> "1:15"; negative -> "-0:05"; null/NaN -> "--:--"). */
export function fmtMin(min) {
  if (min == null || !Number.isFinite(min)) return '--:--';
  const neg = min < 0;
  const total = Math.round(Math.abs(min));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${neg ? '-' : ''}${h}:${String(m).padStart(2, '0')}`;
}

/** Minutes -> "42 min" or "1 h 15 min". */
export function fmtMinLong(min) {
  if (min == null || !Number.isFinite(min)) return '—';
  const total = Math.round(Math.abs(min));
  const sign = min < 0 ? '-' : '';
  if (total < 60) return `${sign}${total} min`;
  const h = Math.floor(total / 60), m = total % 60;
  return `${sign}${h} h${m ? ` ${m} min` : ''}`;
}

/** Meters -> "340 m" or "4.98 km". */
export function fmtDistM(m) {
  if (m == null || !Number.isFinite(m)) return '—';
  if (Math.abs(m) < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

/** Tiny HTML escaper for modules that build markup from data strings. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Geography (real data): grid px <-> lon/lat from bounds.json corners.
// LINEAR (bilinear) interpolation between the four corners. The grid is a local
// true-scale equirectangular patch 4 km across, so the error of this
// approximation is far below a pixel. Say "approx." / "linear" in the UI.
// px here is the pipeline's continuous [x, y] (origin at the top-left image
// corner, y down): it reproduces site.json lon/lat to ~1e-6 deg.
// geo = ctx.data.geo = { nw, ne, se, sw: [lon, lat], widthPx, heightPx } or null.
// ---------------------------------------------------------------------------

/** [x, y] grid px -> [lon, lat] degrees (east-positive lon, planetocentric as in bounds.json). null if no geo. */
export function pxToLonLat(px, geo) {
  if (!geo || !px) return null;
  const u = px[0] / geo.widthPx, v = px[1] / geo.heightPx;
  const top = [lerp(geo.nw[0], geo.ne[0], u), lerp(geo.nw[1], geo.ne[1], u)];
  const bot = [lerp(geo.sw[0], geo.se[0], u), lerp(geo.sw[1], geo.se[1], u)];
  return [lerp(top[0], bot[0], v), lerp(top[1], bot[1], v)];
}

/** [lon, lat] -> [x, y] grid px (inverse of pxToLonLat; exact for an axis-aligned box, which bounds.json is). */
export function lonLatToPx(lonlat, geo) {
  if (!geo || !lonlat) return null;
  const u = (lonlat[0] - geo.nw[0]) / (geo.ne[0] - geo.nw[0]);
  const v = (lonlat[1] - geo.nw[1]) / (geo.sw[1] - geo.nw[1]);
  return [u * geo.widthPx, v * geo.heightPx];
}

/** [lon, lat] -> "18.45851° N, 77.40609° E" (digits default 5 ≈ 0.6 m on Mars). */
export function fmtLonLat(lonlat, digits = 5) {
  if (!lonlat || !lonlat.every(Number.isFinite)) return '—';
  const [lon, lat] = lonlat;
  return `${Math.abs(lat).toFixed(digits)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(digits)}° ${lon >= 0 ? 'E' : 'W'}`;
}

// ---------------------------------------------------------------------------
// Suit budget: the real budget (config.budgetMin, from safety_params.json) or the
// labelled DEMO override (state.demoBudgetMin). Every module that shows or uses a
// budget calls this instead of reading config.budgetMin directly.
// ---------------------------------------------------------------------------

export const DEMO_BUDGET_NOTE = 'DEMO SETTING, not the real suit budget';

/**
 * effectiveBudget(state, config) -> {
 *   budgetMin, reserveMin, usableMin,     // usable = budget - reserve
 *   demo: boolean,                        // true when state.demoBudgetMin overrides the real budget
 *   realBudgetMin,                        // config.budgetMin (always the real one)
 *   label,                                // "480 min suit budget" | "240 min DEMO budget"
 *   note,                                 // '' | DEMO_BUDGET_NOTE
 * }
 */
export function effectiveBudget(state, config) {
  const real = config?.budgetMin ?? 480;
  const reserveMin = config?.reserveMin ?? 30;
  const d = state?.demoBudgetMin;
  const demo = Number.isFinite(d) && d > 0 && d !== real;
  const budgetMin = demo ? d : real;
  return {
    budgetMin, reserveMin, usableMin: budgetMin - reserveMin, demo, realBudgetMin: real,
    label: demo ? `${budgetMin} min DEMO budget` : `${budgetMin} min suit budget`,
    note: demo ? DEMO_BUDGET_NOTE : '',
  };
}

/** Basis tag for a safety param / assumption: 'primary' | 'secondary' | 'assumption' | 'demo' -> short UI label. */
export function basisLabel(basis) {
  return ({ primary: 'PRIMARY', secondary: 'SECONDARY', assumption: 'ASSUMPTION', demo: 'DEMO' })[basis] || 'ASSUMPTION';
}

// Which safety_params.json keys a free-text routes.json assumption line talks about. The Engine writes
// these lines as plain text, so the match is by keyword; unmatched lines stay 'assumption'.
const ASSUMPTION_KEY_RULES = [
  [/walking speed|km\/h/i, ['walk_speed_flat_kmh']],
  [/tobler|uphill|slower on slopes/i, ['slope_speed_model']],
  [/sand/i, ['speed_factor_sand_small', 'speed_factor_sand_large']],
  [/rocky|blocky|talus/i, ['speed_factor_rocky']],
  [/slope[^.]*\b20\s*°/i, ['slope_hard_deg']],
  [/slope[^.]*\b15\s*°/i, ['slope_soft_deg']],
  [/rough/i, ['rough_hard_m']],
];
const BASIS_RANK = { assumption: 0, secondary: 1, primary: 2 };

/**
 * Basis for a routes.json assumption line, from the safety_params keys it mentions.
 * -> { basis (weakest of the matched keys, 'assumption' if none), bases: [{ basis, keys[] }] strongest first }
 */
export function assumptionBasis(text, params) {
  const keys = [];
  for (const [re, ks] of ASSUMPTION_KEY_RULES) {
    if (re.test(String(text || ''))) ks.forEach((k) => { if (params?.[k]?.basis && !keys.includes(k)) keys.push(k); });
  }
  if (!keys.length) return { basis: 'assumption', bases: [{ basis: 'assumption', keys: [] }] };
  const by = {};
  keys.forEach((k) => { const b = params[k].basis in BASIS_RANK ? params[k].basis : 'assumption'; (by[b] = by[b] || []).push(k); });
  const bases = Object.keys(by).sort((a, b) => BASIS_RANK[b] - BASIS_RANK[a]).map((b) => ({ basis: b, keys: by[b] }));
  return { basis: bases[bases.length - 1].basis, bases };
}
