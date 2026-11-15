// panels.js — side panel (planner mode). Owner: panels agent (panels.js + panels.css).
// Contract: INTERFACES.md "panels.js". Renders inside ctx.els.sidePanel only.
//
// Sections (each re-rendered only when its own inputs change, via a cheap key):
//   banners  — fault banners: rover link lost, turn-around, storm abort, slow pace / high air notes
//   replan   — pending replan card (Confirm reroute) + current reroute + replan history
//   route    — variant picker (idle only), totals, fits-budget badge, why-lines of the active route
//   stop     — stop list + preview of the selected stop
//   safety   — air budget bar, time home, margin, env status, warnings, assumptions
//   alerts   — alerts log from sim.alerts

import { esc, fmtMin, fmtMinLong, fmtDistM } from './util.js';
import { pacedDuration } from './sim.js';

const KIND_LABEL = { base: 'Base', science: 'Science stop', depot: 'Sample depot' };
const OPTION_LABEL = {
  planned: 'Continue as planned', skip_work: 'Skip the work here', drop: 'Drop the next stop',
  abort: 'Abort: walk home', return: 'Return home', hazard: 'Detour',
};
const LEVEL_WORD = { ok: 'OK', warn: 'CAUTION', danger: 'DANGER', info: 'INFO' };

const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const num = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const tPlus = (t) => (Number.isFinite(t) ? `T+${fmtMin(t)}` : '—');

/** @param {object} ctx  see INTERFACES.md "ctx" */
export function initPanels(ctx) {
  const { data, config } = ctx;
  const root = ctx.els.sidePanel;
  root.classList.add('pn-root');
  root.innerHTML = `
    <div class="pn-banners" data-sec="banners" aria-live="assertive"></div>
    <div data-sec="replan"></div>
    <section class="pn-card" data-sec="route" aria-label="Route"></section>
    <section class="pn-card" data-sec="stop" aria-label="Stop preview"></section>
    <section class="pn-card" data-sec="safety" aria-label="Safety check"></section>
    <section class="pn-card" data-sec="alerts" aria-label="Alerts log"></section>
  `;
  const sec = Object.fromEntries([...root.querySelectorAll('[data-sec]')].map((el) => [el.dataset.sec, el]));
  const keys = {};
  const detailsOpen = {};   // viewer's open/closed state of <details> in re-rendered cards

  // ---------------------------------------------------------------- helpers
  const isIdle = (s) => !s.sim || s.sim.status === 'idle';
  const plannedVariant = (s) =>
    data.variantsById[s.sim?.active?.variantId] || data.variantsById[s.plannedVariantId] || data.routes.variants[0];
  const stopName = (id) => data.stopsById[id]?.name || id || '—';
  const routeLabel = (v) => (v.stops || []).join(' → ');

  function setSec(name, key, render) {
    if (keys[name] === key) return;
    keys[name] = key;
    sec[name].innerHTML = render();
  }

  // ---------------------------------------------------------------- banners
  function bannerItems(s) {
    const sim = s.sim;
    const items = [];
    const linkLost = sim ? sim.link?.ok === false : s.faults.linkLost;
    if (s.faults.storm || sim?.env?.stormActive) {
      const st = sim?.status || 'idle';
      const title = st === 'idle' ? 'Dust / solar storm: EVA on hold'
        : (st === 'done' || st === 'aborted') ? 'Dust / solar storm: crew back at the habitat'
        : 'Dust / solar storm: walk aborted';
      items.push({ level: 'danger', kind: 'storm', title,
        text: sim?.env?.text || 'Shortest safe route home is shown on the map.' });
    }
    if (sim?.air?.turnaround) {
      items.push({ level: 'danger', kind: 'air', title: 'Turn around: air for the walk home is getting short',
        text: `Air left ${fmtMinLong(sim.air.leftMin)} vs ${fmtMinLong(sim.air.neededMin ?? ((sim.air.timeHomeMin ?? 0) + sim.air.reserveMin))} needed (walk home${(sim.air.burnFactor ?? 1) !== 1 ? ` at ${sim.air.burnFactor}× burn` : ''} + reserve).` });
    }
    if (linkLost) {
      const since = sim?.link?.lostSinceT;
      const unc = sim?.crew?.[0]?.uncertaintyM;
      items.push({ level: 'danger', kind: 'link', title: 'Rover link lost – suit-only mode',
        text: `Dead reckoning${Number.isFinite(since) ? ` since ${tPlus(since)}` : ''}${Number.isFinite(unc) ? `, position ±${Math.round(unc)} m` : ''}. Way home shown on the HUD.` });
    }
    if (s.faults.highAir && !sim?.air?.turnaround) {
      items.push({ level: 'warn', kind: 'air', title: 'High air use',
        text: `Air burns at ${config.highAirBurnFactor}× planned rate (demo assumption).` });
    }
    if (s.slowPace) {
      items.push({ level: 'info', kind: 'pace', title: 'Slow pace',
        text: `Crew walks at ${config.slowPaceFactor}× planned speed (demo assumption)${sim?.schedule?.behindMin > 0.5 ? `, ${fmtMinLong(sim.schedule.behindMin)} behind` : ''}.` });
    }
    return items;
  }

  function renderBanners(s) {
    const items = bannerItems(s);
    const key = items.map((b) => b.title + b.text).join('|');
    setSec('banners', key, () => items.map((b) => `
      <div class="pn-banner" data-level="${b.level}" data-kind="${b.kind}">
        <div class="pn-banner-title">${esc(b.title)}</div>
        <div class="pn-banner-text">${esc(b.text)}</div>
      </div>`).join(''));
  }

  // ---------------------------------------------------------------- replan
  function renderReplan(s) {
    const sim = s.sim;
    const p = sim?.pendingReplan || null;
    const replans = sim?.replans || [];
    const active = sim?.active;
    const rerouted = active && active.kind && active.kind !== 'planned';
    const key = JSON.stringify([p?.id, replans.length, replans.map((r) => r.confirmedT), active?.id]);
    setSec('replan', key, () => {
      let html = '';
      if (p) {
        const safety = p.safety || {};
        const why = (p.why || []).map((w) => `<li>${esc(w)}</li>`).join('');
        const rejected = (p.rejected || []).map((r) => `
          <li><span class="pn-tag">${esc(OPTION_LABEL[r.kind] || r.kind)}</span> ${esc(r.label || '')}
          ${Number.isFinite(r.overByMin) ? `<span class="pn-dim">— over budget by ${esc(fmtMinLong(r.overByMin))}</span>` : ''}</li>`).join('');
        const trig = { schedule: 'Behind schedule', air: 'Air running short', storm: 'Storm', hazard: 'Rover: rock field' }[p.trigger] || 'Replan';
        html += `
        <section class="pn-card pn-replan" data-kind="${esc(p.kind)}" aria-label="Replan proposal">
          <div class="pn-replan-head">
            <span class="pn-pill" data-level="${p.trigger === 'schedule' ? 'warn' : 'danger'}">${esc(trig)}</span>
            <h2>Reroute proposed</h2>
          </div>
          <div class="pn-kv">
            <div><span>At</span><b>${esc(p.atStopName || stopName(p.atStopId) || 'mid-leg')}</b></div>
            <div><span>${p.checkpoint || p.trigger === 'hazard' ? 'At' : 'Arrived'}</span><b>${esc(tPlus(p.arrivedT))}${Number.isFinite(p.plannedArriveT) ? ` <small class="pn-dim">(plan ${esc(tPlus(p.plannedArriveT))})</small>` : ''}</b></div>
            <div><span>Behind schedule</span><b class="pn-warn">${esc(fmtMinLong(p.behindMin))}</b></div>
            ${p.trigger === 'hazard'
              ? `<div><span>Adds</span><b class="pn-warn">${esc(fmtMinLong(Math.abs(p.savesMin)))}</b></div>`
              : `<div><span>Saves</span><b class="pn-ok">${esc(fmtMinLong(p.savesMin))}</b></div>`}
          </div>
          <div class="pn-choice"><span class="pn-tag">${esc(OPTION_LABEL[p.kind] || p.kind)}</span> ${esc(p.label || '')}</div>
          ${why ? `<ul class="pn-why">${why}</ul>` : ''}
          <div class="pn-safe"${safety.withinBudget === false ? ' data-level="danger"' : ''}>
            <div class="pn-safe-title">${safety.withinBudget === false ? (safety.airRunsOut ? 'Best available: NOT within budget, air runs out' : 'Best available: NOT within budget') : 'Why it is safe'}</div>
            <div>${esc(safety.text || '')}</div>
            <div class="pn-dim pn-small">Back by ${esc(tPlus(safety.projectedReturnT))} · margin ${esc(fmtMinLong(safety.marginMin))} · air at return ${esc(fmtMinLong(safety.airLeftAtReturnMin))}</div>
          </div>
          ${rejected ? `<details class="pn-details"><summary>Options that did not fit (${(p.rejected || []).length})</summary><ul class="pn-list">${rejected}</ul></details>` : ''}
          <button type="button" class="btn btn-primary pn-confirm" data-action="confirm" data-id="${esc(p.id)}">Confirm reroute</button>
          <div class="pn-dim pn-small">Sim is paused until the astronaut confirms. Rule: first option with T + minutes + reserve ≤ budget, else abort (minutes at the current pace, air × burn rate).</div>
        </section>`;
      } else if (rerouted) {
        html += `
        <section class="pn-card pn-rerouted" data-kind="${esc(active.kind)}" aria-label="Current reroute">
          <div class="pn-replan-head">
            <span class="pn-pill" data-level="${active.kind === 'abort' || active.kind === 'return' ? 'danger' : 'warn'}">Rerouted</span>
            <h2>${esc(active.label || OPTION_LABEL[active.kind] || active.kind)}</h2>
          </div>
          <div class="pn-dim pn-small">Now following ${esc((active.stops || []).join(' → '))} · ${esc(fmtDistM(active.distanceM))}</div>
        </section>`;
      }
      if (replans.length) {
        const rows = replans.slice().reverse().map((r) => `
          <li data-kind="${esc(r.kind)}">
            <span class="pn-mono">${esc(tPlus(r.t))}</span>
            <span class="pn-tag">${esc(r.kind)}</span>
            <span>${esc(r.atStopId ? stopName(r.atStopId) : 'mid-leg')}: ${esc(r.label || OPTION_LABEL[r.kind] || '')}</span>
            ${r.kind === 'planned' ? '' : `<span class="pn-dim">${r.confirmedT != null ? `confirmed ${esc(tPlus(r.confirmedT))}` : 'awaiting confirm'}</span>`}
          </li>`).join('');
        html += `
        <section class="pn-card" aria-label="Replan log">
          <h3 class="pn-h">Replan log</h3>
          <ul class="pn-log">${rows}</ul>
        </section>`;
      }
      return html;
    });
  }

  // ---------------------------------------------------------------- route
  function renderRoute(s) {
    const idle = isIdle(s);
    const sim = s.sim;
    const active = sim?.active;
    const pv = plannedVariant(s);
    const why = active?.why?.length ? active.why : pv?.why || [];
    const key = JSON.stringify([idle, s.plannedVariantId, active?.id, why.length]);
    setSec('route', key, () => {
      const cards = data.routes.variants.map((v) => {
        const sel = v.id === s.plannedVariantId;
        return `
        <button type="button" class="pn-variant" data-action="variant" data-id="${esc(v.id)}"
          aria-pressed="${sel}" ${idle ? '' : 'disabled'} title="${idle ? 'Plan this variant' : 'Reset the sim to change the plan'}">
          <div class="pn-variant-top">
            <span class="pn-variant-id">${esc(v.id)}</span>
            <span class="pn-variant-stops">${esc(routeLabel(v))}</span>
            <span class="pn-pill" data-level="${v.fits_budget ? 'ok' : 'danger'}">${v.fits_budget ? 'fits budget' : 'over budget'}</span>
          </div>
          <div class="pn-variant-stats">
            <span><b>${esc(fmtDistM(v.distance_m))}</b> distance</span>
            <span><b>${esc(fmtMin(v.est_min))}</b> est.</span>
            <span><b>${esc(fmtMinLong(v.walk_min))}</b> walk</span>
            <span><b>${esc(fmtMinLong(v.work_min))}</b> work</span>
            <span><b>${esc(num(v.max_slope_deg, 1))}°</b> max slope</span>
          </div>
        </button>`;
      }).join('');
      const whyTitle = active && active.kind && active.kind !== 'planned' ? `Why this route (${esc(active.label || active.kind)})` : 'Why this route';
      return `
        <div class="pn-card-head"><h2>Route plan</h2>${idle ? '' : '<span class="pn-dim pn-small">locked while walking · Reset to change</span>'}</div>
        <div class="pn-variants">${cards}</div>
        <h3 class="pn-h">${whyTitle}</h3>
        <ul class="pn-why">${why.map((w) => `<li>${esc(w)}</li>`).join('') || '<li class="pn-dim">No notes</li>'}</ul>`;
    });
  }

  // ---------------------------------------------------------------- stop preview
  function stopTimes(s, id) {
    const pv = plannedVariant(s);
    const plan = (pv?.stop_plan || []).filter((p) => p.id === id);
    // For H, show the return (last) entry if it exists; for others the single entry.
    const sp = id === 'H' ? plan[plan.length - 1] : plan[0];
    const rec = (s.sim?.replans || []).find((r) => r.atStopId === id);
    const visited = (s.sim?.visited || []).includes(id);
    const dropped = (s.sim?.dropped || []).includes(id);
    const inPlan = (pv?.stops || []).includes(id);
    return { sp, rec, visited, dropped, inPlan, variant: pv };
  }

  function renderStop(s) {
    const id = s.selectedStopId;
    const st = id ? data.stopsById[id] : null;
    const times = st ? stopTimes(s, id) : null;
    const key = JSON.stringify([id, times?.variant?.id, times?.rec?.t, times?.visited, times?.dropped]);
    setSec('stop', key, () => {
      const list = data.stops.map((x) => `
        <button type="button" class="pn-stopchip" data-action="stop" data-id="${esc(x.id)}" data-kind="${esc(x.kind)}"
          aria-pressed="${x.id === id}" title="${esc(x.name)}"><span class="pn-stopdot">${esc(x.id)}</span>${esc(x.name)}</button>`).join('');
      if (!st) {
        return `<div class="pn-card-head"><h2>Stops</h2></div>
          <div class="pn-stoplist">${list}</div>
          <p class="pn-dim pn-small">Click a stop here or on the map to preview it.</p>`;
      }
      const photos = (st.photos || []).map((u, i) => `
        <figure class="pn-photo" data-i="${i}">
          <img src="${esc(u)}" alt="${esc(st.name)} photo ${i + 1}" loading="lazy" referrerpolicy="no-referrer">
          <figcaption class="pn-photo-fallback" hidden>Photo unavailable · <a href="${esc(u)}" target="_blank" rel="noopener">open link</a></figcaption>
        </figure>`).join('');
      const { sp, rec, visited, dropped, inPlan, variant } = times;
      const statusPill = dropped ? '<span class="pn-pill" data-level="danger">dropped</span>'
        : visited ? '<span class="pn-pill" data-level="ok">visited</span>'
        : !inPlan ? '<span class="pn-pill">not in plan</span>' : '';
      const row = (label, value) => (value === '' || value == null ? '' : `<div><span>${label}</span><b>${value}</b></div>`);
      return `
        <div class="pn-card-head"><h2>Stops</h2></div>
        <div class="pn-stoplist">${list}</div>
        <div class="pn-stop" data-kind="${esc(st.kind)}">
          <div class="pn-stop-head">
            <span class="pn-stopdot" data-kind="${esc(st.kind)}">${esc(st.id)}</span>
            <div class="pn-stop-title"><h3>${esc(st.name)}</h3><span class="pn-dim pn-small">${esc(KIND_LABEL[st.kind] || st.kind)}</span></div>
            ${statusPill}
            <button type="button" class="pn-iconbtn" data-action="focus" data-id="${esc(st.id)}" title="Center map on this stop">◎</button>
            <button type="button" class="pn-iconbtn" data-action="close" title="Close preview" aria-label="Close preview">×</button>
          </div>
          ${photos ? `<div class="pn-photos">${photos}</div>` : (st.kind === 'base' ? '' : '<div class="pn-photo-none">No photos for this stop</div>')}
          ${st.why ? `<p class="pn-goal"><span class="pn-label">Science goal</span>${esc(st.why)}</p>` : ''}
          ${st.expect ? `<p class="pn-goal"><span class="pn-label">What to expect</span>${esc(st.expect)}</p>` : ''}
          <div class="pn-kv">
            ${row('Sol (image)', st.sol ? esc(st.sol) : '')}
            ${row('Minerals', st.minerals ? esc(st.minerals) : '')}
            ${row('Rock unit', st.rock_unit ? esc(st.rock_unit) : '')}
            ${row('Work time', Number.isFinite(st.work_min) ? esc(fmtMinLong(st.work_min)) : '')}
            ${row('Grid px', esc(`${st.px[0]}, ${st.px[1]}`))}
          </div>
          ${sp ? `
          <h3 class="pn-h">Planned times <span class="pn-dim">(${esc(variant.id)})</span></h3>
          <div class="pn-kv">
            ${row('Arrive', esc(tPlus(sp.arrive_min)))}
            ${row('Depart', esc(tPlus(sp.depart_min)))}
            ${row('Walk home from here', esc(fmtMinLong(sp.home_min)))}
            ${row('Plan left after arrival', esc(fmtMinLong(sp.remaining_min)))}
            ${rec ? row('Actual arrival', `${esc(tPlus(rec.t))}${Number.isFinite(sp.arrive_min) ? ` <small class="pn-dim">(${rec.t - sp.arrive_min >= 0 ? '+' : ''}${esc(num(rec.t - sp.arrive_min, 0))} min)</small>` : ''}`) : ''}
          </div>` : `<p class="pn-dim pn-small">Not on the ${esc(variant?.id || '')} plan.</p>`}`;
    });
    // Wire image fallbacks (only after a fresh render; listeners attach once per <img>).
    sec.stop.querySelectorAll('.pn-photo img:not([data-wired])').forEach((img) => {
      img.dataset.wired = '1';
      const fail = () => {
        const fig = img.closest('.pn-photo');
        img.remove();
        fig.classList.add('pn-photo-failed');
        fig.querySelector('.pn-photo-fallback').hidden = false;
      };
      img.addEventListener('error', fail, { once: true });
      if (img.complete && img.naturalWidth === 0 && img.src) fail();
    });
  }

  // ---------------------------------------------------------------- safety
  function airNumbers(s) {
    const sim = s.sim;
    const budget = config.budgetMin;
    const reserve = config.reserveMin;
    if (!sim || sim.status === 'idle' || !sim.air) {
      const pv = plannedVariant(s);
      const est = pv?.est_min ?? 0;
      const burn = s.faults.highAir ? config.highAirBurnFactor : 1;
      const pace = s.slowPace ? config.slowPaceFactor : 1;
      // air the whole plan uses at the current burn rate and pace
      const planMin = pace !== 1 && pv?.path ? pacedDuration(pv.path, pv.t_min, 0, pv.t_min[pv.t_min.length - 1], pace) : est;
      const planAir = planMin * burn;
      const margin = budget - planAir - reserve;
      return {
        planned: true, budget, reserve, left: budget, timeHome: est, needed: planAir + reserve,
        margin, level: margin <= config.turnaroundMarginMin ? 'danger' : margin < 2 * config.turnaroundMarginMin ? 'warn' : 'ok',
        source: 'plan', burn, pace, planMin, planAir, variantId: pv?.id,
      };
    }
    const a = sim.air;
    const th = Number.isFinite(a.timeHomeMin) ? a.timeHomeMin : null;
    return {
      planned: false, budget: a.budgetMin ?? budget, reserve: a.reserveMin ?? reserve, left: a.leftMin,
      timeHome: th, needed: Number.isFinite(a.neededMin) ? a.neededMin : (th ?? 0) + (a.reserveMin ?? reserve),
      homeAir: a.homeAirMin, wayHome: a.wayHomeMin, pace: a.paceFactor ?? 1,
      margin: Number.isFinite(a.marginMin) ? a.marginMin : a.leftMin - (th ?? 0) - reserve,
      level: a.level || 'ok', source: a.timeHomeSource || 'none', burn: a.burnFactor ?? 1,
      used: a.usedMin, turnaround: a.turnaround,
    };
  }

  function envNumbers(s) {
    const se = s.sim?.env;
    const de = data.env || {};
    const storm = !!(s.faults.storm || se?.stormActive);
    const dust = se?.dust ?? de.dust ?? 'unknown';
    const solar = !!(se ? se.solarAlert : de.solar_alert) || storm;
    const level = storm ? 'danger' : se?.level || (solar || /high|severe/i.test(dust) ? 'warn' : 'ok');
    return { storm, dust, solar, level, text: se?.text || '', radiation: de.radiation_note || '' };
  }

  function warningsList(s) {
    const w = [...(config.warnings || [])];
    data.routes.variants.forEach((v) => {
      if (v.fits_budget === false) w.push(`Variant ${v.id} (${routeLabel(v)}) does not fit the suit budget`);
    });
    if (data.env?.missing) w.push('env.json missing: dust/solar status unknown, using default suit budget');
    if (data.fake) w.push('FAKE DATA: terrain, routes and stop info are placeholders, not mission data');
    const tv = s.sim?.air?.timeHomeSource;
    if (tv === 'none') w.push('Time to walk home unknown at the current position (off the time-home grid)');
    else if (tv === 'route') w.push('Time home taken from the route (time-home grid has no value here)');
    return w;
  }

  function renderSafety(s) {
    const a = airNumbers(s);
    const e = envNumbers(s);
    const warns = warningsList(s);
    const key = JSON.stringify([r1(a.left), r1(a.timeHome), r1(a.margin), r1(a.needed), a.level, a.source, a.burn, a.pace, a.variantId, a.turnaround, e, warns]);
    // the card is rebuilt while the sim runs: keep the viewer's open/closed <details> choices
    sec.safety.querySelectorAll('details[data-key]').forEach((d) => { detailsOpen[d.dataset.key] = d.open; });
    setSec('safety', key, () => {
      const B = a.budget || 1;
      const pct = (v) => `${Math.max(0, Math.min(100, (v / B) * 100)).toFixed(2)}%`;
      const leftPct = pct(a.left);
      const needPct = pct(a.needed);
      const resPct = pct(a.reserve);
      const short = a.left < a.needed;
      const assumptions = (config.assumptions || []).map((x) => `
        <li><span class="pn-assume">ASSUMPTION</span> ${esc(x.text)} <span class="pn-src">${esc(x.source)}</span></li>`).join('');
      const derived = [
        `Walking speed ${config.vFlatKmh} km/h on flat ground`,
        `Slope soft limit ${config.slopeSoftDeg}°, no-go ${config.slopeHardDeg}°`,
        `Map grid ${config.widthPx}×${config.heightPx} px at ${config.pixelM} m/px`,
      ].map((t) => `<li><span class="pn-assume">ASSUMPTION</span> ${esc(t)} <span class="pn-src">params</span></li>`).join('');
      return `
        <div class="pn-card-head"><h2>Safety check</h2><span class="pn-pill" data-level="${a.level}">${LEVEL_WORD[a.level] || a.level}</span></div>
        <div class="pn-air" data-level="${a.level}">
          <div class="pn-air-legend">
            <span><i class="pn-sw pn-sw-left"></i>${a.planned ? 'Air at start' : 'Air left'} <b>${esc(fmtMinLong(a.left))}</b></span>
            <span><i class="pn-sw pn-sw-need"></i>${a.planned ? 'Plan + reserve' : 'Walk home + reserve'}${a.burn !== 1 || (a.pace ?? 1) !== 1 ? ' <small>(air at current burn / pace)</small>' : ''} <b>${esc(fmtMinLong(a.needed))}</b></span>
          </div>
          <div class="pn-airbar" role="img" aria-label="Air left ${esc(fmtMinLong(a.left))}, needed ${esc(fmtMinLong(a.needed))} of ${esc(fmtMinLong(a.budget))} budget">
            <div class="pn-airbar-left" style="width:${leftPct}"></div>
            <div class="pn-airbar-need${short ? ' pn-short' : ''}" style="width:${needPct}"></div>
            <div class="pn-airbar-reserve" style="left:${resPct}" title="Reserve ${esc(fmtMinLong(a.reserve))}"><span>reserve</span></div>
            <div class="pn-airbar-needmark" style="left:${needPct}"></div>
          </div>
          <div class="pn-airbar-scale"><span>0</span><span>budget ${esc(fmtMinLong(a.budget))} <small>(assumption)</small></span></div>
        </div>
        <div class="pn-kv pn-kv-3">
          <div><span>${a.planned ? 'Planned walk' : 'Time to walk home'}</span><b>${esc(fmtMinLong(a.timeHome))}</b>
            <small class="pn-dim">${a.planned ? `est_min of ${esc(a.variantId || '')}${a.planAir != null && Math.abs(a.planAir - a.timeHome) > 0.5 ? ` · uses ${esc(fmtMinLong(a.planAir))} of air` : ''}`
              : `source: ${esc(a.source)}${Number.isFinite(a.wayHome) && Number.isFinite(a.timeHome) && a.wayHome > a.timeHome + 0.5 ? ` · routed way home ${esc(fmtMinLong(a.wayHome))}` : ''}${Number.isFinite(a.homeAir) && Math.abs(a.homeAir - Math.max(a.timeHome ?? 0, a.wayHome ?? 0)) > 0.5 ? ` · uses ${esc(fmtMinLong(a.homeAir))} of air` : ''}`}</small></div>
          <div><span>Margin</span><b class="${a.margin < 0 ? 'pn-danger' : a.level === 'warn' ? 'pn-warn' : 'pn-ok'}">${esc(fmtMinLong(a.margin))}</b>
            <small class="pn-dim">after reserve</small></div>
          <div><span>Burn rate</span><b>${esc(num(a.burn, 1))}×</b><small class="pn-dim">${a.burn > 1 ? 'high air use' : 'nominal'}</small></div>
        </div>
        <h3 class="pn-h">Environment</h3>
        <div class="pn-env">
          <span class="pn-chip" data-level="${e.storm ? 'danger' : /high|severe/i.test(e.dust) ? 'warn' : 'ok'}">Dust: ${esc(e.storm ? 'STORM' : e.dust)}</span>
          <span class="pn-chip" data-level="${e.solar ? 'danger' : 'ok'}">Solar: ${e.solar ? 'ALERT' : 'no alert'}</span>
          <span class="pn-chip" data-level="${e.storm ? 'danger' : 'info'}">Radiation</span>
        </div>
        ${e.text ? `<div class="pn-small ${e.storm ? 'pn-danger' : 'pn-dim'}">${esc(e.text)}</div>` : ''}
        ${e.radiation ? `<div class="pn-small pn-dim">Radiation note: ${esc(e.radiation)}</div>` : ''}
        ${warns.length ? `<h3 class="pn-h">Warnings</h3><ul class="pn-warnings">${warns.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        <details class="pn-details" data-key="assumptions"${detailsOpen.assumptions !== false ? ' open' : ''}>
          <summary>Assumptions (${(config.assumptions || []).length + 3})</summary>
          <ul class="pn-assumptions">${assumptions}${derived}</ul>
        </details>
        ${config.replanRule ? `<details class="pn-details" data-key="rule"${detailsOpen.rule ? ' open' : ''}><summary>Replan rule (from routes.json)</summary><p class="pn-small pn-rule">${esc(config.replanRule)}</p>
          <p class="pn-small pn-dim">The sim applies it to option minutes at the crew's current pace, and also requires those minutes × burn rate + reserve ≤ air left.</p></details>` : ''}`;
    });
  }

  // ---------------------------------------------------------------- alerts
  function renderAlerts(s) {
    const alerts = s.sim?.alerts || [];
    const last = alerts[alerts.length - 1];
    const key = JSON.stringify([alerts.length, last?.id, alerts.map((a) => a.active ? 1 : 0).join('')]);
    setSec('alerts', key, () => {
      const rows = alerts.slice().reverse().slice(0, 30).map((a) => `
        <li data-level="${esc(a.level)}" class="${a.active ? 'pn-active' : ''}">
          <span class="pn-mono">${esc(tPlus(a.t))}</span>
          <div><b>${esc(a.title)}</b>${a.active ? ' <span class="pn-pill" data-level="danger">active</span>' : ''}
          ${a.text ? `<div class="pn-dim pn-small">${esc(a.text)}</div>` : ''}</div>
        </li>`).join('');
      return `<div class="pn-card-head"><h2>Alerts</h2><span class="pn-dim pn-small">${alerts.length}</span></div>
        ${rows ? `<ul class="pn-alerts">${rows}</ul>` : '<p class="pn-dim pn-small">No alerts yet. Press Play to start the walk.</p>'}`;
    });
  }

  // ---------------------------------------------------------------- events
  root.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-action]');
    if (!btn || !root.contains(btn) || btn.disabled) return;
    const { action, id } = btn.dataset;
    if (action === 'confirm') {
      ctx.emit('replan:confirm', { id });
    } else if (action === 'variant') {
      if (isIdle(ctx.getState())) ctx.setState({ plannedVariantId: id });
    } else if (action === 'stop') {
      const st = data.stopsById[id];
      ctx.setState({ selectedStopId: ctx.getState().selectedStopId === id ? null : id });
      if (st) ctx.emit('map:focus', { px: st.px });
    } else if (action === 'focus') {
      const st = data.stopsById[id];
      if (st) ctx.emit('map:focus', { px: st.px });
    } else if (action === 'close') {
      ctx.setState({ selectedStopId: null });
    }
  });

  // ---------------------------------------------------------------- render loop
  function renderAll(s) {
    renderBanners(s);
    renderReplan(s);
    renderRoute(s);
    renderStop(s);
    renderSafety(s);
    renderAlerts(s);
  }
  renderAll(ctx.getState());

  const WATCH = ['sim', 'plannedVariantId', 'selectedStopId', 'faults', 'slowPace'];
  const unsubscribe = ctx.subscribe((s, prev, changed) => {
    if (WATCH.some((k) => changed.has(k))) renderAll(s);
    // A stop picked on the map should be visible: bring its preview into view in the panel.
    if (changed.has('selectedStopId') && s.selectedStopId && s.mode === 'planner' && !s.sim?.pendingReplan) {
      requestAnimationFrame(() => sec.stop.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    }
  });

  // Scroll the replan card into view when a proposal arrives.
  const offProposed = ctx.on('replan:proposed', () => {
    // The fault banners and the replan card sit at the top of the panel, so jump there (no smooth
    // scroll: the per-frame re-renders below the card would interrupt it).
    requestAnimationFrame(() => { root.scrollTop = 0; });
  });

  return { unsubscribe, offProposed, rerender: () => { Object.keys(keys).forEach((k) => delete keys[k]); renderAll(ctx.getState()); } };
}
