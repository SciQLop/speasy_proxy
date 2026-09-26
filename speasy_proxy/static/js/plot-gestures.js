// Mouse and trackpad gestures for one uPlot subplot. Plot area: wheel / pinch = zoom time
// at the cursor, horizontal swipe / Shift+wheel / drag = pan time. Y-axis gutter: the
// same gestures act on Y, plus double-click = reset Y. Time changes go through
// ctx.setView so every subplot stays on one shared window.
import { wheelIntent, zoomToward, panRange, yRangeFromPixels } from './plot-core.js';

const ZOOM_SENSITIVITY = 0.0015;  // zoom amount per normalized wheel pixel
// simplify: tuned by reasoning, not on hardware; pinch deltas are ~10x smaller than
// wheel notches. Raise/lower if pinch feels sluggish/jumpy on a real trackpad.
const PINCH_ZOOM_SENSITIVITY = 0.01;
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
    const intent = wheelIntent(e);
    if (onY) wheelY(u, ctx, e, intent);
    else wheelX(u, ctx, e, intent);
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

const zoomFactor = ({ kind, px }) =>
  px * (kind === 'pinch' ? PINCH_ZOOM_SENSITIVITY : ZOOM_SENSITIVITY);

// Pans move the content by the swipe's pixels, so it tracks the fingers like a drag.
function wheelX(u, ctx, e, intent) {
  const { start, end } = ctx.getView();
  const rect = u.over.getBoundingClientRect();
  if (intent.kind === 'pan') {
    ctx.setView(panRange(start, end, intent.px / (rect.width || 1)));
    return;
  }
  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const next = zoomToward(start, end, frac, zoomFactor(intent), MIN_ZOOM_SPAN_MS);
  if (next) ctx.setView(next);
}

function yScaleSnapshot(u) {
  const sc = u.scales.y;
  return { min: sc.min, max: sc.max, log: sc.distr === 3, heightPx: u.over.clientHeight || 1 };
}

function applyY(ctx, range) {
  if (range) ctx.setY(range.min, range.max);
}

function wheelY(u, ctx, e, intent) {
  const scale = yScaleSnapshot(u);
  const h = scale.heightPx;
  if (intent.kind === 'pan') {
    applyY(ctx, yRangeFromPixels(scale, h + intent.px, intent.px));
    return;
  }
  const cursorPx = e.clientY - u.over.getBoundingClientRect().top;
  const f = 1 + zoomFactor(intent);
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
