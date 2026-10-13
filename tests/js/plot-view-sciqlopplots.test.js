import { describe, it, expect } from 'vitest';
import { lineArrays, colormapArrays } from '../../speasy_proxy/static/js/plot-view-sciqlopplots.js';

const asArray = (typed) => Array.from(typed);

describe('lineArrays', () => {
  const cache = {
    times: [1000, 2000, 3000],
    columnNames: ['x', 'y'],
    columns: { x: [1, null, 3], y: [4, 5, Number.NaN] },
  };

  it('gives times in seconds and values row-major, missing values as NaN', () => {
    const { t, values, shape } = lineArrays(cache);
    expect(asArray(t)).toEqual([1, 2, 3]);
    expect(shape).toEqual([3, 2]);
    expect(asArray(values)).toEqual([1, 4, Number.NaN, 5, 3, Number.NaN]);
  });
});

describe('colormapArrays', () => {
  it('shares one y axis when every row has the same channels', () => {
    const { t, y, yShape, z, zShape } = colormapArrays({
      times: [1000, 2000], rows: [[1, 2, 3], [4, null, 6]], yTables: [[10, 20, 30]], yIndex: [0, 0],
    });
    expect(asArray(t)).toEqual([1, 2]);
    expect(yShape).toEqual([3]);
    expect(asArray(y)).toEqual([10, 20, 30]);
    expect(zShape).toEqual([2, 3]);
    expect(asArray(z)).toEqual([1, 2, 3, 4, Number.NaN, 6]);
  });

  it('gives each row its own y axis when the channels change, padded with NaN', () => {
    const { y, yShape, z, zShape } = colormapArrays({
      times: [1000, 2000], rows: [[1, 2], [3, 4, 5]], yTables: [[10, 20], [1, 2, 3]], yIndex: [0, 1],
    });
    expect(yShape).toEqual([2, 3]);
    expect(asArray(y)).toEqual([10, 20, Number.NaN, 1, 2, 3]);
    expect(zShape).toEqual([2, 3]);
    expect(asArray(z)).toEqual([1, 2, Number.NaN, 3, 4, 5]);
  });
});
