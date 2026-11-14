// map.js — Leaflet map for planner mode. Owner: map agent (map.js + map.css).
// Contract: INTERFACES.md "map.js". All px <-> LatLng conversion goes through util.js.
//
// Layers are built once in initMap and then only updated (setLatLngs / setLatLng /
// setRadius / setStyle / class toggles) from the state subscriber, so the ~60 Hz sim
// tick never re-creates Leaflet layers.

import { pxToLatLng, latLngToPx, imageBounds, pathToLatLngs, lerpPx, clamp, esc, fmtDistM, fmtMinLong } from './util.js';

const KIND_LABEL = { base: 'Base', science: 'Science stop', depot: 'Depot' };

/** Read the design tokens once (SVG presentation attributes cannot use var()). */
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
  return {
    planned: v('--route-planned', '#f3e9e1'),
    alt: v('--route-alt', '#8a776a'),
    active: v('--route-active', '#ffb347'),
    proposed: v('--route-proposed', '#6cb4ee'),
    home: v('--route-home', '#ef5a4c'),
    crew1: v('--crew-1', '#4fc3f7'),
    crew2: v('--crew-2', '#b39ddb'),
    rover: v('--rover', '#ffd54f'),
    text: v('--text', '#f3e9e1'),
    dim: v('--text-faint', '#8a776a'),
    danger: v('--danger', '#ef5a4c'),
  };
}

function samePx(a, b) {
  return !!a && !!b && a[0] === b[0] && a[1] === b[1];
}

/** Split a path at segment i + frac into [walked, remaining] px arrays (both include the split point). */
function splitPath(path, i, frac) {
  const n = path.length;
  if (n === 0) return [[], []];
  if (n === 1) return [[path[0]], [path[0]]];
  const ii = clamp(i | 0, 0, n - 2);
  const f = clamp(Number.isFinite(frac) ? frac : 0, 0, 1);
  const p = lerpPx(path[ii], path[ii + 1], f);
  return [[...path.slice(0, ii + 1), p], [p, ...path.slice(ii + 1)]];
}

/** "Nice" scale-bar length (1, 2, 5 x 10^k) not above maxM. */
function niceMeters(maxM) {
  if (!(maxM > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(maxM));
  const d = maxM / p;
  return (d >= 5 ? 5 : d >= 2 ? 2 : 1) * p;
}

/** @param {object} ctx  see INTERFACES.md "ctx" */
export function initMap(ctx) {
  const L = window.L;
  if (!L) throw new Error('Leaflet (window.L) is not loaded');
  const { data, config } = ctx;
  const W = config.widthPx, H = config.heightPx, pixelM = config.pixelM || 2;
  const bounds = imageBounds(W, H);
  const C = readColors();
  const el = ctx.els.map;
  el.classList.add('map-root');

  const map = L.map(el, {
    crs: L.CRS.Simple, minZoom: -3, maxZoom: 3, zoomSnap: 0.25, zoomDelta: 0.5,
    attributionControl: false, preferCanvas: false,
    maxBounds: L.latLngBounds(bounds).pad(0.5), maxBoundsViscosity: 0.6,
  });

  // Panes: basemap < overlays < routes (overlayPane 400) < markers (600) < crew < tooltips.
  const mkPane = (name, z, interactive = true) => {
    const p = map.createPane(name);
    p.style.zIndex = String(z);
    if (!interactive) p.style.pointerEvents = 'none';
    return p;
  };
  mkPane('map-base', 150, false);
  mkPane('map-overlay', 250, false);
  mkPane('map-live', 450, false);
  mkPane('map-crew', 640, false);
  const liveRenderer = L.svg({ pane: 'map-live', padding: 0.5 });
  const crewRenderer = L.svg({ pane: 'map-crew', padding: 0.5 });

  // ---------------------------------------------------------------- basemap
  const basemap = L.imageOverlay(data.url('basemap.png'), bounds, { pane: 'map-base', interactive: false, className: 'map-basemap' });
  basemap.on('error', () => ctx.toast({ level: 'warn', title: 'Basemap missing', text: `Could not load ${data.url('basemap.png')}` }));
  basemap.addTo(map);

  // ---------------------------------------------------------------- overlays
  const opacity = {};
  const overlays = {};
  for (const layer of data.layers) {
    opacity[layer.id] = 0.7;
    const ov = L.imageOverlay(data.url(layer.file), bounds, {
      pane: 'map-overlay', interactive: false, opacity: opacity[layer.id], className: `map-ov map-ov-${layer.id}`,
    });
    ov.on('error', () => ctx.toast({ level: 'warn', title: `${layer.label}: layer missing`, text: data.url(layer.file) }));
    overlays[layer.id] = ov;
  }

  const LayerControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const box = L.DomUtil.create('div', 'map-ctl map-layers');
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);
      const rows = data.layers.map((layer) => {
        const legend = (layer.legend || []).map((l) => {
          const assumed = /limit|no-go|threshold/i.test(l.label || '');
          return `<li><span class="map-sw" style="background:${esc(l.color)}"></span>${esc(l.label)}${assumed ? ' <em class="map-assume">assumption</em>' : ''}</li>`;
        }).join('');
        return `<div class="map-layer" data-layer="${esc(layer.id)}">
          <label class="map-layer-head"><input type="checkbox" data-layer-cb="${esc(layer.id)}"> <span>${esc(layer.label)}</span></label>
          <div class="map-layer-body">
            <ul class="map-legend">${legend}</ul>
            <label class="map-opacity">opacity <input type="range" min="0.1" max="1" step="0.05" value="${opacity[layer.id]}" data-layer-op="${esc(layer.id)}"></label>
          </div>
        </div>`;
      }).join('');
      box.innerHTML = `<div class="map-ctl-title">Layers</div>${rows || '<div class="map-empty">No overlays in layers.json</div>'}`;
      box.addEventListener('change', (e) => {
        const id = e.target?.dataset?.layerCb;
        if (!id) return;
        const s = ctx.getState();
        ctx.setState({ layersOn: { ...s.layersOn, [id]: e.target.checked } });
      });
      box.addEventListener('input', (e) => {
        const id = e.target?.dataset?.layerOp;
        if (!id) return;
        opacity[id] = Number(e.target.value);
        overlays[id]?.setOpacity(opacity[id]);
      });
      return box;
    },
  });
  const layerCtl = new LayerControl().addTo(map);
  const layerBox = layerCtl.getContainer();

  function renderLayers(layersOn) {
    for (const layer of data.layers) {
      const on = !!layersOn?.[layer.id];
      const ov = overlays[layer.id];
      if (on && !map.hasLayer(ov)) ov.addTo(map);
      if (!on && map.hasLayer(ov)) map.removeLayer(ov);
      const cb = layerBox.querySelector(`[data-layer-cb="${CSS.escape(layer.id)}"]`);
      if (cb) cb.checked = on;
      layerBox.querySelector(`[data-layer="${CSS.escape(layer.id)}"]`)?.classList.toggle('is-on', on);
    }
  }

  // ---------------------------------------------------------------- scale bar + north note
  const ScaleControl = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd() {
      const box = L.DomUtil.create('div', 'map-ctl map-scale');
      box.innerHTML = `<div class="map-scale-bar"><span class="map-scale-label"></span></div>
        <div class="map-scale-note">1 px = ${esc(pixelM)} m · map up = north <em class="map-assume">(assumption)</em></div>`;
      return box;
    },
  });
  const scaleCtl = new ScaleControl().addTo(map);
  const scaleBar = scaleCtl.getContainer().querySelector('.map-scale-bar');
  const scaleLabel = scaleCtl.getContainer().querySelector('.map-scale-label');
  function renderScale() {
    // L.CRS.Simple: 1 map unit = 1 grid px = 2^zoom screen px.
    const mPerScreenPx = pixelM / 2 ** map.getZoom();
    const m = niceMeters(120 * mPerScreenPx);
    scaleBar.style.width = `${Math.round(m / mPerScreenPx)}px`;
    scaleLabel.textContent = fmtDistM(m);
  }
  map.on('zoomend', renderScale);

  // ---------------------------------------------------------------- follow-crew + fit
  let follow = false;
  const ViewControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const box = L.DomUtil.create('div', 'map-ctl map-view leaflet-bar');
      L.DomEvent.disableClickPropagation(box);
      box.innerHTML = `<button type="button" class="map-btn" data-act="fit" title="Fit the whole map">Fit</button>
        <button type="button" class="map-btn" data-act="follow" aria-pressed="false" title="Keep EV1 centered">Follow crew</button>`;
      box.addEventListener('click', (e) => {
        const act = e.target?.closest?.('[data-act]')?.dataset.act;
        if (act === 'fit') { follow = false; syncFollowBtn(); map.fitBounds(bounds); }
        if (act === 'follow') {
          follow = !follow; syncFollowBtn();
          const px = ctx.getState().sim?.crew?.[0]?.px;
          if (follow && px) map.panTo(pxToLatLng(px));
        }
      });
      return box;
    },
  });
  const viewCtl = new ViewControl().addTo(map);
  const followBtn = viewCtl.getContainer().querySelector('[data-act="follow"]');
  function syncFollowBtn() { followBtn.setAttribute('aria-pressed', String(follow)); }
  map.on('dragstart', () => { if (follow) { follow = false; syncFollowBtn(); } });

  // ---------------------------------------------------------------- variant routes
  const variantLines = {};
  for (const v of data.routes.variants) {
    const line = L.polyline(pathToLatLngs(v.path), {
      color: C.alt, weight: 3, opacity: 0.5, lineJoin: 'round', lineCap: 'round', className: 'map-route map-route-variant',
    });
    line.bindTooltip(
      `<b>${esc(v.id)}</b> ${esc((v.stops || []).join('→'))}<br>${esc(fmtDistM(v.distance_m))} · ${esc(fmtMinLong(v.est_min))}` +
        `${v.fits_budget === false ? '<br><span class="map-bad">over budget</span>' : ''}`,
      { sticky: true, className: 'map-tip', direction: 'top', offset: [0, -6] },
    );
    line.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      const s = ctx.getState();
      const idle = !s.sim || s.sim.status === 'idle';
      if (!idle) {
        ctx.toast({ level: 'info', title: 'Walk in progress', text: 'Reset the sim to pick another route variant.', timeoutMs: 2500 });
        return;
      }
      if (s.plannedVariantId !== v.id) ctx.setState({ plannedVariantId: v.id });
    });
    line.addTo(map);
    variantLines[v.id] = line;
  }

  function renderVariants(s) {
    const sim = s.sim;
    const offPlan = sim?.active && sim.active.kind !== 'planned';
    const idle = !sim || sim.status === 'idle';
    for (const [id, line] of Object.entries(variantLines)) {
      const isPlanned = id === s.plannedVariantId;
      if (isPlanned) {
        line.setStyle({ color: C.planned, weight: 4.5, opacity: offPlan ? 0.35 : 0.9, dashArray: null });
        line.bringToFront();
      } else {
        line.setStyle({ color: C.alt, weight: 3, opacity: idle ? 0.55 : 0.3, dashArray: '6 6' });
      }
      line.getElement()?.classList.toggle('map-route-clickable', idle);
    }
  }

  // ---------------------------------------------------------------- live layers (sim)
  const live = { renderer: liveRenderer, interactive: false, lineJoin: 'round', lineCap: 'round' };
  const activeWalked = L.polyline([], { ...live, color: C.active, weight: 4, opacity: 0.35 });
  const activeRemaining = L.polyline([], { ...live, color: C.active, weight: 6, opacity: 1, className: 'map-route-active' });
  const proposedLine = L.polyline([], { ...live, color: C.proposed, weight: 5, opacity: 0.95, dashArray: '10 8', className: 'map-route-proposed' });
  const homeLine = L.polyline([], { ...live, color: C.home, weight: 3, opacity: 0.85, dashArray: '2 7' });
  const trailLine = L.polyline([], { ...live, color: C.crew1, weight: 2, opacity: 0.75, dashArray: '1 5' });
  [homeLine, activeWalked, activeRemaining, trailLine, proposedLine].forEach((l) => l.addTo(map));

  const crewOpt = { renderer: crewRenderer, interactive: false };
  const crewColors = [C.crew1, C.crew2];
  const crew = crewColors.map((color, i) => ({
    ring: L.circle(pxToLatLng([0, 0]), { ...crewOpt, radius: 1, color, weight: 1, opacity: 0.8, fillColor: color, fillOpacity: 0.12 }),
    ghost: L.circleMarker(pxToLatLng([0, 0]), { ...crewOpt, radius: 4, color, weight: 1, opacity: 0.5, fill: false, dashArray: '2 2' }),
    dot: L.circleMarker(pxToLatLng([0, 0]), { ...crewOpt, radius: i === 0 ? 6.5 : 5.5, color: '#081016', weight: 2, fillColor: color, fillOpacity: 1 }),
    on: false, ghostOn: false,
  }));
  const rover = L.circleMarker(pxToLatLng([0, 0]), { ...crewOpt, radius: 6, color: '#2a1a00', weight: 2, fillColor: C.rover, fillOpacity: 1 });
  const roverLink = L.polyline([], { ...crewOpt, color: C.rover, weight: 1.5, opacity: 0.5, dashArray: '3 4' });
  let roverOn = false;

  // ---------------------------------------------------------------- stops
  const stopMarkers = {};
  for (const st of data.stops) {
    const kind = st.kind || 'science';
    const icon = L.divIcon({
      className: 'map-stop-wrap',
      iconSize: [30, 30], iconAnchor: [15, 15],
      html: `<div class="map-stop map-stop-${esc(kind)}" data-stop="${esc(st.id)}">
          <span class="map-stop-pin">${esc(st.id)}</span>
          <span class="map-stop-check" aria-hidden="true">✓</span>
          <span class="map-stop-name">${esc(st.name || st.id)}</span>
        </div>`,
    });
    const m = L.marker(pxToLatLng(st.px), { icon, keyboard: true, title: `${st.name || st.id} (${KIND_LABEL[kind] || kind})`, riseOnHover: true });
    m.on('click', () => {
      const cur = ctx.getState().selectedStopId;
      ctx.setState({ selectedStopId: cur === st.id ? null : st.id });
    });
    m.addTo(map);
    stopMarkers[st.id] = m;
  }

  function renderStops(s) {
    const sim = s.sim;
    const dropped = new Set(sim?.dropped || []);
    const visited = new Set(sim?.visited || []);
    const next = sim?.nextStop?.id;
    for (const [id, m] of Object.entries(stopMarkers)) {
      const node = m.getElement()?.querySelector('.map-stop');
      if (!node) continue;
      node.classList.toggle('is-selected', s.selectedStopId === id);
      node.classList.toggle('is-dropped', dropped.has(id));
      node.classList.toggle('is-visited', visited.has(id));
      node.classList.toggle('is-next', next === id && !!sim && sim.status !== 'idle');
      m.setZIndexOffset(s.selectedStopId === id ? 1000 : 0);
    }
  }

  // ---------------------------------------------------------------- per-tick sim render
  let lastActiveId = null, lastSplitKey = '', lastTrailLen = -1, lastProposalId = null, lastHomeKey = '';

  function setVisible(layer, on) {
    if (on && !map.hasLayer(layer)) layer.addTo(map);
    if (!on && map.hasLayer(layer)) map.removeLayer(layer);
  }

  function renderSim(s) {
    const sim = s.sim;
    const a = sim?.active;

    // Active route: walked (dim) + remaining (bright). Color by kind.
    if (a && a.path?.length && sim.status !== 'idle') {
      if (a.id !== lastActiveId) {
        const color = a.kind === 'abort' || a.kind === 'return' ? C.home : a.kind === 'planned' ? C.planned : C.active;
        activeWalked.setStyle({ color });
        activeRemaining.setStyle({ color, weight: a.kind === 'planned' ? 5.5 : 6 });
        lastActiveId = a.id;
        lastSplitKey = '';
      }
      const i = sim.progress?.i ?? 0, frac = sim.progress?.frac ?? 0;
      const key = `${a.id}|${i}|${frac.toFixed(4)}`;
      if (key !== lastSplitKey) {
        const [walked, remaining] = splitPath(a.path, i, frac);
        activeWalked.setLatLngs(pathToLatLngs(walked));
        activeRemaining.setLatLngs(pathToLatLngs(remaining));
        lastSplitKey = key;
      }
      setVisible(activeWalked, true);
      setVisible(activeRemaining, true);
    } else {
      setVisible(activeWalked, false);
      setVisible(activeRemaining, false);
      lastActiveId = null; lastSplitKey = '';
    }

    // Pending replan proposal: dashed.
    const pr = sim?.pendingReplan;
    if (pr?.path?.length) {
      if (pr.id !== lastProposalId) { proposedLine.setLatLngs(pathToLatLngs(pr.path)); lastProposalId = pr.id; }
      setVisible(proposedLine, true);
      proposedLine.bringToFront();
    } else {
      setVisible(proposedLine, false);
      lastProposalId = null;
    }

    // Way home: shown in suit-only mode or during a storm.
    const showHome = !!sim && sim.status !== 'idle' && (sim.link?.ok === false || sim.env?.stormActive) && sim.home?.path?.length > 1;
    if (showHome) {
      const hp = sim.home.path;
      const hk = `${hp.length}|${hp[0]}|${hp[hp.length - 1]}`;
      if (hk !== lastHomeKey) { homeLine.setLatLngs(pathToLatLngs(hp)); lastHomeKey = hk; }
    } else lastHomeKey = '';
    setVisible(homeLine, showHome);

    // Breadcrumb trail.
    const trail = sim?.trail || [];
    const crewPx = sim?.crew?.[0]?.truePx || sim?.crew?.[0]?.px;
    if (trail.length !== lastTrailLen || (trail.length && crewPx)) {
      const pts = trail.length && crewPx && !samePx(trail[trail.length - 1], crewPx) ? [...trail, crewPx] : trail;
      trailLine.setLatLngs(pts.length > 1 ? pathToLatLngs(pts) : []);
      lastTrailLen = trail.length;
    }

    // Crew dots + uncertainty rings (+ ghost at truePx while the link is lost).
    const showCrew = !!sim && Array.isArray(sim.crew) && sim.status !== 'idle';
    const linkOk = sim?.link?.ok !== false;
    sim?.crew?.slice(0, 2).forEach((c, i) => {
      const k = crew[i];
      if (!k || !c?.px) return;
      const ll = pxToLatLng(c.px);
      k.dot.setLatLng(ll);
      k.ring.setLatLng(ll);
      k.ring.setRadius(Math.max(0.5, (c.uncertaintyM || 0) / pixelM));
      k.ring.setStyle({ color: linkOk ? crewColors[i] : C.danger, fillOpacity: linkOk ? 0.12 : 0.08, dashArray: linkOk ? null : '4 4' });
      const ghost = !linkOk && c.truePx && !samePx(c.truePx, c.px);
      if (ghost) k.ghost.setLatLng(pxToLatLng(c.truePx));
      setVisible(k.ghost, ghost && showCrew);
    });
    crew.forEach((k, i) => {
      const on = showCrew && !!sim.crew[i]?.px;
      if (on !== k.on) {
        setVisible(k.ring, on); setVisible(k.dot, on);
        if (!on) setVisible(k.ghost, false);
        k.on = on;
      }
    });
    // Keep EV1 drawn on top of EV2.
    if (showCrew) crew[0].dot.bringToFront();

    // Rover.
    const r = sim?.rover;
    const roverVisible = showCrew && !!r?.px;
    if (roverVisible) {
      rover.setLatLng(pxToLatLng(r.px));
      rover.setStyle({ fillOpacity: r.linkOk === false ? 0.3 : 1, opacity: r.linkOk === false ? 0.4 : 1 });
      if (sim.crew[0]?.px) roverLink.setLatLngs([pxToLatLng(sim.crew[0].px), pxToLatLng(r.px)]);
      roverLink.setStyle({ opacity: r.linkOk === false ? 0 : 0.5 });
    }
    if (roverVisible !== roverOn) { setVisible(rover, roverVisible); setVisible(roverLink, roverVisible); roverOn = roverVisible; }

    if (follow && showCrew && sim.crew[0]?.px) map.panTo(pxToLatLng(sim.crew[0].px), { animate: false });

    el.classList.toggle('map-link-lost', !!sim && !linkOk);
    el.classList.toggle('map-storm', !!sim?.env?.stormActive);
  }

  // ---------------------------------------------------------------- wiring
  function renderAll(s) {
    renderLayers(s.layersOn);
    renderVariants(s);
    renderStops(s);
    renderSim(s);
  }

  map.fitBounds(bounds);
  renderScale();
  renderAll(ctx.getState());

  let prevStatusIdle = null, prevKind = null;
  ctx.subscribe((s, prev, changed) => {
    if (changed.has('layersOn')) renderLayers(s.layersOn);
    if (changed.has('mode') && s.mode === 'planner') setTimeout(() => map.invalidateSize(), 0);
    if (changed.has('sim') || changed.has('plannedVariantId') || changed.has('selectedStopId')) {
      const idle = !s.sim || s.sim.status === 'idle';
      const kind = s.sim?.active?.kind ?? null;
      if (changed.has('plannedVariantId') || idle !== prevStatusIdle || kind !== prevKind) {
        renderVariants(s);
        prevStatusIdle = idle; prevKind = kind;
      }
      const ps = prev.sim, ss = s.sim;
      if (changed.has('selectedStopId') || ps?.dropped !== ss?.dropped || ps?.visited !== ss?.visited ||
          ps?.nextStop?.id !== ss?.nextStop?.id || ps?.status !== ss?.status) {
        renderStops(s);
      }
      if (changed.has('sim')) renderSim(s);
    }
  });

  ctx.on('map:focus', (p) => {
    if (!p?.px) return;
    const ll = pxToLatLng(p.px);
    if (Number.isFinite(p.zoom)) map.setView(ll, p.zoom);
    else map.panTo(ll);
  });

  // Click empty map: clear the stop selection.
  map.on('click', () => { if (ctx.getState().selectedStopId) ctx.setState({ selectedStopId: null }); });

  // Container size changes (panel resize, window resize) keep the map correct.
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => map.invalidateSize()).observe(el);

  return { map, latLngToPx };
}
