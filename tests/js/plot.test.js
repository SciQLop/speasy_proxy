import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { installPlotDom } from './helpers/dom-mock.js';
import { configToBase64 } from '../../speasy_proxy/static/js/plot-core.js';

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

describe('a window outside a product coverage', () => {
  const pspTree = { cda: { PSP: { __spz_type__: 'DatasetIndex', __spz_name__: 'PSP',
    hfr: { __spz_type__: 'ParameterIndex', __spz_provider__: 'cda', __spz_uid__: 'PSP/hfr', __spz_name__: 'hfr',
      start_date: '2018-10-02 03:48:16', stop_date: '2026-03-15 23:59:53' } } } };
  const pspSubplot = () => ({ products: [{ path: 'cda/PSP/hfr' }], y_axis: { log: false }, plotType: 'line',
    productData: { 'cda/PSP/hfr': lineCache('cda/PSP/hfr', '') } });

  it('offers to jump to the last data, keeping the window length', async () => {
    apiClient.fetchInventory.mockResolvedValueOnce(pspTree);
    await plot.__test__.loadInventory();
    initChart();
    plotState.plots = [pspSubplot()];
    plotState.time_range = { start: '2026-06-01T00:00:00.000Z', stop: '2026-06-03T00:00:00.000Z' };
    const before = dom.created.length;

    renderAllSubplots();

    const note = dom.created.slice(before).find((e) => e.className === 'pv-nodata-text');
    expect(note.textContent).toContain('2018-10-02 → 2026-03-15');
    const jump = dom.created.slice(before).find((e) => e.textContent === 'Go to last data');
    jump.addEventListener.mock.calls.find(([t]) => t === 'click')[1]();
    expect(plotState.time_range).toEqual({ start: '2026-03-13T23:59:53.000Z', stop: '2026-03-15T23:59:53.000Z' });
  });

  it('says nothing while the window overlaps the coverage', async () => {
    apiClient.fetchInventory.mockResolvedValueOnce(pspTree);
    await plot.__test__.loadInventory();
    initChart();
    plotState.plots = [pspSubplot()];
    plotState.time_range = { start: '2026-03-14T00:00:00.000Z', stop: '2026-03-16T00:00:00.000Z' };
    const before = dom.created.length;

    renderAllSubplots();

    expect(dom.created.slice(before).some((e) => e.className === 'pv-nodata')).toBe(false);
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
  it('applies the typed UTC start to every subplot, keeping the subplots and the width', () => {
    initChart();
    bindControls();
    plotState.plots = [heatmapSubplot(), heatmapSubplot()];
    plotState.time_range = { start: '2020-01-01T00:00:00.000Z', stop: '2020-01-02T00:00:00.000Z' };
    dom.getById('start-time').value = '2024-01-01 00:00';

    const keydown = dom.getById('start-time').addEventListener.mock.calls
      .filter(([type]) => type === 'keydown').map(([, fn]) => fn);
    for (const fn of keydown) fn({ key: 'Enter', preventDefault: vi.fn() });

    expect(plotState.plots).toHaveLength(2);
    expect(plotState.time_range.start).toBe('2024-01-01T00:00:00.000Z');
    expect(plotState.time_range.stop).toBe('2024-01-02T00:00:00.000Z');
  });
});

describe('time window controls', () => {
  const fieldListener = (id, type) => dom.getById(id).addEventListener.mock.calls.filter(([t]) => t === type).at(-1)[1];
  const showWindow = (start, stop) => {
    plotState.time_range = { start, stop };
    dom.getById('start-time').value = start.slice(0, 19).replace('T', ' ');
    dom.getById('stop-time').value = stop.slice(0, 19).replace('T', ' ');
  };

  beforeEach(() => {
    initChart();
    bindControls();
    plotState.plots = [heatmapSubplot()];
    showWindow('2024-01-01T00:00:00.000Z', '2024-01-03T00:00:00.000Z');
  });

  it('a span chip sets the window length from its start', () => {
    const chips = dom.getById('range-chips').addEventListener.mock.calls.filter(([t]) => t === 'click').at(-1)[1];
    chips({ target: { closest: () => ({ dataset: { ms: String(6 * 3600000) } }) } });
    expect(plotState.time_range).toEqual({ start: '2024-01-01T00:00:00.000Z', stop: '2024-01-01T06:00:00.000Z' });
  });

  it('leaving an edited field applies it, no Enter needed', () => {
    dom.getById('stop-time').value = '2024-01-02T12:00:00Z';
    fieldListener('stop-time', 'change')();
    expect(plotState.time_range).toEqual({ start: '2024-01-01T00:00:00.000Z', stop: '2024-01-02T12:00:00.000Z' });
  });

  it('a new start moves the window, even with a stale stop in the other field', () => {
    dom.getById('start-time').value = '2015-06-01 00:00';
    fieldListener('start-time', 'change')();
    expect(plotState.time_range).toEqual({ start: '2015-06-01T00:00:00.000Z', stop: '2015-06-03T00:00:00.000Z' });
  });

  it('shows the window length', () => {
    fieldListener('start-time', 'change')();  // same window: nothing refetched
    dom.getById('stop-time').value = '2024-01-03 08:00';
    fieldListener('stop-time', 'change')();
    expect(dom.getById('time-span').textContent).toBe('2d 8h');
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

  it('a Z range applies to that spectrogram only; null goes back to auto', () => {
    plotState.plots = [heatmapSubplot(), heatmapSubplot()];

    plot.__test__.subplotAction({ type: 'zRange', index: 1, value: { vMin: 2, vMax: 8 } });
    expect(plotState.plots.map((sp) => sp._zOverride)).toEqual([undefined, { vMin: 2, vMax: 8 }]);

    plot.__test__.subplotAction({ type: 'zRange', index: 1, value: null });
    expect(plotState.plots[1]._zOverride).toBeUndefined();
  });

  it('log Z drops a set Z range that starts at or below zero', () => {
    plotState.plots = [{ ...heatmapSubplot(), logScale: false, _zOverride: { vMin: 0, vMax: 8 } }];
    plot.__test__.subplotAction({ type: 'logZ', index: 0 });
    expect(plotState.plots[0]._zOverride).toBeUndefined();
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

  it('offers auto Z and log Z only on spectrograms and marks the active scales', () => {
    initChart();
    const line = { products: [{ path: 'cda/b' }], y_axis: { log: true }, plotType: 'line', productData: { 'cda/b': lineCache('cda/b', '') } };
    plotState.plots = [line, heatmapSubplot()];
    const before = dom.created.length;

    renderAllSubplots();

    const made = dom.created.slice(before).filter((e) => e.tagName === 'BUTTON' && e.className.startsWith('pv-tool'));
    expect(made.map((b) => [b.textContent, b.className])).toEqual([
      ['auto Y', 'pv-tool active'], ['log Y', 'pv-tool active'], ['✕', 'pv-tool remove'],
      ['auto Y', 'pv-tool active'], ['log Y', 'pv-tool'], ['auto Z', 'pv-tool active'], ['log Z', 'pv-tool active'], ['✕', 'pv-tool remove'],
    ]);
  });

  it('auto Z off freezes the shown colour range; the colour bar shows a set range', () => {
    initChart();
    plotState.plots = [heatmapSubplot()];
    let before = dom.created.length;
    renderAllSubplots();
    const autoZ = dom.created.slice(before).find((e) => e.textContent === 'auto Z');
    autoZ.addEventListener.mock.calls.find(([type]) => type === 'click')[1]();
    expect(plotState.plots[0]._zOverride).toEqual({ vMin: 1, vMax: 9 });

    plotState.plots[0]._zOverride = { vMin: 2, vMax: 500 };
    before = dom.created.length;
    renderAllSubplots();
    const labels = dom.created.slice(before).filter((e) => e.className?.startsWith('pv-colorbar-label')).map((e) => e.textContent);
    expect(labels.slice(0, 2)).toEqual(['2', '500']);
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
    expect(made.filter((e) => e.className?.startsWith('pv-colorbar-label')).map((e) => e.textContent))
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

  it('shows the product metadata on hover, under its path', async () => {
    apiClient.fetchInventory.mockResolvedValueOnce({
      cda: { __spz_type__: 'ProviderIndex', ACE: { __spz_type__: 'DatasetIndex', __spz_name__: 'ACE',
        GSE_LAT: { __spz_type__: 'ParameterIndex', __spz_provider__: 'cda', __spz_uid__: 'AC/GSE_LAT', __spz_name__: 'GSE_LAT',
          CATDESC: 'ACE latitude in GSE', UNITS: 'deg' } } },
    });
    await plot.__test__.loadInventory();
    const before = dom.created.length;

    plot.__test__.onSearchInput({ target: { value: 'gse_lat' } });

    const leaf = dom.created.slice(before).find((e) => e.className === 'tree-leaf');
    expect(leaf.title).toBe('cda / ACE / GSE_LAT\ncda/AC/GSE_LAT\n\nACE latitude in GSE\nUNITS: deg');
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
  it('a pan or zoom updates the start/stop fields, so chips work from what is shown', async () => {
    initChart();
    plotState.plots = [{ products: [{ path: 'cda/b' }], y_axis: { log: false }, plotType: 'line',
      productData: { 'cda/b': { ...lineCache('cda/b', ''), intervals: [[0, 1e12]], fetchSpan: 1e12 } } }];
    renderAllSubplots();
    plot.__test__.getPlotView().setView({ start: Date.parse('2020-01-01T04:00:00Z'), end: Date.parse('2020-01-01T10:00:00Z') });

    await plot.__test__.onMultiZoomPan();

    expect(dom.getById('start-time').value).toBe('2020-01-01 04:00:00');
    expect(dom.getById('stop-time').value).toBe('2020-01-01 10:00:00');
  });
});

describe('Back and Forward walk the views', () => {
  const T0 = Date.parse('2020-01-01T00:00:00Z'), HOUR = 3600000;
  const oneLinePlot = () => [{ products: [{ path: 'cda/b' }], y_axis: { log: false }, plotType: 'line',
    productData: { 'cda/b': { ...lineCache('cda/b', ''), intervals: [[0, 1e13]], fetchSpan: 1e13 } } }];
  const configUrl = (config) => '?config=' + configToBase64(config);
  const clearHistory = () => { window.history.pushState.mockClear(); window.history.replaceState.mockClear(); };

  beforeEach(() => initChart());

  it('a zoom gesture makes one history entry, however many steps it takes', async () => {
    plotState.plots = oneLinePlot();
    renderAllSubplots();
    plot.__test__.replotOverRange(T0, T0 + 24 * HOUR);  // an edit: the gesture below starts afresh
    plotState.plots = oneLinePlot();
    clearHistory();

    for (const hours of [12, 6, 3]) {
      plot.__test__.getPlotView().setView({ start: T0, end: T0 + hours * HOUR });
      await plot.__test__.onMultiZoomPan();
    }

    expect(window.history.pushState).toHaveBeenCalledTimes(1);
    expect(window.history.replaceState).toHaveBeenCalledTimes(2);
  });

  it('a new time range and a removed subplot are history entries; Clear leaves a bare /plot', () => {
    plotState.plots = oneLinePlot();
    renderAllSubplots();
    clearHistory();

    plot.__test__.replotOverRange(T0, T0 + HOUR);
    window.location.search = '?config=shown';  // what the browser's URL now carries
    plot.__test__.subplotAction({ type: 'remove', index: 0 });

    expect(window.history.pushState).toHaveBeenCalledTimes(2);
    expect(window.history.pushState.mock.calls.at(-1)[2]).toBe('/cache/plot');
    window.location.search = '';
  });

  it('going back applies that entry without adding one', () => {
    window.location.search = configUrl({ version: 1, time_range: { start: '2020-01-01T00:00:00Z', stop: '2020-01-02T00:00:00Z' },
      plots: [{ products: [{ path: 'cda/a' }] }, { products: [{ path: 'cda/b' }] }] });
    clearHistory();

    plot.__test__.onPopState();

    expect(plotState.plots.map((sp) => sp.products[0].path)).toEqual(['cda/a', 'cda/b']);
    expect(window.history.pushState).not.toHaveBeenCalled();
    expect(window.history.replaceState).not.toHaveBeenCalled();
    window.location.search = '';
  });

  it('going back to a bare /plot empties the view', () => {
    plotState.plots = oneLinePlot();
    renderAllSubplots();
    window.location.search = '';
    clearHistory();

    plot.__test__.onPopState();

    expect(plotState.plots).toEqual([]);
    expect(window.history.pushState).not.toHaveBeenCalled();
  });
});

describe('empty /plot offers presets and recent views', () => {
  const view = { version: 1, time_range: { start: '2020-01-01T00:00:00Z', stop: '2020-01-02T00:00:00Z' },
    plots: [{ products: [{ path: 'cda/a' }] }] };
  const cards = (listId) => dom.getById(listId).children;
  const memoryStorage = () => {
    const items = new Map();
    return { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, String(v)) };
  };

  beforeEach(() => {
    initChart();
    dom.getById('empty-presets-list').children = [];
    dom.getById('empty-recent-list').children = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the presets as cards that open them', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true,
      json: () => Promise.resolve([{ name: 'Substorm', description: 'Onset.', config: view }]) })));
    plotState.plots = [];

    await plot.__test__.loadPresets();

    expect(dom.getById('empty-state').hidden).toBe(false);
    const [card] = cards('empty-presets-list');
    expect(card.children.map((c) => c.textContent)).toEqual(['Substorm', 'Onset.']);
    card.addEventListener.mock.calls.find(([t]) => t === 'click')[1]();
    expect(plotState.plots[0].products[0].path).toBe('cda/a');
    expect(plotState.story.name).toBe('Substorm');
    expect(dom.getById('empty-state').hidden).toBe(true);
  });

  it('remembers the views shown, and offers them once the plot is cleared', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    applyConfig(view);

    plot.__test__.subplotAction({ type: 'remove', index: 0 });

    expect(dom.getById('empty-state').hidden).toBe(false);
    const [card] = cards('empty-recent-list');
    expect(card.children.map((c) => c.textContent)).toEqual(['a', '2020-01-01 00:00 UTC · 1d']);
  });

  it('works without storage', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });

    applyConfig(view);
    plot.__test__.subplotAction({ type: 'remove', index: 0 });

    expect(dom.getById('empty-state').hidden).toBe(false);
    expect(cards('empty-recent-list')).toEqual([]);
  });
});

describe('presets saved in the browser', () => {
  const view = { version: 1, time_range: { start: '2020-01-01T00:00:00Z', stop: '2020-01-02T00:00:00Z' },
    plots: [{ products: [{ path: 'cda/a' }] }] };
  const memoryStorage = () => {
    const items = new Map();
    return { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, String(v)) };
  };
  const click = (el) => el.addEventListener.mock.calls.filter(([t]) => t === 'click').at(-1)[1]();
  const save = (name) => {
    dom.getById('preset-name').value = name;
    click(dom.getById('btn-save-preset'));
  };
  const mine = () => dom.getById('user-presets-list').children;

  beforeEach(() => {
    initChart();
    bindControls();
    dom.getById('user-presets-list').children = [];
    dom.getById('empty-mine-list').children = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it('saves the current view under a name and lists it in the sidebar', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    applyConfig(view);

    save('My storm');

    expect(mine().map((item) => item.children[0].textContent)).toEqual(['My storm']);
    expect(dom.getById('preset-name').value).toBe('');
  });

  it('opens a saved preset with its name as the story, from the sidebar and from the empty page', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    applyConfig(view);
    save('My storm');
    plot.__test__.subplotAction({ type: 'remove', index: 0 });

    const [card] = dom.getById('empty-mine-list').children;
    expect(card.children[0].textContent).toBe('My storm');
    click(card);
    expect(plotState.plots[0].products[0].path).toBe('cda/a');
    expect(plotState.story.name).toBe('My storm');

    plot.__test__.subplotAction({ type: 'remove', index: 0 });
    document.querySelector.mockImplementationOnce(() => ({ classList: { remove: vi.fn() } }));  // the drawer it closes
    click(mine()[0].children[0]);
    expect(plotState.plots[0].products[0].path).toBe('cda/a');
  });

  it('offers to save a modified preset under its own name, keeping its description', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    applyConfig({ ...view, name: 'THEMIS substorm', description: 'Onset.' });
    expect(dom.getById('preset-name').value).toBe('THEMIS substorm');

    applyConfig({ ...view, name: 'THEMIS substorm', description: 'Onset.', time_range: { start: '2020-01-01T06:00:00Z', stop: '2020-01-01T12:00:00Z' } });
    click(dom.getById('btn-save-preset'));

    const [saved] = JSON.parse(localStorage.getItem('speasy-plot-presets'));
    expect(saved).toMatchObject({ name: 'THEMIS substorm', description: 'Onset.', config: { time_range: { start: '2020-01-01T06:00:00.000Z' } } });
  });

  it('deletes a saved preset', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    applyConfig(view);
    save('My storm');

    click(mine()[0].children[1]);

    expect(mine()).toEqual([]);
  });

  it('works without storage', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    applyConfig(view);

    expect(() => save('My storm')).not.toThrow();
    expect(mine()).toEqual([]);
  });
});

describe('events added in the browser', () => {
  const view = { version: 1, time_range: { start: '2020-01-01T00:00:00Z', stop: '2020-01-02T00:00:00Z' },
    plots: [{ products: [{ path: 'cda/a' }] }] };
  const t = (iso) => Date.parse(iso);
  const click = (el) => el.addEventListener.mock.calls.filter(([type]) => type === 'click').at(-1)[1]();
  const events = () => dom.getById('events-list').children;
  const sharedConfig = () => plot.__test__.base64ToConfig(
    new URL(dom.getById('share-url').value).searchParams.get('config'));
  const addEvent = (label) => {
    vi.stubGlobal('prompt', vi.fn(() => label));
    plot.__test__.subplotAction({ type: 'addEvent', value: [t('2020-01-01T06:00:00Z'), t('2020-01-01T07:30:00Z')] });
  };

  beforeEach(() => {
    dom.getById('events-container').open = false;
    initChart();
    applyConfig(view);
    dom.getById('events-list').children = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it('adds the dragged interval, with the label typed, to the view', () => {
    addEvent('Shock');

    expect(plotState.intervals).toMatchObject([{ start: '2020-01-01T06:00:00.000Z', stop: '2020-01-01T07:30:00.000Z', label: 'Shock' }]);
    expect(events().map((item) => item.children[1].textContent)).toEqual(['Shock']);
    updateShareURL();
    expect(sharedConfig().intervals).toMatchObject([{ start: '2020-01-01T06:00:00.000Z', label: 'Shock' }]);
  });

  it('shows the Events section, closed, as soon as something is plotted: its hint tells how to add one', () => {
    const container = dom.getById('events-container');
    expect(container.hidden).toBe(false);
    expect(container.open).toBeFalsy();

    plot.__test__.subplotAction({ type: 'remove', index: 0 });
    expect(container.hidden).toBe(true);
  });

  it('adds nothing when the label prompt is cancelled', () => {
    addEvent(null);

    expect(plotState.intervals).toEqual([]);
  });

  it('lists an unlabelled event by its dates', () => {
    addEvent('');

    expect(events()[0].children[1].textContent).toBe('2020-01-01 06:00 — 2020-01-01 07:30');
  });

  it('deletes an event', () => {
    addEvent('Shock');
    vi.stubGlobal('prompt', vi.fn(() => 'Later'));
    plot.__test__.subplotAction({ type: 'addEvent', value: [t('2020-01-01T10:00:00Z'), t('2020-01-01T11:00:00Z')] });

    click(events()[0].children[2]);  // the first listed: the earliest, Shock

    expect(plotState.intervals.map((iv) => iv.label)).toEqual(['Later']);
  });
});

describe('Code button', () => {
  const click = (id) => dom.getById(id).addEventListener.mock.calls.filter(([t]) => t === 'click').at(-1)[1]();

  it('shows speasy and URL snippets for the current view', () => {
    initChart();
    bindControls();
    applyConfig({ version: 1, time_range: { start: '2008-02-26T04:30:00Z', stop: '2008-02-26T05:20:00Z' },
      plots: [{ products: [{ path: 'cda/thb' }] }] });
    dom.getById('code-popover').style.display = 'none';

    click('btn-code');

    expect(dom.getById('code-popover').style.display).not.toBe('none');
    expect(dom.getById('code-python').value)
      .toContain('thb = spz.get_data("cda/thb", "2008-02-26T04:30:00Z", "2008-02-26T05:20:00Z")');
    expect(dom.getById('code-urls').value)
      .toBe('https://host/cache/get_data?path=cda/thb&start_time=2008-02-26T04:30:00Z&stop_time=2008-02-26T05:20:00Z&format=cdf');
  });

  it('is disabled with nothing plotted', () => {
    initChart();
    plotState.plots = [heatmapSubplot()];
    renderAllSubplots();
    expect(dom.getById('btn-code').disabled).toBe(false);

    plot.__test__.subplotAction({ type: 'remove', index: 0 });

    expect(dom.getById('btn-code').disabled).toBe(true);
  });
});

describe('a preset keeps its story', () => {
  const story = {
    version: 1, name: 'THEMIS substorm', description: 'Dipolarization at 04:54 UT.',
    time_range: { start: '2008-02-26T04:00:00Z', stop: '2008-02-26T06:00:00Z' },
    intervals: [{ start: '2008-02-26T04:50:00Z', stop: '2008-02-26T05:00:00Z', label: 'Onset' }],
    plots: [{ products: [{ path: 'cda/thb' }] }],
  };
  const sharedConfig = () => plot.__test__.base64ToConfig(
    new URL(dom.getById('share-url').value).searchParams.get('config'));

  beforeEach(() => initChart());

  it('shows the preset name and description in the sidebar', () => {
    applyConfig(story);

    expect(dom.getById('preset-story').hidden).toBe(false);
    expect(dom.getById('preset-story-name').textContent).toBe('THEMIS substorm');
    expect(dom.getById('preset-story-desc').textContent).toBe('Dipolarization at 04:54 UT.');
  });

  it('keeps name and description in the share URL', () => {
    applyConfig(story);
    updateShareURL();

    expect(sharedConfig()).toMatchObject({ name: 'THEMIS substorm', description: 'Dipolarization at 04:54 UT.' });
  });

  it('opens the Events panel when the preset has events', () => {
    dom.getById('events-container').open = false;
    applyConfig(story);

    expect(dom.getById('events-container').open).toBe(true);
  });

  it('hides the caption for a config without a story', () => {
    applyConfig(story);
    applyConfig({ ...story, name: undefined, description: undefined });

    expect(dom.getById('preset-story').hidden).toBe(true);
    updateShareURL();
    expect(sharedConfig()).not.toHaveProperty('name');
  });
});
