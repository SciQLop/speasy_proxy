// Mouse, trackpad and touch gestures for one uPlot subplot. Plot area: wheel / pinch =
// zoom time at the cursor, horizontal swipe / Shift+wheel / drag = pan time, Shift+drag =
// mark an event (ctx.markRange), drag an event edge = resize it, Ctrl/⌘+drag inside an
// event = move it (live via ctx.setEventSpan, committed on release); on touch,
// one finger pans time and two fingers pinch-zoom it. Y-axis gutter: mouse gestures act
// on Y, double-click (double-tap) = reset Y; a finger there scrolls the subplot list.
// Time changes go through ctx.setView so every subplot stays on one shared window.
import { wheelIntent, zoomToward, panRange, pinchRange, yRangeFromPixels, rangeFromDrag, formatDuration } from './plot-core.js';

const ZOOM_SENSITIVITY = 0.0015;  // zoom amount per normalized wheel pixel
// simplify: tuned by reasoning, not on hardware; pinch deltas are ~10x smaller than
// wheel notches. Raise/lower if pinch feels sluggish/jumpy on a real trackpad.
const PINCH_ZOOM_SENSITIVITY = 0.01;
const MIN_ZOOM_SPAN_MS = 1;       // smallest time window (times are ms)

// ctx: { getView(), setView(view), setY(min, max), resetY(), markRange(start, end),
//        edgeAt(clientX) -> { index, side } | null, eventAt(clientX) -> index | null,
//        eventSpan(index) -> [t0, t1], setEventSpan(index, t0, t1), commitEvent(index) }
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
    if (e.button === 0 && inGutter(e)) dragY(u, ctx, e);
  });
  bindTimeDrag(u, ctx);

  // What a press would grab, said by the cursor.
  u.over.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || e.buttons !== 0) return;
    const movable = (e.ctrlKey || e.metaKey) && ctx.eventAt(e.clientX) !== null;
    u.over.style.cursor = movable ? 'move' : ctx.edgeAt(e.clientX) ? 'ew-resize' : '';
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

// Pointers down on the plot area, by id, in touch order. The gesture is re-anchored to
// the current view whenever a finger lands or lifts, so going from two fingers to one
// continues as a pan without a jump.
function bindTimeDrag(u, ctx) {
  const pointers = new Map();  // pointerId -> clientX
  let anchor = null;           // { view, fracs } at the last change of finger count
  const fracs = () => {
    const r = u.over.getBoundingClientRect();
    return [...pointers.values()].slice(0, 2).map((x) => (x - r.left) / (r.width || 1));
  };
  const reanchor = () => { anchor = { view: ctx.getView(), fracs: fracs() }; };

  u.over.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.pointerType === 'mouse' && eventGesture(u, ctx, e)) return;
    u.over.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, e.clientX);
    document.body.style.userSelect = 'none';
    reanchor();
  });
  u.over.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, e.clientX);
    const now = fracs();
    const { view, fracs: then } = anchor;
    const next = now.length === 2
      ? pinchRange(view, then, now, MIN_ZOOM_SPAN_MS)
      : panRange(view.start, view.end, then[0] - now[0]);
    if (next) ctx.setView(next);
  });
  const lift = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size === 0) document.body.style.userSelect = '';
    reanchor();
  };
  u.over.addEventListener('pointerup', lift);
  u.over.addEventListener('pointercancel', lift);
}

// Shift+drag: a band follows the mouse; on release the covered span becomes an event.
function markDrag(u, ctx, e) {
  const frac = plotFraction(u);
  const f0 = frac(e.clientX);
  const view = ctx.getView();
  const band = document.createElement('div');
  band.className = 'pv-marking';
  u.over.appendChild(band);
  const drawBand = (f1) => {
    const [a, b] = [f0, f1].map((f) => Math.max(0, Math.min(1, f))).sort((x, y) => x - y);
    band.style.left = (a * 100) + '%';
    band.style.width = ((b - a) * 100) + '%';
    band.textContent = formatDuration((b - a) * (view.end - view.start));
  };
  drawBand(f0);
  trackPointer(u, e, (m) => drawBand(frac(m.clientX)), (m, released) => {
    band.remove();
    const range = released ? rangeFromDrag(view, f0, frac(m.clientX)) : null;
    if (range) ctx.markRange(range.start, range.end);
  });
}

// Mouse gestures on events, before a plain drag pans: Shift = mark a new one, Ctrl/⌘
// inside one = move it, near an edge = resize it. True when one started.
function eventGesture(u, ctx, e) {
  if (e.shiftKey) { markDrag(u, ctx, e); return true; }
  const inside = (e.ctrlKey || e.metaKey) ? ctx.eventAt(e.clientX) : null;
  if (inside !== null) { spanDrag(u, ctx, e, inside, (t0, t1, dt) => [t0 + dt, t1 + dt]); return true; }
  const edge = ctx.edgeAt(e.clientX);
  if (edge) {
    spanDrag(u, ctx, e, edge.index, (t0, t1, dt) => edge.side === 'start' ? [t0 + dt, t1] : [t0, t1 + dt]);
    return true;
  }
  return false;
}

// The event follows the pointer live (reshape: its span from the time dragged), and is
// committed on release.
function spanDrag(u, ctx, e, index, reshape) {
  const frac = plotFraction(u);
  const view = ctx.getView();
  const timeAt = (x) => view.start + Math.max(0, Math.min(1, frac(x))) * (view.end - view.start);
  const [t0, t1] = ctx.eventSpan(index);
  const from = timeAt(e.clientX);
  trackPointer(u, e, (m) => ctx.setEventSpan(index, ...reshape(t0, t1, timeAt(m.clientX) - from)),
    () => ctx.commitEvent(index));
}

const plotFraction = (u) => {
  const rect = u.over.getBoundingClientRect();
  return (x) => (x - rect.left) / (rect.width || 1);
};

// Follows one pointer until it lifts: move(e) on each step, end(e, released) once.
// Pointer events throughout: preventDefault on pointerdown suppresses the mouse events.
function trackPointer(u, e, move, end) {
  e.preventDefault();
  const finish = (m) => {
    u.over.removeEventListener('pointermove', move);
    u.over.removeEventListener('pointerup', finish);
    u.over.removeEventListener('pointercancel', finish);
    end(m, m.type === 'pointerup');
  };
  u.over.setPointerCapture(e.pointerId);
  u.over.addEventListener('pointermove', move);
  u.over.addEventListener('pointerup', finish);
  u.over.addEventListener('pointercancel', finish);
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
