// tablet.js — the astronaut's tablet (mode 'tablet', container #tablet).
// Same look as the planner: a full-bleed live map with floating panels. Read-only view of state.sim, built for
// gloves: next stop, air left + time home, route progress, what the rover sees, four big buttons, and a
// full-screen card when the rover proposes a detour (Accept emits replan:confirm). Link-lost and storm modes
// switch the guidance to the saved way home. See docs/ui-redesign.md.

import { fmtMin, fmtDistM, distM, esc, effectiveBudget, DEMO_BUDGET_NOTE } from './util.js';
import { createMiniMap } from './minimap.js';
import { createSmoother } from './smooth.js';

const PX_PER_GRID = 2.3;          // screen px per grid px (2 m) at zoom 1: the map shows more ground on wider screens
const TRIGGER_TITLE = {
  schedule: 'Behind schedule: new plan suggested',
  air: 'Air is running short: head home',
  storm: 'Storm: head home now',
  hazard: 'Rover found a rock field ahead',
  marked: 'Your route crosses a hazard you marked',
};
const ICON = {
  hazard: '<path d="M12 3 22 20H2Z"/><path d="M12 10v4M12 17v.5"/>',
  photo: '<rect x="3" y="7" width="18" height="13" rx="1.5"/><circle cx="12" cy="13.5" r="3.5"/><path d="M8.5 7 10 4.5h4L15.5 7"/>',
  play: '<path class="fill" d="M7 5v14l11-7Z"/>',
  pause: '<rect class="fill" x="6" y="5" width="4" height="14"/><rect class="fill" x="14" y="5" width="4" height="14"/>',
  home: '<path d="M3 11 12 4l9 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/>',
  wait: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  pin: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>',
};
const btn = (act, icon, label, cls = '') =>
  `<button type="button" class="tbl-btn ${cls}" data-act="${act}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON[icon]}</svg><span data-l>${label}</span></button>`;

export function initTablet(ctx) {
  const { data, config } = ctx;
  const root = ctx.els.tablet;
  if (!root) return null;
  root.classList.add('tb-root');
  root.innerHTML = `
    <section class="tbl-map" aria-label="Live map" data-f="map"></section>

    <aside class="tbl-col" aria-label="Guidance">
      <div class="tbl-card tbl-next" data-f="nextCard">
        <span class="tbl-k" data-f="nextLabel">Next stop</span>
        <div class="tbl-next-row">
          <svg class="tbl-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 20 20 12 15.5 4 20Z"></path></svg>
          <div class="tbl-next-txt">
            <span class="tbl-big" data-f="nextDist">—</span>
            <span class="tbl-sub" data-f="nextSub"></span>
          </div>
        </div>
        <span class="tbl-eta" data-f="nextEta"></span>
      </div>

      <div class="tbl-card tbl-air">
        <div class="tbl-pair">
          <div><span class="tbl-k">Air left</span><b class="tbl-num" data-f="airLeft">—</b></div>
          <div><span class="tbl-k">Time home</span><b class="tbl-num" data-f="timeHome">—</b></div>
        </div>
        <div class="tbl-bar" aria-hidden="true"><i data-f="barLeft"></i><i data-f="barReserve"></i></div>
        <div class="tbl-row"><span class="tbl-dim tbl-small" data-f="budget"></span><span data-f="margin"></span></div>
      </div>

      <div class="tbl-card tbl-route">
        <div class="tbl-row"><span class="tbl-k">Route</span><span class="tbl-k" data-f="routeEta"></span></div>
        <ol class="tbl-steps" data-f="steps"></ol>
        <div class="tbl-prog" aria-hidden="true"><i data-f="prog"></i></div>
      </div>

      <div class="tbl-card tbl-rover" data-f="roverCard">
        <div class="tbl-row"><span class="tbl-k">Rover · scouting ahead</span><span class="tbl-k" data-f="roverDist"></span></div>
        <span class="tbl-cam" data-f="cam"></span>
        <span class="tbl-dim tbl-small" data-f="statusText"></span>
      </div>
    </aside>

    <div class="tbl-chips">
      <span class="tbl-chip"><i class="tbl-dot"></i><b data-f="who">EV1</b> · <span data-f="link">Rover link</span></span>
      <span class="tbl-chip" data-f="buddy"></span>
      <span class="tbl-chip" data-f="env"></span>
    </div>
    <div class="tbl-banner" data-f="banner" hidden></div>
    <div class="tbl-legend"><span><i class="lg lg-ev1"></i>You</span><span><i class="lg lg-ev2"></i>Buddy</span><span><i class="lg lg-rover"></i>Rover</span></div>
    <div class="tbl-map-note" data-f="mapNote" hidden>Way home</div>
    <div class="tbl-zoom"><button type="button" data-zoom="-1" aria-label="Zoom in">+</button><button type="button" data-zoom="1" aria-label="Zoom out">−</button></div>

    <div class="tbl-actions" data-f="actions">
      ${btn('hazard', 'hazard', 'Mark hazard')}
      ${btn('photo', 'photo', 'Take photo')}
      ${btn('pause', 'play', 'Start walk', 'tbl-btn-play')}
      ${btn('home', 'home', 'Way home', 'tbl-btn-home')}
    </div>
    <div class="tbl-actions tbl-actions-lost" data-f="lostActions" hidden>
      ${btn('walkhome', 'home', 'Start walking home', 'is-primary')}
      ${btn('wait', 'wait', 'Wait for link')}
      ${btn('landmark', 'pin', 'I see a landmark')}
    </div>
    <div class="tbl-takeover" data-f="replan" hidden></div>`;

  const f = Object.fromEntries([...root.querySelectorAll('[data-f]')].map((n) => [n.dataset.f, n]));
  const set = (k, v) => { const s = String(v ?? ''); if (f[k].textContent !== s) f[k].textContent = s; };
  root.querySelector('[data-act="home"]').setAttribute('aria-pressed', 'false');

  // ---- live map
  const mm = createMiniMap(f.map, { url: data.url('basemap.png'), widthPx: config.widthPx, heightPx: config.heightPx,
    pixelM: config.pixelM, label: 'Live map around the crew' });
  const mmTrail = mm.line('mm-trail');
  const mmAbandoned = [0, 1, 2, 3].map(() => mm.line('mm-abandoned'));   // old route pieces given up (red)
  const mmRoute = mm.line('mm-route');
  const mmPendingAbandoned = mm.line('mm-abandoned is-pending');
  const mmHome = mm.line('mm-home');
  const mmProposed = mm.line('mm-proposed');
  const mmHazard = mm.circle('mm-hazard');
  const mmMarkZones = [0, 1, 2, 3, 4, 5].map(() => mm.circle('mm-mark-zone'));
  const mmMarkPins = [0, 1, 2, 3, 4, 5].map(() => mm.circle('mm-mark'));
  const stopSetters = data.stops.map((st) => [st, mm.diamond(`mm-stop mm-stop-${st.kind || 'science'}`, st.id, 16)]);
  const ring1 = mm.circle('mm-ring');
  const rover = mm.square('mm-rover', 9);
  const ev2 = mm.circle('mm-ev2');
  const ev1 = mm.circle('mm-ev1');
  stopSetters.forEach(([st, s]) => s(st.px));

  let wayHome = false;
  let zoomF = 1;
  const smooth = createSmoother();   // display-only: crew, rover and the map camera glide instead of jumping
  root.querySelector('.tbl-zoom').addEventListener('click', (e) => {
    const z = e.target.closest('[data-zoom]');
    if (!z) return;
    zoomF = Math.max(0.35, Math.min(3, zoomF * (Number(z.dataset.zoom) > 0 ? 1.5 : 1 / 1.5)));
    render(ctx.getState(), true);
  });

  // ---- buttons
  root.addEventListener('click', (e) => {
    if (!e.target.closest('.tbl-actions')) return;
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const s = ctx.getState();
    const sim = s.sim;
    const at = sim ? `T+${fmtMin(sim.t)}` : '';
    const me = sim?.crew?.[s.tabletCrew ?? 0] || sim?.crew?.[0];
    const act = b.dataset.act;
    if (act === 'pause' || act === 'walkhome') {
      if (!sim?.pendingReplan) ctx.setState({ playing: act === 'walkhome' ? true : !s.playing });
    } else if (act === 'wait') {
      ctx.setState({ playing: false });
      ctx.toast({ level: 'info', title: 'Holding position', text: 'Waiting for the rover link; air and time home keep counting.' });
    } else if (act === 'landmark') {
      ctx.toast({ level: 'ok', title: 'Landmark confirmed', text: `Position fix requested at ${at} (demo).` });
    } else if (act === 'hazard') {
      ctx.emit('hazard:mark');
      ctx.toast({ level: 'warn', title: 'Hazard marked', text: `Pinned at your position ${at}; shared with the rover and your buddy. Routes will now keep 40 m clear of it.` });
    } else if (act === 'photo') {
      ctx.toast({ level: 'ok', title: 'Photo saved', text: `Tagged with position and time ${at} (demo).` });
    } else if (act === 'home') {
      wayHome = !wayHome;
      b.setAttribute('aria-pressed', String(wayHome));
      render(ctx.getState(), true);
    }
  });

  // ---- reroute takeover (rebuilt only when the proposal changes)
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
      <div class="tbl-modal" data-level="${sev}" role="dialog" aria-label="Reroute proposed">
        <span class="tbl-k">${esc(p.atStopId ? `At ${p.atStopName || p.atStopId}` : 'On the way')} · T+${esc(fmtMin(p.arrivedT))}${p.behindMin >= 1 ? ` · ${esc(Math.round(p.behindMin))} min behind` : ''}</span>
        <h2 class="tbl-modal-h">${esc(TRIGGER_TITLE[p.trigger] || 'New route suggested')}</h2>
        <div class="tbl-suggest">
          <span class="tbl-k">Suggested</span>
          <span class="tbl-suggest-label">${esc(p.label)}</span>
          ${p.savesMin > 0 ? `<span class="tbl-ok">Saves ${esc(Math.round(p.savesMin))} min</span>` : ''}
        </div>
        <button type="button" class="tbl-accept" data-confirm="${esc(p.id)}">Accept new route</button>
        <p class="tbl-safe"><b>Why it is safe:</b> ${esc(p.safety?.text || '')}</p>
        ${(p.why || []).length ? `<ul class="tbl-why">${p.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        ${rejected ? `<details class="tbl-rej"><summary>Options that did not fit</summary><ul>${rejected}</ul></details>` : ''}
        <span class="tbl-dim tbl-small">Both crew see this. The walk is paused until someone accepts.</span>
      </div>`;
  }

  // ---- route progress
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
    set('routeEta', `Back T+${fmtMin(end)}`);
  }

  // ---- main render
  function render(s, force = false) {
    if (s.mode !== 'tablet' && !force) return;
    const sim = s.sim;
    const b = effectiveBudget(s, config);
    if (!sim) return;
    const linkOk = sim.link?.ok !== false;
    const storm = !!sim.env?.stormActive;
    const ci = Math.min(sim.crew.length - 1, Math.max(0, s.tabletCrew ?? 0));
    const ev = sim.crew[ci];
    const buddy = sim.crew[1 - ci] || sim.crew[0];

    // chips
    root.dataset.link = linkOk ? 'ok' : 'lost';
    set('who', ev.label || ev.id);
    set('link', linkOk ? 'Rover link' : 'Rover link lost');
    set('buddy', `Buddy ${buddy.label || buddy.id} · ${fmtDistM(distM(ev.px, buddy.px, config.pixelM))}`);
    set('env', sim.env?.text || '');
    f.actions.hidden = !linkOk;
    f.lostActions.hidden = linkOk;

    // banner
    let banner = '', level = '';
    if (!linkOk) { banner = `Rover link lost · suit-only mode · position from step counting (±${Math.round(ev.uncertaintyM)} m)`; level = 'danger'; }
    else if (storm) { banner = 'Storm warning · head home on the safe route'; level = 'danger'; }
    else if (sim.active?.kind === 'hazard' && !sim.pendingReplan && sim.status !== 'done') { banner = `${sim.active.label} · old route in red`; level = 'warn'; }
    else if (sim.air?.level === 'danger') { banner = 'Air margin critical · turn around'; level = 'danger'; }
    else if (sim.air?.level === 'warn') { banner = 'Air margin getting short'; level = 'warn'; }
    f.banner.hidden = !banner;
    if (banner) { set('banner', banner); f.banner.dataset.level = level; }

    // next / way home card
    const homeMode = !linkOk || storm || sim.status === 'returning' || ['abort', 'return'].includes(sim.active?.kind) || wayHome;
    const arrow = f.nextCard.querySelector('.tbl-arrow');
    let kind = 'next', eta = '';
    if (homeMode && sim.home) {
      kind = 'home';
      set('nextLabel', 'Way home · saved route');
      set('nextDist', fmtDistM(sim.home.straightM));
      set('nextSub', `about ${fmtMin(sim.home.timeHomeMin ?? sim.air?.timeHomeMin)} walking`);
      arrow.style.transform = `rotate(${sim.home.bearingDeg ?? 0}deg)`;
    } else if (sim.status === 'working' && sim.working) {
      kind = 'work';
      const st = data.stopsById[sim.working.stopId];
      set('nextLabel', `Working at ${st?.name || sim.working.stopId}`);
      set('nextDist', `${Math.ceil(sim.working.leftMin)} min`);
      set('nextSub', sim.nextStop ? `then ${sim.nextStop.name}` : 'left at this stop');
    } else if (sim.status === 'done' || sim.status === 'aborted') {
      kind = 'done';
      set('nextLabel', sim.status === 'done' ? 'Walk complete' : 'Walk aborted');
      set('nextDist', 'Home');
      set('nextSub', `back at T+${fmtMin(sim.t)} · press Replay to run it again`);
    } else if (sim.nextStop) {
      const n = sim.nextStop;
      set('nextLabel', `Next · ${n.id === 'H' ? 'Habitat' : `Stop ${n.id}`}`);
      set('nextDist', fmtDistM(n.distanceM));
      set('nextSub', n.name);
      arrow.style.transform = `rotate(${n.bearingDeg ?? 0}deg)`;
      if (n.etaT != null) {
        const behind = sim.schedule?.behindMin ?? 0;
        eta = `Arrive T+${fmtMin(n.etaT)} · ${behind >= 1 ? `${Math.round(behind)} min behind plan` : 'on plan'}`;
      }
      if (sim.status === 'idle') eta = 'Ready · press Play to start the walk';
    }
    f.nextCard.dataset.kind = kind;
    set('nextEta', eta);

    // air
    const air = sim.air || {};
    const budgetMin = air.budgetMin || b.budgetMin;
    set('airLeft', fmtMin(air.leftMin));
    set('timeHome', fmtMin(air.timeHomeMin));
    const leftF = Math.max(0, Math.min(1, (air.leftMin ?? budgetMin) / budgetMin));
    const res = Math.max(0, Math.min(1, (air.reserveMin ?? b.reserveMin) / budgetMin));
    f.barLeft.style.width = `${(leftF * 100).toFixed(1)}%`;
    f.barLeft.dataset.level = air.level || 'ok';
    f.barReserve.style.width = `${(res * 100).toFixed(1)}%`;
    set('margin', `Margin ${fmtMin(air.marginMin)}`);
    f.margin.dataset.level = air.level || 'ok';
    set('budget', air.budgetDemo ? `DEMO BUDGET ${Math.round(budgetMin)} MIN (${DEMO_BUDGET_NOTE})` : `Suit ${fmtMin(budgetMin)} · reserve ${fmtMin(air.reserveMin ?? b.reserveMin)}`);

    // rover card
    const rv = sim.rover;
    set('roverDist', rv ? (rv.linkOk ? `${fmtDistM(rv.aheadM)} ahead` : 'link down') : '');
    let cam = 'Camera: no hazards ahead', camLevel = 'ok';
    if (!rv?.linkOk) { cam = 'Camera: no data while the link is down'; camLevel = 'warn'; }
    else if (sim.hazard) { cam = `Camera: rock field confirmed ${fmtDistM(distM(rv.px, sim.hazard.px, config.pixelM))} away · detour ${sim.pendingReplan ? 'proposed' : 'in use'}`; camLevel = 'danger'; }
    else if (sim.hazardArmed) { cam = 'Camera: scanning the route ahead'; camLevel = 'ok'; }
    set('cam', cam);
    f.cam.dataset.level = camLevel;
    set('statusText', `Now: ${sim.statusText || sim.status}`);

    // map: keep the crew centered in the open area to the right of the panels
    const mapW = f.map.clientWidth || 1000;
    const pr = sim.pendingReplan;
    const colW = (pr ? f.replan.firstElementChild || root.querySelector('.tbl-col') : root.querySelector('.tbl-col')).getBoundingClientRect().width + 20;
    let span = Math.max(160, Math.min(1400, mapW / PX_PER_GRID)) * zoomF;
    let focus = null;
    if (pr?.hazard) {
      // a hazard detour: zoom out to show the hazard, the old route (red) and the new one
      const pts = [ev.px, ...(pr.abandoned || []), [pr.hazard.px[0] - pr.hazard.radiusPx, pr.hazard.px[1] - pr.hazard.radiusPx], [pr.hazard.px[0] + pr.hazard.radiusPx, pr.hazard.px[1] + pr.hazard.radiusPx]];
      const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
      const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
      const openW = Math.max(200, mapW - colW), mapH = f.map.clientHeight || 600;
      span = Math.max(160, (bw * 1.5) * (mapW / openW), (bh * 1.6) * (mapW / mapH));
      focus = [(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2];
    }
    const scale = mapW / span;                              // screen px per grid px (viewBox fits the width)
    const shift = (colW / 2) / scale;
    const snap = !s.playing;
    const evP = smooth('ev', ev.px, { snap });
    const buddyP = smooth('buddy', buddy.px, { snap });
    const roverP = rv?.px ? smooth('rover', rv.px, { snap }) : null;
    const camC = focus || evP;
    mm.view([camC[0] - shift, camC[1]], span);
    mmTrail(sim.trail);
    const ab = sim.abandoned || [];
    const recent = ab.slice(-mmAbandoned.length);
    mmAbandoned.forEach((ln, i) => ln(recent[i]?.path || null));
    mmRoute(sim.active?.path);
    mmPendingAbandoned(pr?.abandoned?.length > 1 ? pr.abandoned : null);
    mmProposed(pr?.path || null);
    const marks = sim.marks || [];
    mmMarkZones.forEach((c, i) => c(marks[i]?.px || null, marks[i]?.radiusPx || 0));
    mmMarkPins.forEach((c, i) => c(marks[i]?.px || null, 5));
    mmHome(homeMode ? (sim.home?.path || null) : null);
    f.mapNote.hidden = !homeMode;
    mmHazard(sim.hazard?.px || null, sim.hazard?.radiusPx || 0);
    ring1(evP, ev.uncertaintyM / config.pixelM);
    ev1(evP, 4.2);
    ev2(buddyP, 3.6);
    rover(roverP);
    root.dataset.roverLink = rv?.linkOk ? 'ok' : 'lost';
    stopSetters.forEach(([st]) => {
      const g = f.map.querySelector(`.mm-stop-${st.kind || 'science'}`);
      if (g) g.classList.toggle('is-dropped', (sim.dropped || []).includes(st.id));
    });

    // play / pause button (only touched when it changes: Safari drops clicks on replaced text nodes)
    const pauseBtn = root.querySelector('[data-act="pause"]');
    const lbl = pauseBtn.querySelector('[data-l]');
    const done = sim.status === 'done' || sim.status === 'aborted';
    const txt = s.playing ? 'Pause walk' : done ? 'Replay walk' : sim.status === 'idle' ? 'Start walk' : 'Resume walk';
    if (lbl.textContent !== txt) {
      lbl.textContent = txt;
      pauseBtn.querySelector('svg').innerHTML = s.playing ? ICON.pause : ICON.play;
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
  window.addEventListener('resize', () => render(ctx.getState()));
  return { render };
}
