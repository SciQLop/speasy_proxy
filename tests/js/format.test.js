import { describe, it, expect } from 'vitest';
import { formatBytes, formatNumber, formatDuration } from '../../speasy_proxy/static/js/format.js';

describe('format', () => {
  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024 * 5)).toBe('5.0 MB');
  });
  it('formats numbers with K/M', () => {
    expect(formatNumber(500)).toBe('500');
    expect(formatNumber(1500)).toBe('1.5K');
    expect(formatNumber(2_000_000)).toBe('2.0M');
  });
  it('formats durations', () => {
    expect(formatDuration(90)).toBe('1m');
    expect(formatDuration(3 * 3600 + 5 * 60)).toBe('3h 5m');
    expect(formatDuration(2 * 86400 + 4 * 3600)).toBe('2d 4h');
  });
});
