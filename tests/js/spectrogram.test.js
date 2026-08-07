import { describe, it, expect } from 'vitest';
import { VIRIDIS_LUT, computeYEdges, spectrogramValueAt, renderSpectrogramImage } from '../../speasy_proxy/static/js/spectrogram.js';

describe('spectrogram', () => {
  it('builds a 256-entry RGB viridis LUT with correct endpoints', () => {
    expect(VIRIDIS_LUT).toHaveLength(256 * 3);
    expect([VIRIDIS_LUT[0], VIRIDIS_LUT[1], VIRIDIS_LUT[2]]).toEqual([68, 1, 84]);
    expect([VIRIDIS_LUT[765], VIRIDIS_LUT[766], VIRIDIS_LUT[767]]).toEqual([253, 231, 37]);
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
        const canvas = { width: 0, height: 0 };
        canvas.getContext = () => ({
          createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
          putImageData: () => {},
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

    it('preserves tStart/tEnd/yMin/yMax regardless of capping', () => {
      const { times, rows, yBins } = makeData(10000, 10);
      const result = renderSpectrogramImage(times, rows, yBins, 1, 100000, false, null);
      expect(result.tStart).toBe(times[0]);
      expect(result.tEnd).toBe(times[times.length - 1]);
      expect(result.yMin).toBe(yBins[0]);
      expect(result.yMax).toBe(yBins[yBins.length - 1]);
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
