// tablet.js — the astronaut's tablet (mode 'tablet', container #tablet).
// Read-only view of state.sim, built for gloves: three numbers (distance, air, time home), a live map, four big
// buttons, and full-screen takeovers for a reroute proposal, a lost rover link and a storm.
// It only reads state and emits the existing events (replan:confirm, toast). See docs/ui-redesign.md.

import { fmtMin, fmtDistM, distM, esc, effectiveBudget, DEMO_BUDGET_NOTE } from './util.js';
import { createMiniMap } from './minimap.js';

const PX_PER_GRID = 2.3;          // screen px per grid px (2 m) at zoom 1: the map shows more ground on wider screens
const TRIGGER_TITLE = {
  schedule: 'Behind schedule: new plan suggested',
  air: 'Air is running short: head home',
  storm: 'Storm: head home now',
  hazard: 'Rover found a hazard ahead',
};

export function initTablet(ctx) {
  const { data, config } = ctx;
  const root = ctx.els.tablet;
  if (!root) return null;
  root.classList.add('tb-root');
  root.innerHTML = `
    <div class="tbl-strip">
      <span class="tbl-who" data-f="who">EV1</span>
      <span class="tbl-link"><i class="tbl-dot"></i><span data-f="link">Rover link</span></span>
      <span data-f="buddy" class="tbl-dim"></span>
      <span data-f="env" class="tbl-dim"></span>
      <span class="tbl-grow"></span>
      <span data-f="plan" class="tbl-dim"></span>
    </div>
    <div class="tbl-banner" data-f="banner" hidden></div>
    <div class="tbl-body">
      <section class="tbl-left" aria-label="Guidance">
        <div class="tbl-next" data-f="nextCard">
          <svg class="tbl-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 20 20 12 15.5 4 20Z"></path></svg>
          <div class="tbl-next-txt">
            <span class="tbl-k" data-f="nextLabel">Next stop</span>
            <span class="tbl-big" data-f="nextDist">—</span>
            <span class="tbl-sub" data-f="nextSub"></span>
          </div>
        </div>
        <div class="tbl-card tbl-air">
          <div class="tbl-row"><span class="tbl-k">Air left</span><span class="tbl-num" data-f="airLeft">—</span></div>
          <div class="tbl-bar" aria-hidden="true"><i data-f="barLeft"></i><i data-f="barReserve"></i></div>
          <div class="tbl-row tbl-row-sm">
            <span>Time home <b data-f="timeHome">—</b></span>
            <span data-f="margin"></span>
          </div>
          <span class="tbl-demo" data-f="demo" hidden></span>
        </div>
        <div class="tbl-card tbl-route">
          <div class="tbl-row"><span class="tbl-k">Route</span><span class="tbl-k" data-f="routeEta"></span></div>
          <ol class="tbl-steps" data-f="steps"></ol>
          <div class="tbl-prog" aria-hidden="true"><i data-f="prog"></i></div>
        </div>
        <div class="tbl-card tbl-status">
          <span class="tbl-k">Now</span>
          <span data-f="statusText" class="tbl-status-main"></span>
          <span data-f="rover" class="tbl-dim"></span>
          <span data-f="extra" class="tbl-warnline"></span>
        </div>
      </section>
      <section class="tbl-map" aria-label="Live map" data-f="map">
        <div class="tbl-legend"><span><i class="lg lg-ev1"></i>You</span><span><i class="lg lg-ev2"></i>Buddy</span><span><i class="lg lg-rover"></i>Rover</span></div>
        <div class="tbl-map-note" data-f="mapNote" hidden>Way home</div>
        <div class="tbl-zoom"><button type="button" data-zoom="-1" aria-label="Zoom in">+</button><button type="button" data-zoom="1" aria-label="Zoom out">−</button></div>
      </section>
    </div>
    <div class="tbl-actions tbl-actions-lost" data-f="lostActions" hidden>
      <button type="button" class="tbl-btn tbl-btn-go" data-act="walkhome">Start walking home</button>
      <button type="button" class="tbl-btn" data-act="wait">Wait for link</button>
      <button type="button" class="tbl-btn" data-act="landmark">I see a landmark</button>
    </div>
    <div class="tbl-actions" data-f="actions">
      <button type="button" class="tbl-btn" data-act="hazard"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 22 20H2Z"/><path d="M12 10v4M12 17v.5"/></svg><span data-l>Mark hazard</span></button>
      <button type="button" class="tbl-btn" data-act="photo"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="1.5"/><circle cx="12" cy="13.5" r="3.5"/><path d="M8.5 7 10 4.5h4L15.5 7"/></svg><span data-l>Take photo</span></button>
      <button type="button" class="tbl-btn tbl-btn-play" data-act="pause"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5v14l11-7Z"/></svg><span data-l>Start walk</span></button>
      <button type="button" class="tbl-btn tbl-btn-home" data-act="home" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11 12 4l9 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/></svg><span data-l>Way home</span></button>
    </div>
    <div class="tbl-takeover" data-f="replan" hidden></div>`;

  const f = Object.fromEntries([...root.querySelectorAll('[data-f]')].map((n) => [n.dataset.f, n]));
  const set = (k, v) => { if (f[k].textContent !== v) f[k].textContent = v; };

  // ---- live map
  const mm = createMiniMap(f.map, { url: data.url('basemap.png'), widthPx: config.widthPx, heightPx: config.heightPx,
    pixelM: config.pixelM, label: 'Live map around the crew' });
  const mmTrail = mm.line('mm-trail');
  const mmRoute = mm.line('mm-route');
  const mmHome = mm.line('mm-home');
  const mmProposed = mm.line('mm-proposed');
  const mmHazard = mm.circle('mm-hazard');
  const mmMarks = [];
  const stopSetters = data.stops.map((st) => [st, mm.diamond(`mm-stop mm-stop-${st.kind || 'science'}`, st.id, 16)]);
  const ring1 = mm.circle('mm-ring');
  const rover = mm.square('mm-rover', 9);
  const ev2 = mm.circle('mm-ev2');
  const ev1 = mm.circle('mm-ev1');
  stopSetters.forEach(([st, s]) => s(st.px));

  // ---- buttons
  let wayHome = false;
  let zoomF = 1;
  f.map.querySelector('.tbl-zoom').addEventListener('click', (e) => {
    const z = e.target.closest('[data-zoom]');
    if (!z) return;
    zoomF = Math.max(0.35, Math.min(3, zoomF * (Number(z.dataset.zoom) > 0 ? 1.5 : 1 / 1.5)));
    render(ctx.getState(), true);
  });
  root.addEventListener('click', (e) => {
    if (!e.target.closest('.tbl-actions')) return;
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const s = ctx.getState();
    const sim = s.sim;
    const at = sim ? `T+${fmtMin(sim.t)}` : '';
    const me = sim?.crew?.[s.tabletCrew ?? 0] || sim?.crew?.[0];
    if (b.dataset.act === 'walkhome' || b.dataset.act === 'wait') {
      if (!sim?.pendingReplan) ctx.setState({ playing: b.dataset.act === 'walkhome' });
      ctx.toast({ level: 'info', title: b.dataset.act === 'walkhome' ? 'Walking home on the saved route' : 'Holding position',
        text: b.dataset.act === 'walkhome' ? 'Suit keeps your route, air and time home without the rover.' : 'Waiting for the rover link; air and time home keep counting.' });
    } else if (b.dataset.act === 'landmark') {
      ctx.toast({ level: 'ok', title: 'Landmark confirmed', text: `Position fix requested at ${at} (demo). Turn the link back on in DEMO to snap the dot back.` });
    } else if (b.dataset.act === 'hazard') {
      if (me) mmMarks.push(me.px);
      ctx.toast({ level: 'warn', title: 'Hazard marked', text: `Pinned at your position ${at}. Sent to the rover and your buddy (demo).` });
      drawMarks();
    } else if (b.dataset.act === 'photo') {
      ctx.toast({ level: 'ok', title: 'Photo saved', text: `Tagged with position and time ${at} (demo).` });
    } else if (b.dataset.act === 'pause') {
      if (!sim?.pendingReplan) ctx.setState({ playing: !s.playing });
    } else if (b.dataset.act === 'home') {
      wayHome = !wayHome;
      b.setAttribute('aria-pressed', String(wayHome));
      render(ctx.getState(), true);
    }
  });
  const markNodes = [];
  function drawMarks() {
    while (markNodes.length < mmMarks.length) markNodes.push(mm.circle('mm-mark'));
    mmMarks.forEach((p, i) => markNodes[i](p, 5));
  }

  // ---- replan takeover (rebuilt only when the proposal changes)
  let replanId = null;
  f.replan.addEventListener('click', (e) => {
    const b = e.target.closest('[data-confirm]');
    if (b) ctx.emit('replan:confirm', { id: b.dataset.confirm });
  });
  function renderReplan(p) {
    if (!p) { f.replan.hidden = true; replanId = null; return; }
    f.replan.hidden = false;
    if (p.id === replanId) return;
    replanId = p.id;
    const sev = p.trigger === 'storm' || p.trigger === 'air' ? 'danger' : 'warn';
    const rejected = (p.rejected || []).map((r) => `<li>${esc(r.label)}${r.overByMin != null ? ` <span class="tbl-dim">· over by ${esc(Math.round(r.overByMin))} min</span>` : ''}</li>`).join('');
    f.replan.innerHTML = `
      <div class="tbl-modal" data-level="${sev}">
        <span class="tbl-k">${esc(p.atStopId ? `At ${p.atStopName || p.atStopId}` : 'On the way')} · T+${esc(fmtMin(p.arrivedT))}${p.behindMin >= 1 ? ` · ${esc(Math.round(p.behindMin))} min behind` : ''}</span>
        <h2 class="tbl-modal-h">${esc(TRIGGER_TITLE[p.trigger] || 'New route suggested')}</h2>
        <div class="tbl-suggest">
          <span class="tbl-k">Suggested</span>
          <span class="tbl-suggest-label">${esc(p.label)}</span>
          ${p.savesMin > 0 ? `<span class="tbl-ok">Saves ${esc(Math.round(p.savesMin))} min</span>` : ''}
        </div>
        <p class="tbl-safe"><b>Why it is safe:</b> ${esc(p.safety?.text || '')}</p>
        ${(p.why || []).length ? `<ul class="tbl-why">${p.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        ${rejected ? `<details class="tbl-rej"><summary>Options that did not fit</summary><ul>${rejected}</ul></details>` : ''}
        <button type="button" class="tbl-accept" data-confirm="${esc(p.id)}">Accept new route</button>
        <span class="tbl-dim tbl-fine">Both crew see this. The walk is paused until someone accepts.</span>
      </div>`;
  }

  // ---- route progress (planned stops, visited / dropped / next, progress along the walk)
  let routeKey = '';
  function renderRoute(s, sim) {
    const v = data.variantsById[s.plannedVariantId] || data.routes.variants[0];
    const visited = sim.visited || [], dropped = sim.dropped || [];
    const key = [v.id, visited.join(), dropped.join(), sim.nextStop?.id, sim.status].join('|');
    if (key !== routeKey) {
      routeKey = key;
      const last = v.stop_plan.length - 1;
      f.steps.innerHTML = v.stop_plan.map((sp, i) => {
        const st = data.stopsById[sp.id];
        const state = dropped.includes(sp.id) ? 'dropped'
          : (i > 0 && i < last && visited.includes(sp.id)) || (i === 0 && sim.status !== 'idle') || (i === last && (sim.status === 'done' || sim.status === 'aborted')) ? 'done'
          : (sim.nextStop?.id === sp.id && i > 0 && sim.status !== 'idle') ? 'next' : '';
        return `<li data-state="${state}" class="${st?.kind === 'base' ? 'is-base' : ''}"><i>${esc(sp.id)}</i>
          <span>${esc(i === 0 ? 'Start' : i === last ? 'Home' : st?.name || sp.id)}<b>T+${esc(fmtMin(sp.arrive_min))}</b></span></li>`;
      }).join('');
    }
    const end = sim.schedule?.projectedReturnT || v.est_min;
    const frac = sim.status === 'done' || sim.status === 'aborted' ? 1 : Math.max(0, Math.min(1, sim.t / end));
    f.prog.style.width = `${(frac * 100).toFixed(1)}%`;
    const eta = `Back T+${fmtMin(end)}`;
    if (f.routeEta.textContent !== eta) f.routeEta.textContent = eta;
  }

  // ---- main render
  function render(s, force = false) {
    if (s.mode !== 'tablet' && !force) return;
    const sim = s.sim;
    const b = effectiveBudget(s, config);
    if (!sim) {
      set('statusText', 'Sim not loaded');
      return;
    }
    const linkOk = sim.link?.ok !== false;
    const storm = !!sim.env?.stormActive;
    const ci = Math.min(sim.crew.length - 1, Math.max(0, s.tabletCrew ?? 0));
    const ev = sim.crew[ci];
    const buddy = sim.crew[1 - ci] || sim.crew[0];

    // strip
    root.dataset.link = linkOk ? 'ok' : 'lost';
    set('link', linkOk ? 'Rover link' : 'Rover link lost');
    set('who', ev.label || ev.id);
    set('buddy', `Buddy ${buddy.label || buddy.id} · ${fmtDistM(distM(ev.px, buddy.px, config.pixelM))}`);
    f.actions.hidden = !linkOk;
    f.lostActions.hidden = linkOk;
    set('env', sim.env?.text || '');
    set('plan', sim.active?.label || '');

    // banner
    let banner = '';
    let level = '';
    if (!linkOk) { banner = `Rover link lost · suit-only mode · position from step counting (±${Math.round(ev.uncertaintyM)} m)`; level = 'danger'; }
    else if (storm) { banner = 'Storm warning · head home on the safe route'; level = 'danger'; }
    else if (sim.air?.level === 'danger') { banner = 'Air margin critical · turn around'; level = 'danger'; }
    else if (sim.air?.level === 'warn') { banner = 'Air margin getting short'; level = 'warn'; }
    f.banner.hidden = !banner;
    if (banner) { set('banner', banner); f.banner.dataset.level = level; }

    // next / way home card
    const homeMode = !linkOk || storm || sim.status === 'returning' || sim.active?.kind === 'abort' || sim.active?.kind === 'return' || wayHome;
    const arrow = f.nextCard.querySelector('.tbl-arrow');
    if (homeMode && sim.home) {
      f.nextCard.dataset.kind = 'home';
      set('nextLabel', 'Way home (saved route)');
      set('nextDist', fmtDistM(sim.home.straightM));
      set('nextSub', `about ${fmtMin(sim.home.timeHomeMin ?? sim.air?.timeHomeMin)} walking`);
      arrow.style.transform = `rotate(${sim.home.bearingDeg ?? 0}deg)`;
    } else if (sim.status === 'working' && sim.working) {
      f.nextCard.dataset.kind = 'work';
      const st = data.stopsById[sim.working.stopId];
      set('nextLabel', `Working at ${st?.name || sim.working.stopId}`);
      set('nextDist', `${Math.ceil(sim.working.leftMin)} min`);
      set('nextSub', 'left at this stop');
      arrow.style.transform = 'rotate(0deg)';
    } else if (sim.status === 'done' || sim.status === 'aborted') {
      f.nextCard.dataset.kind = 'done';
      set('nextLabel', sim.status === 'done' ? 'Walk complete' : 'Walk aborted');
      set('nextDist', 'Home');
      set('nextSub', `back at T+${fmtMin(sim.t)}`);
    } else if (sim.nextStop) {
      f.nextCard.dataset.kind = 'next';
      const n = sim.nextStop;
      set('nextLabel', `Next · ${n.id === 'H' ? 'Habitat' : `Stop ${n.id}`}`);
      set('nextDist', fmtDistM(n.distanceM));
      const inMin = n.etaT != null ? Math.max(0, n.etaT - sim.t) : null;
      const behind = sim.schedule?.behindMin ?? 0;
      set('nextSub', `${n.name}${inMin != null ? ` · about ${Math.round(inMin)} min` : ''}${behind >= 1 ? ` · ${Math.round(behind)} min behind` : ''}`);
      arrow.style.transform = `rotate(${n.bearingDeg ?? 0}deg)`;
    }
    const idleHint = ' · press Play to start';
    if (sim.status === 'idle' && !f.nextSub.textContent.endsWith(idleHint)) set('nextSub', `${f.nextSub.textContent}${idleHint}`);

    // air
    const air = sim.air || {};
    set('airLeft', fmtMin(air.leftMin));
    const budgetMin = air.budgetMin || b.budgetMin;
    const leftF = Math.max(0, Math.min(1, (air.leftMin ?? budgetMin) / budgetMin));
    const res = Math.max(0, Math.min(1, (air.reserveMin ?? b.reserveMin) / budgetMin));
    f.barLeft.style.width = `${(leftF * 100).toFixed(1)}%`;
    f.barLeft.dataset.level = air.level || 'ok';
    f.barReserve.style.width = `${(res * 100).toFixed(1)}%`;
    set('timeHome', fmtMin(air.timeHomeMin));
    set('margin', `Margin ${fmtMin(air.marginMin)}`);
    f.margin.dataset.level = air.level || 'ok';
    f.demo.hidden = !air.budgetDemo;
    if (air.budgetDemo) set('demo', `DEMO BUDGET ${Math.round(air.budgetMin)} MIN · ${DEMO_BUDGET_NOTE}`);

    // status card
    set('statusText', sim.statusText || sim.status);
    set('rover', sim.rover ? (sim.rover.linkOk ? `Rover ${fmtDistM(sim.rover.aheadM)} ahead, scouting` : 'Rover: last known position') : '');
    let extra = '';
    if (sim.hazard) extra = 'Rock field confirmed ahead by the rover camera';
    else if (sim.paceFactor < 1) extra = `Walking at ${Math.round(sim.paceFactor * 100)}% of planned pace`;
    set('extra', extra);

    // map
    const span = Math.max(160, Math.min(1400, (f.map.clientWidth || 600) / PX_PER_GRID)) * zoomF;
    mm.view(ev.px, span);
    mmTrail(sim.trail);
    mmRoute(sim.active?.path);
    mmProposed(sim.pendingReplan?.path || null);
    mmHome(homeMode ? (sim.home?.path || null) : null);
    f.mapNote.hidden = !homeMode;
    mmHazard(sim.hazard?.px || null, sim.hazard?.radiusPx || 0);
    ring1(ev.px, ev.uncertaintyM / config.pixelM);
    ev1(ev.px, 4.2);
    ev2(buddy.px, 3.6);
    rover(sim.rover?.px || null);
    root.dataset.roverLink = sim.rover?.linkOk ? 'ok' : 'lost';
    stopSetters.forEach(([st]) => {
      const g = f.map.querySelector(`.mm-stop-${st.kind || 'science'}`);
      if (g) g.classList.toggle('is-dropped', (sim.dropped || []).includes(st.id));
    });

    // buttons
    const pauseBtn = root.querySelector('[data-act="pause"]');
    const pauseLbl = pauseBtn.querySelector('[data-l]');
    const pauseTxt = s.playing ? 'Pause walk' : (sim.status === 'idle' ? 'Start walk' : 'Resume walk');
    if (pauseLbl.textContent !== pauseTxt) {   // only on change (Safari drops clicks on replaced text nodes)
      pauseLbl.textContent = pauseTxt;
      pauseBtn.querySelector('svg').innerHTML = s.playing ? '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>' : '<path d="M7 5v14l11-7Z"/>';
      pauseBtn.classList.toggle('is-primary', !s.playing);
    }
    if (pauseBtn.disabled !== !!sim.pendingReplan) pauseBtn.disabled = !!sim.pendingReplan;

    renderRoute(s, sim);

    renderReplan(sim.pendingReplan);
  }

  render(ctx.getState(), true);
  ctx.subscribe((s, prev, changed) => {
    if (changed.has('mode') && s.mode === 'tablet') { render(s, true); return; }
    if (s.mode === 'tablet' && (changed.has('sim') || changed.has('playing') || changed.has('demoBudgetMin') || changed.has('tabletCrew'))) render(s);
  });
  return { render };
}
