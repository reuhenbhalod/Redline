// hud.js — Helmet HUD (mode 'hud', container #hud). Rebuilt to the "Mockup · Helmet HUD" artboard
// (docs/ui-redesign.md): an eyes-up visor over the camera view with a heading tape, one arrow to the next
// stop (relative to the direction of travel), distance + stop + ETA, and two rings: air left and time home.
// Alerts show as one chip; a pending reroute shows a confirm card (button or Enter emits replan:confirm).
// Read-only otherwise. Works with state.sim === null (shows the planned view).

import { fmtMin, fmtDistM, distM, cardinal, effectiveBudget, DEMO_BUDGET_NOTE } from './util.js';

const ENV_HOUR_LTST = 13; // HUD temperature: MEDA hourly mean at this local true solar hour (a fixed pick)

/** Glanceable env chips from the sim env (or data.env when idle). Pure: exported for tests/debug. */
export function hudEnvChips(simEnv, dataEnv, hourLtst = ENV_HOUR_LTST) {
  const de = dataEnv || {};
  const se = simEnv || {};
  const chips = [];
  const w = de.weather;
  const hr = w?.hourly?.find((h) => h.hour === hourLtst);
  const r1 = (v) => Math.round(v);
  if (hr && Number.isFinite(hr.airTempC)) {
    chips.push({ id: 'temp', level: 'ok', text: `${r1(hr.airTempC)}°C ${hourLtst}h`,
      title: `Air temperature ${hr.airTempC} °C: MEDA hourly mean at ${hourLtst}:00 LTST (fixed pick)` +
        `${w.airTempC ? `; range ${r1(w.airTempC.min)} to ${r1(w.airTempC.max)} °C` : ''}${w.timeFrame ? ` · ${w.timeFrame}` : ''}${w.source ? ` · ${w.source}` : ''}` });
  } else if (w?.airTempC && Number.isFinite(w.airTempC.min)) {
    chips.push({ id: 'temp', level: 'ok', text: `${r1(w.airTempC.min)}…${r1(w.airTempC.max)}°C`,
      title: `Air temperature range (MEDA)${w.timeFrame ? ` · ${w.timeFrame}` : ''}` });
  }
  const dust = String(se.dust ?? de.dust ?? 'unknown');
  const tau = Number.isFinite(se.dustTau) ? se.dustTau : de.dustTau?.estimate;
  const dt = de.dustTau;
  chips.push({ id: 'dust', level: dust === 'high' ? 'danger' : dust === 'moderate' ? 'warn' : dust === 'unknown' ? 'info' : 'ok',
    text: `DUST ${dust.toUpperCase()}${Number.isFinite(tau) ? ` τ${tau.toFixed(2)}` : ''}`,
    title: dt ? `Dust optical depth τ ${dt.estimate}${dt.range ? ` (range ${dt.range[0]}–${dt.range[1]})` : ''}${dt.isEstimate ? ', estimate' : ''}${dt.source ? ` · ${dt.source}` : ''}` : 'Dust level' });
  const storm = !!se.stormActive;
  const solar = storm || !!(se.solarAlert ?? de.solar_alert);
  const sw = de.spaceWeather;
  chips.push({ id: 'solar', level: solar ? 'danger' : 'ok',
    text: storm ? 'STORM' : solar ? 'SOLAR ALERT' : 'NO SOLAR ALERT',
    title: `Solar alert from ${sw?.source || 'space weather feed'}${sw?.cmeArrivals30d ? ` · ${sw.cmeArrivals30d.length} Mars CME arrivals in the last 30 days` : ''}${storm ? ' · STORM demo on' : ''}` });
  return chips;
}

const RING_C = 2 * Math.PI * 40;   // ring radius 40 in a 96 viewBox
const norm = (d) => ((d % 360) + 360) % 360;

/** @param {object} ctx  see INTERFACES.md "ctx" */
export function initHud(ctx) {
  const { data, config } = ctx;
  const root = ctx.els.hud;
  root.classList.add('hud-root');
  root.innerHTML = `
    <img class="hv-view" alt="" data-f="view">
    <div class="hv-vignette" aria-hidden="true"></div>
    <div class="hv-tl">
      <span data-f="who">EV1</span>
      <span><i class="hv-dot" data-f="linkDot"></i><span data-f="link">ROVER LINK</span></span>
      <span class="hv-dim" data-f="buddy"></span>
    </div>
    <div class="hv-tape" aria-label="Heading">
      <div class="hv-tape-nums" data-f="tape"></div>
      <svg class="hv-caret" viewBox="0 0 400 14" aria-hidden="true"><path d="M0 1H400" class="hv-tape-line"></path><path d="M200 2l-6 10h12z" class="hv-tape-caret"></path></svg>
    </div>
    <div class="hv-tr">
      <div class="hv-alert" data-f="alert" role="status" hidden><b data-f="alertTitle"></b><span data-f="alertText"></span></div>
      <div class="hv-env" data-f="env"></div>
    </div>
    <div class="hv-center">
      <svg class="hv-arrow" viewBox="0 0 120 120" role="img" data-f="arrowSvg" aria-label="Direction to the next stop">
        <g data-f="arrow"><path d="M60 14L96 86 60 68 24 86z"></path></g>
      </svg>
      <span class="hv-dist" data-f="dist">—</span>
      <span class="hv-next" data-f="next"></span>
    </div>
    <div class="hv-ring hv-ring-l">
      <svg viewBox="0 0 96 96" aria-hidden="true"><circle cx="48" cy="48" r="40" class="hv-track"></circle><circle cx="48" cy="48" r="40" class="hv-arc" data-f="airArc" transform="rotate(-90 48 48)"></circle></svg>
      <div><b data-f="air">—</b><span>AIR LEFT</span><span class="hv-demo" data-f="demo" hidden>DEMO BUDGET</span></div>
    </div>
    <div class="hv-ring hv-ring-r">
      <div><b data-f="home">—</b><span>TIME HOME</span></div>
      <svg viewBox="0 0 96 96" aria-hidden="true"><circle cx="48" cy="48" r="40" class="hv-track"></circle><circle cx="48" cy="48" r="40" class="hv-arc" data-f="homeArc" transform="rotate(-90 48 48)"></circle></svg>
    </div>
    <span class="hv-foot" data-f="foot"></span>
    <div class="hv-card" data-f="card" hidden role="dialog" aria-label="Reroute proposed">
      <span class="hv-card-k" data-f="cardK"></span>
      <b class="hv-card-h" data-f="cardH"></b>
      <span class="hv-card-t" data-f="cardT"></span>
      <button type="button" class="hv-card-btn" data-f="cardBtn">CONFIRM REROUTE ⏎</button>
    </div>`;
  const f = Object.fromEntries([...root.querySelectorAll('[data-f]')].map((n) => [n.dataset.f, n]));
  const set = (k, v) => { const s = String(v ?? ''); if (f[k].textContent !== s) f[k].textContent = s; };
  const attr = (n, k, v) => { const s = String(v); if (n.getAttribute(k) !== s) n.setAttribute(k, s); };

  // ---- reroute confirm (button + Enter, same behaviour as before)
  const confirmPending = () => {
    const p = ctx.getState().sim?.pendingReplan;
    if (p) ctx.emit('replan:confirm', { id: p.id });
  };
  f.cardBtn.addEventListener('click', confirmPending);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey) return;
    const st = ctx.getState();
    if (st.mode !== 'hud' || !st.sim?.pendingReplan) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || e.target.isContentEditable) return;
    if (tag === 'button' && e.target !== f.cardBtn && !e.target.closest('#topbar')) return;
    e.preventDefault();
    confirmPending();
  });

  // ---- visor view: a Perseverance photo from near the stop closest to the crew (placeholder for the helmet camera)
  let viewKey = '';
  f.view.addEventListener('error', () => f.view.removeAttribute('src'));
  function pickView(px) {
    let best = null;
    for (const st of data.stops) {
      const d = distM(px, st.px, config.pixelM);
      if (!best || d < best.d) best = { st, d };
    }
    const ph = data.photosByStop?.[best?.st.id];
    const c = (ph?.candidates || []).find((x) => x.url) || (ph?.featured || [])[0];
    return c ? { url: c.url, stop: best.st.name, credit: c.credit || 'NASA/JPL-Caltech', sol: c.sol } : null;
  }

  function tapeNumbers(heading) {
    const out = [];
    for (let k = -30; k <= 30; k += 15) {
      const d = norm(Math.round((heading + k) / 15) * 15);
      const c = cardinal(d);
      out.push(d % 90 === 0 ? c : String(d).padStart(3, '0'));
    }
    return out;
  }

  function render(s, force = false) {
    if (s.mode !== 'hud' && !force) return;
    const sim = s.sim;
    const b = effectiveBudget(s, config);
    const crew = sim?.crew?.[0];
    const px = crew?.px || data.stopsById.H?.px;

    // view
    const v = px ? pickView(px) : null;
    if ((v?.url || '') !== viewKey) {
      viewKey = v?.url || '';
      if (v) { f.view.src = v.url; f.view.alt = `Visor view placeholder: Perseverance photo near ${v.stop}`; }
      else f.view.removeAttribute('src');
    }

    // top left
    const linkOk = sim ? sim.link?.ok !== false : true;
    root.dataset.link = linkOk ? 'ok' : 'lost';
    set('link', linkOk ? 'ROVER LINK' : 'ROVER LINK LOST · SUIT-ONLY');
    set('buddy', sim ? `EV2 · ${fmtDistM(distM(sim.crew[0].px, sim.crew[1].px, config.pixelM)).toUpperCase()}` : 'EV2');

    // heading tape
    const heading = Number.isFinite(sim?.headingDeg) ? sim.headingDeg : 0;
    const nums = tapeNumbers(heading);
    if (f.tape.dataset.k !== nums.join()) {
      f.tape.dataset.k = nums.join();
      f.tape.innerHTML = nums.map((n, i) => `<span class="${i === 2 ? 'hv-tape-mid' : ''}">${n}</span>`).join('');
    }

    // alert chip: pending reroute > newest active alert > hazard; otherwise env chips
    const active = (sim?.alerts || []).filter((a) => a.active && (a.level === 'danger' || a.level === 'warn'));
    const al = sim?.pendingReplan
      ? { level: 'warn', title: 'REROUTE PROPOSED', text: 'CONFIRM BELOW OR ON THE TABLET' }
      : active.length ? { level: active[active.length - 1].level, title: active[active.length - 1].title.toUpperCase(), text: '' }
      : sim?.hazard ? { level: 'warn', title: 'ROCK FIELD AHEAD', text: 'ROVER CONFIRMED · ROUTE GOES AROUND' } : null;
    f.alert.hidden = !al;
    if (al) { f.alert.dataset.level = al.level; set('alertTitle', al.title); set('alertText', al.text); }
    const chips = hudEnvChips(sim?.env, data.env);
    const envKey = chips.map((c) => c.text + c.level).join('|');
    if (f.env.dataset.k !== envKey) {
      f.env.dataset.k = envKey;
      f.env.innerHTML = chips.map((c) => `<span data-level="${c.level}" title="${c.title.replace(/"/g, '&quot;')}">${c.text}</span>`).join('');
    }

    // center: next stop / way home / working
    const homeMode = sim && (!linkOk || sim.env?.stormActive || sim.status === 'returning' || ['abort', 'return'].includes(sim.active?.kind));
    root.dataset.home = homeMode ? '1' : '0';
    let rel = 0;
    if (homeMode && sim.home) {
      rel = norm((sim.home.bearingDeg ?? 0) - heading);
      set('dist', fmtDistM(sim.home.straightM).toUpperCase());
      set('next', `HOME · ${fmtMin(sim.home.timeHomeMin ?? sim.air?.timeHomeMin)} WALK`);
    } else if (sim?.status === 'working' && sim.working) {
      const st = data.stopsById[sim.working.stopId];
      set('dist', `${Math.ceil(sim.working.leftMin)} MIN`);
      set('next', `WORKING AT ${(st?.name || sim.working.stopId).toUpperCase()}`);
    } else if (sim && (sim.status === 'done' || sim.status === 'aborted')) {
      set('dist', 'HOME');
      set('next', `BACK AT T+${fmtMin(sim.t)}`);
    } else if (sim?.nextStop) {
      const n = sim.nextStop;
      rel = norm((n.bearingDeg ?? 0) - heading);
      set('dist', fmtDistM(n.distanceM).toUpperCase());
      const eta = n.etaT != null ? Math.max(0, n.etaT - sim.t) : null;
      set('next', `${n.id === 'H' ? 'HABITAT' : `STOP ${n.id}`} · ${String(n.name || '').toUpperCase()}${eta != null ? ` · ${fmtMin(eta)}` : ''}`);
    } else {
      const v0 = data.variantsById[s.plannedVariantId] || data.routes.variants[0];
      set('dist', fmtDistM(v0.distance_m).toUpperCase());
      set('next', `PLAN ${v0.stops.join('→')} · ${fmtMin(v0.est_min)}`);
    }
    const working = sim?.status === 'working';
    f.arrowSvg.style.visibility = working || sim?.status === 'done' || sim?.status === 'aborted' ? 'hidden' : 'visible';
    attr(f.arrow, 'transform', `rotate(${(rel > 180 ? rel - 360 : rel).toFixed(1)} 60 60)`);

    // rings
    const air = sim?.air;
    const left = air?.leftMin ?? b.budgetMin;
    set('air', fmtMin(left));
    attr(f.airArc, 'stroke-dasharray', `${(Math.max(0, Math.min(1, left / b.budgetMin)) * RING_C).toFixed(1)} ${RING_C.toFixed(1)}`);
    const th = air?.timeHomeMin ?? 0;
    set('home', fmtMin(th));
    const usable = Math.max(1, left - (air?.reserveMin ?? b.reserveMin));
    attr(f.homeArc, 'stroke-dasharray', `${(Math.max(0.02, Math.min(1, th / usable)) * RING_C).toFixed(1)} ${RING_C.toFixed(1)}`);
    root.dataset.level = air?.level || 'ok';
    f.demo.hidden = !b.demo;
    if (b.demo) { set('demo', `DEMO BUDGET ${Math.round(b.budgetMin)}`); f.demo.title = `${DEMO_BUDGET_NOTE} (real ${b.realBudgetMin} min)`; }
    set('foot', `${b.demo ? `BUDGET ${Math.round(b.budgetMin)} MIN: ${DEMO_BUDGET_NOTE.toUpperCase()} (REAL ${b.realBudgetMin})` : `BUDGET ${Math.round(b.budgetMin)} / RESERVE ${Math.round(b.reserveMin)} MIN`}${v ? ` · VISOR VIEW PLACEHOLDER: PERSEVERANCE${v.sol != null ? ` SOL ${v.sol}` : ''} · ${v.credit.toUpperCase()}` : ''}`);

    // reroute card
    const p = sim?.pendingReplan;
    f.card.hidden = !p;
    root.dataset.card = p ? '1' : '0';
    if (p) {
      set('cardK', `${p.atStopId ? `AT ${(p.atStopName || p.atStopId).toUpperCase()}` : 'ON THE WAY'} · T+${fmtMin(p.arrivedT)}`);
      set('cardH', p.label);
      set('cardT', p.safety?.text || '');
    }
  }

  render(ctx.getState(), true);
  ctx.subscribe((s, prev, changed) => {
    if (changed.has('mode') && s.mode === 'hud') { render(s, true); return; }
    if (s.mode === 'hud' && (changed.has('sim') || changed.has('demoBudgetMin') || changed.has('plannedVariantId'))) render(s);
  });
  return { render };
}
