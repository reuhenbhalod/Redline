// events.js — scripted, realistic situations during the demo walk (on top of the sim's own rock-field reroute).
// Each event fires once per walk when its condition is met on state.sim. "Pop-up" events pause the walk and show
// a card in every view until someone presses Understood (or Play). Effects use the sim's own inputs (faults.highAir,
// slowPace), so air and pace really change. Restart clears everything. ?events=0 turns the script off (testing).
//
//  ~T+0:06  suit O2 use climbs on the ascent (faults.highAir on, silently: the cause)
//  ~T+0:14  POP-UP  High O2 use: slow down and conserve  -> on Understood: highAir off, slowPace on
//  ~T+0:35  pace back to normal (slowPace off)
//  arrive A POP-UP  Solar storm forecast in 3 h: be home by the deadline -> storm countdown chip in the top bar
//  at A     toast   dust devil sighted, drifting away
//  A -> B   (sim)   rover confirms a rock field -> detour card
//  leave B  toast   all sample tubes loaded on the rover
//  home leg toast   storm check: on track
//  home     toast   back with N min before the storm deadline

import { fmtMin } from './util.js';

const STORM_LEAD_MIN = 180;        // CME forecast to arrive 3 h after the alert
const SHELTER_MARGIN_MIN = 30;     // be inside this long before arrival

export function initEvents(ctx) {
  const params = new URLSearchParams(location.search);
  if (params.get('events') === '0') return null;
  const { data } = ctx;
  const pop = document.getElementById('event-pop');
  const chip = document.getElementById('storm-chip');
  if (!pop) return null;

  let fired = new Set();
  let ours = { highAir: false, slowPace: false };   // inputs this script switched on (so Restart can undo them)
  let stormDeadline = null;                        // sim minutes
  let queue = [];
  let showing = null;

  const setFaults = (patch) => ctx.setState({ faults: { ...ctx.getState().faults, ...patch } });

  function resetRun() {
    fired = new Set();
    stormDeadline = null;
    queue = []; hidePop();
    chip.hidden = true;
    const patch = {};
    if (ours.highAir) patch.faults = { ...ctx.getState().faults, highAir: false };
    if (ours.slowPace) patch.slowPace = false;
    ours = { highAir: false, slowPace: false };
    if (Object.keys(patch).length) ctx.setState(patch);
  }

  // ------------------------------------------------------------------ pop-up card
  function showPop(ev) {
    showing = ev;
    pop.dataset.level = ev.level;
    pop.querySelector('[data-k]').textContent = ev.kicker;
    pop.querySelector('[data-h]').textContent = ev.title;
    pop.querySelector('[data-t]').textContent = ev.text;
    const facts = pop.querySelector('[data-facts]');
    facts.innerHTML = '';
    for (const [k, v] of ev.facts || []) {
      const d = document.createElement('div');
      const a = document.createElement('span'); a.textContent = k;
      const b = document.createElement('b'); b.textContent = v;
      d.append(a, b); facts.appendChild(d);
    }
    pop.hidden = false;
    pop.querySelector('button').focus({ preventScroll: true });
  }
  function hidePop() { pop.hidden = true; showing = null; }
  function ack() {
    if (!showing) return;
    const ev = showing;
    hidePop();
    ev.onAck?.();
    if (queue.length) { showPop(queue.shift()); return; }
    if (!ctx.getState().sim?.pendingReplan) ctx.setState({ playing: true });
  }
  pop.querySelector('button').addEventListener('click', ack);
  document.addEventListener('keydown', (e) => { if (showing && e.key === 'Enter') { e.preventDefault(); ack(); } });

  function popup(ev) {
    ctx.setState({ playing: false });
    if (showing || ctx.getState().sim?.pendingReplan) queue.push(ev);
    else showPop(ev);
  }
  const toast = (level, title, text) => ctx.toast({ level, title, text, timeoutMs: 7000 });

  // ------------------------------------------------------------------ the script
  function check(s) {
    const sim = s.sim;
    if (!sim) return;
    if (sim.status === 'idle' && sim.t === 0) { if (fired.size || ours.highAir || ours.slowPace) resetRun(); return; }
    const once = (id, cond, fn) => { if (!fired.has(id) && cond) { fired.add(id); fn(); } };
    const visited = sim.visited || [];
    const atA = visited.includes('A');

    // 1. O2: rising use on the climb (cause), then the alert
    once('o2-rise', sim.t >= 6 && !atA && sim.status === 'walking', () => {
      if (!s.faults.highAir) { ours.highAir = true; setFaults({ highAir: true }); }
    });
    once('o2-alert', sim.t >= 14 && !atA && sim.status === 'walking', () => {
      const air = sim.air || {};
      popup({
        level: 'warn', kicker: `Suit · EV1 · T+${fmtMin(sim.t)}`,
        title: 'High oxygen use: slow down and conserve',
        text: 'You are working too hard on the climb toward the delta. Oxygen use is about 1.4× the plan and your heart rate is up. Slow your pace and keep your breathing steady; the route waits for you.',
        facts: [['O₂ use', '1.4× plan'], ['Heart rate', '148 bpm'], ['Air left', fmtMin(air.leftMin)], ['Pace after this', '0.8× (slower)']],
        onAck: () => {
          const patch = { slowPace: true };
          if (ours.highAir) { patch.faults = { ...ctx.getState().faults, highAir: false }; ours.highAir = false; }
          ours.slowPace = true;
          ctx.setState(patch);
        },
      });
    });
    once('o2-recover', sim.t >= 35 && ours.slowPace && !s.sim.pendingReplan, () => {
      ours.slowPace = false;
      ctx.setState({ slowPace: false });
      toast('ok', 'Breathing and O₂ use back to normal', 'Resume the planned pace.');
    });

    // 2. Solar storm forecast on arrival at the first stop
    once('storm', atA, () => {
      stormDeadline = sim.t + STORM_LEAD_MIN - SHELTER_MARGIN_MIN;
      const back = sim.schedule?.projectedReturnT;
      const ok = back != null && back <= stormDeadline;
      popup({
        level: 'danger', kicker: `Space weather · T+${fmtMin(sim.t)} · simulated forecast`,
        title: 'Solar storm in 3 hours: be back by then',
        text: `A coronal mass ejection is forecast to reach Mars at T+${fmtMin(sim.t + STORM_LEAD_MIN)}. Its radiation makes the surface unsafe, so the crew must be inside the habitat by T+${fmtMin(stormDeadline)} (${SHELTER_MARGIN_MIN} min shelter margin). ${ok ? 'The current plan gets you home in time.' : 'The current plan runs past the deadline: shorten the walk.'}`,
        facts: [['Storm arrives', `T+${fmtMin(sim.t + STORM_LEAD_MIN)}`], ['Be inside by', `T+${fmtMin(stormDeadline)}`], ['Plan home at', back != null ? `T+${fmtMin(back)}` : '—'], ['Status', ok ? 'On track' : 'Too late']],
        onAck: () => { chip.hidden = false; },
      });
    });

    // 3. Dust devil while working at A
    once('dust-devil', sim.status === 'working' && sim.working?.stopId === 'A' && sim.working.leftMin <= 25, () => {
      toast('info', 'Dust devil sighted 400 m east', 'Drifting north, away from you. No action needed; keep visors down and stay clear of its path.');
    });

    // 4. Sample tubes loaded when leaving the depot
    once('tubes', visited.includes('B') && sim.status === 'walking', () => {
      const n = data.depot?.tubes?.length || 10;
      toast('ok', `All ${n} sample tubes loaded on the rover`, 'Three Forks depot cleared. Heading home.');
    });

    // 5. Storm check on the way home
    once('storm-check', stormDeadline != null && visited.includes('B') && sim.status === 'walking' && sim.t >= (sim.schedule?.projectedReturnT ?? 999) - 30, () => {
      const back = sim.schedule?.projectedReturnT;
      toast(back <= stormDeadline ? 'ok' : 'danger', 'Storm check',
        `Home by T+${fmtMin(back)}; storm deadline T+${fmtMin(stormDeadline)} (${Math.round(stormDeadline - back)} min to spare).`);
    });

    // 6. Home
    once('home', sim.status === 'done' || sim.status === 'aborted', () => {
      const spare = stormDeadline != null ? Math.round(stormDeadline - sim.t) : null;
      toast('ok', 'Crew back inside the habitat', spare != null ? `Home at T+${fmtMin(sim.t)}, ${spare} min before the storm deadline.` : `Home at T+${fmtMin(sim.t)}.`);
    });

    // queued pop-up waits for the reroute card to be answered
    if (!showing && queue.length && !sim.pendingReplan) showPop(queue.shift());

    // storm countdown chip
    if (stormDeadline != null && !chip.hidden) {
      const left = stormDeadline - sim.t;
      const home = sim.status === 'done';
      const txt = home ? 'STORM · CREW SHELTERED' : left > 0 ? `STORM · BE INSIDE IN ${fmtMin(left)}` : 'STORM DEADLINE PASSED';
      if (chip.textContent !== txt) chip.textContent = txt;
      chip.dataset.level = home ? 'ok' : left > 30 ? 'warn' : 'danger';
    }
  }

  ctx.subscribe((s, prev, changed) => {
    if (changed.has('playing') && s.playing && showing) {   // Play also dismisses the card
      const ev = showing; hidePop(); ev.onAck?.();
    }
    if (changed.has('sim')) check(s);
  });
  return { resetRun };
}
