// Opt-in chart layer of /plot (?backend=sciqlopplots): the interface of plot-view.js,
// drawn by SciQLopPlots built for WebAssembly, served at /sciqlopplots/ when the proxy
// has SPEASY_PROXY_SCIQLOPPLOTS_PATH. Qt draws the whole panel: pan/zoom, the shared time
// axis, legends and the crosshair are SciQLopPlots' own.
// simplify: no per-subplot toolbar, badges, drop targets, intervals or PNG export yet;
// products are added with the tree's + button. Port them once this backend is kept.
import { productTitle } from './plot-core.js';

// The uPlot view's colours (plot-view.js), so both backends look the same on the page.
const THEME = {
  background: '#0b0e17', foreground: '#8892b0', grid: '#1e2640', subGrid: '#141a2e',
  selection: '#6b8afd', legendBackground: '#1a1f36', legendBorder: '#2a3358',
};
const MS_PER_S = 1e3;  // plot.js works in ms, SciQLopPlots in seconds
const SAME_VIEW_MS = 1e-3;

const seconds = (ms) => Float64Array.from(ms, (t) => t / MS_PER_S);
const numberOrNaN = (v) => (v == null ? Number.NaN : v);

// Row-major [n, columns] values of a line product.
export function lineArrays(cache) {
  const n = cache.times.length, width = cache.columnNames.length;
  const values = new Float64Array(n * width);
  cache.columnNames.forEach((name, c) =>
    cache.columns[name].forEach((v, i) => { values[i * width + c] = numberOrNaN(v); }));
  return { t: seconds(cache.times), values, shape: [n, width] };
}

// A spectrogram: one shared y axis, or one per row when its channels change over time.
export function colormapArrays(cache) {
  const n = cache.times.length;
  const width = Math.max(0, ...cache.yTables.map((table) => table.length));
  const shared = cache.yTables.length === 1;
  return {
    t: seconds(cache.times),
    y: shared ? Float64Array.from(cache.yTables[0]) : padded(cache.yIndex.map((i) => cache.yTables[i]), width),
    yShape: shared ? [width] : [n, width],
    z: padded(cache.rows, width),
    zShape: [n, width],
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

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error('could not load ' + src));
    document.head.appendChild(script);
  });
}

// Qt's loader replaces Emscripten's locateFile and drops the script's directory, so the
// .wasm would be looked for next to the page: give its full URL.
async function loadSciQLopPlots(root) {
  const base = `${window.SPEASY_BASE_URL}/sciqlopplots/`;
  await loadScript(base + 'sciqlopplots.js');
  await loadScript(base + 'qtloader.js');
  return window.qtLoad({
    locateFile: (file) => base + file,
    qt: { entryFunction: window.sciqlopplots_entry, containerElements: [root] },
  });
}

export function createPlotView(root, { onViewChange }) {
  let spz = null;
  let plots = [];
  let slots = [];   // per subplot: { plot: id, items: Map(product path → plottable id) }
  let view = { start: null, end: null };

  loadSciQLopPlots(root)
    .then((module) => {
      spz = module;
      spz.setTheme('dark', THEME);
      spz.onTimeRangeChanged(onTimeRangeChanged);
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

  function render(nextPlots, nextView) {
    plots = nextPlots;
    view = { ...nextView };
    draw();
  }

  function update(nextPlots) {
    plots = nextPlots;
    if (!spz) return;
    if (slots.length !== plots.length) draw();
    else plots.forEach((sp, i) => fill(sp, slots[i]));
  }

  function setView(next) {
    view = { start: next.start, end: next.end };
    showView();
  }

  function clear() {
    plots = [];
    slots = [];
    spz?.clear();
  }

  // A new plot fits its y axis to the data in view, so the time range goes first.
  function draw() {
    if (!spz) return;
    spz.clear();
    showView();
    slots = plots.map(addSlot);
    plots.forEach((sp, i) => fill(sp, slots[i]));
  }

  function showView() {
    if (spz && view.start != null) spz.setTimeRange(view.start / MS_PER_S, view.end / MS_PER_S);
  }

  function addSlot(sp) {
    const plot = spz.addPlot();
    if (!isHeatmap(sp)) spz.setYLog(plot, !!sp.y_axis?.log);
    spz.setYLabel(plot, yLabel(sp));
    return { plot, items: new Map() };
  }

  function fill(sp, slot) {
    const heatmap = isHeatmap(sp);
    const lineProducts = drawables(sp).length;
    for (const { prod, cache } of drawables(sp)) {
      const id = slot.items.get(prod.path);
      if (!cache || (id == null && cache.times.length === 0)) continue;
      const created = heatmap ? fillColormap(sp, slot.plot, id, prod, cache) : fillLine(slot.plot, id, prod, cache, lineProducts);
      slot.items.set(prod.path, created);
    }
  }

  function fillLine(plot, id, prod, cache, nProducts) {
    const { t, values, shape } = lineArrays(cache);
    return withBuffers([[t, [t.length]], [values, shape]], (x, y) => {
      if (id != null) { spz.setLineData(id, x, y); return id; }
      const name = productTitle(prod, cache);
      const labels = cache.columnNames.map((c) => (nProducts > 1 ? `${name} ${c}` : c));
      return spz.line(plot, x, y, labels);
    });
  }

  function fillColormap(sp, plot, id, prod, cache) {
    const { t, y, yShape, z, zShape } = colormapArrays(cache);
    return withBuffers([[t, [t.length]], [y, yShape], [z, zShape]], (x, yb, zb) => {
      if (id != null) { spz.setColormapData(id, x, yb, zb); return id; }
      return spz.colormap(plot, x, yb, zb, productTitle(prod, cache), !!sp.y_axis?.log, !!sp.logScale);
    });
  }

  // Embind objects live in wasm memory until deleted; SciQLopPlots keeps its own copy.
  function withBuffers(arrays, use) {
    const buffers = arrays.map(([array, shape]) => spz.Buffer.fromArray(array, shape));
    try {
      return use(...buffers);
    } finally {
      buffers.forEach((b) => b.delete());
    }
  }

  return {
    render, update, setView, clear,
    getView: () => ({ ...view }),
    resize: () => {},          // Qt follows its container's size itself
    toDataURL: () => null,
  };
}
