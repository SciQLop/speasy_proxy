import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { installPlotDom } from './helpers/dom-mock.js';

import * as apiClient from '../../speasy_proxy/static/js/api-client.js';

vi.mock('../../speasy_proxy/static/js/api-client.js', () => ({
  fetchData: vi.fn(() => Promise.resolve(null)),
  fetchInventory: vi.fn(() => Promise.resolve({})),
}));

// Deployed behind a reverse proxy: root_path prefix in the base URL, and the browser
// path already carries it.
const dom = installPlotDom({ baseUrl: 'https://host/cache', pathname: '/cache/plot', origin: 'https://host' });
const plot = await import('../../speasy_proxy/static/js/plot.js');
const {
  plotState, initChart, renderAllSubplots, removeProductFromSubplot,
  updateShareURL, mergeProductData, bindControls, getChart, applyScaleHints, applyConfig,
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

describe('cold spectrogram render', () => {
  // The chart has no model (grids/axes) until the first setOption, so heatmap geometry
  // must not be computed before it — that threw a TypeError and left the page spinning.
  it('renders a heatmap on a chart that has never had setOption called', () => {
    initChart();
    plotState.plots = [heatmapSubplot()];

    expect(() => renderAllSubplots()).not.toThrow();

    const chart = getChart();
    expect(chart.calls[0].opt.grid).toBeTruthy(); // structure applied before any geometry read

    // Heatmap images are zrender elements added directly to chart.getZr(), not
    // the ECharts `graphic` option component — see positionHeatmapZrEl in plot.js.
    const zr = chart.getZr();
    expect(zr.add).toHaveBeenCalled();
    const group = zr.add.mock.calls[0][0];
    expect(group.children[0].style.image).toBeTruthy();
    expect(group.clipPath).toBeTruthy();
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

  it('ignores an all-gap slice instead of dropping the floor to a sentinel', () => {
    const cache = heatmapSubplot().productData['cda/flux'];

    mergeProductData(cache, spectrogramResponse([[null, NaN, null]], 4e9), 4000, 5000);

    expect(cache.valueRange).toEqual({ vMin: 1, vMax: 9 });
  });
});
