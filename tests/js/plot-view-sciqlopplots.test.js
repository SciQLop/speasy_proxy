import { describe, it, expect } from 'vitest';
import { lineColumns, colormapArrays, dropAction } from '../../speasy_proxy/static/js/plot-view-sciqlopplots.js';

const asArray = (typed) => Array.from(typed);

describe('lineColumns', () => {
  const cache = {
    times: [1000, 2000, 3000],
    columnNames: ['x', 'y'],
    columns: { x: [1, null, 3], y: [4, 5, Number.NaN] },
  };

  it('gives times in seconds and one typed array per column, missing values as NaN', () => {
    const { t, columns } = lineColumns(cache);
    expect(asArray(t)).toEqual([1, 2, 3]);
    expect(columns.map(asArray)).toEqual([[1, Number.NaN, 3], [4, 5, Number.NaN]]);
  });
});

describe('colormapArrays', () => {
  it('shares one y axis when every row has the same channels', () => {
    const { t, y, z } = colormapArrays({
      times: [1000, 2000], rows: [[1, 2, 3], [4, null, 6]], yTables: [[10, 20, 30]], yIndex: [0, 0],
    });
    expect(asArray(t)).toEqual([1, 2]);
    expect(asArray(y)).toEqual([10, 20, 30]);
    expect(asArray(z)).toEqual([1, 2, 3, 4, Number.NaN, 6]);
  });

  it('gives each row its own y axis when the channels change, padded with NaN', () => {
    const { y, z } = colormapArrays({
      times: [1000, 2000], rows: [[1, 2], [3, 4, 5]], yTables: [[10, 20], [1, 2, 3]], yIndex: [0, 1],
    });
    expect(asArray(y)).toEqual([10, 20, Number.NaN, 1, 2, 3]);
    expect(asArray(z)).toEqual([1, 2, Number.NaN, 3, 4, 5]);
  });
});

describe('dropAction', () => {
  it('adds a new subplot when the panel is empty', () => {
    expect(dropAction(10, 600, 0)).toEqual({ type: 'addProduct', index: null });
  });

  it('adds into the subplot under the pointer, the panel split evenly', () => {
    expect(dropAction(150, 600, 2)).toEqual({ type: 'addProduct', index: 0 });
    expect(dropAction(450, 600, 2)).toEqual({ type: 'addProduct', index: 1 });
  });

  it('inserts a new subplot on the edge of one', () => {
    expect(dropAction(5, 600, 2)).toEqual({ type: 'insertProduct', index: 0 });
    expect(dropAction(295, 600, 2)).toEqual({ type: 'insertProduct', index: 1 });
    expect(dropAction(599, 600, 2)).toEqual({ type: 'insertProduct', index: 2 });
  });

  it('keeps a drop on the bottom pixel in the last subplot', () => {
    expect(dropAction(600, 600, 2)).toEqual({ type: 'insertProduct', index: 2 });
  });
});
