import { describe, it, expect } from 'vitest';
import { toLocalISOString, escapeHtml } from '../../speasy_proxy/static/js/common.js';

describe('toLocalISOString', () => {
  it('formats local datetime with zero-padded seconds', () => {
    expect(toLocalISOString(new Date(2018, 0, 5, 3, 7, 9))).toBe('2018-01-05T03:07:09');
  });
  it('includes seconds even when zero (the drift fix)', () => {
    expect(toLocalISOString(new Date(2020, 10, 30, 23, 0, 0))).toBe('2020-11-30T23:00:00');
  });
});

describe('escapeHtml', () => {
  it('escapes HTML metacharacters', () => {
    expect(escapeHtml('<b>a & "b"</b>')).toBe('&lt;b&gt;a &amp; &quot;b&quot;&lt;/b&gt;');
  });
  it('passes through safe text', () => {
    expect(escapeHtml('hello')).toBe('hello');
  });
});
