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

  it('labels each subplot with a badge carrying the unit (no rotated axis label)', () => {
    initChart();
    plotState.plots = [
      { products: [{ path: 'cda/b', label: 'OMNI B' }], y_axis: { log: false }, plotType: 'line', productData: { 'cda/b': lineCache('cda/b', '') } },
      heatmapSubplot(),
    ];
    renderAllSubplots();

    const titles = dom.created.filter((e) => e.className === 'pv-header-title').slice(-2).map((e) => e.textContent);
    expect(titles).toEqual(['OMNI B (nT)', 'flux · energy (eV)']);
    for (const u of liveCharts()) expect(u.opts.axes[1].label).toBeFalsy();
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
    dom.getById('product-path').value = 'ssc/ace';
    renderProductParams({ __spz_type__: 'ParameterIndex', __spz_provider__: 'ssc' });
    plotState.plots = [];

    onProductParamsChanged();

    expect(apiClient.fetchData).not.toHaveBeenCalled();
  });

  it('drops the stale cache and re-fetches with the new coordinate_system', async () => {
    dom.getById('product-path').value = 'ssc/ace';
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
    dom.getById('product-path').value = '';
    plotState.plots = [];
    // productParamSelects/productParamsKind are module-private and only reset by
    // renderProductParams itself -- clear any state a previous test left behind.
    renderProductParams({ __spz_type__: 'DatasetIndex' });
  });

  it('re-renders the params box, restored to the config-loaded value, once inventory arrives', async () => {
    // Simulates the state right after applyConfig() runs on a page load, before
    // loadInventory()'s fetch (fired in parallel, not awaited) has resolved.
    dom.getById('product-path').value = 'ssc/ace';
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

describe('Shift+Enter in a time field', () => {
  it('adds to the plot instead of replotting from scratch', () => {
    initChart();
    bindControls();
    plotState.plots = [heatmapSubplot(), heatmapSubplot()];
    dom.getById('product-path').value = 'cda/flux';
    dom.getById('start-time').tagName = 'INPUT';
    dom.getById('start-time').value = '01-01-2024 00:00';
    dom.getById('stop-time').value = '02-01-2024 00:00';
    dom.getById('btn-add').disabled = false;

    const keydown = dom.getById('start-time').addEventListener.mock.calls
      .filter(([type]) => type === 'keydown').map(([, fn]) => fn);
    expect(keydown.length).toBeGreaterThan(0);
    const event = { key: 'Enter', shiftKey: true, target: dom.getById('start-time'), preventDefault: vi.fn() };
    for (const fn of keydown) fn(event);
    dom.fireDocument('keydown', event);

    expect(dom.getById('btn-add').click).toHaveBeenCalled();
    expect(plotState.plots).toHaveLength(2); // doPlot would have reset this to 1
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
