import { describe, it, expect } from 'vitest';
import {
  mergeSorted, spliceRows, mergeIntervals, evictProductCache,
  detectPlotType, configToBase64, base64ToConfig, isCovered, resolutionSufficient, rangesOverlap, trimCacheWindow, cacheToCsv,
  createSubplotData, createProductCache, subplotToConfig, subplotFromConfig, paramValue, withParam, editedRange, zRangeOf, outOfCoverage, formatSpan,
  normalizeWheelDelta, wheelIntent, zoomRange, panRange, zoomToward, pinchRange, structureKey, resampleTarget,
  plotTypeFromCache, computeValueRange, mergeValueRange, renderableRange,
  nearestIndex, lineTable, yRangeFromPixels, rangeFromDrag, colorHex, withHue, edgeColor, fmtTick, cleanText, productTitle, dropZone, distinctCrumbs,
} from '../../speasy_proxy/static/js/plot-core.js';

describe('merge', () => {
  it('mergeSorted interleaves by time, preferring new on ties', () => {
    const r = mergeSorted([1, 3], [2, 3], { a: [10, 30] }, [[20], [99]], ['a']);
    expect(r.times).toEqual([1, 2, 3]);
    expect(r.columns.a).toEqual([10, 20, 99]);
  });
  it('spliceRows puts new rows next to old ones outside the fetched window', () => {
    const r = spliceRows([1, 4], [[1, 1], [4, 4]], [2], [[2, 2]], 2, 3);
    expect(r.times).toEqual([1, 2, 4]);
    expect(r.rows).toEqual([[1, 1], [2, 2], [4, 4]]);
  });
  // Two resampled fetches have their own time grids: interleaving them over the same
  // span made uneven steps that the image drew as dark vertical stripes.
  it('spliceRows replaces the old rows inside the fetched window', () => {
    const r = spliceRows([0, 10, 20, 30, 40], [[0], [10], [20], [30], [40]], [15, 25], [[15], [25]], 12, 32);
    expect(r.times).toEqual([0, 10, 15, 25, 40]);
    expect(r.rows).toEqual([[0], [10], [15], [25], [40]]);
  });
  it('mergeIntervals coalesces overlaps and sorts', () => {
    expect(mergeIntervals([[5, 10], [1, 3], [2, 6]])).toEqual([[1, 10]]);
    expect(mergeIntervals([[1, 3], [10, 12]])).toEqual([[1, 3], [10, 12]]);
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

describe('wheelIntent', () => {
  const wheel = (o) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ctrlKey: false, ...o });
  it('vertical wheel zooms', () => {
    expect(wheelIntent(wheel({ deltaY: 40 }))).toEqual({ kind: 'zoom', px: 40 });
  });
  it('horizontal swipe pans', () => {
    expect(wheelIntent(wheel({ deltaX: 30, deltaY: 4 }))).toEqual({ kind: 'pan', px: 30 });
  });
  it('mostly-vertical swipe with some drift still zooms', () => {
    expect(wheelIntent(wheel({ deltaX: 4, deltaY: -30 }))).toEqual({ kind: 'zoom', px: -30 });
  });
  it('Shift+wheel pans whether the browser reports it on Y (Firefox) or X (Chrome)', () => {
    expect(wheelIntent(wheel({ deltaY: 3, deltaMode: 1, shiftKey: true }))).toEqual({ kind: 'pan', px: 48 });
    expect(wheelIntent(wheel({ deltaX: 3, deltaMode: 1, shiftKey: true }))).toEqual({ kind: 'pan', px: 48 });
  });
  it('Ctrl+wheel (trackpad pinch) is a pinch zoom', () => {
    expect(wheelIntent(wheel({ deltaY: -5, ctrlKey: true }))).toEqual({ kind: 'pinch', px: -5 });
  });
  it('normalizes line deltas on the horizontal axis too', () => {
    expect(wheelIntent(wheel({ deltaX: -2, deltaMode: 1 }))).toEqual({ kind: 'pan', px: -32 });
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

describe('pinchRange', () => {
  const view = { start: 0, end: 100 };
  it('keeps the times under both fingers when they spread (zoom in)', () => {
    // fingers at t=25 and t=75 move out to the plot edges → window becomes [25, 75]
    expect(pinchRange(view, [0.25, 0.75], [0, 1], 1)).toEqual({ start: 25, end: 75 });
  });
  it('pans when both fingers move together', () => {
    const r = pinchRange(view, [0.2, 0.6], [0.3, 0.7], 1);
    expect(r.start).toBeCloseTo(-10);
    expect(r.end).toBeCloseTo(90);
  });
  it('zooms out when the fingers pinch together', () => {
    const r = pinchRange(view, [0, 1], [0.25, 0.75], 1);
    expect(r.start).toBeCloseTo(-50);
    expect(r.end).toBeCloseTo(150);
  });
  it('is null when the fingers cross or meet, or below the min span', () => {
    expect(pinchRange(view, [0.2, 0.6], [0.5, 0.5], 1)).toBeNull();
    expect(pinchRange(view, [0.2, 0.6], [0.6, 0.2], 1)).toBeNull();
    expect(pinchRange({ start: 0, end: 2 }, [0.4, 0.6], [0, 1], 1)).toBeNull();
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
    // Fresh subplot: Y/Z still follow the ISTP SCALETYP hint, not a user override.
    expect(sp._yScaleAuto).toBe(true);
    expect(sp._zScaleAuto).toBe(true);
  });
  it('subplotToConfig / subplotFromConfig round-trip', () => {
    const sp = createSubplotData();
    sp.products.push({ path: 'amda/imf', label: 'IMF' });
    sp.y_axis.log = true;
    sp.logScale = false;
    sp._yScaleAuto = false;  // clicked
    sp._zScaleAuto = false;
    const cfg = subplotToConfig(sp);
    expect(cfg).toEqual({ products: [{ path: 'amda/imf', label: 'IMF' }], y_axis: { log: true }, log_z: false });
    const restored = subplotFromConfig(cfg);
    expect(restored.products).toEqual([{ path: 'amda/imf', label: 'IMF' }]);
    expect(restored.y_axis.log).toBe(true);
    expect(restored.logScale).toBe(false);
  });
  it('a scale still following the ISTP hint is not saved, so a reload keeps following it', () => {
    // Adding a product saves the URL before its data (and SCALETYP) arrives: saving the
    // default log=false there made every reload or shared link come back linear.
    const sp = createSubplotData();
    sp.products.push({ path: 'cda/spec', label: 'spec' });
    sp.y_axis.log = true;  // set by the hint, not by a click
    const cfg = subplotToConfig(sp);
    expect(cfg.y_axis).toBeUndefined();
    expect(cfg.log_z).toBeUndefined();
    const restored = subplotFromConfig(cfg);
    expect(restored._yScaleAuto).toBe(true);
    expect(restored._zScaleAuto).toBe(true);
  });
  it('saves a colormap only when it is not the default', () => {
    const sp = createSubplotData();
    expect(subplotToConfig(sp).colormap).toBeUndefined();
    sp.colormap = 'jet';
    const cfg = subplotToConfig(sp);
    expect(cfg.colormap).toBe('jet');
    expect(subplotFromConfig(cfg).colormap).toBe('jet');
    expect(subplotFromConfig({ products: [] }).colormap).toBe('viridis');
  });
  it('subplotFromConfig treats a loaded/shared config as a deliberate choice', () => {
    const restored = subplotFromConfig({ products: [], y_axis: { log: true }, log_z: false });
    expect(restored._yScaleAuto).toBe(false);
    expect(restored._zScaleAuto).toBe(false);
  });
  it('subplotFromConfig leaves auto flags set when the config omits that axis', () => {
    const restored = subplotFromConfig({ products: [] });
    expect(restored._yScaleAuto).toBe(true);
    expect(restored._zScaleAuto).toBe(true);
  });
  it('carries a product\'s coordinate_system / product_inputs through a share-URL round-trip', () => {
    // Without this, sharing a link to an SSC/3DView product or an AMDA templated
    // parameter silently drops the chosen frame/arguments on the recipient's end.
    const sp = createSubplotData();
    sp.products.push({ path: 'ssc/ace', label: 'ace', coordinateSystem: 'gsm' });
    sp.products.push({ path: 'amda/bepi_sixp_p', label: 'p', productInputs: { side: '1' } });
    const cfg = subplotToConfig(sp);
    const restored = subplotFromConfig(cfg);
    expect(restored.products[0].coordinateSystem).toBe('gsm');
    expect(restored.products[1].productInputs).toEqual({ side: '1' });
  });
});

describe('nearestIndex', () => {
  it('returns the index of the closest sample', () => {
    expect(nearestIndex([10, 20, 30], 24)).toBe(1);
    expect(nearestIndex([10, 20, 30], 26)).toBe(2);
  });
  it('clamps outside the data', () => {
    expect(nearestIndex([10, 20, 30], -5)).toBe(0);
    expect(nearestIndex([10, 20, 30], 99)).toBe(2);
  });
  it('returns -1 for no data', () => {
    expect(nearestIndex([], 5)).toBe(-1);
  });
});

describe('lineTable', () => {
  it('lays out a line cache as a uPlot table: times, then one column per component', () => {
    const cache = { times: [1, 2], columnNames: ['x', 'y'], columns: { x: [1, 2], y: [3, 4] } };
    expect(lineTable(cache)).toEqual([[1, 2], [1, 2], [3, 4]]);
  });
  it('turns NaN (CDF fill values) into null so the line shows a gap', () => {
    const cache = { times: [1, 2, 3], columnNames: ['x'], columns: { x: [1, NaN, 3] } };
    expect(lineTable(cache)[1]).toEqual([1, null, 3]);
  });
});

describe('yRangeFromPixels', () => {
  const lin = { min: 0, max: 100, log: false, heightPx: 200 };
  it('maps pixel rows back to values on a linear axis (0 = top)', () => {
    expect(yRangeFromPixels(lin, 200, 0)).toEqual({ min: 0, max: 100 });
    expect(yRangeFromPixels(lin, 150, 50)).toEqual({ min: 25, max: 75 });
  });
  it('pans a log axis by whole decades per equal pixel shift', () => {
    const log = { min: 1, max: 1000, log: true, heightPx: 300 };
    const r = yRangeFromPixels(log, 200, -100); // shift up by one decade (100 px)
    expect(r.min).toBeCloseTo(10, 9);
    expect(r.max).toBeCloseTo(10000, 6);
  });
  it('returns null for a degenerate or inverted range', () => {
    expect(yRangeFromPixels(lin, 50, 50)).toBeNull();
    expect(yRangeFromPixels(lin, 0, 200)).toBeNull();
  });
});

describe('fmtTick', () => {
  it('keeps ordinary values short and exact', () => {
    expect(fmtTick(0)).toBe('0');
    expect(fmtTick(-250)).toBe('-250');
    expect(fmtTick(0.25)).toBe('0.25');
    expect(fmtTick(12345)).toBe('12345');
  });
  it('switches to exponent form for very large or very small magnitudes', () => {
    expect(fmtTick(1e-9)).toBe('1e-9');
    expect(fmtTick(2.5e7)).toBe('2.5e7');
  });
  it('drops floating-point noise', () => {
    expect(fmtTick(0.1 + 0.2)).toBe('0.3');
  });
  it('leaves a tick unlabeled when uPlot passes null (skipped log-axis minors)', () => {
    expect(fmtTick(null)).toBe('');
  });
});

describe('cleanText', () => {
  it('strips CDF NUL padding and surrounding blanks', () => {
    expect(cleanText('\u0000')).toBe('');
    expect(cleanText('nT\u0000\u0000 ')).toBe('nT');
    expect(cleanText(undefined)).toBe('');
  });
});

describe('productTitle', () => {
  const cache = { title: 'sw density' };
  it('prefers a label set on purpose (preset, shared config)', () => {
    expect(productTitle({ path: 'amda/sw_n', label: 'Density' }, cache)).toBe('Density');
  });
  it('uses the ISTP name when the label is just the path', () => {
    expect(productTitle({ path: 'amda/sw_n', label: 'amda/sw_n' }, cache)).toBe('sw density');
    expect(productTitle({ path: 'amda/sw_n' }, cache)).toBe('sw density');
  });
  it('falls back to the last path segment before the data arrives', () => {
    expect(productTitle({ path: 'amda/sw_n' }, undefined)).toBe('sw_n');
    expect(productTitle({ path: 'amda/sw_n' }, { title: '' })).toBe('sw_n');
  });
});

describe('dropZone', () => {
  it('near the top or bottom edge inserts a subplot there; the middle overlays', () => {
    expect(dropZone(5, 200)).toBe('before');
    expect(dropZone(195, 200)).toBe('after');
    expect(dropZone(100, 200)).toBe('into');
  });
  it('keeps the edge bands to 24 px on tall plots', () => {
    expect(dropZone(30, 400)).toBe('into');
    expect(dropZone(20, 400)).toBe('before');
  });
  it('keeps a middle band on short plots (a quarter each side at most)', () => {
    expect(dropZone(8, 40)).toBe('before');
    expect(dropZone(20, 40)).toBe('into');
    expect(dropZone(32, 40)).toBe('after');
  });
});

describe('distinctCrumbs', () => {
  it('drops the leading segments every result shares, so what tells them apart shows', () => {
    expect(distinctCrumbs([
      ['amda', 'Parameters', 'SW Models', 'Bepi', 'Tao'],
      ['amda', 'Parameters', 'SW Models', 'Juno', 'Tao'],
    ])).toEqual(['… / Bepi / Tao', '… / Juno / Tao']);
  });
  it('keeps at least the last segment', () => {
    expect(distinctCrumbs([['amda', 'X'], ['amda', 'X']])).toEqual(['… / X', '… / X']);
  });
  it('keeps a lone result whole, and paths with nothing in common as they are', () => {
    expect(distinctCrumbs([['cda', 'ACE']])).toEqual(['cda / ACE']);
    expect(distinctCrumbs([['cda', 'ACE'], ['amda', 'ACE']])).toEqual(['cda / ACE', 'amda / ACE']);
  });
});

describe('product params', () => {
  const frame = { key: 'coordinate_system', label: 'Frame', choices: [['gse', 'gse'], ['gsm', 'gsm']], default: 'gse' };
  const side = { key: 'side', label: 'Side', choices: [['0', '0'], ['1', '1']], default: '0' };

  it('reads the product value, else the default', () => {
    expect(paramValue({ path: 'ssc/ace' }, frame)).toBe('gse');
    expect(paramValue({ path: 'ssc/ace', coordinateSystem: 'gsm' }, frame)).toBe('gsm');
    expect(paramValue({ path: 'amda/x', productInputs: { side: '1' } }, side)).toBe('1');
  });

  it('sets a coordinate system or one template argument, keeping the others', () => {
    expect(withParam({ path: 'ssc/ace' }, 'coordinate_system', 'gsm')).toEqual({ path: 'ssc/ace', coordinateSystem: 'gsm' });
    expect(withParam({ path: 'amda/x', productInputs: { side: '0', level: 'L2' } }, 'side', '1'))
      .toEqual({ path: 'amda/x', productInputs: { side: '1', level: 'L2' } });
  });
});

describe('time window helpers', () => {
  const H = 3600000;
  // Editing the start then the stop used to apply [new start, old stop] in between:
  // years of data fetched for a window nobody asked for.
  it('editedRange: a new start moves the window, keeping its width', () => {
    expect(editedRange('start', 2 * H, 0, 10 * H)).toEqual([2 * H, 12 * H]);
    expect(editedRange('start', -1000 * H, 0, 10 * H)).toEqual([-1000 * H, -990 * H]);
  });
  it('editedRange: a new stop sets the width, or moves the window when before the start', () => {
    expect(editedRange('stop', 5 * H, 0, 10 * H)).toEqual([0, 5 * H]);
    expect(editedRange('stop', -1 * H, 0, 10 * H)).toEqual([-11 * H, -1 * H]);
  });
  it('formatSpan gives the two largest units', () => {
    expect(formatSpan(56 * H)).toBe('2d 8h');
    expect(formatSpan(H + 30 * 60000)).toBe('1h 30m');
    expect(formatSpan(24 * H)).toBe('1d');
    expect(formatSpan(45 * 1000)).toBe('45s');
    expect(formatSpan(400 * 24 * H)).toBe('400d');
  });
});

describe('colour (Z) range', () => {
  const cache = { rows: [[1, 10], [100, 5]], valueRange: { vMin: 1, vMax: 100 } };
  it('follows the data until a range is set', () => {
    expect(zRangeOf(createSubplotData(), cache)).toEqual({ vMin: 1, vMax: 100 });
    expect(zRangeOf({ ...createSubplotData(), _zOverride: { vMin: 3, vMax: 30 } }, cache)).toEqual({ vMin: 3, vMax: 30 });
  });
  it('a set range is saved and restored as z_range', () => {
    const sp = { ...createSubplotData(), _zOverride: { vMin: 3, vMax: 30 } };
    const cfg = subplotToConfig(sp);
    expect(cfg.z_range).toEqual([3, 30]);
    expect(subplotFromConfig(cfg)._zOverride).toEqual({ vMin: 3, vMax: 30 });
    expect(subplotToConfig(createSubplotData()).z_range).toBeUndefined();
    expect(subplotFromConfig({ products: [] })._zOverride).toBeUndefined();
  });
});

describe('outOfCoverage', () => {
  const D = 86400000;
  const coverage = { start: 100 * D, stop: 200 * D };
  it('is null when the window overlaps the coverage', () => {
    expect(outOfCoverage(coverage, 150 * D, 160 * D)).toBeNull();
    expect(outOfCoverage(coverage, 195 * D, 205 * D)).toBeNull();
    expect(outOfCoverage(null, 0, D)).toBeNull();
  });
  it('after the coverage: a window of the same length ending at its last data', () => {
    expect(outOfCoverage(coverage, 300 * D, 302 * D)).toEqual({ side: 'after', range: [198 * D, 200 * D] });
  });
  it('before the coverage: a window of the same length starting at its first data', () => {
    expect(outOfCoverage(coverage, 10 * D, 13 * D)).toEqual({ side: 'before', range: [100 * D, 103 * D] });
  });
});

describe('rangeFromDrag (Shift+drag marks an event)', () => {
  const view = { start: 1000, end: 2000 };

  it('maps the dragged fractions of the plot width onto the view, either direction', () => {
    expect(rangeFromDrag(view, 0.2, 0.5)).toEqual({ start: 1200, end: 1500 });
    expect(rangeFromDrag(view, 0.5, 0.2)).toEqual({ start: 1200, end: 1500 });
  });

  it('clamps a drag that leaves the plot area', () => {
    expect(rangeFromDrag(view, -0.3, 1.4)).toEqual({ start: 1000, end: 2000 });
  });

  it('ignores a click or a tiny drag', () => {
    expect(rangeFromDrag(view, 0.5, 0.5)).toBeNull();
    expect(rangeFromDrag(view, 0.5, 0.502)).toBeNull();
  });
});

describe('event colours (a colour picker gives #rrggbb, shading needs transparency)', () => {
  it('reads the picker value of a colour', () => {
    expect(colorHex('rgba(100, 140, 255, 0.12)')).toBe('#648cff');
    expect(colorHex('#ff7850')).toBe('#ff7850');
    expect(colorHex('not a colour')).toBe('#648cff');
  });

  it('takes the picked hue and keeps the transparency', () => {
    expect(withHue('rgba(100, 140, 255, 0.12)', '#ff7850')).toBe('rgba(255, 120, 80, 0.12)');
  });

  it('draws an event edge in its own hue, nearly opaque, so it shows over curves and spectrograms', () => {
    expect(edgeColor('rgba(255, 120, 80, 0.12)')).toBe('rgba(255, 120, 80, 0.85)');
    expect(edgeColor('garbage')).toBe('rgba(100, 140, 255, 0.85)');
  });

  it('gives an opaque colour a light default transparency', () => {
    expect(withHue('#000000', '#ff7850')).toBe('rgba(255, 120, 80, 0.15)');
  });
});
