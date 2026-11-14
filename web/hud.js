// hud.js — Helmet / wrist HUD. Owner: HUD agent (hud.js + hud.css). Contract: INTERFACES.md "hud.js".
// Builds one SVG (plus a small HTML replan card) inside ctx.els.hud ONCE, then only updates
// attributes / textContent on each state change. Renders only while state.mode === 'hud'.
// Works with state.sim === null (shows the planned view from ctx.data / ctx.config).

import {
  clamp, distM, cumulativeDistM, distanceAt,
  bearingDeg, cardinal, fmtMin, fmtMinLong, fmtDistM,
} from './util.js';

const NS = 'http://www.w3.org/2000/svg';
const VB_W = 1600, VB_H = 900;

// Layout (viewBox units)
const ARROW = { cx: 320, cy: 420, r: 185 };
const MINI = { x: 1090, y: 130, w: 470, h: 470 };
const STRIP = { x: 90, y: 772, w: 1420 };
const AIRBAR = { x: 640, y: 568, w: 420, h: 26 };

const LEVEL_COLOR = { ok: 'var(--ok)', warn: 'var(--warn)', danger: 'var(--danger)', info: 'var(--info)' };

function svg(tag, attrs = {}, parent = null, text = null) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  if (text != null) n.textContent = text;
  if (parent) parent.appendChild(n);
  return n;
}
function html(tag, cls, parent = null, text = null) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  if (parent) parent.appendChild(n);
  return n;
}
const pts = (path) => path.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
const setAttr = (n, k, v) => { const s = String(v); if (n.getAttribute(k) !== s) n.setAttribute(k, s); };
const setText = (n, t) => { const s = String(t ?? ''); if (n.textContent !== s) n.textContent = s; };
const show = (n, on) => setAttr(n, 'display', on ? 'inline' : 'none');
/**
 * Set text and make it fit in maxW viewBox units: squeeze up to 25% with textLength, and
 * if that is not enough, cut it with an ellipsis first. Only measures when the text changed.
 */
function setFit(n, t, maxW) {
  const full = String(t ?? '');
  if (n.__fitSrc === full && n.__fitW === maxW) return;
  n.__fitSrc = full; n.__fitW = maxW;
  n.textContent = full;
  n.removeAttribute('textLength'); n.removeAttribute('lengthAdjust');
  if (!full) return;
  let w;
  try { w = n.getComputedTextLength(); } catch { return; }
  if (!w || w <= maxW) return;
  if (w * 0.75 > maxW) {
    const keep = Math.max(4, Math.floor((full.length * maxW) / (w * 0.75)) - 1);
    n.textContent = `${full.slice(0, keep).trimEnd()}…`;
    try { w = n.getComputedTextLength(); } catch { return; }
    if (w <= maxW) return;
  }
  n.setAttribute('textLength', String(maxW));
  n.setAttribute('lengthAdjust', 'spacingAndGlyphs');
}

/** @param {object} ctx  see INTERFACES.md "ctx" */
export function initHud(ctx) {
  const { data, config } = ctx;
  const root = ctx.els.hud;
  root.textContent = '';
  root.classList.add('hud-root');

  // ---------------------------------------------------------------------------
  // Static route geometry: bbox of all variants (mini-map overview)
  // ---------------------------------------------------------------------------
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (p) => { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); };
  data.routes.variants.forEach((v) => v.path.forEach(grow));
  data.stops.forEach((s) => grow(s.px));
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = config.widthPx; maxY = config.heightPx; }
  const side = Math.max(maxX - minX, maxY - minY) * 1.18 + 40;
  const ccx = (minX + maxX) / 2, ccy = (minY + maxY) / 2;
  const overviewVB = { x: ccx - side / 2, y: ccy - side / 2, w: side, h: side };
  const LOCAL_HALF_M = 300; // local view: 600 m across

  // ---------------------------------------------------------------------------
  // Build DOM once
  // ---------------------------------------------------------------------------
  const s = svg('svg', {
    class: 'hud-svg', viewBox: `0 0 ${VB_W} ${VB_H}`, preserveAspectRatio: 'xMidYMid meet',
    role: 'img', 'aria-label': 'Helmet heads-up display',
  }, root);

  const defs = svg('defs', {}, s);
  const glow = svg('filter', { id: 'hud-glow', x: '-30%', y: '-30%', width: '160%', height: '160%' }, defs);
  svg('feGaussianBlur', { stdDeviation: 3, result: 'b' }, glow);
  const fm = svg('feMerge', {}, glow);
  svg('feMergeNode', { in: 'b' }, fm);
  svg('feMergeNode', { in: 'SourceGraphic' }, fm);
  const clip = svg('clipPath', { id: 'hud-mini-clip' }, defs);
  svg('rect', { x: MINI.x, y: MINI.y, width: MINI.w, height: MINI.h, rx: 18 }, clip);
  const vign = svg('radialGradient', { id: 'hud-vignette', cx: '50%', cy: '50%', r: '75%' }, defs);
  svg('stop', { offset: '60%', 'stop-color': '#000', 'stop-opacity': 0 }, vign);
  svg('stop', { offset: '100%', 'stop-color': '#000', 'stop-opacity': 0.75 }, vign);

  // Visor frame
  const frame = svg('g', { class: 'hud-frame' }, s);
  svg('rect', { x: 0, y: 0, width: VB_W, height: VB_H, fill: 'url(#hud-vignette)', 'pointer-events': 'none' }, frame);
  svg('rect', { class: 'hud-visor', x: 14, y: 14, width: VB_W - 28, height: VB_H - 28, rx: 46 }, frame);
  for (const [x, y, dx, dy] of [[40, 40, 1, 1], [VB_W - 40, 40, -1, 1], [40, VB_H - 40, 1, -1], [VB_W - 40, VB_H - 40, -1, -1]]) {
    svg('path', { class: 'hud-bracket', d: `M${x} ${y + 50 * dy} L${x} ${y} L${x + 50 * dx} ${y}` }, frame);
  }

  // Top-left: clock + status
  const gTop = svg('g', {}, s);
  const tClock = svg('text', { class: 'hud-t hud-clock', x: 70, y: 92 }, gTop, 'T+0:00');
  const tStatus = svg('text', { class: 'hud-t hud-status', x: 70, y: 124 }, gTop, '');
  const tPace = svg('text', { class: 'hud-t hud-tag hud-tag-warn', x: 70, y: 154 }, gTop, 'SLOW PACE');
  // Top-right: FAKE tag
  const gFake = svg('g', { class: 'hud-fake' }, s);
  svg('rect', { x: VB_W - 226, y: 58, width: 156, height: 34, rx: 6 }, gFake);
  svg('text', { class: 'hud-t', x: VB_W - 148, y: 82, 'text-anchor': 'middle' }, gFake, 'FAKE DATA');
  show(gFake, !!data.fake);

  // Alert banner (top center)
  const gBanner = svg('g', { class: 'hud-banner' }, s);
  const bRect = svg('rect', { x: 410, y: 40, width: 650, height: 84, rx: 14 }, gBanner);
  const bTitle = svg('text', { class: 'hud-t hud-banner-title', x: 735, y: 76, 'text-anchor': 'middle' }, gBanner, '');
  const bText = svg('text', { class: 'hud-t hud-banner-text', x: 735, y: 108, 'text-anchor': 'middle' }, gBanner, '');

  // Arrow / compass (left)
  const gArrow = svg('g', { class: 'hud-compass' }, s);
  svg('circle', { class: 'hud-ring', cx: ARROW.cx, cy: ARROW.cy, r: ARROW.r }, gArrow);
  svg('circle', { class: 'hud-ring hud-ring-inner', cx: ARROW.cx, cy: ARROW.cy, r: ARROW.r - 34 }, gArrow);
  for (let d = 0; d < 360; d += 10) {
    const major = d % 90 === 0, mid = d % 30 === 0;
    const r1 = ARROW.r, r0 = ARROW.r - (major ? 22 : mid ? 14 : 7);
    const a = (d * Math.PI) / 180;
    svg('line', {
      class: major ? 'hud-tick hud-tick-major' : 'hud-tick',
      x1: ARROW.cx + r0 * Math.sin(a), y1: ARROW.cy - r0 * Math.cos(a),
      x2: ARROW.cx + r1 * Math.sin(a), y2: ARROW.cy - r1 * Math.cos(a),
    }, gArrow);
  }
  for (const [lbl, d] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
    const a = (d * Math.PI) / 180, r = ARROW.r + 24;
    svg('text', { class: `hud-t hud-cardinal${lbl === 'N' ? ' hud-cardn' : ''}`, x: ARROW.cx + r * Math.sin(a), y: ARROW.cy - r * Math.cos(a) + 9, 'text-anchor': 'middle' }, gArrow, lbl);
  }
  // Heading tick (direction of travel) on the outer ring
  const gHeading = svg('g', {}, gArrow);
  svg('path', { class: 'hud-heading', d: `M${ARROW.cx} ${ARROW.cy - ARROW.r - 2} l-11 -20 h22 z` }, gHeading);
  // Home bearing marker (small house glyph on ring)
  const gHomeMark = svg('g', {}, gArrow);
  svg('circle', { class: 'hud-homemark', cx: ARROW.cx, cy: ARROW.cy - ARROW.r + 17, r: 10 }, gHomeMark);
  svg('text', { class: 'hud-t hud-homemark-t', x: ARROW.cx, y: ARROW.cy - ARROW.r + 23, 'text-anchor': 'middle' }, gHomeMark, 'H');
  // Big arrow
  const gBig = svg('g', { class: 'hud-arrow', filter: 'url(#hud-glow)' }, gArrow);
  const arrowPath = svg('path', {
    d: `M${ARROW.cx} ${ARROW.cy - 150} L${ARROW.cx + 70} ${ARROW.cy + 20} L${ARROW.cx + 22} ${ARROW.cy - 5} L${ARROW.cx + 22} ${ARROW.cy + 110} L${ARROW.cx - 22} ${ARROW.cy + 110} L${ARROW.cx - 22} ${ARROW.cy - 5} L${ARROW.cx - 70} ${ARROW.cy + 20} Z`,
  }, gBig);
  const tBearing = svg('text', { class: 'hud-t hud-bearing', x: ARROW.cx, y: ARROW.cy + ARROW.r + 72, 'text-anchor': 'middle' }, gArrow, '');
  const tArrowFor = svg('text', { class: 'hud-t hud-label', x: ARROW.cx, y: ARROW.cy + ARROW.r + 102, 'text-anchor': 'middle' }, gArrow, '');

  // Center column: next stop + big readouts
  const CX = 640;
  const gMid = svg('g', {}, s);
  svg('text', { class: 'hud-t hud-label', x: CX, y: 182 }, gMid, 'NEXT STOP');
  const tNextName = svg('text', { class: 'hud-t hud-next', x: CX, y: 226 }, gMid, '');
  const tDist = svg('text', { class: 'hud-t hud-big', x: CX, y: 322 }, gMid, '');
  const tDistSub = svg('text', { class: 'hud-t hud-sub', x: CX, y: 358 }, gMid, '');
  const tEta = svg('text', { class: 'hud-t hud-sub', x: CX, y: 392 }, gMid, '');

  svg('text', { class: 'hud-t hud-label', x: CX, y: 452 }, gMid, 'AIR LEFT');
  svg('text', { class: 'hud-t hud-label', x: CX + 230, y: 452 }, gMid, 'TIME TO WALK HOME');
  // Air bar (budget scale): fill = air left, marker = time home + reserve
  const gBar = svg('g', { class: 'hud-airbar' }, gMid);
  svg('rect', { class: 'hud-bar-bg', x: AIRBAR.x, y: AIRBAR.y, width: AIRBAR.w, height: AIRBAR.h, rx: 5 }, gBar);
  const barReserve = svg('rect', { class: 'hud-bar-reserve', x: AIRBAR.x, y: AIRBAR.y, width: 0, height: AIRBAR.h, rx: 5 }, gBar);
  const barFill = svg('rect', { class: 'hud-bar-fill', x: AIRBAR.x, y: AIRBAR.y + 4, width: 0, height: AIRBAR.h - 8, rx: 3 }, gBar);
  const barNeed = svg('line', { class: 'hud-bar-need', x1: AIRBAR.x, x2: AIRBAR.x, y1: AIRBAR.y - 8, y2: AIRBAR.y + AIRBAR.h + 8 }, gBar);
  const tBarNeed = svg('text', { class: 'hud-t hud-tiny', x: AIRBAR.x, y: AIRBAR.y + AIRBAR.h + 26, 'text-anchor': 'middle' }, gBar, 'home+reserve');
  const tAirT = svg('text', { class: 'hud-t', x: CX, y: 545 }, gMid);
  const tAir = svg('tspan', { class: 'hud-huge' }, tAirT, '');
  svg('tspan', { class: 'hud-unit', dx: 8 }, tAirT, 'min');
  const tHomeT = svg('text', { class: 'hud-t', x: CX + 230, y: 545 }, gMid);
  const tHome = svg('tspan', { class: 'hud-huge' }, tHomeT, '');
  svg('tspan', { class: 'hud-unit', dx: 8 }, tHomeT, 'min');
  const tMargin = svg('text', { class: 'hud-t hud-sub', x: CX, y: 648 }, gMid, '');
  const tBurn = svg('text', { class: 'hud-t hud-tiny', x: CX, y: 674 }, gMid, '');
  const tEnv = svg('text', { class: 'hud-t hud-sub', x: CX, y: 704 }, gMid, '');

  // Mini-map (right)
  const gMiniFrame = svg('g', { class: 'hud-mini' }, s);
  svg('rect', { class: 'hud-mini-bg', x: MINI.x, y: MINI.y, width: MINI.w, height: MINI.h, rx: 18 }, gMiniFrame);
  const miniSvg = svg('svg', {
    x: MINI.x, y: MINI.y, width: MINI.w, height: MINI.h,
    viewBox: `${overviewVB.x} ${overviewVB.y} ${overviewVB.w} ${overviewVB.h}`, preserveAspectRatio: 'xMidYMid slice',
  }, gMiniFrame);
  const mImg = svg('image', { href: data.url('basemap.png'), x: 0, y: 0, width: config.widthPx, height: config.heightPx, class: 'hud-mini-img', preserveAspectRatio: 'none' }, miniSvg);
  mImg.addEventListener('error', () => mImg.remove(), { once: true });
  const mAlt = svg('g', { class: 'hud-m-alt' }, miniSvg);
  data.routes.variants.forEach((v) => svg('polyline', { points: pts(v.path) }, mAlt));
  const mHome = svg('polyline', { class: 'hud-m-home', points: '' }, miniSvg);
  const mActive = svg('polyline', { class: 'hud-m-active', points: '' }, miniSvg);
  const mProposed = svg('polyline', { class: 'hud-m-proposed', points: '' }, miniSvg);
  const mTrail = svg('polyline', { class: 'hud-m-trail', points: '' }, miniSvg);
  const mStops = svg('g', {}, miniSvg);
  const stopEls = {};
  for (const st of data.stops) {
    const g = svg('g', { class: `hud-m-stop hud-m-stop-${st.kind || 'other'}` }, mStops);
    const c = svg('circle', { cx: st.px[0], cy: st.px[1], r: 10 }, g);
    const t = svg('text', { class: 'hud-t', x: st.px[0], y: st.px[1], 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g, st.id);
    stopEls[st.id] = { g, c, t };
  }
  const mRover = svg('g', { class: 'hud-m-rover' }, miniSvg);
  const mRoverDot = svg('rect', { x: 0, y: 0, width: 10, height: 10 }, mRover);
  const crewEls = [0, 1].map((i) => {
    const g = svg('g', { class: `hud-m-crew hud-m-crew-${i + 1}` }, miniSvg);
    const ring = svg('circle', { class: 'hud-m-unc', cx: 0, cy: 0, r: 5 }, g);
    const dot = svg('circle', { class: 'hud-m-dot', cx: 0, cy: 0, r: 5 }, g);
    return { g, ring, dot };
  });
  const tMiniTitle = svg('text', { class: 'hud-t hud-label', x: MINI.x + 18, y: MINI.y - 16 }, s, 'MAP · OVERVIEW');
  const tMiniHint = svg('text', { class: 'hud-t hud-tiny', x: MINI.x + MINI.w - 14, y: MINI.y - 16, 'text-anchor': 'end' }, s, 'click: zoom');
  const tMiniNorth = svg('text', { class: 'hud-t hud-tiny', x: MINI.x + 16, y: MINI.y + MINI.h - 14 }, s, '▲ N (map up, assumption)');
  const tCrewUnc = svg('text', { class: 'hud-t hud-sub', x: MINI.x, y: MINI.y + MINI.h + 40 }, s, '');
  const tRover = svg('text', { class: 'hud-t hud-tiny', x: MINI.x, y: MINI.y + MINI.h + 70 }, s, '');
  // Legend under mini map
  const gLeg = svg('g', { class: 'hud-legend' }, s);
  let lgx = MINI.x;
  [['hud-lg-crew1', 'EV1'], ['hud-lg-crew2', 'EV2'], ['hud-lg-rover', 'rover'], ['hud-lg-prop', 'proposed'], ['hud-lg-home', 'way home']].forEach(([c, l]) => {
    const x = lgx; lgx += 34 + l.length * 9.5;
    svg('circle', { class: c, cx: x + 8, cy: MINI.y + MINI.h + 98, r: 6 }, gLeg);
    svg('text', { class: 'hud-t hud-tiny', x: x + 20, y: MINI.y + MINI.h + 103 }, gLeg, l);
  });
  // Hit area for view toggle
  const miniHit = svg('rect', { x: MINI.x, y: MINI.y, width: MINI.w, height: MINI.h, rx: 18, fill: 'transparent', class: 'hud-mini-hit' }, s);
  let miniLocal = false;
  miniHit.addEventListener('click', () => { miniLocal = !miniLocal; lastKey.miniScale = null; render(); });

  // Route strip (bottom)
  const gStrip = svg('g', { class: 'hud-strip' }, s);
  const tStripLabel = svg('text', { class: 'hud-t hud-label', x: STRIP.x, y: STRIP.y - 30 }, gStrip, '');
  const tStripRight = svg('text', { class: 'hud-t hud-tiny', x: STRIP.x + STRIP.w, y: STRIP.y - 30, 'text-anchor': 'end' }, gStrip, '');
  svg('line', { class: 'hud-strip-base', x1: STRIP.x, x2: STRIP.x + STRIP.w, y1: STRIP.y, y2: STRIP.y }, gStrip);
  const stripDone = svg('line', { class: 'hud-strip-done', x1: STRIP.x, x2: STRIP.x, y1: STRIP.y, y2: STRIP.y }, gStrip);
  const stripTicks = svg('g', {}, gStrip);
  const stripMe = svg('g', { class: 'hud-strip-me' }, gStrip);
  svg('path', { d: 'M0 -14 L10 0 L0 14 L-10 0 Z' }, stripMe);

  // Footnotes
  const tFoot = svg('text', { class: 'hud-t hud-foot', x: 70, y: VB_H - 46 }, s, '');

  // HTML replan card (needs a real button)
  const card = html('div', 'hud-card', root);
  card.hidden = true;
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-label', 'Reroute proposed');
  const cHead = html('div', 'hud-card-head', card, 'REROUTE PROPOSED');
  const cLabel = html('div', 'hud-card-label', card, '');
  const cMeta = html('div', 'hud-card-meta', card, '');
  const cWhy = html('ul', 'hud-card-why', card);
  const cSafe = html('div', 'hud-card-safe', card, '');
  const cRej = html('div', 'hud-card-rej', card, '');
  const cBtn = html('button', 'hud-card-btn', card, 'CONFIRM REROUTE  ⏎');
  cBtn.type = 'button';
  cBtn.addEventListener('click', () => confirmPending());

  function confirmPending() {
    const p = ctx.getState().sim?.pendingReplan;
    if (p) ctx.emit('replan:confirm', { id: p.id });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey) return;
    const st = ctx.getState();
    if (st.mode !== 'hud' || !st.sim?.pendingReplan) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || e.target.isContentEditable) return;
    // Let other HUD buttons handle Enter, but a focused top-bar toggle (e.g. the Storm button the
    // presenter just clicked) must not swallow Enter: in HUD mode Enter means "confirm the reroute".
    if (tag === 'button' && e.target !== cBtn && !e.target.closest('#topbar')) return;
    e.preventDefault();
    confirmPending();
  });

  // ---------------------------------------------------------------------------
  // Derived view model (works with sim === null)
  // ---------------------------------------------------------------------------
  const cumCache = new Map();
  function cumFor(id, path) {
    let c = cumCache.get(id);
    if (!c || c.path !== path) { c = { path, cum: cumulativeDistM(path, config.pixelM) }; cumCache.set(id, c); }
    return c.cum;
  }

  function pathLenM(path) {
    const c = cumulativeDistM(path, config.pixelM);
    return c[c.length - 1] || 0;
  }

  function plannedView(st) {
    const v = data.variantsById[st.plannedVariantId] || data.routes.variants[0];
    const home = data.stopsById.H || data.stops[0];
    const startPx = v.path[0] || home.px;
    const sp = v.stop_plan || [];
    const next = sp[1];
    const nStop = next ? data.stopsById[next.id] : null;
    const cum = cumFor(`planned:${v.id}`, v.path);
    const th = ctx.timeHomeAt(startPx) ?? v.home_min?.[0] ?? 0;
    return {
      planned: true,
      t: 0,
      status: 'idle',
      statusText: `Planned: ${v.id} · press Play to start`,
      active: {
        id: v.id, kind: 'planned', label: `Plan ${v.stops.join('→')}`, path: v.path, tMin: v.t_min,
        stopMarks: sp.map((p) => ({ id: p.id, pathIndex: p.path_index, arriveMin: p.arrive_min, departMin: p.depart_min })),
        distanceM: v.distance_m,
      },
      trail: [],
      progress: { i: 0, frac: 0, distanceAlongM: 0, remainingM: v.distance_m },
      nextStop: nStop ? {
        id: nStop.id, name: nStop.name, px: nStop.px,
        distanceM: cum[next.path_index] ?? distM(startPx, nStop.px, config.pixelM),
        straightM: distM(startPx, nStop.px, config.pixelM),
        bearingDeg: bearingDeg(startPx, nStop.px), etaT: next.arrive_min, plannedArriveT: next.arrive_min,
      } : null,
      headingDeg: v.path[1] ? bearingDeg(v.path[0], v.path[1]) : 0,
      working: null,
      crew: [
        { id: 'EV1', px: startPx, truePx: startPx, uncertaintyM: config.posErrM },
        { id: 'EV2', px: startPx, truePx: startPx, uncertaintyM: config.posErrM },
      ],
      rover: { px: startPx, linkOk: !st.faults?.linkLost, aheadM: 0 },
      air: {
        budgetMin: config.budgetMin, reserveMin: config.reserveMin, usedMin: 0, leftMin: config.budgetMin,
        burnFactor: st.faults?.highAir ? config.highAirBurnFactor : 1, timeHomeMin: th, timeHomeSource: 'grid',
        marginMin: config.budgetMin - th - config.reserveMin, level: 'ok', turnaround: false,
      },
      schedule: { behindMin: 0, plannedReturnT: v.est_min, projectedReturnT: v.est_min },
      env: {
        dust: data.env.dust, solarAlert: !!data.env.solar_alert || !!st.faults?.storm, stormActive: !!st.faults?.storm,
        level: st.faults?.storm ? 'danger' : (data.env.solar_alert || data.env.dust === 'high') ? 'warn' : 'ok',
        text: `Dust ${data.env.dust} · ${data.env.solar_alert ? 'SOLAR ALERT' : 'no solar alert'}`,
      },
      link: { ok: !st.faults?.linkLost, lostSinceT: null },
      home: { px: home.px, bearingDeg: bearingDeg(startPx, home.px), straightM: distM(startPx, home.px, config.pixelM), timeHomeMin: th, path: [] },
      visited: [], dropped: [], replans: [], pendingReplan: null, alerts: [],
    };
  }

  function pickBanner(sim, st) {
    if (sim.pendingReplan) {
      const p = sim.pendingReplan;
      const trig = p.trigger === 'storm' ? 'danger' : p.trigger === 'air' ? 'danger' : 'warn';
      return { level: trig, title: /^(storm|turn|abort|return)/i.test(p.label || '') ? p.label : `REROUTE: ${p.label}`, text: `Confirm on the card below${p.behindMin > 0.5 ? ` · ${Math.round(p.behindMin)} min behind` : ''}`, kind: 'replan' };
    }
    const alerts = sim.alerts || [];
    for (let i = alerts.length - 1; i >= 0; i--) {
      const a = alerts[i];
      if (a && a.active) {
        if (a.kind === 'link') return { ...a, title: 'ROVER LINK LOST · SUIT-ONLY', text: a.text || 'Dead reckoning. Follow the way-home arrow.' };
        return a;
      }
    }
    // Fallbacks derived from state (in case the sim has no active alert yet)
    if (sim.env?.stormActive || st.faults?.storm) return { level: 'danger', kind: 'storm', title: 'STORM · WALK ABORTED', text: sim.env?.text || 'Head home on the shortest safe route' };
    if (sim.link && !sim.link.ok) return { level: 'danger', kind: 'link', title: 'ROVER LINK LOST · SUIT-ONLY', text: 'Dead reckoning. Follow the way-home arrow.' };
    if (sim.air?.turnaround) return { level: 'danger', kind: 'air', title: 'TURN AROUND', text: 'Air for the walk home is getting short' };
    return null;
  }

  // ---------------------------------------------------------------------------
  // Render (attribute updates only)
  // ---------------------------------------------------------------------------
  const lastKey = { active: null, proposed: null, home: null, trailLen: -1, trailRef: null, stripId: null, miniScale: null, cardId: undefined, dropped: null, visited: null };

  function render() {
    const st = ctx.getState();
    if (st.mode !== 'hud') return;
    const sim = st.sim || plannedView(st);
    const air = sim.air || {};
    const linkOk = sim.link ? sim.link.ok : !st.faults?.linkLost;
    const storm = !!(sim.env?.stormActive || st.faults?.storm);
    const returning = sim.status === 'returning' || sim.active?.kind === 'abort' || sim.active?.kind === 'return';
    const ev1 = sim.crew?.[0]?.px || data.stopsById.H?.px || [0, 0];

    // Root level classes
    root.dataset.level = storm ? 'danger' : !linkOk ? 'danger' : (air.level || 'ok');
    root.classList.toggle('hud-suitonly', !linkOk);
    root.classList.toggle('hud-storm', storm);

    // Clock + status
    setText(tClock, `T+${fmtMin(sim.t ?? 0)}`);
    setFit(tStatus, (sim.statusText || sim.status || '').toUpperCase(), 320);
    show(tPace, !!st.slowPace);
    setText(tPace, st.slowPace ? `SLOW PACE ${Math.round((sim.paceFactor ?? config.slowPaceFactor) * 100)}% (demo)` : '');

    // Banner
    const ban = pickBanner(sim, st);
    show(gBanner, !!ban);
    if (ban) {
      setAttr(gBanner, 'data-level', ban.level || 'info');
      setAttr(bRect, 'class', `hud-banner-bg hud-lv-${ban.level || 'info'}`);
      const tt = String(ban.title || '').toUpperCase();
      setFit(bTitle, tt, 610);
      const bt = String(ban.text || '');
      setFit(bText, bt, 610);
    }

    // Arrow target: home in suit-only, storm or while returning; else next stop
    const goHome = !linkOk || storm || returning || !sim.nextStop;
    const hm = sim.home || {};
    let bearing, forText, distText, distSub, etaText, nameText;
    if (goHome && hm.px && !(sim.nextStop && returning && sim.nextStop.id !== 'H' && linkOk && !storm)) {
      const b = hm.bearingDeg ?? bearingDeg(ev1, hm.px);
      bearing = b;
      forText = !linkOk ? 'WAY HOME (DEAD RECKONING)' : 'WAY HOME';
      nameText = data.stopsById.H?.name ? `Home · ${data.stopsById.H.name}` : 'Home';
      // distance along the way home: the active route once it IS the way home, else the home path
      const homeBound = returning || sim.nextStop?.id === 'H';
      let along = null;
      if (sim.nextStop?.id === 'H' && homeBound) along = sim.nextStop.distanceM;
      else if (homeBound && sim.progress) along = sim.progress.remainingM;
      else if (hm.path?.length > 1) along = pathLenM(hm.path);
      distText = fmtDistM(along ?? hm.straightM);
      distSub = `${fmtDistM(hm.straightM)} straight line`;
      etaText = sim.nextStop?.id === 'H' && sim.nextStop.etaT != null ? `ETA T+${fmtMin(sim.nextStop.etaT)}` : `walk home ${fmtMinLong(hm.timeHomeMin ?? air.timeHomeMin)}`;
      if (sim.status === 'done' || sim.status === 'aborted') {
        forText = sim.status === 'done' ? 'WALK COMPLETE' : 'BACK HOME (ABORTED)';
        distText = '0 m'; distSub = 'at habitat'; etaText = `returned T+${fmtMin(sim.t)}`;
      }
    } else {
      const n = sim.nextStop;
      bearing = n?.bearingDeg ?? 0;
      forText = 'TO NEXT STOP';
      nameText = n ? `${n.id} · ${n.name}` : '—';
      distText = fmtDistM(n?.distanceM);
      distSub = n ? `${fmtDistM(n.straightM)} straight line` : '';
      if (n?.etaT != null) {
        const late = n.plannedArriveT != null ? n.etaT - n.plannedArriveT : 0;
        etaText = `ETA T+${fmtMin(n.etaT)}${n.plannedArriveT != null ? ` · plan T+${fmtMin(n.plannedArriveT)}` : ''}${late > 0.5 ? ` · +${Math.round(late)} late` : ''}`;
      } else etaText = '';
    }
    if (sim.working) {
      const ws = data.stopsById[sim.working.stopId];
      forText = `WORKING · ${Math.ceil(sim.working.leftMin)} MIN LEFT`;
      if (ws) distSub = `at ${ws.name} · then ${distSub}`;
    }
    const rot = `rotate(${(bearing || 0).toFixed(1)} ${ARROW.cx} ${ARROW.cy})`;
    setAttr(gBig, 'transform', rot);
    setAttr(arrowPath, 'class', goHome ? 'hud-arrow-home' : 'hud-arrow-next');
    setAttr(gHeading, 'transform', `rotate(${(sim.headingDeg || 0).toFixed(1)} ${ARROW.cx} ${ARROW.cy})`);
    show(gHomeMark, !goHome && !!hm.px);
    if (hm.px) setAttr(gHomeMark, 'transform', `rotate(${(hm.bearingDeg ?? 0).toFixed(1)} ${ARROW.cx} ${ARROW.cy})`);
    setText(tBearing, `${Math.round(bearing || 0)}° ${cardinal(bearing || 0)}`);
    setText(tArrowFor, forText);
    setFit(tNextName, nameText, 430);
    setText(tDist, distText);
    setFit(tDistSub, distSub, 430);
    setFit(tEta, etaText, 430);

    // Air
    const budget = air.budgetMin ?? config.budgetMin;
    const reserve = air.reserveMin ?? config.reserveMin;
    const left = air.leftMin ?? budget;
    const th = air.timeHomeMin;
    const lvl = air.level || 'ok';
    setText(tAir, Number.isFinite(left) ? String(Math.max(0, Math.round(left))) : '--');
    setText(tHome, Number.isFinite(th) ? String(Math.round(th)) : '--');
    setAttr(tAir, 'class', `hud-huge hud-lv-${lvl}`);
    setAttr(tHome, 'class', `hud-huge ${!linkOk ? 'hud-lv-warn' : ''}`);
    const scale = (m) => AIRBAR.w * clamp((m || 0) / budget, 0, 1);
    setAttr(barFill, 'width', scale(left).toFixed(1));
    setAttr(barFill, 'class', `hud-bar-fill hud-fill-${lvl}`);
    const need = Number.isFinite(air.neededMin) ? air.neededMin : (Number.isFinite(th) ? th : 0) + reserve;
    const nx = AIRBAR.x + scale(need);
    setAttr(barReserve, 'width', scale(need).toFixed(1));
    setAttr(barNeed, 'x1', nx.toFixed(1)); setAttr(barNeed, 'x2', nx.toFixed(1));
    setAttr(tBarNeed, 'x', clamp(nx, AIRBAR.x + 50, AIRBAR.x + AIRBAR.w - 50).toFixed(1));
    const margin = air.marginMin ?? (left - need);
    setFit(tMargin, air.turnaround ? `TURN AROUND · margin ${Math.round(margin)} min` : `Margin ${Number.isFinite(margin) ? `${margin >= 0 ? '+' : ''}${Math.round(margin)} min` : '—'} · ${reserve} reserve kept`, 430);
    setAttr(tMargin, 'class', `hud-t hud-sub hud-lv-${lvl}`);
    const src = air.timeHomeSource === 'grid' ? 'grid' : air.timeHomeSource === 'route' ? 'route' : 'n/a';
    setText(tBurn, `air burn ${(air.burnFactor ?? 1).toFixed(1)}×${(air.burnFactor ?? 1) > 1 ? ' HIGH' : ''} · home via ${src}`);
    setAttr(tBurn, 'class', `hud-t hud-tiny ${(air.burnFactor ?? 1) > 1 ? 'hud-lv-warn' : ''}`);
    const envLvl = sim.env?.level || 'ok';
    setFit(tEnv, sim.env?.text || `Dust ${data.env.dust}`, 430);
    setAttr(tEnv, 'class', `hud-t hud-sub hud-lv-${envLvl}`);

    // Mini map geometry (only when changed)
    const act = sim.active;
    if (act && lastKey.active !== act) {
      lastKey.active = act;
      setAttr(mActive, 'points', pts(act.path || []));
      setAttr(mActive, 'class', `hud-m-active ${act.kind === 'abort' || act.kind === 'return' ? 'hud-m-active-home' : act.kind !== 'planned' ? 'hud-m-active-alt' : ''}`);
    }
    const prop = sim.pendingReplan?.path || null;
    if (lastKey.proposed !== prop) {
      lastKey.proposed = prop;
      setAttr(mProposed, 'points', prop ? pts(prop) : '');
    }
    const homePath = (!linkOk || storm) && hm.path?.length ? hm.path : null;
    if (lastKey.home !== homePath) {
      lastKey.home = homePath;
      setAttr(mHome, 'points', homePath ? pts(homePath) : '');
    }
    const trail = sim.trail || [];
    if (lastKey.trailRef !== trail || lastKey.trailLen !== trail.length) {
      lastKey.trailRef = trail; lastKey.trailLen = trail.length;
      setAttr(mTrail, 'points', trail.length > 1 ? pts(trail) : '');
    }

    // Mini viewBox and screen-relative sizes
    let vb = overviewVB;
    if (miniLocal) {
      const half = LOCAL_HALF_M / config.pixelM;
      vb = { x: ev1[0] - half, y: ev1[1] - half, w: half * 2, h: half * 2 };
    }
    setAttr(miniSvg, 'viewBox', `${vb.x.toFixed(1)} ${vb.y.toFixed(1)} ${vb.w.toFixed(1)} ${vb.h.toFixed(1)}`);
    const k = vb.w / MINI.w; // map px per viewBox unit
    if (lastKey.miniScale !== k) {
      lastKey.miniScale = k;
      miniSvg.style.setProperty('--hud-k', String(k));
      for (const id of Object.keys(stopEls)) {
        const e = stopEls[id];
        setAttr(e.c, 'r', (13 * k).toFixed(2));
        setAttr(e.t, 'font-size', (15 * k).toFixed(2));
      }
      setAttr(mRoverDot, 'width', (12 * k).toFixed(2)); setAttr(mRoverDot, 'height', (12 * k).toFixed(2));
      crewEls.forEach((c) => setAttr(c.dot, 'r', (6 * k).toFixed(2)));
      setText(tMiniTitle, miniLocal ? `MAP · LOCAL ${LOCAL_HALF_M * 2} M` : 'MAP · OVERVIEW');
    }
    const dropped = sim.dropped || [], visited = sim.visited || [];
    if (lastKey.dropped !== dropped || lastKey.visited !== visited) {
      lastKey.dropped = dropped; lastKey.visited = visited;
      for (const id of Object.keys(stopEls)) {
        setAttr(stopEls[id].g, 'class', `hud-m-stop hud-m-stop-${data.stopsById[id].kind || 'other'}${dropped.includes(id) ? ' hud-m-dropped' : ''}${visited.includes(id) && id !== 'H' ? ' hud-m-visited' : ''}`);
      }
    }
    const nextId = sim.nextStop?.id;
    for (const id of Object.keys(stopEls)) stopEls[id].g.classList.toggle('hud-m-next', id === nextId);

    // Crew + rover
    const crew = sim.crew || [];
    crewEls.forEach((c, i) => {
      const cm = crew[i];
      show(c.g, !!cm);
      if (!cm) return;
      setAttr(c.g, 'transform', `translate(${cm.px[0].toFixed(2)} ${cm.px[1].toFixed(2)})`);
      // ring = dot halo + true-scale uncertainty, so growth is always visible
      const rr = 8 * k + (cm.uncertaintyM || 0) / config.pixelM;
      setAttr(c.ring, 'r', rr.toFixed(2));
    });
    const rv = sim.rover;
    show(mRover, !!rv);
    if (rv) {
      const half = 6 * k;
      setAttr(mRover, 'transform', `translate(${(rv.px[0] - half).toFixed(2)} ${(rv.px[1] - half).toFixed(2)})`);
      mRover.classList.toggle('hud-m-rover-off', !rv.linkOk);
    }
    const u1 = crew[0]?.uncertaintyM, u2 = crew[1]?.uncertaintyM;
    setFit(tCrewUnc, `EV1 ±${Number.isFinite(u1) ? u1.toFixed(1) : '?'} m · EV2 ±${Number.isFinite(u2) ? u2.toFixed(1) : '?'} m${linkOk ? '' : ' · DR'}`, 470);
    setAttr(tCrewUnc, 'class', `hud-t hud-sub ${linkOk ? '' : 'hud-lv-danger'}`);
    setFit(tRover, rv ? (rv.linkOk ? (sim.planned ? `Rover link OK · will scout ~${config.roverAheadM} m ahead` : `Rover link OK · scouting ${Math.round(rv.aheadM ?? config.roverAheadM)} m ahead`) : 'Rover link LOST · position by suit IMU + step count') : '', 470);

    // Route strip
    if (act) {
      const cum = cumFor(act.id, act.path || []);
      const total = cum.length ? cum[cum.length - 1] : 0;
      if (lastKey.stripId !== act) {
        lastKey.stripId = act;
        stripTicks.textContent = '';
        (act.stopMarks || []).forEach((m) => {
          const d = cum[clamp(m.pathIndex, 0, cum.length - 1)] ?? 0;
          const x = STRIP.x + (total > 0 ? (d / total) * STRIP.w : 0);
          const st0 = data.stopsById[m.id];
          const g = svg('g', { class: `hud-strip-stop hud-m-stop-${st0?.kind || 'other'}`, 'data-id': m.id }, stripTicks);
          svg('circle', { cx: x, cy: STRIP.y, r: 15 }, g);
          svg('text', { class: 'hud-t', x, y: STRIP.y + 6, 'text-anchor': 'middle' }, g, m.id);
          svg('text', { class: 'hud-t hud-tiny', x, y: STRIP.y + 38, 'text-anchor': 'middle' }, g, `T+${fmtMin(m.arriveMin)}`);
        });
        setFit(tStripLabel, `ROUTE · ${act.label || act.id}`.toUpperCase(), 740);
      }
      const along = sim.progress?.distanceAlongM ?? (sim.progress ? distanceAt(cum, sim.progress.i, sim.progress.frac) : 0);
      const fx = STRIP.x + (total > 0 ? clamp(along / total, 0, 1) * STRIP.w : 0);
      setAttr(stripDone, 'x2', fx.toFixed(1));
      setAttr(stripMe, 'transform', `translate(${fx.toFixed(1)} ${STRIP.y})`);
      const rem = sim.progress?.remainingM ?? Math.max(0, total - along);
      const ret = sim.schedule?.projectedReturnT;
      const behind = sim.schedule?.behindMin ?? 0;
      setFit(tStripRight, `${fmtDistM(rem)} left · back T+${fmtMin(ret)}${behind > 0.5 ? ` · ${Math.round(behind)} min behind plan` : ''}`, 640);
      setAttr(tStripRight, 'class', `hud-t hud-tiny ${behind > 0.5 ? 'hud-lv-warn' : ''}`);
      for (const g of stripTicks.children) {
        const id = g.getAttribute('data-id');
        g.classList.toggle('hud-m-dropped', dropped.includes(id));
      }
    }

    // Footnotes (assumptions)
    setFit(tFoot, `Assumptions: suit budget ${budget} min · reserve ${reserve} min · walk ${config.vFlatKmh} km/h on flat · slope soft ${config.slopeSoftDeg}° / no-go ${config.slopeHardDeg}° · turn-around at home+reserve+${config.turnaroundMarginMin} min · map up = north${data.fake ? ' · FAKE DATA' : ''}`, 1440);

    // Replan card
    const p = sim.pendingReplan;
    const pid = p ? p.id : null;
    if (lastKey.cardId !== pid) {
      lastKey.cardId = pid;
      card.hidden = !p;
      if (p) {
        card.dataset.trigger = p.trigger || 'schedule';
        cHead.textContent = p.trigger === 'storm' ? 'STORM · RETURN HOME' : p.trigger === 'air' ? 'TURN AROUND · AIR' : `REROUTE PROPOSED${p.atStopName ? ` AT ${p.atStopName.toUpperCase()}` : ''}`;
        cLabel.textContent = p.label || p.kind;
        const bits = [];
        if (p.behindMin > 0.5) bits.push(`${Math.round(p.behindMin)} min behind schedule`);
        if (p.savesMin > 0.5) bits.push(`saves ${Math.round(p.savesMin)} min`);
        if (Number.isFinite(p.minutes)) bits.push(`${fmtMinLong(p.minutes)} from here`);
        cMeta.textContent = bits.join(' · ');
        cWhy.textContent = '';
        (p.why || []).slice(0, 4).forEach((w) => html('li', null, cWhy, w));
        cSafe.textContent = p.safety?.text ? `${p.safety.withinBudget === false ? 'BEST AVAILABLE, NOT WITHIN BUDGET: ' : 'Safe: '}${p.safety.text}` : '';
        cSafe.classList.toggle('hud-lv-danger', p.safety?.withinBudget === false);
        const rej = (p.rejected || []).map((r) => `${r.label || r.kind} (+${Math.round(r.overByMin ?? 0)} min over)`);
        cRej.textContent = rej.length ? `Rejected: ${rej.join('; ')}` : '';
        cRej.hidden = !rej.length;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------
  const WATCH = ['sim', 'mode', 'plannedVariantId', 'faults', 'slowPace'];
  ctx.subscribe((st, prev, changed) => {
    if (st.mode !== 'hud') return;
    if (changed.has('mode')) { lastKey.miniScale = null; }
    if (WATCH.some((k) => changed.has(k))) render();
  });
  ctx.on('replan:proposed', () => {
    root.classList.remove('hud-flash');
    void root.offsetWidth; // restart animation
    root.classList.add('hud-flash');
  });
  render();

  return { render };
}
