import { describe, it, expect } from 'vitest';
import {
  mergeSorted, mergeSortedRows, mergeIntervals, evictProductCache, buildSeriesData,
  detectPlotType, configToBase64, base64ToConfig,
  createSubplotData, createProductCache, subplotToConfig, subplotFromConfig,
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
