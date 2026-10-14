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
  // A fake panel.plotAt: two plots, rows 0-290 and 310-600, a gap between them.
  const plotAt = (x, y) => (y >= 0 && y <= 290 ? { index: 0 } : y >= 310 && y <= 600 ? { index: 1 } : null);
  const drop = (y) => dropAction(plotAt, 100, y, 2);

  it('adds a new subplot when the panel is empty', () => {
    expect(dropAction(() => null, 100, 10, 0)).toEqual({ type: 'addProduct', index: null });
  });

  it('adds into the plot under the pointer', () => {
    expect(drop(150)).toEqual({ type: 'addProduct', index: 0 });
    expect(drop(450)).toEqual({ type: 'addProduct', index: 1 });
  });

  it('inserts a new subplot on the top or bottom edge of a plot', () => {
    expect(drop(5)).toEqual({ type: 'insertProduct', index: 0 });
    expect(drop(285)).toEqual({ type: 'insertProduct', index: 1 });
    expect(drop(315)).toEqual({ type: 'insertProduct', index: 1 });
    expect(drop(595)).toEqual({ type: 'insertProduct', index: 2 });
  });

  it('inserts a new subplot after the plot above a gap', () => {
    expect(drop(300)).toEqual({ type: 'insertProduct', index: 1 });
  });

  it('appends a new subplot when nothing is near the pointer', () => {
    expect(drop(700)).toEqual({ type: 'insertProduct', index: 2 });
  });
});
