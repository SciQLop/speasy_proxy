import { describe, it, expect } from 'vitest';
import {
  mergeSorted, mergeSortedRows, mergeIntervals, evictProductCache, buildSeriesData,
  detectPlotType, configToBase64, base64ToConfig,
  createSubplotData, createProductCache, subplotToConfig, subplotFromConfig,
  normalizeWheelDelta, zoomRange, panRange, axisExtent, structureKey,
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

describe('axisExtent', () => {
  it('pads the loaded span symmetrically', () => {
    expect(axisExtent([10, 20], 0.5)).toEqual({ min: 5, max: 25 });
  });
  it('returns undefined bounds for empty data', () => {
    expect(axisExtent([], 0.5)).toEqual({ min: undefined, max: undefined });
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
