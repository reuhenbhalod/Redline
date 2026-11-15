// app.js — loads data, owns the state store + event bus, wires the top bar, switches modes,
// and initializes the four feature modules. See INTERFACES.md for the full contract.

import { fmtMin, effectiveBudget, DEMO_BUDGET_NOTE, assumptionBasis } from './util.js';
import { initSim } from './sim.js';
import { initMap } from './map.js';
import { initPanels } from './panels.js';
import { initHud } from './hud.js';
import { initTablet } from './tablet.js';
import { initRover } from './rover.js';
import { initPlanner } from './planner.js';
import { initDemo } from './demo.js';

// ---------------------------------------------------------------------------
// Tunable demo constants (shown in the UI as assumptions where relevant).
// ---------------------------------------------------------------------------
const DEMO = {
  slowPaceFactor: 0.8,        // crew walking speed multiplier when "Slow pace" is on
  highAirBurnFactor: 1.6,     // air burn multiplier when "High air use" is on
  turnaroundMarginMin: 10,    // turn-around alert fires when airLeft <= timeHome + reserve + this
  roverAheadM: 100,           // rover scouts ~100 m ahead along the route
  crewSpacingM: 4,            // EV2 walks this far behind EV1 along the route
  posErrM: 1.5,               // 1-sigma position error with the rover link up (rover camera + UWB)
  drGrowthMPerMin: 1.2,       // dead-reckoning uncertainty growth while the link is lost
  drDriftMPerMin: 0.6,        // dead-reckoning drift of the displayed dot while the link is lost
};
const DEFAULT_SPEED = 300;    // x real time; sim minutes per real second = speed / 60
// DEMO SETTING, not the real suit budget. With the real 480 min the full plan (~186 min) always fits,
// so "Slow pace" can never trigger a replan. At 240 min (checked against the real routes.json):
// on time -> the plan fits (back at ~T+3:06, ~54 min of air left); slow pace 0.8x -> the T+0:15
// checkpoint proposes "Skip the 45-min work at Delta outcrop", the crew still reaches the depot and
// gets home with ~74 min left (reserve kept).
const DEMO_BUDGET_MIN = 240;

// ---------------------------------------------------------------------------
// Store: getState / setState (shallow merge) / subscribe
// ---------------------------------------------------------------------------
let state = {};
const listeners = new Set();
const pending = [];
let notifying = false;

export function getState() {
  return state;
}

/**
 * Shallow-merge `patch` (object, or function state => object) into state.
 * Top-level keys whose value is === unchanged are ignored. Nested objects must be
 * replaced, never mutated (e.g. setState({ faults: { ...s.faults, storm: true } })).
 * Listeners are called synchronously as fn(state, prevState, changedKeys:Set<string>).
 * setState inside a listener is allowed; it is queued and delivered after the current round.
 */
export function setState(patch) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  if (!p) return;
  const prev = state;
  const changed = new Set();
  for (const k of Object.keys(p)) if (p[k] !== prev[k]) changed.add(k);
  if (!changed.size) return;
  state = { ...prev, ...p };
  pending.push([state, prev, changed]);
  if (notifying) return;
  notifying = true;
  try {
    while (pending.length) {
      const [s, pr, ch] = pending.shift();
      for (const fn of [...listeners]) {
        try { fn(s, pr, ch); } catch (e) { console.error('[marswalk] subscriber error', e); }
      }
    }
  } finally {
    notifying = false;
  }
}

/** subscribe(fn) -> unsubscribe(). fn(state, prev, changedKeys). Not called on subscribe. */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------------------
// Event bus (one-shot actions that are not state): on / off / emit
// ---------------------------------------------------------------------------
const handlers = new Map();
export function on(name, fn) {
  if (!handlers.has(name)) handlers.set(name, new Set());
  handlers.get(name).add(fn);
  return () => off(name, fn);
}
export function off(name, fn) {
  handlers.get(name)?.delete(fn);
}
export function emit(name, payload) {
  for (const fn of [...(handlers.get(name) || [])]) {
    try { fn(payload); } catch (e) { console.error(`[marswalk] handler error for "${name}"`, e); }
  }
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
function dataBaseUrl() {
  const q = new URLSearchParams(location.search).get('data');
  let base = q || '../data/';
  if (!base.endsWith('/')) base += '/';
  return new URL(base, location.href).href;
}

async function fetchFile(base, name, kind) {
  const url = new URL(name, base).href;
  let res;
  try {
    res = await fetch(url, { cache: 'no-cache' });
  } catch (e) {
    throw { name, url, reason: `network error (${e.message})` };
  }
  if (!res.ok) throw { name, url, reason: `HTTP ${res.status} ${res.statusText}` };
  try {
    return kind === 'bin' ? await res.arrayBuffer() : await res.json();
  } catch (e) {
    throw { name, url, reason: `could not parse (${e.message})` };
  }
}

function parseTimeHome(buf, meta) {
  const width = meta?.width ?? 1000;
  const height = meta?.height ?? 1000;
  const expected = width * height * 2;
  if (buf.byteLength !== expected) {
    throw { name: 'time_home.bin', url: '', reason: `size ${buf.byteLength} B, expected ${expected} B (${width}x${height} uint16)` };
  }
  // Decode little-endian explicitly so it is correct on any host endianness.
  const dv = new DataView(buf);
  const values = new Uint16Array(width * height);
  for (let i = 0; i < values.length; i++) values[i] = dv.getUint16(i * 2, true);
  return {
    width, height,
    stridePx: meta?.stride_px ?? 2,
    scaleMin: meta?.scale_min ?? 0.1,
    nodata: meta?.nodata ?? 65535,
    values,
  };
}

function makeTimeHomeAt(th) {
  /** Minutes to walk home from grid px (x, y), or null if unreachable / off-grid. */
  return function timeHomeAt(x, y) {
    if (Array.isArray(x)) [x, y] = x;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const cx = Math.floor(Math.round(x) / th.stridePx);
    const cy = Math.floor(Math.round(y) / th.stridePx);
    if (cx < 0 || cy < 0 || cx >= th.width || cy >= th.height) return null;
    const v = th.values[cy * th.width + cx];
    return v === th.nodata ? null : v * th.scaleMin;
  };
}

function showLoadError(errors, base) {
  const el = document.getElementById('load-error');
  const rows = errors.map((e) => `<li><code>${e.name}</code> — ${e.reason}${e.url ? `<br><small><code>${e.url}</code></small>` : ''}</li>`).join('');
  el.innerHTML = `<div class="err-card">
    <h2>Could not load the walk data</h2>
    <p>Data folder: <code>${base}</code></p>
    <ul>${rows}</ul>
    <p>Serve the repo root and open the app from <code>/web/</code>:</p>
    <pre>cd &lt;repo root&gt;\npython3 -m http.server 8000\nopen http://localhost:8000/web/index.html</pre>
    <p>Use <code>?data=&lt;path&gt;</code> to point at another folder (relative to <code>/web/</code>).</p>
  </div>`;
  el.hidden = false;
}

// ---------------------------------------------------------------------------
// Adapters: raw data files -> the clean shapes in INTERFACES.md ("ctx.data").
// Every new file is optional, so an old (fake) data folder still loads.
// ---------------------------------------------------------------------------

// Map overlay groups, in display order. Unknown layer ids go to 'other' at the end.
const LAYER_GROUPS = [
  { id: 'terrain', label: 'Terrain', layerIds: ['slope', 'rough', 'rocky', 'sand', 'nogo'] },
  { id: 'science', label: 'Science', layerIds: ['geology', 'minerals', 'ti'] },
];

// Dust opacity (tau) -> word. App-side thresholds, shown as an assumption.
const DUST_TAU_LEVELS = [
  { max: 0.6, word: 'low' },        // typical clear-season Jezero tau is ~0.3-0.6
  { max: 1.0, word: 'moderate' },
  { max: Infinity, word: 'high' },  // regional / global storms reach tau 2-5+
];
const dustWord = (tau) => (Number.isFinite(tau) ? DUST_TAU_LEVELS.find((l) => tau < l.max).word : 'unknown');

function adaptLayers(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.layers) ? raw.layers : [];
  const groupOf = (id) => LAYER_GROUPS.find((g) => g.layerIds.includes(id))?.id || 'other';
  const order = LAYER_GROUPS.flatMap((g) => g.layerIds);
  const rank = (id) => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
  const layers = list
    .filter((l) => l && l.id && l.file)
    .map((l) => ({
      ...l,
      label: l.label || l.id,
      legend: Array.isArray(l.legend) ? l.legend : [],
      source: l.source || '',
      native_res: l.native_res || '',
      time_frame: l.time_frame || '',
      note: l.note || '',
      group: groupOf(l.id),
    }))
    .sort((a, b) => rank(a.id) - rank(b.id));
  const present = new Set(layers.map((l) => l.id));
  const groups = LAYER_GROUPS
    .map((g) => ({ ...g, layerIds: g.layerIds.filter((id) => present.has(id)) }))
    .filter((g) => g.layerIds.length);
  const other = layers.filter((l) => l.group === 'other').map((l) => l.id);
  if (other.length) groups.push({ id: 'other', label: 'Other', layerIds: other });
  return {
    layers,
    layerGroups: groups,
    layersMeta: Array.isArray(raw) ? { grid: null, contextMap: null } : { grid: raw?.grid || null, contextMap: raw?.context_map || null },
  };
}

function adaptGeo(bounds) {
  const w = bounds?.width_px ?? 2000, h = bounds?.height_px ?? 2000;
  let c = bounds?.corners_lonlat;
  if (Array.isArray(c) && c.length === 2) {          // old fake shape: [[lon,lat] nw, [lon,lat] se]
    const [nw, se] = c;
    c = { nw, se, ne: [se[0], nw[1]], sw: [nw[0], se[1]] };
  }
  if (!c || !['nw', 'ne', 'se', 'sw'].every((k) => Array.isArray(c[k]) && c[k].length >= 2)) return null;
  return {
    nw: c.nw, ne: c.ne, se: c.se, sw: c.sw, widthPx: w, heightPx: h,
    center: bounds.center_lonlat || null, crs: bounds.crs || '', fake: !!bounds.fake,
    method: 'linear interpolation between the bounds.json corners',
  };
}

function adaptDepot(depotRaw, site) {
  const cored = Object.fromEntries((site?.depot_samples_cored || []).map((c) => [c.sample_id, c]));
  const tubes = (Array.isArray(depotRaw) ? depotRaw : []).map((t) => {
    const c = cored[t.sample_id];
    return {
      name: t.name, sampleId: t.sample_id, dropSol: t.drop_sol ?? null, dropLmst: t.drop_lmst || '',
      px: t.px, lon: t.lon ?? null, lat: t.lat ?? null,
      closeup: t.closeup || '', closeupDem: t.closeup_dem || '', credit: t.closeup_credit || '',
      fromWaypoint: t.from_waypoint || null,
      coredSol: c?.cored_sol ?? null, coredLonLat: c ? [c.lon, c.lat] : null,
    };
  });
  return {
    tubes,
    center: site?.depot_center ? { px: site.depot_center.px, lon: site.depot_center.lon, lat: site.depot_center.lat, spreadM: site.depot_center.tube_spread_m ?? null } : null,
  };
}

function adaptRoverPath(raw) {
  if (!raw || !Array.isArray(raw.segments)) return null;
  const segments = raw.segments.filter((s) => Array.isArray(s.px) && s.px.length);
  const sols = segments.map((s) => s.sol).filter(Number.isFinite);
  return {
    source: raw.source || '',
    segments,                                   // [{ sol, px: [[x, y], ...] }], one per sol, in sol order
    waypoints: Array.isArray(raw.waypoints) ? raw.waypoints : [],   // [{ sol, site, drive, px, elev_m }]
    solRange: sols.length ? [Math.min(...sols), Math.max(...sols)] : null,
  };
}

function adaptPhotos(raw, stops) {
  const out = {};
  for (const st of stops) {
    const p = raw?.[st.id];
    if (p) {
      out[st.id] = {
        note: p.note || '',
        radiusM: p.radius_m ?? null,
        parkedSols: p.parked_sols || [],
        featured: (p.featured || []).map((f) => ({ url: f.url, caption: f.caption || '', credit: f.credit || '' })),
        candidates: (p.candidates || []).map((c) => ({
          sol: c.sol ?? null, camera: c.camera || '', url: c.url, thumb: c.thumb || c.url, fullRes: c.full_res || '',
          dateUtc: c.date_utc || '', credit: c.credit || '', imageId: c.imageid || '',
        })),
        fromStops: false,
      };
    } else {
      // No photos.json (old data): the stop's own photo URLs become featured images without captions.
      out[st.id] = {
        note: '', radiusM: null, parkedSols: [],
        featured: (st.photos || []).map((url) => ({ url, caption: '', credit: '' })),
        candidates: [], fromStops: true,
      };
    }
  }
  return out;
}

function adaptSafety(raw) {
  const params = raw?.params || {};
  const list = Object.entries(params).map(([key, p]) => ({
    key, value: p.value, unit: p.unit || '', basis: p.basis || 'assumption', source: p.source || '', note: p.note || '',
  }));
  return { params, list, assumptions: raw?.assumptions || [], marsG: raw?.mars_g ?? null, missing: !raw };
}

function adaptEnv(envData, envLegacy) {
  if (envData) {
    const w = envData.weather || null;
    const d = envData.dust || null;
    const r = envData.radiation || null;
    const sw = envData.space_weather || null;
    const tau = d?.tau_estimate;
    const radNote = r
      ? `${r.dose_uGy_per_day} µGy/day${r.stand_in ? ' (Curiosity RAD at Gale, a stand-in for Jezero)' : ''}${r.note ? `: ${r.note}` : ''}`
      : '';
    return {
      missing: false, source: 'env_data', fake: !!envData.fake,
      // legacy keys (the old env.json shape; sim/hud/panels read these today)
      dust: dustWord(tau),
      solar_alert: !!sw?.solar_alert,
      radiation_note: radNote,
      suit: {},
      assumptions: [],
      // new keys
      dustTau: d ? { estimate: tau ?? null, range: d.tau_range || null, isEstimate: d.is_estimate !== false, method: d.method || '', source: d.source || '', timeFrame: d.time_frame || '' } : null,
      weather: w ? {
        airTempC: w.air_temp_c || null, groundTempC: w.ground_temp_c || null, pressurePa: w.pressure_pa ?? null,
        hourly: (w.hourly_profile || []).map((h) => ({ hour: h.ltst_hour, airTempC: h.air_temp_c, groundTempC: h.ground_temp_c, pressurePa: h.pressure_pa })),
        perSol: w.per_sol || [],
        wind: w.wind ?? null, windNote: w.wind_note || '', source: w.source || '', timeFrame: w.time_frame || '',
      } : null,
      radiation: r ? {
        doseUGyPerDay: r.dose_uGy_per_day ?? null, doseSiliconUGyPerDay: r.dose_silicon_uGy_per_day ?? null,
        standIn: !!r.stand_in, note: r.note || '', reference: r.reference || '', source: r.source || '', timeFrame: r.time_frame || '',
        perDay: r.per_day || [],
      } : null,
      spaceWeather: sw ? {
        solarAlert: !!sw.solar_alert,
        cmeArrivals30d: (sw.mars_cme_arrivals_30d || []).map((a) => ({
          arrivalUtc: a.arrival_utc, glancingBlow: !!a.glancing_blow, minorImpact: !!a.minor_impact,
          cmeIds: a.cme_ids || [], link: a.link || '', simulation: a.simulation || '',
        })),
        upcoming: sw.upcoming || [], source: sw.source || '', timeFrame: sw.time_frame || '',
        fetchedUtc: sw.fetched_utc || '', window: sw.window || null,
      } : null,
    };
  }
  if (envLegacy) {
    return {
      missing: false, source: 'env', fake: !!envLegacy.fake,
      dust: envLegacy.dust ?? 'unknown', solar_alert: !!envLegacy.solar_alert, radiation_note: envLegacy.radiation_note || '',
      suit: envLegacy.suit || {}, assumptions: envLegacy.assumptions || [],
      dustTau: null, weather: null, radiation: envLegacy.radiation_note ? { doseUGyPerDay: null, standIn: true, note: envLegacy.radiation_note } : null,
      spaceWeather: { solarAlert: !!envLegacy.solar_alert, cmeArrivals30d: [], upcoming: [], source: 'env.json', timeFrame: '' },
    };
  }
  return {
    missing: true, source: 'default', fake: false,
    dust: 'unknown', solar_alert: false, radiation_note: '', suit: {}, assumptions: [],
    dustTau: null, weather: null, radiation: null, spaceWeather: null,
  };
}

function adaptProvenance(raw) {
  if (!raw) return null;
  return {
    sources: (raw.sources || []).map((s) => ({ name: s.name || '', url: s.url || '', license: s.license || '', credit: s.credit || '', processing: s.processing || '' })),
    literature: raw.literature || [],
    aiUse: raw.ai_use || '',
  };
}

function collectCredits(photosByStop, depot, provenance) {
  const set = new Set();
  for (const p of Object.values(photosByStop)) {
    p.featured.forEach((f) => f.credit && set.add(f.credit));
    p.candidates.forEach((c) => c.credit && set.add(c.credit));
  }
  depot.tubes.forEach((t) => t.credit && set.add(t.credit));
  (provenance?.sources || []).forEach((s) => s.credit && set.add(s.credit));
  return [...set];
}

async function loadData() {
  const base = dataBaseUrl();
  const errors = [];
  const grab = (name, kind, optional = false) =>
    fetchFile(base, name, kind).catch((e) => {
      if (optional) { console.info(`[marswalk] optional ${name} not loaded: ${e.reason}`); return null; }
      errors.push(e);
      return null;
    });

  const [bounds, layersRaw, stops, routes, envData, site, depotRaw, photosRaw, roverRaw, safetyRaw, provRaw, gridsReadme] =
    await Promise.all([
      grab('bounds.json'), grab('layers.json'), grab('stops.json'), grab('routes.json'),
      grab('env_data.json', 'json', true), grab('site.json', 'json', true), grab('depot.json', 'json', true),
      grab('photos.json', 'json', true), grab('rover_path.json', 'json', true), grab('safety_params.json', 'json', true),
      grab('provenance.json', 'json', true), grab('grids_readme.json', 'json', true),
    ]);
  // env.json is the old (fake) environment file: only fetched when env_data.json is absent.
  const envLegacy = envData ? null : await grab('env.json', 'json', true);
  let timeHome = null;
  if (routes) {
    const buf = await grab(routes.time_home_file || 'time_home.bin', 'bin');
    if (buf) {
      try { timeHome = parseTimeHome(buf, routes.time_home); } catch (e) { errors.push(e); }
    }
  }
  if (routes && !Array.isArray(routes.variants)) errors.push({ name: 'routes.json', url: '', reason: 'missing variants[]' });
  if (stops && !Array.isArray(stops)) errors.push({ name: 'stops.json', url: '', reason: 'expected an array of stops' });
  if (errors.length) {
    showLoadError(errors, base);
    throw new Error('data load failed');
  }

  const stopsById = Object.fromEntries(stops.map((s) => [s.id, s]));
  const variantsById = Object.fromEntries(routes.variants.map((v) => [v.id, v]));
  const { layers, layerGroups, layersMeta } = adaptLayers(layersRaw);
  const env = adaptEnv(envData, envLegacy);
  const depot = adaptDepot(depotRaw, site);
  const photosByStop = adaptPhotos(photosRaw, stops);
  const provenance = adaptProvenance(provRaw);
  return {
    base,
    url: (name) => new URL(name, base).href,
    bounds, geo: adaptGeo(bounds),
    layers, layerGroups, layersMeta,
    stops, stopsById, routes, variantsById,
    site: site || null,
    depot,
    roverPath: adaptRoverPath(roverRaw),
    photosByStop,
    env,
    safety: adaptSafety(safetyRaw),
    provenance,
    credits: collectCredits(photosByStop, depot, provenance),
    tables: {
      units: gridsReadme?.units || {}, minerals: gridsReadme?.minerals || {},
      arrays: gridsReadme?.arrays || {}, limits: gridsReadme?.limits || {},
    },
    timeHome,
    fake: !!(bounds.fake || routes.fake || env.fake),
    raw: { bounds, layers: layersRaw, site, depot: depotRaw, photos: photosRaw, roverPath: roverRaw, envData, env: envLegacy, safety: safetyRaw, provenance: provRaw, gridsReadme },
  };
}

function buildConfig(data) {
  const p = data.routes.params || {};
  const sp = data.safety.params;
  const suit = data.env.suit || {};
  const val = (k) => (sp[k] && Number.isFinite(sp[k].value) ? sp[k].value : undefined);
  const pick = (...cands) => cands.find(([v]) => Number.isFinite(v)) || [undefined, 'default'];
  const [budgetMin, budgetFrom] = pick([val('suit_budget_min'), 'safety_params'], [suit.budget_min, 'env'], [p.suit_budget_min, 'routes'], [300, 'default']);
  const [reserveMin, reserveFrom] = pick([val('reserve_min'), 'safety_params'], [suit.reserve_min, 'env'], [p.suit_reserve_min, 'routes'], [30, 'default']);
  const assumptions = [];
  const seen = new Set();
  const add = (text, source, basis = 'assumption', bases = null) => {
    if (!text || seen.has(text)) return;
    seen.add(text);
    assumptions.push({ text, source, basis, ...(bases ? { bases } : {}) });
  };
  // routes.json lines take their basis from the safety_params keys they mention (e.g. walk speed -> PRIMARY)
  (data.routes.assumptions || []).forEach((t) => { const ab = assumptionBasis(t, sp); add(t, 'routes', ab.basis, ab.bases); });
  (data.safety.assumptions || []).forEach((t) => add(t, 'safety'));
  (data.env.assumptions || []).forEach((t) => add(t, 'env'));
  const bb = sp.suit_budget_min?.basis, rb = sp.reserve_min?.basis;
  add(`Suit time budget ${budgetMin} min, reserve ${reserveMin} min (usable ${budgetMin - reserveMin} min)`, budgetFrom === 'safety_params' ? 'safety' : 'app',
    bb === 'primary' && rb === 'primary' ? 'primary' : 'assumption');
  add(`Demo budget ${DEMO_BUDGET_MIN} min: a DEMO SETTING, not the real suit budget, so the replan can be shown with the real (short) walk`, 'app', 'demo');
  add(`Rover scouts about ${DEMO.roverAheadM} m ahead; crew position from rover camera + UWB, about ${DEMO.posErrM} m error`, 'app');
  add(`Demo: "Slow pace" walks at ${DEMO.slowPaceFactor}x planned speed; "High air use" burns air at ${DEMO.highAirBurnFactor}x`, 'app', 'demo');
  add(`Turn-around alert when air left <= time home + reserve + ${DEMO.turnaroundMarginMin} min`, 'app');
  if (data.env.dustTau) add('Dust words from tau: low < 0.6, moderate < 1.0, high above (app thresholds)', 'app');
  if (data.geo) add('Lon/lat readout interpolates linearly between the bounds.json corners', 'app');
  add('Map up is treated as north for bearings', 'app');
  return {
    budgetMin,                    // REAL suit budget. Use effectiveBudget(state, config) for the one in force.
    reserveMin,
    budgetSource: budgetFrom,     // 'safety_params' | 'env' | 'routes' | 'default'
    demoBudgetMin: DEMO_BUDGET_MIN,
    budgetOptions: [
      { value: null, label: `Real ${budgetMin} min`, demo: false },
      { value: DEMO_BUDGET_MIN, label: `Demo ${DEMO_BUDGET_MIN} min`, demo: true },
    ],
    pixelM: data.bounds.pixel_m ?? p.pixel_m ?? 2,
    widthPx: data.bounds.width_px ?? 2000,
    heightPx: data.bounds.height_px ?? 2000,
    vFlatKmh: val('walk_speed_flat_kmh') ?? p.v_flat_kmh ?? 2,
    slopeSoftDeg: val('slope_soft_deg') ?? p.slope_soft_deg ?? 15,
    slopeHardDeg: val('slope_hard_deg') ?? p.slope_hard_deg ?? 25,
    weights: p.weights || {},
    dustTauLevels: DUST_TAU_LEVELS.map((l) => ({ ...l })),
    ...DEMO,
    assumptions,
    warnings: [...(data.routes.warnings || [])],
    replanRule: data.routes.replan_rule || '',
  };
}

// ---------------------------------------------------------------------------
// Top bar wiring, mode switching, toasts, keyboard
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function toggleKey(key) {
  const s = getState();
  if (key.includes('.')) {
    const [outer, inner] = key.split('.');
    setState({ [outer]: { ...s[outer], [inner]: !s[outer]?.[inner] } });
  } else {
    setState({ [key]: !s[key] });
  }
}

export const MODES = ['planner', 'tablet', 'hud', 'rover'];

export function setMode(mode) {
  if (!MODES.includes(mode)) return;
  setState({ mode });
}

function toast({ level = 'info', title = '', text = '', timeoutMs = 5000 } = {}) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.level = level;
  if (title) {
    const t = document.createElement('div');
    t.className = 'toast-title';
    t.textContent = title;
    el.appendChild(t);
  }
  if (text) {
    const b = document.createElement('div');
    b.textContent = text;
    el.appendChild(b);
  }
  el.addEventListener('click', () => el.remove());
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  if (timeoutMs > 0) setTimeout(() => el.remove(), timeoutMs);
}

const STATUS_LEVEL = {
  idle: '', walking: 'ok', working: 'ok', awaiting_confirm: 'warn',
  returning: 'warn', done: 'ok', aborted: 'danger',
};

function wireTopBar(config) {
  const scrub = $('#scrub');
  let scrubbing = false;
  scrub.max = String(Math.ceil(effectiveBudget(getState(), config).budgetMin));

  // Demo budget select: DEMO SETTING, not the real suit budget. Only changeable while the sim is idle
  // (Reset first); the sim reads the budget through effectiveBudget(state, config).
  const selBudget = $('#sel-budget');
  selBudget.innerHTML = '';
  for (const o of config.budgetOptions) {
    const opt = document.createElement('option');
    opt.value = o.value == null ? '' : String(o.value);
    opt.textContent = o.label;
    selBudget.appendChild(opt);
  }
  selBudget.addEventListener('change', (e) => {
    const v = e.target.value === '' ? null : Number(e.target.value);
    setState({ demoBudgetMin: v });
  });

  $('#btn-play').addEventListener('click', () => setState({ playing: !getState().playing }));
  $('#btn-reset').addEventListener('click', () => {
    setState({ playing: false });
    emit('sim:reset');
  });
  $('#sel-speed').addEventListener('change', (e) => setState({ speed: Number(e.target.value) }));
  scrub.addEventListener('pointerdown', () => { scrubbing = true; });
  scrub.addEventListener('pointerup', () => { scrubbing = false; });
  scrub.addEventListener('change', () => { scrubbing = false; });
  scrub.addEventListener('input', () => emit('sim:seek', { t: Number(scrub.value) }));

  document.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => toggleKey(btn.dataset.toggle));
  });
  document.querySelectorAll('[data-mode-btn]').forEach((btn) => {
    btn.addEventListener('click', () => setMode(btn.dataset.modeBtn));
  });

  // DEMO drawer: presenter controls (clock, speed, budget, scenarios). Same element ids as the old top bar.
  const drawer = $('#demo-drawer');
  const demoBtn = $('#btn-demo');
  const setDrawer = (open) => {
    drawer.hidden = !open;
    demoBtn.setAttribute('aria-expanded', String(open));
    demoBtn.textContent = open ? 'DEMO ▾' : 'DEMO ▸';
  };
  demoBtn.addEventListener('click', () => setDrawer(drawer.hidden));
  if (new URLSearchParams(location.search).get('demo') === '1') setDrawer(true);   // ?demo=1 opens the drawer
  document.addEventListener('pointerdown', (e) => {
    if (!drawer.hidden && !drawer.contains(e.target) && !demoBtn.contains(e.target)) setDrawer(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || e.target.isContentEditable) return;
    if (e.key === 'h' || e.key === 'H') { setMode(getState().mode === 'hud' ? 'planner' : 'hud'); e.preventDefault(); }
    else if (e.key >= '1' && e.key <= '4') { setMode(MODES[Number(e.key) - 1]); e.preventDefault(); }
    else if (e.key === 'd' || e.key === 'D') { setDrawer(drawer.hidden); e.preventDefault(); }
    else if (e.key === 'Escape' && !drawer.hidden) setDrawer(false);
    else if (e.key === 'Escape' && getState().mode !== 'planner') setMode('planner');
    else if (e.key === ' ' && tag !== 'button') { setState({ playing: !getState().playing }); e.preventDefault(); }
    else if (e.key === 'r' || e.key === 'R') { setState({ playing: false }); emit('sim:reset'); }
  });

  let lastBudgetKey = null;
  function render(s) {
    const sim = s.sim;
    const awaiting = !!sim?.pendingReplan;
    const play = $('#btn-play');
    play.textContent = s.playing ? 'Pause' : 'Play';
    play.disabled = awaiting && !s.playing;
    play.title = awaiting ? 'Confirm or review the reroute first' : 'Play / pause (space)';
    $('#sel-speed').value = String(s.speed);
    const b = effectiveBudget(s, config);
    const idle = (sim?.status ?? 'idle') === 'idle';
    const budgetKey = `${b.demo}|${b.budgetMin}|${b.realBudgetMin}`;
    if (budgetKey !== lastBudgetKey) {
      lastBudgetKey = budgetKey;
      // a non-standard ?budget=<n> value gets its own option (as in the Safety card), so it never shows blank
      selBudget.querySelectorAll('option[data-extra]').forEach((o) => o.remove());
      if (b.demo && !config.budgetOptions.some((o) => o.value === b.budgetMin)) {
        const opt = document.createElement('option');
        opt.value = String(b.budgetMin);
        opt.dataset.extra = '1';
        opt.textContent = `Demo ${b.budgetMin} min`;
        selBudget.appendChild(opt);
      }
      const badge = $('#demo-badge');
      badge.hidden = !b.demo;
      badge.innerHTML = `DEMO<span class="tb-long"> BUDGET ${Math.round(Number(b.budgetMin))} MIN</span>`;
      badge.title = `${DEMO_BUDGET_NOTE} (real: ${b.realBudgetMin} min)`;
    }
    const selVal = b.demo ? String(b.budgetMin) : '';
    if (selBudget.value !== selVal) selBudget.value = selVal;
    selBudget.disabled = !idle;
    const selTitle = (b.demo ? `${DEMO_BUDGET_NOTE}. ` : `Real suit budget ${b.realBudgetMin} min (safety_params.json). `)
      + (idle ? 'Suit budget used by the sim' : 'Reset the sim to change the budget');
    if (selBudget.title !== selTitle) selBudget.title = selTitle;
    if (selBudget.dataset.demo !== String(b.demo)) selBudget.dataset.demo = String(b.demo);
    scrub.max = String(Math.ceil(b.budgetMin));
    const t = sim?.t ?? 0;
    $('#clock').textContent = `T+${fmtMin(t)}`;
    if (!scrubbing) scrub.value = String(t);
    const chip = $('#status-chip');
    const status = sim?.status ?? 'idle';
    chip.textContent = status.replace('_', ' ');
    chip.dataset.level = s.faults.storm ? 'danger' : (STATUS_LEVEL[status] ?? '');
    document.querySelectorAll('[data-toggle]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(!!getPath(s, btn.dataset.toggle)));
    });
    document.querySelectorAll('[data-mode-btn]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.modeBtn === s.mode));
    });
  }
  render(getState());
  subscribe((s, prev, changed) => {
    if (changed.has('sim') || changed.has('playing') || changed.has('speed') || changed.has('faults') ||
        changed.has('slowPace') || changed.has('mode') || changed.has('demoBudgetMin')) render(s);
  });
}

function wireMode() {
  const apply = (mode) => {
    document.body.dataset.mode = mode;
    $('#hud').hidden = mode !== 'hud';
    $('#tablet').hidden = mode !== 'tablet';
    $('#rover').hidden = mode !== 'rover';
  };
  apply(getState().mode);
  subscribe((s, prev, changed) => { if (changed.has('mode')) apply(s.mode); });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  let data;
  try {
    data = await loadData();
  } catch (e) {
    console.error('[marswalk]', e);
    return;
  }
  const config = buildConfig(data);
  $('#fake-badge').hidden = !data.fake;

  const layersOn = Object.fromEntries(data.layers.map((l) => [l.id, false]));
  const params = new URLSearchParams(location.search);
  // ?budget=demo (or ?budget=<minutes>) starts with the DEMO budget; anything else = the real budget.
  const qb = params.get('budget');
  const demoBudgetMin = qb === 'demo' ? config.demoBudgetMin : (Number(qb) > 0 && Number(qb) !== config.budgetMin ? Number(qb) : null);
  state = {
    mode: MODES.includes(params.get('mode')) ? params.get('mode') : 'planner',
    plannedVariantId: data.variantsById[params.get('variant')] ? params.get('variant') : data.routes.variants[0].id,
    selectedStopId: data.stopsById[params.get('stop')] ? params.get('stop') : null,   // ?stop=A opens the stop preview
    layersOn,
    playing: false,
    speed: DEFAULT_SPEED,
    // Deep links for demos and screenshot checks: ?slow=1, ?fault=link,air,storm,hazard (comma list).
    slowPace: params.get('slow') === '1',
    faults: (() => {
      const f = new Set((params.get('fault') || '').split(',').map((x) => x.trim()));
      return { linkLost: f.has('link'), highAir: f.has('air'), storm: f.has('storm'), hazard: f.has('hazard') };
    })(),
    demoBudgetMin,          // null = real suit budget; a number = DEMO override (see effectiveBudget in util.js)
    roverPathOn: false,     // map.js: Perseverance's real traverse overlay
    tabletCrew: 0,          // tablet.js: which crew member's tablet is shown (0 = EV1, 1 = EV2); demo console writes it
    depotOn: true,          // map.js: the 10 depot tubes
    sim: null, // written only by sim.js (see INTERFACES.md "state.sim")
  };

  const ctx = {
    data,
    config,
    getState, setState, subscribe,
    on, off, emit,
    timeHomeAt: makeTimeHomeAt(data.timeHome),
    setMode,
    toast,
    els: {
      map: $('#map'),
      sidePanel: $('#side-panel'),
      hud: $('#hud'),
      tablet: $('#tablet'),
      rover: $('#rover'),
      toasts: $('#toasts'),
    },
    modules: {},
  };
  window.marswalk = ctx; // console debugging only; modules must use the ctx they are given

  on('toast', toast);
  on('alert', (a) => {
    if (!a || a.toast === false) return;
    // The HUD has its own alert banner and replan card, and the planner shows the replan card in the
    // side panel, so sim alerts only toast in planner mode and replan proposals never toast.
    const m = getState().mode;
    if (m === 'hud' || m === 'tablet' || a.kind === 'replan') return;
    toast({ level: a.level, title: a.title, text: a.text, timeoutMs: a.level === 'danger' ? 6000 : 4000 });
  });

  wireMode();
  wireTopBar(config);

  // sim first so state.sim exists before the views render; each init is isolated.
  const inits = [['sim', initSim], ['map', initMap], ['panels', initPanels], ['hud', initHud],
    ['tablet', initTablet], ['rover', initRover], ['planner', initPlanner], ['demo', initDemo]];
  for (const [name, init] of inits) {
    try {
      ctx.modules[name] = (await init(ctx)) ?? null;
    } catch (e) {
      console.error(`[marswalk] init${name[0].toUpperCase()}${name.slice(1)} failed`, e);
      toast({ level: 'danger', title: `${name}.js failed to start`, text: String(e?.message || e), timeoutMs: 0 });
    }
  }
  emit('app:ready', ctx);
  // ?t=<minutes>: jump the sim to that time after load (same as the scrubber), for demos and screenshot checks.
  const t0 = Number(params.get('t'));
  if (t0 > 0) emit('sim:seek', { t: t0 });
}

boot();
