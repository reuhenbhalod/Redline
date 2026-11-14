// app.js — loads data, owns the state store + event bus, wires the top bar, switches modes,
// and initializes the four feature modules. See INTERFACES.md for the full contract.

import { fmtMin } from './util.js';
import { initSim } from './sim.js';
import { initMap } from './map.js';
import { initPanels } from './panels.js';
import { initHud } from './hud.js';

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

async function loadData() {
  const base = dataBaseUrl();
  const errors = [];
  const grab = (name, kind, optional = false) =>
    fetchFile(base, name, kind).catch((e) => {
      if (optional) { console.warn(`[marswalk] optional ${name} missing: ${e.reason}`); return null; }
      errors.push(e);
      return null;
    });

  const [bounds, layers, stops, routes, env] = await Promise.all([
    grab('bounds.json'), grab('layers.json'), grab('stops.json'), grab('routes.json'), grab('env.json', 'json', true),
  ]);
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
  return {
    base,
    url: (name) => new URL(name, base).href,
    bounds, layers: layers || [], stops, stopsById, routes, variantsById,
    env: env || { dust: 'unknown', solar_alert: false, radiation_note: '', suit: {}, assumptions: [], missing: true },
    timeHome,
    fake: !!(bounds.fake || routes.fake),
  };
}

function buildConfig(data) {
  const p = data.routes.params || {};
  const suit = data.env.suit || {};
  const budgetMin = suit.budget_min ?? p.suit_budget_min ?? 300;
  const reserveMin = suit.reserve_min ?? p.suit_reserve_min ?? 30;
  const assumptions = [];
  const seen = new Set();
  const add = (text, source) => {
    if (!text || seen.has(text)) return;
    seen.add(text);
    assumptions.push({ text, source });
  };
  (data.routes.assumptions || []).forEach((t) => add(t, 'routes'));
  (data.env.assumptions || []).forEach((t) => add(t, 'env'));
  add(`Suit time budget ${budgetMin} min, reserve ${reserveMin} min`, 'app');
  add(`Rover scouts about ${DEMO.roverAheadM} m ahead; crew position from rover camera + UWB, about ${DEMO.posErrM} m error`, 'app');
  add(`Demo: "Slow pace" walks at ${DEMO.slowPaceFactor}x planned speed; "High air use" burns air at ${DEMO.highAirBurnFactor}x`, 'app');
  add(`Turn-around alert when air left <= time home + reserve + ${DEMO.turnaroundMarginMin} min`, 'app');
  add('Map up is treated as north for bearings', 'app');
  return {
    budgetMin,
    reserveMin,
    pixelM: data.bounds.pixel_m ?? p.pixel_m ?? 2,
    widthPx: data.bounds.width_px ?? 2000,
    heightPx: data.bounds.height_px ?? 2000,
    vFlatKmh: p.v_flat_kmh ?? 2,
    slopeSoftDeg: p.slope_soft_deg ?? 15,
    slopeHardDeg: p.slope_hard_deg ?? 25,
    weights: p.weights || {},
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

export function setMode(mode) {
  if (mode !== 'planner' && mode !== 'hud') return;
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
  scrub.max = String(Math.ceil(config.budgetMin));

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

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || e.target.isContentEditable) return;
    if (e.key === 'h' || e.key === 'H') { setMode(getState().mode === 'hud' ? 'planner' : 'hud'); e.preventDefault(); }
    else if (e.key === 'Escape' && getState().mode === 'hud') setMode('planner');
    else if (e.key === ' ' && tag !== 'button') { setState({ playing: !getState().playing }); e.preventDefault(); }
    else if (e.key === 'r' || e.key === 'R') { setState({ playing: false }); emit('sim:reset'); }
  });

  function render(s) {
    const sim = s.sim;
    const awaiting = !!sim?.pendingReplan;
    const play = $('#btn-play');
    play.textContent = s.playing ? 'Pause' : 'Play';
    play.disabled = awaiting && !s.playing;
    play.title = awaiting ? 'Confirm or review the reroute first' : 'Play / pause (space)';
    $('#sel-speed').value = String(s.speed);
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
        changed.has('slowPace') || changed.has('mode')) render(s);
  });
}

function wireMode() {
  const apply = (mode) => {
    document.body.dataset.mode = mode;
    $('#hud').hidden = mode !== 'hud';
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
  state = {
    mode: params.get('mode') === 'hud' ? 'hud' : 'planner',
    plannedVariantId: data.variantsById[params.get('variant')] ? params.get('variant') : data.routes.variants[0].id,
    selectedStopId: null,
    layersOn,
    playing: false,
    speed: DEFAULT_SPEED,
    slowPace: false,
    faults: { linkLost: false, highAir: false, storm: false },
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
    if (getState().mode === 'hud' || a.kind === 'replan') return;
    toast({ level: a.level, title: a.title, text: a.text, timeoutMs: a.level === 'danger' ? 6000 : 4000 });
  });

  wireMode();
  wireTopBar(config);

  // sim first so state.sim exists before the views render; each init is isolated.
  const inits = [['sim', initSim], ['map', initMap], ['panels', initPanels], ['hud', initHud]];
  for (const [name, init] of inits) {
    try {
      ctx.modules[name] = (await init(ctx)) ?? null;
    } catch (e) {
      console.error(`[marswalk] init${name[0].toUpperCase()}${name.slice(1)} failed`, e);
      toast({ level: 'danger', title: `${name}.js failed to start`, text: String(e?.message || e), timeoutMs: 0 });
    }
  }
  emit('app:ready', ctx);
}

boot();
