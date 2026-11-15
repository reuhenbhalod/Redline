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
      if (l.id === 'minerals') return mineralLegend(l);
      const lg = (l.legend || []).filter((x) => x.color && !String(x.color).startsWith('ramp:'));
      const shown = lg.slice(0, 6);
      return `<div class="lg-layer"><span class="lg-name">${esc(l.label)}</span>
        <ul>${shown.map((x) => `<li><i style="background:${esc(x.color)}"></i>${esc(x.label)}</li>`).join('')}
        ${lg.length > shown.length ? `<li class="lg-more">+ ${lg.length - shown.length} more</li>` : ''}</ul>
        <span class="lg-src">${esc(l.source || '')}${l.native_res ? ` · ${esc(l.native_res)}` : ''}</span></div>`;
    }).join('');
  }

  // CRISM legend: one row per mineral (high and medium confidence share a colour), grouped by what it means
  // for the crew, clays first, so the colours along the route (salmon olivine + smectite, brown kaolinite) are
  // always labelled. Groups follow pipeline/common.py CRISM_CLASSES.
  const MINERAL_GROUPS = [
    ['Clays · form in water', ['Olivine + smectite', 'Kaolinite', 'Fe/Mg-smectite', 'Mg-smectite 2', 'Olivine/smectite + 2.2 µm']],
    ['Carbonates · also form in water', ['Mg-carbonate', 'Carbonate + 2.2 µm']],
    ['Volcanic · not water-formed', ['Olivine', 'High-Ca pyroxene', 'Low-Ca pyroxene']],
  ];
  function mineralLegend(l) {
    const color = {};
    for (const x of l.legend || []) {
      const name = String(x.label || '').replace(/\s*\((high|medium) confidence\)\s*$/i, '');
      if (x.color && !color[name]) color[name] = x.color;
    }
    const groups = MINERAL_GROUPS.map(([h, names]) => {
      const rows = names.filter((n) => color[n]).map((n) => `<li><i style="background:${esc(color[n])}"></i>${esc(n)}</li>`).join('');
      return rows ? `<li class="lg-grp">${esc(h)}</li>${rows}` : '';
    }).join('');
    return `<div class="lg-layer lg-minerals"><span class="lg-name">${esc(l.label)}</span>
      <ul>${groups}<li class="lg-grp">No colour</li><li class="lg-more">covered by CRISM but not identified, or uncertain</li></ul>
      <span class="lg-src">Brighter = high confidence, darker = medium · ${esc(l.source || '')}${l.native_res ? ` · ${esc(l.native_res)}` : ''}</span></div>`;
  }

  // ------------------------------------------------------------------ GO TO search
  const places = [
    ...data.stops.map((st) => ({ label: `${st.name} (stop ${st.id})`, px: st.px, stopId: st.id, zoom: 1 })),
    ...(data.depot?.tubes || []).map((t) => ({ label: `Tube ${t.name} (${t.sampleId})`, px: t.px, zoom: 2 })),
  ];
  // A short, fixed list (3 stops + the depot tubes), so GO TO is a dropdown menu, not a search box.
  const stopPlaces = places.filter((p) => p.stopId);
  const tubePlaces = places.filter((p) => !p.stopId);
  const stopLetter = (id) => esc(id);
  goto.innerHTML = `
    <button type="button" class="gt-btn" aria-haspopup="true" aria-expanded="false">
      <span class="gt-k">Go to</span><span class="gt-cur">Choose a stop or sample tube</span><span class="gt-caret" aria-hidden="true">▾</span></button>
    <div class="gt-menu" role="menu" hidden>
      <span class="gt-h">Stops</span>
      ${data.stops.map((st, i) => `<button type="button" role="menuitem" class="gt-item" data-i="${places.indexOf(stopPlaces[i])}">
        <i class="gt-dia ${st.kind === 'base' ? 'gt-base' : ''}">${stopLetter(st.id)}</i><span>${esc(st.name)}</span></button>`).join('')}
      ${tubePlaces.length ? `<span class="gt-h">Sample tubes at Three Forks (${tubePlaces.length})</span>
      <div class="gt-tubes">${(data.depot?.tubes || []).map((t, i) => `<button type="button" role="menuitem" class="gt-item gt-tube" data-i="${places.indexOf(tubePlaces[i])}">${esc(t.name)}</button>`).join('')}</div>` : ''}
    </div>`;
  const gtBtn = goto.querySelector('.gt-btn');
  const gtMenu = goto.querySelector('.gt-menu');
  const setMenu = (open) => { gtMenu.hidden = !open; gtBtn.setAttribute('aria-expanded', String(open)); };
  gtBtn.addEventListener('click', () => setMenu(gtMenu.hidden));
  gtMenu.addEventListener('click', (e) => {
    const b = e.target.closest('.gt-item');
    if (!b) return;
    const hit = places[Number(b.dataset.i)];
    setMenu(false);
    if (!hit) return;
    goto.querySelector('.gt-cur').textContent = hit.stopId ? data.stopsById[hit.stopId].name : `Tube ${b.textContent}`;
    if (!hit.stopId && ctx.getState().depotOn === false) ctx.setState({ depotOn: true });
    if (hit.stopId) ctx.setState({ selectedStopId: hit.stopId });
    ctx.emit('map:focus', { px: hit.px, zoom: hit.zoom });
  });
  document.addEventListener('pointerdown', (e) => { if (!gtMenu.hidden && !goto.contains(e.target)) setMenu(false); });
  goto.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setMenu(false); gtBtn.focus(); } });

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
    } else if (act === 'why') {
      whyOpen = !whyOpen;
      t.setAttribute('aria-expanded', String(whyOpen));
      t.querySelector('.sh-caret').textContent = whyOpen ? '▾' : '▸';
      const body = t.closest('.sh-brief')?.querySelector('.sh-why-body');
      if (body) body.hidden = !whyOpen;
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
      return `<li title="${esc(w)}"><span class="sh-tag">${esc(/cuts/i.test(w) ? 'Cuts' : 'Avoids')}</span>${esc(m ? `${m[2]} (${m[1]})` : w).replace(/^avoids |^cuts /i, '')}</li>`;
    }).join('');

    const others = data.routes.variants.filter((x) => x.id !== v.id).map((x) =>
      `<button type="button" class="sh-backup" data-act="variant" data-id="${esc(x.id)}" ${idle ? '' : 'disabled'}
        title="${idle ? 'Make this the plan' : 'Reset the sim to change the plan'}">
        <span>Backup: ${esc(x.stops.join(' → '))}</span><span class="sh-mono">${esc((x.distance_m / 1000).toFixed(1))} KM · ${esc(fmtMin(x.est_min))}</span></button>`).join('');

    // safety strip
    const planW = Math.min(100, (v.est_min / b.budgetMin) * 100);
    const resW = (b.reserveMin / b.budgetMin) * 100;

    return `
      <div class="sh-head">
        <span class="sh-k">EVA 01 · 2 crew + rover · plan "${esc(v.id)}"</span>
        <h1 class="sh-title">${esc(variantTitle(v))}</h1>
        ${idle ? briefHtml(v) : ''}
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
        <div class="sh-chips">${chipsHtml(s)}</div>
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


  // ------------------------------------------------------------------ mission brief (why this walk matters)
  // Every claim here comes from data/stops.json (stop "why"/minerals, CRISM) and data/depot.json (PDS Three Forks
  // depot bundle); the lines only appear when the planned variant actually visits that stop.
  let whyOpen = false;
  function briefHtml(v) {
    const sci = v.stops.map((id) => data.stopsById[id]).find((st) => st?.kind === 'science');
    const dep = v.stops.map((id) => data.stopsById[id]).find((st) => st?.kind === 'depot');
    const tubes = data.depot?.tubes || [];
    const lines = [];
    if (sci) {
      const cored = /cored (\w+)/i.exec(sci.why || '')?.[1];
      const water = /clay/i.test(`${sci.why} ${sci.minerals}`);
      lines.push(`<p class="sh-bl"><span class="sh-tag">Science</span>${water
        ? `Delta clays formed in water can preserve signs of past life${cored ? `; Perseverance cored ${esc(cored)} here` : ''}`
        : esc(sci.why || sci.name)}</p>`);
    }
    if (dep && tubes.length) {
      const wit = tubes.filter((t) => /witness/i.test(t.name || '')).length;
      lines.push(`<p class="sh-bl"><span class="sh-tag">Retrieve</span>${tubes.length} sample tubes${wit ? ` (${wit} witness)` : ''} Perseverance left at ${esc(dep.name.replace(/ depot$/i, ''))}</p>`);
    }
    if (!lines.length) return '';
    const sols = tubes.map((t) => t.dropSol).filter(Number.isFinite);
    const detail = [
      sci?.why ? `<p>${esc(sci.why)}.</p>` : '',
      sci?.minerals ? `<p><b>CRISM:</b> ${esc(sci.minerals)}</p>` : '',
      dep && tubes.length ? `<p><b>Depot:</b> ${tubes.length} tubes${sols.length ? ` set down sols ${Math.min(...sols)}–${Math.max(...sols)}` : ''}; tube names and drop sols from the PDS depot bundle.</p>` : '',
    ].join('');
    return `<div class="sh-brief">${lines.join('')}
      <div class="sh-bf"><button type="button" class="sh-why" data-act="why" aria-expanded="${whyOpen}">Why here <span class="sh-caret">${whyOpen ? '▾' : '▸'}</span></button>
        <span class="sh-src" title="MRO CRISM mineral map; Mars 2020 PDS Three Forks sample depot bundle">Data: MRO CRISM · M2020 PDS</span></div>
      <div class="sh-why-body" ${whyOpen ? '' : 'hidden'}>${detail}<span class="sh-src">Sources: data/stops.json (MRO CRISM, Mars 2020 sample record) · data/depot.json (PDS Three Forks depot bundle)</span></div></div>`;
  }

  // ------------------------------------------------------------------ safety chips (live: storm forecast, EVA dose)
  function chipsKey(s) {
    const e = s.sim?.env, r = s.sim?.radiation;
    const sf = e?.stormForecast;
    return [Number.isFinite(sf?.arrivalT) ? Math.round(sf.arrivalT) : '', e?.solarAlert ? 1 : 0, e?.stormActive ? 1 : 0,
      Number.isFinite(r?.evaDoseUGy) ? Math.floor(r.evaDoseUGy / 10) : '', r?.rateUGyPerDay ?? ''].join('|');
  }
  function chipsHtml(s) {
    const env = data.env || {};
    const tau = env.dustTau?.estimate;
    const sw = env.spaceWeather;
    const se = s.sim?.env || {};
    const sf = se.stormForecast && Number.isFinite(se.stormForecast.arrivalT) ? se.stormForecast : null;
    const alert = !!(se.solarAlert || sw?.solarAlert);
    const rad = env.radiation;
    const sr = s.sim?.radiation || {};
    const rate = Number.isFinite(sr.rateUGyPerDay) ? sr.rateUGyPerDay : Number.isFinite(rad?.doseUGyPerDay) ? rad.doseUGyPerDay : null;
    const dose = Number.isFinite(sr.evaDoseUGy) && sr.evaDoseUGy > 0 ? sr.evaDoseUGy : null;
    const solar = se.stormActive
      ? `<span class="sh-chip-bad"><i class="bad"></i>STORM NOW</span>`
      : sf
        ? `<span class="sh-chip-warn" title="${esc(`Simulated CME forecast: arrival T+${fmtMin(sf.arrivalT)}${Number.isFinite(sf.deadlineT) ? `, crew inside by T+${fmtMin(sf.deadlineT)}` : ''}${sf.basedOn?.arrivalUtc ? ` (modeled on DONKI CME arrival ${sf.basedOn.arrivalUtc})` : ''}`)}"><i class="bad"></i>STORM T+${esc(fmtMin(sf.arrivalT))}</span>`
        : `<span><i class="${alert ? 'bad' : 'ok'}"></i>${alert ? 'SOLAR ALERT' : 'NO CME DUE'}</span>`;
    const radTitle = sr.source || rad?.note || '';
    const radTxt = rate != null
      ? `${(rate / 1000).toFixed(2)} mGy/d${dose != null ? ` · EVA ${(dose / 1000).toFixed(2)} mGy` : ''}`
      : 'RAD n/a';
    return `<span><i class="${tau != null && tau < 0.6 ? 'ok' : 'warn'}"></i>DUST ${tau != null ? `τ${esc(tau.toFixed(2))}` : '?'}</span>
      ${solar}
      <span class="${dose != null ? 'sh-chip-wide' : ''}" title="${esc(radTitle)}"><i class="dim"></i>${esc(radTxt)}</span>`;
  }

  let lastKey = '', lastChips = '';
  function renderSheet(s) {
    const sim = s.sim;
    const key = [s.selectedStopId, s.plannedVariantId, s.demoBudgetMin, sim?.status, (sim?.visited || []).join(), (sim?.dropped || []).join(), sim?.nextStop?.id].join('|');
    if (key === lastKey) {
      // only the live chips changed (storm forecast, EVA dose): patch them in place, keep scroll and focus
      const ck = chipsKey(s);
      if (ck !== lastChips) {
        lastChips = ck;
        const chips = sheet.querySelector('.sh-chips');
        if (chips) chips.innerHTML = chipsHtml(s);
      }
      return;
    }
    lastKey = key;
    lastChips = chipsKey(s);
    sheet.dataset.view = s.selectedStopId ? 'stop' : 'route';
    sheet.innerHTML = s.selectedStopId && data.stopsById[s.selectedStopId] ? dossierHtml(s, s.selectedStopId) : sheetHtml(s);
    sheet.scrollTop = 0;
  }

  // Frame the planned route in the open map area between the rail and the sheet (the mockup's opening view).
  let framed = false;
  function frameRoute() {
    const s = ctx.getState();
    if (s.mode !== 'planner' || s.selectedStopId) return;
    framed = true;
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
    // booted in tablet mode: frame the route the first time the planner is shown (after the map is resized)
    if (changed.has('mode') && s.mode === 'planner' && !framed) setTimeout(() => requestAnimationFrame(frameRoute), 0);
    if (changed.has('layersOn') || changed.has('roverPathOn') || changed.has('depotOn')) renderRail(s);
    if (changed.has('sim') || changed.has('selectedStopId') || changed.has('plannedVariantId') || changed.has('demoBudgetMin')) renderSheet(s);
  });
  return { renderSheet };
}
