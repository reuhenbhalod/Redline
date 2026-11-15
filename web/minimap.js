// minimap.js — a small SVG map on the HiRISE basemap that follows a point (used by tablet.js).
// Coordinates are grid px (y down), so the SVG viewBox uses px directly (INTERFACES.md "Coordinates").
// Build once, then call the returned setters every frame; they skip work when nothing changed.

const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}

export function createMiniMap(container, { url, widthPx, heightPx, pixelM = 2, label = 'Map' }) {
  const svg = el('svg', { class: 'mm-svg', role: 'img', 'aria-label': label, preserveAspectRatio: 'xMidYMid slice' });
  el('rect', { x: -5000, y: -5000, width: 12000, height: 12000, class: 'mm-void' }, svg);
  const defs = el('defs', {}, svg);
  // Rust tint as an SVG filter: Safari ignores CSS `filter` on SVG <image>, so the map stayed grey there.
  // The HiRISE image is greyscale (r = g = b), so each row maps grey to a warm tone, like the planner's tint.
  const tintId = `mmt-${Math.random().toString(36).slice(2, 8)}`;
  const flt = el('filter', { id: tintId, 'color-interpolation-filters': 'sRGB' }, defs);
  el('feColorMatrix', { type: 'matrix', values: '0.30 0.30 0.30 0 -0.02  0.23 0.23 0.23 0 -0.02  0.165 0.165 0.165 0 -0.02  0 0 0 1 0' }, flt);
  el('image', { href: url, x: 0, y: 0, width: widthPx, height: heightPx, class: 'mm-base', preserveAspectRatio: 'none', filter: `url(#${tintId})` }, svg);
  const sp = 100 / pixelM;   // 100 m grid
  const pat = el('pattern', { id: `mmg-${Math.random().toString(36).slice(2, 8)}`, width: sp, height: sp, patternUnits: 'userSpaceOnUse' }, defs);
  el('path', { d: `M${sp} 0H0V${sp}`, class: 'mm-grid-line', 'vector-effect': 'non-scaling-stroke' }, pat);
  el('rect', { x: 0, y: 0, width: widthPx, height: heightPx, fill: `url(#${pat.id})` }, svg);
  const layer = el('g', {}, svg);
  container.appendChild(svg);

  const cache = new WeakMap();
  function ptsString(points) {
    if (!points || points.length === 0) return '';
    let s = cache.get(points);
    if (!s) { s = points.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' '); cache.set(points, s); }
    return s;
  }

  return {
    svg,
    /** A polyline; returns set(points|null). */
    line(cls) {
      // stroke widths in CSS are screen pixels at any zoom
      const node = el('polyline', { class: cls, fill: 'none', 'vector-effect': 'non-scaling-stroke' }, layer);
      let last;
      return (points) => {
        if (points === last) return;
        last = points;
        node.setAttribute('points', ptsString(points));
        node.style.display = points && points.length > 1 ? '' : 'none';
      };
    },
    /** A circle; returns set(px|null, radiusPx). */
    circle(cls) {
      const node = el('circle', { class: cls, r: 1, 'vector-effect': 'non-scaling-stroke' }, layer);
      return (px, r) => {
        if (!px) { node.style.display = 'none'; return; }
        node.style.display = '';
        node.setAttribute('cx', px[0].toFixed(1)); node.setAttribute('cy', px[1].toFixed(1));
        node.setAttribute('r', Math.max(0.5, r).toFixed(2));
      };
    },
    /** A diamond marker with a letter; size in screen-independent px of the grid. */
    diamond(cls, letter, size) {
      const g = el('g', { class: cls }, layer);
      el('rect', { x: -size / 2, y: -size / 2, width: size, height: size, transform: 'rotate(45)', 'vector-effect': 'non-scaling-stroke' }, g);
      const t = el('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': size * 0.85 }, g);
      t.textContent = letter;
      return (px) => {
        if (!px) { g.style.display = 'none'; return; }
        g.style.display = '';
        g.setAttribute('transform', `translate(${px[0].toFixed(1)} ${px[1].toFixed(1)})`);
      };
    },
    /** A square marker (the rover). */
    square(cls, size) {
      const node = el('rect', { class: cls, width: size, height: size, x: -size / 2, y: -size / 2, 'vector-effect': 'non-scaling-stroke' }, layer);
      return (px) => {
        if (!px) { node.style.display = 'none'; return; }
        node.style.display = '';
        node.setAttribute('transform', `translate(${px[0].toFixed(1)} ${px[1].toFixed(1)})`);
      };
    },
    /** Center the view on px with a square window `spanPx` wide (the SVG crops to its box). */
    view(center, spanPx) {
      const c = center || [widthPx / 2, heightPx / 2];
      const vb = `${(c[0] - spanPx / 2).toFixed(1)} ${(c[1] - spanPx / 2).toFixed(1)} ${spanPx} ${spanPx}`;
      if (svg.getAttribute('viewBox') !== vb) svg.setAttribute('viewBox', vb);
    },
  };
}
