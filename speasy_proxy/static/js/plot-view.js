// Chart layer of the /plot viewer: one uPlot per subplot stacked on a shared time
// window, a title/legend badge over each plot, a per-subplot toolbar, a cursor tooltip,
// highlighted intervals, spectrogram images and drop targets for products dragged from
// the tree.
// plot.js owns the data (subplot caches) and calls render/update; this module only
// draws it and reports back: time-window changes through onViewChange, subplot edits
// (log toggles, removals, dropped products) through onAction({ type, index, path }).
import uPlot from './vendor/uPlot.esm.js';
import { CHART_COLORS, escapeHtml, utcMs } from './common.js';
import {
  lineTable, nearestIndex, fmtTick, productTitle, dropZone,
  paramValue, zRangeOf, outOfCoverage, edgeColor, nearestEdge, eventAt, formatDuration,
  subMsSplits, subMsTickLabels, fmtInstant,
} from './plot-core.js';
import { binRowRects, computeYEdges, lowestPositiveEdge, renderSpectrogramImage, spectrogramValueAt, COLORMAPS, colormapLut } from './spectrogram.js';
import { bindGestures } from './plot-gestures.js';

const Y_AXIS_PX = 64;      // fixed y-axis gutter so every subplot's plot area lines up
const Y_UNIT_PX = 16;      // part of that gutter given to a rotated unit label, when there is one
const X_AXIS_PX = 46;      // time axis (two label lines), drawn under the last subplot only
const MIN_PLOT_PX = 60;
// Explicit [top, right, bottom, left] padding: uPlot otherwise auto-pads only the chart
// whose time labels overflow (the last one), shifting its time axis off the others.
const CHART_PADDING = [6, 28, 6, 0];  // top/bottom room for edge tick labels
const EDGE_GRAB_PX = 5;      // how close to an event edge a press grabs it instead of panning
const BADGE_INSET_PX = 6;              // title/legend badge offset inside the plot area
const COLORBAR_W = 80, COLORBAR_H = 8;  // spectrogram colour bar, drawn inside the badge
const HEATMAP_REFRESH_MS = 200;  // re-render spectrogram images once a gesture settles
const SYNC_KEY = 'speasy-plot';
const MUTED = '#8892b0';
export const PRODUCT_MIME = 'application/x-speasy-product';  // drag payload: a product path

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

// paramSpecsOf(path): the product's extra parameters (inventory-tree.js paramSpecs).
// coverageOf(path): the product's { start, stop } time coverage in ms, or null.
export function createPlotView(root, { onViewChange, onAction = () => {}, paramSpecsOf = () => [], coverageOf = () => null }) {
  const plotsEl = el('div', 'pv-plots');
  const tooltip = el('div', 'pv-tooltip');
  const dropNew = el('div', 'pv-drop-new');
  root.appendChild(plotsEl);
  root.appendChild(tooltip);
  root.appendChild(dropNew);
  bindDropTarget(dropNew, (path) => onAction({ type: 'addProduct', index: null, path }));
  watchProductDrags(root);
  setEmpty(true);

  let charts = [];          // [{ u, subplot }]
  let plots = [];
  let intervals = [];
  let view = { start: null, end: null };
  let hovered = null;
  let heatmapTimer = null;

  // --- public API -------------------------------------------------------------

  function render(nextPlots, nextView, opts = {}) {
    destroyCharts();
    setEmpty(nextPlots.length === 0);
    plots = nextPlots;
    view = { ...nextView };
    intervals = (opts.intervals || []).map((iv) => ({ ...iv, t0: utcMs(iv.start), t1: utcMs(iv.stop) }));
    const heights = layoutHeights(plots, root.clientHeight);
    charts = plots.map((sp, i) => createChart(sp, i, heights[i], opts.loading?.has(sp)));
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
    refreshCoverageNotes();
  }

  function setView(next) {
    view = { start: next.start, end: next.end };
    for (const c of charts) c.u.setScale('x', { min: view.start, max: view.end });
    refreshCoverageNotes();
    clearTimeout(heatmapTimer);
    heatmapTimer = setTimeout(refreshHeatmaps, HEATMAP_REFRESH_MS);
  }

  // A subplot whose window lies wholly before or after a product's data says so, with
  // a button to the nearest data (same window length).
  function refreshCoverageNotes() {
    for (const c of charts) {
      c.note?.remove();
      c.note = coverageNote(c.subplot);
      if (c.note) c.u.root.appendChild(c.note);
    }
  }

  function coverageNote(subplot) {
    for (const prod of subplot.products) {
      const coverage = coverageOf(prod.path);
      const out = outOfCoverage(coverage, view.start, view.end);
      if (!out) continue;
      const note = el('div', 'pv-nodata');
      const name = prod.path.split('/').pop();
      const text = el('span', 'pv-nodata-text');
      text.textContent = 'No data here: ' + name + ' covers ' + utcDay(coverage.start) + ' → ' + utcDay(coverage.stop);
      note.appendChild(text);
      const jump = el('button', 'pv-tool active');
      jump.textContent = out.side === 'after' ? 'Go to last data' : 'Go to first data';
      jump.addEventListener('click', () => onAction({ type: 'jumpTo', value: out.range }));
      note.appendChild(jump);
      return note;
    }
    return null;
  }

  function refreshHeatmaps() {
    for (const c of charts) {
      if (c.subplot.plotType !== 'heatmap') continue;
      c.subplot.lastHeatmapImg = heatmapImage(c.subplot, view);
      c.colorbar?.update();
      c.u.redraw(false);
    }
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
    setEmpty(true);
  }

  // Empty, the whole chart area is one big drop target with a hint; otherwise a strip
  // at the bottom takes drops for a new subplot while a product is being dragged.
  function setEmpty(empty) {
    root.classList.toggle('pv-empty', empty);
    dropNew.textContent = empty
      ? 'Drag a product here, or press its + in the product tree'
      : '+ New subplot';
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
      axes: [xAxis(isLast), yAxisOpts(isHeatmap, yUnit(subplot, isHeatmap))],
      series,
      hooks: {
        init: [extendTimeAxisBelowMs],
        drawClear: [(u) => drawBackdrop(u, subplot, isHeatmap)],
        draw: [(u) => drawIntervalEdges(u, intervals, index === plots.length - 1)],
        setCursor: [(u) => onCursor(u, subplot)],
      },
    };
    const u = new uPlot(opts, chartData(subplot), plotsEl);
    const act = (type, path) => onAction({ type, index, path });
    // A manual Y range (_yOverride) is what turns auto-scaling off, whether it came from
    // the auto Y button or a zoom/pan in the Y gutter; the button always reflects it.
    const setY = (range) => {
      if (range) { subplot._yOverride = range; u.setScale('y', range); } else resetY(u, subplot);
      tools.show('autoY', !subplot._yOverride);
    };
    const toggleAutoY = () => setY(subplot._yOverride ? null : { min: u.scales.y.min, max: u.scales.y.max });
    // Auto Z off freezes the colour range on screen; back on, it follows the data again.
    const setZ = (range) => onAction({ type: 'zRange', index, value: range });
    const toggleAutoZ = () => setZ(subplot._zOverride ? null : zRangeOf(subplot, firstCache(subplot)));
    const localTools = { autoY: toggleAutoY, autoZ: toggleAutoZ };
    const tools = createTools(subplot, isHeatmap, paramSpecsOf,
      (type, value, extra) => (localTools[type] ? localTools[type]() : onAction({ type, index, value, ...extra })));
    const colorbar = isHeatmap ? createColorbar(subplot, setZ) : null;
    u.root.appendChild(createBadge(u, createTitle(subplot, isHeatmap, loading, (path) => act('removeProduct', path)), colorbar));
    u.root.appendChild(tools.bar);
    const note = coverageNote(subplot);
    if (note) u.root.appendChild(note);
    bindDropTarget(u.root, (path, zone) => {
      if (zone === 'into') act('addProduct', path);
      else onAction({ type: 'insertProduct', index: zone === 'before' ? index : index + 1, path });
    }, (e) => {
      const r = u.root.getBoundingClientRect();
      return dropZone(e.clientY - r.top, r.height);
    });
    u.batch(() => {
      u.setScale('x', { min: view.start, max: view.end });
      if (subplot._yOverride) u.setScale('y', subplot._yOverride);
    });
    u.over.addEventListener('mouseenter', () => { hovered = u; });
    u.over.addEventListener('mouseleave', () => { hovered = null; tooltip.style.display = 'none'; });
    bindGestures(u, {
      getView: () => view,
      setView: (next) => { setView(next); onViewChange(view); },
      setY: (min, max) => setY({ min, max }),
      resetY: () => setY(null),
      markRange: (start, end) => onAction({ type: 'addEvent', index, value: [start, end] }),
      edgeAt: (clientX) => nearestEdge(eventPixels(u), clientX - u.over.getBoundingClientRect().left, EDGE_GRAB_PX),
      eventAt: (clientX) => eventAt(eventPixels(u), clientX - u.over.getBoundingClientRect().left),
      eventSpan: (i) => [intervals[i].t0, intervals[i].t1],
      setEventSpan: (i, t0, t1) => {
        Object.assign(intervals[i], { t0, t1 });
        for (const c of charts) c.u.redraw(false);
      },
      commitEvent: (i) => onAction({ type: 'moveEvent', event: i, value: [intervals[i].t0, intervals[i].t1] }),
    });
    return { u, subplot, meta, colorbar, note };
  }

  function resetY(u, subplot) {
    delete subplot._yOverride;
    u.batch(() => {
      u.setData(u.data, true);
      u.setScale('x', { min: view.start, max: view.end });
    });
  }

  // Each event's [start, stop] in plot-area CSS pixels, as pointer positions are.
  const eventPixels = (u) => intervals.map((iv) => [u.valToPos(iv.t0, 'x'), u.valToPos(iv.t1, 'x')]);

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
    tooltip.innerHTML = tooltipHtml(t, charts, intervals, subplot, yVal, view.end - view.start);
    placeTooltip(tooltip, root, u, left, u.cursor.top);
  }

  return { render, update, setView, getView: () => ({ ...view }), resize: fitHeights, clear, toDataURL };
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

// uPlot's time axis is built on Date, so its ticks stop at 1 ms. Below that, our own
// steps and labels; above, uPlot's (its resolved axis functions, wrapped at init).
const SUB_MS_INCRS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5];
const SUB_MS_SPACE_BELOW_MS = 20, SUB_MS_TICK_SPACE_PX = 80;

function extendTimeAxisBelowMs(u) {
  const axis = u.axes[0];
  const { incrs, splits, values, space } = axis;
  axis.incrs = (...args) => [...SUB_MS_INCRS, ...incrs(...args)];
  // ":02.12345" labels are wider than uPlot's ms ones: ask for more room between ticks.
  axis.space = (self, axisIdx, min, max, dim) => max - min < SUB_MS_SPACE_BELOW_MS ? SUB_MS_TICK_SPACE_PX : space(self, axisIdx, min, max, dim);
  axis.splits = (self, axisIdx, min, max, incr, space) =>
    incr < 1 ? subMsSplits(min, max, incr) : splits(self, axisIdx, min, max, incr, space);
  axis.values = (self, ticks, axisIdx, space, incr) =>
    incr < 1 ? subMsTickLabels(ticks, incr) : values(self, ticks, axisIdx, space, incr);
}

function xAxis(isLast) {
  return isLast
    ? { ...axisBase, size: X_AXIS_PX, values: TIME_TICKS, grid: { show: false } }
    : { ...axisBase, show: false, grid: { show: false } };
}

// The unit is drawn rotated at the gutter's outer edge, inside Y_AXIS_PX: tick values
// get what is left, so labelled and unlabelled subplots keep the same plot-area left.
function yAxisOpts(isHeatmap, unit) {
  return {
    ...axisBase,
    size: unit ? Y_AXIS_PX - Y_UNIT_PX : Y_AXIS_PX,
    label: unit || null,
    labelSize: Y_UNIT_PX,
    labelGap: 0,
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
    const prodLabel = productTitle(prod, cache);
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

// Every distinct unit of a line subplot: products with different units can share one.
const lineUnits = (subplot) => [...new Set(lineProducts(subplot).map(({ cache }) => cache.unit).filter(Boolean))].join(', ');

const productName = (subplot, p) => productTitle(p, subplot.productData[p.path]);

// Hover text: the exact product path, plus its ISTP description when there is one.
function productHover(subplot, p) {
  const desc = subplot.productData[p.path]?.description;
  return p.path + (desc ? ' — ' + desc : '');
}

const yUnit = (subplot, isHeatmap) => (isHeatmap ? firstCache(subplot)?.yAxisUnit || '' : lineUnits(subplot));

// Badge text after the products: the y quantity for spectrograms (its unit, like a line
// plot's, is on the Y axis).
function badgeSuffix(subplot, isHeatmap, loading) {
  const quantity = isHeatmap && firstCache(subplot)?.yAxisName;
  return (quantity ? ' · ' + quantity : '') + (loading ? ' ●' : '');
}

// With several products, each name gets its own remove button (shown on hover). The
// plain text is kept in data-text for the PNG export.
function createTitle(subplot, isHeatmap, loading, removeProduct) {
  const title = el('span', 'pv-header-title');
  const suffix = badgeSuffix(subplot, isHeatmap, loading);
  title.dataset.text = subplot.products.map((p) => productName(subplot, p)).join(', ') + suffix;
  title.title = subplot.products.map((p) => productHover(subplot, p)).join('\n');
  if (subplot.products.length < 2) {
    title.textContent = title.dataset.text;
    return title;
  }
  subplot.products.forEach((p, i) => {
    if (i > 0) title.appendChild(document.createTextNode(', '));
    title.appendChild(document.createTextNode(productName(subplot, p)));
    const x = el('button', 'pv-chip-x');
    x.textContent = '✕';
    x.title = 'Remove ' + productName(subplot, p) + ' from this subplot';
    x.addEventListener('click', () => removeProduct(p.path));
    title.appendChild(x);
  });
  title.appendChild(document.createTextNode(suffix));
  return title;
}

// The legend moves into the badge; only its entries take clicks (toggle a series), the
// rest lets the cursor and drag gestures through to the plot underneath.
function createBadge(u, title, colorbar) {
  const badge = el('div', 'pv-header');
  badge.style.left = (Y_AXIS_PX + BADGE_INSET_PX) + 'px';
  badge.style.top = (CHART_PADDING[0] + BADGE_INSET_PX) + 'px';
  badge.appendChild(title);
  if (colorbar) badge.appendChild(colorbar.node);
  const legend = u.root.querySelector('.u-legend');
  if (legend) badge.appendChild(legend);
  return badge;
}

// Compact horizontal colour bar: low value, colormap gradient, high value, value unit.
// Lives in the badge so spectrograms don't need a wider right gutter than line plots
// (every subplot shares one plot-area width, or the time axes misalign).
// update() re-reads the range: refetches widen it without rebuilding the chart.
// Clicking a limit edits it; setZ(range) receives the new colour range.
function createColorbar(subplot, setZ) {
  const node = el('span', 'pv-colorbar');
  const lo = el('span', 'pv-colorbar-label pv-colorbar-limit');
  const canvas = gradientCanvas(colormapLut(subplot.colormap));
  const hi = el('span', 'pv-colorbar-label pv-colorbar-limit');
  const unit = el('span', 'pv-colorbar-label');
  node.appendChild(lo);
  node.appendChild(canvas);
  node.appendChild(hi);
  node.appendChild(unit);
  const range = () => zRangeOf(subplot, firstCache(subplot));
  const limitEdit = (key) => (value) => {
    const next = { ...range(), [key]: value };
    if (next.vMin < next.vMax && !(subplot.logScale && next.vMin <= 0)) setZ(next);
  };
  editOnClick(lo, limitEdit('vMin'));
  editOnClick(hi, limitEdit('vMax'));
  const colorbar = {
    node, canvas,
    labels: () => [lo.textContent, hi.textContent, unit.textContent],
    update() {
      const cache = firstCache(subplot);
      const { vMin, vMax } = range();
      lo.textContent = colorbarTick(vMin);
      hi.textContent = colorbarTick(vMax);
      unit.textContent = cache?.unit || '';
      node.title = (subplot.logScale ? 'Logarithmic' : 'Linear') + ' colour scale'
        + (subplot._zOverride ? ', range set by hand' : ', following the data') + '. Click a limit to change it.';
    },
  };
  colorbar.update();
  return colorbar;
}

// Click a number to type a new one: Enter or leaving the field applies it, Escape keeps
// the old one. onValue gets a finite number; anything else is ignored.
function editOnClick(label, onValue) {
  label.addEventListener('click', () => {
    const input = el('input', 'pv-colorbar-input');
    input.value = label.textContent;
    let done = false;
    const finish = (apply) => {
      if (done) return;
      done = true;
      const value = Number(input.value.trim());
      input.replaceWith(label);
      if (apply && input.value.trim() !== '' && Number.isFinite(value)) onValue(value);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    label.replaceWith(input);
    input.focus();
    input.select();
  });
}

// Three significant digits: the bar is a rough guide, the tooltip gives exact values.
const colorbarTick = (v) => fmtTick(Number(v.toPrecision(3)));

function gradientCanvas(lut) {
  const canvas = document.createElement('canvas');
  canvas.className = 'pv-colorbar-gradient';
  canvas.width = 256;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(256, 1);
  for (let i = 0; i < 256; i++) {
    img.data.set([lut[i * 3], lut[i * 3 + 1], lut[i * 3 + 2], 255], i * 4);
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// Controls in the plot's top-right corner. Each acts on its own subplot only.
// show(type, on) updates a toggle's state without rebuilding the chart.
function createTools(subplot, isHeatmap, paramSpecsOf, act) {
  const bar = el('div', 'pv-tools');
  bar.style.right = (CHART_PADDING[1] + BADGE_INSET_PX) + 'px';
  bar.style.top = (CHART_PADDING[0] + BADGE_INSET_PX) + 'px';
  const toolClass = (on, extra = '') => 'pv-tool' + (on ? ' active' : '') + extra;
  const buttons = {};
  const tools = [
    { label: 'auto Y', type: 'autoY', on: !subplot._yOverride, title: 'Fit Y to the visible data (off: keep the current Y range)' },
    { label: 'log Y', type: 'logY', on: !!subplot.y_axis.log, title: 'Y axis: logarithmic / linear' },
    isHeatmap && { label: 'auto Z', type: 'autoZ', on: !subplot._zOverride, title: 'Colour range follows the data (off: keep it; or click a colour bar limit to type one)' },
    isHeatmap && { label: 'log Z', type: 'logZ', on: !!subplot.logScale, title: 'Colour scale: logarithmic / linear' },
    { label: '✕', type: 'remove', on: false, title: 'Remove this subplot', extra: ' remove' },
  ].filter(Boolean);
  for (const t of tools) {
    const b = el('button', toolClass(t.on, t.extra));
    b.textContent = t.label;
    b.title = t.title;
    b.addEventListener('click', () => act(t.type));
    bar.appendChild(b);
    buttons[t.type] = b;
  }
  for (const p of paramPickers(subplot, paramSpecsOf, act)) bar.insertBefore(p, buttons.autoY);
  if (isHeatmap) bar.insertBefore(colormapPicker(subplot, act), buttons.remove);
  return { bar, show: (type, on) => { buttons[type].className = toolClass(on); } };
}

function colormapPicker(subplot, act) {
  const names = Object.keys(COLORMAPS).map((name) => [name, name]);
  return picker('Colour map', names, subplot.colormap || 'viridis', (name) => act('colormap', name));
}

// One dropdown per extra parameter (frame, AMDA template argument) of each product.
// The name is in the tooltip to keep the toolbar short; overlays prefix the product.
function paramPickers(subplot, paramSpecsOf, act) {
  const withParams = subplot.products
    .map((prod) => ({ prod, specs: paramSpecsOf(prod.path) }))
    .filter(({ specs }) => specs.length > 0);
  const prefix = (prod) => (withParams.length > 1 ? (prod.label || prod.path) + ' · ' : '');
  return withParams.flatMap(({ prod, specs }) => specs.map((spec) => picker(
    prefix(prod) + spec.label, spec.choices, paramValue(prod, spec),
    (value) => act('productParam', value, { path: prod.path, key: spec.key }), ' pv-param')));
}

function picker(title, choices, value, onPick, extraClass = '') {
  const select = el('select', 'pv-tool' + extraClass);
  select.title = title;
  for (const [label, optionValue] of choices) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = label;
    select.appendChild(option);
  }
  select.value = value;
  select.addEventListener('change', () => onPick(select.value));
  return select;
}

// --- drag and drop of products from the tree ---------------------------------------

const carriesProduct = (e) => Array.from(e.dataTransfer?.types || []).includes(PRODUCT_MIME);

// zoneOf(e) names where on the node the drop would land ('into', 'before', 'after'); the
// node shows it with a matching class (outline, or an insertion line on that edge).
const ZONE_CLASS = { into: 'pv-drop-target', before: 'pv-drop-before', after: 'pv-drop-after' };

function bindDropTarget(node, onDrop, zoneOf = () => 'into') {
  const clear = () => node.classList.remove(...Object.values(ZONE_CLASS));
  node.addEventListener('dragover', (e) => {
    if (!carriesProduct(e)) return;
    e.preventDefault();
    clear();
    node.classList.add(ZONE_CLASS[zoneOf(e)]);
  });
  node.addEventListener('dragleave', clear);
  node.addEventListener('drop', (e) => {
    clear();
    const path = e.dataTransfer.getData(PRODUCT_MIME);
    if (!path) return;
    e.preventDefault();
    onDrop(path, zoneOf(e));
  });
}

// The "new subplot" strip only shows while a product is being dragged.
function watchProductDrags(root) {
  document.addEventListener('dragstart', (e) => { if (carriesProduct(e)) root.classList.add('pv-dragging'); });
  document.addEventListener('dragend', () => root.classList.remove('pv-dragging'));
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
  const { vMin, vMax } = zRangeOf(subplot, cache);
  return renderSpectrogramImage(cache.times, cache.rows, binsOf(cache), vMin, vMax, subplot.logScale, view, subplot.colormap);
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

// On top of everything (uPlot's draw hook runs after the series), so events stay visible:
// a line in the event's hue inside a dark outline, readable over a bright spectrogram too.
// The bottom subplot also carries each event's measurement, just above the time axis,
// as a waveform viewer's ruler does.
function drawIntervalEdges(u, intervals, withMeasurements) {
  const { ctx, bbox } = u;
  const px = Math.max(1, Math.round(globalThis.devicePixelRatio || 1));
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();
  for (const iv of intervals) {
    for (const t of [iv.t0, iv.t1]) {
      const x = Math.round(u.valToPos(t, 'x', true));
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillRect(x - 2 * px, bbox.top, 4 * px, bbox.height);
      ctx.fillStyle = edgeColor(iv.color);
      ctx.fillRect(x - px, bbox.top, 2 * px, bbox.height);
    }
    if (withMeasurements) drawMeasurement(u, iv, px);
  }
  ctx.restore();
}

// |<-- 4h 42m -->| between the edges, near the bottom; beside the stop edge when the text
// does not fit between them.
function drawMeasurement(u, iv, px) {
  const { ctx, bbox } = u;
  const [x0, x1] = [u.valToPos(iv.t0, 'x', true), u.valToPos(iv.t1, 'x', true)].sort((a, b) => a - b);
  const y = bbox.top + bbox.height - 10 * px;
  const text = formatDuration(Math.abs(iv.t1 - iv.t0));
  ctx.font = `${11 * px}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';  // uPlot leaves 'center' from its axis labels
  const w = ctx.measureText(text).width + 8 * px, h = 14 * px;
  const color = edgeColor(iv.color);
  const fits = x1 - x0 >= w + 16 * px;
  if (fits) {
    ctx.strokeStyle = color;
    ctx.lineWidth = px;
    ctx.beginPath();
    ctx.moveTo(x0 + 2 * px, y); ctx.lineTo(x1 - 2 * px, y);
    for (const [tip, dir] of [[x0 + 2 * px, 1], [x1 - 2 * px, -1]]) {
      ctx.moveTo(tip + dir * 5 * px, y - 3 * px); ctx.lineTo(tip, y); ctx.lineTo(tip + dir * 5 * px, y + 3 * px);
    }
    ctx.stroke();
  }
  const left = fits ? (x0 + x1 - w) / 2 : x1 + 4 * px;
  ctx.fillStyle = 'rgba(11, 14, 23, 0.85)';
  ctx.fillRect(left, y - h / 2, w, h);
  ctx.fillStyle = '#e0e6f0';
  ctx.fillText(text, left + 4 * px, y);
}

// --- tooltip content ---------------------------------------------------------------

function tooltipHtml(t, charts, intervals, hoveredSubplot, yVal, viewSpan) {
  let html = '<b>' + fmtInstant(t, viewSpan) + '</b><br/>';
  for (const iv of intervals) {
    if (t < Math.min(iv.t0, iv.t1) || t > Math.max(iv.t0, iv.t1)) continue;
    html += swatch(iv.color, 2) + (iv.label ? '<b>' + escapeHtml(iv.label) + '</b> · ' : 'Event · ')
      + formatDuration(Math.abs(iv.t1 - iv.t0)) + '<br/>';
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
  for (const { u, meta, colorbar } of charts) {
    const canvas = u.ctx.canvas;
    const r = canvas.getBoundingClientRect();
    ctx.drawImage(canvas, r.left - rootRect.left, r.top - rootRect.top, r.width, r.height);
    const x = r.left - rootRect.left + Y_AXIS_PX + BADGE_INSET_PX;
    const y = r.top - rootRect.top + CHART_PADDING[0] + BADGE_INSET_PX + 8;
    const title = u.root.querySelector('.pv-header-title')?.dataset.text || '';
    ctx.fillStyle = MUTED;
    ctx.fillText(title, x, y);
    const after = x + ctx.measureText(title).width + 12;
    if (colorbar) drawColorbar(ctx, colorbar, after, y);
    else if (u.series.length > 2) drawLegendRow(ctx, u, meta, after, y);
  }
  return out.toDataURL('image/png');
}

function drawColorbar(ctx, colorbar, x, y) {
  const [lo, hi, unit] = colorbar.labels();
  ctx.fillStyle = '#e0e6f0';
  ctx.fillText(lo, x, y);
  x += ctx.measureText(lo).width + 4;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(colorbar.canvas, x, y - COLORBAR_H / 2, COLORBAR_W, COLORBAR_H);
  x += COLORBAR_W + 4;
  ctx.fillText(hi + (unit ? ' ' + unit : ''), x, y);
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

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function el(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
