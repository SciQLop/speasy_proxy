// Mouse gestures for one uPlot subplot. Plot area: wheel = zoom time at the cursor,
// Shift+wheel = pan time, drag = pan time. Y-axis gutter: wheel = zoom Y, Shift+wheel
// = pan Y, drag = pan Y, double-click = reset Y. Time changes go through ctx.setView so
// every subplot stays on one shared window.
import { normalizeWheelDelta, zoomToward, panRange, yRangeFromPixels } from './plot-core.js';

const ZOOM_SENSITIVITY = 0.0015;  // zoom amount per normalized wheel pixel
const PAN_SENSITIVITY = 0.0015;   // pan amount (fraction of view) per normalized wheel pixel
const MIN_ZOOM_SPAN_MS = 1;       // smallest time window (times are ms)

// ctx: { getView(), setView(view), setY(min, max), resetY() }
export function bindGestures(u, ctx) {
  // The Y gutter is the strip left of the plot area, at the plot area's height (not the
  // title or legend rows above/below it).
  const inGutter = (e) => {
    const r = u.over.getBoundingClientRect();
    return e.clientX < r.left && e.clientY >= r.top && e.clientY <= r.bottom;
  };

  // Wheel anywhere else (title, legend) is left alone so the subplot list can scroll.
  u.root.addEventListener('wheel', (e) => {
    const onY = inGutter(e);
    if (!onY && !u.over.contains(e.target)) return;
    e.preventDefault();
    const delta = normalizeWheelDelta(e.deltaY, e.deltaMode);
    if (onY) wheelY(u, ctx, e, delta);
    else wheelX(u, ctx, e, delta);
  }, { passive: false });

  u.root.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (inGutter(e)) dragY(u, ctx, e);
    else if (u.over.contains(e.target)) dragX(u, ctx, e);
  });

  u.root.addEventListener('dblclick', (e) => {
    if (!inGutter(e)) return;
    e.preventDefault();
    ctx.resetY();
  });
}

function wheelX(u, ctx, e, delta) {
  const { start, end } = ctx.getView();
  if (e.shiftKey) {
    ctx.setView(panRange(start, end, PAN_SENSITIVITY * delta));
    return;
  }
  const rect = u.over.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const next = zoomToward(start, end, frac, delta * ZOOM_SENSITIVITY, MIN_ZOOM_SPAN_MS);
  if (next) ctx.setView(next);
}

function yScaleSnapshot(u) {
  const sc = u.scales.y;
  return { min: sc.min, max: sc.max, log: sc.distr === 3, heightPx: u.over.clientHeight || 1 };
}

function applyY(ctx, range) {
  if (range) ctx.setY(range.min, range.max);
}

function wheelY(u, ctx, e, delta) {
  const scale = yScaleSnapshot(u);
  const h = scale.heightPx;
  if (e.shiftKey) {
    const shift = h * PAN_SENSITIVITY * delta;
    applyY(ctx, yRangeFromPixels(scale, h + shift, shift));
    return;
  }
  const cursorPx = e.clientY - u.over.getBoundingClientRect().top;
  const f = 1 + delta * ZOOM_SENSITIVITY;
  applyY(ctx, yRangeFromPixels(scale, cursorPx + (h - cursorPx) * f, cursorPx - cursorPx * f));
}

function dragX(u, ctx, e) {
  const start = ctx.getView();
  const x0 = e.clientX;
  const width = u.over.clientWidth || 1;
  onDrag((m) => {
    const shift = ((m.clientX - x0) / width) * (start.end - start.start);
    ctx.setView({ start: start.start - shift, end: start.end - shift });
  });
}

// Anchored to the scale at mousedown: the drag keeps changing the live scale, so reading
// it on every move would compound the shift.
function dragY(u, ctx, e) {
  e.preventDefault();
  const scale = yScaleSnapshot(u);
  const y0 = e.clientY;
  onDrag((m) => {
    const dy = m.clientY - y0;
    applyY(ctx, yRangeFromPixels(scale, scale.heightPx - dy, -dy));
  });
}

function onDrag(move) {
  document.body.style.userSelect = 'none';
  const up = () => {
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}
