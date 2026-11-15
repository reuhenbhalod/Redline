// smooth.js — display-only smoothing for moving markers (crew, rover, the tablet's map camera).
// The sim moves the crew along a grid path with sharp 45° corners and publishes once per frame; drawing those
// positions directly looks jerky at corners. Each smoother is a time-based exponential filter: the drawn point
// glides toward the sim point (time constant `tauSec`) and snaps on big jumps (seek, reset, link snap-back) or
// while the sim is paused, so it never lags a stopped crew. The sim state itself is never changed.

export function createSmoother(tauSec = 0.07, snapPx = 40) {
  const st = new Map();
  return function smooth(key, px, { snap = false, now = performance.now() } = {}) {
    if (!px) { st.delete(key); return px; }
    const s = st.get(key);
    if (!s || snap || Math.hypot(px[0] - s.x, px[1] - s.y) > snapPx) {
      st.set(key, { x: px[0], y: px[1], t: now });
      return px;
    }
    const dt = Math.min(0.25, Math.max(0, (now - s.t) / 1000));
    const a = 1 - Math.exp(-dt / tauSec);
    s.x += (px[0] - s.x) * a;
    s.y += (px[1] - s.y) * a;
    s.t = now;
    return [s.x, s.y];
  };
}
