// science.js — "science along the way": short field-geology prompts between the stops.
//
// data/route_science.json (pipeline/09_route_science.py) lists, per route variant, the points where the mapped
// rock/surface unit (Stack et al. 2020) or the orbital CRISM mineral class (Parente et al.) changes along the
// path. When EV1 passes within TRIGGER_M of one, the crew gets a toast with a short observation task. The walk
// is never paused. Prompts are matched by position (not path index), so they still fire after a reroute; a
// detour may skip some. Each fires once per walk; Restart clears them.
//
// Writes state.scienceLog: [{ id, t, title, prompt, source, kind, to, px }] (fired prompts, in order).
// Draws small hexagon markers on the planner map (ctx.modules.map.map) for the route being walked/planned.
// Missing route_science.json = silently off.

import { fmtMin, pxToLatLng } from './util.js';

const TRIGGER_M = 25;          // crew within this distance of the prompt point
const SEEK_JUMP_MIN = 6;       // a bigger sim-time jump between frames is a seek: do not sweep-fire
const MIN_GAP_MS = 2500;       // real time between two science toasts (600x demo: keeps them readable)
const STALE_MIN = 8;           // a queued prompt older than this (sim minutes, ~250 m of walking) is dropped, not shown late
const TOAST_MS = 9000;
const OTHER_TOAST_MS = 1200;   // real time after another toast before a science toast may join it

export async function initScience(ctx) {
  const { data, config } = ctx;
  let doc;
  try {
    const res = await fetch(data.url('route_science.json'), { cache: 'no-cache' });
    if (!res.ok) return null;
    doc = await res.json();
  } catch { return null; }
  const byVariant = doc?.variants;
  if (!byVariant || typeof byVariant !== 'object') return null;
  const pixelM = config.pixelM || 2;
  const pop = document.getElementById('event-pop');
  const toastBox = ctx.els.toasts || document.getElementById('toasts');

  let fired = new Map();       // prompt id -> { to, px }
  let queue = [];              // [{ p, t }]
  let lastPos = null, lastT = null;
  let lastToastAt = -Infinity;
  let logLen = 0;

  const promptsFor = (vid) => (Array.isArray(byVariant[vid]) ? byVariant[vid] : []);
  const variantOf = (s) => s.sim?.active?.variantId || s.plannedVariantId;

  // distance (m) from point p to segment a-b, all in grid px
  function segDistM(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    let f = L2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0;
    f = Math.max(0, Math.min(1, f));
    return Math.hypot(a[0] + f * dx - p[0], a[1] + f * dy - p[1]) * pixelM;
  }
  // the same observation already fired nearby (e.g. the shared start of two variants)
  const alreadyDone = (p) => fired.has(p.id) || [...fired.values()].some((f) => f.to === p.to &&
    Math.hypot(f.px[0] - p.px[0], f.px[1] - p.px[1]) * pixelM < 60);

  function resetRun() {
    fired = new Map(); queue = []; current = null; lastPos = null; lastT = null; lastToastAt = -Infinity;
    toastBox?.querySelectorAll('.toast[data-kind="science"]').forEach((el) => el.remove());
    if (logLen) { logLen = 0; ctx.setState({ scienceLog: [] }); }
    paintMarkers();
  }

  // let another module's toast be read first: wait OTHER_TOAST_MS after any non-science toast appears
  let otherToastAt = -Infinity;
  if (toastBox && typeof MutationObserver === 'function') {
    new MutationObserver((recs) => {
      for (const r of recs) for (const n of r.addedNodes) if (n.nodeType === 1 && n.dataset.kind !== 'science') otherToastAt = performance.now();
    }).observe(toastBox, { childList: true });
  }
  const blocked = (s) => performance.now() - otherToastAt < OTHER_TOAST_MS || !!s.sim?.pendingReplan || (pop && !pop.hidden) || (toastBox && toastBox.children.length >= 3 &&
    !toastBox.querySelector('.toast[data-kind="science"]'));

  function show(p, s) {
    // one science toast on screen at a time; the newest replaces the last
    toastBox?.querySelectorAll('.toast[data-kind="science"]').forEach((el) => el.remove());
    ctx.toast({ level: 'info', title: `Science along the way · ${p.title}`, text: p.prompt, timeoutMs: TOAST_MS });
    const el = toastBox?.lastElementChild;
    if (el) {
      el.dataset.kind = 'science';
      const src = document.createElement('div');
      src.className = 'toast-src';
      src.textContent = `${p.kind === 'mineral' ? 'Orbital mineral map' : 'Geologic map'} · ${shortSource(p.source)}`;
      el.appendChild(src);
    }
    lastToastAt = performance.now();
    current = { p, el, at: lastToastAt };
    const prevLog = ctx.getState().scienceLog || [];
    if (prevLog.some((x) => x.id === p.id)) { markDone(p.id); return; }   // re-shown after a pop-up
    const log = [...prevLog, {
      id: p.id, t: s.sim.t, title: p.title, prompt: p.prompt, source: p.source, kind: p.kind, to: p.to, px: p.px,
    }];
    logLen = log.length;
    ctx.setState({ scienceLog: log });
    markDone(p.id);
  }

  // a pop-up opening right after a science toast would cover it: take the toast back and show it after the pop-up
  let current = null;
  if (pop && typeof MutationObserver === 'function') {
    new MutationObserver(() => {
      if (pop.hidden || !current || !current.el?.isConnected || performance.now() - current.at > 3000) return;
      current.el.remove();
      const t = ctx.getState().sim?.t ?? 0;
      if (!queue.some((q) => q.p.id === current.p.id)) queue.unshift({ p: current.p, t });
      lastToastAt = -Infinity;
      current = null;
    }).observe(pop, { attributes: true, attributeFilter: ['hidden'] });
  }

  function check(s) {
    const sim = s.sim;
    if (!sim) return;
    if (sim.status === 'idle' && sim.t === 0) { if (fired.size || queue.length || logLen) resetRun(); lastPos = null; return; }
    const ev1 = sim.crew?.[0];
    const pos = ev1?.truePx || ev1?.px;
    if (!pos) return;
    const jumped = lastT == null || Math.abs(sim.t - lastT) > SEEK_JUMP_MIN;
    const from = jumped ? pos : lastPos;
    lastPos = pos; lastT = sim.t;
    if (jumped && Number.isFinite(sim.routeT)) {        // seek: prompts already behind on the plan count as passed
      for (const p of promptsFor(variantOf(s))) {
        if (!fired.has(p.id) && p.t_min < sim.routeT - 1) { fired.set(p.id, { to: p.to, px: p.px }); markDone(p.id); }
      }
    }
    if (sim.status === 'walking' || sim.status === 'returning') {
      for (const p of promptsFor(variantOf(s))) {
        if (alreadyDone(p) || queue.some((q) => q.p.id === p.id)) continue;
        // out-and-back paths cross: only prompts on the leg toward the current next stop
        if (p.next_stop && sim.nextStop?.id && p.next_stop !== sim.nextStop.id) continue;
        if (segDistM(p.px, from, pos) <= TRIGGER_M) {
          fired.set(p.id, { to: p.to, px: p.px });
          if (jumped) { markDone(p.id); continue; }   // a seek landed here: count it, no toast

          queue.push({ p, t: sim.t });
        }
      }
    }
    if (!queue.length) return;
    queue = queue.filter((q) => sim.t - q.t <= STALE_MIN);
    if (!queue.length || blocked(s) || performance.now() - lastToastAt < MIN_GAP_MS) return;
    const q = queue.shift();
    show(q.p, s);
  }

  // ------------------------------------------------------------------ planner map markers
  const L = window.L;
  const map = ctx.modules?.map?.map;
  const markers = new Map();
  let shownVariant = null;
  const layer = L && map ? L.layerGroup().addTo(map) : null;

  function paintMarkers(s = ctx.getState()) {
    if (!layer) return;
    const vid = variantOf(s);
    if (vid !== shownVariant) {
      layer.clearLayers(); markers.clear(); shownVariant = vid;
      for (const p of promptsFor(vid)) {
        const icon = L.divIcon({ className: 'sci-marker', html: '<span></span>', iconSize: [14, 14], iconAnchor: [7, 7] });
        const m = L.marker(pxToLatLng(p.px), { icon, keyboard: false, riseOnHover: true })
          .bindTooltip(`<b>Science along the way</b><br>${escHtml(p.title)}<br><small>planned T+${fmtMin(p.t_min)} · ${p.kind === 'mineral' ? 'CRISM orbital map' : 'Stack et al. 2020 map'}</small>`,
            { direction: 'top', offset: [0, -6] });
        m.addTo(layer);
        markers.set(p.id, m);
      }
    }
    for (const [id, m] of markers) m.getElement()?.classList.toggle('is-done', fired.has(id));
  }
  function markDone(id) { markers.get(id)?.getElement()?.classList.add('is-done'); }

  ctx.subscribe((s, prev, changed) => {
    if (changed.has('sim')) check(s);
    if (layer && (changed.has('plannedVariantId') || (changed.has('sim') && s.sim?.active?.variantId !== prev.sim?.active?.variantId))) paintMarkers(s);
  });
  paintMarkers();
  check(ctx.getState());

  return { prompts: byVariant, sources: doc.sources || [] };
}

function shortSource(src = '') {
  if (/Parente/i.test(src)) {
    return 'CRISM, Parente et al. (Zenodo 5575824)';
  }
  if (/Stack/i.test(src)) return 'Stack et al. 2020';
  return src;
}
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
