import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { installPlotDom } from './helpers/dom-mock.js';

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
