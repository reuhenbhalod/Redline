// panels.js — side panel (planner mode). Owner: panels agent (panels.js + panels.css).
// Contract: INTERFACES.md "panels.js" + "Real-data tasks". Renders inside ctx.els.sidePanel only.
//
// Sections (each re-rendered only when its own inputs change, via a cheap key):
//   banners  — fault banners: rover link lost, turn-around, storm abort, slow pace / high air notes, DEMO budget
//   replan   — pending replan card (Confirm reroute) + current reroute + replan history
//   route    — variant picker (idle only), totals, fits-budget badge, why-lines of the active route
//   stop     — stop list + preview of the selected stop (real photos + credits, site facts, depot tube list)
//   safety   — suit budget (PRIMARY / DEMO), air budget bar, time home, margin, warnings, safety params, assumptions
//   env      — environment from env_data.json: dust tau, temperatures, pressure, wind, radiation (stand-in), DONKI CMEs
//   alerts   — alerts log from sim.alerts
//   credits  — data sources, literature, AI use and image credits (provenance.json), collapsed

import {
  esc, fmtMin, fmtMinLong, fmtDistM, effectiveBudget, DEMO_BUDGET_NOTE, basisLabel, pxToLonLat, fmtLonLat,
} from './util.js';
import { pacedDuration } from './sim.js';

const KIND_LABEL = { base: 'Base', science: 'Science stop', depot: 'Sample depot' };
const OPTION_LABEL = {
  planned: 'Continue as planned', skip_work: 'Skip the work here', drop: 'Drop the next stop',
  abort: 'Abort: walk home', return: 'Return home', hazard: 'Detour',
};
const LEVEL_WORD = { ok: 'OK', warn: 'CAUTION', danger: 'DANGER', info: 'INFO' };
const CAMERA_LABEL = {
  MCZ_LEFT: 'Mastcam-Z L', MCZ_RIGHT: 'Mastcam-Z R', NAVCAM_LEFT: 'Navcam L', NAVCAM_RIGHT: 'Navcam R',
  FRONT_HAZCAM_LEFT_A: 'Front Hazcam', REAR_HAZCAM_LEFT: 'Rear Hazcam', SHERLOC_WATSON: 'WATSON', SUPERCAM_RMI: 'SuperCam RMI',
};
const camLabel = (c) => CAMERA_LABEL[c] || String(c || '').replace(/_/g, ' ');

const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const num = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const tPlus = (t) => (Number.isFinite(t) ? `T+${fmtMin(t)}` : '—');
const pct = (f) => (Number.isFinite(f) ? `${Math.round(f * 100)}%` : '—');
const basisBadge = (basis, title = '') =>
  `<span class="basis" data-basis="${esc(basis || 'assumption')}"${title ? ` title="${esc(title)}"` : ''}>${esc(basisLabel(basis))}</span>`;
const demoTag = (title = DEMO_BUDGET_NOTE) => `<span class="basis" data-basis="demo" title="${esc(title)}">DEMO</span>`;
const fmtUtcDay = (s) => (s ? String(s).slice(0, 10) : '—');
const fmtUtcTime = (s) => {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(s || ''));
  return m ? `${m[1]} ${m[2]} UTC` : (s || '—');
};

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
    <section class="pn-card" data-sec="env" aria-label="Environment"></section>
    <section class="pn-card" data-sec="alerts" aria-label="Alerts log"></section>
    <section class="pn-card" data-sec="credits" aria-label="Data and credits"></section>
  `;
  const sec = Object.fromEntries([...root.querySelectorAll('[data-sec]')].map((el) => [el.dataset.sec, el]));
  const keys = {};
  const detailsOpen = {};   // viewer's open/closed state of <details data-key> in re-rendered cards

  // ---------------------------------------------------------------- helpers
  const isIdle = (s) => !s.sim || s.sim.status === 'idle';
  const plannedVariant = (s) =>
    data.variantsById[s.sim?.active?.variantId] || data.variantsById[s.plannedVariantId] || data.routes.variants[0];
  const stopName = (id) => data.stopsById[id]?.name || id || '—';
  const routeLabel = (v) => (v.stops || []).join(' → ');
  /** ' open' when the viewer left this disclosure open (or it is open by default and was never closed). */
  const openAttr = (key, dflt = false) => ((detailsOpen[key] ?? dflt) ? ' open' : '');

  function setSec(name, key, render) {
    if (keys[name] === key) return;
    keys[name] = key;
    // keep the viewer's open/closed <details> choices across re-renders
    sec[name].querySelectorAll('details[data-key]').forEach((d) => { detailsOpen[d.dataset.key] = d.open; });
    sec[name].innerHTML = render();
    wireImages(sec[name]);
  }

  /** <img data-fb> gets a fallback once: the image is replaced by its sibling .pn-img-fallback (a link). */
  function wireImages(el) {
    el.querySelectorAll('img[data-fb]:not([data-wired])').forEach((img) => {
      img.dataset.wired = '1';
      const fail = () => {
        const box = img.closest('.pn-photo, .pn-thumb, .pn-tube-img');
        img.remove();
        if (!box) return;
        box.classList.add('pn-photo-failed');
        const fb = box.querySelector('.pn-img-fallback');
        if (fb) fb.hidden = false;
      };
      img.addEventListener('error', fail, { once: true });
      img.addEventListener('load', () => img.closest('.pn-photo, .pn-thumb')?.classList.add('pn-loaded'), { once: true });
      if (img.complete && img.naturalWidth > 0) img.closest('.pn-photo, .pn-thumb')?.classList.add('pn-loaded');
      if (img.complete && img.naturalWidth === 0 && img.src) fail();
    });
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
        text: `Air burns at ${config.highAirBurnFactor}× planned rate (DEMO setting).` });
    }
    if (s.slowPace) {
      items.push({ level: 'info', kind: 'pace', title: 'Slow pace',
        text: `Crew walks at ${config.slowPaceFactor}× planned speed (DEMO setting)${sim?.schedule?.behindMin > 0.5 ? `, ${fmtMinLong(sim.schedule.behindMin)} behind` : ''}.` });
    }
    const eb = effectiveBudget(s, config);
    if (eb.demo) {
      items.push({ level: 'demo', kind: 'budget', title: `Demo budget ${eb.budgetMin} min`,
        text: `${DEMO_BUDGET_NOTE} (real ${eb.realBudgetMin} min). Reserve ${eb.reserveMin} min kept.` });
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
    const fitsAll = data.routes.variants.map((v) => variantFit(v, s));
    const key = JSON.stringify([idle, s.plannedVariantId, active?.id, why.length, fitsAll.map((f) => [f.fits, f.demo, f.budget])]);
    setSec('route', key, () => {
      const cards = data.routes.variants.map((v, vi) => {
        const sel = v.id === s.plannedVariantId;
        const f = fitsAll[vi];
        const fitTitle = `${fmtMinLong(f.needed)} with reserve vs ${f.budget} min ${f.demo ? `DEMO budget (${DEMO_BUDGET_NOTE})` : 'suit budget'}${f.pace !== 1 ? `, at ${f.pace}x pace` : ''}${f.burn !== 1 ? `, ${f.burn}x air burn` : ''}`;
        return `
        <button type="button" class="pn-variant" data-action="variant" data-id="${esc(v.id)}"
          aria-pressed="${sel}" ${idle ? '' : 'disabled'} title="${idle ? 'Plan this variant' : 'Reset the sim to change the plan'}">
          <div class="pn-variant-top">
            <span class="pn-variant-id">${esc(v.id)}</span>
            <span class="pn-variant-stops">${esc(routeLabel(v))}</span>
            <span class="pn-pill" data-level="${f.fits ? 'ok' : 'danger'}" title="${esc(fitTitle)}">${f.fits ? 'fits budget' : 'over budget'}</span>${f.demo ? demoTag() : ''}
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

  function photosHtml(st) {
    const ph = data.photosByStop?.[st.id] || { featured: [], candidates: [], note: '' };
    const fl = ph.featured || [];
    const fCredits = [...new Set(fl.map((f) => f.credit).filter(Boolean))];
    const oneCredit = fCredits.length === 1;
    const featured = fl.map((f, i) => `
      <figure class="pn-photo pn-photo-featured${i ? ' pn-photo-small' : ''}" title="${esc(f.caption || '')}">
        <a class="pn-photo-link" href="${esc(f.url)}" target="_blank" rel="noopener" title="Open full image in a new tab">
          <img src="${esc(f.url)}" alt="${esc(f.caption || `${st.name} photo ${i + 1}`)}" loading="lazy" referrerpolicy="no-referrer" data-fb>
        </a>
        <span class="pn-img-fallback" hidden>Photo unavailable · <a href="${esc(f.url)}" target="_blank" rel="noopener">open link</a></span>
        ${f.caption || (f.credit && !oneCredit) ? `<figcaption>${f.caption ? `<span>${esc(f.caption)}</span>` : ''}${f.credit && !oneCredit ? `<span class="pn-credit">Credit: ${esc(f.credit)}</span>` : ''}</figcaption>` : ''}
      </figure>`).join('');
    const cands = ph.candidates || [];
    const thumbs = cands.map((c) => {
      const cap = `Sol ${c.sol ?? '?'} · ${camLabel(c.camera)}`;
      return `
      <a class="pn-thumb" href="${esc(c.url)}" target="_blank" rel="noopener"
        title="${esc(`${cap}${c.dateUtc ? ` · ${fmtUtcTime(c.dateUtc)}` : ''}${c.credit ? ` · ${c.credit}` : ''} (opens in a new tab)`)}">
        <img src="${esc(c.thumb || c.url)}" alt="${esc(`${st.name}: ${cap}`)}" loading="lazy" referrerpolicy="no-referrer" data-fb>
        <span class="pn-img-fallback" hidden>n/a</span>
        <span class="pn-thumb-cap">Sol ${esc(c.sol ?? '?')}<br>${esc(camLabel(c.camera))}</span>
      </a>`;
    }).join('');
    const candCredits = [...new Set(cands.map((c) => c.credit).filter(Boolean))];
    let html = '';
    if (featured) {
      html += `<div class="pn-featured" data-n="${fl.length}">${featured}</div>`;
      if (oneCredit) html += `<div class="pn-credit">Credit: ${esc(fCredits[0])}</div>`;
    }
    if (ph.note) html += `<p class="pn-photo-note"><span class="pn-label">Photos</span>${esc(ph.note)}</p>`;
    if (thumbs) {
      html += `
        <div class="pn-strip-head"><span class="pn-label">${ph.note ? 'Rover images from nearby positions' : 'Rover images near this spot'} (${cands.length})</span>
          ${ph.note ? '<span class="pn-dim pn-small">see note above</span>'
            : Number.isFinite(ph.radiusM) ? `<span class="pn-dim pn-small">within ${esc(ph.radiusM)} m${ph.parkedSols?.length ? ` · rover parked here ${ph.parkedSols.length} sols` : ''}</span>` : ''}</div>
        <div class="pn-strip" role="list">${thumbs}</div>
        ${candCredits.length ? `<div class="pn-credit">Raw images: ${esc(candCredits.join('; '))} (Perseverance, not mission-calibrated)</div>` : ''}`;
    }
    if (!html && st.kind !== 'base') html = '<div class="pn-photo-none">No photos for this stop</div>';
    return html;
  }

  /** Extra facts from site.json (habitat / stop A). */
  function siteFacts(st) {
    const site = data.site;
    if (!site) return '';
    const row = (label, value, title = '') => (value === '' || value == null ? '' : `<div${title ? ` title="${esc(title)}"` : ''}><span>${esc(label)}</span><b>${value}</b></div>`);
    if (st.kind === 'science' && site.stop_a) {
      const a = site.stop_a;
      const cored = (a.depot_samples_cored_here || []).join(', ');
      return `
        <h3 class="pn-h">Site facts <span class="pn-dim">(site.json)</span></h3>
        <div class="pn-kv">
          ${row('Sample cored here', cored ? esc(cored) : '', 'Perseverance cored this depot sample at this waypoint')}
          ${row('Clay fraction', esc(pct(a.clay_frac)), 'CRISM Fe/Mg clay fraction within 75 m')}
          ${row('Carbonate fraction', esc(pct(a.carb_frac)), 'CRISM carbonate fraction within 75 m')}
          ${row('Slope p90 (HiRISE)', Number.isFinite(a.hirise_slope_p90_deg) ? `${esc(num(a.hirise_slope_p90_deg, 1))}°` : '', '90th percentile slope across the work area, HiRISE DTM')}
          ${row('Roughness p90', Number.isFinite(a.hirise_rough_p90_m) ? `${esc(num(a.hirise_rough_p90_m, 2))} m` : '')}
          ${row('Sand / no-go', `${esc(pct(a.sand_frac))} / ${esc(pct(a.nogo_frac))}`)}
          ${row('Rover waypoint', Number.isFinite(a.sol) ? esc(`sol ${a.sol}, site ${a.site}, drive ${a.drive}`) : '')}
          ${row('To depot', Number.isFinite(a.dist_to_depot_m) ? esc(fmtDistM(a.dist_to_depot_m)) : '')}
        </div>
        ${site.criteria?.stop_a ? `<details class="pn-details" data-key="crit-a"${openAttr('crit-a')}><summary>How stop A was picked</summary><p class="pn-small pn-dim">${esc(site.criteria.stop_a)}</p></details>` : ''}`;
    }
    if (st.kind === 'base' && site.habitat) {
      const h = site.habitat;
      return `
        <h3 class="pn-h">Site facts <span class="pn-dim">(site.json)</span></h3>
        <div class="pn-kv">
          ${row('Mean slope (100 m)', Number.isFinite(h.mean_slope_100m_deg) ? `${esc(num(h.mean_slope_100m_deg, 1))}°` : '', h.slope_source || '')}
          ${row('To depot', Number.isFinite(h.dist_to_depot_m) ? esc(fmtDistM(h.dist_to_depot_m)) : '')}
        </div>
        ${site.criteria?.habitat ? `<details class="pn-details" data-key="crit-h"${openAttr('crit-h')}><summary>How the habitat site was picked</summary><p class="pn-small pn-dim">${esc(site.criteria.habitat)}</p></details>` : ''}`;
    }
    return '';
  }

  /** Depot tube list for B. */
  function tubesHtml(st) {
    const tubes = data.depot?.tubes || [];
    if (st.kind !== 'depot' || !tubes.length) return '';
    const credits = [...new Set(tubes.map((t) => t.credit).filter(Boolean))];
    const rows = tubes.map((t, i) => `
      <tr>
        <td><button type="button" class="pn-linkbtn" data-action="focus-tube" data-i="${i}" title="Center map on this tube">${esc(t.name)}</button></td>
        <td class="pn-mono" title="${esc(t.sampleId)}">${esc(String(t.sampleId || '').replace(/^M2020-/, ''))}</td>
        <td class="pn-num" title="${esc(t.dropLmst || '')}">${esc(t.dropSol ?? '—')}</td>
        <td class="pn-num">${esc(t.coredSol ?? '—')}</td>
        <td>${t.closeup ? `<a href="${esc(t.closeup)}" target="_blank" rel="noopener" title="${esc(`Close-up ortho image of ${t.name}${t.credit ? ` · ${t.credit}` : ''}`)}">image</a>` : '—'}</td>
      </tr>`).join('');
    const c = data.depot.center;
    return `
      <h3 class="pn-h">Sample tubes at the depot (${tubes.length})</h3>
      <div class="pn-small pn-dim">Sample IDs are M2020-&lt;cored sol&gt;-&lt;n&gt;. Click a name to show the tube on the map.</div>
      ${c && Number.isFinite(c.spreadM) ? `<div class="pn-small pn-dim">Spread over about ${esc(c.spreadM)} m; ~${esc(Math.round((st.work_min || 0) / tubes.length))} min per tube in the plan.</div>` : ''}
      <div class="pn-tablewrap">
        <table class="pn-table">
          <thead><tr><th>Tube</th><th>Sample ID</th><th class="pn-num" title="Sol the tube was dropped at the depot">Drop</th><th class="pn-num" title="Sol the sample was cored">Cored</th><th title="Close-up ortho image">Img</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${credits.length ? `<div class="pn-credit">Close-ups: ${esc(credits.join('; '))}</div>` : ''}`;
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
      const { sp, rec, visited, dropped, inPlan, variant } = times;
      const statusPill = dropped ? '<span class="pn-pill" data-level="danger">dropped</span>'
        : visited ? '<span class="pn-pill" data-level="ok">visited</span>'
        : !inPlan ? '<span class="pn-pill">not in plan</span>' : '';
      const row = (label, value, title = '') => (value === '' || value == null ? '' : `<div${title ? ` title="${esc(title)}"` : ''}><span>${label}</span><b>${value}</b></div>`);
      const ll = pxToLonLat(st.px, data.geo);
      // H's "expect" is the photo note in the real data; do not show it twice.
      const expect = st.expect && st.expect !== data.photosByStop?.[st.id]?.note ? st.expect : '';
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
          ${photosHtml(st)}
          ${st.why ? `<p class="pn-goal"><span class="pn-label">${st.kind === 'science' ? 'Science goal' : st.kind === 'depot' ? 'Task' : 'Site'}</span>${esc(st.why)}</p>` : ''}
          ${expect ? `<p class="pn-goal"><span class="pn-label">What to expect</span>${esc(expect)}</p>` : ''}
          <div class="pn-kv">
            ${row('Rock unit', st.rock_unit ? esc(st.rock_unit) : '', 'Stack et al. geologic unit (geology layer)')}
            ${row('Minerals', st.minerals ? esc(st.minerals) : '', 'CRISM mineral map (minerals layer)')}
            ${row('Work time', Number.isFinite(st.work_min) ? `${esc(fmtMinLong(st.work_min))} ${basisBadge(data.safety?.params?.[st.kind === 'depot' ? 'work_min_depot' : 'work_min_science_stop']?.basis || 'assumption', data.safety?.params?.[st.kind === 'depot' ? 'work_min_depot' : 'work_min_science_stop']?.source || '')}` : '')}
            ${row('Rover sol', st.sol ? esc(st.sol) : '', 'Perseverance sol at this spot')}
            ${row('Grid px', esc(`${st.px[0]}, ${st.px[1]}`))}
            ${ll ? `<div class="pn-kv-wide" title="Linear interpolation between the bounds.json corners"><span>Lon / lat <small>(approx., linear between corners)</small></span><b>${esc(fmtLonLat(ll, 5))}</b></div>` : ''}
          </div>
          ${siteFacts(st)}
          ${tubesHtml(st)}
          ${sp ? `
          <h3 class="pn-h">Planned times <span class="pn-dim">(${esc(variant.id)})</span></h3>
          <div class="pn-kv">
            ${row('Arrive', esc(tPlus(sp.arrive_min)))}
            ${row('Depart', esc(tPlus(sp.depart_min)))}
            ${row('Walk home from here', esc(fmtMinLong(sp.home_min)))}
            ${row('Plan left after arrival', esc(fmtMinLong(sp.remaining_min)))}
            ${rec ? row('Actual arrival', `${esc(tPlus(rec.t))}${Number.isFinite(sp.arrive_min) ? ` <small class="pn-dim">(${rec.t - sp.arrive_min >= 0 ? '+' : ''}${esc(num(rec.t - sp.arrive_min, 0))} min)</small>` : ''}`) : ''}
          </div>` : `<p class="pn-dim pn-small">Not on the ${esc(variant?.id || '')} plan.</p>`}
        </div>`;
    });
  }

  // ---------------------------------------------------------------- safety
  // Does a variant fit the budget in force (real or DEMO) at the selected pace / burn? Same numbers as
  // airNumbers' idle branch; routes.json fits_budget was computed against the real budget at 1x only.
  function variantFit(v, s) {
    const eb = effectiveBudget(s, config);
    const burn = s.faults?.highAir ? config.highAirBurnFactor : 1;
    const pace = s.slowPace ? config.slowPaceFactor : 1;
    const est = v?.est_min ?? (v?.t_min?.at(-1) ?? 0);
    const planMin = pace !== 1 && v?.path ? pacedDuration(v.path, v.t_min, 0, v.t_min[v.t_min.length - 1], pace) : est;
    const needed = planMin * burn + eb.reserveMin;
    return { fits: needed <= eb.budgetMin + 1e-9, needed, budget: eb.budgetMin, demo: eb.demo, pace, burn };
  }

  function airNumbers(s) {
    const sim = s.sim;
    const eb = effectiveBudget(s, config);
    const budget = eb.budgetMin;
    const reserve = eb.reserveMin;
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
        source: 'plan', burn, pace, planMin, planAir, variantId: pv?.id, demo: eb.demo,
      };
    }
    const a = sim.air;
    const th = Number.isFinite(a.timeHomeMin) ? a.timeHomeMin : null;
    const b = Number.isFinite(a.budgetMin) ? a.budgetMin : budget;
    return {
      planned: false, budget: b, reserve: a.reserveMin ?? reserve, left: a.leftMin,
      timeHome: th, needed: Number.isFinite(a.neededMin) ? a.neededMin : (th ?? 0) + (a.reserveMin ?? reserve),
      homeAir: a.homeAirMin, wayHome: a.wayHomeMin, pace: a.paceFactor ?? 1,
      margin: Number.isFinite(a.marginMin) ? a.marginMin : a.leftMin - (th ?? 0) - reserve,
      level: a.level || 'ok', source: a.timeHomeSource || 'none', burn: a.burnFactor ?? 1,
      used: a.usedMin, turnaround: a.turnaround,
      // the sim's own flag when it has one, else "the budget in use differs from the real one"
      demo: typeof a.budgetDemo === 'boolean' ? a.budgetDemo : b !== eb.realBudgetMin,
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
      const f = variantFit(v, s);
      if (!f.fits) w.push(`Variant ${v.id} (${routeLabel(v)}) does not fit the ${f.demo ? `${f.budget} min DEMO budget` : 'suit budget'}${f.pace !== 1 || f.burn !== 1 ? ' at the current pace / air use' : ''}`);
    });
    if (data.env?.source === 'default') w.push('No environment file (env_data.json / env.json): dust and solar status unknown');
    if (data.safety?.missing) w.push(`safety_params.json missing: suit budget from ${config.budgetSource}`);
    if (data.fake) w.push('FAKE DATA: terrain, routes and stop info are placeholders, not mission data');
    const tv = s.sim?.air?.timeHomeSource;
    if (tv === 'none') w.push('Time to walk home unknown at the current position (off the time-home grid)');
    else if (tv === 'route') w.push('Time home taken from the route (time-home grid has no value here)');
    return w;
  }

  const PARAM_LABEL = {
    slope_hard_deg: 'Slope hard limit', slope_soft_deg: 'Slope soft limit', rough_hard_m: 'Roughness limit',
    walk_speed_flat_kmh: 'Walking speed (flat)', walkback_speed_kmh: 'Walk-back speed', slope_speed_model: 'Slope speed model',
    speed_factor_sand_small: 'Speed on small ripples', speed_factor_sand_large: 'Speed on large bedforms',
    speed_factor_rocky: 'Speed on rocky units', suit_budget_min: 'Suit budget', reserve_min: 'Reserve',
    apollo_time_in_suit_min: 'Apollo time-in-suit limit', max_walkback_km: 'Max walk-back distance',
    work_min_science_stop: 'Work at a science stop', work_min_depot: 'Work at the depot',
  };
  const paramLabel = (k) => PARAM_LABEL[k] || k.replace(/_/g, ' ');
  const paramValue = (p) => {
    if (typeof p.value === 'number') {
      const u = p.unit || '';
      if (u === 'deg') return `${p.value}°`;
      if (/^x speed/.test(u)) return `${p.value}×`;
      if (/^(min|km|km\/h)$/.test(u)) return `${p.value} ${u}`;
      return `${p.value}${u ? ` ${u.split(' (')[0]}` : ''}`;
    }
    return String(p.value ?? '—');
  };

  function budgetBlock(s, a) {
    const eb = effectiveBudget(s, config);
    const sp = data.safety?.params || {};
    const bP = sp.suit_budget_min, rP = sp.reserve_min, apollo = sp.apollo_time_in_suit_min;
    const idle = isIdle(s);
    const opts = (config.budgetOptions || []).map((o) => {
      const v = o.value == null ? '' : String(o.value);
      const sel = (eb.demo ? String(eb.budgetMin) : '') === v;
      return `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(o.label)}${o.demo ? ' (DEMO)' : ''}</option>`;
    }).join('');
    // a non-standard ?budget=<n> value still shows as selected
    const extra = eb.demo && !(config.budgetOptions || []).some((o) => o.value === eb.budgetMin)
      ? `<option value="${esc(eb.budgetMin)}" selected>Demo ${esc(eb.budgetMin)} min (DEMO)</option>` : '';
    const realLine = `
      <div class="pn-budget-line${eb.demo ? ' pn-struck' : ''}">
        <span><b>${esc(eb.realBudgetMin)} min</b> suit budget ${basisBadge(bP?.basis || 'assumption', bP?.source || `from ${config.budgetSource}`)}</span>
        <span><b>${esc(eb.reserveMin)} min</b> reserve ${basisBadge(rP?.basis || 'assumption', rP?.source || `from ${config.budgetSource}`)}</span>
        <span><b>${esc(eb.realBudgetMin - eb.reserveMin)} min</b> usable</span>
      </div>`;
    const demoLine = eb.demo ? `
      <div class="pn-demo" role="note">
        <div class="pn-demo-title">${demoTag()} Demo ${esc(eb.budgetMin)} min budget in use</div>
        <div>${esc(DEMO_BUDGET_NOTE)}; real ${esc(eb.realBudgetMin)} min. Reserve ${esc(eb.reserveMin)} min kept, ${esc(eb.usableMin)} min usable.
          It makes the plan tight enough that <b>Slow pace</b> triggers a replan.</div>
      </div>` : '';
    return `
      <div class="pn-budget" data-demo="${eb.demo}">
        ${demoLine}
        ${realLine}
        ${apollo ? `<div class="pn-small pn-dim">Reference: Apollo time-in-suit limit ~${esc(apollo.value)} min ${basisBadge(apollo.basis, apollo.source)} (historical, not used)</div>` : ''}
        <label class="pn-budget-sel">
          <span>Demo budget</span>
          <select data-action="budget" ${idle ? '' : 'disabled'} data-demo="${eb.demo}"
            title="${esc(idle ? `Same as the top-bar select. Demo values are a ${DEMO_BUDGET_NOTE}.` : 'Reset the sim to change the budget')}">${opts}${extra}</select>
          ${idle ? '' : '<span class="pn-dim pn-small">locked while walking</span>'}
        </label>
        ${a.planned ? '' : (a.budget !== eb.budgetMin ? `<div class="pn-small pn-warn">Sim is using ${esc(fmtMinLong(a.budget))} (it applies a new budget from the next step).</div>` : '')}
      </div>`;
  }

  // Live numbers of the Safety card (air left, needed, bar widths, time home, margin). They change
  // every frame while the sim plays, so they are patched in place; the card itself is only rebuilt
  // when something structural changes (budget, idle, level, variant, warnings...).
  function safetyLive(a) {
    const B = a.budget || 1;
    const pctOf = (v) => `${Math.max(0, Math.min(100, ((v ?? 0) / B) * 100)).toFixed(2)}%`;
    const thNote = a.planned
      ? `est_min of ${a.variantId || ''}${a.planAir != null && Math.abs(a.planAir - a.timeHome) > 0.5 ? ` · uses ${fmtMinLong(a.planAir)} of air` : ''}`
      : `source: ${a.source}${Number.isFinite(a.wayHome) && Number.isFinite(a.timeHome) && a.wayHome > a.timeHome + 0.5 ? ` · routed way home ${fmtMinLong(a.wayHome)}` : ''}${Number.isFinite(a.homeAir) && Math.abs(a.homeAir - Math.max(a.timeHome ?? 0, a.wayHome ?? 0)) > 0.5 ? ` · uses ${fmtMinLong(a.homeAir)} of air` : ''}`;
    return {
      left: { text: fmtMinLong(a.left) },
      needed: { text: fmtMinLong(a.needed) },
      bar: { attr: { 'aria-label': `Air left ${fmtMinLong(a.left)}, needed ${fmtMinLong(a.needed)} of ${fmtMinLong(a.budget)} budget${a.demo ? ` (${DEMO_BUDGET_NOTE})` : ''}` } },
      barLeft: { style: { width: pctOf(a.left) } },
      barNeed: { style: { width: pctOf(a.needed) }, cls: `pn-airbar-need${a.left < a.needed ? ' pn-short' : ''}` },
      barRes: { style: { left: pctOf(a.reserve) }, attr: { title: `Reserve ${fmtMinLong(a.reserve)}` } },
      barNeedMark: { style: { left: pctOf(a.needed) } },
      timeHome: { text: fmtMinLong(a.timeHome) },
      timeHomeNote: { text: thNote },
      margin: { text: fmtMinLong(a.margin), cls: a.margin < 0 ? 'pn-danger' : a.level === 'warn' ? 'pn-warn' : 'pn-ok' },
    };
  }

  function patchLive(root, live) {
    root.querySelectorAll('[data-live]').forEach((el) => {
      const v = live[el.dataset.live];
      if (!v) return;
      if (v.text != null && el.textContent !== v.text) el.textContent = v.text;
      if (v.cls != null && el.className !== v.cls) el.className = v.cls;
      if (v.style) for (const [k, x] of Object.entries(v.style)) if (el.style[k] !== x) el.style[k] = x;
      if (v.attr) for (const [k, x] of Object.entries(v.attr)) if (el.getAttribute(k) !== x) el.setAttribute(k, x);
    });
  }

  function renderSafety(s) {
    const a = airNumbers(s);
    const eb = effectiveBudget(s, config);
    const warns = warningsList(s);
    const idle = isIdle(s);
    const key = JSON.stringify([a.planned, a.budget, a.demo, eb.budgetMin, idle,
      a.level, a.source, a.burn, a.pace, a.variantId, a.turnaround, warns]);
    setSec('safety', key, () => {
      const assumptions = (config.assumptions || []).map((x) => `
        <li>${x.bases ? x.bases.map((b) => basisBadge(b.basis, b.keys.length ? `safety_params: ${b.keys.join(', ')}` : '')).join(' ') : basisBadge(x.basis)} ${esc(x.text)} <span class="pn-src">${esc(x.source)}</span></li>`).join('');
      const params = (data.safety?.list || []).map((p) => `
        <li class="pn-param">
          <div class="pn-param-top"><span class="pn-param-name">${esc(paramLabel(p.key))}</span>
            <b class="pn-param-val" title="${esc(p.unit)}">${esc(paramValue(p))}</b>${basisBadge(p.basis)}</div>
          ${p.source ? `<div class="pn-src pn-param-src">${esc(p.source)}</div>` : ''}
          ${p.note ? `<div class="pn-param-note">${esc(p.note)}</div>` : ''}
        </li>`).join('');
      const counts = (data.safety?.list || []).reduce((m, p) => ((m[p.basis] = (m[p.basis] || 0) + 1), m), {});
      const countTxt = ['primary', 'secondary', 'assumption'].filter((b) => counts[b]).map((b) => `${counts[b]} ${b}`).join(' · ');
      return `
        <div class="pn-card-head"><h2>Safety check</h2><span class="pn-pill" data-level="${a.level}">${LEVEL_WORD[a.level] || a.level}</span></div>
        ${budgetBlock(s, a)}
        <div class="pn-air" data-level="${a.level}">
          <div class="pn-air-legend">
            <span><i class="pn-sw pn-sw-left"></i>${a.planned ? 'Air at start' : 'Air left'} <b data-live="left"></b></span>
            <span><i class="pn-sw pn-sw-need"></i>${a.planned ? 'Plan + reserve' : 'Walk home + reserve'}${a.burn !== 1 || (a.pace ?? 1) !== 1 ? ' <small>(air at current burn / pace)</small>' : ''} <b data-live="needed"></b></span>
          </div>
          <div class="pn-airbar${a.demo ? ' pn-airbar-demo' : ''}" role="img" data-live="bar">
            <div class="pn-airbar-left" data-live="barLeft"></div>
            <div class="pn-airbar-need" data-live="barNeed"></div>
            <div class="pn-airbar-reserve" data-live="barRes"><span>reserve</span></div>
            <div class="pn-airbar-needmark" data-live="barNeedMark"></div>
          </div>
          <div class="pn-airbar-scale"><span>0</span><span>budget ${esc(Math.round(a.budget))} min ${a.demo ? demoTag(`${DEMO_BUDGET_NOTE} (real ${eb.realBudgetMin} min)`) : basisBadge(data.safety?.params?.suit_budget_min?.basis || 'assumption', data.safety?.params?.suit_budget_min?.source || '')}</span></div>
        </div>
        <div class="pn-kv pn-kv-3">
          <div><span>${a.planned ? 'Planned walk' : 'Time to walk home'}</span><b data-live="timeHome"></b>
            <small class="pn-dim" data-live="timeHomeNote"></small></div>
          <div><span>Margin</span><b data-live="margin"></b>
            <small class="pn-dim">after reserve${a.demo ? ' · demo budget' : ''}</small></div>
          <div><span>Burn rate</span><b>${esc(num(a.burn, 1))}×</b><small class="pn-dim">${a.burn > 1 ? 'high air use (DEMO)' : 'nominal'}</small></div>
        </div>
        ${warns.length ? `<h3 class="pn-h">Warnings</h3><ul class="pn-warnings">${warns.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        ${params ? `<details class="pn-details" data-key="params"${openAttr('params')}>
          <summary>Safety parameters (${(data.safety.list || []).length}${countTxt ? `: ${esc(countTxt)}` : ''})</summary>
          <ul class="pn-params">${params}</ul>
          <p class="pn-small pn-dim">From safety_params.json. PRIMARY = NASA / mission source, SECONDARY = quoted guideline, ASSUMPTION = our choice.</p>
        </details>` : ''}
        <details class="pn-details" data-key="assumptions"${openAttr('assumptions')}>
          <summary>Assumptions (${(config.assumptions || []).length})</summary>
          <ul class="pn-assumptions">${assumptions}</ul>
        </details>
        ${config.replanRule ? `<details class="pn-details" data-key="rule"${openAttr('rule')}><summary>Replan rule (from routes.json)</summary><p class="pn-small pn-rule">${esc(config.replanRule)}</p>
          <p class="pn-small pn-dim">The sim applies it to option minutes at the crew's current pace, and also requires those minutes × burn rate + reserve ≤ air left. The budget is the one in force${eb.demo ? ` (now the DEMO ${esc(eb.budgetMin)} min)` : ''}.</p></details>` : ''}`;
    });
    patchLive(sec.safety, safetyLive(a));
  }

  // ---------------------------------------------------------------- environment
  function sparkline(hourly) {
    const pts = (hourly || []).filter((h) => Number.isFinite(h.airTempC) && Number.isFinite(h.hour));
    if (pts.length < 3) return '';
    const W = 220, H = 44, P = 3;
    const all = pts.flatMap((h) => [h.airTempC, Number.isFinite(h.groundTempC) ? h.groundTempC : h.airTempC]);
    const lo = Math.min(...all), hi = Math.max(...all);
    const x = (hr) => P + (hr / 23) * (W - 2 * P);
    const y = (v) => P + (1 - (v - lo) / ((hi - lo) || 1)) * (H - 2 * P);
    const line = (k) => pts.filter((h) => Number.isFinite(h[k])).map((h) => `${x(h.hour).toFixed(1)},${y(h[k]).toFixed(1)}`).join(' ');
    const zero = lo < 0 && hi > 0 ? `<line x1="${P}" x2="${W - P}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" class="pn-spark-zero"/>` : '';
    return `
      <figure class="pn-spark">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Hourly temperature profile: air ${esc(num(Math.min(...pts.map((h) => h.airTempC)), 0))} to ${esc(num(Math.max(...pts.map((h) => h.airTempC)), 0))} °C">
          ${zero}
          <polyline class="pn-spark-ground" points="${line('groundTempC')}"/>
          <polyline class="pn-spark-air" points="${line('airTempC')}"/>
        </svg>
        <figcaption class="pn-small pn-dim"><i class="pn-sw pn-sw-air"></i>air <i class="pn-sw pn-sw-ground"></i>ground · hour 0–23 LTST${zero ? ' · line = 0 °C' : ''}</figcaption>
      </figure>`;
  }

  const srcLine = (o) => (o && (o.source || o.timeFrame)
    ? `<div class="pn-src pn-env-src">${o.timeFrame ? `${esc(o.timeFrame)}` : ''}${o.timeFrame && o.source ? ' · ' : ''}${o.source ? esc(o.source) : ''}</div>` : '');
  const tempRange = (r) => (r && Number.isFinite(r.min) && Number.isFinite(r.max) ? `${num(r.min, 0)} to ${num(r.max, 0)} °C` : '—');

  function renderEnv(s) {
    const e = envNumbers(s);
    const env = data.env || {};
    const key = JSON.stringify([e, env.source]);
    setSec('env', key, () => {
      const chips = `
        <div class="pn-env">
          <span class="pn-chip" data-level="${e.storm ? 'danger' : /high|severe/i.test(e.dust) ? 'warn' : /moderate/i.test(e.dust) ? 'info' : 'ok'}">Dust: ${esc(e.storm ? 'STORM' : e.dust)}${env.dustTau && Number.isFinite(env.dustTau.estimate) && !e.storm ? ` · τ ${esc(num(env.dustTau.estimate, 2))}` : ''}</span>
          <span class="pn-chip" data-level="${e.solar ? 'danger' : 'ok'}">Solar: ${e.solar ? 'ALERT' : 'no alert'}</span>
          ${e.storm ? '<span class="pn-chip" data-level="danger">Storm (DEMO)</span>' : ''}
        </div>
        ${e.text ? `<div class="pn-small ${e.storm ? 'pn-danger' : 'pn-dim'}">${esc(e.text)}</div>` : ''}`;
      const head = `<div class="pn-card-head"><h2>Environment</h2><span class="pn-pill" data-level="${e.level}">${LEVEL_WORD[e.level] || e.level}</span></div>`;
      if (env.source !== 'env_data') {
        // old env.json (or nothing): the one-liners as before
        return `${head}${chips}
          ${e.radiation ? `<div class="pn-small pn-dim">Radiation note: ${esc(e.radiation)}</div>` : ''}
          <div class="pn-src">${env.source === 'env' ? 'from env.json' : 'no environment data file'}</div>`;
      }
      const w = env.weather, d = env.dustTau, r = env.radiation, sw = env.spaceWeather;
      const cmes = sw?.cmeArrivals30d || [];
      const cmeRows = cmes.slice().sort((x, y) => String(y.arrivalUtc).localeCompare(String(x.arrivalUtc))).map((c) => {
        const impact = c.minorImpact ? 'minor impact' : c.glancingBlow ? 'glancing blow' : 'arrival';
        return `<li><span class="pn-mono">${esc(fmtUtcTime(c.arrivalUtc))}</span>
          <span class="pn-tag" data-impact="${c.minorImpact ? 'minor' : c.glancingBlow ? 'glancing' : 'none'}">${esc(impact)}</span>
          ${c.link ? `<a href="${esc(c.link)}" target="_blank" rel="noopener" title="${esc((c.cmeIds || []).join(', '))}">DONKI</a>` : ''}</li>`;
      }).join('');
      return `${head}${chips}
        ${d ? `
        <div class="pn-env-block">
          <h3 class="pn-h">Dust</h3>
          <div class="pn-env-row"><b>τ ${esc(num(d.estimate, 2))}</b>
            ${Array.isArray(d.range) ? `<span class="pn-dim">range ${esc(num(d.range[0], 2))}–${esc(num(d.range[1], 2))}</span>` : ''}
            ${d.isEstimate ? `<span class="basis" data-basis="assumption" title="${esc(d.method || 'estimate')}">ESTIMATE</span>` : ''}
            <span class="pn-dim pn-small">word "${esc(env.dust)}" from app thresholds (low &lt; 0.6, moderate &lt; 1.0)</span></div>
          ${d.method ? `<div class="pn-small pn-dim">Method: ${esc(d.method)}</div>` : ''}
          ${srcLine(d)}
        </div>` : ''}
        ${w ? `
        <div class="pn-env-block">
          <h3 class="pn-h">Weather (MEDA)</h3>
          <div class="pn-kv pn-kv-3">
            <div><span>Air temperature</span><b>${esc(tempRange(w.airTempC))}</b></div>
            <div><span>Ground temperature</span><b>${esc(tempRange(w.groundTempC))}</b></div>
            <div><span>Pressure</span><b>${Number.isFinite(w.pressurePa) ? `${esc(num(w.pressurePa, 0))} Pa` : '—'}</b></div>
          </div>
          ${sparkline(w.hourly)}
          <div class="pn-small"><span class="pn-dim">Wind:</span> ${w.wind != null ? esc(JSON.stringify(w.wind)) : esc(w.windNote || 'not available')}</div>
          ${srcLine(w)}
        </div>` : ''}
        ${r ? `
        <div class="pn-env-block">
          <h3 class="pn-h">Radiation ${r.standIn ? '<span class="basis" data-basis="secondary" title="Curiosity RAD at Gale crater, used because Perseverance carries no ionizing-radiation detector">CURIOSITY STAND-IN</span>' : ''}</h3>
          <div class="pn-env-row"><b>${Number.isFinite(r.doseUGyPerDay) ? `${esc(num(r.doseUGyPerDay, 0))} µGy/day` : '—'}</b>
            <span class="pn-dim pn-small">surface dose${Number.isFinite(r.doseSiliconUGyPerDay) ? ` (silicon ${esc(num(r.doseSiliconUGyPerDay, 0))})` : ''}</span></div>
          ${r.note ? `<div class="pn-small pn-dim">${esc(r.note)}</div>` : ''}
          ${r.reference ? `<div class="pn-src">Reference: ${esc(r.reference)}</div>` : ''}
          ${srcLine(r)}
        </div>` : ''}
        ${sw ? `
        <div class="pn-env-block">
          <h3 class="pn-h">Space weather (NASA DONKI)</h3>
          <div class="pn-env-row"><span class="pn-chip" data-level="${sw.solarAlert ? 'danger' : 'ok'}">Solar alert: ${sw.solarAlert ? 'YES' : 'none'}</span>
            <span class="pn-dim pn-small">${esc(cmes.length)} Mars CME arrival${cmes.length === 1 ? '' : 's'} in the last 30 days · ${esc((sw.upcoming || []).length)} upcoming</span></div>
          ${cmeRows ? `<details class="pn-details" data-key="cme"${openAttr('cme')}><summary>Recent Mars CME arrivals (${cmes.length})</summary><ul class="pn-cmes">${cmeRows}</ul>
            <p class="pn-small pn-dim">Modelled arrivals at Mars (WSA-ENLIL); ${sw.solarAlert ? 'env_data.json flags a solar alert.' : 'env_data.json sets no solar alert.'}</p></details>` : ''}
          <div class="pn-src pn-env-src">${sw.window ? `window ${esc(sw.window.join(' to '))} · ` : ''}${sw.fetchedUtc ? `fetched ${esc(fmtUtcTime(sw.fetchedUtc))} · ` : ''}${esc(sw.source || '')}</div>
        </div>` : ''}`;
    });
  }

  // ---------------------------------------------------------------- data and credits
  function renderCredits() {
    setSec('credits', 'static', () => {
      const prov = data.provenance;
      const sources = (prov?.sources || []).map((x) => `
        <li>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name || x.url)}</a>` : `<b>${esc(x.name)}</b>`}
          ${x.license ? `<span class="pn-tag">${esc(x.license)}</span>` : ''}
          ${x.credit ? `<div class="pn-credit">Credit: ${esc(x.credit)}</div>` : ''}
          ${x.processing ? `<div class="pn-src">${esc(x.processing)}</div>` : ''}</li>`).join('');
      const lit = (prov?.literature || []).map((t) => `<li>${esc(t)}</li>`).join('');
      const credits = (data.credits || []).map((t) => `<li>${esc(t)}</li>`).join('');
      const nSrc = prov?.sources?.length || 0;
      return `
        <details class="pn-details pn-credits" data-key="credits"${openAttr('credits')}>
          <summary>Data and credits${nSrc ? ` (${nSrc} sources)` : ''}</summary>
          ${sources ? `<h3 class="pn-h">Data sources</h3><ul class="pn-sources">${sources}</ul>` : '<p class="pn-small pn-dim">No provenance.json in this data folder.</p>'}
          ${credits ? `<h3 class="pn-h">Image and data credits</h3><ul class="pn-list">${credits}</ul>` : ''}
          ${lit ? `<details class="pn-details" data-key="lit"${openAttr('lit')}><summary>Literature (${(prov.literature || []).length})</summary><ul class="pn-list pn-lit">${lit}</ul></details>` : ''}
          ${prov?.aiUse ? `<h3 class="pn-h">AI use</h3><p class="pn-small pn-dim">${esc(prov.aiUse)}</p>` : ''}
          <p class="pn-small pn-dim">Images and data from NASA and its partners, as credited above. Rover raw images are not mission-calibrated products.</p>
        </details>`;
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
    if (!btn || !root.contains(btn) || btn.disabled || btn.tagName === 'SELECT') return;
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
    } else if (action === 'focus-tube') {
      const t = data.depot?.tubes?.[Number(btn.dataset.i)];
      if (t?.px) ctx.emit('map:focus', { px: t.px, zoom: 2 });
    } else if (action === 'close') {
      ctx.setState({ selectedStopId: null });
    }
  });

  // Mirror of the top-bar Demo budget select (same state key, only while idle).
  root.addEventListener('change', (ev) => {
    const sel = ev.target.closest('select[data-action="budget"]');
    if (!sel || !isIdle(ctx.getState())) return;
    const v = sel.value === '' ? null : Number(sel.value);
    ctx.setState({ demoBudgetMin: Number.isFinite(v) && v > 0 ? v : null });
  });

  // ---------------------------------------------------------------- render loop
  function renderAll(s) {
    renderBanners(s);
    renderReplan(s);
    renderRoute(s);
    renderStop(s);
    renderSafety(s);
    renderEnv(s);
    renderAlerts(s);
    renderCredits();
  }
  renderAll(ctx.getState());

  const WATCH = ['sim', 'plannedVariantId', 'selectedStopId', 'faults', 'slowPace', 'demoBudgetMin'];
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
