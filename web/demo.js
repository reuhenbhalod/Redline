// demo.js — extra wiring for the DEMO console (#demo-drawer). app.js already wires the shared controls by id
// (#sel-speed, #btn-reset, #scrub, #sel-budget, [data-toggle], [data-mode-btn]); this adds the console-only parts:
// play button, speed buttons, crew switch for the tablet (state.tabletCrew), the stop-preview shortcut, stop
// markers under the scrubber, the clock readout, and jumping to the view where a scenario shows its effect.

import { fmtMin, effectiveBudget } from './util.js';

export function initDemo(ctx) {
  const { data, config } = ctx;
  const drawer = document.getElementById('demo-drawer');
  const toggleBtn = document.getElementById('btn-demo');
  if (!drawer) return null;
  const close = () => { if (!drawer.hidden) toggleBtn.click(); };

  drawer.addEventListener('click', (e) => {
    if (e.target === drawer) { close(); return; }          // click on the backdrop
    const t = e.target.closest('button');
    if (!t) return;
    const s = ctx.getState();
    if (t.hasAttribute('data-play')) {
      if (!s.sim?.pendingReplan) ctx.setState({ playing: !s.playing });
    } else if (t.dataset.speed) {
      ctx.setState({ speed: Number(t.dataset.speed) });
    } else if (t.dataset.crew != null) {
      ctx.setState({ tabletCrew: Number(t.dataset.crew) });
    }
    if (t.dataset.stop) {
      ctx.setState({ selectedStopId: t.dataset.stop });
      const st = data.stopsById[t.dataset.stop];
      if (st) setTimeout(() => ctx.emit('map:focus', { px: st.px, zoom: 1 }), 0);
    }
    if (t.dataset.goto) {
      // app.js has already toggled the key; jump to the view that shows the effect when it was turned ON
      if (t.getAttribute('aria-pressed') !== 'true' && readToggle(ctx.getState(), t.dataset.toggle)) {
        ctx.setMode(t.dataset.goto);
        close();
      }
    }
    if (t.hasAttribute('data-close')) close();
  });

  function readToggle(s, key) {
    return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), s);
  }

  // stop markers under the scrubber (planned variant, on the budget scale the scrubber uses)
  const marks = drawer.querySelector('[data-marks]');
  function renderMarks(s) {
    const v = data.variantsById[s.plannedVariantId] || data.routes.variants[0];
    const max = Math.ceil(effectiveBudget(s, config).budgetMin);
    marks.innerHTML = v.stop_plan.map((sp, i) => {
      const left = Math.min(100, (sp.arrive_min / max) * 100);
      const name = i === 0 ? 'Depart' : i === v.stop_plan.length - 1 ? 'Home' : (data.stopsById[sp.id]?.kind === 'depot' ? 'Depot' : `Stop ${sp.id}`);
      return `<span class="dd-mark" style="left:${left.toFixed(2)}%"><i></i>${name}</span>`;
    }).join('');
  }

  function render(s) {
    const play = drawer.querySelector('[data-play]');
    play.textContent = s.playing ? 'Pause' : 'Play';
    play.disabled = !!s.sim?.pendingReplan && !s.playing;
    drawer.querySelectorAll('[data-speed]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === s.speed)));
    drawer.querySelectorAll('[data-crew]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.crew) === (s.tabletCrew ?? 0))));
    const tEl = drawer.querySelector('[data-time]');
    const v = data.variantsById[s.plannedVariantId] || data.routes.variants[0];
    tEl.textContent = `T+${fmtMin(s.sim?.t ?? 0)} / ${fmtMin(v.est_min)}`;
    drawer.querySelectorAll('.dd-view[data-mode-btn]').forEach((b) => {
      const on = b.dataset.modeBtn === s.mode && (b.dataset.stop ? s.selectedStopId === b.dataset.stop : !(s.mode === 'planner' && s.selectedStopId));
      b.classList.toggle('is-on', on);
    });
  }

  renderMarks(ctx.getState());
  render(ctx.getState());
  ctx.subscribe((s, prev, changed) => {
    if (changed.has('plannedVariantId') || changed.has('demoBudgetMin')) renderMarks(s);
    if (!drawer.hidden || changed.has('mode')) render(s);
  });
  // re-render when the console opens
  new MutationObserver(() => { if (!drawer.hidden) render(ctx.getState()); }).observe(drawer, { attributes: true, attributeFilter: ['hidden'] });
  return { render };
}
