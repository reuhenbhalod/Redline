// tablet.js — the astronaut's tablet (mode 'tablet', container #tablet).
// Read-only view of state.sim, built for gloves: three numbers (distance, air, time home), a live map, four big
// buttons, and full-screen takeovers for a reroute proposal, a lost rover link and a storm.
// It only reads state and emits the existing events (replan:confirm, toast). See docs/ui-redesign.md.

import { fmtMin, fmtDistM, distM, esc, effectiveBudget, DEMO_BUDGET_NOTE } from './util.js';
import { createMiniMap } from './minimap.js';

const MAP_SPAN_PX = 330;          // ~660 m across at 2 m/px
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
      <span class="tbl-who">EV1</span>
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
          <div class="tbl-bar" aria-hidden="true"><i data-f="barUsed"></i><i data-f="barReserve"></i></div>
          <div class="tbl-row tbl-row-sm">
            <span>Time home <b data-f="timeHome">—</b></span>
            <span data-f="margin"></span>
          </div>
          <span class="tbl-demo" data-f="demo" hidden></span>
        </div>
        <div class="tbl-card tbl-status">
          <span class="tbl-k">Now</span>
          <span data-f="statusText" class="tbl-status-main"></span>
          <span data-f="rover" class="tbl-dim"></span>
          <span data-f="extra" class="tbl-warnline"></span>
        </div>
      </section>
      <section class="tbl-map" aria-label="Live map" data-f="map">
        <div class="tbl-legend"><span><i class="lg lg-ev1"></i>You (EV1)</span><span><i class="lg lg-ev2"></i>Buddy (EV2)</span><span><i class="lg lg-rover"></i>Rover</span></div>
        <div class="tbl-map-note" data-f="mapNote" hidden>Way home</div>
      </section>
    </div>
    <div class="tbl-actions">
      <button type="button" class="tbl-btn" data-act="hazard">Mark hazard</button>
      <button type="button" class="tbl-btn" data-act="photo">Take photo</button>
      <button type="button" class="tbl-btn" data-act="pause">Pause walk</button>
      <button type="button" class="tbl-btn tbl-btn-home" data-act="home" aria-pressed="false">Way home</button>
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
  root.querySelector('.tbl-actions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const s = ctx.getState();
    const sim = s.sim;
    const at = sim ? `T+${fmtMin(sim.t)}` : '';
    if (b.dataset.act === 'hazard') {
      if (sim) mmMarks.push(sim.crew[0].px);
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
    const ev = sim.crew[0];

    // strip
    root.dataset.link = linkOk ? 'ok' : 'lost';
    set('link', linkOk ? 'Rover link' : 'Rover link lost');
    set('buddy', `Buddy EV2 · ${fmtDistM(distM(sim.crew[0].px, sim.crew[1].px, config.pixelM))}`);
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
    const used = Math.max(0, Math.min(1, (air.usedMin ?? 0) / (air.budgetMin || b.budgetMin)));
    const res = Math.max(0, Math.min(1, (air.reserveMin ?? b.reserveMin) / (air.budgetMin || b.budgetMin)));
    f.barUsed.style.width = `${(used * 100).toFixed(1)}%`;
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
    mm.view(ev.px, MAP_SPAN_PX);
    mmTrail(sim.trail);
    mmRoute(sim.active?.path);
    mmProposed(sim.pendingReplan?.path || null);
    mmHome(homeMode ? (sim.home?.path || null) : null);
    f.mapNote.hidden = !homeMode;
    mmHazard(sim.hazard?.px || null, sim.hazard?.radiusPx || 0);
    ring1(ev.px, ev.uncertaintyM / config.pixelM);
    ev1(ev.px, 4.2);
    ev2(sim.crew[1].px, 3.6);
    rover(sim.rover?.px || null);
    root.dataset.roverLink = sim.rover?.linkOk ? 'ok' : 'lost';
    stopSetters.forEach(([st]) => {
      const g = f.map.querySelector(`.mm-stop-${st.kind || 'science'}`);
      if (g) g.classList.toggle('is-dropped', (sim.dropped || []).includes(st.id));
    });

    // buttons
    const pauseBtn = root.querySelector('[data-act="pause"]');
    const pauseTxt = s.playing ? 'Pause walk' : (sim.status === 'idle' ? 'Start walk' : 'Resume walk');
    if (pauseBtn.textContent !== pauseTxt) pauseBtn.textContent = pauseTxt;
    pauseBtn.disabled = !!sim.pendingReplan;

    renderReplan(sim.pendingReplan);
  }

  render(ctx.getState(), true);
  ctx.subscribe((s, prev, changed) => {
    if (changed.has('mode') && s.mode === 'tablet') { render(s, true); return; }
    if (s.mode === 'tablet' && (changed.has('sim') || changed.has('playing') || changed.has('demoBudgetMin'))) render(s);
  });
  return { render };
}
