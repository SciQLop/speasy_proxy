import { describe, it, expect } from 'vitest';
import { VIRIDIS_LUT, computeYEdges } from '../../speasy_proxy/static/js/spectrogram.js';

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
});
