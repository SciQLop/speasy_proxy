import { describe, it, expect } from 'vitest';
import {
  mergeSorted, mergeSortedRows, mergeIntervals, evictProductCache, buildSeriesData,
  detectPlotType, configToBase64, base64ToConfig, isCovered, resolutionSufficient, rangesOverlap, trimCacheWindow, cacheToCsv,
  createSubplotData, createProductCache, subplotToConfig, subplotFromConfig,
  normalizeWheelDelta, zoomRange, panRange, zoomToward, axisExtent, sharedAxisExtent, structureKey, resampleTarget,
  axisNeedsExpansion, dataOnlyOption, plotTypeFromCache, computeValueRange, mergeValueRange, renderableRange,
} from '../../speasy_proxy/static/js/plot-core.js';

describe('merge', () => {
  it('mergeSorted interleaves by time, preferring new on ties', () => {
    const r = mergeSorted([1, 3], [2, 3], { a: [10, 30] }, [[20], [99]], ['a']);
    expect(r.times).toEqual([1, 2, 3]);
    expect(r.columns.a).toEqual([10, 20, 99]);
  });
  it('mergeSortedRows interleaves whole rows', () => {
    const r = mergeSortedRows([1, 4], [2], [[1, 1], [4, 4]], [[2, 2]]);
    expect(r.times).toEqual([1, 2, 4]);
    expect(r.rows).toEqual([[1, 1], [2, 2], [4, 4]]);
  });
  it('mergeIntervals coalesces overlaps and sorts', () => {
    expect(mergeIntervals([[5, 10], [1, 3], [2, 6]])).toEqual([[1, 10]]);
    expect(mergeIntervals([[1, 3], [10, 12]])).toEqual([[1, 3], [10, 12]]);
  });
  it('buildSeriesData zips into [t,v] pairs', () => {
    expect(buildSeriesData([1, 2], [10, 20])).toEqual([[1, 10], [2, 20]]);
  });
});

describe('isCovered', () => {
  it('is false for an empty or missing interval list', () => {
    expect(isCovered([], 0, 10)).toBe(false);
    expect(isCovered(null, 0, 10)).toBe(false);
  });
  it('is true when a single interval contains the range', () => {
    expect(isCovered([[0, 100]], 10, 90)).toBe(true);
  });
  it('is true on exact boundaries (inclusive)', () => {
    expect(isCovered([[0, 100]], 0, 100)).toBe(true);
  });
  it('is true when adjacent/overlapping intervals merge to cover the range', () => {
    expect(isCovered([[50, 100], [0, 60]], 10, 90)).toBe(true);
  });
  it('is false when a gap sits inside the range', () => {
    expect(isCovered([[0, 40], [60, 100]], 10, 90)).toBe(false);
  });
  it('is false when the range sticks out on either side', () => {
    expect(isCovered([[10, 90]], 0, 50)).toBe(false);
    expect(isCovered([[10, 90]], 50, 100)).toBe(false);
  });
  it('does not mutate the caller’s intervals', () => {
    const ivs = [[50, 100], [0, 60]];
    isCovered(ivs, 10, 90);
    expect(ivs).toEqual([[50, 100], [0, 60]]);
  });
});

describe('resolutionSufficient', () => {
  it('is false when no fetch span is recorded (safe default: refetch)', () => {
    expect(resolutionSufficient(0, 100)).toBe(false);
  });
  it('is true when the request span is close to the fetched span (pan)', () => {
    expect(resolutionSufficient(1000, 900, 0.5)).toBe(true);
    expect(resolutionSufficient(1000, 1000, 0.5)).toBe(true);
  });
  it('is true on the exact ratio boundary', () => {
    expect(resolutionSufficient(1000, 500, 0.5)).toBe(true);
  });
  it('is false once zoomed in below the ratio (needs denser data)', () => {
    expect(resolutionSufficient(1000, 499, 0.5)).toBe(false);
    expect(resolutionSufficient(1000, 10, 0.5)).toBe(false);
  });
  it('defaults to a 0.5 ratio', () => {
    expect(resolutionSufficient(1000, 600)).toBe(true);
    expect(resolutionSufficient(1000, 400)).toBe(false);
  });
});

describe('rangesOverlap', () => {
  it('is false for an empty or missing interval list', () => {
    expect(rangesOverlap([], 0, 10)).toBe(false);
    expect(rangesOverlap(null, 0, 10)).toBe(false);
  });
  it('is true on any overlap, including touching bounds', () => {
    expect(rangesOverlap([[0, 50]], 25, 75)).toBe(true);
    expect(rangesOverlap([[0, 50]], 50, 75)).toBe(true);
    expect(rangesOverlap([[50, 75]], 0, 50)).toBe(true);
    expect(rangesOverlap([[0, 10], [40, 60]], 20, 45)).toBe(true);
  });
  it('is false when fully disjoint', () => {
    expect(rangesOverlap([[0, 10]], 20, 30)).toBe(false);
    expect(rangesOverlap([[40, 60]], 0, 30)).toBe(false);
  });
});

describe('trimCacheWindow', () => {
  const mkCache = () => ({
    times: [0, 10, 20, 30, 40, 50],
    columns: { a: [0, 1, 2, 3, 4, 5] },
    columnNames: ['a'],
    rows: [[0], [1], [2], [3], [4], [5]],
    intervals: [[0, 50]],
  });
  it('slices times, columns and rows to the window and clips intervals', () => {
    const c = mkCache();
    trimCacheWindow(c, 15, 35);
    expect(c.times).toEqual([20, 30]);
    expect(c.columns.a).toEqual([2, 3]);
    expect(c.rows).toEqual([[2], [3]]);
    expect(c.intervals).toEqual([[15, 35]]);
  });
  it('keeps boundary points (inclusive window)', () => {
    const c = mkCache();
    trimCacheWindow(c, 10, 30);
    expect(c.times).toEqual([10, 20, 30]);
  });
  it('is a no-op when everything is inside the window', () => {
    const c = mkCache();
    trimCacheWindow(c, -100, 100);
    expect(c.times).toEqual([0, 10, 20, 30, 40, 50]);
    expect(c.intervals).toEqual([[0, 50]]);
  });
  it('empties the cache when the window is fully outside', () => {
    const c = mkCache();
    trimCacheWindow(c, 1000, 2000);
    expect(c.times).toEqual([]);
    expect(c.intervals).toEqual([]);
  });
  it('tolerates an empty cache', () => {
    const c = { times: [], columns: {}, columnNames: [], rows: [], intervals: [] };
    expect(() => trimCacheWindow(c, 0, 10)).not.toThrow();
  });
});

describe('cacheToCsv', () => {
  const mkCache = () => {
    const cache = createProductCache('amda/imf');
    cache.times = [Date.UTC(2024, 0, 1, 0, 0, 0), Date.UTC(2024, 0, 1, 1, 0, 0), Date.UTC(2024, 0, 1, 2, 0, 0)];
    cache.columnNames = ['bx', 'by'];
    cache.columns = { bx: [1, 2, 3], by: [4, null, 6] };
    cache.unit = 'nT';
    return cache;
  };
  it('writes a header with path, column names and units, then ISO rows', () => {
    const csv = cacheToCsv(mkCache(), -Infinity, Infinity);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('time,"amda/imf bx (nT)","amda/imf by (nT)"');
    expect(lines[1]).toBe('2024-01-01T00:00:00.000Z,1,4');
    expect(lines).toHaveLength(4);
  });
  it('serializes nulls as empty cells', () => {
    const csv = cacheToCsv(mkCache(), -Infinity, Infinity);
    expect(csv.split('\n')[2]).toBe('2024-01-01T01:00:00.000Z,2,');
  });
  it('restricts rows to [startMs, stopMs] inclusively', () => {
    const cache = mkCache();
    const csv = cacheToCsv(cache, cache.times[1], cache.times[2]);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[1].startsWith('2024-01-01T01:00:00.000Z')).toBe(true);
  });
  it('escapes quotes in header fields', () => {
    const cache = mkCache();
    cache.columnNames = ['we"ird'];
    cache.columns = { 'we"ird': [1, 2, 3] };
    const csv = cacheToCsv(cache, -Infinity, Infinity);
    expect(csv.split('\n')[0]).toBe('time,"amda/imf we""ird (nT)"');
  });
});

describe('evictProductCache', () => {
  it('trims column-based cache to maxPoints and clamps intervals', () => {
    const cache = createProductCache('p');
    cache.times = [1, 2, 3, 4];
    cache.columnNames = ['a'];
    cache.columns = { a: [10, 20, 30, 40] };
    cache.intervals = [[1, 4]];
    evictProductCache(cache, 2);
    expect(cache.times).toEqual([3, 4]);
    expect(cache.columns.a).toEqual([30, 40]);
    expect(cache.intervals).toEqual([[3, 4]]);
  });

  it('nulls valueRange after eviction to force recomputation', () => {
    const cache = createProductCache('p');
    cache.times = [1, 2, 3, 4, 5];
    cache.columnNames = ['a'];
    cache.columns = { a: [10, 20, 30, 40, 50] };
    cache.valueRange = { vMin: 10, vMax: 50 };
    evictProductCache(cache, 3);
    expect(cache.valueRange).toBeNull();
  });

  it('leaves cache untouched when under maxPoints', () => {
    const cache = createProductCache('p');
    cache.times = [1, 2];
    cache.valueRange = { vMin: 1, vMax: 2 };
    evictProductCache(cache, 5);
    expect(cache.times).toEqual([1, 2]);
    expect(cache.valueRange).toEqual({ vMin: 1, vMax: 2 });
  });
});

describe('detectPlotType', () => {
  it('heatmap from DISPLAY_TYPE', () => {
    expect(detectPlotType({ axes: [{}, {}], values: { values: [[1]], meta: { DISPLAY_TYPE: 'spectrogram' } } })).toBe('heatmap');
  });
  it('heatmap from wide multi-axis data', () => {
    expect(detectPlotType({ axes: [{}, {}], values: { values: [new Array(15).fill(0)] } })).toBe('heatmap');
  });
  it('line otherwise', () => {
    expect(detectPlotType({ axes: [{}], values: { values: [[1, 2]] } })).toBe('line');
  });
});

describe('plotTypeFromCache', () => {
  it('keeps line products on the line path even with a DISPLAY_TYPE', () => {
    const cache = createProductCache('cda/b_gse');
    cache.displayType = 'time_series';
    cache.columnNames = ['bx', 'by', 'bz'];
    expect(plotTypeFromCache(cache)).toBe('line');
  });
  it('detects a spectrogram cache', () => {
    const cache = createProductCache('cda/flux');
    cache.displayType = 'spectrogram';
    expect(plotTypeFromCache(cache)).toBe('heatmap');
  });
  it('detects a heatmap cache from its loaded y axis and rows', () => {
    const cache = createProductCache('cda/flux');
    cache.yAxis = [1, 2, 3];
    cache.rows = [[1, 2, 3]];
    expect(plotTypeFromCache(cache)).toBe('heatmap');
  });
  it('falls back to line for a missing cache', () => {
    expect(plotTypeFromCache(null)).toBe('line');
  });
});

describe('value range merging', () => {
  it('returns null for a slice with no positive samples', () => {
    expect(computeValueRange([[null, NaN], [0, -1]])).toBeNull();
    expect(computeValueRange([])).toBeNull();
  });
  it('widens a degenerate range only where it is rendered', () => {
    expect(computeValueRange([[5]])).toEqual({ vMin: 5, vMax: 5 });
    expect(renderableRange({ vMin: 5, vMax: 5 })).toEqual({ vMin: 5, vMax: 50 });
    expect(renderableRange(null)).toEqual({ vMin: 1e-30, vMax: 1 });
  });
  // After a trim/evict the cached range is invalidated but the retained rows stay, so
  // seeding from the new slice alone would color the whole cache by its newest chunk.
  it('rescans the whole cache when the cached range was invalidated', () => {
    const rows = [[1000], [2000], [3]];
    expect(mergeValueRange(null, rows, [[3]])).toEqual({ vMin: 3, vMax: 2000 });
  });
  it('unions a new slice into the cached range', () => {
    expect(mergeValueRange({ vMin: 10, vMax: 20 }, [[10], [20], [5]], [[5]]))
      .toEqual({ vMin: 5, vMax: 20 });
  });
  // A data gap must not drag vMin down to the sentinel and flatten the color scale.
  it('ignores an all-gap slice instead of folding in a sentinel', () => {
    expect(mergeValueRange({ vMin: 1e-9, vMax: 1e-6 }, [[1e-9]], [[null, NaN]]))
      .toEqual({ vMin: 1e-9, vMax: 1e-6 });
  });
  it('returns null when neither the cache nor the slice has positive data', () => {
    expect(mergeValueRange(null, [[null]], [[null]])).toBeNull();
  });
});

describe('config base64', () => {
  it('round-trips', () => {
    const cfg = { version: 1, plots: [{ products: [{ path: 'amda/x' }] }] };
    expect(base64ToConfig(configToBase64(cfg))).toEqual(cfg);
  });
  it('is URL-safe', () => {
    expect(configToBase64({ s: '???>>>' })).not.toMatch(/[+/=]/);
  });
});

describe('normalizeWheelDelta', () => {
  it('passes pixel deltas through (deltaMode 0)', () => {
    expect(normalizeWheelDelta(40, 0)).toBe(40);
    expect(normalizeWheelDelta(-40, 0)).toBe(-40);
  });
  it('scales line deltas to pixels (deltaMode 1)', () => {
    expect(normalizeWheelDelta(3, 1)).toBe(48);
  });
  it('scales page deltas to pixels (deltaMode 2)', () => {
    expect(normalizeWheelDelta(0.1, 2)).toBeCloseTo(80); // 0.1 * 800px
  });
  it('clamps magnitude so one big notch cannot overshoot', () => {
    expect(normalizeWheelDelta(5000, 0)).toBe(120);
    expect(normalizeWheelDelta(-5000, 0)).toBe(-120);
  });
});

describe('zoomRange', () => {
  it('zooms in (factor<0) around cursor, keeping cursor time fixed', () => {
    // cursor at center, shrink by 20%
    const r = zoomRange(0, 100, 0.5, -0.2);
    expect(r.start).toBeCloseTo(10);
    expect(r.end).toBeCloseTo(90);
  });
  it('zooms out (factor>0) around cursor', () => {
    const r = zoomRange(0, 100, 0.5, 0.2);
    expect(r.start).toBeCloseTo(-10);
    expect(r.end).toBeCloseTo(110);
  });
  it('keeps the time under the cursor anchored', () => {
    // cursor at left edge → start stays put when zooming
    const r = zoomRange(0, 100, 0, -0.3);
    expect(r.start).toBeCloseTo(0);
    expect(r.end).toBeCloseTo(70);
  });
});

describe('panRange', () => {
  it('shifts the window right by a fraction of its width', () => {
    expect(panRange(0, 100, 0.25)).toEqual({ start: 25, end: 125 });
  });
  it('shifts left for negative fraction', () => {
    expect(panRange(100, 200, -0.5)).toEqual({ start: 50, end: 150 });
  });
});

describe('zoomToward', () => {
  it('zooms in toward the cursor when above the floor', () => {
    // 100ms window, zoom in 50% around the centre → 50ms window, well above a 1ms floor.
    expect(zoomToward(0, 100, 0.5, -0.5, 1)).toEqual({ start: 25, end: 75 });
  });
  it('allows zooming down to millisecond windows (regression: was a hard 1s floor)', () => {
    // A 2ms window zooming in must NOT be rejected by a 1ms floor.
    const next = zoomToward(0, 2, 0.5, -0.25, 1);
    expect(next).not.toBeNull();
    expect(next.end - next.start).toBeCloseTo(1.5, 9);
  });
  it('refuses to shrink below the min span', () => {
    expect(zoomToward(0, 1, 0.5, -0.5, 1)).toBeNull();
  });
  it('always allows zooming out regardless of floor', () => {
    expect(zoomToward(0, 0.5, 0.5, 1, 1)).toEqual({ start: -0.25, end: 0.75 });
  });
});

describe('axisExtent', () => {
  it('pads the loaded span symmetrically', () => {
    expect(axisExtent([10, 20], 0.5)).toEqual({ min: 5, max: 25 });
  });
  it('returns undefined bounds for empty data', () => {
    expect(axisExtent([], 0.5)).toEqual({ min: undefined, max: undefined });
  });
});

describe('sharedAxisExtent', () => {
  const mkSubplot = (spans) => ({
    products: spans.map((_, i) => ({ path: 'p' + i })),
    productData: Object.fromEntries(spans.map(([lo, hi], i) => ['p' + i, { times: hi > lo ? [lo, hi] : [] }])),
  });
  it('unions times across subplots and products, then pads', () => {
    const plots = [mkSubplot([[10, 50]]), mkSubplot([[20, 90], [0, 30]])];
    // union is [0, 90], pad 0.5 × 90 = 45 on each side
    expect(sharedAxisExtent(plots, 0.5)).toEqual({ min: -45, max: 135 });
  });
  it('ignores empty caches', () => {
    const plots = [mkSubplot([[0, 0], [10, 20]])];
    expect(sharedAxisExtent(plots, 0.5)).toEqual({ min: 5, max: 25 });
  });
  it('returns undefined bounds when nothing has data', () => {
    expect(sharedAxisExtent([mkSubplot([[0, 0]])], 0.5)).toEqual({ min: undefined, max: undefined });
    expect(sharedAxisExtent([], 0.5)).toEqual({ min: undefined, max: undefined });
  });
});

describe('resampleTarget', () => {
  it('scales the budget by the fetch span so the visible third hits the density', () => {
    // 1500px wide, 2 pts/px visible, 1x buffer each side (fetch span = 3x visible).
    // Budget = 1500 * 2 * 3 = 9000; visible third ≈ 3000 over 1500px = 2 pts/px.
    expect(resampleTarget(1500, 2, 1)).toBe(9000);
  });
  it('with no buffer targets the density directly', () => {
    expect(resampleTarget(1500, 2, 0)).toBe(3000);
  });
  it('falls back to a default width when the plot is unsized', () => {
    expect(resampleTarget(0, 2, 1)).toBe(12000); // 2000 * 2 * 3
  });
  it('never drops below the floor', () => {
    expect(resampleTarget(10, 1, 0)).toBe(2000);
  });
  it('rounds up to a whole point count', () => {
    expect(Number.isInteger(resampleTarget(777, 1.5, 1))).toBe(true);
  });
});

describe('structureKey', () => {
  it('is stable when only data changes', () => {
    const mk = () => {
      const sp = createSubplotData();
      sp.products.push({ path: 'amda/b' });
      sp.productData['amda/b'] = createProductCache('amda/b');
      sp.productData['amda/b'].columnNames = ['bx', 'by', 'bz'];
      return [sp];
    };
    expect(structureKey(mk())).toBe(structureKey(mk()));
  });
  it('changes when plot type changes', () => {
    const line = createSubplotData();
    const heat = createSubplotData();
    heat.plotType = 'heatmap';
    expect(structureKey([line])).not.toBe(structureKey([heat]));
  });
  it('changes when a product is added', () => {
    const a = createSubplotData();
    a.products.push({ path: 'amda/b' });
    const b = createSubplotData();
    b.products.push({ path: 'amda/b' }, { path: 'amda/v' });
    expect(structureKey([a])).not.toBe(structureKey([b]));
  });
  it('changes when log scale toggles', () => {
    const a = createSubplotData();
    const b = createSubplotData();
    b.y_axis.log = true;
    expect(structureKey([a])).not.toBe(structureKey([b]));
  });
  it('changes when column count changes', () => {
    const mk = (cols) => {
      const sp = createSubplotData();
      sp.products.push({ path: 'amda/b' });
      sp.productData['amda/b'] = createProductCache('amda/b');
      sp.productData['amda/b'].columnNames = cols;
      return [sp];
    };
    expect(structureKey(mk(['a']))).not.toBe(structureKey(mk(['a', 'b'])));
  });
});

describe('factories', () => {
  it('createSubplotData defaults', () => {
    const sp = createSubplotData();
    expect(sp.products).toEqual([]);
    expect(sp.y_axis.log).toBe(false);
    expect(sp.logScale).toBe(true);
    expect(sp.plotType).toBe('line');
  });
  it('subplotToConfig / subplotFromConfig round-trip', () => {
    const sp = createSubplotData();
    sp.products.push({ path: 'amda/imf', label: 'IMF' });
    sp.y_axis.log = true;
    sp.logScale = false;
    const cfg = subplotToConfig(sp);
    expect(cfg).toEqual({ products: [{ path: 'amda/imf', label: 'IMF' }], y_axis: { log: true }, log_z: false });
    const restored = subplotFromConfig(cfg);
    expect(restored.products).toEqual([{ path: 'amda/imf', label: 'IMF' }]);
    expect(restored.y_axis.log).toBe(true);
    expect(restored.logScale).toBe(false);
  });
});

describe('axisNeedsExpansion', () => {
  it('returns null when view has room on both sides', () => {
    expect(axisNeedsExpansion(100, 200, 0, 500)).toBeNull();
  });

  it('signals expansion when view is near the left boundary', () => {
    // viewSpan=100, proximity=50, viewStart-axisMin=10 < 50 → near left
    expect(axisNeedsExpansion(10, 110, 0, 500)).not.toBeNull();
    // viewSpan=100, proximity=50, viewStart-axisMin=60 > 50 → NOT near
    expect(axisNeedsExpansion(60, 160, 0, 500)).toBeNull();
  });

  it('signals expansion when view is near the right boundary', () => {
    // viewSpan=100, proximity=50, axisMax-viewEnd=500-400=100 > 50 → NOT near
    expect(axisNeedsExpansion(300, 400, 0, 500)).toBeNull();
    // viewSpan=100, proximity=50, axisMax-viewEnd=500-460=40 < 50 → near right
    expect(axisNeedsExpansion(360, 460, 0, 500)).not.toBeNull();
  });

  it('returns expanded axis values that give breathing room', () => {
    const r = axisNeedsExpansion(40, 140, 0, 500);
    expect(r.min).toBeLessThan(0);
    expect(r.max).toBe(500);
  });

  it('expands both sides when the view touches both boundaries', () => {
    const r = axisNeedsExpansion(50, 450, 0, 500);
    // near-left: 50-0=50 < 400*0.5=200 → true
    // near-right: 500-450=50 < 200 → true
    expect(r.min).toBeLessThan(0);
    expect(r.max).toBeGreaterThan(500);
  });

  it('returns null for undefined axis boundaries', () => {
    expect(axisNeedsExpansion(100, 200, undefined, undefined)).toBeNull();
    expect(axisNeedsExpansion(100, 200, null, null)).toBeNull();
  });
});

describe('dataOnlyOption', () => {
  it('includes only series — xAxis update is deferred to avoid zoom-out during pan', () => {
    const series = [{ type: 'line', data: [[1, 2]] }];
    const opt = dataOnlyOption(series);
    expect(opt.series).toBe(series);
    expect(opt.xAxis).toBeUndefined();
    expect(opt.dataZoom).toBeUndefined();
  });
});

describe('plot.js structureSame path regression guard', () => {
  // Reads plot.js source and asserts the data-only (structureSame) render path uses
  // dataOnlyOption(series) instead of the bare { series: series } that caused
  // the pan-to-boundary stall (commit 5b72f67).
  it('calls dataOnlyOption(series) in the structureSame branch', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../../speasy_proxy/static/js/plot.js', import.meta.url).pathname, 'utf8');

    // The structureSame branch MUST use dataOnlyOption(series) — just series.
    expect(src).toContain('chart.setOption(dataOnlyOption(series)');
    // And NOT the old bare { series: series }.
    expect(src).not.toContain('chart.setOption({ series: series }');
  });
});
