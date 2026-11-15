// Run from the repo root: node --test web/tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  chooseReplanOption, positionAt, buildStopMarks, findReplanEntry, stripWork, sliceRouteFrom,
  backtrackRoute, concatRoutes, pacedDuration, workMinutes, turnaroundDue, airLevel, pointBehind, initSim,
} from '../sim.js';
import { effectiveBudget, pxToLonLat, lonLatToPx, DEMO_BUDGET_NOTE, assumptionBasis } from '../util.js';

const dataDir = fileURLToPath(new URL('../../data/', import.meta.url));
const routes = JSON.parse(readFileSync(dataDir + 'routes.json', 'utf8'));
const stops = JSON.parse(readFileSync(dataDir + 'stops.json', 'utf8'));
const stopsById = Object.fromEntries(stops.map((s) => [s.id, s]));
const V = Object.fromEntries(routes.variants.map((v) => [v.id, v]));
const full = V.full;
const safety = JSON.parse(readFileSync(dataDir + 'safety_params.json', 'utf8'));
const bounds = JSON.parse(readFileSync(dataDir + 'bounds.json', 'utf8'));
const site = JSON.parse(readFileSync(dataDir + 'site.json', 'utf8'));
// Budgets are explicit per scenario: the REAL suit budget (safety_params.json, 480 / 30) or the
// DEMO budget the app offers (240, "DEMO SETTING, not the real suit budget").
const BUDGET = safety.params.suit_budget_min.value;
const RESERVE = safety.params.reserve_min.value;
const DEMO = 240;
const PACE = 0.8; // app.js slowPaceFactor
const entryAt = (v, id) => v.replan.find((r) => r.at === id);
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b} (tol ${tol})`);

test('positionAt: starts at H, reaches A at its planned arrival, holds still during work, ends at H', () => {
  const sp = Object.fromEntries(full.stop_plan.slice(1, 3).map((e) => [e.id, e]));
  assert.deepEqual(positionAt(full.path, full.t_min, 0).px, stopsById.H.px);
  assert.deepEqual(positionAt(full.path, full.t_min, sp.A.arrive_min).px, stopsById.A.px);
  const mid = positionAt(full.path, full.t_min, (sp.A.arrive_min + sp.A.depart_min) / 2);
  assert.deepEqual(mid.px, stopsById.A.px);
  assert.equal(mid.stationary, true);
  assert.deepEqual(positionAt(full.path, full.t_min, 1e9).px, stopsById.H.px);
});

test('buildStopMarks matches stop_plan indices and times', () => {
  const marks = buildStopMarks(full.path, full.t_min, full.stops, (id) => stopsById[id].px);
  assert.deepEqual(marks.map((m) => m.id), ['H', 'A', 'B', 'H']);
  full.stop_plan.forEach((e, k) => {
    assert.equal(marks[k].pathIndex, e.path_index);
    near(marks[k].arriveMin, e.arrive_min, 0.01);
    near(marks[k].departMin, e.depart_min, 0.01);
  });
});

test('chooseReplanOption: on time at A keeps the plan', () => {
  const A = entryAt(full, 'A');
  const T = full.stop_plan[1].arrive_min;
  const c = chooseReplanOption(A.options, T, BUDGET, RESERVE);
  assert.equal(c.option.kind, 'planned');
  assert.equal(c.fits, true);
});

test('chooseReplanOption: late arrival at A takes the first option that fits (routes.json rule)', () => {
  const A = entryAt(full, 'A');
  // arrive late enough that the plan no longer fits
  const planned = A.options[0];
  const T = BUDGET - RESERVE - planned.minutes + 5;
  const c = chooseReplanOption(A.options, T, BUDGET, RESERVE);
  const expected = A.options.find((o) => T + o.minutes + RESERVE <= BUDGET) || A.options.at(-1);
  assert.equal(c.option.kind, expected.kind);
  assert.notEqual(c.option.kind, 'planned');
  assert.equal(c.rejected[0].option.kind, 'planned');
  assert.ok(c.rejected[0].overByMin > 0);
});

test('chooseReplanOption: very late falls back to abort; high air use triggers "air"', () => {
  const A = entryAt(full, 'A');
  const late = chooseReplanOption(A.options, BUDGET - RESERVE, BUDGET, RESERVE); // nothing can fit any more
  assert.equal(late.option.kind, 'abort');
  assert.equal(late.fits, false);
  // on time, but air for only the shortest (abort) option at 1.6x burn
  const abortA = A.options.find((o) => o.abort || o.kind === 'abort');
  const T = full.stop_plan[1].arrive_min;
  const air = chooseReplanOption(A.options, T, BUDGET, RESERVE, { burnFactor: 1.6, airLeftMin: abortA.minutes * 1.6 + RESERVE + 0.5 });
  assert.ok(A.options.filter((o) => o !== abortA).every((o) => o.minutes > abortA.minutes + 0.5));
  assert.equal(air.option.kind, 'abort');
  assert.equal(air.trigger, 'air');
  const B = entryAt(full, 'B');
  assert.equal(chooseReplanOption(B.options, BUDGET, BUDGET, RESERVE).option, null); // B has no abort option
});

test('findReplanEntry: after skip_work at A, B entry is found by remaining stops', () => {
  const hit = findReplanEntry(routes.variants, 'B', ['B', 'H'], 'full@A:skip_work');
  assert.ok(hit);
  assert.equal(hit.entry.at, 'B');
  assert.equal(findReplanEntry(routes.variants, 'A', ['A', 'X'], 'full').entry.at, 'A'); // fallback by variant
  assert.equal(findReplanEntry(routes.variants, 'Z', ['Z'], 'full'), null);
});

test('replan option t_min is relative to arrival and ends at H', () => {
  for (const v of routes.variants) for (const r of v.replan) for (const o of r.options) {
    assert.equal(o.t_min[0], 0);
    assert.deepEqual(o.path.at(-1), stopsById.H.px);
    near(o.t_min.at(-1), o.minutes, 0.1);
    assert.equal(o.path.length, o.t_min.length);
    assert.equal(o.path.length, o.home_min.length);
  }
});

test('stripWork removes exactly the work minutes', () => {
  const s = stripWork(full.path, full.t_min, full.home_min);
  near(s.tMin.at(-1), full.t_min.at(-1) - workMinutes(full.path, full.t_min), 1e-6);
  near(workMinutes(full.path, full.t_min), full.work_min, 0.05);
  assert.equal(workMinutes(s.path, s.tMin), 0);
});

test('sliceRouteFrom / backtrackRoute / concatRoutes', () => {
  const t = (full.stop_plan[1].depart_min + full.stop_plan[2].arrive_min) / 2; // mid A->B leg
  const departA = full.stop_plan[1].path_index + 1; // A's depart vertex (dwell duplicate)
  const sl = sliceRouteFrom(full.path, full.t_min, full.home_min, t);
  near(sl.tMin.at(-1), full.t_min.at(-1) - t, 1e-6);
  assert.deepEqual(sl.path[0], positionAt(full.path, full.t_min, t).px);
  const back = backtrackRoute(full.path, full.t_min, full.home_min, t, departA);
  assert.deepEqual(back.path.at(-1), stopsById.A.px);
  near(back.tMin.at(-1), t - full.stop_plan[1].depart_min, 1e-6);
  const abortA = entryAt(full, 'A').options.find((o) => o.kind === 'abort');
  const c = concatRoutes(back, { path: abortA.path, tMin: abortA.t_min, homeMin: abortA.home_min });
  near(c.tMin.at(-1), back.tMin.at(-1) + abortA.minutes, 0.06); // minutes is rounded to 0.1
  assert.deepEqual(c.path.at(-1), stopsById.H.px);
  for (let i = 1; i < c.tMin.length; i++) assert.ok(c.tMin[i] >= c.tMin[i - 1]);
});

test('pacedDuration stretches walking, not work', () => {
  const total = full.t_min.at(-1);
  near(pacedDuration(full.path, full.t_min, 0, total, 1), total, 1e-6);
  const work = workMinutes(full.path, full.t_min);
  near(pacedDuration(full.path, full.t_min, 0, total, 0.5), (total - work) * 2 + work, 1e-6);
});

test('turnaround and air level rules', () => {
  assert.equal(turnaroundDue(90, 50, 30, 10), true);
  assert.equal(turnaroundDue(90.1, 50, 30, 10), false);
  assert.equal(turnaroundDue(5, NaN, 30, 10), false);
  assert.equal(airLevel(50, 10), 'ok');
  assert.equal(airLevel(15, 10), 'warn');
  assert.equal(airLevel(10, 10), 'danger');
});

test('pointBehind walks back along the trail', () => {
  assert.deepEqual(pointBehind([[0, 0], [10, 0]], [10, 0], 8, 2), [6, 0]);
  assert.deepEqual(pointBehind([[0, 0]], [0, 0], 8, 2), [0, 0]);
});

// ---------------------------------------------------------------- engine scenarios (mock ctx)
// budget: 'real' (480, demoBudgetMin null) or a number (the DEMO override in state.demoBudgetMin). Always explicit.
function makeCtx({ budget, slowPace = false, faults = {}, variant = 'full' } = {}) {
  assert.ok(budget === 'real' || Number.isFinite(budget), 'every scenario sets its budget explicitly');
  let state = {
    mode: 'planner', plannedVariantId: variant, selectedStopId: null, layersOn: {}, playing: false, speed: 300,
    slowPace, faults: { linkLost: false, highAir: false, storm: false, hazard: false, ...faults },
    demoBudgetMin: budget === 'real' ? null : budget, sim: null,
  };
  const subs = new Set(), handlers = new Map(), events = [];
  const ctx = {
    data: { routes, stops, stopsById, variantsById: V, env: { dust: 'low', solar_alert: false, dustTau: { estimate: 0.34, range: [0.16, 0.53] } } },
    config: {
      budgetMin: BUDGET, reserveMin: RESERVE, pixelM: 2, slowPaceFactor: PACE, highAirBurnFactor: 1.6,
      turnaroundMarginMin: 10, roverAheadM: 100, crewSpacingM: 4, posErrM: 1.5, drGrowthMPerMin: 1.2, drDriftMPerMin: 0.6,
    },
    getState: () => state,
    setState: (p) => {
      const patch = typeof p === 'function' ? p(state) : p;
      const prev = state; const ch = new Set(Object.keys(patch).filter((k) => patch[k] !== prev[k]));
      if (!ch.size) return;
      state = { ...state, ...patch };
      for (const f of [...subs]) f(state, prev, ch);
    },
    subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
    on: (n, f) => { if (!handlers.has(n)) handlers.set(n, new Set()); handlers.get(n).add(f); },
    off: () => {}, emit: (n, p) => { events.push([n, p]); for (const f of handlers.get(n) || []) f(p); },
    timeHomeAt: () => null, // force the route fallback (no bin in node)
    setMode: () => {}, toast: () => {},
  };
  const api = initSim(ctx);
  return { ctx, api, events, sim: () => state.sim };
}
function run(h, maxMin = 600) {
  for (let i = 0; i < maxMin * 4; i++) {
    const s = h.sim();
    if (s.pendingReplan || s.status === 'done' || s.status === 'aborted') break;
    h.api.step(0.25);
  }
  return h.sim();
}
/** Run to the end, confirming every proposal. Returns { s, proposals }. */
function runConfirming(h, maxProposals = 6) {
  const proposals = [];
  let s = run(h);
  while (s.pendingReplan && proposals.length < maxProposals) {
    proposals.push(s.pendingReplan);
    h.ctx.emit('replan:confirm', { id: s.pendingReplan.id });
    s = run(h);
  }
  return { s, proposals };
}
const setFaults = (h, f) => h.ctx.setState({ faults: { linkLost: false, highAir: false, storm: false, hazard: false, ...f } });
const skipLabel = `Skip the ${stopsById.A.work_min}-min work at ${stopsById.A.name}`;

// ---------------------------------------------------------------- budget helpers (util.js)
test('effectiveBudget: real by default, labelled demo override', () => {
  const config = { budgetMin: BUDGET, reserveMin: RESERVE };
  const real = effectiveBudget({ demoBudgetMin: null }, config);
  assert.deepEqual([real.budgetMin, real.reserveMin, real.usableMin, real.demo, real.note], [480, 30, 450, false, '']);
  const demo = effectiveBudget({ demoBudgetMin: DEMO }, config);
  assert.deepEqual([demo.budgetMin, demo.usableMin, demo.demo, demo.realBudgetMin], [DEMO, DEMO - RESERVE, true, BUDGET]);
  assert.equal(demo.note, DEMO_BUDGET_NOTE);
  assert.match(demo.label, /DEMO/);
  assert.equal(effectiveBudget({ demoBudgetMin: BUDGET }, config).demo, false); // same as real is not a demo
  assert.equal(effectiveBudget({}, config).budgetMin, BUDGET);
});

test('pxToLonLat: corners and the site.json habitat round trip (linear, 1e-5 deg)', () => {
  const c = bounds.corners_lonlat;
  const geo = { ...c, widthPx: bounds.width_px, heightPx: bounds.height_px };
  const W = bounds.width_px, Hh = bounds.height_px;
  for (const [px, ll] of [[[0, 0], c.nw], [[W, 0], c.ne], [[W, Hh], c.se], [[0, Hh], c.sw]]) {
    const got = pxToLonLat(px, geo);
    near(got[0], ll[0], 1e-9); near(got[1], ll[1], 1e-9);
  }
  const hab = site.habitat;
  const ll = pxToLonLat(hab.px, geo);
  near(ll[0], hab.lon, 1e-5); near(ll[1], hab.lat, 1e-5);
  const back = lonLatToPx([hab.lon, hab.lat], geo);
  near(back[0], hab.px[0], 0.05); near(back[1], hab.px[1], 0.05);
  assert.equal(pxToLonLat([1, 1], null), null);
});

// ---------------------------------------------------------------- engine: real budget (480 / 30)
test('engine (real 480): full plan on time finishes at H at est_min with no reroute', () => {
  const h = makeCtx({ budget: 'real' });
  assert.equal(h.sim().status, 'idle');
  assert.equal(h.sim().air.budgetMin, BUDGET);
  assert.equal(h.sim().air.budgetDemo, false);
  const s = run(h);
  assert.equal(s.status, 'done');
  near(s.t, full.est_min, 0.1);
  assert.deepEqual(s.visited, ['A', 'B', 'H']);
  assert.ok(s.replans.every((r) => r.kind === 'planned'));
  assert.deepEqual(s.crew[0].px, stopsById.H.px);
  near(s.air.leftMin, BUDGET - full.est_min, 0.1);
});

test('engine (real 480): slow pace alone never triggers a replan', () => {
  const h = makeCtx({ budget: 'real', slowPace: true });
  const s = run(h);
  assert.equal(s.status, 'done');
  assert.deepEqual(s.visited, ['A', 'B', 'H']);
  assert.ok(s.replans.every((r) => r.kind === 'planned'));
  assert.ok(s.air.leftMin > 250, `air left ${s.air.leftMin}`);
});

test('engine (real 480): high air use from the start still fits, no reroute', () => {
  const h = makeCtx({ budget: 'real', faults: { highAir: true } });
  const s = run(h);
  assert.equal(s.status, 'done');
  assert.ok(s.replans.every((r) => r.kind === 'planned'));
  near(s.air.leftMin, BUDGET - full.est_min * 1.6, 0.2);
});

test('engine: env carries the dust tau and the solar alert', () => {
  const h = makeCtx({ budget: 'real' });
  const e = h.sim().env;
  assert.equal(e.dust, 'low');
  assert.equal(e.dustTau, 0.34);
  assert.equal(e.solarAlert, false);
  assert.equal(e.level, 'ok');
  assert.equal(e.text, 'Dust low (τ 0.34) · no solar alert');
});

// ---------------------------------------------------------------- engine: demo budget
test('engine: demo budget change while idle rebuilds air; real again clears the flag', () => {
  const h = makeCtx({ budget: 'real' });
  h.ctx.setState({ demoBudgetMin: DEMO });
  let a = h.sim().air;
  assert.equal(a.budgetMin, DEMO);
  assert.equal(a.budgetDemo, true);
  assert.equal(a.leftMin, DEMO);
  assert.equal(h.sim().status, 'idle');
  h.ctx.setState({ demoBudgetMin: null });
  a = h.sim().air;
  assert.equal(a.budgetMin, BUDGET);
  assert.equal(a.budgetDemo, false);
});

test('engine (demo 240): on time the plan still fits with the reserve kept', () => {
  const h = makeCtx({ budget: DEMO });
  const s = run(h);
  assert.equal(s.status, 'done');
  assert.ok(s.replans.every((r) => r.kind === 'planned'));
  assert.ok(!s.air.turnaround);
  near(s.air.leftMin, DEMO - full.est_min, 0.1);
  assert.ok(s.air.leftMin >= RESERVE);
});

test('engine (demo 240): slow pace -> checkpoint proposes skipping the work at A, depot still reached, reserve kept', () => {
  const h = makeCtx({ budget: DEMO, slowPace: true });
  let s = run(h);
  assert.equal(s.status, 'awaiting_confirm');
  const p = s.pendingReplan;
  assert.equal(p.kind, 'skip_work');
  assert.equal(p.label, skipLabel);
  assert.equal(p.trigger, 'schedule');
  assert.equal(p.checkpoint, true);
  assert.equal(p.atStopId, null);
  // first checkpoint on the A leg (planned route clock), reached late at 0.8x
  const cp0 = full.checkpoints[0].t_min;
  near(s.routeT, cp0, 0.3);
  assert.ok(s.t > cp0 && s.t < full.stop_plan[1].arrive_min, `proposed at T+${s.t}`);
  assert.ok(p.behindMin > 2 && p.behindMin < 6, `behind ${p.behindMin}`);
  assert.equal(p.rejected[0].kind, 'planned');
  assert.ok(p.rejected[0].overByMin > 0);
  assert.equal(p.safety.withinBudget, true);
  assert.equal(p.safety.budgetMin, DEMO);
  assert.match(p.safety.text, /demo budget/);
  assert.match(p.safety.text, new RegExp(DEMO_BUDGET_NOTE));
  h.api.step(5); // paused while awaiting confirm
  near(h.sim().t, s.t, 1e-9);
  h.ctx.emit('replan:confirm', { id: p.id });
  s = h.sim();
  assert.equal(s.pendingReplan, null);
  assert.equal(s.active.kind, 'skip_work');
  assert.equal(h.ctx.getState().playing, true);
  const rest = runConfirming(h);
  s = rest.s;
  assert.equal(rest.proposals.length, 0, 'no further reroutes after skipping the work');
  assert.equal(s.status, 'done');
  assert.deepEqual(s.visited, ['A', 'B', 'H']);
  assert.deepEqual(s.dropped, []);
  assert.ok(s.air.leftMin >= RESERVE, `reserve kept, air left ${s.air.leftMin}`);
  assert.ok(s.air.marginMin >= 0);
  assert.ok(s.t < full.est_min, `back at T+${s.t}`);
});

test('engine (demo 240): high air use from the start drops A at a checkpoint (air trigger)', () => {
  const h = makeCtx({ budget: DEMO, faults: { highAir: true } });
  const { s, proposals } = runConfirming(h);
  assert.equal(proposals[0].trigger, 'air');
  assert.ok(['drop', 'abort'].includes(proposals[0].kind));
  assert.ok(proposals[0].checkpoint || proposals[0].atStopId === 'A');
  assert.ok(['done', 'aborted'].includes(s.status));
  assert.ok(s.dropped.includes('A'));
  assert.ok(s.air.leftMin >= RESERVE - 1, `air left at home ${s.air.leftMin}`);
});

test('engine (demo 240): high air mid-walk turns around in time to keep the reserve (burn-aware)', () => {
  for (const at of [50, 100]) {
    const h = makeCtx({ budget: DEMO });
    while (h.sim().t < at) h.api.step(0.25);
    setFaults(h, { highAir: true });
    const { s, proposals } = runConfirming(h);
    assert.ok(proposals.length > 0 && proposals[0].trigger === 'air', `expected an air reroute (high air from T+${at})`);
    assert.ok(['done', 'aborted'].includes(s.status));
    assert.ok(s.air.leftMin >= s.air.reserveMin - 1, `air left at home ${s.air.leftMin} (high air from T+${at})`);
    assert.ok(!s.alerts.some((a) => a.title === 'Air budget used up'));
  }
});

test('engine (demo 240): high air toggled mid-leg after A fires the turn-around and turns back', () => {
  const h = makeCtx({ budget: DEMO });
  while (h.sim().t < 50) h.api.step(0.25);
  setFaults(h, { highAir: true });
  const s0 = run(h);
  assert.equal(s0.pendingReplan?.trigger, 'air');
  assert.ok(s0.air.turnaround || s0.pendingReplan.checkpoint);
  const { s } = runConfirming(h);
  assert.ok(['done', 'aborted'].includes(s.status));
  assert.ok(s.air.leftMin >= s.air.reserveMin - 1, `air left at home ${s.air.leftMin}`);
});

test('engine: air margin scales the walk home by the burn rate', () => {
  const h = makeCtx({ budget: 'real', faults: { highAir: true } });
  for (let i = 0; i < 80; i++) h.api.step(0.25);
  const a = h.sim().air;
  const walk = Math.max(a.timeHomeMin, a.wayHomeMin);
  near(a.homeAirMin, walk * 1.6, 1e-6);
  near(a.marginMin, a.leftMin - walk * 1.6 - a.reserveMin, 1e-6);
  near(a.neededMin, walk * 1.6 + a.reserveMin, 1e-6);
  near(a.leftMin, BUDGET - 20 * 1.6, 1e-6);
});

test('engine (demo 240): seek replays confirmed reroutes and fault times', () => {
  const h = makeCtx({ budget: DEMO, slowPace: true });
  let s = run(h);
  const tP = s.t;
  const kind = s.pendingReplan.kind;
  h.ctx.emit('replan:confirm', { id: s.pendingReplan.id });
  while (h.sim().t < tP + 10) h.api.step(0.25);
  setFaults(h, { linkLost: true });
  for (let i = 0; i < 20; i++) h.api.step(0.25);
  const before = h.sim();
  h.ctx.emit('sim:seek', { t: before.t });
  s = h.sim();
  near(s.t, before.t, 1e-6);
  assert.equal(s.active.kind, kind);
  assert.equal(s.status, before.status);
  near(s.link.lostSinceT, before.link.lostSinceT, 1e-6);
  near(s.crew[0].uncertaintyM, before.crew[0].uncertaintyM, 1e-6);
  near(s.air.leftMin, before.air.leftMin, 1e-6);
  // scrub back before the link cut: toggle follows the timeline
  h.ctx.emit('sim:seek', { t: tP + 5 });
  assert.equal(h.sim().link.ok, true);
  assert.equal(h.ctx.getState().faults.linkLost, false);
  assert.equal(h.sim().active.kind, kind);
});

test('engine (real 480): storm mid-leg proposes an abort home; link loss drifts and snaps back', () => {
  const h = makeCtx({ budget: 'real' });
  while (h.sim().t < 20) h.api.step(0.25);
  setFaults(h, { linkLost: true });
  for (let i = 0; i < 40; i++) h.api.step(0.25);
  let s = h.sim();
  assert.equal(s.link.ok, false);
  assert.equal(s.rover.linkOk, false);
  assert.ok(s.alerts.some((a) => a.kind === 'link' && a.active));
  assert.ok(s.crew[0].uncertaintyM > 1.5);
  assert.ok(Math.hypot(s.crew[0].px[0] - s.crew[0].truePx[0], s.crew[0].px[1] - s.crew[0].truePx[1]) > 0);
  setFaults(h, {});
  s = h.sim();
  assert.deepEqual(s.crew[0].px, s.crew[0].truePx);
  assert.ok(!s.alerts.some((a) => a.kind === 'link' && a.active));
  setFaults(h, { storm: true });
  s = h.sim();
  assert.equal(s.env.level, 'danger');
  assert.equal(s.pendingReplan.trigger, 'storm');
  assert.equal(s.pendingReplan.kind, 'abort');
  h.ctx.emit('replan:confirm', { id: s.pendingReplan.id });
  s = run(h);
  assert.equal(s.status, 'aborted');
  assert.ok(s.t < 70, `back at ${s.t}`);
  assert.ok(s.dropped.includes('A') && s.dropped.includes('B'));
});

test('engine (demo 240): seek fast-forwards and stops at a pending replan; reset returns to idle', () => {
  const h = makeCtx({ budget: DEMO, slowPace: true });
  h.ctx.emit('sim:seek', { t: 200 });
  assert.equal(h.sim().status, 'awaiting_confirm');
  assert.equal(h.sim().pendingReplan.kind, 'skip_work');
  h.ctx.emit('sim:reset');
  assert.equal(h.sim().status, 'idle');
  assert.equal(h.sim().t, 0);
  assert.equal(h.sim().air.budgetMin, DEMO); // reset keeps the budget setting
  h.ctx.setState({ plannedVariantId: 'skipA' });
  assert.equal(h.sim().active.id, 'skipA');
});


// ---------------------------------------------------------------- checkpoints and the hazard demo
test('engine (demo 240): checkpoints are queued on the active route and never re-propose the same reroute', () => {
  const h0 = makeCtx({ budget: 'real' });
  // the full variant's own checkpoints, plus skipA's where the two routes share a segment
  assert.ok(h0.sim().checkpoints.length >= full.checkpoints.length, 'expected checkpoints on the route');
  assert.ok(full.checkpoints.every((c) => h0.sim().checkpoints.some((q) => Math.abs(q.at - c.t_min) < 0.01)));
  const h = makeCtx({ budget: DEMO, slowPace: true });
  let s = run(h);
  const first = s.pendingReplan;
  assert.ok(first?.checkpoint);
  h.ctx.emit('replan:confirm', { id: first.id });
  s = run(h);
  // after skipping the work, arriving at A must not propose skipping it again
  const again = s.replans.filter((r) => r.kind === first.kind && r.confirmedT == null && r.id !== first.id);
  assert.equal(again.length, 0);
  while (s.pendingReplan) { h.ctx.emit('replan:confirm', { id: s.pendingReplan.id }); s = run(h); }
  assert.ok(['done', 'aborted'].includes(s.status));
});

for (const budget of ['real', DEMO]) {
  test(`engine (${budget === 'real' ? 'real 480' : 'demo 240'}): rock field demo proposes the precomputed detour and rejoins the plan at B`, () => {
    const hz = full.hazard_demo;
    assert.ok(hz, 'routes.json full variant has a hazard_demo');
    const h = makeCtx({ budget, faults: { hazard: true } });
    let s = run(h);
    assert.equal(s.pendingReplan?.trigger, 'hazard');
    near(s.routeT, hz.trigger_t_min, 0.01);
    assert.deepEqual(s.hazard.px, hz.hazard_px);
    assert.ok(s.pendingReplan.minutes > 0);
    assert.equal(s.pendingReplan.safety.withinBudget, true);
    h.ctx.emit('replan:confirm', { id: s.pendingReplan.id });
    s = h.sim();
    assert.equal(s.active.kind, 'hazard');
    assert.deepEqual(s.active.stops, ['B', 'H']);
    // the detour never enters the rock field
    const [hx, hy] = hz.hazard_px;
    for (const [x, y] of s.active.path.slice(0, hz.path.length)) assert.ok(Math.hypot(x - hx, y - hy) > hz.radius_px);
    s = run(h);
    while (s.pendingReplan) { h.ctx.emit('replan:confirm', { id: s.pendingReplan.id }); s = run(h); }
    assert.equal(s.status, 'done');
    assert.ok(s.visited.includes('B'));
    assert.ok(s.air.leftMin >= RESERVE);
  });
}

test('engine (real 480): rock field toggled after the trigger point does nothing', () => {
  const h = makeCtx({ budget: 'real' });
  while (h.sim().routeT < full.hazard_demo.trigger_t_min + 5) h.api.step(0.25);
  setFaults(h, { hazard: true });
  const s = run(h);
  assert.notEqual(s.pendingReplan?.trigger, 'hazard');
  assert.ok(s.alerts.some((a) => a.title === 'No rover hazard ahead'));
});

// "T+h:mm (planned h:mm), n min behind" -> minutes; arrival = planned + behind on one clock
const parseHm = (x) => { const [h, m] = x.split(':').map(Number); return h * 60 + m; };
test('engine (demo 240): after a reroute, arrival alerts use the active route plan, so planned + behind = arrival', () => {
  const h = makeCtx({ budget: DEMO, slowPace: true });
  const { s, proposals } = runConfirming(h);
  assert.equal(proposals.length, 1);
  assert.equal(s.status, 'done');
  const arrivals = s.alerts.filter((a) => a.kind === 'arrive');
  assert.ok(arrivals.length >= 2, 'arrived at A and B');
  for (const a of arrivals) {
    const m = a.text.match(/^T\+(\d+:\d\d) \(planned (\d+:\d\d)\)(?:, (\d+) min behind)?/);
    assert.ok(m, a.text);
    const at = parseHm(m[1]), planned = parseHm(m[2]), behind = m[3] ? Number(m[3]) : 0;
    assert.ok(planned <= at, `${a.title}: planned after arrival (${a.text})`);
    assert.ok(Math.abs(at - planned - behind) <= 1, `${a.title}: ${a.text}`);
  }
});

test('assumptionBasis: routes.json lines take the basis of the safety_params keys they mention', () => {
  const P = safety.params;
  const walk = assumptionBasis('Suited walking speed 2 km/h on flat ground, slower on slopes (Tobler-style), up to 40% slower in soft sand', P);
  assert.deepEqual(walk.bases.map((b) => b.basis), [P.walk_speed_flat_kmh.basis, 'assumption']);
  assert.ok(walk.bases[0].keys.includes('walk_speed_flat_kmh'));
  const slope = assumptionBasis('Slope above 15° is costly and 20° or more is no-go', P);
  assert.deepEqual(slope.bases.flatMap((b) => b.keys).sort(), ['slope_hard_deg', 'slope_soft_deg']);
  assert.equal(slope.bases.find((b) => b.keys.includes('slope_hard_deg')).basis, P.slope_hard_deg.basis);
  assert.deepEqual(assumptionBasis('Routes keep 4 m away from no-go ground', P), { basis: 'assumption', bases: [{ basis: 'assumption', keys: [] }] });
  assert.equal(assumptionBasis('Cost weights are tuning knobs, not physics', P).basis, 'assumption');
  assert.equal(assumptionBasis('anything', null).basis, 'assumption');
});
