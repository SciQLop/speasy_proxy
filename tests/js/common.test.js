import { describe, it, expect } from 'vitest';
import {
  toLocalISOString, escapeHtml, formatDateInput, parseDateInput,
} from '../../speasy_proxy/static/js/common.js';

describe('toLocalISOString', () => {
  it('formats local datetime with zero-padded seconds', () => {
    expect(toLocalISOString(new Date(2018, 0, 5, 3, 7, 9))).toBe('2018-01-05T03:07:09');
  });
  it('includes seconds even when zero (the drift fix)', () => {
    expect(toLocalISOString(new Date(2020, 10, 30, 23, 0, 0))).toBe('2020-11-30T23:00:00');
  });
});

describe('formatDateInput', () => {
  it('formats day-first DD-MM-YYYY HH:MM:SS, zero-padded', () => {
    expect(formatDateInput(new Date(2016, 5, 1, 3, 7, 9))).toBe('01-06-2016 03:07:09');
  });
});

describe('parseDateInput', () => {
  it('round-trips with formatDateInput', () => {
    const d = new Date(2016, 5, 1, 3, 7, 9);
    expect(parseDateInput(formatDateInput(d)).getTime()).toBe(d.getTime());
  });
  it('parses day-first as day then month (not swapped)', () => {
    const d = parseDateInput('02-06-2016 00:00');
    expect(d.getDate()).toBe(2);
    expect(d.getMonth()).toBe(5); // June
  });
  it('accepts / and . separators and optional seconds/time', () => {
    expect(parseDateInput('02/06/2016 01:02').getMinutes()).toBe(2);
    expect(parseDateInput('02.06.2016 01:02:03').getSeconds()).toBe(3);
    expect(parseDateInput('02-06-2016').getHours()).toBe(0);
  });
  it('rejects malformed or out-of-range input', () => {
    expect(parseDateInput('')).toBeNull();
    expect(parseDateInput('2016-06-02 00:00')).toBeNull(); // year-first not accepted
    expect(parseDateInput('32-06-2016 00:00')).toBeNull();
    expect(parseDateInput('02-13-2016 00:00')).toBeNull();
    expect(parseDateInput('02-06-2016 25:00')).toBeNull();
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
