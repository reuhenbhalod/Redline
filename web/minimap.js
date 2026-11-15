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
  // Rust tint, baked ONCE into a copy of the basemap (see tintedBasemap). A live SVG/CSS filter re-rendered the
  // whole 2000x2000 image every frame while the map followed the crew, which made motion choppy (worst in Safari).
  const img = el('image', { x: 0, y: 0, width: widthPx, height: heightPx, class: 'mm-base', preserveAspectRatio: 'none' }, svg);
  tintedBasemap(url).then((u) => img.setAttribute('href', u)).catch(() => img.setAttribute('href', url));
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

// One tinted copy of the basemap per page, shared by every mini map. The HiRISE image is greyscale, so each
// grey level maps to a warm rust tone (the same look as the planner's CSS tint on the Leaflet basemap).
const tintCache = new Map();
export function tintedBasemap(url) {
  if (!tintCache.has(url)) {
    tintCache.set(url, new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = im.naturalWidth; c.height = im.naturalHeight;
          const g = c.getContext('2d');
          g.drawImage(im, 0, 0);
          const d = g.getImageData(0, 0, c.width, c.height);
          const p = d.data;
          for (let i = 0; i < p.length; i += 4) {
            const v = p[i];                                   // grey level (r = g = b)
            p[i] = Math.min(255, v * 0.9 - 5);
            p[i + 1] = Math.max(0, v * 0.69 - 5);
            p[i + 2] = Math.max(0, v * 0.495 - 5);
          }
          g.putImageData(d, 0, 0);
          c.toBlob((b) => (b ? resolve(URL.createObjectURL(b)) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.9);
        } catch (e) { reject(e); }
      };
      im.onerror = reject;
      im.src = url;
    }));
  }
  return tintCache.get(url);
}
