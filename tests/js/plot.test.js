import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { installPlotDom } from './helpers/dom-mock.js';

import * as apiClient from '../../speasy_proxy/static/js/api-client.js';
import uPlot from '../../speasy_proxy/static/js/vendor/uPlot.esm.js';

vi.mock('../../speasy_proxy/static/js/api-client.js', () => ({
  fetchData: vi.fn(() => Promise.resolve(null)),
  fetchInventory: vi.fn(() => Promise.resolve({})),
}));

// Stand-in for the vendored uPlot: records construction and the calls plot-view makes.
vi.mock('../../speasy_proxy/static/js/vendor/uPlot.esm.js', () => {
  const node = () => ({
    addEventListener() {}, appendChild() {}, contains: () => true, querySelector: () => null,
    getBoundingClientRect: () => ({ left: 64, top: 0, width: 736, height: 200, bottom: 200 }),
    clientWidth: 736, clientHeight: 200, style: {},
  });
  class FakeUPlot {
    constructor(opts, data, target) {
      this.opts = opts;
      this.data = data;
      this.series = opts.series.map((sr) => ({ show: true, ...sr }));
      this.scales = { x: { min: 0, max: 1 }, y: { min: 0, max: 1, distr: opts.scales.y.distr } };
      this.root = node();
      this.over = node();
      this.bbox = { left: 64, top: 0, width: 736, height: 200 };
      this.ctx = { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, fillRect() {}, drawImage: vi.fn(), canvas: {} };
      this.cursor = { left: -1, top: -1 };
      this.destroyed = false;
      target.appendChild(this.root);
      FakeUPlot.instances.push(this);
    }
    batch(fn) { fn(); }
    setData(data) { this.data = data; }
    setScale(key, range) { Object.assign(this.scales[key], range); }
    setSize() {}
    redraw() {}
    destroy() { this.destroyed = true; }
    valToPos(v) { return v; }
    posToVal(p) { return p; }
  }
  FakeUPlot.instances = [];
  FakeUPlot.pxRatio = 1;
  FakeUPlot.tzDate = (d) => d;
  FakeUPlot.rangeNum = (a, b) => [a, b];
  FakeUPlot.rangeLog = (a, b) => [a, b];
  FakeUPlot.join = vi.fn((tables) => [tables[0][0], ...tables.flatMap((t) => t.slice(1))]);
  return { default: FakeUPlot };
});

// Deployed behind a reverse proxy: root_path prefix in the base URL, and the browser
// path already carries it.
const dom = installPlotDom({ baseUrl: 'https://host/cache', pathname: '/cache/plot', origin: 'https://host' });
const plot = await import('../../speasy_proxy/static/js/plot.js');
const {
  plotState, initChart, renderAllSubplots, removeProductFromSubplot,
  updateShareURL, mergeProductData, bindControls, applyScaleHints, applyConfig,
  renderProductParams, collectProductParams, onProductParamsChanged,
} = plot.__test__;

afterAll(() => dom.restore());

function heatmapSubplot() {
  const path = 'cda/flux';
  return {
    products: [{ path, label: 'flux' }],
    y_axis: { log: false },
    logScale: true,
    plotType: 'heatmap',
    lastHeatmapImg: null,
    productData: {
      [path]: {
        path,
        intervals: [[0, 3000]],
        fetchSpan: 3000,
        times: [1000, 2000, 3000],
        columns: {},
        columnNames: [],
        unit: '',
        yAxis: [1, 2, 3],
        yAxisName: 'energy',
        yAxisUnit: 'eV',
        rows: [[1, 2, 3], [4, 5, 6], [7, 8, 9]],
        displayType: 'spectrogram',
        valueRange: { vMin: 1, vMax: 9 },
      },
    },
  };
}

function lineCache(path, displayType) {
  return {
    path,
    intervals: [[0, 2000]],
    fetchSpan: 2000,
    times: [1000, 2000],
    columns: { v: [1, 2] },
    columnNames: ['v'],
    unit: 'nT',
    yAxis: null,
    yAxisName: '',
    yAxisUnit: '',
    rows: [],
    displayType,
    valueRange: null,
  };
}

function spectrogramResponse(rows, startNs = 1e6) {
  return {
    axes: [
      { values: rows.map((_, i) => startNs + i * 1e9) },
      { values: [1, 2, 3], name: 'energy', meta: { UNITS: 'eV' } },
    ],
    values: { values: rows, meta: { DISPLAY_TYPE: 'spectrogram' } },
    columns: [],
  };
}

beforeEach(() => {
  plotState.plots = [];
  plotState.time_range = { start: null, stop: null };
});

const liveCharts = () => uPlot.instances.filter((u) => !u.destroyed);
const createEmptyCache = (path) => ({
  path, intervals: [], fetchSpan: 0, times: [], columns: {}, columnNames: [], unit: '',
  yAxis: null, yAxisName: '', yAxisUnit: '', rows: [], displayType: '', valueRange: null,
});

describe('rendering subplots with uPlot', () => {
  beforeEach(() => { uPlot.instances.length = 0; });

  it('paints the spectrogram image from the heatmap subplot\'s draw hook', () => {
    initChart();
    plotState.plots = [heatmapSubplot()];
    plotState.time_range = { start: new Date(0).toISOString(), stop: new Date(4000).toISOString() };

    expect(() => renderAllSubplots()).not.toThrow();

    const [u] = liveCharts();
    expect(plotState.plots[0].lastHeatmapImg?.canvas).toBeTruthy();
    for (const hook of u.opts.hooks.drawClear) hook(u);
    // one source row per bin, each drawn between that bin's own edges
    const img = plotState.plots[0].lastHeatmapImg;
    expect(u.ctx.drawImage).toHaveBeenCalledWith(img.canvas, 0, expect.any(Number), img.canvas.width, 1,
      expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number));
    expect(u.ctx.drawImage).toHaveBeenCalledTimes(img.canvas.height);
  });

  it('builds one chart per subplot, all on the requested time window', () => {
    initChart();
    plotState.plots = [
      { ...heatmapSubplot() },
      { products: [{ path: 'cda/b' }], y_axis: { log: false }, plotType: 'line', productData: { 'cda/b': lineCache('cda/b', '') } },
    ];
    plotState.time_range = { start: new Date(500).toISOString(), stop: new Date(2500).toISOString() };

    renderAllSubplots();

    const charts = liveCharts();
    expect(charts).toHaveLength(2);
    for (const u of charts) expect(u.scales.x).toMatchObject({ min: 500, max: 2500 });
  });

  it('swaps data into the existing charts on a data-only refresh instead of rebuilding', () => {
    initChart();
    const cache = lineCache('cda/b', '');
    plotState.plots = [{ products: [{ path: 'cda/b' }], y_axis: { log: false }, plotType: 'line', productData: { 'cda/b': cache } }];
    plotState.time_range = { start: new Date(0).toISOString(), stop: new Date(3000).toISOString() };
    renderAllSubplots();
    const [u] = liveCharts();

    cache.times = [1000, 2000, 2500];
    cache.columns.v = [1, 2, 3];
    renderAllSubplots(true, true);

    expect(liveCharts()).toEqual([u]);
    expect(u.data).toEqual([[1000, 2000, 2500], [1, 2, 3]]);
  });

  it('keeps one data column per series when a pan trims a product\'s cache empty', () => {
    // Panning away from a sparse product's data: the refetch returns nothing for it and
    // trimCacheWindow empties its cache, but the structure is unchanged, so the charts
    // get a data-only update. uPlot needs exactly one data column per series.
    initChart();
    const cache = lineCache('cda/b', '');
    plotState.plots = [{ products: [{ path: 'cda/b' }], y_axis: { log: false }, plotType: 'line', productData: { 'cda/b': cache } }];
    renderAllSubplots();
    const [u] = liveCharts();

    cache.times = [];
    cache.columns.v = [];
    renderAllSubplots(true, true);

    expect(u.data).toHaveLength(u.series.length);
  });

  it('names series by column, product, or both depending on the subplot', () => {
    initChart();
    const threeCols = { ...lineCache('amda/imf', ''), columnNames: ['bx', 'by', 'bz'], columns: { bx: [1, 2], by: [1, 2], bz: [1, 2] } };
    const oneCol = { ...lineCache('amda/ae', ''), columnNames: ['col_0'], columns: { col_0: [1, 2] } };
    plotState.plots = [
      { products: [{ path: 'amda/imf', label: 'OMNI B' }], y_axis: { log: false }, plotType: 'line', productData: { 'amda/imf': threeCols } },
      { products: [{ path: 'amda/ae', label: 'AE' }], y_axis: { log: false }, plotType: 'line', productData: { 'amda/ae': oneCol } },
      { products: [{ path: 'amda/imf', label: 'OMNI B' }, { path: 'amda/ae', label: 'AE' }], y_axis: { log: false }, plotType: 'line',
        productData: { 'amda/imf': threeCols, 'amda/ae': oneCol } },
    ];
    renderAllSubplots();

    const labels = liveCharts().map((u) => u.series.slice(1).map((sr) => sr.label));
    expect(labels[0]).toEqual(['bx', 'by', 'bz']);             // the title names the product
    expect(labels[1]).toEqual(['AE']);                         // never the generated 'col_0'
    expect(labels[2]).toEqual(['OMNI B bx', 'OMNI B by', 'OMNI B bz', 'AE']);
    expect(liveCharts().map((u) => u.opts.legend.show)).toEqual([true, false, true]);
  });

  it('puts the unit on the Y axis and the name in the badge, without widening the gutter', () => {
    initChart();
    const unitless = { ...lineCache('cda/c', ''), unit: '' };
    plotState.plots = [
      { products: [{ path: 'cda/b', label: 'OMNI B' }], y_axis: { log: false }, plotType: 'line', productData: { 'cda/b': lineCache('cda/b', '') } },
      heatmapSubplot(),
      { products: [{ path: 'cda/c', label: 'count' }], y_axis: { log: false }, plotType: 'line', productData: { 'cda/c': unitless } },
    ];
    renderAllSubplots();

    const titles = dom.created.filter((e) => e.className === 'pv-header-title').slice(-3).map((e) => e.textContent);
    expect(titles).toEqual(['OMNI B', 'flux · energy', 'count']);
    const yAxes = liveCharts().map((u) => u.opts.axes[1]);
    expect(yAxes.map((a) => a.label ?? null)).toEqual(['nT', 'eV', null]);
    // every subplot's plot area starts at the same x, labelled or not
    expect(yAxes.map((a) => a.size + (a.label != null ? a.labelSize : 0))).toEqual([64, 64, 64]);
  });

  it('puts every product of a subplot on one joined time axis', () => {
    initChart();
    plotState.plots = [{
      products: [{ path: 'cda/a' }, { path: 'cda/b' }], y_axis: { log: false }, plotType: 'line',
      productData: { 'cda/a': lineCache('cda/a', ''), 'cda/b': lineCache('cda/b', '') },
    }];
    renderAllSubplots();

    expect(uPlot.join).toHaveBeenCalled();
    expect(liveCharts()[0].series).toHaveLength(3); // time + one column per product
  });
});

describe('applying a config with a zero-width time range', () => {
  // The legacy ?path=&start=&stop= URL format (still generated for old bookmarks/links)
  // passes start/stop straight through unvalidated. A bare "YYYY-MM-DD" used for both --
  // e.g. someone linking to "that day's data" -- parses as the exact same UTC midnight for
  // both fields, producing a zero-width request the backend always rejects as invalid.
  it('expands stop when a bare-date URL gives identical start and stop', () => {
    initChart();
    applyConfig({
      version: 1,
      time_range: { start: '2026-08-20', stop: '2026-08-20' },
      plots: [{ products: [{ path: 'amda/imf' }], y_axis: { log: false } }],
    });

    const startMs = new Date(plotState.time_range.start).getTime();
    const stopMs = new Date(plotState.time_range.stop).getTime();
    expect(stopMs).toBeGreaterThan(startMs);
  });
});

describe('per-product extra params (AMDA template args, SSC/3DView frames)', () => {
  beforeEach(() => {
    plot.__test__.__resetCdpp3dviewFramesCache();
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
  });

  it('renders no params for a plain ParameterIndex', () => {
    renderProductParams({ __spz_type__: 'ParameterIndex', __spz_provider__: 'amda' });
    expect(collectProductParams()).toEqual({});
  });

  it('builds one select per AMDA templated-parameter argument, defaulted', () => {
    renderProductParams({
      __spz_type__: 'TemplatedParameterIndex',
      __spz_provider__: 'amda',
      __spz_arguments__: {
        __spz_type__: 'ArgumentListIndex',
        side: {
          __spz_type__: 'ArgumentIndex', key: 'side', name: 'Side', default: '0',
          choices: [['Side 0', '0'], ['Side 1', '1'], ['Side 2', '2']],
        },
      },
    });
    expect(collectProductParams()).toEqual({ productInputs: { side: '0' } });
  });

  it('defaults an SSC product to a gse coordinate_system dropdown', () => {
    renderProductParams({ __spz_type__: 'ParameterIndex', __spz_provider__: 'ssc' });
    expect(collectProductParams()).toEqual({ coordinateSystem: 'gse' });
  });

  it('defaults a 3DView product to a J2000 coordinate_frame dropdown', () => {
    renderProductParams({ __spz_type__: 'ParameterIndex', __spz_provider__: 'cdpp3dview' });
    expect(collectProductParams()).toEqual({ coordinateSystem: 'J2000' });
  });

  it('replaces the 3DView frame list once the live list arrives', async () => {
    // A list that does NOT include the hardcoded 'J2000' placeholder, so a changed
    // selected value proves the live list actually replaced it (not a no-op).
    globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ frames: ['GSE', 'GSM'] }) });
    renderProductParams({ __spz_type__: 'ParameterIndex', __spz_provider__: 'cdpp3dview' });
    await new Promise((r) => setTimeout(r, 0));
    expect(collectProductParams()).toEqual({ coordinateSystem: 'GSE' });
  });

  it('a preset value overrides the AMDA argument default', () => {
    renderProductParams({
      __spz_type__: 'TemplatedParameterIndex',
      __spz_provider__: 'amda',
      __spz_arguments__: {
        __spz_type__: 'ArgumentListIndex',
        side: {
          __spz_type__: 'ArgumentIndex', key: 'side', name: 'Side', default: '0',
          choices: [['Side 0', '0'], ['Side 1', '1'], ['Side 2', '2']],
        },
      },
    }, { productInputs: { side: '2' } });
    expect(collectProductParams()).toEqual({ productInputs: { side: '2' } });
  });

  it('a preset value overrides the SSC coordinate_system default', () => {
    renderProductParams({ __spz_type__: 'ParameterIndex', __spz_provider__: 'ssc' },
      { coordinateSystem: 'gsm' });
    expect(collectProductParams()).toEqual({ coordinateSystem: 'gsm' });
  });

  it('a preset 3DView frame survives the live frame list arriving afterwards', async () => {
    globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ frames: ['J2000', 'GSE'] }) });
    renderProductParams({ __spz_type__: 'ParameterIndex', __spz_provider__: 'cdpp3dview' },
      { coordinateSystem: 'GSE' });
    await new Promise((r) => setTimeout(r, 0));
    expect(collectProductParams()).toEqual({ coordinateSystem: 'GSE' });
  });

  it('a later selection is not clobbered by a slow-to-arrive 3DView frame list', async () => {
    let resolveFrames;
    globalThis.fetch = () => new Promise((resolve) => {
      resolveFrames = () => resolve({ ok: true, json: () => Promise.resolve({ frames: ['J2000', 'GSE'] }) });
    });
    renderProductParams({ __spz_type__: 'ParameterIndex', __spz_provider__: 'cdpp3dview' });
    renderProductParams({ __spz_type__: 'ParameterIndex', __spz_provider__: 'ssc' });
    resolveFrames();
    await new Promise((r) => setTimeout(r, 0));
    expect(collectProductParams()).toEqual({ coordinateSystem: 'gse' });
  });
});

describe('changing a param select on an already-plotted product', () => {
  beforeEach(() => {
    plot.__test__.__resetCdpp3dviewFramesCache();
    apiClient.fetchData.mockClear();
  });

  it('wires a change listener to onProductParamsChanged', () => {
    renderProductParams({ __spz_type__: 'ParameterIndex', __spz_provider__: 'ssc' });
    const select = dom.created.filter(el => el.tagName === 'SELECT').at(-1);
    expect(select.addEventListener).toHaveBeenCalledWith('change', onProductParamsChanged);
  });

  it('does nothing if the product is not part of the current plot yet', () => {
    plot.__test__.setSelectedProduct('ssc/ace');
    renderProductParams({ __spz_type__: 'ParameterIndex', __spz_provider__: 'ssc' });
    plotState.plots = [];

    onProductParamsChanged();

    expect(apiClient.fetchData).not.toHaveBeenCalled();
  });

  it('drops the stale cache and re-fetches with the new coordinate_system', async () => {
    plot.__test__.setSelectedProduct('ssc/ace');
    renderProductParams({ __spz_type__: 'ParameterIndex', __spz_provider__: 'ssc' });

    const staleCache = { path: 'ssc/ace', marker: 'stale-gse-data' };
    plotState.plots = [{
      products: [{ path: 'ssc/ace', label: 'ace', coordinateSystem: 'gse' }],
      productData: { 'ssc/ace': staleCache },
      y_axis: { log: false },
      plotType: 'line',
      _yScaleAuto: true, _zScaleAuto: true,
    }];
    plotState.time_range = { start: '2020-01-01T00:00:00.000Z', stop: '2020-01-02T00:00:00.000Z' };

    // Simulate picking a different coordinate system in the dropdown.
    const select = dom.created.filter(el => el.tagName === 'SELECT').at(-1);
    select.value = 'gsm';

    onProductParamsChanged();
    await Promise.resolve(); await Promise.resolve();

    expect(plotState.plots[0].products[0].coordinateSystem).toBe('gsm');
    expect(plotState.plots[0].productData['ssc/ace']).not.toBe(staleCache);
    expect(apiClient.fetchData).toHaveBeenCalled();
    const call = apiClient.fetchData.mock.calls[0][0];
    expect(call.path).toBe('ssc/ace');
    expect(call.coordinateSystem).toBe('gsm');
  });
});

describe('restoring the params box after a page refresh', () => {
  const sscTree = {
    ssc: {
      Trajectories: {
        ace: {
          __spz_type__: 'ParameterIndex', __spz_provider__: 'ssc',
          __spz_uid__: 'ace', __spz_name__: 'ACE',
        },
      },
    },
  };

  beforeEach(() => {
    apiClient.fetchInventory.mockReset();
    plot.__test__.setSelectedProduct(null);
    plotState.plots = [];
    // productParamSelects/productParamsKind are module-private and only reset by
    // renderProductParams itself -- clear any state a previous test left behind.
    renderProductParams({ __spz_type__: 'DatasetIndex' });
  });

  it('re-renders the params box, restored to the config-loaded value, once inventory arrives', async () => {
    // Simulates the state right after applyConfig() runs on a page load, before
    // loadInventory()'s fetch (fired in parallel, not awaited) has resolved.
    plot.__test__.setSelectedProduct('ssc/ace');
    plotState.plots = [{
      products: [{ path: 'ssc/ace', label: 'ace', coordinateSystem: 'gsm' }],
      productData: {}, y_axis: { log: false },
    }];
    apiClient.fetchInventory.mockResolvedValueOnce(sscTree);

    await plot.__test__.loadInventory();

    expect(collectProductParams()).toEqual({ coordinateSystem: 'gsm' });
  });

  it('does nothing when no product was selected before inventory arrives', async () => {
    apiClient.fetchInventory.mockResolvedValueOnce(sscTree);
    await plot.__test__.loadInventory();
    expect(collectProductParams()).toEqual({});
  });
});

describe('product parameters in the subplot toolbar', () => {
  const sscTree = { ssc: { Trajectories: { ace: {
    __spz_type__: 'ParameterIndex', __spz_provider__: 'ssc', __spz_uid__: 'ace', __spz_name__: 'ACE',
  } } } };
  const sscSubplot = (coordinateSystem) => ({
    products: [{ path: 'ssc/ace', label: 'ace', coordinateSystem }],
    productData: { 'ssc/ace': lineCache('ssc/ace', '') }, y_axis: { log: false }, plotType: 'line',
  });
  const paramSelects = (from) => dom.created.slice(from).filter((e) => e.tagName === 'SELECT' && e.className.includes('pv-param'));

  it('shows each subplot its own product frame, and a change touches only that subplot', async () => {
    apiClient.fetchInventory.mockResolvedValueOnce(sscTree);
    await plot.__test__.loadInventory();
    initChart();
    plotState.plots = [sscSubplot('gsm'), sscSubplot(undefined)];
    const before = dom.created.length;

    renderAllSubplots();

    const selects = paramSelects(before);
    expect(selects.map((s) => s.value)).toEqual(['gsm', 'gse']);
    selects[1].value = 'sm';
    selects[1].addEventListener.mock.calls.find(([type]) => type === 'change')[1]();
    expect(plotState.plots.map((sp) => sp.products[0].coordinateSystem)).toEqual(['gsm', 'sm']);
  });

  it('keeps the sidebar in step when the changed product is the one selected there', async () => {
    apiClient.fetchInventory.mockResolvedValueOnce(sscTree);
    await plot.__test__.loadInventory();
    plot.__test__.setSelectedProduct('ssc/ace');
    plotState.plots = [sscSubplot('gsm')];

    plot.__test__.subplotAction({ type: 'productParam', index: 0, path: 'ssc/ace', key: 'coordinate_system', value: 'sm' });

    expect(collectProductParams()).toEqual({ coordinateSystem: 'sm' });
  });

  it('shows no parameter dropdowns for a plain product', () => {
    initChart();
    plotState.plots = [{ products: [{ path: 'cda/b' }], y_axis: { log: false }, plotType: 'line', productData: { 'cda/b': lineCache('cda/b', '') } }];
    const before = dom.created.length;
    renderAllSubplots();
    expect(paramSelects(before)).toHaveLength(0);
  });
});

describe('share URL behind a reverse-proxy prefix', () => {
  it('does not duplicate the root_path prefix', () => {
    initChart();
    plotState.plots = [heatmapSubplot()];
    updateShareURL();

    const url = dom.getById('share-url').value;
    expect(url.startsWith('https://host/cache/plot?config=')).toBe(true);
    expect(url).not.toContain('/cache/cache/');
  });
});

describe('removing a product from a subplot', () => {
  it('keeps a line subplot on the line path when DISPLAY_TYPE is set', () => {
    initChart();
    const subplot = {
      products: [{ path: 'cda/b1' }, { path: 'cda/b2' }],
      y_axis: { log: false },
      logScale: true,
      plotType: 'line',
      lastHeatmapImg: null,
      productData: {
        'cda/b1': lineCache('cda/b1', 'time_series'),
        'cda/b2': lineCache('cda/b2', 'time_series'),
      },
    };
    plotState.plots = [subplot];

    removeProductFromSubplot(0, 'cda/b1');

    expect(subplot.plotType).toBe('line');
  });
});

describe('Enter in a time field', () => {
  it('applies the typed UTC window to every subplot, keeping the subplots', () => {
    initChart();
    bindControls();
    plotState.plots = [heatmapSubplot(), heatmapSubplot()];
    dom.getById('start-time').value = '01-01-2024 00:00';
    dom.getById('stop-time').value = '02-01-2024 00:00';

    const keydown = dom.getById('start-time').addEventListener.mock.calls
      .filter(([type]) => type === 'keydown').map(([, fn]) => fn);
    for (const fn of keydown) fn({ key: 'Enter', preventDefault: vi.fn() });

    expect(plotState.plots).toHaveLength(2);
    expect(plotState.time_range.start).toBe('2024-01-01T00:00:00.000Z');
    expect(plotState.time_range.stop).toBe('2024-01-02T00:00:00.000Z');
  });
});

describe('per-subplot actions (the toolbar on each subplot)', () => {
  const lineSubplot = (path) => ({
    products: [{ path }], y_axis: { log: false }, plotType: 'line', _yScaleAuto: true, _zScaleAuto: true,
    productData: { [path]: lineCache(path, '') },
  });

  beforeEach(() => {
    initChart();
    plotState.time_range = { start: '2020-01-01T00:00:00.000Z', stop: '2020-01-02T00:00:00.000Z' };
    dom.getById('start-time').value = '01-01-2020 00:00';
    dom.getById('stop-time').value = '02-01-2020 00:00';
  });

  it('log Y flips only the subplot it belongs to, and drops a manual Y range', () => {
    plotState.plots = [lineSubplot('cda/a'), lineSubplot('cda/b')];
    plotState.plots[1]._yOverride = { min: -5, max: 5 };

    plot.__test__.subplotAction({ type: 'logY', index: 1 });

    expect(plotState.plots.map((sp) => sp.y_axis.log)).toEqual([false, true]);
    expect(plotState.plots[1]._yOverride).toBeUndefined();
    expect(plotState.plots[1]._yScaleAuto).toBe(false);
  });

  it('log Z flips only the spectrogram it belongs to', () => {
    plotState.plots = [heatmapSubplot(), heatmapSubplot()];

    plot.__test__.subplotAction({ type: 'logZ', index: 0 });

    expect(plotState.plots.map((sp) => sp.logScale)).toEqual([false, true]);
  });

  it('a colormap pick changes only the spectrogram it belongs to', () => {
    plotState.plots = [heatmapSubplot(), heatmapSubplot()];

    plot.__test__.subplotAction({ type: 'colormap', index: 1, value: 'jet' });

    expect(plotState.plots.map((sp) => sp.colormap)).toEqual([undefined, 'jet']);
  });

  it('remove drops that subplot', () => {
    plotState.plots = [lineSubplot('cda/a'), lineSubplot('cda/b')];

    plot.__test__.subplotAction({ type: 'remove', index: 0 });

    expect(plotState.plots.map((sp) => sp.products[0].path)).toEqual(['cda/b']);
  });

  it('a product dropped on a subplot is overlaid there', () => {
    plotState.plots = [lineSubplot('cda/a'), lineSubplot('cda/b')];

    plot.__test__.subplotAction({ type: 'addProduct', index: 1, path: 'cda/c' });

    expect(plotState.plots).toHaveLength(2);
    expect(plotState.plots[1].products.map((p) => p.path)).toEqual(['cda/b', 'cda/c']);
  });

  it('a product dropped on a subplot edge gets a new subplot at that position', () => {
    plotState.plots = [lineSubplot('cda/a'), lineSubplot('cda/b')];

    plot.__test__.subplotAction({ type: 'insertProduct', index: 1, path: 'cda/c' });
    plot.__test__.subplotAction({ type: 'insertProduct', index: 0, path: 'cda/d' });

    expect(plotState.plots.map((sp) => sp.products[0].path)).toEqual(['cda/d', 'cda/a', 'cda/c', 'cda/b']);
  });

  it('a product added without a target gets a new subplot at the bottom', () => {
    plotState.plots = [lineSubplot('cda/a')];

    plot.__test__.subplotAction({ type: 'addProduct', index: null, path: 'cda/c' });

    expect(plotState.plots.map((sp) => sp.products[0].path)).toEqual(['cda/a', 'cda/c']);
  });

  it('a product already in the target subplot is not added twice', () => {
    plotState.plots = [lineSubplot('cda/a')];

    plot.__test__.subplotAction({ type: 'addProduct', index: 0, path: 'cda/a' });

    expect(plotState.plots[0].products).toHaveLength(1);
  });
});

describe('subplot toolbar', () => {
  beforeEach(() => { uPlot.instances.length = 0; });

  it('offers log Z only on spectrograms and marks the active scales', () => {
    initChart();
    const line = { products: [{ path: 'cda/b' }], y_axis: { log: true }, plotType: 'line', productData: { 'cda/b': lineCache('cda/b', '') } };
    plotState.plots = [line, heatmapSubplot()];
    const before = dom.created.length;

    renderAllSubplots();

    const made = dom.created.slice(before).filter((e) => e.tagName === 'BUTTON' && e.className.startsWith('pv-tool'));
    expect(made.map((b) => [b.textContent, b.className])).toEqual([
      ['auto Y', 'pv-tool active'], ['log Y', 'pv-tool active'], ['✕', 'pv-tool remove'],
      ['auto Y', 'pv-tool active'], ['log Y', 'pv-tool'], ['log Z', 'pv-tool active'], ['✕', 'pv-tool remove'],
    ]);
  });

  it('offers a colormap choice only on spectrograms, showing the current one', () => {
    initChart();
    const line = { products: [{ path: 'cda/b' }], y_axis: { log: false }, plotType: 'line', productData: { 'cda/b': lineCache('cda/b', '') } };
    plotState.plots = [line, { ...heatmapSubplot(), colormap: 'turbo' }];
    const before = dom.created.length;

    renderAllSubplots();

    const selects = dom.created.slice(before).filter((e) => e.tagName === 'SELECT');
    expect(selects).toHaveLength(1);
    expect(selects[0].value).toBe('turbo');
  });

  it('auto Y off freezes the current Y range, back on lets it refit', () => {
    initChart();
    plotState.plots = [{ products: [{ path: 'cda/b' }], y_axis: { log: false }, plotType: 'line', productData: { 'cda/b': lineCache('cda/b', '') } }];
    const before = dom.created.length;
    renderAllSubplots();
    const autoY = dom.created.slice(before).find((e) => e.textContent === 'auto Y');
    const click = autoY.addEventListener.mock.calls.find(([type]) => type === 'click')[1];
    const [u] = liveCharts();
    u.scales.y.min = -3; u.scales.y.max = 7;

    click();
    expect(plotState.plots[0]._yOverride).toEqual({ min: -3, max: 7 });
    expect(autoY.className).toBe('pv-tool');

    click();
    expect(plotState.plots[0]._yOverride).toBeUndefined();
    expect(autoY.className).toBe('pv-tool active');
  });
});

describe('ISTP SCALETYP scale hints', () => {
  function autoSubplot(plotType) {
    return { plotType, logScale: true, y_axis: { log: false }, _yScaleAuto: true, _zScaleAuto: true };
  }

  it('seeds Log Z and Log Y from a spectrogram\'s SCALETYP (energy axis log, values linear)', () => {
    const subplot = autoSubplot('heatmap');
    const data = {
      values: { meta: { SCALETYP: 'linear' } },
      axes: [{ values: [] }, { meta: { SCALETYP: 'log' } }],
    };

    applyScaleHints(subplot, data);

    expect(subplot.logScale).toBe(false); // values.meta.SCALETYP -> Z (color)
    expect(subplot.y_axis.log).toBe(true); // axes[1].meta.SCALETYP -> Y (energy)
  });

  it('uses values.meta.SCALETYP for a line subplot\'s Y axis (no DEPEND_1)', () => {
    const subplot = autoSubplot('line');
    const data = { values: { meta: { SCALETYP: 'log' } }, axes: [{ values: [] }] };

    applyScaleHints(subplot, data);

    expect(subplot.y_axis.log).toBe(true);
  });

  it('leaves the current value untouched when SCALETYP is absent (e.g. AMDA)', () => {
    const subplot = autoSubplot('heatmap');
    subplot.logScale = false; // deliberately not the createSubplotData default, to prove
    subplot.y_axis.log = true; // an absent hint doesn't coincidentally "restore" a default
    const data = { values: { meta: {} }, axes: [{ values: [] }, { meta: {} }] };

    applyScaleHints(subplot, data);

    expect(subplot.logScale).toBe(false);
    expect(subplot.y_axis.log).toBe(true);
  });

  // Many spectrograms (AMDA, Cluster HIA, Solar Orbiter PAS) carry no SCALETYP on their
  // energy table: drawn linear, a 10 eV - 30 keV table squashes all the physics at the bottom.
  const unhinted = (energies) => ({ values: { meta: {} }, axes: [{ values: [] }, { meta: {}, values: energies }] });

  it('draws an unhinted spectrogram axis spanning over a decade on a log scale', () => {
    const subplot = autoSubplot('heatmap');
    applyScaleHints(subplot, unhinted([10, 100, 1000, 30000]));
    expect(subplot.y_axis.log).toBe(true);
  });

  it('reads a time-varying (2-D) energy table too', () => {
    const subplot = autoSubplot('heatmap');
    applyScaleHints(subplot, unhinted([[10, 100], [12, 30000]]));
    expect(subplot.y_axis.log).toBe(true);
  });

  it('keeps an unhinted axis linear when it spans less than a decade or reaches zero', () => {
    const narrow = autoSubplot('heatmap');
    applyScaleHints(narrow, unhinted([500, 900, 1900]));
    expect(narrow.y_axis.log).toBe(false);
    const withZero = autoSubplot('heatmap');
    applyScaleHints(withZero, unhinted([0, 10, 30000]));
    expect(withZero.y_axis.log).toBe(false);
  });

  it('lets an explicit SCALETYP linear win over a wide range', () => {
    const subplot = autoSubplot('heatmap');
    const data = unhinted([10, 30000]);
    data.axes[1].meta.SCALETYP = 'linear';
    applyScaleHints(subplot, data);
    expect(subplot.y_axis.log).toBe(false);
  });

  it('never overwrites an explicit user Log Y / Log Z choice', () => {
    const subplot = autoSubplot('heatmap');
    subplot._yScaleAuto = false;
    subplot._zScaleAuto = false;
    subplot.logScale = true;
    subplot.y_axis.log = false;
    const data = {
      values: { meta: { SCALETYP: 'linear' } },
      axes: [{ values: [] }, { meta: { SCALETYP: 'log' } }],
    };

    applyScaleHints(subplot, data);

    expect(subplot.logScale).toBe(true);
    expect(subplot.y_axis.log).toBe(false);
  });
});

describe('heatmap value range across refetches', () => {
  it('rescans retained rows when a trim invalidated the cached range', () => {
    const cache = heatmapSubplot().productData['cda/flux'];
    cache.valueRange = null; // trimCacheWindow does this

    mergeProductData(cache, spectrogramResponse([[0.5, 0.5, 0.5]], 4e9), 4000, 5000);

    expect(cache.valueRange).toEqual({ vMin: 0.5, vMax: 9 });
  });

  it('drops the NUL padding AMDA leaves in unit strings (unitless products)', () => {
    const cache = createEmptyCache('amda/omni_sw_beta');
    mergeProductData(cache, {
      axes: [{ values: [1e6, 2e6] }],
      values: { values: [[1], [2]], meta: { UNITS: '\u0000' } },
      columns: [],
    }, 0, 3);
    expect(cache.unit).toBe('');
  });

  it('ignores an all-gap slice instead of dropping the floor to a sentinel', () => {
    const cache = heatmapSubplot().productData['cda/flux'];

    mergeProductData(cache, spectrogramResponse([[null, NaN, null]], 4e9), 4000, 5000);

    expect(cache.valueRange).toEqual({ vMin: 1, vMax: 9 });
  });
});

describe('ISTP names and descriptions', () => {
  const response = (meta) => ({
    axes: [{ values: [1e6, 2e6] }], columns: ['v'],
    values: { values: [[1], [2]], meta: { UNITS: 'cm-3', ...meta } },
  });

  it('keeps FIELDNAM as the product name and CATDESC as its description', () => {
    const cache = { ...createEmptyCache('cda/x') };
    mergeProductData(cache, response({ FIELDNAM: 'flow speed, GSE', LABLAXIS: 'V', CATDESC: 'Flow Speed (km/s), GSE' }), 0, 3000);
    expect(cache.title).toBe('flow speed, GSE');
    expect(cache.description).toBe('Flow Speed (km/s), GSE');
  });

  it('drops a CATDESC that only repeats the product id (AMDA)', () => {
    const cache = { ...createEmptyCache('amda/omni_sw_n') };
    mergeProductData(cache, response({ FIELDNAM: 'sw density', CATDESC: 'omni_sw_n' }), 0, 3000);
    expect(cache.description).toBe('');
  });

  it('labels a spectrogram Y axis with its LABLAXIS, not the variable name', () => {
    const cache = { ...createEmptyCache('cda/spec') };
    const json = spectrogramResponse([[1, 2, 3]]);
    json.axes[1] = { values: [1, 2, 3], name: 'mms1_dis_energy_fast', meta: { LABLAXIS: 'energy', FIELDNAM: 'MMS1 FPI/DIS energy', UNITS: 'eV' } };
    mergeProductData(cache, json, 0, 3000);
    expect(cache.yAxisName).toBe('energy');
  });

  it('falls back to LABLAXIS when there is no FIELDNAM', () => {
    const cache = { ...createEmptyCache('cda/x') };
    mergeProductData(cache, response({ LABLAXIS: 'sw density' }), 0, 3000);
    expect(cache.title).toBe('sw density');
  });

  it('titles the badge with the ISTP name, and keeps the path and description on hover', () => {
    initChart();
    const cache = { ...lineCache('amda/omni_sw_n', ''), title: 'sw density', description: 'Solar wind density' };
    plotState.plots = [{ products: [{ path: 'amda/omni_sw_n', label: 'amda/omni_sw_n' }], y_axis: { log: false }, plotType: 'line', productData: { 'amda/omni_sw_n': cache } }];
    const before = dom.created.length;

    renderAllSubplots();

    const title = dom.created.slice(before).find((e) => e.className === 'pv-header-title');
    expect(title.textContent).toBe('sw density');
    expect(title.title).toBe('amda/omni_sw_n — Solar wind density');
  });
});

describe('units in a mixed subplot', () => {
  it('lists every distinct unit, not just the first product\'s', () => {
    initChart();
    const speed = { ...lineCache('cda/v', ''), unit: 'km/s' };
    const dens = { ...lineCache('cda/n', ''), unit: 'cm-3' };
    const dens2 = { ...lineCache('cda/n2', ''), unit: 'cm-3' };
    plotState.plots = [{ products: [{ path: 'cda/n', label: 'n' }, { path: 'cda/n2', label: 'n2' }, { path: 'cda/v', label: 'v' }], y_axis: { log: false }, plotType: 'line',
      productData: { 'cda/n': dens, 'cda/n2': dens2, 'cda/v': speed } }];
    const before = dom.created.length;

    renderAllSubplots();

    const title = dom.created.slice(before).find((e) => e.className === 'pv-header-title');
    expect(title.dataset.text).toBe('n, n2, v');
    expect(liveCharts().at(-1).opts.axes[1].label).toBe('cm-3, km/s');
  });
});

describe('spectrogram colour bar', () => {
  it('shows the colour range and the value unit in the badge', () => {
    initChart();
    const sp = heatmapSubplot();
    sp.productData['cda/flux'].unit = 'keV/(cm^2 s sr keV)';
    sp.productData['cda/flux'].valueRange = { vMin: 23.8022, vMax: 7.6812e7 };
    plotState.plots = [sp];
    const before = dom.created.length;

    renderAllSubplots();

    const made = dom.created.slice(before);
    expect(made.some((e) => e.className === 'pv-colorbar')).toBe(true);
    expect(made.filter((e) => e.className === 'pv-colorbar-label').map((e) => e.textContent))
      .toEqual(['23.8', '7.68e7', 'keV/(cm^2 s sr keV)']);
  });
});

describe('fetches that finish after the state moved on', () => {
  const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
  const lineResponse = (t0, value) => ({
    axes: [{ values: [t0 * 1e6, (t0 + 1000) * 1e6] }], columns: ['v'],
    values: { values: [[value], [value]], meta: { UNITS: 'nT' } },
  });
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

  beforeEach(() => {
    initChart();
    apiClient.fetchData.mockReset();
    dom.getById('start-time').value = '01-01-2020 00:00';
    dom.getById('stop-time').value = '02-01-2020 00:00';
  });

  it('a product fetch never lands in a cache that was replaced meanwhile (params change, new range)', async () => {
    const slow = deferred();
    apiClient.fetchData.mockReturnValueOnce(slow.promise);
    plot.__test__.subplotAction({ type: 'addProduct', index: null, path: 'ssc/ace' });
    const sp = plotState.plots[0];
    const fresh = createEmptyCache('ssc/ace');
    sp.productData['ssc/ace'] = fresh;  // what a coordinate-system change or a new range does

    slow.resolve(lineResponse(1000, 1));
    await flush();

    expect(fresh.times).toEqual([]);
  });

  it('an older full refetch finishing last does not land in the caches of a newer range', async () => {
    const slow = deferred();
    apiClient.fetchData.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(lineResponse(5000, 2));
    applyConfig({ version: 1, time_range: { start: '1970-01-01T00:00:00Z', stop: '1970-01-01T00:00:03Z' },
      plots: [{ products: [{ path: 'cda/b' }] }] });
    plot.__test__.replotOverRange(4000, 7000);  // e.g. a quick-range chip while the first load runs
    await flush();
    const cache = plotState.plots[0].productData['cda/b'];
    const timesAfterNewest = [...cache.times];

    slow.resolve(lineResponse(1000, 1));
    await flush();

    expect(cache.times).toEqual(timesAfterNewest);
    expect(cache.intervals).toEqual([[4000, 7000]]);
  });

  it('the loading dot follows its subplot when an earlier subplot is removed', async () => {
    const slow = deferred();
    apiClient.fetchData.mockResolvedValueOnce(lineResponse(1000, 1)).mockReturnValueOnce(slow.promise);
    plot.__test__.subplotAction({ type: 'addProduct', index: null, path: 'cda/a' });
    await flush();
    plot.__test__.subplotAction({ type: 'addProduct', index: null, path: 'cda/b' });
    const before = dom.created.length;

    plot.__test__.subplotAction({ type: 'remove', index: 0 });

    const titles = dom.created.slice(before).filter((e) => e.className === 'pv-header-title').map((e) => e.dataset.text);
    expect(titles).toEqual(['b ●']);
    slow.resolve(null);
    await flush();
  });

  it('a new subplot shows up at once, with its loading dot, before its data arrives', async () => {
    const slow = deferred();
    apiClient.fetchData.mockReturnValueOnce(slow.promise);
    const before = dom.created.length;

    plot.__test__.subplotAction({ type: 'addProduct', index: null, path: 'cda/a' });

    const titles = dom.created.slice(before).filter((e) => e.className === 'pv-header-title').map((e) => e.dataset.text);
    expect(titles).toEqual(['a ●']);
    slow.resolve(null);
    await flush();
  });

  it('adding a product refuses a stop before the start', () => {
    dom.getById('start-time').value = '02-01-2020 00:00';
    dom.getById('stop-time').value = '01-01-2020 00:00';

    plot.__test__.subplotAction({ type: 'addProduct', index: null, path: 'cda/a' });

    expect(plotState.plots).toHaveLength(0);
  });
});

describe('URL state', () => {
  const lastSavedConfig = () => {
    const url = window.history.replaceState.mock.calls.at(-1)[2];
    return plot.__test__.base64ToConfig(new URL(url, 'https://host').searchParams.get('config'));
  };

  beforeEach(() => { initChart(); window.history.replaceState.mockClear(); });

  it('applying a preset saves it in the URL, so a reload shows the preset', () => {
    applyConfig({ version: 1, time_range: { start: '2020-06-15T00:00:00Z', stop: '2020-06-16T00:00:00Z' },
      plots: [{ products: [{ path: 'amda/imf' }] }] });

    expect(lastSavedConfig().plots[0].products[0].path).toBe('amda/imf');
  });

  it('an old ?path= link leaves the scales to the ISTP hints', () => {
    window.location.search = '?path=amda/imf&start=2020-01-01&stop=2020-01-02';

    plot.__test__.loadFromURLParams();

    expect(plotState.plots[0]._yScaleAuto).toBe(true);
    window.location.search = '';
  });
});

describe('product search', () => {
  it('shows each result\'s name first, then its path once (no repeated name)', async () => {
    apiClient.fetchInventory.mockResolvedValueOnce({
      cda: { __spz_type__: 'ProviderIndex', ACE: { __spz_type__: 'DatasetIndex', __spz_name__: 'ACE',
        GSE_LAT: { __spz_type__: 'ParameterIndex', __spz_provider__: 'cda', __spz_uid__: 'AC/GSE_LAT', __spz_name__: 'GSE_LAT' } } },
    });
    await plot.__test__.loadInventory();
    const before = dom.created.length;

    plot.__test__.onSearchInput({ target: { value: 'gse_lat' } });

    // Name first: long paths get cut off at the end, and the name is what you pick by.
    const leaf = dom.created.slice(before).find((e) => e.className === 'tree-leaf');
    expect(leaf.children.map((c) => c.textContent)).toEqual(['+', 'GSE_LAT', 'cda / ACE']);
  });

  it('binds its input listener once, even when the inventory is loaded again (Retry)', async () => {
    apiClient.fetchInventory.mockResolvedValue({});
    const box = dom.getById('search-box');
    const inputs = () => box.addEventListener.mock.calls.filter(([type]) => type === 'input').length;
    await plot.__test__.loadInventory();
    const once = inputs();

    await plot.__test__.loadInventory();

    expect(inputs()).toBe(once);
  });
});

describe('time fields follow the view', () => {
  it('a pan or zoom updates the start/stop fields, so chips and Now work from what is shown', async () => {
    initChart();
    plotState.plots = [{ products: [{ path: 'cda/b' }], y_axis: { log: false }, plotType: 'line',
      productData: { 'cda/b': { ...lineCache('cda/b', ''), intervals: [[0, 1e12]], fetchSpan: 1e12 } } }];
    renderAllSubplots();
    plot.__test__.getPlotView().setView({ start: Date.parse('2020-01-01T04:00:00Z'), end: Date.parse('2020-01-01T10:00:00Z') });

    await plot.__test__.onMultiZoomPan();

    expect(dom.getById('start-time').value).toBe('01-01-2020 04:00:00');
    expect(dom.getById('stop-time').value).toBe('01-01-2020 10:00:00');
  });
});
