import { describe, it, expect } from 'vitest';
import {
  shueParams, bowShockParams, classifyPoint, toReData, computeAxisRange, EARTH_RADIUS_KM,
} from '../../speasy_proxy/static/js/magnetosphere.js';

describe('magnetosphere', () => {
  it('computes Shue 1998 r0/alpha for nominal solar wind', () => {
    const { r0, alpha } = shueParams(2, 0);
    expect(r0).toBeCloseTo(10.0, 0);
    expect(alpha).toBeGreaterThan(0.5);
    expect(alpha).toBeLessThan(0.7);
  });
  it('classifies subsolar (inside) and far-upstream (solar wind) points', () => {
    const mp = shueParams(2, 0);
    const bs = bowShockParams(mp);
    expect(classifyPoint(3, 0, 0, mp, bs)).toBe(0);
    expect(classifyPoint(60, 0, 0, mp, bs)).toBe(2);
  });
  it('converts km to Re, drops too-distant and non-finite points', () => {
    const mp = shueParams(2, 0);
    const bs = bowShockParams(mp);
    const km = [
      [EARTH_RADIUS_KM * 3, 0, 0],
      [EARTH_RADIUS_KM * 1000, 0, 0],
      [NaN, 0, 0],
    ];
    const re = toReData(km, mp, bs);
    expect(re).toHaveLength(1);
    expect(re[0][0]).toBeCloseTo(3, 6);
    expect(re[0]).toHaveLength(4);
  });
  it('computes a symmetric axis range padded by 10%', () => {
    const range = computeAxisRange([[[5, -3, 0, 0], [1, 8, -2, 0]]]);
    expect(range.min).toBe(-range.max);
    expect(range.max).toBeGreaterThanOrEqual(9);
  });
});
