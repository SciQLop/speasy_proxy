// Pure data-processing for the plot viewer. No DOM, no chart library.

export function createSubplotData() {
  return {
    products: [],
    y_axis: { log: false },
    logScale: true,
    colormap: 'viridis',
    plotType: 'line',
    lastHeatmapImg: null,
    productData: {},
    // Whether Y/Z still follow the ISTP SCALETYP hint from the data (applyScaleHints
    // in plot.js) rather than an explicit Log Y / Log Z click.
    _yScaleAuto: true,
    _zScaleAuto: true,
  };
}

export function createProductCache(path) {
  return {
    path,
    intervals: [],
    fetchSpan: 0, // ms span the cached data was last fetched over (density bookkeeping)
    times: [],
    columns: {},
    columnNames: [],
    unit: '',
    title: '',       // ISTP FIELDNAM (or LABLAXIS): a readable product name
    description: '', // ISTP CATDESC, shown on hover
    yAxis: null,
    yAxisName: '',
    yAxisUnit: '',
    rows: [],
    displayType: '',
    valueRange: null, // { vMin, vMax } for heatmap color scale; set on data load
  };
}

// A plotted product's value for one paramSpecs entry, else the spec's default.
export function paramValue(prod, spec) {
  const value = spec.key === 'coordinate_system' ? prod.coordinateSystem : prod.productInputs?.[spec.key];
  return value ?? spec.default;
}

// A copy of the product with one parameter set; other template arguments are kept.
export function withParam(prod, key, value) {
  return key === 'coordinate_system'
    ? { ...prod, coordinateSystem: value }
    : { ...prod, productInputs: { ...prod.productInputs, [key]: value } };
}

// Scales are saved only once chosen explicitly; one still following the ISTP hint is
// left out so a reload re-reads the hint (see subplotFromConfig).
export function subplotToConfig(sp) {
  return {
    products: sp.products.map((p) => ({
      path: p.path, label: p.label,
      coordinate_system: p.coordinateSystem,
      product_inputs: p.productInputs,
    })),
    ...(sp._yScaleAuto ? {} : { y_axis: { log: sp.y_axis.log } }),
    ...(sp._zScaleAuto ? {} : { log_z: sp.logScale }),
    ...(sp.colormap === 'viridis' ? {} : { colormap: sp.colormap }),
    ...(sp._zOverride ? { z_range: [sp._zOverride.vMin, sp._zOverride.vMax] } : {}),
  };
}

export function subplotFromConfig(plotDef) {
  const subplot = createSubplotData();
  subplot.y_axis.log = plotDef.y_axis?.log || false;
  // A shared/loaded config is a deliberate choice, not a default — but only when it
  // actually specified one; an old/malformed config with no y_axis is still a fresh state.
  if (plotDef.y_axis?.log !== undefined) subplot._yScaleAuto = false;
  if (plotDef.colormap) subplot.colormap = plotDef.colormap;
  if (Array.isArray(plotDef.z_range) && plotDef.z_range.length === 2) {
    subplot._zOverride = { vMin: plotDef.z_range[0], vMax: plotDef.z_range[1] };
  }
  if (plotDef.log_z !== undefined) {
    subplot.logScale = plotDef.log_z;
    subplot._zScaleAuto = false;
  }
  for (const prod of plotDef.products) {
    subplot.products.push({
      path: prod.path, label: prod.label || prod.path,
      coordinateSystem: prod.coordinate_system,
      productInputs: prod.product_inputs,
    });
    subplot.productData[prod.path] = createProductCache(prod.path);
  }
  return subplot;
}

export function detectPlotType(json) {
  const meta = json.values.meta || {};
  const displayType = (meta.DISPLAY_TYPE || '').toLowerCase();
  const numCols = json.values.values.length > 0 ? json.values.values[0].length : 0;
  if (displayType === 'spectrogram' || (numCols > 10 && json.axes.length >= 2)) return 'heatmap';
  return 'line';
}

// Plot type of an already-loaded cache (detectPlotType needs the raw response, which
// is gone by the time a product is removed from a subplot). displayType holds the raw
// DISPLAY_TYPE, so it must be compared, not just tested for truthiness — 'time_series'
// is truthy and would turn every line product into an empty heatmap.
export function plotTypeFromCache(cache) {
  if (!cache) return 'line';
  if ((cache.displayType || '').toLowerCase() === 'spectrogram') return 'heatmap';
  return cache.yAxis && cache.rows && cache.rows.length > 0 ? 'heatmap' : 'line';
}

// Min/max of all positive values in a spectrogram's rows, or null when there are none
// (an all-gap slice). Returning null rather than a sentinel keeps callers from folding
// a fake floor into a real range.
export function computeValueRange(rows) {
  let vMin = Infinity, vMax = -Infinity;
  for (const row of rows || []) {
    if (!row) continue;
    for (const val of row) {
      if (val != null && !isNaN(val) && val > 0) {
        if (val < vMin) vMin = val;
        if (val > vMax) vMax = val;
      }
    }
  }
  return vMin === Infinity ? null : { vMin, vMax };
}

// Value range covering the cache after a freshly fetched slice was merged in.
// A null cachedRange means it was invalidated (trim/evict) while retained rows stayed,
// so the whole cache must be rescanned; otherwise only the new slice is scanned and
// unioned in, keeping pan/zoom refetches off an O(total) rescan.
export function mergeValueRange(cachedRange, cacheRows, newValues) {
  if (!cachedRange) return computeValueRange(cacheRows);
  const newRange = computeValueRange(newValues);
  if (!newRange) return cachedRange;
  return {
    vMin: Math.min(cachedRange.vMin, newRange.vMin),
    vMax: Math.max(cachedRange.vMax, newRange.vMax),
  };
}

// Color scale actually handed to the renderer: a missing or zero-width range has no
// usable log10 span, so substitute a decade.
// The colour range a spectrogram is drawn with: the one set by hand (auto Z off, or a
// colour bar limit typed in), else the data's.
export function zRangeOf(subplot, cache) {
  return subplot._zOverride || renderableRange(cache?.valueRange || computeValueRange(cache?.rows || []));
}

export function renderableRange(range) {
  if (!range) return { vMin: 1e-30, vMax: 1 };
  return range.vMin === range.vMax ? { vMin: range.vMin, vMax: range.vMin * 10 } : range;
}

// A fetch returns every row of [startMs, stopMs], so it replaces the cached rows there
// rather than interleaving with them: two resampled fetches sit on different time grids,
// and interleaving them gives uneven steps that the image draws as dark stripes.
export function spliceRows(oldTimes, oldRows, newTimes, newRows, startMs, stopMs) {
  const before = oldTimes.findIndex((t) => t >= startMs);
  const lo = before === -1 ? oldTimes.length : before;
  const after = oldTimes.findIndex((t) => t > stopMs);
  const hi = after === -1 ? oldTimes.length : after;
  return {
    times: oldTimes.slice(0, lo).concat(newTimes, oldTimes.slice(hi)),
    rows: oldRows.slice(0, lo).concat(newRows, oldRows.slice(hi)),
  };
}

export function mergeSorted(oldTimes, newTimes, oldColumns, newValues, columnNames) {
  const resultTimes = [];
  const resultColumns = {};
  for (const cn of columnNames) resultColumns[cn] = [];
  let i = 0, j = 0;
  while (i < oldTimes.length && j < newTimes.length) {
    if (oldTimes[i] < newTimes[j]) {
      resultTimes.push(oldTimes[i]);
      for (const cn of columnNames) resultColumns[cn].push(oldColumns[cn][i]);
      i++;
    } else if (oldTimes[i] > newTimes[j]) {
      resultTimes.push(newTimes[j]);
      for (let c = 0; c < columnNames.length; c++) resultColumns[columnNames[c]].push(newValues[j][c]);
      j++;
    } else {
      resultTimes.push(newTimes[j]);
      for (let c = 0; c < columnNames.length; c++) resultColumns[columnNames[c]].push(newValues[j][c]);
      i++; j++;
    }
  }
  while (i < oldTimes.length) {
    resultTimes.push(oldTimes[i]);
    for (const cn of columnNames) resultColumns[cn].push(oldColumns[cn][i]);
    i++;
  }
  while (j < newTimes.length) {
    resultTimes.push(newTimes[j]);
    for (let c = 0; c < columnNames.length; c++) resultColumns[columnNames[c]].push(newValues[j][c]);
    j++;
  }
  return { times: resultTimes, columns: resultColumns };
}

export function mergeIntervals(intervals) {
  if (intervals.length === 0) return [];
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [intervals[0].slice()];
  for (let i = 1; i < intervals.length; i++) {
    const last = merged[merged.length - 1];
    if (intervals[i][0] <= last[1]) last[1] = Math.max(last[1], intervals[i][1]);
    else merged.push(intervals[i].slice());
  }
  return merged;
}

// True when the (unsorted, possibly gappy) interval list fully covers [startMs, stopMs]:
// merging the intervals must yield a single span containing the whole range. A gap
// anywhere inside the range means "not covered" — callers must refetch rather than
// draw a line across missing data.
export function isCovered(intervals, startMs, stopMs) {
  if (!intervals || intervals.length === 0) return false;
  return mergeIntervals(intervals.map((iv) => iv.slice()))
    .some((iv) => iv[0] <= startMs && iv[1] >= stopMs);
}

// True when data fetched over fetchSpanMs is still dense enough for a request over
// reqSpanMs: max_points is constant, so the server spreads it across the fetched span —
// once the requested span shrinks below `ratio` × the fetched span, a refetch would
// meaningfully increase resolution (zoom-in) and the caller should not skip it.
export function resolutionSufficient(fetchSpanMs, reqSpanMs, ratio = 0.5) {
  return fetchSpanMs > 0 && reqSpanMs >= fetchSpanMs * ratio;
}

// True when any interval in the list overlaps [startMs, stopMs] (inclusive bounds).
// Used to decide whether a refetch can merge into a cache or must reset it — merging
// across a disjoint gap would draw a line over missing data.
export function rangesOverlap(intervals, startMs, stopMs) {
  return (intervals || []).some((iv) => iv[0] <= stopMs && iv[1] >= startMs);
}

// Drop cached points outside [startMs, stopMs] and clip intervals to the window.
// Merged caches otherwise grow without bound and every re-render re-zips/re-parses
// all of them — the render path must stay at ~a few fetch payloads, not the whole
// session's accumulation.
export function trimCacheWindow(cache, startMs, stopMs) {
  const t = cache.times;
  if (!t || t.length === 0) return;
  let a = 0;
  let b = t.length;
  while (a < b) { const m = (a + b) >> 1; if (t[m] < startMs) a = m + 1; else b = m; }
  const lo = a;
  b = t.length;
  while (a < b) { const m = (a + b) >> 1; if (t[m] <= stopMs) a = m + 1; else b = m; }
  const hi = a;
  if (lo === 0 && hi === t.length) return;  // nothing to trim
  cache.times = t.slice(lo, hi);
  for (const cn of cache.columnNames || []) {
    if (cache.columns[cn]) cache.columns[cn] = cache.columns[cn].slice(lo, hi);
  }
  if (cache.rows && cache.rows.length) cache.rows = cache.rows.slice(lo, hi);
  cache.intervals = (cache.intervals || [])
    .map((iv) => [Math.max(iv[0], startMs), Math.min(iv[1], stopMs)])
    .filter((iv) => iv[0] <= iv[1]);
  // Trimmed data may have a different value distribution; let the next render
  // recompute the color scale from the visible rows instead of using the
  // stale full-cache range.
  cache.valueRange = null;
}

export function evictProductCache(cache, maxPoints) {
  if (cache.times.length <= maxPoints) return;
  const excess = cache.times.length - maxPoints;
  cache.times = cache.times.slice(excess);
  if (cache.rows.length > 0) {
    cache.rows = cache.rows.slice(excess);
  } else {
    for (const cn of cache.columnNames) cache.columns[cn] = cache.columns[cn].slice(excess);
  }
  if (cache.times.length > 0) {
    const newStart = cache.times[0];
    cache.intervals = cache.intervals
      .map((iv) => [Math.max(iv[0], newStart), iv[1]])
      .filter((iv) => iv[1] > iv[0]);
  }
  cache.valueRange = null;
}

// Serialize a line-product cache's [startMs, stopMs] slice to CSV: ISO timestamps in the
// first column, one column per component, header carries path + column name + unit.
// Null/undefined values become empty cells. Heatmap caches (no columnNames) yield just
// the header and are skipped by callers.
export function cacheToCsv(cache, startMs, stopMs) {
  const quote = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  const header = ['time'];
  for (const cn of cache.columnNames) {
    header.push(quote(cache.path + ' ' + cn + (cache.unit ? ' (' + cache.unit + ')' : '')));
  }
  const lines = [header.join(',')];
  for (let i = 0; i < cache.times.length; i++) {
    const t = cache.times[i];
    if (t < startMs || t > stopMs) continue;
    const row = [new Date(t).toISOString()];
    for (const cn of cache.columnNames) {
      const v = cache.columns[cn][i];
      row.push(v == null ? '' : String(v));
    }
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

// ===== Pan / zoom math (pure, DOM-free) =====

const WHEEL_LINE_PX = 16;   // a "line" of wheel delta ≈ 16px
const WHEEL_PAGE_PX = 800;  // a "page" of wheel delta ≈ 800px
const WHEEL_MAX_PX = 120;   // clamp so one big notch can't overshoot

// Normalize a wheel event's deltaY to pixels regardless of device/deltaMode,
// so mouse notches and trackpad swipes feel consistent. Clamped to ±WHEEL_MAX_PX.
export function normalizeWheelDelta(deltaY, deltaMode) {
  let px = deltaY;
  if (deltaMode === 1) px = deltaY * WHEEL_LINE_PX;
  else if (deltaMode === 2) px = deltaY * WHEEL_PAGE_PX;
  return Math.max(-WHEEL_MAX_PX, Math.min(WHEEL_MAX_PX, px));
}

// What a wheel event means: 'pinch' (trackpad pinch arrives as Ctrl+wheel), 'pan'
// (Shift+wheel or a mostly-horizontal swipe) or 'zoom'. px is the normalized delta.
// Shift reads X too because Chrome already swaps Shift+wheel onto deltaX.
export function wheelIntent({ deltaX, deltaY, deltaMode, shiftKey, ctrlKey }) {
  const px = (d) => normalizeWheelDelta(d, deltaMode);
  if (ctrlKey) return { kind: 'pinch', px: px(deltaY) };
  if (shiftKey) return { kind: 'pan', px: px(deltaY || deltaX) };
  if (Math.abs(deltaX) > Math.abs(deltaY)) return { kind: 'pan', px: px(deltaX) };
  return { kind: 'zoom', px: px(deltaY) };
}

// Zoom [start,end] around the time under the cursor (cursorFrac in [0,1] across the range).
// factor < 0 zooms in (shrinks), factor > 0 zooms out (widens). The cursor time stays put.
export function zoomRange(start, end, cursorFrac, factor) {
  const center = start + cursorFrac * (end - start);
  return {
    start: center - (center - start) * (1 + factor),
    end: center + (end - center) * (1 + factor),
  };
}

// Zoom [start,end] around the cursor, refusing to shrink below minSpan (in the same units
// as start/end — milliseconds for the time axis). Returns the new range, or null when the
// requested zoom would cross the floor (so the caller leaves the view untouched).
export function zoomToward(start, end, cursorFrac, factor, minSpan) {
  const next = zoomRange(start, end, cursorFrac, factor);
  if (next.end - next.start < minSpan) return null;
  return next;
}

const MIN_DRAG_FRAC = 0.005;  // a smaller Shift+drag is a click, not an event

// The time span a drag covered, from its start and end as fractions of the plot width
// (either direction, clamped to the plot), or null for a click.
export function rangeFromDrag(view, frac0, frac1) {
  const [a, b] = [frac0, frac1].map((f) => Math.max(0, Math.min(1, f))).sort((x, y) => x - y);
  if (b - a < MIN_DRAG_FRAC) return null;
  const span = view.end - view.start;
  return { start: view.start + a * span, end: view.start + b * span };
}

// Shift [start,end] by a fraction of its width (positive = later, negative = earlier).
export function panRange(start, end, fraction) {
  const shift = (end - start) * fraction;
  return { start: start + shift, end: end + shift };
}

// Two-finger pinch: the times under the fingers at touch-down ([f1, f2], fractions of the
// plot width across view0) stay under the fingers at their new positions [g1, g2]. One
// formula covers zoom and pan. Null when the fingers meet or cross, or below minSpan.
export function pinchRange(view0, [f1, f2], [g1, g2], minSpan) {
  const span0 = view0.end - view0.start;
  const t1 = view0.start + f1 * span0;
  const t2 = view0.start + f2 * span0;
  const span = (t2 - t1) / (g2 - g1);
  if (!Number.isFinite(span) || span < minSpan) return null;
  const start = t1 - g1 * span;
  return { start, end: start + span };
}

// Fallback for a spectrogram axis with no SCALETYP hint: true (log) when its values are
// all positive and span more than a decade, else null (no opinion). Energy tables may be
// 2-D (one row per time).
export function logHintFromRange(values) {
  const finite = (values || []).flat().filter(Number.isFinite);
  if (finite.length === 0) return null;
  const lo = Math.min(...finite), hi = Math.max(...finite);
  return lo > 0 && hi / lo > 10 ? true : null;
}

const DEFAULT_PLOT_WIDTH_PX = 2000; // fallback when the chart hasn't been laid out yet
const MIN_RESAMPLE_POINTS = 2000;   // floor so a tiny/unsized plot still fetches usable detail

// Server-side resample target (max_points) sized so the *visible* window lands near
// `pointsPerPixel` points per horizontal pixel. We fetch visible + bufferRatio on each
// side and the server spreads its budget across the whole fetched span, so scale the
// target by the fetch-span factor (1 + 2*bufferRatio) to keep the visible slice dense.
export function resampleTarget(widthPx, pointsPerPixel, bufferRatio) {
  const w = widthPx > 0 ? widthPx : DEFAULT_PLOT_WIDTH_PX;
  const fetchSpanFactor = 1 + 2 * bufferRatio;
  return Math.max(MIN_RESAMPLE_POINTS, Math.ceil(w * pointsPerPixel * fetchSpanFactor));
}

// Index of the sample closest to t in a sorted time array, or -1 when empty.
export function nearestIndex(times, t) {
  const n = times ? times.length : 0;
  if (n === 0) return -1;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1; else hi = mid;
  }
  return lo > 0 && t - times[lo - 1] <= times[lo] - t ? lo - 1 : lo;
}

// A line cache as a uPlot table: [times, ...one array per column]. NaN (the CDF
// codec's fill value) becomes null, which uPlot draws as a gap.
export function lineTable(cache) {
  return [cache.times, ...cache.columnNames.map((cn) =>
    cache.columns[cn].map((v) => (v == null || Number.isNaN(v) ? null : v)))];
}

// Y range shown between two pixel rows (0 = top of the plot area), mapped through a
// snapshot of the scale ({ min, max, log, heightPx }). Working in pixels makes pan/zoom
// gestures behave the same on linear and log axes. Null when the result is degenerate.
export function yRangeFromPixels(scale, bottomPx, topPx) {
  const f = scale.log ? Math.log10 : (v) => v;
  const inv = scale.log ? (v) => 10 ** v : (v) => v;
  const lo = f(scale.min), hi = f(scale.max);
  const at = (px) => inv(lo + ((scale.heightPx - px) / scale.heightPx) * (hi - lo));
  const min = at(bottomPx), max = at(topPx);
  return Number.isFinite(min) && Number.isFinite(max) && max > min ? { min, max } : null;
}

// Metadata text from CDF attributes: fixed-width strings come NUL-padded, and a
// "unitless" AMDA product sends UNITS as a lone NUL.
export function cleanText(s) {
  return String(s ?? '').replace(/\0/g, '').trim();
}

// Search-result paths as text. Leading segments every result shares tell them apart not
// at all, and a narrow sidebar cuts paths off at the end: drop them ("… / ") so the
// segments that differ stay visible. The last segment is always kept.
export function distinctCrumbs(crumbs) {
  let shared = 0;
  if (crumbs.length > 1) {
    while (crumbs.every((c) => shared < c.length - 1 && c[shared] === crumbs[0][shared])) shared++;
  }
  return crumbs.map((c) => (shared > 0 ? '… / ' : '') + c.slice(shared).join(' / '));
}

// Where a product dropped at offsetY on a subplot of heightPx goes: a new subplot
// 'before'/'after' it when near an edge, else 'into' it. Edge bands are 24 px, at most a
// quarter of the height each, so short plots keep a middle band.
export function dropZone(offsetY, heightPx) {
  const band = Math.min(24, heightPx / 4);
  if (offsetY < band) return 'before';
  if (offsetY > heightPx - band) return 'after';
  return 'into';
}

// A label set on purpose (preset, shared config) wins; a label that is just the path
// (what adding from the tree stores) gives way to the ISTP name once data has arrived.
export function productTitle(product, cache) {
  if (product.label && product.label !== product.path) return product.label;
  return cache?.title || product.path.split('/').pop();
}

// Axis tick label that fits a fixed-width gutter: 6 significant digits, exponent form
// outside [1e-3, 1e5). uPlot passes null for log-axis ticks it leaves unlabeled.
export function fmtTick(v) {
  if (v == null) return '';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a < 1e-3 || a >= 1e5) return v.toExponential(2).replace(/\.?0+e/, 'e').replace('e+', 'e');
  return String(Number(v.toPrecision(6)));
}

// A signature of everything that affects the chart's *structure* (component layout), so a
// data-only update can be merged in place instead of a full teardown+rebuild. Changes when
// the subplot count, plot type, log flags, products, or per-product column count change.
export function structureKey(plots) {
  return plots
    .map((sp) => {
      const prods = sp.products
        .map((p) => p.path + '#' + (sp.productData?.[p.path]?.columnNames?.length || 0))
        .join('+');
      return [sp.plotType, sp.y_axis.log ? 1 : 0, sp.logScale ? 1 : 0, prods].join(':');
    })
    .join('|');
}

export function configToBase64(config) {
  return btoa(JSON.stringify(config)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64ToConfig(b64) {
  return JSON.parse(atob(b64.replace(/-/g, '+').replace(/_/g, '/')));
}

// --- time window -----------------------------------------------------------------

// The window after one end is edited ('start' or 'stop'). A new start moves the whole
// window, keeping its width: applying [new start, old stop] fetched years of data while
// the user was still on their way to the stop field. A new stop sets the width; one
// before the start moves the window instead of making it empty.
export function editedRange(end, valueMs, startMs, stopMs) {
  const width = stopMs - startMs;
  if (end === 'start') return [valueMs, valueMs + width];
  return valueMs > startMs ? [startMs, valueMs] : [valueMs - width, valueMs];
}

const SPAN_UNITS = [['d', 86400000], ['h', 3600000], ['m', 60000], ['s', 1000]];

// A window length for people: its two largest non-zero units ("2d 8h", "45s").
export function formatSpan(ms) {
  let rest = Math.round(ms / 1000) * 1000;
  const parts = [];
  for (const [unit, size] of SPAN_UNITS) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n > 0 || parts.length > 0) parts.push([n, unit]);
  }
  return parts.slice(0, 2).filter(([n]) => n > 0).map(([n, unit]) => n + unit).join(' ') || '0s';
}

// Where a window sits against a product's coverage ({ start, stop } in ms): null when
// they overlap, else the side it is on and the window of the same length at the
// coverage's nearest edge.
export function outOfCoverage(coverage, startMs, stopMs) {
  if (!coverage) return null;
  const width = stopMs - startMs;
  if (startMs >= coverage.stop) return { side: 'after', range: [coverage.stop - width, coverage.stop] };
  if (stopMs <= coverage.start) return { side: 'before', range: [coverage.start, coverage.start + width] };
  return null;
}
