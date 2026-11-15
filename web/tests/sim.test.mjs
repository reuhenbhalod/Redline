// Run from the repo root: node --test web/tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  chooseReplanOption, positionAt, buildStopMarks, findReplanEntry, stripWork, sliceRouteFrom,
  backtrackRoute, concatRoutes, pacedDuration, workMinutes, turnaroundDue, airLevel, pointBehind, initSim,
} from '../sim.js';

const dataDir = fileURLToPath(new URL('../../data/', import.meta.url));
const routes = JSON.parse(readFileSync(dataDir + 'routes.json', 'utf8'));
const stops = JSON.parse(readFileSync(dataDir + 'stops.json', 'utf8'));
const stopsById = Object.fromEntries(stops.map((s) => [s.id, s]));
const V = Object.fromEntries(routes.variants.map((v) => [v.id, v]));
const full = V.full;
const BUDGET = routes.params.suit_budget_min;
const RESERVE = routes.params.suit_reserve_min;
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
  const late = chooseReplanOption(A.options, 250, BUDGET, RESERVE);
  assert.equal(late.option.kind, 'abort');
  assert.equal(late.fits, false);
  const air = chooseReplanOption(A.options, 41.9, BUDGET, RESERVE, { burnFactor: 1.6, airLeftMin: BUDGET - 41.9 * 1.6 });
  assert.equal(air.option.kind, 'abort');
  assert.equal(air.trigger, 'air');
  const B = entryAt(full, 'B');
  assert.equal(chooseReplanOption(B.options, 290, BUDGET, RESERVE).option, null); // B has no abort option
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
function makeCtx({ slowPace = false, faults = {}, variant = 'full' } = {}) {
  let state = {
    mode: 'planner', plannedVariantId: variant, selectedStopId: null, layersOn: {}, playing: false, speed: 300,
    slowPace, faults: { linkLost: false, highAir: false, storm: false, ...faults }, sim: null,
  };
  const subs = new Set(), handlers = new Map(), events = [];
  const ctx = {
    data: { routes, stops, stopsById, variantsById: V, env: { dust: 'low', solar_alert: false } },
    config: {
      budgetMin: BUDGET, reserveMin: RESERVE, pixelM: 2, slowPaceFactor: 0.7, highAirBurnFactor: 1.6,
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

test('engine: full plan on time finishes at H at est_min with no reroute', () => {
  const h = makeCtx();
  assert.equal(h.sim().status, 'idle');
  const s = run(h);
  assert.equal(s.status, 'done');
  near(s.t, full.est_min, 0.1);
  assert.deepEqual(s.visited, ['A', 'B', 'H']);
  assert.ok(s.replans.every((r) => r.kind === 'planned'));
  assert.deepEqual(s.crew[0].px, stopsById.H.px);
});

test('engine: slow pace applies the rule at the real pace, waits, and confirm splices it', () => {
  const h = makeCtx({ slowPace: true });
  let s = run(h);
  assert.equal(s.status, 'awaiting_confirm');
  const kind = s.pendingReplan.kind;
  assert.ok(['skip_work', 'drop', 'abort'].includes(kind), `unexpected ${kind}`);
  assert.equal(s.pendingReplan.safety.withinBudget, true);
  // fires at the first point where the plan stops fitting: a mid-leg checkpoint before A, or A itself
  const atA = s.pendingReplan.atStopId === 'A';
  assert.ok(atA || s.pendingReplan.checkpoint, 'expected a proposal at A or at a checkpoint');
  assert.ok(s.t <= full.stop_plan[1].arrive_min / 0.7 + 0.05);
  assert.ok(s.pendingReplan.behindMin > 0);
  h.api.step(5); // paused while awaiting confirm
  near(h.sim().t, s.t, 1e-9);
  h.ctx.emit('replan:confirm', { id: s.pendingReplan.id });
  s = h.sim();
  assert.equal(s.pendingReplan, null);
  assert.equal(s.active.kind, kind);
  assert.equal(h.ctx.getState().playing, true);
  s = run(h);
  for (let n = 0; n < 4 && s.pendingReplan; n++) {
    h.ctx.emit('replan:confirm', { id: s.pendingReplan.id });
    s = run(h);
  }
  assert.ok(['done', 'aborted'].includes(s.status));
  assert.ok(s.air.marginMin >= 0, `reserve kept, margin ${s.air.marginMin}`);
});

test('engine: high air mid-walk turns around in time to keep the reserve (burn-aware)', () => {
  for (const at of [50, 100]) {
    const h = makeCtx();
    while (h.sim().t < at) h.api.step(0.25);
    h.ctx.setState({ faults: { linkLost: false, highAir: true, storm: false } });
    let s = run(h);
    for (let n = 0; n < 4 && s.pendingReplan; n++) {
      h.ctx.emit('replan:confirm', { id: s.pendingReplan.id });
      s = run(h);
    }
    assert.ok(['done', 'aborted'].includes(s.status));
    assert.ok(s.air.leftMin >= s.air.reserveMin - 1, `air left at home ${s.air.leftMin} (high air from T+${at})`);
    assert.ok(!s.alerts.some((a) => a.title === 'Air budget used up'));
  }
});

test('engine: air margin scales the walk home by the burn rate', () => {
  const h = makeCtx({ faults: { highAir: true } });
  for (let i = 0; i < 80; i++) h.api.step(0.25);
  const a = h.sim().air;
  const walk = Math.max(a.timeHomeMin, a.wayHomeMin);
  near(a.homeAirMin, walk * 1.6, 1e-6);
  near(a.marginMin, a.leftMin - walk * 1.6 - a.reserveMin, 1e-6);
  near(a.neededMin, walk * 1.6 + a.reserveMin, 1e-6);
});

test('engine: seek replays confirmed reroutes and fault times', () => {
  const h = makeCtx({ slowPace: true });
  let s = run(h);
  const tA = s.t;
  const kind = s.pendingReplan.kind;
  h.ctx.emit('replan:confirm', { id: s.pendingReplan.id });
  while (h.sim().t < tA + 10) h.api.step(0.25);
  h.ctx.setState({ faults: { linkLost: true, highAir: false, storm: false } });
  for (let i = 0; i < 20; i++) h.api.step(0.25);
  const before = h.sim();
  h.ctx.emit('sim:seek', { t: before.t });
  s = h.sim();
  near(s.t, before.t, 1e-6);
  assert.equal(s.active.kind, kind);
  assert.equal(s.status, before.status);
  near(s.link.lostSinceT, before.link.lostSinceT, 1e-6);
  near(s.crew[0].uncertaintyM, before.crew[0].uncertaintyM, 1e-6);
  // scrub back before the link cut: toggle follows the timeline
  h.ctx.emit('sim:seek', { t: tA + 5 });
  assert.equal(h.sim().link.ok, true);
  assert.equal(h.ctx.getState().faults.linkLost, false);
  assert.equal(h.sim().active.kind, kind);
});

test('engine: high air use aborts at A (air trigger)', () => {
  const h = makeCtx({ faults: { highAir: true } });
  const s = run(h);
  assert.equal(s.pendingReplan.kind, 'abort');
  assert.equal(s.pendingReplan.trigger, 'air');
  h.ctx.emit('replan:confirm', { id: s.pendingReplan.id });
  const e = run(h);
  assert.equal(e.status, 'aborted');
  assert.ok(e.dropped.includes('B'));
});

test('engine: high air toggled mid-leg after A fires the turn-around and turns back', () => {
  const h = makeCtx();
  while (h.sim().t < 50) h.api.step(0.25);
  h.ctx.setState({ faults: { linkLost: false, highAir: true, storm: false } });
  let s = run(h);
  // caught by a checkpoint's air check, or by the turn-around rule
  assert.equal(s.pendingReplan?.trigger, 'air');
  assert.ok(s.air.turnaround || s.pendingReplan.checkpoint);
  for (let n = 0; n < 4 && s.pendingReplan; n++) {
    h.ctx.emit('replan:confirm', { id: s.pendingReplan.id });
    s = run(h);
  }
  assert.ok(['done', 'aborted'].includes(s.status));
  assert.ok(s.air.leftMin >= s.air.reserveMin - 1, `air left at home ${s.air.leftMin}`);
});

test('engine: storm mid-leg proposes an abort home; link loss drifts and snaps back', () => {
  const h = makeCtx();
  while (h.sim().t < 20) h.api.step(0.25);
  h.ctx.setState({ faults: { linkLost: true, highAir: false, storm: false } });
  for (let i = 0; i < 40; i++) h.api.step(0.25);
  let s = h.sim();
  assert.equal(s.link.ok, false);
  assert.ok(s.crew[0].uncertaintyM > 1.5);
  assert.ok(Math.hypot(s.crew[0].px[0] - s.crew[0].truePx[0], s.crew[0].px[1] - s.crew[0].truePx[1]) > 0);
  h.ctx.setState({ faults: { linkLost: false, highAir: false, storm: false } });
  s = h.sim();
  assert.deepEqual(s.crew[0].px, s.crew[0].truePx);
  h.ctx.setState({ faults: { linkLost: false, highAir: false, storm: true } });
  s = h.sim();
  assert.equal(s.env.level, 'danger');
  assert.equal(s.pendingReplan.trigger, 'storm');
  assert.equal(s.pendingReplan.kind, 'abort');
  h.ctx.emit('replan:confirm', { id: s.pendingReplan.id });
  s = run(h);
  assert.equal(s.status, 'aborted');
  assert.ok(s.t < 70, `back at ${s.t}`);
});

test('engine: seek fast-forwards and stops at a pending replan; reset returns to idle', () => {
  const h = makeCtx({ slowPace: true });
  h.ctx.emit('sim:seek', { t: 200 });
  assert.equal(h.sim().status, 'awaiting_confirm');
  h.ctx.emit('sim:reset');
  assert.equal(h.sim().status, 'idle');
  assert.equal(h.sim().t, 0);
  h.ctx.setState({ plannedVariantId: 'skipA' });
  assert.equal(h.sim().active.id, 'skipA');
});


// ---------------------------------------------------------------- checkpoints and the hazard demo
test('engine: checkpoints are queued on the active route and never re-propose the same reroute', () => {
  const h = makeCtx({ slowPace: true });
  let s = run(h);
  assert.ok(s.checkpoints.length > 0 || s.pendingReplan, 'expected checkpoints on the route');
  const first = s.pendingReplan;
  h.ctx.emit('replan:confirm', { id: first.id });
  s = run(h);
  // after skipping the work, arriving at A must not propose skipping it again
  const again = s.replans.filter((r) => r.kind === first.kind && r.confirmedT == null && r.id !== first.id);
  assert.equal(again.length, 0);
  while (s.pendingReplan) { h.ctx.emit('replan:confirm', { id: s.pendingReplan.id }); s = run(h); }
  assert.ok(['done', 'aborted'].includes(s.status));
});

test('engine: rock field demo proposes the precomputed detour and rejoins the plan at B', () => {
  const hz = full.hazard_demo;
  assert.ok(hz, 'routes.json full variant has a hazard_demo');
  const h = makeCtx({ faults: { hazard: true } });
  let s = run(h);
  assert.equal(s.pendingReplan?.trigger, 'hazard');
  near(s.routeT, hz.trigger_t_min, 0.01);
  assert.deepEqual(s.hazard.px, hz.hazard_px);
  assert.ok(s.pendingReplan.minutes > 0);
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
});

test('engine: rock field toggled after the trigger point does nothing', () => {
  const h = makeCtx();
  while (h.sim().routeT < full.hazard_demo.trigger_t_min + 5) h.api.step(0.25);
  h.ctx.setState({ faults: { linkLost: false, highAir: false, storm: false, hazard: true } });
  const s = run(h);
  assert.notEqual(s.pendingReplan?.trigger, 'hazard');
  assert.ok(s.alerts.some((a) => a.title === 'No rover hazard ahead'));
});
