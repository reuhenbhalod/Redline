// planner.js — the planner chrome from the mockups (docs/ui-redesign.md): left layer rail, GO TO search, layer
// legend, and the right route sheet / stop dossier. The map (map.js) and the detail cards (panels.js) are unchanged;
// this module writes the same state keys map.js already reacts to (layersOn, roverPathOn, depotOn, selectedStopId,
// plannedVariantId) and emits map:focus. It never writes state.sim.

import { fmtMin, esc, effectiveBudget, DEMO_BUDGET_NOTE } from './util.js';

const RAIL = [
  { id: 'slope', label: 'Slope' }, { id: 'nogo', label: 'No-go' }, { id: 'sand', label: 'Sand' },
  { id: 'rocky', label: 'Rock' }, { id: 'rough', label: 'Rough' }, { id: 'minerals', label: 'Mineral' },
  { id: 'geology', label: 'Geology' }, { id: 'ti', label: 'Thermal' },
  { extra: 'roverPathOn', label: 'Rover path' }, { extra: 'depotOn', label: 'Tubes' },
];
const KIND = { base: 'Base', science: 'Science', depot: 'Depot' };

export function initPlanner(ctx) {
  const { data, config } = ctx;
  const planner = document.getElementById('planner');
  const rail = document.getElementById('layer-rail');
  const goto = document.getElementById('goto');
  const legend = document.getElementById('layer-legend');
  const wrap = document.getElementById('sheet-wrap');
  const sheet = document.getElementById('route-sheet');
  if (!planner || !rail || !sheet) return null;
  const layerById = Object.fromEntries(data.layers.map((l) => [l.id, l]));

  // ------------------------------------------------------------------ layer rail
  const items = RAIL.filter((r) => (r.extra ? (r.extra === 'roverPathOn' ? !!data.roverPath : true) : !!layerById[r.id]));
  rail.innerHTML = `<span class="rl-h">Layers</span>${items.map((r) =>
    `<button type="button" class="rl-btn" data-layer="${esc(r.id || '')}" data-extra="${esc(r.extra || '')}" aria-pressed="false"
      title="${esc(r.id ? layerById[r.id].label : r.label)}">${esc(r.label)}</button>`).join('')}`;
  rail.addEventListener('click', (e) => {
    const b = e.target.closest('.rl-btn');
    if (!b) return;
    const s = ctx.getState();
    if (b.dataset.extra) ctx.setState({ [b.dataset.extra]: !(b.dataset.extra === 'depotOn' ? s.depotOn !== false : !!s[b.dataset.extra]) });
    else ctx.setState({ layersOn: { ...s.layersOn, [b.dataset.layer]: !s.layersOn?.[b.dataset.layer] } });
  });

  function renderRail(s) {
    rail.querySelectorAll('.rl-btn').forEach((b) => {
      const on = b.dataset.extra ? (b.dataset.extra === 'depotOn' ? s.depotOn !== false : !!s[b.dataset.extra]) : !!s.layersOn?.[b.dataset.layer];
      b.setAttribute('aria-pressed', String(on));
    });
    const active = data.layers.filter((l) => s.layersOn?.[l.id]);
    legend.hidden = active.length === 0;
    legend.innerHTML = active.map((l) => {
      const lg = (l.legend || []).filter((x) => x.color && !String(x.color).startsWith('ramp:'));
      const shown = lg.slice(0, 6);
      return `<div class="lg-layer"><span class="lg-name">${esc(l.label)}</span>
        <ul>${shown.map((x) => `<li><i style="background:${esc(x.color)}"></i>${esc(x.label)}</li>`).join('')}
        ${lg.length > shown.length ? `<li class="lg-more">+ ${lg.length - shown.length} more</li>` : ''}</ul>
        <span class="lg-src">${esc(l.source || '')}${l.native_res ? ` · ${esc(l.native_res)}` : ''}</span></div>`;
    }).join('');
  }

  // ------------------------------------------------------------------ GO TO search
  const places = [
    ...data.stops.map((st) => ({ label: `${st.name} (stop ${st.id})`, px: st.px, stopId: st.id, zoom: 1 })),
    ...(data.depot?.tubes || []).map((t) => ({ label: `Tube ${t.name} (${t.sampleId})`, px: t.px, zoom: 2 })),
  ];
  goto.innerHTML = `<span class="gt-k">Go to</span>
    <input type="text" list="goto-list" placeholder="stop or sample tube" aria-label="Go to a stop or sample tube">
    <datalist id="goto-list">${places.map((p) => `<option value="${esc(p.label)}"></option>`).join('')}</datalist>`;
  const gotoInput = goto.querySelector('input');
  function go() {
    const q = gotoInput.value.trim().toLowerCase();
    if (!q) return;
    const hit = places.find((p) => p.label.toLowerCase() === q) || places.find((p) => p.label.toLowerCase().includes(q));
    if (!hit) { ctx.toast({ level: 'info', title: 'Not found', text: `No stop or tube matches "${gotoInput.value}".`, timeoutMs: 2500 }); return; }
    ctx.emit('map:focus', { px: hit.px, zoom: hit.zoom });
    if (hit.stopId) ctx.setState({ selectedStopId: hit.stopId });
    if (!hit.stopId && ctx.getState().depotOn === false) ctx.setState({ depotOn: true });
    gotoInput.blur();
  }
  gotoInput.addEventListener('change', go);
  gotoInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });

  // ------------------------------------------------------------------ route sheet
  let details = false;
  sheet.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const s = ctx.getState();
    const idle = (s.sim?.status ?? 'idle') === 'idle';
    const act = t.dataset.act;
    if (act === 'start') {
      if (idle) ctx.setState({ playing: true });
      ctx.setMode('tablet');
    } else if (act === 'variant' && idle) {
      ctx.setState({ plannedVariantId: t.dataset.id });
    } else if (act === 'stop') {
      ctx.setState({ selectedStopId: t.dataset.id });
      const st = data.stopsById[t.dataset.id];
      if (st) ctx.emit('map:focus', { px: st.px, zoom: 1 });
    } else if (act === 'back') {
      ctx.setState({ selectedStopId: null });
    } else if (act === 'focus') {
      ctx.emit('map:focus', { px: JSON.parse(t.dataset.px), zoom: Number(t.dataset.zoom || 1) });
    } else if (act === 'skip' && idle) {
      ctx.setState({ plannedVariantId: t.dataset.id, selectedStopId: null });
    } else if (act === 'details') {
      details = !details;
      wrap.classList.toggle('show-details', details);
      t.setAttribute('aria-expanded', String(details));
      t.querySelector('.sh-caret').textContent = details ? '▾' : '▸';
    }
  });

  const stopName = (id) => data.stopsById[id]?.name || id;
  const variantTitle = (v) => {
    const mid = v.stops.slice(1, -1).map(stopName);
    return mid.length ? `${mid.join(' + ')} loop` : 'Walk';
  };

  function sheetHtml(s) {
    const sim = s.sim;
    const idle = (sim?.status ?? 'idle') === 'idle';
    const v = data.variantsById[s.plannedVariantId] || data.routes.variants[0];
    const b = effectiveBudget(s, config);
    const pct = Math.round((v.est_min / b.budgetMin) * 100);
    const visited = new Set(sim?.visited || []);
    const dropped = new Set(sim?.dropped || []);
    const nextId = sim?.nextStop?.id;

    // timeline from stop_plan + legs
    const rows = v.stop_plan.map((sp, i) => {
      const st = data.stopsById[sp.id];
      const leg = i > 0 ? v.legs[i - 1] : null;
      const last = i === v.stop_plan.length - 1;
      let sub;
      if (i === 0) sub = 'depart T+0:00';
      else if (last) sub = `${(leg.distance_m / 1000).toFixed(1)} km · ${Math.round(leg.walk_min)} min · back T+${fmtMin(sp.arrive_min)}`;
      else sub = `${(leg.distance_m / 1000).toFixed(1)} km · ${Math.round(leg.walk_min)} min walk · ${Math.round(sp.depart_min - sp.arrive_min)} min work`;
      const state = dropped.has(sp.id) ? 'dropped' : (!last && i > 0 && visited.has(sp.id)) ? 'done' : (sp.id === nextId && !idle && i > 0) ? 'next' : '';
      const hollow = st?.kind === 'base';
      return `<li class="tl-row ${hollow ? 'tl-base' : ''}" data-state="${state}">
        <span class="tl-dia" aria-hidden="true"></span>
        <span class="tl-txt">${esc(i === 0 || last ? st?.name || sp.id : `${sp.id} · ${st?.name || sp.id}`)}<span class="tl-sub">${esc(sub)}</span></span>
        ${st && st.kind !== 'base' ? `<button type="button" class="tl-view" data-act="stop" data-id="${esc(sp.id)}">View</button>` : '<span></span>'}
      </li>`;
    }).join('');

    const avoids = (v.why || []).filter((w) => /avoid|cuts/i.test(w)).slice(0, 3).map((w) => {
      const m = /^([^:]+):\s*(.*)$/.exec(w);
      return `<li><span class="sh-tag">${esc(/cuts/i.test(w) ? 'Cuts' : 'Avoids')}</span>${esc(m ? `${m[2]} (${m[1]})` : w).replace(/^avoids |^cuts /i, '')}</li>`;
    }).join('');

    const others = data.routes.variants.filter((x) => x.id !== v.id).map((x) =>
      `<button type="button" class="sh-backup" data-act="variant" data-id="${esc(x.id)}" ${idle ? '' : 'disabled'}
        title="${idle ? 'Make this the plan' : 'Reset the sim to change the plan'}">
        <span>Backup: ${esc(x.stops.join(' → '))}</span><span class="sh-mono">${esc((x.distance_m / 1000).toFixed(1))} KM · ${esc(fmtMin(x.est_min))}</span></button>`).join('');

    // safety strip
    const env = data.env || {};
    const tau = env.dustTau?.estimate;
    const sw = env.spaceWeather;
    const rad = env.radiation;
    const planW = Math.min(100, (v.est_min / b.budgetMin) * 100);
    const resW = (b.reserveMin / b.budgetMin) * 100;

    return `
      <div class="sh-head">
        <span class="sh-k">EVA 01 · 2 crew + rover · plan "${esc(v.id)}"</span>
        <h1 class="sh-title">${esc(variantTitle(v))}</h1>
        <div class="sh-stats">
          <div><b>${esc(fmtMin(v.est_min))}</b><span>HRS</span></div>
          <div><b>${esc((v.distance_m / 1000).toFixed(1))}</b><span>KM</span></div>
          <div><b class="${v.fits_budget === false ? 'sh-bad' : 'sh-good'}">${esc(pct)}%</b><span>OF SUIT TIME</span></div>
        </div>
      </div>
      <ol class="sh-tl">${rows}</ol>
      ${avoids ? `<ul class="sh-avoid">${avoids}</ul>` : ''}
      ${others}
      <button type="button" class="sh-start" data-act="start">${idle ? 'Start EVA' : 'Open astronaut tablet'}</button>
      <div class="sh-safety">
        <div class="sh-sbar-labels"><span>SUIT ${esc(fmtMin(b.budgetMin))}${b.demo ? ' (DEMO)' : ''}</span><span>PLAN ${esc(fmtMin(v.est_min))}</span><span class="sh-amber">RESERVE ${esc(fmtMin(b.reserveMin))}</span></div>
        <div class="sh-sbar"><i style="width:${planW.toFixed(1)}%"></i><i class="sh-sbar-gap"></i><i class="sh-sbar-res" style="width:${resW.toFixed(1)}%"></i></div>
        ${b.demo ? `<span class="sh-demo">${esc(DEMO_BUDGET_NOTE)} (real ${esc(b.realBudgetMin)} min)</span>` : ''}
        <div class="sh-chips">
          <span><i class="${tau != null && tau < 0.6 ? 'ok' : 'warn'}"></i>DUST ${tau != null ? `τ${esc(tau.toFixed(2))}` : '?'}</span>
          <span><i class="${sw?.solarAlert ? 'bad' : 'ok'}"></i>${sw?.solarAlert ? 'SOLAR ALERT' : 'NO CME DUE'}</span>
          <span title="${esc(rad?.note || '')}"><i class="dim"></i>${rad?.doseUGyPerDay ? `${esc((rad.doseUGyPerDay / 1000).toFixed(2))} mGy/d` : 'RAD n/a'}</span>
        </div>
      </div>
      <button type="button" class="sh-details" data-act="details" aria-expanded="${details}">
        <span>Mission details: safety, environment, credits</span><span class="sh-caret">${details ? '▾' : '▸'}</span></button>`;
  }

  function dossierHtml(s, id) {
    const st = data.stopsById[id];
    const v = data.variantsById[s.plannedVariantId] || data.routes.variants[0];
    const idx = v.stop_plan.findIndex((sp) => sp.id === id && sp.path_index > 0);
    const sp = idx >= 0 ? v.stop_plan[idx] : null;
    const kmFromH = sp ? v.legs.slice(0, idx).reduce((a, l) => a + l.distance_m, 0) / 1000 : null;
    const sci = data.stops.filter((x) => x.kind !== 'base');
    const order = sci.findIndex((x) => x.id === id);
    const ph = data.photosByStop?.[id] || {};
    const cands = (ph.candidates || []).filter((c) => c.url);
    const feat = (ph.featured || []).filter((c) => c.url);
    const big = cands[0] || feat[0];
    const small = cands.slice(1, 3);
    const strip = feat[0] && feat[0] !== big ? feat[0] : null;
    const credit = big?.credit || strip?.credit || 'NASA/JPL-Caltech';
    const homeMin = sp ? sp.home_min : ctx.timeHomeAt(st.px);
    const skipVariant = data.routes.variants.find((x) => !x.stops.includes(id));
    const idle = (s.sim?.status ?? 'idle') === 'idle';
    const img = (c, cls) => `<img class="${cls}" src="${esc(c.thumb && cls !== 'ds-big' ? c.thumb : c.url)}" alt="${esc(c.caption || `Perseverance ${c.camera || ''} sol ${c.sol ?? ''}`)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'${cls} ds-missing',textContent:'Photo unavailable'}))">`;
    const tubes = id === 'B' ? (data.depot?.tubes || []) : [];
    return `
      <div class="ds-top"><button type="button" class="ds-back" data-act="back">← Route</button>
        <span class="sh-k">${st.kind === 'base' ? 'Base' : `Stop ${order + 1} of ${sci.length}`} · ${esc(KIND[st.kind] || st.kind)}</span></div>
      <h1 class="sh-title">${esc(st.name)}</h1>
      <p class="ds-lead">${esc(st.why || ph.note || '')}</p>
      ${big ? `<div class="ds-photos ${small.length ? '' : 'ds-one'}">${img(big, 'ds-big')}${small.map((c) => img(c, 'ds-small')).join('')}</div>` : ''}
      ${strip ? img(strip, 'ds-strip') : ''}
      ${big || strip ? `<span class="ds-credit">${esc(credit)}${ph.note && st.kind === 'base' ? ` · ${esc(ph.note)}` : ''}</span>` : ''}
      <div class="ds-stats">
        <div><b>${kmFromH != null ? esc(kmFromH.toFixed(1)) : '—'}</b><span>KM FROM H</span></div>
        <div><b>${sp ? esc(fmtMin(sp.arrive_min)) : '—'}</b><span>ARRIVE</span></div>
        <div><b>${st.work_min ? esc(fmtMin(st.work_min)) : '—'}</b><span>WORK</span></div>
        <div><b>${homeMin != null ? esc(fmtMin(homeMin)) : '—'}</b><span>TIME HOME</span></div>
      </div>
      ${st.expect ? `<h2 class="ds-h">What to expect</h2><p class="ds-p">${esc(st.expect)}</p>` : ''}
      ${(st.rock_unit || st.minerals) ? `<div class="ds-facts">
        ${st.rock_unit ? `<div><span class="sh-k">Rock unit</span>${esc(st.rock_unit)}</div>` : ''}
        ${st.minerals ? `<div><span class="sh-k">Minerals · CRISM</span>${esc(st.minerals)}</div>` : ''}</div>` : ''}
      ${tubes.length ? `<h2 class="ds-h">Sample tubes (${tubes.length})</h2><ul class="ds-tubes">${tubes.map((t) =>
        `<li><button type="button" data-act="focus" data-px="${esc(JSON.stringify(t.px))}" data-zoom="2">${esc(t.name)}</button><span>${esc(t.sampleId)} · dropped sol ${esc(t.dropSol ?? '?')}</span></li>`).join('')}</ul>` : ''}
      <div class="ds-actions">
        <button type="button" class="sh-start" data-act="focus" data-px="${esc(JSON.stringify(st.px))}" data-zoom="1">Show on map</button>
        <button type="button" class="ds-skip" data-act="skip" data-id="${esc(skipVariant?.id || '')}" ${skipVariant && idle && st.kind !== 'base' ? '' : 'disabled'}
          title="${skipVariant ? (idle ? `Use plan ${skipVariant.id} (${skipVariant.stops.join(' → ')})` : 'Reset the sim to change the plan') : 'No plan without this stop'}">Skip stop</button>
      </div>`;
  }

  let lastKey = '';
  function renderSheet(s) {
    const sim = s.sim;
    const key = [s.selectedStopId, s.plannedVariantId, s.demoBudgetMin, sim?.status, (sim?.visited || []).join(), (sim?.dropped || []).join(), sim?.nextStop?.id].join('|');
    if (key === lastKey) return;
    lastKey = key;
    sheet.dataset.view = s.selectedStopId ? 'stop' : 'route';
    sheet.innerHTML = s.selectedStopId && data.stopsById[s.selectedStopId] ? dossierHtml(s, s.selectedStopId) : sheetHtml(s);
    sheet.scrollTop = 0;
  }

  // Frame the planned route in the open map area between the rail and the sheet (the mockup's opening view).
  function frameRoute() {
    const s = ctx.getState();
    if (s.mode !== 'planner' || s.selectedStopId) return;
    const v = data.variantsById[s.plannedVariantId] || data.routes.variants[0];
    const xs = v.path.map((p) => p[0]), ys = v.path.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const box = planner.getBoundingClientRect();
    const left = rail.getBoundingClientRect().right - box.left + 24;
    const right = (wrap.getBoundingClientRect().left - box.left) - 24;
    const availW = Math.max(200, right - left), availH = Math.max(200, box.height - 140);
    const z = Math.max(-2, Math.min(1, Math.floor(Math.log2(Math.min(availW / (x1 - x0 + 160), availH / (y1 - y0 + 160))) * 4) / 4));
    const scale = 2 ** -z;                                    // grid px per screen px at zoom z
    const shiftX = (box.width / 2 - (left + right) / 2) * scale;
    ctx.emit('map:focus', { px: [(x0 + x1) / 2 + shiftX, (y0 + y1) / 2], zoom: z });
  }
  requestAnimationFrame(frameRoute);

  renderRail(ctx.getState());
  renderSheet(ctx.getState());
  ctx.subscribe((s, prev, changed) => {
    if (changed.has('layersOn') || changed.has('roverPathOn') || changed.has('depotOn')) renderRail(s);
    if (changed.has('sim') || changed.has('selectedStopId') || changed.has('plannedVariantId') || changed.has('demoBudgetMin')) renderSheet(s);
  });
  return { renderSheet };
}
