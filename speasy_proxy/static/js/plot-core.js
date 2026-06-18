// Pure data-processing for the plot viewer. No DOM, no ECharts.

export function createSubplotData() {
  return {
    products: [],
    y_axis: { log: false },
    logScale: true,
    plotType: 'line',
    lastHeatmapImg: null,
    productData: {},
  };
}

export function createProductCache(path) {
  return {
    path,
    intervals: [],
    times: [],
    columns: {},
    columnNames: [],
    unit: '',
    yAxis: null,
    yAxisName: '',
    yAxisUnit: '',
    rows: [],
    displayType: '',
  };
}

export function subplotToConfig(sp) {
  return {
    products: sp.products.map((p) => ({ path: p.path, label: p.label })),
    y_axis: { log: sp.y_axis.log },
    log_z: sp.logScale,
  };
}

export function subplotFromConfig(plotDef) {
  const subplot = createSubplotData();
  subplot.y_axis.log = plotDef.y_axis?.log || false;
  if (plotDef.log_z !== undefined) subplot.logScale = plotDef.log_z;
  for (const prod of plotDef.products) {
    subplot.products.push({ path: prod.path, label: prod.label || prod.path });
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

export function mergeSortedRows(oldTimes, newTimes, oldRows, newRows) {
  const resultTimes = [];
  const resultRows = [];
  let i = 0, j = 0;
  while (i < oldTimes.length && j < newTimes.length) {
    if (oldTimes[i] < newTimes[j]) { resultTimes.push(oldTimes[i]); resultRows.push(oldRows[i]); i++; }
    else if (oldTimes[i] > newTimes[j]) { resultTimes.push(newTimes[j]); resultRows.push(newRows[j]); j++; }
    else { resultTimes.push(newTimes[j]); resultRows.push(newRows[j]); i++; j++; }
  }
  while (i < oldTimes.length) { resultTimes.push(oldTimes[i]); resultRows.push(oldRows[i]); i++; }
  while (j < newTimes.length) { resultTimes.push(newTimes[j]); resultRows.push(newRows[j]); j++; }
  return { times: resultTimes, rows: resultRows };
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
}

export function buildSeriesData(times, values) {
  const data = new Array(times.length);
  for (let i = 0; i < times.length; i++) data[i] = [times[i], values[i]];
  return data;
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

// Shift [start,end] by a fraction of its width (positive = later, negative = earlier).
export function panRange(start, end, fraction) {
  const shift = (end - start) * fraction;
  return { start: start + shift, end: end + shift };
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

// X-axis domain padded symmetrically around the loaded time span by padRatio of the span,
// giving the dataZoom room to pan beyond the loaded data without hitting a hard wall.
export function axisExtent(times, padRatio) {
  if (!times || times.length === 0) return { min: undefined, max: undefined };
  const lo = times[0];
  const hi = times[times.length - 1];
  const pad = (hi - lo) * padRatio;
  return { min: lo - pad, max: hi + pad };
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
