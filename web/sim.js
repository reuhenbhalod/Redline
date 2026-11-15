// sim.js — sim engine. Owner: sim agent (sim.js only, no DOM, no CSS). Contract: INTERFACES.md "sim.js".
// The ONLY writer of state.sim. initSim sets a complete state.sim synchronously.
//
// Layout:
//   1. Pure core (exported, unit-tested in web/tests/sim.test.mjs): path timing, stop marks,
//      the replan rule, route surgery (slice / strip work / backtrack / concat).
//   2. initSim(ctx): mutable sim-internal state S, the step function, fault handling,
//      replan proposals, and publish() which writes one fresh state.sim object per frame.

import {
  clamp, lerp, distPx, distM, cumulativeDistM, searchSorted, interpolateOnPath, interpolateArray,
  distanceAt, positionAtDistance, bearingDeg, fmtMin, effectiveBudget,
} from './util.js';

const EPS = 1e-9;
const FAULT_KEYS = ['linkLost', 'highAir', 'storm', 'hazard'];
const HERE = '@'; // routes.json pseudo-stop: the crew's position at a checkpoint

// ===========================================================================
// 1. Pure core
// ===========================================================================

export function samePx(a, b) {
  return !!a && !!b && a[0] === b[0] && a[1] === b[1];
}

/** Position on a path at time t (planned clock). Repeated points hold still. */
export function positionAt(path, tMin, t) {
  return interpolateOnPath(path, tMin, t);
}

/** Segment index i (path[i] -> path[i+1]) that contains time t, in [0, n-2]. */
export function segmentIndexAt(tMin, t) {
  const n = tMin.length;
  if (n < 2) return 0;
  return clamp(searchSorted(tMin, t), 0, n - 2);
}

/**
 * Wall-clock minutes needed to advance the route clock from `fromT` to `toT` when walking
 * segments run at `pace` (work segments, i.e. repeated points, always run at 1x).
 */
export function pacedDuration(path, tMin, fromT, toT, pace = 1) {
  if (!(toT > fromT)) return 0;
  const p = pace > 0 ? pace : 1;
  let sum = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = Math.max(fromT, tMin[i]);
    const b = Math.min(toT, tMin[i + 1]);
    if (b <= a) continue;
    sum += samePx(path[i], path[i + 1]) ? b - a : (b - a) / p;
  }
  return sum;
}

/** Total work (stationary) minutes in a route between route times fromT and toT. */
export function workMinutes(path, tMin, fromT = -Infinity, toT = Infinity) {
  let sum = 0;
  for (let i = 0; i < path.length - 1; i++) {
    if (!samePx(path[i], path[i + 1])) continue;
    const a = Math.max(fromT, tMin[i]);
    const b = Math.min(toT, tMin[i + 1]);
    if (b > a) sum += b - a;
  }
  return sum;
}

/**
 * Find each stop of `stopIds` on `path`, in order. Returns
 * [{ id, pathIndex, departIndex, arriveMin, departMin }] where pathIndex is the first vertex at the
 * stop and departIndex the last vertex of the repeated (work) run. Matching is exact px, else the
 * nearest vertex at or after the previous stop.
 */
export function buildStopMarks(path, tMin, stopIds, stopPx) {
  const marks = [];
  let cursor = 0;
  for (const id of stopIds) {
    const px = stopPx(id);
    if (!px || !path.length) continue;
    let idx = -1;
    for (let j = cursor; j < path.length; j++) {
      if (distPx(path[j], px) <= 1.5) { idx = j; break; }
    }
    if (idx < 0) {
      let bd = Infinity;
      for (let j = cursor; j < path.length; j++) {
        const d = distPx(path[j], px);
        if (d < bd) { bd = d; idx = j; }
      }
    }
    if (idx < 0) continue;
    let dep = idx;
    while (dep + 1 < path.length && samePx(path[dep + 1], path[idx])) dep++;
    marks.push({ id, pathIndex: idx, departIndex: dep, arriveMin: tMin[idx], departMin: tMin[dep] });
    cursor = dep + 1;
  }
  return marks;
}

/**
 * The routes.json replan rule. Options are ordered planned -> skip_work -> drop -> abort.
 * Take the first option where T + minutes + reserve <= budget AND (air check) minutes * burn + reserve <= airLeft.
 * `durationOf(option)` (optional) replaces option.minutes, e.g. with the duration at the current pace.
 * If none fits, take the abort option (or null when the entry has none).
 * Returns { option, index, fits, trigger: 'schedule'|'air', rejected: [{ option, projectedReturnT, overByMin, failed }] }.
 */
export function chooseReplanOption(options, T, budgetMin, reserveMin, { burnFactor = 1, airLeftMin = Infinity, durationOf = null } = {}) {
  const rejected = [];
  let airFailed = false;
  for (let k = 0; k < (options || []).length; k++) {
    const o = options[k];
    // durationOf lets the sim stretch option minutes to the crew's actual pace (default: planned minutes)
    const d = durationOf ? durationOf(o) : o.minutes;
    const projectedReturnT = T + d;
    const timeOk = projectedReturnT + reserveMin <= budgetMin + EPS;
    const airOk = d * burnFactor + reserveMin <= airLeftMin + EPS;
    if (timeOk && airOk) {
      return { option: o, index: k, fits: true, trigger: airFailed ? 'air' : 'schedule', rejected };
    }
    if (timeOk && !airOk) airFailed = true;
    const overTime = projectedReturnT + reserveMin - budgetMin;
    const overAir = d * burnFactor + reserveMin - airLeftMin;
    rejected.push({ option: o, projectedReturnT, overByMin: Math.max(overTime, overAir), failed: timeOk ? 'air' : 'time' });
  }
  const k = (options || []).findIndex((o) => o.kind === 'abort' || o.abort === true);
  const trigger = airFailed ? 'air' : 'schedule';
  if (k >= 0) {
    return { option: options[k], index: k, fits: false, trigger, rejected: rejected.filter((r) => r.option !== options[k]) };
  }
  return { option: null, index: -1, fits: false, trigger, rejected };
}

/**
 * Replan entry for a stop: in any variant, the entry whose options[0].stops equals the stops still
 * ahead (starting with this stop); else the entry of `fallbackVariantId` at that stop; else null.
 */
export function findReplanEntry(variants, stopId, remainingStops, fallbackVariantId) {
  const eq = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
  for (const v of variants || []) {
    for (const r of v.replan || []) {
      if (r.at === stopId && eq(r.options?.[0]?.stops, remainingStops)) return { variantId: v.id, entry: r };
    }
  }
  const fb = (variants || []).find((v) => v.id === fallbackVariantId);
  const r = fb?.replan?.find((e) => e.at === stopId);
  return r ? { variantId: fb.id, entry: r } : null;
}

/** Remove work (repeated points) from a route, shifting later times earlier. */
export function stripWork(path, tMin, homeMin) {
  if (!path.length) return { path: [], tMin: [], homeMin: [] };
  const P = [path[0]], T = [tMin[0]], H = [homeMin ? homeMin[0] : 0];
  let shift = 0;
  for (let j = 1; j < path.length; j++) {
    if (samePx(path[j], path[j - 1])) { shift += tMin[j] - tMin[j - 1]; continue; }
    P.push(path[j]); T.push(tMin[j] - shift); H.push(homeMin ? homeMin[j] : 0);
  }
  return { path: P, tMin: T, homeMin: H };
}

/** The rest of a route from route time t, re-based so the first point is at time 0. */
export function sliceRouteFrom(path, tMin, homeMin, t) {
  const n = path.length;
  if (!n) return { path: [], tMin: [], homeMin: [] };
  const p = interpolateOnPath(path, tMin, t);
  const t0 = clamp(t, tMin[0], tMin[n - 1]);
  const P = [p.px], T = [0], H = [homeMin ? interpolateArray(tMin, homeMin, t0) : 0];
  if (p.atEnd) return { path: P, tMin: T, homeMin: H };
  for (let j = p.atStart ? 1 : p.i + 1; j < n; j++) {
    if (j === p.i + 1 && distPx(path[j], p.px) < 1e-6 && !samePx(path[p.i], path[j])) continue;
    P.push(path[j]); T.push(Math.max(0, tMin[j] - t0)); H.push(homeMin ? homeMin[j] : 0);
  }
  return { path: P, tMin: T, homeMin: H };
}

/**
 * Walk back along a route from route time t to vertex `toIndex` (e.g. the last stop's depart
 * vertex), reusing the planned walking time of each segment (work is skipped). Time starts at 0.
 */
export function backtrackRoute(path, tMin, homeMin, t, toIndex) {
  const n = path.length;
  if (!n) return { path: [], tMin: [], homeMin: [] };
  const p = interpolateOnPath(path, tMin, t);
  const tc = clamp(t, tMin[0], tMin[n - 1]);
  const P = [p.px], T = [0], H = [homeMin ? interpolateArray(tMin, homeMin, tc) : 0];
  let acc = 0;
  let prevPx = p.px, prevT = tc;
  for (let j = Math.min(p.atEnd ? n - 1 : p.i, n - 1); j >= toIndex; j--) {
    if (samePx(path[j], prevPx)) { prevT = tMin[j]; continue; }
    acc += Math.max(0, prevT - tMin[j]);
    P.push(path[j]); T.push(acc); H.push(homeMin ? homeMin[j] : 0);
    prevPx = path[j]; prevT = tMin[j];
  }
  return { path: P, tMin: T, homeMin: H };
}

/** Concatenate two re-based routes; b's times are offset by a's end, a duplicate joint is dropped. */
export function concatRoutes(a, b) {
  if (!a.path.length) return b;
  if (!b.path.length) return a;
  const off = a.tMin[a.tMin.length - 1];
  const skip = samePx(a.path[a.path.length - 1], b.path[0]) ? 1 : 0;
  return {
    path: [...a.path, ...b.path.slice(skip)],
    tMin: [...a.tMin, ...b.tMin.slice(skip).map((x) => x + off)],
    homeMin: [...a.homeMin, ...b.homeMin.slice(skip)],
  };
}

/**
 * Turn-around rule: air left <= air for the walk home + reserve + margin.
 * Pass the walk home as AIR minutes (time home x burn rate / pace), see homeAirMin().
 */
export function turnaroundDue(airLeftMin, homeAirMin, reserveMin, marginMin) {
  if (!Number.isFinite(homeAirMin)) return false;
  return airLeftMin <= homeAirMin + reserveMin + marginMin;
}

/** Air (minutes of suit budget) the walk home uses: planned walk minutes stretched by pace, times burn rate. */
export function homeAirMin(timeHomeMin, burnFactor = 1, pace = 1) {
  return timeHomeMin * (burnFactor || 1) / (pace > 0 ? pace : 1);
}

/** Air level from the margin (left - home - reserve). */
export function airLevel(marginMin, turnaroundMarginMin) {
  if (!Number.isFinite(marginMin)) return 'warn';
  if (marginMin <= turnaroundMarginMin) return 'danger';
  if (marginMin < 2 * turnaroundMarginMin) return 'warn';
  return 'ok';
}

/** Point `backM` meters behind `px` along the polyline `trail` (walked backwards from its end). */
export function pointBehind(trail, px, backM, pixelM) {
  let need = backM / pixelM;
  let cur = px;
  for (let j = trail.length - 1; j >= 0 && need > 0; j--) {
    const d = distPx(cur, trail[j]);
    if (d < 1e-9) continue;
    if (d >= need) return [lerp(cur[0], trail[j][0], need / d), lerp(cur[1], trail[j][1], need / d)];
    need -= d;
    cur = trail[j];
  }
  return [...cur];
}

// ===========================================================================
// 2. Sim engine
// ===========================================================================

export function initSim(ctx) {
  const { data, config } = ctx;
  const variants = data.routes.variants;
  const pixelM = config.pixelM;
  const H_ID = data.stopsById.H ? 'H' : (variants[0].stops?.[0] ?? 'H');
  const stopPx = (id) => data.stopsById[id]?.px ?? data.routes.stops_px?.[id] ?? null;
  const stopName = (id) => data.stopsById[id]?.name ?? id;
  const homePx = stopPx(H_ID) ?? variants[0].path[0];
  const cumCache = new WeakMap();
  const cumOf = (a) => {
    let c = cumCache.get(a);
    if (!c) { c = cumulativeDistM(a.path, pixelM); cumCache.set(a, c); }
    return c;
  };

  let S = null;          // sim-internal mutable state (arrays inside are replaced, never mutated)
  let alertSeq = 0;
  let homeCache = { key: '', path: null };

  // Timeline of what the user did since the last hard reset, so seek() can replay it:
  //   { t, type: 'inputs', faults, slowPace }  fault / pace toggles at sim time t
  //   { t, type: 'confirm', trigger, atStopId, kind }  a confirmed reroute
  let timeline = [];
  let baseInputs = null;   // inputs in force at the hard reset (t = 0)
  let replay = null;       // inputs override while seek() replays the timeline
  let lastInputs = null;   // inputs the engine is currently running on

  // ---------------------------------------------------------------- helpers
  const st = () => ctx.getState();
  // Suit budget in force: the real one (config) or the labelled DEMO override (state.demoBudgetMin).
  const bud = () => effectiveBudget(st(), config);
  const stateInputs = () => ({ faults: { ...(st().faults || {}) }, slowPace: !!st().slowPace });
  const inputs = () => replay || stateInputs();
  const sameInputs = (a, b) => !!a && !!b && a.slowPace === b.slowPace
    && FAULT_KEYS.every((k) => !!a.faults?.[k] === !!b.faults?.[k]);
  const paceFactor = () => (inputs().slowPace ? config.slowPaceFactor : 1);
  const burnFactor = () => (inputs().faults?.highAir ? config.highAirBurnFactor : 1);
  const finished = () => S.status === 'done' || S.status === 'aborted';
  const isReturnKind = (k) => k === 'abort' || k === 'return';

  function variantLabel(v) {
    const base = v.label || (v.id === 'full' ? 'Full plan' : `Plan ${v.id}`);
    return `${base} ${(v.stops || []).join('→')}`;
  }

  function makeActive({ id, kind, label, variantId, stops, path, tMin, homeMin, why, distanceM }) {
    const stopMarks = buildStopMarks(path, tMin, stops, stopPx);
    return {
      id, kind, label, variantId, stops, path, tMin, homeMin, why: why || [],
      distanceM: distanceM ?? cumulativeDistM(path, pixelM)[path.length - 1] ?? 0,
      stopMarks,
    };
  }

  function activeFromVariant(v) {
    return makeActive({
      id: v.id, kind: 'planned', label: variantLabel(v), variantId: v.id, stops: v.stops,
      path: v.path, tMin: v.t_min, homeMin: v.home_min, why: v.why, distanceM: v.distance_m,
    });
  }

  function plannedVariant() {
    return data.variantsById[S?.plannedVariantId] || data.variantsById[st().plannedVariantId] || variants[0];
  }

  // Planned arrival at a stop mark of the ACTIVE route, on the route clock (S.routeT). Before any
  // reroute this is the variant's stop_plan time; after one it is the new route's plan (rebased at
  // the switch), so "planned" and "behind" (S.t - S.routeT) always use the same clock.
  function plannedArriveFor(mark) {
    if (!mark || isReturnKind(S.active.kind)) return null;
    return Number.isFinite(mark.arriveMin) ? mark.arriveMin : null;
  }

  function freshState(variantId) {
    const v = data.variantsById[variantId] || variants[0];
    const active = activeFromVariant(v);
    return withQueues({
      plannedVariantId: v.id,
      t: 0, routeT: 0, status: 'idle', headingDeg: 0,
      active, markIdx: active.stopMarks.length > 1 ? 1 : 0,
      trail: [[...active.path[0]]],
      visited: [], dropped: [], replans: [], alerts: [],
      pending: null, pendingRoute: null, pendingMarkIdx: 0,
      usedMin: 0, turnaround: false, airOutAlerted: false,
      link: { ok: true, lostSinceT: null, linkAlertId: null },
      storm: { on: false, alertId: null, handled: false, holdAlerted: false },
      cpQueue: [],                       // upcoming mid-leg checkpoints on the active route
      hazard: { armed: false, at: null, demo: null, variantId: null, seen: null, done: false },
      seeking: false,
    });
  }

  // ------------------------------------------------- checkpoints / hazard
  const sameIds = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

  /** Stops still ahead on route `a` after route time t (by arrival). */
  function stopsAheadAt(a, t) {
    return a.stopMarks.filter((m) => m.arriveMin > t + EPS).map((m) => m.id);
  }

  /**
   * Map routes.json checkpoints onto the active route. A checkpoint applies where its segment
   * (variant path[i] -> path[i+1]) appears on the active route and the stops it plans for are the
   * stops still ahead there. Option routes reuse the same leg vertices, so this keeps working
   * after a reroute (e.g. skip the work at A). One checkpoint per CHECKPOINT window.
   */
  function checkpointQueue(st0) {
    const a = st0.active;
    if (isReturnKind(a.kind)) return [];
    const found = [];
    const order = [a.variantId, ...variants.map((v) => v.id).filter((id) => id !== a.variantId)];
    for (const vid of order) {
      const v = data.variantsById[vid];
      for (const c of v?.checkpoints || []) {
        const i = c.path_index, P = v.path, T = v.t_min;
        if (!P[i + 1] || !(T[i + 1] > T[i])) continue;
        for (let j = 0; j < a.path.length - 1; j++) {
          if (!samePx(a.path[j], P[i]) || !samePx(a.path[j + 1], P[i + 1])) continue;
          const f = (c.t_min - T[i]) / (T[i + 1] - T[i]);
          const at = a.tMin[j] + f * (a.tMin[j + 1] - a.tMin[j]);
          if (at <= st0.routeT + EPS) break;
          const want = (c.options?.[0]?.stops || []).filter((x) => x !== HERE);
          if (!sameIds(want, stopsAheadAt(a, at))) break;
          if (found.some((q) => Math.abs(q.at - at) < 5)) break;
          found.push({ at, cp: c, variantId: vid });
          break;
        }
      }
    }
    return found.sort((x, y) => x.at - y.at);
  }

  /** Where the scripted rover-camera hazard triggers on the active route, or null. */
  function hazardOnRoute(st0) {
    const a = st0.active;
    if (isReturnKind(a.kind)) return null;
    for (const v of variants) {
      const d = v.hazard_demo;
      if (!d) continue;
      const ahead = stopsAheadAt(a, st0.routeT);
      if (!ahead.includes(d.leg[1])) continue;
      // only on that leg: after leaving leg[0] (if it is still on this route) and before reaching
      // leg[1]. Routes can retrace earlier legs, so the trigger pixel may also appear before.
      const end = a.stopMarks.find((m) => m.id === d.leg[1] && m.arriveMin > st0.routeT + EPS);
      const start = a.stopMarks.filter((m) => m.id === d.leg[0] && end && m.departMin <= end.arriveMin).pop();
      const fromT = Math.max(st0.routeT + EPS, start ? start.departMin : -Infinity);
      for (let j = 0; j < a.path.length; j++) {
        if (a.tMin[j] < fromT || (end && j > end.pathIndex)) continue;
        if (samePx(a.path[j], d.trigger_px)) return { at: a.tMin[j], demo: d, variantId: v.id };
      }
    }
    return null;
  }

  /** Recompute the checkpoint queue and the hazard trigger for the current active route. */
  function withQueues(st0) {
    st0.cpQueue = checkpointQueue(st0);
    if (st0.hazard.armed && !st0.hazard.done) {
      const h = hazardOnRoute(st0);
      st0.hazard = { ...st0.hazard, at: h?.at ?? null, demo: h?.demo ?? null, variantId: h?.variantId ?? null };
    }
    return st0;
  }

  function pushAlert(a) {
    const al = { id: `al${++alertSeq}`, t: S.t, level: 'info', kind: 'info', title: '', text: '', active: false, ...a };
    S.alerts = [...S.alerts, al].slice(-30);
    ctx.emit('alert', S.seeking ? { ...al, toast: false } : al);
    return al.id;
  }
  function deactivateAlerts(pred) {
    if (!S.alerts.some((a) => a.active && pred(a))) return;
    S.alerts = S.alerts.map((a) => (a.active && pred(a) ? { ...a, active: false } : a));
  }

  // --------------------------------------------------------- position / air
  function locate() {
    const a = S.active;
    const p = interpolateOnPath(a.path, a.tMin, S.routeT);
    const cum = cumOf(a);
    const along = p.atEnd ? cum[cum.length - 1] : distanceAt(cum, p.i, p.frac);
    return { p, cum, along, total: cum[cum.length - 1] || 0 };
  }

  function driftOffsetPx(crewIdx) {
    if (S.link.ok || S.link.lostSinceT == null) return [0, 0];
    const el = Math.max(0, S.t - S.link.lostSinceT);
    const ang = ((S.link.lostSinceT * 137.508 + 40 + crewIdx * 23) % 360) * Math.PI / 180;
    const r = (config.drDriftMPerMin * el) / pixelM;
    return [Math.cos(ang) * r, Math.sin(ang) * r];
  }
  function uncertaintyM() {
    if (S.link.ok || S.link.lostSinceT == null) return config.posErrM;
    return config.posErrM + config.drGrowthMPerMin * Math.max(0, S.t - S.link.lostSinceT);
  }
  function displayedPx(truePx, crewIdx) {
    const o = driftOffsetPx(crewIdx);
    return [truePx[0] + o[0], truePx[1] + o[1]];
  }

  function timeHomeFrom(px) {
    const g = ctx.timeHomeAt(px);
    if (g != null && Number.isFinite(g)) return { min: g, source: 'grid' };
    const a = S.active;
    const r = interpolateArray(a.tMin, a.homeMin, S.routeT);
    if (Number.isFinite(r)) return { min: r, source: 'route' };
    return { min: NaN, source: 'none' };
  }

  /** Planned walking minutes of the way home the sim would actually send the crew on right now. */
  function wayHomeMin() {
    if (finished()) return 0;
    const a = S.active;
    if (isReturnKind(a.kind) || alreadyHeadingHome()) {
      return Math.max(0, (a.tMin[a.tMin.length - 1] ?? 0) - S.routeT - workMinutes(a.path, a.tMin, S.routeT));
    }
    return bestReturn().minutes;
  }

  function airNow(ev1px) {
    const leftMin = bud().budgetMin - S.usedMin;
    const th = timeHomeFrom(ev1px);
    // The walk home is the slower of the time-home grid (best case from this spot) and the way
    // home the sim can actually route (backtrack / abort route). It burns air at the current
    // burn rate and takes longer at a slow pace.
    const way = wayHomeMin();
    const walkHome = Number.isFinite(th.min) ? Math.max(th.min, way) : way;
    const homeAir = homeAirMin(walkHome, burnFactor(), paceFactor());
    const neededMin = homeAir + bud().reserveMin;
    const marginMin = leftMin - neededMin;
    return { leftMin, timeHomeMin: th.min, timeHomeSource: th.source, wayHomeMin: way, homeAirMin: homeAir, neededMin, marginMin };
  }

  function pushTrail(px, force = false) {
    const last = S.trail[S.trail.length - 1];
    if (force ? !samePx(last, px) : distPx(last, px) >= 5) S.trail = [...S.trail, [px[0], px[1]]];
  }

  // ---------------------------------------------------------- route options
  /** Stop mark the crew is standing at right now (arrived, not yet departed), or null. */
  function currentStopMark() {
    const a = S.active;
    for (let k = S.markIdx - 1; k >= 0; k--) {
      const m = a.stopMarks[k];
      if (m && S.routeT >= m.arriveMin - EPS && S.routeT <= m.departMin + EPS) return m;
    }
    if (S.routeT <= EPS && a.stopMarks[0]?.pathIndex === 0) return a.stopMarks[0];
    return null;
  }

  function remainingStopIds() {
    return S.active.stopMarks.slice(S.markIdx).map((m) => m.id);
  }

  function rebase(r) {
    return { path: r.path, tMin: r.tMin.map((x) => x + S.routeT), homeMin: r.homeMin };
  }

  function abortOptionAt(stopId, remaining) {
    const hit = findReplanEntry(variants, stopId, [stopId, ...remaining], S.active.variantId);
    const opt = hit?.entry.options.find((o) => o.kind === 'abort' || o.abort === true);
    return opt ? { opt, variantId: hit.variantId } : null;
  }

  /**
   * Best way home from the crew's current spot (re-based to time 0).
   * Returns { route, stops, why, label, via }.
   */
  function bestReturn() {
    const a = S.active;
    const remaining = remainingStopIds();
    const stopsAhead = remaining.filter((id) => id !== H_ID);
    // (a) the rest of the active route with remaining work removed
    const slice = sliceRouteFrom(a.path, a.tMin, a.homeMin, S.routeT);
    const candA = stripWork(slice.path, slice.tMin, slice.homeMin);
    const minA = candA.tMin[candA.tMin.length - 1] ?? 0;
    const at = currentStopMark();
    if (at && at.id !== H_ID) {
      const ab = abortOptionAt(at.id, remaining);
      if (ab) {
        const r = { path: ab.opt.path, tMin: ab.opt.t_min, homeMin: ab.opt.home_min };
        return {
          route: r, stops: ab.opt.stops.slice(1), minutes: ab.opt.minutes, via: 'abort',
          label: `head home from ${stopName(at.id)}`,
          why: [`At ${stopName(at.id)}: use the precomputed abort route home (${fmtMin(ab.opt.minutes)} walk)`, ...(ab.opt.why || []).slice(1)],
        };
      }
      return {
        route: candA, stops: remaining, minutes: minA, via: 'remainder',
        label: `skip the remaining work, head home from ${stopName(at.id)}`,
        why: [`At ${stopName(at.id)}: skip the remaining work and walk the planned way home (${fmtMin(minA)})`],
      };
    }
    // (b) back along the walked path to the last stop, then that stop's abort route (or nothing at H)
    const lastMark = [...a.stopMarks.slice(0, S.markIdx)].reverse().find((m) => m.arriveMin <= S.routeT + EPS) || null;
    let candB = null, minB = Infinity, lastId = null;
    if (lastMark) {
      lastId = lastMark.id;
      const back = backtrackRoute(a.path, a.tMin, a.homeMin, S.routeT, lastMark.departIndex);
      if (lastId === H_ID) {
        candB = back;
      } else {
        const ab = abortOptionAt(lastId, [...remaining]);
        if (ab) candB = concatRoutes(back, { path: ab.opt.path, tMin: ab.opt.t_min, homeMin: ab.opt.home_min });
      }
      if (candB) minB = candB.tMin[candB.tMin.length - 1];
    }
    if (candB && minB < minA - EPS) {
      return {
        route: candB, stops: [H_ID], minutes: minB, via: 'backtrack',
        label: lastId === H_ID ? `back to ${stopName(H_ID)}` : `back via ${stopName(lastId)}`,
        why: [
          `Back the way you came${lastId === H_ID ? '' : ` to ${stopName(lastId)}, then its abort route`}: ${fmtMin(minB)} walk`,
          `Pressing on${stopsAhead.length ? ` via ${stopsAhead.map(stopName).join(', ')}` : ''} would take ${fmtMin(minA)}`,
        ],
      };
    }
    return {
      route: candA, stops: remaining, minutes: minA, via: 'remainder',
      label: stopsAhead.length ? `press on home via ${stopsAhead.map(stopName).join(', ')} (no work)` : 'continue straight home',
      why: [
        `Pressing on${stopsAhead.length ? ` via ${stopsAhead.map(stopName).join(', ')} without work` : ''}: ${fmtMin(minA)} walk`,
        ...(candB ? [`Turning back${lastId ? ` via ${stopName(lastId)}` : ''} would take ${fmtMin(minB)}`] : []),
      ],
    };
  }

  /** True when the rest of the active route is already a work-free walk straight home. */
  function alreadyHeadingHome() {
    const rem = remainingStopIds().filter((id) => id !== H_ID);
    return rem.length === 0 && workMinutes(S.active.path, S.active.tMin, S.routeT) < EPS;
  }

  /**
   * Safety projection for a route option, at the crew's CURRENT pace and burn rate.
   * withinBudget is false when the option eats into the reserve; airRunsOut when air hits 0 first.
   */
  function safetyFor(minutesPlanned, routeForPace) {
    const pace = paceFactor();
    const burn = burnFactor();
    const plannedReturnT = S.t + minutesPlanned;
    const pacedMin = routeForPace && pace !== 1
      ? pacedDuration(routeForPace.path, routeForPace.tMin, routeForPace.tMin[0], routeForPace.tMin[routeForPace.tMin.length - 1], pace)
      : minutesPlanned;
    const projectedReturnT = S.t + pacedMin;
    const leftMin = bud().budgetMin - S.usedMin;
    const airLeftAtReturnMin = leftMin - pacedMin * burn;
    const marginMin = bud().budgetMin - bud().reserveMin - projectedReturnT;
    const spare = Math.min(marginMin, airLeftAtReturnMin - bud().reserveMin);
    const withinBudget = spare >= -0.5;
    const airRunsOut = airLeftAtReturnMin < 0;
    let text;
    if (withinBudget) {
      text = `Back by ${fmtMin(projectedReturnT)} with ${Math.max(0, Math.round(spare))} min of air to spare (${bud().reserveMin} min reserve kept)`;
    } else if (airRunsOut) {
      text = `NOT within budget: back by ${fmtMin(projectedReturnT)}, but air runs out about ${Math.round(-airLeftAtReturnMin)} min before reaching home, even using the whole ${bud().reserveMin} min reserve. Best option left: go now`;
    } else {
      text = `NOT within budget: back by ${fmtMin(projectedReturnT)}, ${Math.round(-spare)} min into the ${bud().reserveMin} min reserve. Best option left`;
    }
    if (pace < 1) text += `. Times are at the current slow pace (${pace}x)`;
    if (burn > 1) text += `. Air use is ${burn}x planned`;
    const B = bud();
    if (B.demo) text += `. Against the ${B.budgetMin} min demo budget (${B.note}; real ${B.realBudgetMin} min)`;
    return {
      projectedReturnT, plannedReturnT, pacedReturnT: projectedReturnT, budgetMin: bud().budgetMin, reserveMin: bud().reserveMin,
      marginMin, airLeftAtReturnMin, spareMin: spare, withinBudget, airRunsOut, text,
    };
  }

  function optionLabel(opt, stopId, entry) {
    const name = stopName(stopId);
    switch (opt.kind) {
      case 'planned': return 'Continue as planned';
      case 'skip_work': {
        const w = entry?.options?.[0]?.work_here_min || data.stopsById[stopId]?.work_min || 0;
        return `Skip the ${Math.round(w)}-min work at ${name}`;
      }
      case 'drop': {
        const all = entry?.options?.[0]?.stops || [];
        const gone = all.filter((s) => !opt.stops.includes(s));
        return `Drop ${gone.map(stopName).join(', ') || 'a stop'}`;
      }
      case 'abort': return `Abort: home from ${name}`;
      default: return opt.label || opt.kind;
    }
  }

  function setPending(p, route, routeMarkIdx) {
    if (S.pending) {
      // a newer proposal replaces an unconfirmed one
      deactivateAlerts((a) => a.kind === 'replan');
    }
    S.pending = p;
    S.pendingRoute = route;
    S.pendingMarkIdx = routeMarkIdx;
    S.replans = [...S.replans, { id: p.id, t: S.t, atStopId: p.atStopId, kind: p.kind, label: p.label, confirmedT: null, trigger: p.trigger }];
    S.status = 'awaiting_confirm';
    ctx.emit('replan:proposed', p);
    pushAlert({
      level: p.trigger === 'schedule' ? 'warn' : 'danger', kind: 'replan', active: true,
      title: `Reroute proposed: ${p.label}`,
      text: `${p.behindMin >= 0.5 ? `${Math.round(p.behindMin)} min behind. ` : ''}${p.safety.text}. Confirm to switch.`,
    });
    if (st().playing) ctx.setState({ playing: false });
  }

  /**
   * Replan options measured against the ACTIVE route: "planned" becomes the rest of the active
   * route (which may already skip some work), and options that would not save at least half a
   * minute over it are dropped, so the same reroute is never proposed twice.
   */
  function optionsVsActive(options) {
    const a = S.active;
    const rest = sliceRouteFrom(a.path, a.tMin, a.homeMin, S.routeT);
    const restMin = (a.tMin[a.tMin.length - 1] ?? 0) - S.routeT;
    const planned = {
      ...options[0], minutes: restMin, path: rest.path, t_min: rest.tMin, home_min: rest.homeMin, activeRest: true,
    };
    return [planned, ...options.slice(1).filter((o) => o.abort || o.minutes < restMin - 0.5)];
  }

  function chooseNow(options) {
    const pace = paceFactor();
    const durationOf = pace === 1 ? null
      : (o) => pacedDuration(o.path, o.t_min, o.t_min[0], o.t_min[o.t_min.length - 1], pace);
    return chooseReplanOption(options, S.t, bud().budgetMin, bud().reserveMin, {
      burnFactor: burnFactor(), airLeftMin: bud().budgetMin - S.usedMin, durationOf,
    });
  }

  function checkpointLabel(o, options) {
    switch (o.kind) {
      case 'skip_work': {
        const w = data.stopsById[o.skip_at]?.work_min || 0;
        return `Skip the ${Math.round(w)}-min work at ${stopName(o.skip_at)}`;
      }
      case 'drop': {
        const gone = (options[0]?.stops || []).filter((x) => x !== HERE && !o.stops.includes(x));
        return `Drop ${gone.map(stopName).join(', ') || 'a stop'}`;
      }
      case 'abort': return 'Abort: head home from here';
      default: return o.kind;
    }
  }

  /** Mid-leg checkpoint: apply the replan rule from the crew's position. */
  function checkpointReached(q) {
    if (isReturnKind(S.active.kind) || S.storm.on || S.pending) return;
    const options = optionsVsActive(q.cp.options);
    const choice = chooseNow(options);
    if (!choice.option || choice.option.activeRest) return;
    const o = choice.option;
    const pace = paceFactor();
    const label = checkpointLabel(o, options);
    const why = [...(o.why || [])];
    if (!choice.fits) why.unshift('No option fits the budget with the reserve kept, so the rule falls back to abort');
    else if (choice.trigger === 'air') why.unshift('Air use is higher than planned: the longer options would eat into the reserve');
    else why.unshift('Behind schedule mid-leg: the rest of the plan no longer fits with the reserve kept');
    if (pace !== 1) why.push(`Option times stretched to the current pace (${pace}x walking speed)`);
    const route = { path: o.path, tMin: o.t_min, homeMin: o.home_min };
    const reb = rebase(route);
    const stops = o.stops.filter((x) => x !== HERE);
    const p = {
      id: `cp@${S.t.toFixed(1)}`, trigger: choice.trigger, atStopId: null, atStopName: 'mid-leg', checkpoint: true,
      arrivedT: S.t, plannedArriveT: null, behindMin: Math.max(0, S.t - S.routeT),
      kind: o.kind, label, option: o, minutes: o.minutes, savesMin: Math.max(0, options[0].minutes - o.minutes),
      why, path: o.path, safety: safetyFor(o.minutes, reb),
      rejected: choice.rejected.map((r) => ({
        kind: r.option.kind, label: r.option.activeRest ? 'Continue as planned' : checkpointLabel(r.option, options),
        projectedReturnT: r.projectedReturnT, overByMin: r.overByMin, failed: r.failed,
      })),
    };
    const act = makeActive({
      id: `${q.variantId}@cp${Math.round(q.cp.t_min)}:${o.kind}`, kind: o.kind, label, variantId: q.variantId, stops,
      path: reb.path, tMin: reb.tMin, homeMin: reb.homeMin, why, distanceM: o.distance_m,
    });
    setPending(p, act, 0);
  }

  /** The rover camera confirms the scripted rock field: propose the precomputed detour. */
  function hazardReached() {
    const hz = S.hazard;
    const d = hz.demo;
    S.hazard = { ...hz, done: true, at: null, seen: { px: d.hazard_px, radiusPx: d.radius_px, t: S.t, leg: d.leg } };
    const a = S.active;
    const mark = a.stopMarks.slice(S.markIdx).find((m) => m.id === d.leg[1]);
    if (!mark) return;
    const detour = { path: d.path, tMin: d.t_min, homeMin: d.home_min };
    const rest = sliceRouteFrom(a.path, a.tMin, a.homeMin, mark.arriveMin);
    const route = concatRoutes(detour, rest);
    const reb = rebase(route);
    const minutes = route.tMin[route.tMin.length - 1] ?? 0;
    const restMin = (a.tMin[a.tMin.length - 1] ?? 0) - S.routeT;
    const label = `Rock field ahead: detour to ${stopName(d.leg[1])}`;
    const why = [...(d.why || [])];
    pushAlert({
      level: 'danger', kind: 'hazard', active: false, title: 'Rover camera: rock field ahead',
      text: `Confirmed in 3 frames, its edge about ${Math.round(Math.max(0, distPx(locate().p.px, d.hazard_px) - d.radius_px) * pixelM)} m ahead. Detour proposed.`,
    });
    const p = {
      id: `hazard@${S.t.toFixed(1)}`, trigger: 'hazard', atStopId: null, atStopName: 'mid-leg',
      arrivedT: S.t, plannedArriveT: null, behindMin: Math.max(0, S.t - S.routeT),
      kind: 'hazard', label, option: { kind: 'hazard', stops: stopsAheadAt(a, S.routeT), minutes, path: route.path },
      minutes, savesMin: Math.min(0, restMin - minutes), why, path: route.path,
      safety: safetyFor(minutes, reb), rejected: [], hazard: S.hazard.seen,
    };
    const act = makeActive({
      id: `${a.id}>hazard`, kind: 'hazard', label, variantId: a.variantId, stops: stopsAheadAt(a, S.routeT),
      path: reb.path, tMin: reb.tMin, homeMin: reb.homeMin, why,
    });
    setPending(p, act, 0);
  }

  // ------------------------------------------------------- arrival / replan
  function arrive(mark) {
    S.routeT = mark.arriveMin;
    S.markIdx += 1;
    pushTrail(S.active.path[mark.pathIndex], true);
    S.visited = [...S.visited, mark.id];
    const isFinal = S.markIdx >= S.active.stopMarks.length;
    if (isFinal) {
      const aborted = isReturnKind(S.active.kind);
      S.status = aborted ? 'aborted' : 'done';
      deactivateAlerts((a) => a.kind === 'air' || a.kind === 'storm' || a.kind === 'replan');
      const left = bud().budgetMin - S.usedMin;
      const intoReserve = left < bud().reserveMin - 0.5;
      const ranOut = left < 0;
      pushAlert({
        level: ranOut ? 'danger' : (aborted || intoReserve) ? 'warn' : 'ok', kind: 'done',
        title: `Back at ${stopName(mark.id)}: walk ${aborted ? 'aborted' : 'complete'}${ranOut ? ', AIR BUDGET OVERRUN' : intoReserve ? ', reserve used' : ''}`,
        text: `T+${fmtMin(S.t)}, air left ${Math.round(left)} min`
          + (ranOut ? ` (${Math.round(-left)} min past the budget)` : intoReserve ? ` (${Math.round(bud().reserveMin - left)} min into the ${bud().reserveMin} min reserve)` : ''),
      });
      if (st().playing) ctx.setState({ playing: false });
      return;
    }
    const planned = plannedArriveFor(mark);
    const behind = Math.max(0, S.t - S.routeT);
    pushAlert({
      level: 'info', kind: 'arrive', title: `Arrived at ${stopName(mark.id)}`,
      text: `T+${fmtMin(S.t)}${planned != null ? ` (planned ${fmtMin(planned)})` : ''}${behind >= 0.5 ? `, ${Math.round(behind)} min behind` : ''}`,
    });
    if (isReturnKind(S.active.kind)) return;

    // ---- the replan rule
    const remaining = [mark.id, ...remainingStopIds()];
    const hit = findReplanEntry(variants, mark.id, remaining, S.active.variantId);
    if (!hit) return;
    const pace = paceFactor();
    // the rule is applied to the time each option really takes at the crew's current pace, and
    // measured against the route the crew is actually on (it may already skip this stop's work)
    const choice = chooseNow(optionsVsActive(hit.entry.options));
    const rejected = choice.rejected.map((r) => ({
      kind: r.option.kind, label: optionLabel(r.option, mark.id, hit.entry),
      projectedReturnT: r.projectedReturnT, overByMin: r.overByMin, failed: r.failed,
    }));
    const pid = `${mark.id}@${S.t.toFixed(1)}`;
    if (choice.option && (choice.option.kind === 'planned' || choice.option.activeRest)) {
      S.replans = [...S.replans, { id: pid, t: S.t, atStopId: mark.id, kind: 'planned', label: 'Continue as planned', confirmedT: S.t, trigger: 'schedule' }];
      return;
    }
    let route, kind, label, why, option, minutes, savesMin, stops, routeId;
    if (choice.option) {
      option = choice.option;
      kind = option.kind;
      label = optionLabel(option, mark.id, hit.entry);
      why = option.why || [];
      minutes = option.minutes;
      savesMin = option.saves_min ?? 0;
      stops = option.stops;
      route = { path: option.path, tMin: option.t_min, homeMin: option.home_min };
      routeId = `${hit.variantId}@${mark.id}:${kind}`;
    } else {
      // nothing fits and the entry has no abort option: synthesize "skip the work and go home"
      const b = bestReturn();
      option = { kind: 'abort', stops: [mark.id, ...b.stops], minutes: b.minutes, saves_min: Math.max(0, (hit.entry.options[0]?.minutes ?? b.minutes) - b.minutes), path: b.route.path, t_min: b.route.tMin, home_min: b.route.homeMin, abort: true, why: b.why, synthesized: true };
      kind = 'abort'; label = `Abort: ${b.label}`; why = b.why; minutes = b.minutes; savesMin = option.saves_min;
      stops = option.stops; route = b.route; routeId = `${hit.variantId}@${mark.id}:abort`;
    }
    const why2 = [...why];
    if (!choice.fits) why2.unshift('No option fits the budget with the reserve kept, so the rule falls back to abort');
    else if (choice.trigger === 'air') why2.unshift('Air use is higher than planned: the longer options would eat into the reserve');
    if (pace !== 1) why2.push(`Option times stretched to the current pace (${pace}x walking speed)`);
    const reb = rebase(route);
    const p = {
      id: pid, trigger: choice.trigger, atStopId: mark.id, atStopName: stopName(mark.id),
      arrivedT: S.t, plannedArriveT: planned, behindMin: behind,
      kind, label, option, minutes, savesMin, why: why2, path: route.path,
      safety: safetyFor(minutes, reb), rejected,
    };
    const act = makeActive({
      id: routeId, kind, label, variantId: hit.variantId, stops,
      path: reb.path, tMin: reb.tMin, homeMin: reb.homeMin, why: why2, distanceM: option.distance_m,
    });
    setPending(p, act, act.stopMarks.length > 1 ? 1 : 0);
  }

  /** Turn-around (trigger 'air') or storm (trigger 'storm') return proposal. */
  function proposeReturn(trigger) {
    const isStorm = trigger === 'storm';
    if (alreadyHeadingHome()) {
      // the rest of the route already is the way home: no reroute to confirm
      if (isStorm && !isReturnKind(S.active.kind)) {
        S.active = { ...S.active, kind: 'abort', label: 'Storm: straight home', id: `${S.active.id}>home` };
        S.status = 'returning';
      }
      return false;
    }
    const b = bestReturn();
    const reb = rebase(b.route);
    const kind = isStorm ? 'abort' : 'return';
    const at = currentStopMark();
    const why = [
      isStorm ? 'Dust / solar storm: walk aborted, shortest safe way home' : 'Air for the walk home is getting short: turn around now',
      ...b.why,
    ];
    const label = isStorm ? `Storm: ${b.label}` : `Turn around: ${b.label}`;
    const remainingPlanned = pacedDuration(S.active.path, S.active.tMin, S.routeT, S.active.tMin[S.active.tMin.length - 1], 1);
    const option = {
      kind, stops: b.stops, work_here_min: 0, minutes: b.minutes, saves_min: Math.max(0, remainingPlanned - b.minutes),
      path: b.route.path, t_min: b.route.tMin, home_min: b.route.homeMin, abort: true, why, synthesized: true,
    };
    const p = {
      id: `${trigger}@${S.t.toFixed(1)}`, trigger, atStopId: at ? at.id : null,
      atStopName: at ? stopName(at.id) : 'mid-leg', arrivedT: S.t,
      plannedArriveT: at ? plannedArriveFor(at) : null, behindMin: Math.max(0, S.t - S.routeT),
      kind, label, option, minutes: b.minutes, savesMin: option.saves_min, why, path: b.route.path,
      safety: safetyFor(b.minutes, reb), rejected: [],
    };
    const act = makeActive({
      id: `return@${S.t.toFixed(1)}`, kind, label, variantId: S.active.variantId, stops: b.stops,
      path: reb.path, tMin: reb.tMin, homeMin: reb.homeMin, why,
    });
    setPending(p, act, 0);
    return true;
  }

  function confirm(id) {
    if (!S.pending || (id != null && id !== S.pending.id)) return;
    const p = S.pending;
    timeline = [...timeline, { t: S.t, type: 'confirm', trigger: p.trigger, atStopId: p.atStopId, kind: p.kind }];
    applyConfirm();
    // reaching the end immediately (e.g. return from H) finishes on the next step
    publish();
    ctx.setState({ playing: true });
  }

  function applyConfirm() {
    const p = S.pending;
    const oldRemaining = remainingStopIds();
    const next = S.pendingRoute;
    const keep = new Set(next.stops);
    const newlyDropped = oldRemaining.filter((s) => s !== H_ID && !keep.has(s) && !S.visited.includes(s) && !S.dropped.includes(s));
    if (newlyDropped.length) S.dropped = [...S.dropped, ...newlyDropped];
    S.active = next;
    S.markIdx = S.pendingMarkIdx;
    S.pending = null;
    S.pendingRoute = null;
    S.replans = S.replans.map((r) => (r.id === p.id && r.confirmedT == null ? { ...r, confirmedT: S.t } : r));
    const rec = S.replans.find((r) => r.id === p.id);
    deactivateAlerts((a) => a.kind === 'replan');
    S.status = isReturnKind(next.kind) ? 'returning' : 'walking';
    withQueues(S);
    pushAlert({ level: 'ok', kind: 'replan', title: 'Reroute confirmed', text: p.label });
    if (!S.seeking) ctx.emit('replan:applied', rec);
  }

  // --------------------------------------------------------------- faults
  function syncFaults() {
    lastInputs = inputs();
    const f = lastInputs.faults || {};
    // link
    if (f.linkLost && S.link.ok) {
      S.link = { ok: false, lostSinceT: S.t, linkAlertId: null };
      S.link.linkAlertId = pushAlert({
        level: 'danger', kind: 'link', active: true, title: 'Rover link lost: suit-only mode',
        text: 'Position from dead reckoning, uncertainty growing. Follow the way home on the HUD if needed.',
      });
    } else if (!f.linkLost && !S.link.ok) {
      S.link = { ok: true, lostSinceT: null, linkAlertId: null };
      deactivateAlerts((a) => a.kind === 'link');
      pushAlert({ level: 'ok', kind: 'link', title: 'Rover link restored: position fixed', text: 'Dot snapped back to the rover fix.' });
    }
    // rover-camera hazard demo (scripted rock field)
    if (f.hazard && !S.hazard.armed) {
      S.hazard = { ...S.hazard, armed: true };
      withQueues(S);
      if (S.hazard.done) {
        // already used once this walk
      } else if (S.hazard.at != null) {
        pushAlert({
          level: 'info', kind: 'hazard', title: 'Rover scouting ahead',
          text: `The rover camera will confirm a rock field on ${S.hazard.demo.leg.map(stopName).join(' → ')}; a detour will be proposed about ${Math.round(S.hazard.demo.radius_px * pixelM + 100)} m before it.`,
        });
      } else {
        pushAlert({ level: 'info', kind: 'hazard', title: 'No rover hazard ahead', text: 'The scripted rock field is not on the rest of this route.' });
      }
    } else if (!f.hazard && S.hazard.armed && !S.hazard.done) {
      S.hazard = { ...S.hazard, armed: false, at: null, demo: null };
    }
    // storm
    if (f.storm && !S.storm.on) {
      S.storm = { ...S.storm, on: true };
      if (S.status === 'idle') {
        pushAlert({ level: 'danger', kind: 'storm', active: true, title: 'Storm: EVA on hold', text: 'Dust / solar storm warning. Do not leave the habitat.' });
      } else if (!finished()) {
        const homeBound = alreadyHeadingHome() || (isReturnKind(S.active.kind) && !S.pending);
        pushAlert({
          level: 'danger', kind: 'storm', active: true, title: 'Storm: walk aborted',
          text: homeBound ? 'Dust / solar storm warning. Already on the way home: keep walking, no more stops.'
            : 'Dust / solar storm warning. Heading home by the shortest safe route: confirm the reroute.',
        });
        // proposes a reroute, or (already home-bound) just marks the active route as an abort
        if (!isReturnKind(S.active.kind) || S.pending) proposeReturn('storm');
      }
    } else if (!f.storm && S.storm.on) {
      S.storm = { ...S.storm, on: false };
      deactivateAlerts((a) => a.kind === 'storm');
      pushAlert({ level: 'info', kind: 'storm', title: 'Storm warning cleared', text: finished() || S.status === 'idle' ? 'Conditions back to normal.' : 'The walk stays aborted: keep heading home.' });
    }
  }

  // ----------------------------------------------------------------- step
  /** Advance the sim by dt minutes (one chunk, <= 0.25 min recommended). Returns minutes consumed. */
  function step(dt) {
    if (S.pending || finished()) return 0;
    if (S.status === 'idle') {
      if (S.storm.on) return 0;
      S.status = 'walking';
    }
    let rem = dt;
    let guard = 0;
    while (rem > EPS && !S.pending && !finished() && guard++ < 1000) {
      const a = S.active;
      const n = a.path.length;
      const mark = a.stopMarks[S.markIdx];
      if (mark && S.routeT >= mark.arriveMin - EPS) { arrive(mark); continue; }
      if (S.hazard.at != null && S.routeT >= S.hazard.at - EPS) { hazardReached(); continue; }
      const cp = S.cpQueue[0];
      if (cp && S.routeT >= cp.at - EPS) { S.cpQueue = S.cpQueue.slice(1); checkpointReached(cp); continue; }
      if (n < 2 || S.routeT >= a.tMin[n - 1] - EPS) {
        // end of route without a final mark: treat as home
        S.status = isReturnKind(a.kind) ? 'aborted' : 'done';
        pushAlert({ level: 'ok', kind: 'done', title: 'Route complete', text: `T+${fmtMin(S.t)}` });
        if (st().playing) ctx.setState({ playing: false });
        break;
      }
      const i = segmentIndexAt(a.tMin, S.routeT);
      const stationary = samePx(a.path[i], a.path[i + 1]);
      const rate = stationary ? 1 : paceFactor();
      let target = a.tMin[i + 1];
      if (mark && mark.arriveMin < target) target = Math.max(S.routeT, mark.arriveMin);
      if (cp && cp.at < target) target = Math.max(S.routeT, cp.at);
      if (S.hazard.at != null && S.hazard.at < target) target = Math.max(S.routeT, S.hazard.at);
      const need = (target - S.routeT) / rate;
      const use = Math.min(need, rem);
      S.t += use;
      S.usedMin += use * burnFactor();
      S.routeT = use >= need ? target : S.routeT + use * rate;
      rem -= use;
      S.status = isReturnKind(a.kind) ? 'returning' : (stationary ? 'working' : 'walking');
    }
    if (!S.pending && !finished()) {
      const { p } = locate();
      pushTrail(p.px);
      checkAir(p.px);
    }
    return dt - rem;
  }

  function checkAir(truePx) {
    const air = airNow(displayedPx(truePx, 0));
    const burn = burnFactor();
    if (!S.airOutAlerted && air.leftMin <= 0) {
      S.airOutAlerted = true;
      pushAlert({ level: 'danger', kind: 'air', active: true, title: 'Air budget used up', text: 'Suit is on reserve air.' });
    }
    if (S.turnaround || S.pending || isReturnKind(S.active.kind)) return;
    if (S.status !== 'walking' && S.status !== 'working') return;
    if (!turnaroundDue(air.leftMin, air.homeAirMin, bud().reserveMin, config.turnaroundMarginMin)) return;
    S.turnaround = true;
    const homeBound = alreadyHeadingHome();
    pushAlert({
      level: 'danger', kind: 'air', active: true, title: 'Turn around: air for the walk home is getting short',
      text: `Air left ${Math.round(air.leftMin)} min; the walk home needs ${Math.round(air.homeAirMin)} min of air`
        + (burn !== 1 || paceFactor() !== 1 ? ` (${burn}x burn${paceFactor() !== 1 ? ', slow pace' : ''})` : '')
        + ` + ${bud().reserveMin} min reserve.`
        + (homeBound ? (air.marginMin < -config.turnaroundMarginMin
          ? ' Already on the shortest way home: keep walking, the reserve will be used.'
          : ' Already heading home: keep walking, no more stops.') : ' Reroute home proposed.'),
    });
    if (!homeBound) proposeReturn('air');
  }

  // -------------------------------------------------------------- publish
  function homePathFor(loc) {
    const a = S.active;
    const key = `${a.id}|${loc.p.i}|${S.markIdx}|${Math.round(S.routeT * 4)}`;
    if (homeCache.key === key) return homeCache.path;
    let path;
    if (isReturnKind(a.kind) || finished()) path = sliceRouteFrom(a.path, a.tMin, a.homeMin, S.routeT).path;
    else path = bestReturn().route.path;
    homeCache = { key, path };
    return path;
  }

  function statusText(nextStop, working) {
    const a = S.active;
    switch (S.status) {
      case 'idle': return S.storm.on ? 'Storm: EVA on hold' : `Ready: ${a.label}`;
      case 'working': return working ? `Working at ${stopName(working.stopId)}, ${Math.ceil(working.leftMin)} min left` : 'Working';
      case 'walking': return nextStop ? `Walking to ${nextStop.name}` : 'Walking';
      case 'awaiting_confirm': return `Reroute proposed${S.pending?.atStopId ? ` at ${S.pending.atStopName}` : ''}: confirm to continue`;
      case 'returning': return `${S.storm.on ? 'Storm: r' : 'R'}eturning to ${stopName(H_ID)}`;
      case 'done': case 'aborted': {
        const left = bud().budgetMin - S.usedMin;
        const note = left < 0 ? ', air budget overrun' : left < bud().reserveMin - 0.5 ? ', reserve used' : '';
        return `Back at ${stopName(H_ID)}: walk ${S.status === 'done' ? 'complete' : 'aborted'}${note}`;
      }
      default: return S.status;
    }
  }

  function snapshot() {
    const a = S.active;
    const loc = locate();
    const { p, cum, along, total } = loc;
    const truePx = p.px;
    const pace = paceFactor();
    const burn = burnFactor();

    if (!p.stationary && !p.atEnd && a.path.length > 1) {
      const i = clamp(p.i, 0, a.path.length - 2);
      if (!samePx(a.path[i], a.path[i + 1])) S.headingDeg = bearingDeg(a.path[i], a.path[i + 1]);
    }

    const unc = uncertaintyM();
    const ev2True = pointBehind(S.trail, truePx, config.crewSpacingM, pixelM);
    const crew = [
      { id: 'EV1', label: 'EV1', px: displayedPx(truePx, 0), truePx: [...truePx], uncertaintyM: unc },
      { id: 'EV2', label: 'EV2', px: displayedPx(ev2True, 1), truePx: ev2True, uncertaintyM: unc },
    ];
    const ev1 = crew[0].px;
    const rov = positionAtDistance(a.path, cum, along + config.roverAheadM);

    const air = airNow(ev1);

    let working = null;
    if (p.stationary && !p.atEnd) {
      const m = a.stopMarks.find((mk) => S.routeT >= mk.arriveMin - EPS && S.routeT < mk.departMin);
      if (m) working = { stopId: m.id, leftMin: m.departMin - S.routeT };
    }

    let nextStop = null;
    const mk = finished() ? null : a.stopMarks[S.markIdx];
    if (mk) {
      const spx = stopPx(mk.id) || a.path[mk.pathIndex];
      const pa = plannedArriveFor(mk);
      nextStop = {
        id: mk.id, name: stopName(mk.id), px: spx,
        distanceM: Math.max(0, cum[mk.pathIndex] - along),
        straightM: distM(ev1, spx, pixelM),
        bearingDeg: bearingDeg(ev1, spx),
        etaT: S.t + pacedDuration(a.path, a.tMin, S.routeT, mk.arriveMin, pace),
        ...(pa != null ? { plannedArriveT: pa } : {}),
      };
    }

    const endT = a.tMin[a.tMin.length - 1] ?? 0;
    const projectedReturnT = S.t + pacedDuration(a.path, a.tMin, S.routeT, endT, pace);
    const f = inputs().faults || {};
    const dust = data.env?.dust ?? 'unknown';
    const tau = data.env?.dustTau?.estimate;
    const dustTau = Number.isFinite(tau) ? tau : null;
    const solarAlert = !!data.env?.solar_alert || !!f.storm;
    const dustLevel = /high|severe|storm/i.test(dust) ? 'danger' : /moderate|medium/i.test(dust) ? 'warn' : 'ok';
    const envLevel = f.storm ? 'danger' : (solarAlert ? 'warn' : dustLevel === 'danger' ? 'warn' : dustLevel);
    const envText = f.storm
      ? (S.status === 'idle' ? 'STORM: EVA on hold' : finished() ? 'STORM: crew back at the habitat' : 'STORM: walk aborted, heading home')
      : `Dust ${dust}${dustTau != null ? ` (τ ${dustTau.toFixed(2)})` : ''} · ${solarAlert ? 'SOLAR ALERT' : 'no solar alert'}`;

    const visibleHomeMin = air.timeHomeMin;
    const B = bud();
    const pending = S.pending;

    return {
      t: S.t,
      routeT: S.routeT,
      status: S.status,
      statusText: statusText(nextStop, working),
      paceFactor: pace,
      active: a,
      trail: S.trail,
      progress: { i: p.i, frac: p.frac, distanceAlongM: along, remainingM: Math.max(0, total - along) },
      nextStop,
      headingDeg: S.headingDeg,
      working,
      crew,
      rover: { px: rov.px, linkOk: S.link.ok, aheadM: Math.max(0, Math.min(config.roverAheadM, total - along)) },
      air: {
        budgetMin: B.budgetMin, reserveMin: B.reserveMin, budgetDemo: B.demo,
        usedMin: S.usedMin, leftMin: air.leftMin, burnFactor: burn,
        timeHomeMin: air.timeHomeMin, timeHomeSource: air.timeHomeSource,
        wayHomeMin: air.wayHomeMin, homeAirMin: air.homeAirMin, neededMin: air.neededMin, paceFactor: pace,
        marginMin: air.marginMin, level: airLevel(air.marginMin, config.turnaroundMarginMin),
        turnaround: S.turnaround,
      },
      schedule: {
        behindMin: Math.max(0, S.t - S.routeT),
        plannedReturnT: plannedVariant().est_min ?? (plannedVariant().t_min?.at(-1) ?? 0),
        projectedReturnT,
      },
      env: { dust, dustTau, solarAlert, stormActive: !!f.storm, level: envLevel, text: envText },
      link: { ok: S.link.ok, lostSinceT: S.link.lostSinceT },
      home: {
        px: homePx, bearingDeg: bearingDeg(ev1, homePx), straightM: distM(ev1, homePx, pixelM),
        timeHomeMin: visibleHomeMin, path: homePathFor(loc),
      },
      visited: S.visited,
      dropped: S.dropped,
      replans: S.replans,
      pendingReplan: pending,
      alerts: S.alerts,
      hazard: S.hazard.seen ? { ...S.hazard.seen } : null,
      hazardArmed: !!(S.hazard.armed && !S.hazard.done && S.hazard.at != null),
      checkpoints: S.cpQueue.map((q) => ({ at: q.at, px: q.cp.px })),
    };
  }

  function publish() {
    ctx.setState({ sim: snapshot() });
  }

  // ------------------------------------------------------- reset / seek
  function reset() {
    const vid = st().plannedVariantId;
    S = freshState(vid);
    homeCache = { key: '', path: null };
    const prevSeeking = S.seeking;
    S.seeking = true; // reset-time fault alerts are silent
    syncFaults();
    S.seeking = prevSeeking;
  }

  /** Reset that also forgets the recorded timeline (Reset button, new plan, replay after the end). */
  function hardReset() {
    timeline = [];
    baseInputs = stateInputs();
    reset();
  }

  /** Record a user change of faults / slow pace at the current sim time (for seek replay). */
  function recordInputs() {
    const now = stateInputs();
    if (sameInputs(now, lastInputs)) return false;
    if (S.status === 'idle' && S.t <= EPS) baseInputs = now;
    else timeline = [...timeline, { t: S.t, type: 'inputs', ...now }];
    return true;
  }

  /**
   * Jump to sim time `target` by replaying from T+0: fault / pace toggles are re-applied at the
   * times they happened and reroutes the user already confirmed are confirmed again. The replay
   * stops at a proposal that was never confirmed. Seeking backwards forgets anything recorded
   * after the target, and the fault toggles in the UI are set to what was in force at the target.
   */
  function seek(target) {
    const goal = clamp(Number(target) || 0, 0, bud().budgetMin * 2);
    timeline = timeline.filter((e) => e.t <= goal + EPS);
    const events = timeline.filter((e) => e.type === 'inputs');
    const confirms = timeline.filter((e) => e.type === 'confirm').map((e) => ({ ...e, used: false }));
    replay = { ...(baseInputs || stateInputs()) };
    reset();
    S.seeking = true;
    let k = 0;
    const applyInputsUpTo = (t) => {
      let changed = false;
      while (k < events.length && events[k].t <= t + EPS) {
        replay = { faults: { ...events[k].faults }, slowPace: events[k].slowPace };
        k++; changed = true;
      }
      if (changed) syncFaults();
    };
    const autoConfirm = () => {
      const p = S.pending;
      const c = confirms.find((e) => !e.used && e.trigger === p.trigger && e.atStopId === p.atStopId
        && e.kind === p.kind && Math.abs(e.t - S.t) < 1);
      if (!c) return false;
      c.used = true;
      applyConfirm();
      return true;
    };
    let guard = 0;
    while (guard++ < 100000) {
      applyInputsUpTo(S.t);
      if (S.pending) { if (autoConfirm()) continue; break; }
      if (finished() || S.t >= goal - EPS) break;
      const nextEv = k < events.length ? events[k].t : Infinity;
      const used = step(Math.max(EPS * 10, Math.min(0.25, goal - S.t, nextEv - S.t)));
      if (used <= EPS && !S.pending && !finished()) break; // blocked (e.g. storm hold)
    }
    // inputs recorded up to the target stay in force even if the walk ended or stopped earlier
    if (k < events.length) {
      replay = { faults: { ...events[events.length - 1].faults }, slowPace: events[events.length - 1].slowPace };
      syncFaults();
    }
    const finalInputs = replay;
    replay = null;
    S.seeking = false;
    lastInputs = finalInputs;
    // keep the UI toggles in step with what is in force at the target time
    const s0 = st();
    const patch = {};
    if (FAULT_KEYS.some((f) => !!s0.faults?.[f] !== !!finalInputs.faults?.[f])) {
      patch.faults = { ...(s0.faults || {}), ...finalInputs.faults };
    }
    if (!!s0.slowPace !== !!finalInputs.slowPace) patch.slowPace = finalInputs.slowPace;
    if (Object.keys(patch).length) ctx.setState(patch);
    publish();
    if (st().playing && (S.pending || finished())) ctx.setState({ playing: false });
  }

  // -------------------------------------------------------------- clock
  let lastTs = null;
  function frame(ts) {
    const s = st();
    if (s.playing && S) {
      if (S.pending || finished()) {
        lastTs = null;
        ctx.setState({ playing: false });
      } else {
        if (lastTs == null) lastTs = ts;
        const realSec = Math.max(0, (ts - lastTs) / 1000);
        lastTs = ts;
        let dt = Math.min(3, realSec * (s.speed || 300) / 60);
        while (dt > EPS && !S.pending && !finished()) {
          const chunk = Math.min(0.25, dt);
          const used = step(chunk);
          if (used <= EPS) { dt = 0; break; }
          dt -= chunk;
        }
        publish();
        if (st().playing && (S.pending || finished() || (S.status === 'idle' && S.storm.on))) ctx.setState({ playing: false });
      }
    } else {
      lastTs = null;
    }
    requestAnimationFrame(frame);
  }

  // -------------------------------------------------------------- wiring
  hardReset();
  publish();

  ctx.subscribe((s, prev, changed) => {
    if (!S) return;
    if (changed.has('plannedVariantId') && S.status === 'idle' && s.plannedVariantId !== S.plannedVariantId) {
      hardReset();
      publish();
    }
    if (changed.has('demoBudgetMin')) {
      // the budget is read live through bud(): while idle this just rebuilds sim.air; after the start
      // (the select is disabled then) it applies from the next step, with no reset
      publish();
    }
    if (changed.has('faults') || changed.has('slowPace')) {
      // a toggle the seek replay just applied matches lastInputs and is not recorded again
      if (recordInputs()) syncFaults();
      publish();
    }
    if (changed.has('slowPace') || (changed.has('faults') && s.faults?.highAir !== prev.faults?.highAir)) {
      publish();
    }
    if (changed.has('playing') && s.playing && finished()) {
      // pressing Play after the walk ended starts it over
      hardReset();
      publish();
    }
  });

  ctx.on('sim:reset', () => { hardReset(); publish(); });
  ctx.on('sim:seek', (e) => seek(e?.t ?? 0));
  ctx.on('replan:confirm', (e) => confirm(e?.id));

  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(frame);

  // small debug/test API (no other module should rely on it)
  return {
    step: (dt) => { const u = step(dt); publish(); return u; },
    runTo: (t) => seek(t),
    confirm,
    reset: () => { hardReset(); publish(); },
  };
}
