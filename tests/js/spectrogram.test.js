import { describe, it, expect } from 'vitest';
import { COLORMAPS, colormapLut, computeYEdges, spectrogramValueAt, renderSpectrogramImage, ascendingSpectrogram, binRowRects, lowestPositiveEdge } from '../../speasy_proxy/static/js/spectrogram.js';

describe('spectrogram', () => {
  it('builds a 256-entry RGB viridis LUT with correct endpoints', () => {
    const lut = colormapLut('viridis');
    expect(lut).toHaveLength(256 * 3);
    expect([lut[0], lut[1], lut[2]]).toEqual([68, 1, 84]);
    expect([lut[765], lut[766], lut[767]]).toEqual([253, 231, 37]);
  });
  it('builds a LUT per named colormap, viridis for an unknown name', () => {
    expect(Object.keys(COLORMAPS)).toContain('jet');
    const jet = colormapLut('jet');
    expect([jet[0], jet[1], jet[2]]).toEqual([0, 0, 128]);
    expect([jet[765], jet[766], jet[767]]).toEqual([128, 0, 0]);
    expect(colormapLut('no-such-map')).toBe(colormapLut('viridis'));
  });
  it('computes bin edges around centers', () => {
    const edges = computeYEdges([1, 2, 3]);
    expect(edges).toHaveLength(4);
    expect(edges[0]).toBeCloseTo(0.5, 6);
    expect(edges[1]).toBeCloseTo(1.5, 6);
    expect(edges[2]).toBeCloseTo(2.5, 6);
    expect(edges[3]).toBeCloseTo(3.5, 6);
  });

  describe('spectrogramValueAt', () => {
    const times = [1000, 2000, 3000];
    const yBins = [10, 20, 40]; // edges: [5, 15, 30, 50]
    const rows = [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ];
    it('finds the cell at the exact time and bin center', () => {
      expect(spectrogramValueAt(times, rows, yBins, 2000, 20)).toBe(5);
      expect(spectrogramValueAt(times, rows, yBins, 1000, 10)).toBe(1);
    });
    it('snaps to the nearest time column', () => {
      expect(spectrogramValueAt(times, rows, yBins, 2400, 20)).toBe(5); // closer to 2000
      expect(spectrogramValueAt(times, rows, yBins, 2600, 20)).toBe(8); // closer to 3000
    });
    it('snaps the y value into its containing bin', () => {
      expect(spectrogramValueAt(times, rows, yBins, 1000, 14)).toBe(1); // bin [5,15)
      expect(spectrogramValueAt(times, rows, yBins, 1000, 29)).toBe(2); // bin [15,30)
      expect(spectrogramValueAt(times, rows, yBins, 1000, 49)).toBe(3); // bin [30,50]
    });
    it('returns null outside the y range', () => {
      expect(spectrogramValueAt(times, rows, yBins, 1000, 1)).toBeNull();
      expect(spectrogramValueAt(times, rows, yBins, 1000, 100)).toBeNull();
    });
    it('returns null for missing or NaN cells', () => {
      const gappy = [[null, NaN, 3], [4, 5, 6], [7, 8, 9]];
      expect(spectrogramValueAt(times, gappy, yBins, 1000, 10)).toBeNull();
      expect(spectrogramValueAt(times, gappy, yBins, 1000, 20)).toBeNull();
    });
    it('returns null for empty inputs', () => {
      expect(spectrogramValueAt([], [], [], 0, 0)).toBeNull();
      expect(spectrogramValueAt(times, rows, yBins, NaN, 20)).toBeNull();
    });
  });

  describe('renderSpectrogramImage', () => {
    // Minimal canvas mock for the Node test environment (no real DOM).
    function installCanvasMock() {
      const origCreate = globalThis.document?.createElement;
      globalThis.document = globalThis.document || {};
      globalThis.document.createElement = (tag) => {
        if (tag !== 'canvas') return origCreate ? origCreate(tag) : {};
        const canvas = { width: 0, height: 0, imageData: null };
        canvas.getContext = () => ({
          createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
          putImageData: (img) => { canvas.imageData = img; },
        });
        return canvas;
      };
    }

    installCanvasMock();

    function makeData(nTime, nY) {
      const times = [];
      for (let t = 0; t < nTime; t++) times.push(t * 1000);
      const rows = [];
      for (let t = 0; t < nTime; t++) {
        const row = [];
        for (let y = 0; y < nY; y++) row.push((t + 1) * (y + 1));
        rows.push(row);
      }
      const yBins = [];
      for (let y = 0; y < nY; y++) yBins.push(y + 1);
      return { times, rows, yBins };
    }

    it('renders at full width when under the cap', () => {
      const { times, rows, yBins } = makeData(100, 5);
      const result = renderSpectrogramImage(times, rows, yBins, 1, 500, false, null);
      expect(result).not.toBeNull();
      expect(result.canvas.width).toBe(100);
      expect(result.canvas.height).toBe(5);
    });

    it('caps canvas width and decimates columns when over the cap', () => {
      const { times, rows, yBins } = makeData(10000, 10);
      const result = renderSpectrogramImage(times, rows, yBins, 1, 100000, false, null);
      expect(result).not.toBeNull();
      expect(result.canvas.width).toBeLessThanOrEqual(4096);
      expect(result.canvas.height).toBe(10);
    });

    it('spans from the first sample to the end of the last one, regardless of capping', () => {
      const { times, rows, yBins } = makeData(10000, 10);
      const result = renderSpectrogramImage(times, rows, yBins, 1, 100000, false, null);
      expect(result.tStart).toBe(times[0]);
      expect(result.tEnd).toBe(times[times.length - 1] + 1000);  // the last sample covers one cadence
      expect(result.yMin).toBe(yBins[0]);
      expect(result.yMax).toBe(yBins[yBins.length - 1]);
    });

    // Columns are decimated once the slice exceeds the canvas cap; a burst sitting on a
    // dropped source index must still reach the image, or the user sees a quiet interval
    // where the instrument actually spiked.
    it('keeps a burst that falls on a decimated-away column', () => {
      const { times, rows, yBins } = makeData(10000, 4);
      for (const row of rows) row.fill(1);
      const burstIdx = 5001; // not hit by nearest-neighbour picking (step = 10000/4096)
      rows[burstIdx][2] = 1e6;

      const result = renderSpectrogramImage(times, rows, yBins, 1, 1e6, false, null);
      const { data, width } = result.canvas.imageData;
      const py = 4 - 1 - 2;
      let brightest = 0;
      for (let t = 0; t < width; t++) brightest = Math.max(brightest, data[(py * width + t) * 4]);
      expect(brightest).toBe(253); // viridis top of scale
    });

    // Columns used to be one per sample, evenly spaced: a data gap, or the uneven rows
    // a resampled refetch brings, moved every later sample to the wrong time.
    it('places samples at their own time and leaves a data gap empty', () => {
      const times = [0, 1000, 2000, 3000, 10000, 11000, 12000, 13000];
      const rows = times.map((t) => [t < 5000 ? 1 : 2]);
      const result = renderSpectrogramImage(times, rows, [1], 1, 2, false, null);
      const { data, width } = result.canvas.imageData;
      const span = result.tEnd - result.tStart;
      const alphaAt = (t) => data[Math.floor(((t - result.tStart) / span) * width) * 4 + 3];

      expect(alphaAt(6000)).toBe(0);     // inside the gap: nothing drawn
      expect(alphaAt(8000)).toBe(0);
      expect(alphaAt(10500)).toBe(255);  // data resumes where it really is
      expect(alphaAt(1500)).toBe(255);
    });

    it('stretches each sample of a sparse slice up to the next one, not to one thin column', () => {
      const times = [0, 1000, 2000, 3000];
      const result = renderSpectrogramImage(times, times.map(() => [1]), [1], 1, 2, false, null);
      const { data, width } = result.canvas.imageData;
      for (let c = 0; c < width; c++) expect(data[c * 4 + 3]).toBe(255);
    });

    // After a zoom-out the cache holds full-resolution rows next to coarser resampled
    // ones: the coarse stretch is continuous data, not a run of gaps.
    it('fills a coarser stretch of samples instead of striping it', () => {
      const times = [];
      for (let t = 0; t < 2000; t += 10) times.push(t);      // fine cadence: 200 samples
      for (let t = 2000; t < 12000; t += 100) times.push(t); // coarse cadence: 100 samples
      const result = renderSpectrogramImage(times, times.map(() => [1]), [1], 1, 2, false, null);
      const { data, width } = result.canvas.imageData;
      const span = result.tEnd - result.tStart;
      const lit = (t) => data[Math.floor(((t - result.tStart) / span) * width) * 4 + 3] === 255;
      for (let t = 2000; t < 11900; t += 37) expect(lit(t)).toBe(true);
    });

    // The server keeps each bucket's most intense row, anywhere in the bucket: two rows can
    // sit side by side, then the next step spans almost two buckets. Compared with the tiny
    // steps around it, that step used to read as a gap and left an empty vertical stripe.
    it('fills the uneven steps of a resampled slice', () => {
      const bucket = 1000;
      const offsets = [900, 10, 990, 5, 500, 995, 0, 999, 20, 980, 10, 990, 500, 500];
      const times = offsets.map((o, b) => b * bucket + o);
      const result = renderSpectrogramImage(times, times.map(() => [1]), [1], 1, 2, false, null);
      const { data, width } = result.canvas.imageData;
      for (let c = 0; c < width; c++) expect(data[c * 4 + 3]).toBe(255);
    });

    // A lone fill row (all NaN) inside a gap must not make the gap look like sparse data.
    it('ignores empty rows when deciding what is a gap', () => {
      const times = [0, 100, 200, 300, 400, 5000, 9000, 9100, 9200, 9300];
      const rows = times.map((t) => (t === 5000 ? [NaN] : [1]));
      const result = renderSpectrogramImage(times, rows, [1], 1, 2, false, null);
      const { data, width } = result.canvas.imageData;
      const span = result.tEnd - result.tStart;
      const alphaAt = (t) => data[Math.floor(((t - result.tStart) / span) * width) * 4 + 3];
      expect(alphaAt(2500)).toBe(0);
      expect(alphaAt(7000)).toBe(0);
      expect(alphaAt(9150)).toBe(255);
    });

    it('paints with the requested colormap', () => {
      const result = renderSpectrogramImage([0, 1000], [[2], [2]], [1], 1, 2, false, null, 'jet');
      const { data } = result.canvas.imageData;
      expect([data[0], data[1], data[2]]).toEqual([128, 0, 0]); // jet top of scale
    });

    it('returns null for empty data', () => {
      expect(renderSpectrogramImage([], [], [], 1, 10, false, null)).toBeNull();
    });

    it('respects the view window to render only the visible slice', () => {
      const { times, rows, yBins } = makeData(500, 5);
      const view = { start: 100000, end: 200000 };
      const result = renderSpectrogramImage(times, rows, yBins, 1, 500, false, view);
      expect(result).not.toBeNull();
      // view range 100000ms ± 50% → 200000ms render window → indices 50..250 inclusive = 201 points
      expect(result.canvas.width).toBe(201);
    });
  });
});

describe('ascendingSpectrogram', () => {
  it('flips descending bins and every row so bins read low-to-high', () => {
    const out = ascendingSpectrogram([300, 200, 100], [[3, 2, 1], [30, 20, 10]]);
    expect(out.yAxis).toEqual([100, 200, 300]);
    expect(out.rows).toEqual([[1, 2, 3], [10, 20, 30]]);
  });
  it('flips per-time (2D) bin tables too', () => {
    const out = ascendingSpectrogram([[30, 20], [31, 21]], [[3, 2], [4, 5]]);
    expect(out.yAxis).toEqual([[20, 30], [21, 31]]);
    expect(out.rows).toEqual([[2, 3], [5, 4]]);
  });
  it('leaves ascending data untouched', () => {
    const yAxis = [1, 2, 3];
    const rows = [[1, 2, 3]];
    const out = ascendingSpectrogram(yAxis, rows);
    expect(out.yAxis).toBe(yAxis);
    expect(out.rows).toBe(rows);
  });
  it('keeps missing rows missing', () => {
    expect(ascendingSpectrogram([2, 1], [null, [1, 2]]).rows).toEqual([null, [2, 1]]);
  });
});

// Each bin is drawn between its own edges, so it lands where the y axis puts it whatever
// the bin spacing (linear, log) and the axis scale. Stretching one block of evenly spaced
// rows was only right when both spacings matched.
describe('binRowRects', () => {
  const linearPos = (v) => 1000 - v;                 // canvas y grows downward
  const logPos = (v) => 1000 - 100 * Math.log10(v);  // 100 px per decade

  it('places linear bins at their true height on a log axis', () => {
    const edges = computeYEdges([10, 20, 30, 40]);   // 5, 15, 25, 35, 45
    const rects = binRowRects(edges, logPos);
    for (let y = 0; y < 4; y++) {
      expect(rects[y].top).toBe(Math.round(logPos(edges[y + 1])));
      expect(rects[y].top + rects[y].height).toBe(Math.round(logPos(edges[y])));
    }
    expect(rects[0].height).toBeGreaterThan(rects[3].height); // low bins are taller on a log axis
  });

  it('tiles the bins without gaps or overlaps', () => {
    const rects = binRowRects(computeYEdges([1, 2.5, 3, 7, 7.2, 20]), linearPos);
    for (let y = 0; y + 1 < rects.length; y++) expect(rects[y + 1].top + rects[y + 1].height).toBe(rects[y].top);
  });

  it('maps bin y to canvas row nY-1-y (the image stores the highest bin first)', () => {
    expect(binRowRects(computeYEdges([1, 2, 3]), linearPos).map((r) => r.srcRow)).toEqual([2, 1, 0]);
  });

  it('clamps edges at or below zero to the floor on a log axis instead of producing NaN/Infinity', () => {
    const edges = computeYEdges([0, 10, 20]);        // -5, 5, 15, 25
    const rects = binRowRects(edges, logPos, lowestPositiveEdge(edges));
    for (const r of rects) {
      expect(Number.isFinite(r.top)).toBe(true);
      expect(Number.isFinite(r.height)).toBe(true);
    }
    expect(rects[0].height).toBe(0);                 // the 0 bin has no extent on a log axis
    expect(rects[1].height).toBeGreaterThan(0);
  });
});

describe('lowestPositiveEdge', () => {
  it('is the smallest strictly positive edge', () => {
    expect(lowestPositiveEdge([-5, 5, 15, 25])).toBe(5);
    expect(lowestPositiveEdge([0.5, 1.5, 2.5])).toBe(0.5);
  });
  it('is null when no edge is positive', () => {
    expect(lowestPositiveEdge([-3, -1, 0])).toBeNull();
  });
});
