import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  toLocalISOString, escapeHtml, formatDateInput, parseDateInput,
  installErrorBoundary,
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

describe('installErrorBoundary', () => {
  // Minimal window + document mocks for the Node test environment.
  function installDomMock() {
    const elements = {};
    const listeners = {};
    globalThis.document = {
      getElementById: (id) => elements[id] || (elements[id] = { textContent: '' }),
    };
    globalThis.window = {
      addEventListener: (type, h) => { (listeners[type] ||= []).push(h); },
      removeEventListener: (type, h) => {
        listeners[type] = (listeners[type] || []).filter(x => x !== h);
      },
      dispatchEvent: (event) => {
        (listeners[event.type] || []).forEach(h => h(event));
        return true;
      },
    };
  }

  it('writes the error message to the status bar on window error', () => {
    installDomMock();
    installErrorBoundary('s');
    const ev = new Event('error');
    ev.message = 'boom';
    window.dispatchEvent(ev);
    expect(document.getElementById('s').textContent).toContain('boom');
  });

  it('falls back to the message string when error has no .message', () => {
    installDomMock();
    installErrorBoundary('s');
    window.dispatchEvent(new Event('unhandledrejection'));
    expect(document.getElementById('s').textContent).toContain('Unknown error');
  });

  it('returns a cleanup function that removes the handlers', () => {
    installDomMock();
    const cleanup = installErrorBoundary('s');
    cleanup();
    const ev = new Event('error');
    ev.message = 'after-cleanup';
    window.dispatchEvent(ev);
    expect(document.getElementById('s').textContent).not.toContain('after-cleanup');
  });
});
