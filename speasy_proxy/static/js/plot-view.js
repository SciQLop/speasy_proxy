// Chart layer of the /plot viewer: one uPlot per subplot stacked on a shared time
// window, a time slider, a cursor tooltip, highlighted intervals and spectrogram images.
// plot.js owns the data (subplot caches) and calls render/update; this module only
// draws it and reports time-window changes back through onViewChange.
import uPlot from './vendor/uPlot.esm.js';
import { CHART_COLORS } from './common.js';
import {
  lineTable, nearestIndex, fmtTick, sharedAxisExtent, sliderDomain, viewToSlider, sliderToView,
  computeValueRange, renderableRange,
} from './plot-core.js';
import { computeYEdges, renderSpectrogramImage, spectrogramValueAt } from './spectrogram.js';
import { bindGestures } from './plot-gestures.js';

const Y_AXIS_PX = 64;      // fixed y-axis gutter so every subplot's plot area lines up
const Y_LABEL_PX = 16;
const X_AXIS_PX = 46;      // time axis (two label lines), drawn under the last subplot only
const TITLE_PX = 20;
const LEGEND_PX = 24;
const SLIDER_PX = 30;
const MIN_PLOT_PX = 60;
// Explicit [top, right, bottom, left] padding: uPlot otherwise auto-pads only the chart
// whose time labels overflow (the last one), shifting its time axis off the others.
const CHART_PADDING = [6, 28, 0, 0];
const SLIDER_PAD_RATIO = 0.5;
const HEATMAP_REFRESH_MS = 200;  // re-render spectrogram images once a gesture settles
const SYNC_KEY = 'speasy-plot';
const MUTED = '#8892b0';

const utcDate = (ts) => uPlot.tzDate(new Date(ts), 'Etc/UTC');
const binsOf = (cache) => (Array.isArray(cache.yAxis?.[0]) ? cache.yAxis[0] : (cache.yAxis || []));
const firstCache = (sp) => sp.productData[sp.products[0]?.path];
const fmtValue = (v) => String(Number(v.toPrecision(4)));

export function createPlotView(root, { onViewChange }) {
  const plotsEl = el('div', 'pv-plots');
  const slider = createSlider(root, (view) => { setView(view); onViewChange(view); });
  const tooltip = el('div', 'pv-tooltip');
  root.appendChild(plotsEl);
  root.appendChild(slider.el);
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
    slider.update(plots, view, charts[0]?.u);
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
    slider.update(plots, view, charts[0]?.u);
  }

  function setView(next) {
    view = { start: next.start, end: next.end };
    for (const c of charts) c.u.setScale('x', { min: view.start, max: view.end });
    slider.update(plots, view, charts[0]?.u);
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
    slider.update(plots, view, charts[0]?.u);
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
    slider.update([], view, null);
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
    const { series, meta } = isHeatmap ? heatmapSeries(subplot) : lineSeries(subplot, plots.length);
    const title = subplot.products.map((p) => p.label || p.path.split('/').pop()).join(', ') + (loading ? ' ●' : '');
    const opts = {
      title,
      width: plotWidth(),
      height,
      ms: 1,
      tzDate: utcDate,
      padding: CHART_PADDING,
      cursor: { sync: { key: SYNC_KEY }, y: false, points: { show: false }, drag: { x: false, y: false, setScale: false } },
      select: { show: false },
      legend: { show: !isHeatmap, live: false },
      scales: { x: { time: true }, y: yScale(subplot, isHeatmap) },
      axes: [xAxis(isLast), yAxisOpts(subplot, isHeatmap)],
      series,
      hooks: {
        drawClear: [(u) => drawBackdrop(u, subplot, isHeatmap)],
        setCursor: [(u) => onCursor(u, subplot)],
      },
    };
    const u = new uPlot(opts, chartData(subplot), plotsEl);
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

// uPlot's height covers its canvas (plot area + axes); the title and legend are DOM
// rows above/below it, so they are budgeted separately.
function layoutHeights(plots, totalPx) {
  const n = plots.length;
  if (n === 0) return [];
  const chrome = plots.reduce((sum, sp) => sum + TITLE_PX + (sp.plotType === 'heatmap' ? 0 : LEGEND_PX), 0);
  const plotPx = Math.max(MIN_PLOT_PX, Math.floor((totalPx - SLIDER_PX - X_AXIS_PX - chrome) / n));
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

function yAxisOpts(subplot, isHeatmap) {
  const cache = firstCache(subplot);
  const label = isHeatmap
    ? (cache?.yAxisName || '') + (cache?.yAxisUnit ? ' (' + cache.yAxisUnit + ')' : '')
    : (cache?.unit || '');
  return {
    ...axisBase,
    size: Y_AXIS_PX,
    label,
    labelSize: Y_LABEL_PX,
    values: (u, splits) => splits.map(fmtTick),
    grid: isHeatmap ? { show: false } : { stroke: '#1e2640', width: 1, filter: decadesOnlyOnLog },
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
  const lo = edges[0], hi = edges[edges.length - 1];
  return [log ? Math.max(lo, hi * 1e-12, 1e-30) : lo, hi];
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
function lineSeries(subplot, nSubplots) {
  const series = [{}];
  const meta = [null];
  let colorIdx = 0;
  for (const prod of subplot.products) {
    const cache = subplot.productData[prod.path];
    if (!cache || cache.times.length === 0) continue;
    const prodLabel = prod.label || prod.path.split('/').pop();
    for (const cn of cache.columnNames) {
      const color = CHART_COLORS[colorIdx++ % CHART_COLORS.length];
      const label = nSubplots > 1 || subplot.products.length > 1 ? prodLabel + ' ' + cn : cn;
      series.push({ label, stroke: color, width: 1.2, points: { show: false } });
      meta.push({ path: prod.path, column: cn, unit: cache.unit || '', color, label });
    }
  }
  return { series, meta };
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
  const tables = subplot.products
    .map((p) => subplot.productData[p.path])
    .filter((c) => c && c.times.length > 0)
    .map(lineTable);
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
  const yTop = u.valToPos(img.yMax, 'y', true), yBottom = u.valToPos(img.yMin, 'y', true);
  u.ctx.imageSmoothingEnabled = false;
  u.ctx.drawImage(img.canvas, Math.min(x0, x1), Math.min(yTop, yBottom), Math.abs(x1 - x0), Math.abs(yBottom - yTop));
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
      if (!u.series[i].show || !cache) continue;
      const idx = nearestIndex(cache.times, t);
      const v = idx < 0 ? null : cache.columns[m.column]?.[idx];
      if (v == null || Number.isNaN(v)) continue;
      html += swatch(m.color, 5) + escapeHtml(m.label) + ': ' + fmtValue(v) + (m.unit ? ' ' + escapeHtml(m.unit) : '') + '<br/>';
    }
  }
  return html;
}

function heatmapLine(subplot, t, yVal) {
  const cache = firstCache(subplot);
  if (!cache || yVal == null) return '';
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

// --- time slider ---------------------------------------------------------------------

// A track spanning the loaded data (padded) with a draggable window for the current view:
// drag the window to pan, drag an edge to resize. Aligned under the plot areas.
function createSlider(root, onChange) {
  const track = el('div', 'pv-slider');
  const win = el('div', 'pv-slider-window');
  const leftHandle = el('div', 'pv-slider-handle');
  const rightHandle = el('div', 'pv-slider-handle');
  win.appendChild(leftHandle);
  win.appendChild(rightHandle);
  track.appendChild(win);

  let domain = { min: 0, max: 1 };
  let trackPx = 1;
  let current = { start: 0, end: 1 };

  function update(plots, view, firstU) {
    // visibility, not display: the track must keep its height so the charts are sized
    // around it before it first shows.
    track.style.visibility = plots.length > 0 && view.start != null ? 'visible' : 'hidden';
    if (!firstU || view.start == null) return;
    const left = firstU.bbox.left / uPlot.pxRatio;
    trackPx = Math.max(1, firstU.bbox.width / uPlot.pxRatio);
    track.style.marginLeft = left + 'px';
    track.style.width = trackPx + 'px';
    current = view;
    if (!dragging) domain = sliderDomain(sharedAxisExtent(plots, SLIDER_PAD_RATIO), view);
    const px = viewToSlider(domain, view, trackPx);
    win.style.left = px.left + 'px';
    win.style.width = Math.max(4, px.width) + 'px';
  }

  let dragging = false;
  function startDrag(e, mode) {
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    const x0 = e.clientX;
    const start = viewToSlider(domain, current, trackPx);
    const move = (m) => {
      const dx = m.clientX - x0;
      let left = start.left, width = start.width;
      if (mode === 'move') left += dx;
      else if (mode === 'left') { left += dx; width -= dx; }
      else width += dx;
      if (width < 2) return;
      onChange(sliderToView(domain, left, width, trackPx));
    };
    const up = () => {
      dragging = false;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }
  win.addEventListener('mousedown', (e) => startDrag(e, 'move'));
  leftHandle.addEventListener('mousedown', (e) => startDrag(e, 'left'));
  rightHandle.addEventListener('mousedown', (e) => startDrag(e, 'right'));

  return { el: track, update };
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
    const plotLeft = r.left - rootRect.left + u.bbox.left / uPlot.pxRatio;
    ctx.fillStyle = MUTED;
    ctx.fillText(u.root.querySelector('.u-title')?.textContent || '', plotLeft, r.top - rootRect.top - TITLE_PX / 2);
    drawLegendRow(ctx, u, meta, plotLeft, r.bottom - rootRect.top + LEGEND_PX / 2);
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
