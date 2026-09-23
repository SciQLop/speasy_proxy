// Chart layer of the /plot viewer: one uPlot per subplot stacked on a shared time
// window, a title/legend badge over each plot, a cursor tooltip, highlighted intervals and
// spectrogram images.
// plot.js owns the data (subplot caches) and calls render/update; this module only
// draws it and reports time-window changes back through onViewChange.
import uPlot from './vendor/uPlot.esm.js';
import { CHART_COLORS } from './common.js';
import {
  lineTable, nearestIndex, fmtTick,
  computeValueRange, renderableRange,
} from './plot-core.js';
import { binRowRects, computeYEdges, lowestPositiveEdge, renderSpectrogramImage, spectrogramValueAt } from './spectrogram.js';
import { bindGestures } from './plot-gestures.js';

const Y_AXIS_PX = 64;      // fixed y-axis gutter so every subplot's plot area lines up
const X_AXIS_PX = 46;      // time axis (two label lines), drawn under the last subplot only
const MIN_PLOT_PX = 60;
// Explicit [top, right, bottom, left] padding: uPlot otherwise auto-pads only the chart
// whose time labels overflow (the last one), shifting its time axis off the others.
const CHART_PADDING = [6, 28, 6, 0];  // top/bottom room for edge tick labels
const BADGE_INSET_PX = 6;              // title/legend badge offset inside the plot area
const HEATMAP_REFRESH_MS = 200;  // re-render spectrogram images once a gesture settles
const SYNC_KEY = 'speasy-plot';
const MUTED = '#8892b0';

const utcDate = (ts) => uPlot.tzDate(new Date(ts), 'Etc/UTC');
const binsOf = (cache) => (Array.isArray(cache.yAxis?.[0]) ? cache.yAxis[0] : (cache.yAxis || []));
const firstCache = (sp) => sp.productData[sp.products[0]?.path];
// Products that contribute line series. Series and data columns must both come from
// this one list (keyed on columns, like structureKey): a pan can trim a cache to zero
// samples while the charts only get a data-only update.
const lineProducts = (sp) => sp.products
  .map((prod) => ({ prod, cache: sp.productData[prod.path] }))
  .filter(({ cache }) => cache && cache.columnNames.length > 0);
const fmtValue = (v) => String(Number(v.toPrecision(4)));

export function createPlotView(root, { onViewChange }) {
  const plotsEl = el('div', 'pv-plots');
  const tooltip = el('div', 'pv-tooltip');
  root.appendChild(plotsEl);
  root.appendChild(tooltip);

  let charts = [];          // [{ u, subplot }]
  let plots = [];
  let intervals = [];
  let view = { start: null, end: null };
  let hovered = null;
  let heatmapTimer = null;

  // --- public API -------------------------------------------------------------

  function render(nextPlots, nextView, opts = {}) {
    destroyCharts();
    plots = nextPlots;
    view = { ...nextView };
    intervals = (opts.intervals || []).map((iv) => ({ ...iv, t0: Date.parse(iv.start), t1: Date.parse(iv.stop) }));
    const heights = layoutHeights(plots, root.clientHeight);
    charts = plots.map((sp, i) => createChart(sp, i, heights[i], opts.loading?.has(i)));
    fitHeights();
    refreshHeatmaps();
  }

  function update(nextPlots) {
    plots = nextPlots;
    for (const c of charts) {
      c.u.batch(() => {
        c.u.setData(chartData(c.subplot), true);
        c.u.setScale('x', { min: view.start, max: view.end });
        if (c.subplot._yOverride) c.u.setScale('y', c.subplot._yOverride);
      });
    }
    refreshHeatmaps();
  }

  function setView(next) {
    view = { start: next.start, end: next.end };
    for (const c of charts) c.u.setScale('x', { min: view.start, max: view.end });
    clearTimeout(heatmapTimer);
    heatmapTimer = setTimeout(refreshHeatmaps, HEATMAP_REFRESH_MS);
  }

  function refreshHeatmaps() {
    for (const c of charts) {
      if (c.subplot.plotType !== 'heatmap') continue;
      c.subplot.lastHeatmapImg = heatmapImage(c.subplot, view);
      c.u.redraw(false);
    }
  }

  function resize() {
    fitHeights();
  }

  // Titles and legends are DOM rows whose height depends on fonts and wrapping, so
  // measure them once laid out and give the canvases whatever height is left.
  function fitHeights() {
    if (charts.length === 0) return;
    const chrome = charts.reduce((sum, c) => sum + Math.max(0, (c.u.root.offsetHeight || 0) - c.u.height), 0);
    const spare = (plotsEl.clientHeight || 0) - chrome - X_AXIS_PX - 2;  // 2px: sub-pixel rounding
    const each = Math.max(MIN_PLOT_PX, Math.floor(spare / charts.length));
    charts.forEach((c, i) => c.u.setSize({ width: plotWidth(), height: each + (i === charts.length - 1 ? X_AXIS_PX : 0) }));
  }

  function clear() {
    destroyCharts();
    plots = [];
  }

  function toDataURL(pixelRatio = 2, background = '#0b0e17') {
    return exportPng(root, charts, pixelRatio, background);
  }

  // --- chart construction ------------------------------------------------------

  function plotWidth() {
    return Math.max(100, root.clientWidth);
  }

  function destroyCharts() {
    for (const c of charts) c.u.destroy();
    charts = [];
    hovered = null;
    tooltip.style.display = 'none';
  }

  function createChart(subplot, index, height, loading) {
    const isLast = index === plots.length - 1;
    const isHeatmap = subplot.plotType === 'heatmap' && !!firstCache(subplot)?.yAxis;
    const { series, meta } = isHeatmap ? heatmapSeries(subplot) : lineSeries(subplot);
    const opts = {
      width: plotWidth(),
      height,
      ms: 1,
      tzDate: utcDate,
      padding: CHART_PADDING,
      cursor: { sync: { key: SYNC_KEY }, y: false, points: { show: false }, drag: { x: false, y: false, setScale: false } },
      select: { show: false },
      // One series: the title already names it, a legend would only repeat it.
      legend: { show: series.length > 2, live: false },
      scales: { x: { time: true }, y: yScale(subplot, isHeatmap) },
      axes: [xAxis(isLast), yAxisOpts(isHeatmap)],
      series,
      hooks: {
        drawClear: [(u) => drawBackdrop(u, subplot, isHeatmap)],
        setCursor: [(u) => onCursor(u, subplot)],
      },
    };
    const u = new uPlot(opts, chartData(subplot), plotsEl);
    u.root.appendChild(createBadge(u, badgeTitle(subplot, isHeatmap, loading)));
    u.batch(() => {
      u.setScale('x', { min: view.start, max: view.end });
      if (subplot._yOverride) u.setScale('y', subplot._yOverride);
    });
    u.over.addEventListener('mouseenter', () => { hovered = u; });
    u.over.addEventListener('mouseleave', () => { hovered = null; tooltip.style.display = 'none'; });
    bindGestures(u, {
      getView: () => view,
      setView: (next) => { setView(next); onViewChange(view); },
      setY: (min, max) => { subplot._yOverride = { min, max }; u.setScale('y', { min, max }); },
      resetY: () => resetY(u, subplot),
    });
    return { u, subplot, meta };
  }

  function resetY(u, subplot) {
    delete subplot._yOverride;
    u.batch(() => {
      u.setData(u.data, true);
      u.setScale('x', { min: view.start, max: view.end });
    });
  }

  function drawBackdrop(u, subplot, isHeatmap) {
    const { ctx, bbox } = u;
    ctx.save();
    ctx.beginPath();
    ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
    ctx.clip();
    if (isHeatmap) drawHeatmapImage(u, subplot.lastHeatmapImg);
    drawIntervals(u, intervals);
    ctx.restore();
  }

  // --- tooltip -----------------------------------------------------------------

  function onCursor(u, subplot) {
    if (u !== hovered) return;
    const left = u.cursor.left;
    if (left == null || left < 0) { tooltip.style.display = 'none'; return; }
    const t = u.posToVal(left, 'x');
    const yVal = subplot.plotType === 'heatmap' ? u.posToVal(u.cursor.top, 'y') : null;
    tooltip.innerHTML = tooltipHtml(t, charts, intervals, subplot, yVal);
    placeTooltip(tooltip, root, u, left, u.cursor.top);
  }

  return { render, update, setView, getView: () => ({ ...view }), refreshHeatmaps, resize, clear, toDataURL };
}

// --- layout ----------------------------------------------------------------------

// uPlot's height covers its canvas (plot area + axes); the title/legend badge floats over
// the plot, so the canvases share all the height (fitHeights then measures exactly).
function layoutHeights(plots, totalPx) {
  const n = plots.length;
  if (n === 0) return [];
  const plotPx = Math.max(MIN_PLOT_PX, Math.floor((totalPx - X_AXIS_PX) / n));
  return plots.map((_, i) => plotPx + (i === n - 1 ? X_AXIS_PX : 0));
}

// --- axes, scales, series -------------------------------------------------------

const axisBase = {
  stroke: MUTED,
  font: '11px system-ui, sans-serif',
  labelFont: '11px system-ui, sans-serif',
  ticks: { stroke: '#2a3358', width: 1, size: 4 },
};

// 24-hour UTC tick labels; the second line carries the date when it changes. Rows are
// uPlot's [tick increment (ms), default, year, month, day, hour, minute, second, mode].
const SEC = 1e3, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
const TIME_TICKS = [
  [365 * DAY, '{YYYY}', null, null, null, null, null, null, 1],
  [28 * DAY, '{MMM}', '\n{YYYY}', null, null, null, null, null, 1],
  [DAY, '{MM}-{DD}', '\n{YYYY}', null, null, null, null, null, 1],
  [HOUR, '{HH}:{mm}', '\n{YYYY}-{MM}-{DD}', null, '\n{MM}-{DD}', null, null, null, 1],
  [MIN, '{HH}:{mm}', '\n{YYYY}-{MM}-{DD}', null, '\n{MM}-{DD}', null, null, null, 1],
  [SEC, '{HH}:{mm}:{ss}', '\n{YYYY}-{MM}-{DD}', null, '\n{MM}-{DD}', null, null, null, 1],
  [1, ':{ss}.{fff}', '\n{YYYY}-{MM}-{DD} {HH}:{mm}', null, '\n{MM}-{DD} {HH}:{mm}', null, '\n{HH}:{mm}', null, 1],
];

function xAxis(isLast) {
  return isLast
    ? { ...axisBase, size: X_AXIS_PX, values: TIME_TICKS, grid: { show: false } }
    : { ...axisBase, show: false, grid: { show: false } };
}

function yAxisOpts(isHeatmap) {
  return {
    ...axisBase,
    size: Y_AXIS_PX,
    values: (u, splits) => splits.map(fmtTick),
    grid: isHeatmap ? { show: false } : { stroke: '#1e2640', width: 1, filter: decadesOnlyOnLog },
    ticks: { ...axisBase.ticks, filter: decadesOnlyOnLog },
  };
}

// uPlot places a split at every mantissa (2..9) of a log axis; a grid line on each of
// them buries the data, so log grids keep whole decades only.
function decadesOnlyOnLog(u, splits, axisIdx) {
  if (u.scales[u.axes[axisIdx].scale].distr !== 3) return splits;
  return splits.map((v) => (v > 0 && Math.abs(Math.log10(v) - Math.round(Math.log10(v))) < 1e-9 ? v : null));
}

function yScale(subplot, isHeatmap) {
  const log = !!subplot.y_axis.log;
  return {
    distr: log ? 3 : 1,
    range: (u, min, max) => {
      if (subplot._yOverride) return [subplot._yOverride.min, subplot._yOverride.max];
      if (isHeatmap) return heatmapYRange(firstCache(subplot), log);
      return autoYRange(min, max, log);
    },
  };
}

function heatmapYRange(cache, log) {
  const edges = computeYEdges(binsOf(cache));
  const hi = edges[edges.length - 1];
  return [log ? (lowestPositiveEdge(edges) ?? hi / 10) : edges[0], hi];
}

function autoYRange(min, max, log) {
  if (min == null || max == null || !Number.isFinite(min) || !Number.isFinite(max)) return log ? [1, 10] : [0, 1];
  if (!log) return uPlot.rangeNum(min, max, 0.1, true);
  const lo = min > 0 ? min : (max > 0 ? max * 1e-3 : 1);
  return uPlot.rangeLog(lo, Math.max(max, lo * 10), 10, true);
}

// uPlot deep-copies series options, so per-series lookups (which cache/column, unit,
// color) are kept in a parallel `meta` array indexed like u.series, holding paths not
// cache references — caches are mutated and replaced by plot.js between renders.
function lineSeries(subplot) {
  const series = [{}];
  const meta = [null];
  let colorIdx = 0;
  for (const { prod, cache } of lineProducts(subplot)) {
    const prodLabel = prod.label || prod.path.split('/').pop();
    for (const cn of cache.columnNames) {
      const color = CHART_COLORS[colorIdx++ % CHART_COLORS.length];
      const label = seriesLabel(prodLabel, cn, subplot.products.length, cache.columnNames.length);
      series.push({ label, stroke: color, width: 1.2, points: { show: false } });
      // The tooltip lists every subplot at once, so it needs the product in the name.
      const fullLabel = cache.columnNames.length === 1 ? prodLabel : prodLabel + ' ' + cn;
      meta.push({ path: prod.path, column: cn, unit: cache.unit || '', color, label, fullLabel });
    }
  }
  return { series, meta };
}

// Column names alone inside a single-product subplot (the title names the product);
// a lone column is named after its product, never the generated 'col_0'.
function seriesLabel(prodLabel, column, nProducts, nColumns) {
  if (nColumns === 1) return prodLabel;
  return nProducts > 1 ? prodLabel + ' ' + column : column;
}

// Badge text: the products, then the unit (lines) or the y quantity and its unit
// (spectrograms) — replaces a rotated axis label that cost a strip of width per plot.
function badgeTitle(subplot, isHeatmap, loading) {
  const names = subplot.products.map((p) => p.label || p.path.split('/').pop()).join(', ');
  const cache = firstCache(subplot);
  const unit = (u) => (u ? ' (' + u + ')' : '');
  const suffix = isHeatmap
    ? ' · ' + (cache?.yAxisName || '') + unit(cache?.yAxisUnit)
    : unit(cache?.unit);
  return names + suffix + (loading ? ' ●' : '');
}

// The legend moves into the badge; only its entries take clicks (toggle a series), the
// rest lets the cursor and drag gestures through to the plot underneath.
function createBadge(u, title) {
  const badge = el('div', 'pv-header');
  badge.style.left = (Y_AXIS_PX + BADGE_INSET_PX) + 'px';
  badge.style.top = (CHART_PADDING[0] + BADGE_INSET_PX) + 'px';
  const text = el('span', 'pv-header-title');
  text.textContent = title;
  badge.appendChild(text);
  const legend = u.root.querySelector('.u-legend');
  if (legend) badge.appendChild(legend);
  return badge;
}

function heatmapSeries(subplot) {
  return {
    series: [{}, { label: firstCache(subplot)?.yAxisName || 'value', paths: () => null, points: { show: false } }],
    meta: [null, null],
  };
}

// Line subplots: every loaded product on one time axis (uPlot.join marks the other
// product's timestamps as undefined, which uPlot draws through; real gaps stay null).
// Heatmaps draw an image instead of series, so a 2-point x extent is enough data.
function chartData(subplot) {
  if (subplot.plotType === 'heatmap' && firstCache(subplot)?.yAxis) {
    const t = firstCache(subplot).times;
    return t.length ? [[t[0], t[t.length - 1]], [null, null]] : [[], []];
  }
  const tables = lineProducts(subplot).map(({ cache }) => lineTable(cache));
  if (tables.length === 0) return [[]];
  return tables.length === 1 ? tables[0] : uPlot.join(tables);
}

// --- spectrogram image and intervals ---------------------------------------------

function heatmapImage(subplot, view) {
  const cache = firstCache(subplot);
  if (!cache || !cache.yAxis || cache.rows.length === 0) return null;
  const { vMin, vMax } = renderableRange(cache.valueRange || computeValueRange(cache.rows));
  return renderSpectrogramImage(cache.times, cache.rows, binsOf(cache), vMin, vMax, subplot.logScale, view);
}

function drawHeatmapImage(u, img) {
  if (!img) return;
  const x0 = u.valToPos(img.tStart, 'x', true), x1 = u.valToPos(img.tEnd, 'x', true);
  const left = Math.min(x0, x1), width = Math.abs(x1 - x0);
  const floor = u.scales.y.distr === 3 ? lowestPositiveEdge(img.yEdges) : null;
  u.ctx.imageSmoothingEnabled = false;
  for (const r of binRowRects(img.yEdges, (v) => u.valToPos(v, 'y', true), floor)) {
    if (r.height > 0) u.ctx.drawImage(img.canvas, 0, r.srcRow, img.canvas.width, 1, left, r.top, width, r.height);
  }
}

function drawIntervals(u, intervals) {
  const { ctx, bbox } = u;
  for (const iv of intervals) {
    const x0 = u.valToPos(iv.t0, 'x', true), x1 = u.valToPos(iv.t1, 'x', true);
    if (x1 < bbox.left || x0 > bbox.left + bbox.width) continue;
    ctx.fillStyle = iv.color;
    ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height);
  }
}

// --- tooltip content ---------------------------------------------------------------

function tooltipHtml(t, charts, intervals, hoveredSubplot, yVal) {
  let html = '<b>' + new Date(t).toISOString().replace('T', ' ').replace('Z', '') + '</b><br/>';
  for (const iv of intervals) {
    if (iv.label && t >= iv.t0 && t <= iv.t1) html += swatch(iv.color, 2) + '<b>' + escapeHtml(iv.label) + '</b><br/>';
  }
  for (const { u, subplot, meta } of charts) {
    if (subplot.plotType === 'heatmap') {
      if (subplot === hoveredSubplot) html += heatmapLine(subplot, t, yVal);
      continue;
    }
    for (let i = 1; i < meta.length; i++) {
      const m = meta[i];
      const cache = subplot.productData[m.path];
      if (!u.series[i].show || !cache || !withinLoaded(cache.times, t)) continue;
      const idx = nearestIndex(cache.times, t);
      const v = idx < 0 ? null : cache.columns[m.column]?.[idx];
      if (v == null || Number.isNaN(v)) continue;
      html += swatch(m.color, 5) + escapeHtml(m.fullLabel) + ': ' + fmtValue(v) + (m.unit ? ' ' + escapeHtml(m.unit) : '') + '<br/>';
    }
  }
  return html;
}

// Past the loaded data the nearest sample is far away; showing it would report a value
// at a time where nothing is drawn.
const withinLoaded = (times, t) => times.length > 0 && t >= times[0] && t <= times[times.length - 1];

function heatmapLine(subplot, t, yVal) {
  const cache = firstCache(subplot);
  if (!cache || yVal == null || !withinLoaded(cache.times, t)) return '';
  const v = spectrogramValueAt(cache.times, cache.rows, binsOf(cache), t, yVal);
  if (v == null) return '';
  return swatch('#91cc75', 5) + escapeHtml(cache.yAxisName || 'value') + ' ' + fmtValue(yVal)
    + (cache.yAxisUnit ? ' ' + escapeHtml(cache.yAxisUnit) : '') + ': <b>' + fmtValue(v) + '</b>'
    + (cache.unit ? ' ' + escapeHtml(cache.unit) : '') + '<br/>';
}

function placeTooltip(tooltip, root, u, left, top) {
  tooltip.style.display = 'block';
  const rootRect = root.getBoundingClientRect();
  const overRect = u.over.getBoundingClientRect();
  const x = overRect.left - rootRect.left + left + 14;
  const y = overRect.top - rootRect.top + (top ?? 0) + 14;
  const w = tooltip.offsetWidth, h = tooltip.offsetHeight;
  tooltip.style.left = (x + w > rootRect.width ? x - w - 28 : x) + 'px';
  tooltip.style.top = (y + h > rootRect.height ? Math.max(0, y - h - 28) : y) + 'px';
}

const swatch = (color, radius) =>
  '<span style="display:inline-block;width:10px;height:10px;border-radius:' + radius + 'px;background:' + escapeHtml(color) + ';margin-right:4px;"></span>';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- PNG export -------------------------------------------------------------------------

// Each subplot is its own canvas: stitch them, with titles and legends, into one image.
function exportPng(root, charts, pixelRatio, background) {
  const rootRect = root.getBoundingClientRect();
  const out = document.createElement('canvas');
  out.width = Math.round(rootRect.width * pixelRatio);
  out.height = Math.round(rootRect.height * pixelRatio);
  const ctx = out.getContext('2d');
  ctx.scale(pixelRatio, pixelRatio);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, rootRect.width, rootRect.height);
  ctx.font = '12px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const { u, meta } of charts) {
    const canvas = u.ctx.canvas;
    const r = canvas.getBoundingClientRect();
    ctx.drawImage(canvas, r.left - rootRect.left, r.top - rootRect.top, r.width, r.height);
    const x = r.left - rootRect.left + Y_AXIS_PX + BADGE_INSET_PX;
    const y = r.top - rootRect.top + CHART_PADDING[0] + BADGE_INSET_PX + 8;
    const title = u.root.querySelector('.pv-header-title')?.textContent || '';
    ctx.fillStyle = MUTED;
    ctx.fillText(title, x, y);
    if (u.series.length > 2) drawLegendRow(ctx, u, meta, x + ctx.measureText(title).width + 12, y);
  }
  return out.toDataURL('image/png');
}

function drawLegendRow(ctx, u, meta, x, y) {
  for (let i = 1; i < meta.length; i++) {
    if (!meta[i] || !u.series[i].show) continue;
    ctx.fillStyle = meta[i].color;
    ctx.fillRect(x, y - 5, 10, 10);
    ctx.fillStyle = '#e0e6f0';
    ctx.fillText(meta[i].label, x + 14, y);
    x += 24 + ctx.measureText(meta[i].label).width;
  }
}

function el(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
