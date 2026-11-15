// rover.js — the rover's view (mode 'rover', container #rover).
// Shows what the support rover "thinks": its camera (a DEMO FRAME from Perseverance, since there is no live
// camera), confirmed hazards, where it is, where the crew is, the reroute it proposed, and an event log.
// Read-only: it only reads state. See docs/ui-redesign.md.

import { fmtMin, fmtDistM, distM, esc, pxToLonLat, fmtLonLat } from './util.js';
import { createMiniMap } from './minimap.js';

const MAP_SPAN_PX = 220;   // ~440 m across

export function initRover(ctx) {
  const { data, config } = ctx;
  const root = ctx.els.rover;
  if (!root) return null;
  root.classList.add('rv-root');
  root.innerHTML = `
    <section class="rv-cam" aria-label="Rover front camera">
      <div class="rv-frame">
        <img class="rv-img" data-f="img" alt="">
        <div class="rv-box" data-f="box" hidden><span data-f="boxLabel"></span></div>
        <div class="rv-tags">
          <span class="rv-tag" data-f="camName">FRONT STEREO · 2 FPS</span>
          <span class="rv-tag" data-f="scan"></span>
        </div>
        <span class="rv-credit" data-f="credit"></span>
      </div>
      <div class="rv-tabs" role="tablist" aria-label="Rover cameras">
        <button type="button" role="tab" class="rv-tab" data-cam="front" aria-selected="true">Front stereo (hazards)</button>
        <button type="button" role="tab" class="rv-tab" data-cam="rear" aria-selected="false">Rear stereo (crew)</button>
        <button type="button" role="tab" class="rv-tab" data-cam="mast" aria-selected="false">Mast 360° (map match)</button>
      </div>
      <ol class="rv-log" data-f="log" aria-label="Rover event log"></ol>
    </section>
    <aside class="rv-side">
      <div class="rv-map" data-f="map"><span class="rv-map-cap" data-f="mapCap"></span></div>
      <div class="rv-card">
        <h2 class="rv-h">Where is the rover</h2>
        <span data-f="pos" class="rv-mono"></span>
        <span class="rv-dim">Fix: 360° panorama matched to the HiRISE map at each stop (design target ±0.25 m) <span class="basis" data-basis="assumption">ASSUMPTION</span></span>
      </div>
      <div class="rv-card">
        <h2 class="rv-h">Crew tracking · rear camera + UWB</h2>
        <div class="rv-grid">
          <span class="rv-ev1">EV1</span><span data-f="d1"></span><span data-f="u1" class="rv-dim"></span>
          <span class="rv-ev2">EV2</span><span data-f="d2"></span><span data-f="u2" class="rv-dim"></span>
        </div>
        <span data-f="link" class="rv-dim"></span>
      </div>
      <div class="rv-card rv-reroute" data-f="reroute" hidden>
        <h2 class="rv-h">Reroute proposed</h2>
        <span data-f="rrLabel" class="rv-rr"></span>
        <span data-f="rrText" class="rv-dim"></span>
        <span class="rv-warn">Sent to both tablets · waiting for crew OK</span>
      </div>
      <div class="rv-card rv-stats">
        <div><span class="rv-dim">Speed</span><b data-f="speed">—</b></div>
        <div><span class="rv-dim">Tubes loaded</span><b data-f="tubes">—</b></div>
        <div><span class="rv-dim">Link</span><b data-f="linkShort">—</b></div>
      </div>
    </aside>`;

  const f = Object.fromEntries([...root.querySelectorAll('[data-f]')].map((n) => [n.dataset.f, n]));
  const set = (k, v) => { if (f[k].textContent !== v) f[k].textContent = v; };

  const mm = createMiniMap(f.map, { url: data.url('basemap.png'), widthPx: config.widthPx, heightPx: config.heightPx,
    pixelM: config.pixelM, label: 'Map around the rover' });
  const mmRoute = mm.line('mm-route');
  const mmProposed = mm.line('mm-proposed');
  const mmTether = mm.line('mm-tether');
  const mmHazard = mm.circle('mm-hazard');
  const stopSetters = data.stops.map((st) => mm.diamond(`mm-stop mm-stop-${st.kind || 'science'}`, st.id, 12));
  data.stops.forEach((st, i) => stopSetters[i](st.px));
  const ev2 = mm.circle('mm-ev2');
  const ev1 = mm.circle('mm-ev1');
  const rover = mm.square('mm-rover', 10);

  // camera tabs (front shows hazards; rear and mast are labeled placeholders of the same demo frame)
  let cam = 'front';
  root.querySelector('.rv-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cam]');
    if (!b) return;
    cam = b.dataset.cam;
    root.querySelectorAll('[data-cam]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    render(ctx.getState(), true);
  });

  // demo frame: a Perseverance image taken near the stop closest to the rover; changes every 12 sim-minutes
  let frameKey = '';
  f.img.addEventListener('error', () => { f.img.removeAttribute('src'); f.img.alt = 'Image unavailable (needs network)'; });
  function pickFrame(sim) {
    const rp = sim?.rover?.px || data.stopsById.H?.px;
    let best = null;
    for (const st of data.stops) {
      const d = distM(rp, st.px, config.pixelM);
      if (!best || d < best.d) best = { st, d };
    }
    const ph = data.photosByStop?.[best.st.id];
    const cands = (ph?.candidates || []).filter((c) => c.url);
    if (!cands.length) return null;
    const i = Math.floor((sim?.t || 0) / 12) % cands.length;
    return { ...cands[i], stopName: best.st.name, distM: best.d };
  }

  function render(s, force = false) {
    if (s.mode !== 'rover' && !force) return;
    const sim = s.sim;
    if (!sim) return;
    const rv = sim.rover;
    const linkOk = rv?.linkOk !== false;
    root.dataset.link = linkOk ? 'ok' : 'lost';

    // camera frame
    const fr = pickFrame(sim);
    const key = fr ? fr.url : '';
    if (key !== frameKey) {
      frameKey = key;
      if (fr) {
        f.img.src = fr.url;
        f.img.alt = `Demo frame: Perseverance ${fr.camera} image from sol ${fr.sol}, near ${fr.stopName}`;
        set('credit', `DEMO FRAME (no live camera): Perseverance ${fr.camera} · sol ${fr.sol} · ${fr.credit || 'NASA/JPL-Caltech'}`);
      } else {
        f.img.removeAttribute('src');
        set('credit', 'No demo frame available near the rover');
      }
    }
    set('camName', cam === 'front' ? 'FRONT STEREO · 2 FPS' : cam === 'rear' ? 'REAR STEREO · CREW TRACKING' : 'MAST 360° · MAP MATCH');

    // hazard box: shown on the front camera once the rock field is confirmed
    const hz = sim.hazard;
    const showBox = cam === 'front' && !!hz;
    f.box.hidden = !showBox;
    if (hz && rv) {
      const d = distM(rv.px, hz.px, config.pixelM);
      set('boxLabel', `ROCK FIELD · ${fmtDistM(d)} · CONFIRMED 3/3`);
      set('scan', 'HAZARD CONFIRMED');
      f.scan.dataset.level = 'danger';
    } else if (!linkOk) {
      set('scan', 'LINK DOWN · LOGGING ONLY');
      f.scan.dataset.level = 'warn';
    } else {
      set('scan', sim.hazardArmed ? 'SCANNING AHEAD' : 'NO NEW HAZARDS');
      f.scan.dataset.level = 'ok';
    }

    // position + crew
    const ll = rv && data.geo ? pxToLonLat(rv.px, data.geo) : null;
    set('pos', ll ? `${fmtLonLat(ll, 5)} (approx.) · ${fmtDistM(rv.aheadM)} ahead of the crew` : '');
    const c1 = sim.crew[0], c2 = sim.crew[1];
    set('d1', rv ? `${fmtDistM(distM(rv.px, c1.px, config.pixelM))} away` : '—');
    set('d2', rv ? `${fmtDistM(distM(rv.px, c2.px, config.pixelM))} away` : '—');
    set('u1', `±${c1.uncertaintyM.toFixed(1)} m`);
    set('u2', `±${c2.uncertaintyM.toFixed(1)} m`);
    set('link', linkOk ? 'Radio link to both suits: up' : `Radio link lost${sim.link?.lostSinceT != null ? ` since T+${fmtMin(sim.link.lostSinceT)}` : ''}: suits run on their own (dead reckoning)`);

    // reroute
    const p = sim.pendingReplan;
    f.reroute.hidden = !p;
    if (p) {
      set('rrLabel', p.label);
      set('rrText', p.safety?.text || '');
    }

    // stats: speed from the plan's flat speed x pace while walking; tubes loaded from the depot work progress
    const walking = sim.status === 'walking' || sim.status === 'returning';
    set('speed', walking ? `${(config.vFlatKmh * (sim.paceFactor || 1)).toFixed(1)} km/h` : '0.0 km/h');
    const nT = data.depot?.tubes?.length || 0;
    const workB = data.stopsById.B?.work_min || 1;
    const loaded = sim.working?.stopId === 'B' ? Math.round(nT * (1 - sim.working.leftMin / workB))
      : (sim.visited || []).includes('B') ? nT : 0;
    set('tubes', `${Math.max(0, Math.min(nT, loaded))} / ${nT}`);
    set('linkShort', linkOk ? 'Up' : 'Down');

    // map
    mm.view(rv?.px || c1.px, MAP_SPAN_PX);
    mmRoute(sim.active?.path);
    mmProposed(p?.path || null);
    mmTether(rv ? [rv.px, c1.px] : null);
    mmHazard(hz?.px || null, hz?.radiusPx || 0);
    ev2(c2.px, 3);
    ev1(c1.px, 3.4);
    rover(rv?.px || null);
    set('mapCap', `Rover ${linkOk ? '' : '(link down) '}· crew ${fmtDistM(rv?.aheadM ?? 0)} behind${hz ? ' · hazard ringed' : ''}`);

    // event log (newest first)
    const alerts = (sim.alerts || []).slice(-9).reverse();
    const logKey = alerts.map((a) => a.id).join('|');
    if (f.log.dataset.key !== logKey) {
      f.log.dataset.key = logKey;
      f.log.innerHTML = alerts.length
        ? alerts.map((a) => `<li data-level="${esc(a.level)}"><span class="rv-t">T+${esc(fmtMin(a.t))}</span> ${esc(a.title)}</li>`).join('')
        : '<li class="rv-dim">No events yet. Start the walk from DEMO ▸ Play.</li>';
    }
  }

  render(ctx.getState(), true);
  ctx.subscribe((s, prev, changed) => {
    if (changed.has('mode') && s.mode === 'rover') { render(s, true); return; }
    if (s.mode === 'rover' && changed.has('sim')) render(s);
  });
  return { render };
}
