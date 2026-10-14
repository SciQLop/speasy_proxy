// Opt-in chart layer of /plot (?backend=sciqlopplots): the interface of plot-view.js,
// drawn by SciQLopPlots built for WebAssembly (its sciqlopplots.mjs library), served at
// /sciqlopplots/ when the proxy has SPEASY_PROXY_SCIQLOPPLOTS_PATH. Qt draws the whole
// panel: pan/zoom, the shared time axis, legends and the crosshair are SciQLopPlots' own.
// simplify: no per-subplot toolbar or badges, and events are shown read-only (no
// Shift+drag to add one, no dragging to move one). Port them once this backend is kept.
import { productTitle, dropZone } from './plot-core.js';
import { utcMs } from './common.js';
import { PRODUCT_MIME } from './plot-view.js';

// The uPlot view's colours (plot-view.js), so both backends look the same on the page.
const THEME = {
  background: '#0b0e17', foreground: '#8892b0', grid: '#1e2640', subGrid: '#141a2e',
  selection: '#6b8afd', legendBackground: '#1a1f36', legendBorder: '#2a3358',
};
const MS_PER_S = 1e3;  // plot.js works in ms, SciQLopPlots in seconds
const SAME_VIEW_MS = 1e-3;

const seconds = (ms) => Float64Array.from(ms, (t) => t / MS_PER_S);
const numberOrNaN = (v) => (v == null ? Number.NaN : v);

// Times in seconds and one column per component of a line product.
export function lineColumns(cache) {
  return {
    t: seconds(cache.times),
    columns: cache.columnNames.map((name) => Float64Array.from(cache.columns[name], numberOrNaN)),
  };
}

// The onAction a product dropped offsetY px down a panel of `height` px with `count`
// subplots asks for: into a subplot, or a new one on its edge (dropZone), as in plot-view.js.
// simplify: the library gives no plot geometry, so subplots are taken as equal slices of the
// panel; a drop near a border can land one subplot off. Ask SciQLopPlots for plot rects to fix.
export function dropAction(offsetY, height, count) {
  if (count === 0) return { type: 'addProduct', index: null };
  const slice = height / count;
  const index = Math.min(count - 1, Math.floor(offsetY / slice));
  const zone = dropZone(offsetY - index * slice, slice);
  if (zone === 'into') return { type: 'addProduct', index };
  return { type: 'insertProduct', index: zone === 'before' ? index : index + 1 };
}

// A spectrogram: one shared y axis, or one per row (n × m) when its channels change over time.
export function colormapArrays(cache) {
  const width = Math.max(0, ...cache.yTables.map((table) => table.length));
  const shared = cache.yTables.length === 1;
  return {
    t: seconds(cache.times),
    y: shared ? Float64Array.from(cache.yTables[0]) : padded(cache.yIndex.map((i) => cache.yTables[i]), width),
    z: padded(cache.rows, width),
  };
}

function padded(rows, width) {
  const out = new Float64Array(rows.length * width).fill(Number.NaN);
  rows.forEach((row, i) => row?.forEach((v, j) => { out[i * width + j] = numberOrNaN(v); }));
  return out;
}

const isHeatmap = (sp) => sp.plotType === 'heatmap' && !!sp.productData[sp.products[0]?.path]?.yTables;

// The products a subplot draws: its first one as a spectrogram, or every line product.
function drawables(sp) {
  const withCache = sp.products.map((prod) => ({ prod, cache: sp.productData[prod.path] }));
  return isHeatmap(sp)
    ? withCache.slice(0, 1)
    : withCache.filter(({ cache }) => cache && cache.columnNames.length > 0);
}

function yLabel(sp) {
  const units = drawables(sp).map(({ cache }) => (isHeatmap(sp) ? cache.yAxisUnit : cache.unit));
  return [...new Set(units.filter(Boolean))].join(', ');
}

async function loadSciQLopPlots(root) {
  const base = `${window.SPEASY_BASE_URL}/sciqlopplots/`;
  const { load } = await import(base + 'sciqlopplots.mjs');
  const spz = await load({ base });
  return spz.panel(root, { theme: { base: 'dark', colors: THEME } });
}

export function createPlotView(root, { onViewChange, onAction = () => {} }) {
  let panel = null;
  let plots = [];
  let intervals = [];
  let slots = [];   // per subplot: { plot, items: Map(product path → Graph or ColorMap) }
  let spans = [];
  let view = { start: null, end: null };

  bindProductDrops(root, (offsetY, height, path) => onAction({ ...dropAction(offsetY, height, plots.length), path }));
  loadSciQLopPlots(root)
    .then((loaded) => {
      panel = loaded;
      panel.on('timeRangeChanged', onTimeRangeChanged);
      draw();
    })
    .catch((e) => {
      root.textContent = 'SciQLopPlots could not start: ' + e;
      console.error(e);
    });

  // Setting the range from here echoes back: only a user's pan or zoom is a view change.
  function onTimeRangeChanged(start, stop) {
    const next = { start: start * MS_PER_S, end: stop * MS_PER_S };
    if (Math.abs(next.start - view.start) < SAME_VIEW_MS && Math.abs(next.end - view.end) < SAME_VIEW_MS) return;
    view = next;
    onViewChange({ ...view });
  }

  function render(nextPlots, nextView, opts = {}) {
    plots = nextPlots;
    intervals = opts.intervals || [];
    view = { ...nextView };
    draw();
  }

  function update(nextPlots) {
    plots = nextPlots;
    if (!panel) return;
    if (slots.length !== plots.length) draw();
    else plots.forEach((sp, i) => fill(sp, slots[i]));
  }

  function setView(next) {
    view = { start: next.start, end: next.end };
    showView();
  }

  function clear() {
    plots = [];
    intervals = [];
    removeSpans();
    slots = [];
    panel?.clear();
  }

  // A new plot fits its y axis to the data in view, so the time range goes first.
  function draw() {
    if (!panel) return;
    removeSpans();
    panel.clear();
    showView();
    slots = plots.map(addSlot);
    plots.forEach((sp, i) => fill(sp, slots[i]));
    spans = intervals.map(addSpan);
  }

  function showView() {
    if (panel && view.start != null) panel.setTimeRange(view.start / MS_PER_S, view.end / MS_PER_S);
  }

  function addSpan(iv) {
    return panel.addSpan(utcMs(iv.start) / MS_PER_S, utcMs(iv.stop) / MS_PER_S,
      { color: iv.color, tooltip: iv.label || '', readOnly: true });
  }

  function removeSpans() {
    spans.forEach((span) => span.remove());
    spans = [];
  }

  function addSlot(sp) {
    const plot = panel.addPlot();
    plot.setAxis('y', isHeatmap(sp) ? { label: yLabel(sp) } : { label: yLabel(sp), log: !!sp.y_axis?.log });
    return { plot, items: new Map() };
  }

  function fill(sp, slot) {
    const heatmap = isHeatmap(sp);
    const nProducts = drawables(sp).length;
    for (const { prod, cache } of drawables(sp)) {
      const item = slot.items.get(prod.path);
      if (!cache || (!item && cache.times.length === 0)) continue;
      slot.items.set(prod.path, heatmap
        ? fillColormap(sp, slot.plot, item, prod, cache)
        : fillLine(slot.plot, item, prod, cache, nProducts));
    }
  }

  function fillLine(plot, graph, prod, cache, nProducts) {
    const { t, columns } = lineColumns(cache);
    if (graph) { graph.setData(t, columns); return graph; }
    const name = productTitle(prod, cache);
    const labels = cache.columnNames.map((c) => (nProducts > 1 ? `${name} ${c}` : c));
    return plot.line(t, columns, { labels });
  }

  function fillColormap(sp, plot, map, prod, cache) {
    const { t, y, z } = colormapArrays(cache);
    if (map) { map.setData(t, y, z); return map; }
    return plot.colormap(t, y, z, { name: productTitle(prod, cache), yLog: !!sp.y_axis?.log, zLog: !!sp.logScale });
  }

  // plot.js downloads this URL; a blob: URL, which it revokes after the download starts.
  function toDataURL() {
    return panel ? URL.createObjectURL(panel.export('png')) : null;
  }

  return {
    render, update, setView, clear, toDataURL,
    getView: () => ({ ...view }),
    resize: () => {},          // Qt follows its container's size itself
  };
}

const carriesProduct = (e) => Array.from(e.dataTransfer?.types || []).includes(PRODUCT_MIME);

// Capture phase: Qt's canvas inside root handles drag events for its own widgets.
function bindProductDrops(root, onDrop) {
  root.addEventListener('dragover', (e) => {
    if (carriesProduct(e)) e.preventDefault();
  }, { capture: true });
  root.addEventListener('drop', (e) => {
    const path = e.dataTransfer?.getData(PRODUCT_MIME);
    if (!path) return;
    e.preventDefault();
    e.stopPropagation();
    const r = root.getBoundingClientRect();
    onDrop(e.clientY - r.top, r.height, path);
  }, { capture: true });
}
