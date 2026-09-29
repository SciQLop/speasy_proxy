// Spectrogram rendering: colormaps + offscreen-canvas image.

// Eleven evenly spaced stops per map, sampled from matplotlib (linear interpolation
// between them is visually indistinguishable from the full 256-entry tables).
export const COLORMAPS = {
  viridis: [[68, 1, 84], [72, 36, 117], [65, 68, 135], [53, 95, 141], [42, 120, 142], [33, 145, 140],
    [34, 168, 132], [68, 191, 112], [122, 209, 81], [189, 223, 38], [253, 231, 37]],
  plasma: [[13, 8, 135], [65, 4, 157], [106, 0, 168], [143, 13, 164], [177, 42, 144], [204, 71, 120],
    [225, 100, 98], [242, 132, 75], [252, 166, 54], [252, 206, 37], [240, 249, 33]],
  inferno: [[0, 0, 4], [22, 11, 57], [66, 10, 104], [106, 23, 110], [147, 38, 103], [188, 55, 84],
    [221, 81, 58], [243, 120, 25], [252, 165, 10], [246, 215, 70], [252, 255, 164]],
  magma: [[0, 0, 4], [20, 14, 54], [59, 15, 112], [100, 26, 128], [140, 41, 129], [183, 55, 121],
    [222, 73, 104], [247, 112, 92], [254, 159, 109], [254, 207, 146], [252, 253, 191]],
  cividis: [[0, 34, 78], [8, 51, 112], [53, 69, 108], [79, 87, 108], [102, 105, 112], [125, 124, 120],
    [148, 142, 119], [174, 163, 113], [200, 184, 102], [229, 207, 82], [254, 232, 56]],
  turbo: [[48, 18, 59], [69, 89, 203], [62, 155, 254], [25, 213, 205], [70, 248, 132], [164, 252, 60],
    [225, 221, 55], [254, 164, 49], [240, 91, 18], [195, 37, 3], [122, 4, 3]],
  jet: [[0, 0, 128], [0, 0, 241], [0, 76, 255], [0, 176, 255], [41, 255, 206], [125, 255, 122],
    [206, 255, 41], [255, 196, 0], [255, 104, 0], [241, 8, 0], [128, 0, 0]],
};

export const DEFAULT_COLORMAP = 'viridis';

function buildLut(stops) {
  const lut = new Uint8Array(256 * 3);
  const last = stops.length - 1;
  for (let i = 0; i < 256; i++) {
    const pos = (i / 255) * last;
    const j = Math.min(Math.floor(pos), last - 1);
    const f = pos - j;
    for (let ch = 0; ch < 3; ch++) {
      lut[i * 3 + ch] = Math.round(stops[j][ch] + f * (stops[j + 1][ch] - stops[j][ch]));
    }
  }
  return lut;
}

const LUTS = Object.fromEntries(Object.entries(COLORMAPS).map(([name, stops]) => [name, buildLut(stops)]));

// 256 RGB triplets for a colormap name; an unknown name (old or hand-edited config)
// falls back to the default.
export const colormapLut = (name) => LUTS[name] || LUTS[DEFAULT_COLORMAP];

// Energy tables often come high-to-low (AMDA/CSA ion spectrometers). Every consumer
// (edges, image rows, cursor lookup) assumes low-to-high, so flip once at ingestion.
export function ascendingSpectrogram(yAxis, rows) {
  const flat = Array.isArray(yAxis?.[0]) ? yAxis[0] : (yAxis || []);
  if (flat.length < 2 || flat[0] <= flat[flat.length - 1]) return { yAxis, rows };
  const reversed = (a) => (a ? a.slice().reverse() : a);
  return {
    yAxis: Array.isArray(yAxis[0]) ? yAxis.map(reversed) : reversed(yAxis),
    rows: rows.map(reversed),
  };
}

export function computeYEdges(yBinsFlat) {
  const yEdges = new Array(yBinsFlat.length + 1);
  for (let i = 1; i < yBinsFlat.length; i++) yEdges[i] = (yBinsFlat[i - 1] + yBinsFlat[i]) / 2;
  yEdges[0] = yBinsFlat[0] - (yBinsFlat.length > 1 ? (yBinsFlat[1] - yBinsFlat[0]) / 2 : 0.5);
  yEdges[yBinsFlat.length] = yBinsFlat[yBinsFlat.length - 1] +
    (yBinsFlat.length > 1 ? (yBinsFlat[yBinsFlat.length - 1] - yBinsFlat[yBinsFlat.length - 2]) / 2 : 0.5);
  return yEdges;
}

// The lowest y a log axis can show for these bins; null when every edge is <= 0.
export function lowestPositiveEdge(edges) {
  const positive = edges.filter((e) => e > 0);
  return positive.length ? Math.min(...positive) : null;
}

// One destination rectangle per bin, taken from its own edges, so each bin lands where
// the y axis puts it whatever the bin spacing (linear, log) and the axis scale.
// toPos maps a y value to canvas px. floor (log axes) clamps edges <= 0, which have no
// position there. Rounding to whole pixels makes neighbours share a boundary: no seams.
export function binRowRects(edges, toPos, floor = null) {
  const nY = edges.length - 1;
  const pos = (v) => Math.round(toPos(floor != null ? Math.max(v, floor) : v));
  return Array.from({ length: nY }, (_, y) => {
    const a = pos(edges[y]), b = pos(edges[y + 1]);
    return { srcRow: nY - 1 - y, top: Math.min(a, b), height: Math.abs(a - b) };
  });
}

// Value lookup for cursor readout: nearest time column, then the y bin whose edges
// (from computeYEdges) contain yValue. Returns the cell value, or null when the
// position is outside the data or the cell is missing/NaN.
export function spectrogramValueAt(times, rows, yBinsFlat, timeMs, yValue) {
  if (!times || times.length === 0 || !rows || rows.length === 0) return null;
  if (!yBinsFlat || yBinsFlat.length === 0) return null;
  if (typeof timeMs !== 'number' || typeof yValue !== 'number' || isNaN(timeMs) || isNaN(yValue)) return null;

  // Nearest time index (times are sorted ascending).
  let lo = 0, hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < timeMs) lo = mid + 1; else hi = mid;
  }
  let ti = lo;
  if (lo > 0 && timeMs - times[lo - 1] <= times[lo] - timeMs) ti = lo - 1;

  // Y bin containing yValue.
  const edges = computeYEdges(yBinsFlat);
  if (yValue < edges[0] || yValue > edges[edges.length - 1]) return null;
  let a = 0, b = edges.length - 1;
  while (a < b - 1) {
    const mid = (a + b) >> 1;
    if (edges[mid] <= yValue) a = mid; else b = mid;
  }

  const row = rows[ti];
  if (!row || a >= row.length) return null;
  const v = row[a];
  return (v == null || isNaN(v)) ? null : v;
}

// Browser canvas dimensions are bounded (typically 16384–32768 px); a spectrogram
// with more time samples than that either fails to render or stutters. Cap the canvas
// width and reduce each column to the per-bin maximum of the samples it covers — picking
// one sample instead would drop bursts narrower than a column, showing a quiet interval
// where the instrument actually spiked.
const MAX_SPECTROGRAM_CANVAS_WIDTH = 4096;
// A sample covers the time up to the next one, unless that step is this many times longer
// than the steps on both sides of it: then it is a data gap and stays empty.
const GAP_FACTOR = 2.5;

// Rows with something to draw (a finite value > 0). Empty and fill rows are left out of
// the timeline: a lone all-NaN row inside a gap would otherwise make the gap look like
// sparse data and get filled.
function drawableSamples(rows, iStart, iEnd) {
  const out = [];
  for (let s = iStart; s < iEnd; s++) if (rows[s]?.some((v) => v > 0)) out.push(s);
  return out;
}

// Median spacing of the samples: their cadence, robust to gaps and to the uneven rows a
// resampled refetch brings.
function cadence(t) {
  const diffs = [];
  for (let k = 1; k < t.length; k++) if (t[k] > t[k - 1]) diffs.push(t[k] - t[k - 1]);
  if (diffs.length === 0) return 1;
  diffs.sort((x, y) => x - y);
  return diffs[diffs.length >> 1];
}

// view: { start, end } in ms (nullable); colormap: a COLORMAPS name. Returns { canvas, tStart, tEnd, yMin, yMax, yEdges }
// or null. Columns are laid out in time, from tStart to tEnd, so samples land at their
// own time whatever their spacing.
export function renderSpectrogramImage(times, rows, yBinsFlat, vMin, vMax, logScale, view, colormap = DEFAULT_COLORMAP) {
  const v = (view && view.start != null && view.end != null)
    ? { start: view.start, end: view.end }
    : { start: times[0], end: times[times.length - 1] };

  const viewRange = v.end - v.start;
  const renderStart = v.start - viewRange * 0.5;
  const renderEnd = v.end + viewRange * 0.5;

  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < renderStart) lo = mid + 1; else hi = mid; }
  const iStart = lo;
  lo = iStart; hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] <= renderEnd) lo = mid + 1; else hi = mid; }
  const iEnd = lo;

  const nY = yBinsFlat.length;
  const drawn = drawableSamples(rows, iStart, iEnd);
  if (drawn.length === 0 || nY <= 0) return null;

  const t = drawn.map((s) => times[s]);
  const dt = cadence(t);
  const tStart = t[0];
  const tEnd = t[t.length - 1] + dt;
  const width = Math.min(t.length, MAX_SPECTROGRAM_CANVAS_WIDTH);
  const colOf = (time) => Math.min(width, Math.floor(((time - tStart) / (tEnd - tStart)) * width));
  const colMax = columnMaxima(t, drawn.map((s) => rows[s]), nY, width, colOf, dt, tEnd);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = nY;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(width, nY);
  paintColumns(imgData.data, colMax, width, nY, vMin, vMax, logScale, colormapLut(colormap));
  ctx.putImageData(imgData, 0, 0);
  return {
    canvas,
    tStart,
    tEnd,
    yMin: yBinsFlat[0],
    yMax: yBinsFlat[nY - 1],
    yEdges: computeYEdges(yBinsFlat),
  };
}

// Steps on each side of a candidate gap used to estimate the local cadence.
const CADENCE_WINDOW = 5;

// Median of the steps ending at samples [from, to), or null when there are none.
function medianStep(t, from, to) {
  const steps = [];
  for (let i = Math.max(1, from); i < Math.min(to, t.length); i++) steps.push(t[i] - t[i - 1]);
  if (steps.length === 0) return null;
  steps.sort((x, y) => x - y);
  return steps[steps.length >> 1];
}

// Where sample k stops being drawn: the next sample, or, across a data gap, one local
// step later. The step is compared with the cadence on each side, not a global one: a
// cache mixing full-resolution rows with coarser resampled ones is continuous in both
// parts. Each side takes a median over a few steps, not one neighbouring step: resampled
// rows sit anywhere in their bucket, so a single neighbour can be ~0 and turn any normal
// step into a "gap".
function coverEnd(t, k, dt, tEnd) {
  if (k + 1 >= t.length) return tEnd;
  const before = medianStep(t, k + 1 - CADENCE_WINDOW, k + 1);
  const after = medianStep(t, k + 2, k + 2 + CADENCE_WINDOW);
  const local = Math.max(before ?? dt, after ?? dt);
  const next = t[k + 1] - t[k];
  return t[k] + (next > GAP_FACTOR * local ? local : next);
}

// Per column and bin, the largest value among the samples covering that column; each
// sample covers at least its own column.
function columnMaxima(t, rows, nY, width, colOf, dt, tEnd) {
  const colMax = new Float64Array(width * nY);
  for (let k = 0; k < t.length; k++) {
    const row = rows[k];
    const c0 = colOf(t[k]);
    const c1 = Math.max(c0 + 1, colOf(coverEnd(t, k, dt, tEnd)));
    for (let c = c0; c < Math.min(c1, width); c++) {
      for (let y = 0; y < nY; y++) {
        const val = row[y];
        if (val != null && !isNaN(val) && val > colMax[c * nY + y]) colMax[c * nY + y] = val;
      }
    }
  }
  return colMax;
}

// Colour each (column, bin) through the colormap's LUT; empty or non-positive cells stay transparent.
function paintColumns(pixels, colMax, width, nY, vMin, vMax, logScale, lut) {
  const logVMin = Math.log10(Math.max(vMin, 1e-30));
  const logVMax = Math.log10(vMax);
  for (let c = 0; c < width; c++) {
    for (let y = 0; y < nY; y++) {
      const val = colMax[c * nY + y];
      if (val <= 0) continue;
      const norm = logScale
        ? (Math.log10(val) - logVMin) / (logVMax - logVMin)
        : (val - vMin) / (vMax - vMin);
      const li = Math.max(0, Math.min(255, Math.round(norm * 255))) * 3;
      const idx = ((nY - 1 - y) * width + c) * 4;
      pixels[idx] = lut[li];
      pixels[idx + 1] = lut[li + 1];
      pixels[idx + 2] = lut[li + 2];
      pixels[idx + 3] = 255;
    }
  }
}
