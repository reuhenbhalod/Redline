// map.js — Leaflet map for planner mode. Owner: map agent (map.js + map.css).
// Contract: INTERFACES.md "map.js". All px <-> LatLng conversion goes through util.js.
//
// Layers are built once in initMap and then only updated (setLatLngs / setLatLng /
// setRadius / setStyle / class toggles) from the state subscriber, so the ~60 Hz sim
// tick never re-creates Leaflet layers.

import { createSmoother } from './smooth.js';
import {
  pxToLatLng, latLngToPx, imageBounds, pathToLatLngs, lerpPx, clamp, esc, fmtDistM, fmtMinLong,
  pxToLonLat, fmtLonLat, basisLabel,
} from './util.js';

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
    roverPath: v('--rover-path', '#c9a0ff'),
    tube: v('--tube', '#ffffff'),
  };
}

/** Basis badge from style.css: PRIMARY / SECONDARY / ASSUMPTION / DEMO. */
function basisTag(basis) {
  return `<span class="basis" data-basis="${esc(basis)}">${esc(basisLabel(basis))}</span>`;
}

/** Layer note text with "(assumption)" / "(secondary)" / "(primary)" turned into basis badges. */
function noteHtml(note) {
  return esc(note).replace(/\((assumption|secondary|primary)\)/gi, (_, b) => basisTag(b.toLowerCase()));
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

  // 100 m survey grid, registered to the image (an SVG overlay on the same bounds, so it scales with zoom).
  {
    const gw = ctx.config.widthPx, gh = ctx.config.heightPx;
    const sp = 100 / (ctx.config.pixelM || 2);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${gw}" height="${gh}" viewBox="0 0 ${gw} ${gh}">`
      + `<defs><pattern id="g" width="${sp}" height="${sp}" patternUnits="userSpaceOnUse">`
      + `<path d="M${sp} 0H0V${sp}" fill="none" stroke="rgb(244,237,228)" stroke-opacity="0.16" stroke-width="1.4"/></pattern></defs>`
      + `<rect width="${gw}" height="${gh}" fill="url(#g)"/></svg>`;
    L.imageOverlay(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, bounds,
      { pane: 'map-base', interactive: false, className: 'map-grid' }).addTo(map);
  }

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
  const layerById = Object.fromEntries(data.layers.map((l) => [l.id, l]));
  const groups = Array.isArray(data.layerGroups) && data.layerGroups.length
    ? data.layerGroups
    : [{ id: 'all', label: 'Overlays', layerIds: data.layers.map((l) => l.id) }];

  const roverPath = data.roverPath && Array.isArray(data.roverPath.segments) && data.roverPath.segments.length ? data.roverPath : null;
  const tubes = Array.isArray(data.depot?.tubes) ? data.depot.tubes.filter((t) => Array.isArray(t.px)) : [];

  const LayerControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const box = L.DomUtil.create('div', 'map-ctl map-layers');
      L.DomEvent.disableClickPropagation(box);
      L.DomEvent.disableScrollPropagation(box);
      const layerRow = (layer) => {
        const legendItems = layer.legend || [];
        const legend = legendItems.map((l) => {
          const assumed = /assumption/i.test(l.label || '') || (data.fake && /limit|no-go|threshold/i.test(l.label || ''));
          return `<li><span class="map-sw" style="background:${esc(l.color)}"></span><span class="map-lg-t">${esc(l.label)}</span>${assumed ? ` ${basisTag('assumption')}` : ''}</li>`;
        }).join('');
        const long = legendItems.length > 8;
        const info = [layer.source, layer.native_res, layer.time_frame].filter(Boolean);
        const hover = [
          layer.source && `Source: ${layer.source}`,
          layer.native_res && `Resolution: ${layer.native_res}`,
          layer.time_frame && `Time frame: ${layer.time_frame}`,
          layer.note && `Note: ${layer.note}`,
        ].filter(Boolean).join('\n');
        return `<div class="map-layer" data-layer="${esc(layer.id)}">
          <label class="map-layer-head" title="${esc(hover)}"><input type="checkbox" data-layer-cb="${esc(layer.id)}"> <span>${esc(layer.label)}</span></label>
          <div class="map-layer-body">
            ${info.length ? `<div class="map-layer-info">${info.map(esc).join(' · ')}</div>` : ''}
            ${layer.note ? `<div class="map-layer-note">${noteHtml(layer.note)}</div>` : ''}
            ${long
              ? `<details class="map-legend-more"><summary>Legend (${legendItems.length} classes)</summary><ul class="map-legend map-legend-scroll">${legend}</ul></details>`
              : `<ul class="map-legend">${legend}</ul>`}
            <label class="map-opacity">opacity <input type="range" min="0.1" max="1" step="0.05" value="${opacity[layer.id]}" data-layer-op="${esc(layer.id)}"></label>
          </div>
        </div>`;
      };
      const groupHtml = groups.map((g) => {
        const rows = g.layerIds.map((id) => layerById[id]).filter(Boolean).map(layerRow).join('');
        return rows ? `<div class="map-group"><div class="map-group-title">${esc(g.label)}</div>${rows}</div>` : '';
      }).join('');

      const realRows = [];
      if (roverPath) {
        const sr = roverPath.solRange;
        realRows.push(`<div class="map-layer map-layer-extra" data-extra="rover">
          <label class="map-layer-head" title="${esc(roverPath.source)}"><input type="checkbox" data-extra-cb="roverPathOn"> <span class="map-sw map-sw-line" style="background:var(--rover-path)"></span><span>Perseverance traverse (real)</span></label>
          <div class="map-layer-body"><div class="map-layer-info">${sr ? `Sols ${esc(sr[0])}–${esc(sr[1])} · ` : ''}${esc(roverPath.segments.length)} drives in the box · ${esc(roverPath.source)}</div></div>
        </div>`);
      }
      if (tubes.length) {
        const credit = [...new Set(tubes.map((t) => t.credit).filter(Boolean))].join('; ');
        realRows.push(`<div class="map-layer map-layer-extra" data-extra="depot">
          <label class="map-layer-head"><input type="checkbox" data-extra-cb="depotOn"> <span class="map-sw map-sw-dot" style="background:var(--tube)"></span><span>Depot sample tubes (${esc(tubes.length)})</span></label>
          <div class="map-layer-body"><div class="map-layer-info">Three Forks depot, real drop positions. Zoom in to see each tube; click one for its close-up.${credit ? ` ${esc(credit)}` : ''}</div></div>
        </div>`);
      }
      const realHtml = realRows.length ? `<div class="map-group"><div class="map-group-title">Real rover data</div>${realRows.join('')}</div>` : '';

      box.innerHTML = `<button type="button" class="map-ctl-title map-ctl-toggle" aria-expanded="true" data-act="toggle-layers">
          <span>Layers</span><span class="map-ctl-count"></span><span class="map-ctl-caret" aria-hidden="true">▾</span></button>
        <div class="map-layers-body">${groupHtml || '<div class="map-empty">No overlays in layers.json</div>'}${realHtml}</div>`;
      box.addEventListener('click', (e) => {
        if (!e.target?.closest?.('[data-act="toggle-layers"]')) return;
        setCollapsed(!box.classList.contains('is-collapsed'));
      });
      box.addEventListener('change', (e) => {
        const ds = e.target?.dataset || {};
        if (ds.layerCb) {
          const s = ctx.getState();
          ctx.setState({ layersOn: { ...s.layersOn, [ds.layerCb]: e.target.checked } });
        } else if (ds.extraCb) {
          ctx.setState({ [ds.extraCb]: e.target.checked });
        }
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
  const layerCount = layerBox.querySelector('.map-ctl-count');
  function setCollapsed(c) {
    layerBox.classList.toggle('is-collapsed', c);
    layerBox.querySelector('[data-act="toggle-layers"]')?.setAttribute('aria-expanded', String(!c));
  }
  // Narrower maps (e.g. 1280 px laptops, map ~960 px): start collapsed so the control does not cover the route or H.
  if (el.clientWidth && el.clientWidth < 1000) setCollapsed(true);
  // Keep the open control inside the map (it scrolls when taller).
  function fitLayerBox() {
    const h = el.clientHeight;
    if (h) layerBox.querySelector('.map-layers-body').style.maxHeight = `${Math.max(120, h - 90)}px`;
  }

  function renderLayers(layersOn) {
    let n = 0;
    for (const layer of data.layers) {
      const on = !!layersOn?.[layer.id];
      if (on) n++;
      const ov = overlays[layer.id];
      if (on && !map.hasLayer(ov)) ov.addTo(map);
      if (!on && map.hasLayer(ov)) map.removeLayer(ov);
      const cb = layerBox.querySelector(`[data-layer-cb="${CSS.escape(layer.id)}"]`);
      if (cb) cb.checked = on;
      layerBox.querySelector(`[data-layer="${CSS.escape(layer.id)}"]`)?.classList.toggle('is-on', on);
    }
    layerCount.textContent = n ? `${n} on` : '';
  }

  function renderExtras(s) {
    for (const [key, extra] of [['roverPathOn', 'rover'], ['depotOn', 'depot']]) {
      const on = !!s[key];
      const cb = layerBox.querySelector(`[data-extra-cb="${key}"]`);
      if (cb) cb.checked = on;
      layerBox.querySelector(`[data-extra="${extra}"]`)?.classList.toggle('is-on', on);
    }
    renderRoverPath(!!s.roverPathOn);
    renderTubes(s.depotOn !== false);
  }

  // ---------------------------------------------------------------- Perseverance traverse (real)
  mkPane('map-rover-path', 320);
  const roverPathRenderer = L.svg({ pane: 'map-rover-path', padding: 0.5 });
  const roverPathLayer = L.layerGroup();
  if (roverPath) {
    const color = C.roverPath;
    const ranges = [
      ['A', data.photosByStop?.A?.parkedSols, data.stopsById?.A?.name || 'Stop A'],
      ['B', data.photosByStop?.B?.parkedSols, data.stopsById?.B?.name || 'Depot'],
    ].map(([id, sols, name]) => (Array.isArray(sols) && sols.length ? { id, name, lo: Math.min(...sols), hi: Math.max(...sols) } : null))
      .filter(Boolean);
    const inRange = (sol) => ranges.find((r) => sol >= r.lo && sol <= r.hi) || null;
    for (const seg of roverPath.segments) {
      const r = inRange(seg.sol);
      L.polyline(pathToLatLngs(seg.px), {
        renderer: roverPathRenderer, pane: 'map-rover-path', color, weight: r ? 2.4 : 1.6, opacity: r ? 0.95 : 0.75,
        lineJoin: 'round', lineCap: 'round', className: 'map-rover-path',
      }).bindTooltip(`Sol ${esc(seg.sol)}${r ? ` · rover parked near ${esc(r.name)} (sols ${r.lo}–${r.hi})` : ''}`, {
        sticky: true, className: 'map-tip', direction: 'top', offset: [0, -6],
      }).addTo(roverPathLayer);
    }
    // Sol labels: one per ~50 sols, plus the sol ranges at stop A and at the depot. Skip labels that crowd each other.
    const labels = [];
    for (const r of ranges) {
      const seg = roverPath.segments.find((g) => g.sol >= r.lo && g.sol <= r.hi);
      if (seg) labels.push({ px: seg.px[0], text: `Sols ${r.lo}–${r.hi} (${r.id})`, key: true });
    }
    let nextMark = Math.ceil((roverPath.solRange?.[0] ?? 0) / 50) * 50;
    for (const seg of roverPath.segments) {
      if (seg.sol >= nextMark) {
        labels.push({ px: seg.px[0], text: `Sol ${seg.sol}`, key: false });
        nextMark = Math.floor(seg.sol / 50) * 50 + 50;
      }
    }
    // Key labels sit left of their point (stop names extend to the right); plain sol labels avoid the stops.
    const stopPx = data.stops.map((st) => st.px).filter(Array.isArray);
    const placed = [];
    for (const lb of labels) {
      if (placed.some((p) => Math.hypot(p[0] - lb.px[0], p[1] - lb.px[1]) < 45)) continue;
      if (!lb.key && stopPx.some((p) => Math.hypot(p[0] - lb.px[0], p[1] - lb.px[1]) < 60)) continue;
      placed.push(lb.px);
      L.marker(pxToLatLng(lb.px), {
        pane: 'map-rover-path', interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'map-sol-wrap', iconSize: [0, 0], html: `<span class="map-sol${lb.key ? ' is-key is-left' : ''}">${esc(lb.text)}</span>` }),
      }).addTo(roverPathLayer);
    }
  }
  function renderRoverPath(on) {
    if (!roverPath) return;
    if (on && !map.hasLayer(roverPathLayer)) roverPathLayer.addTo(map);
    if (!on && map.hasLayer(roverPathLayer)) map.removeLayer(roverPathLayer);
  }

  // ---------------------------------------------------------------- depot sample tubes (real)
  mkPane('map-tubes', 620);
  const tubesRenderer = L.svg({ pane: 'map-tubes', padding: 0.5 });
  const TUBE_ZOOM = 1;                          // below this, one "10 tubes" marker (they sit within ~35 m)
  const tubeLayer = L.layerGroup();
  const tubeCluster = L.layerGroup();
  if (tubes.length) {
    for (const t of tubes) {
      const ll = Number.isFinite(t.lon) && Number.isFinite(t.lat) ? [t.lon, t.lat] : pxToLonLat(t.px, data.geo);
      const cored = [
        Number.isFinite(t.coredSol) ? `cored on sol ${esc(t.coredSol)}` : '',
        t.coredLonLat ? `at ${esc(fmtLonLat(t.coredLonLat, 4))}` : '',
      ].filter(Boolean).join(' ');
      const img = t.closeup
        ? `<a class="map-tube-img" href="${esc(t.closeup)}" target="_blank" rel="noopener"><img loading="lazy" alt="Close-up of tube ${esc(t.name)}" src="${esc(t.closeup)}"></a>`
        : '';
      const html = `<div class="map-tube-pop">
          <div class="map-tube-title">${esc(t.name)} <span class="map-tube-id">${esc(t.sampleId)}</span></div>
          <div class="map-tube-meta">Dropped on sol ${esc(t.dropSol ?? '?')}${cored ? ` · ${cored}` : ''}</div>
          ${ll ? `<div class="map-tube-meta">${esc(fmtLonLat(ll, 6))}</div>` : ''}
          ${img}
          ${t.closeupDem ? `<div class="map-tube-meta"><a href="${esc(t.closeupDem)}" target="_blank" rel="noopener">Close-up height map (DEM)</a></div>` : ''}
          ${t.credit ? `<div class="map-tube-credit">Image: ${esc(t.credit)}</div>` : ''}
        </div>`;
      const marker = L.circleMarker(pxToLatLng(t.px), {
        renderer: tubesRenderer, pane: 'map-tubes', radius: 4.5, color: '#160d08', weight: 1.5,
        fillColor: C.tube, fillOpacity: 1, className: 'map-tube',
      }).bindTooltip(`${esc(t.name)} · sol ${esc(t.dropSol ?? '?')}`, { className: 'map-tip', direction: 'top', offset: [0, -5] });
      // Popup content is one DOM element per tube, built on first open (so the close-up only loads
      // then). Leaflet's update() re-appends the same element, so the broken-image fallback sticks.
      let el = null;
      const relayout = () => { const pp = marker.getPopup(); if (pp && pp.isOpen()) pp.update(); };
      marker.bindPopup(() => {
        if (el) return el;
        el = document.createElement('div');
        el.innerHTML = html;
        el = el.firstElementChild;
        const im = el.querySelector('.map-tube-img img');
        if (im) {
          im.addEventListener('error', () => {
            const a = im.parentElement;
            im.remove();
            a.classList.add('is-broken');
            a.textContent = 'Open the close-up image (could not load it here)';
            relayout();
          }, { once: true });
          im.addEventListener('load', relayout, { once: true });
        }
        return el;
      }, { className: 'map-popup', maxWidth: 260, minWidth: 220 }).addTo(tubeLayer);
    }
    const c = data.depot?.center?.px || tubes[0].px;
    L.marker(pxToLatLng(c), {
      pane: 'map-tubes', keyboard: true, title: `${tubes.length} depot sample tubes: zoom in`,
      icon: L.divIcon({ className: 'map-tubes-wrap', iconSize: [0, 0], html: `<span class="map-tubes-badge">${esc(tubes.length)} tubes</span>` }),
    }).on('click', (e) => { L.DomEvent.stopPropagation(e); map.setView(pxToLatLng(c), TUBE_ZOOM + 1); })
      .addTo(tubeCluster);
  }
  let tubesShown = null;
  function renderTubes(on) {
    if (!tubes.length) return;
    const detail = map.getZoom() >= TUBE_ZOOM;
    const key = on ? (detail ? 'detail' : 'cluster') : 'off';
    if (key === tubesShown) return;
    tubesShown = key;
    if (key === 'detail') tubeLayer.addTo(map); else map.removeLayer(tubeLayer);
    if (key === 'cluster') tubeCluster.addTo(map); else map.removeLayer(tubeCluster);
  }
  map.on('zoomend', () => renderTubes(ctx.getState().depotOn !== false));

  // ---------------------------------------------------------------- imagery credit
  const ortho = (data.provenance?.sources || []).find((s) => /orthomosaic/i.test(s.name || ''));
  const cm = data.layersMeta?.contextMap;
  const creditBits = [
    ortho ? `Basemap: ${esc(ortho.name)} · ${esc(ortho.credit)}` : '',
    cm?.source ? `Context: ${esc(cm.source)}${cm.layers?.length ? ` (${esc(cm.layers.join('; '))})` : ''}` : '',
  ].filter(Boolean);
  if (creditBits.length) {
    const CreditControl = L.Control.extend({
      options: { position: 'bottomright' },
      onAdd() {
        const box = L.DomUtil.create('div', 'map-credit');
        box.innerHTML = creditBits.join('<br>');
        return box;
      },
    });
    new CreditControl().addTo(map);
  }

  // ---------------------------------------------------------------- cursor lon/lat readout
  if (data.geo) {
    const ReadoutControl = L.Control.extend({
      options: { position: 'bottomright' },
      onAdd() {
        const box = L.DomUtil.create('div', 'map-ctl map-readout');
        box.innerHTML = `<div class="map-readout-ll">Move the cursor over the map</div>
          <div class="map-readout-sub"><span class="map-readout-px"></span><span class="map-readout-home"></span></div>
          <div class="map-readout-note" title="${esc(data.geo.method || 'linear interpolation between the bounds.json corners')}">approx. (linear between corners)${data.geo.fake ? ' · FAKE coordinates' : ''}</div>`;
        return box;
      },
    });
    const ro = new ReadoutControl().addTo(map).getContainer();
    const roLL = ro.querySelector('.map-readout-ll');
    const roPx = ro.querySelector('.map-readout-px');
    const roHome = ro.querySelector('.map-readout-home');
    let raf = 0, lastLL = null;
    const paint = () => {
      raf = 0;
      if (!lastLL) return;
      const px = latLngToPx(lastLL);
      if (px[0] < 0 || px[1] < 0 || px[0] > W || px[1] > H) {
        roLL.textContent = 'Outside the map';
        roPx.textContent = ''; roHome.textContent = '';
        return;
      }
      roLL.textContent = fmtLonLat(pxToLonLat(px, data.geo), 5);
      roPx.textContent = `px ${Math.round(px[0])}, ${Math.round(px[1])}`;
      const th = ctx.timeHomeAt?.(px);
      roHome.textContent = th == null ? ' · no way home' : ` · ${fmtMinLong(th)} home`;
      ro.classList.toggle('is-unreachable', th == null);
    };
    map.on('mousemove', (e) => { lastLL = e.latlng; if (!raf) raf = requestAnimationFrame(paint); });
    map.on('mouseout', () => {
      lastLL = null;
      roLL.textContent = 'Move the cursor over the map';
      roPx.textContent = ''; roHome.textContent = '';
      ro.classList.remove('is-unreachable');
    });
  }

  // ---------------------------------------------------------------- scale bar + north note
  const ScaleControl = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd() {
      const box = L.DomUtil.create('div', 'map-ctl map-scale');
      box.innerHTML = `<div class="map-scale-bar"><span class="map-scale-label"></span></div>
        <div class="map-scale-note">1 px = ${esc(pixelM)} m · map up = north ${data.geo && !data.geo.fake && data.geo.crs
          ? `<em class="map-crs" title="${esc(data.geo.crs)}">(equirectangular grid)</em>`
          : '<em class="map-assume">(assumption)</em>'}</div>`;
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
  const FOLLOW_ZOOM = 1.5;   // close-up for Follow crew (about 0.7 m per screen pixel)
  const ViewControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const box = L.DomUtil.create('div', 'map-ctl map-view leaflet-bar');
      L.DomEvent.disableClickPropagation(box);
      box.innerHTML = `<button type="button" class="map-btn" data-act="follow" aria-pressed="false" title="Zoom in on EV1 and keep the crew centered">Follow crew</button>`;
      box.addEventListener('click', (e) => {
        const act = e.target?.closest?.('[data-act]')?.dataset.act;
        if (act === 'follow') {
          follow = !follow; syncFollowBtn();
          // zoom in on EV1 (at the habitat before the walk starts) and keep the crew centered from then on
          const px = ctx.getState().sim?.crew?.[0]?.px || data.stopsById.H?.px;
          if (follow && px) map.setView(pxToLatLng(px), Math.max(map.getZoom(), FOLLOW_ZOOM));
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
  // Rover-camera hazard (rock field) once confirmed, and upcoming mid-leg checkpoints.
  const hazardCircle = L.circle(pxToLatLng([0, 0]), {
    radius: 1, color: '#e5484d', weight: 2, dashArray: '4 4', fillColor: '#e5484d', fillOpacity: 0.25, interactive: true,
  }).bindTooltip('Rock field (rover camera)', { direction: 'top' });
  const cpLayer = L.layerGroup().addTo(map);
  let lastHazardKey = '', lastCpKey = '';

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

  // Sub-pixel dot layer for the moving crew and rover. Leaflet rounds marker positions to whole screen pixels,
  // so at ~2 px of motion per frame the dots stepped 2-3-2-3 px and looked jittery. These elements live in the
  // crew pane (so they pan with the map) and are placed with unrounded layer coordinates + translate3d.
  // The Leaflet crew/rover markers above are kept only as position holders (never added to the map).
  const dotLayer = L.DomUtil.create('div', 'map-dots', map.getPane('map-crew'));
  const mkDot = (cls) => { const e = L.DomUtil.create('div', cls, dotLayer); e.style.display = 'none'; return e; };
  const dots = {
    ring: [mkDot('map-ring map-ring-1'), mkDot('map-ring map-ring-2')],
    crew: [null, null],
    rover: mkDot('map-dot map-dot-rover'),
  };
  dots.crew[1] = mkDot('map-dot map-dot-ev2');
  dots.crew[0] = mkDot('map-dot map-dot-ev1');   // created last: EV1 draws on top of EV2
  const dotPos = new Map();   // element -> { ll, rPx }
  function placeDot(e, ll, rPx = null) {
    dotPos.set(e, { ll, rPx });
    const p = map.project(ll, map.getZoom()).subtract(map.getPixelOrigin());
    if (rPx != null) {
      const d = Math.max(2, 2 * rPx * map.getZoomScale(map.getZoom(), 0));
      e.style.width = e.style.height = `${d}px`;
    }
    e.style.transform = `translate3d(${p.x}px, ${p.y}px, 0) translate(-50%, -50%)`;
  }
  const showDot = (e, on) => { const v = on ? '' : 'none'; if (e.style.display !== v) e.style.display = v; };
  map.on('zoomanim', () => dotLayer.classList.add('is-zooming'));
  map.on('zoomend viewreset', () => {
    for (const [e, { ll, rPx }] of dotPos) placeDot(e, ll, rPx);
    dotLayer.classList.remove('is-zooming');
  });

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

  const smooth = createSmoother();     // display-only smoothing of the moving markers (see smooth.js)
  let lastLinkOk = null;
  function renderSim(s) {
    const sim = s.sim;
    const a = sim?.active;
    const snap = !s.playing;            // paused / seeking: draw the exact sim positions

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

    // Rock field confirmed by the rover camera.
    const hz = sim?.hazard;
    const hzKey = hz ? `${hz.px}|${hz.radiusPx}` : '';
    if (hzKey !== lastHazardKey) {
      if (hz) { hazardCircle.setLatLng(pxToLatLng(hz.px)); hazardCircle.setRadius(hz.radiusPx); }
      setVisible(hazardCircle, !!hz);
      lastHazardKey = hzKey;
    }

    // Upcoming checkpoints on the active route (small ticks where the replan rule is re-checked).
    const cps = sim && sim.status !== 'idle' ? (sim.checkpoints || []) : [];
    const cpKey = cps.map((c) => c.px.join(',')).join(';');
    if (cpKey !== lastCpKey) {
      cpLayer.clearLayers();
      for (const c of cps) {
        L.circleMarker(pxToLatLng(c.px), { radius: 3, color: '#f5f1e8', weight: 1.5, fillColor: '#6cb4ee', fillOpacity: 1, interactive: false })
          .addTo(cpLayer);
      }
      lastCpKey = cpKey;
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
    const linkChanged = linkOk !== lastLinkOk;
    lastLinkOk = linkOk;
    sim?.crew?.slice(0, 2).forEach((c, i) => {
      const k = crew[i];
      if (!k || !c?.px) return;
      const ll = pxToLatLng(smooth(`crew${i}`, c.px, { snap }));
      k.dot.setLatLng(ll);
      k.ring.setLatLng(ll);
      placeDot(dots.crew[i], ll);
      placeDot(dots.ring[i], ll, Math.max(0.5, (c.uncertaintyM || 0) / pixelM));
      const ghost = !linkOk && c.truePx && !samePx(c.truePx, c.px);
      if (ghost) k.ghost.setLatLng(pxToLatLng(c.truePx));
      setVisible(k.ghost, ghost && showCrew);
    });
    let shown = false;
    crew.forEach((k, i) => {
      const on = showCrew && !!sim.crew[i]?.px;
      if (on !== k.on) {
        showDot(dots.ring[i], on); showDot(dots.crew[i], on);
        if (!on) setVisible(k.ghost, false);
        k.on = on;
        shown = true;
      }
    });
    if (linkChanged) dotLayer.classList.toggle('is-link-lost', !linkOk);

    // Rover.
    const r = sim?.rover;
    const roverVisible = showCrew && !!r?.px;
    if (roverVisible) {
      const rp = smooth('rover', r.px, { snap });
      rover.setLatLng(pxToLatLng(rp));
      placeDot(dots.rover, pxToLatLng(rp));
      if (linkChanged || roverVisible !== roverOn) {
        dots.rover.classList.toggle('is-off', r.linkOk === false);
        roverLink.setStyle({ opacity: r.linkOk === false ? 0 : 0.5 });
      }
      if (sim.crew[0]?.px) roverLink.setLatLngs([crew[0].dot.getLatLng(), pxToLatLng(rp)]);   // tether from the drawn EV1 dot
    }
    if (roverVisible !== roverOn) { showDot(dots.rover, roverVisible); setVisible(roverLink, roverVisible); roverOn = roverVisible; }

    if (follow && showCrew && sim.crew[0]?.px) map.panTo(crew[0].dot.getLatLng(), { animate: false });

    el.classList.toggle('map-link-lost', !!sim && !linkOk);
    el.classList.toggle('map-storm', !!sim?.env?.stormActive);
  }

  // ---------------------------------------------------------------- wiring
  function renderAll(s) {
    renderLayers(s.layersOn);
    renderExtras(s);
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
    if (changed.has('roverPathOn') || changed.has('depotOn')) renderExtras(s);
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
  fitLayerBox();
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { map.invalidateSize(); fitLayerBox(); }).observe(el);

  return { map, latLngToPx };
}
