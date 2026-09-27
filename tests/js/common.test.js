import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import {
  escapeHtml, formatDateInput, parseDateInput, setDateInput, parseUtc,
  installErrorBoundary, runWithConcurrency,
} from '../../speasy_proxy/static/js/common.js';

// Inventory dates ('1997-08-25 17:48:00') and config/link times ('2024-01-01T00:00:00')
// carry no zone: JS reads them as local time, which shifted views by the UTC offset.
describe('parseUtc', () => {
  let tz;
  beforeAll(() => { tz = process.env.TZ; process.env.TZ = 'Europe/Paris'; });
  afterAll(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; });
  it('reads a zone-less ISO date-time as UTC', () => {
    expect(parseUtc('2024-01-01T00:00:00').getTime()).toBe(Date.UTC(2024, 0, 1));
  });
  it('reads the inventory space-separated form as UTC', () => {
    expect(parseUtc('1997-08-25 17:48:00').getTime()).toBe(Date.UTC(1997, 7, 25, 17, 48));
  });
  it('keeps an explicit zone and a bare date', () => {
    expect(parseUtc('2024-01-01T00:00:00+02:00').getTime()).toBe(Date.UTC(2023, 11, 31, 22));
    expect(parseUtc('2024-01-01T00:00:00.000Z').getTime()).toBe(Date.UTC(2024, 0, 1));
    expect(parseUtc('2024-01-01').getTime()).toBe(Date.UTC(2024, 0, 1));
  });
  it('passes numbers (epoch ms) through', () => {
    expect(parseUtc(86400000).getTime()).toBe(86400000);
  });
});

// The time inputs are UTC, like the plot axes and the data: in local time a user east
// of Greenwich typing 00:00 got data from the previous day.
describe('formatDateInput', () => {
  it('formats day-first DD-MM-YYYY HH:MM:SS in UTC, zero-padded', () => {
    expect(formatDateInput(new Date(Date.UTC(2016, 5, 1, 3, 7, 9)))).toBe('01-06-2016 03:07:09');
  });
});

describe('parseDateInput', () => {
  it('reads the fields as UTC', () => {
    expect(parseDateInput('01-01-2020 00:00').toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });
  it('round-trips with formatDateInput', () => {
    const d = new Date(Date.UTC(2016, 5, 1, 3, 7, 9));
    expect(parseDateInput(formatDateInput(d)).getTime()).toBe(d.getTime());
  });
  it('parses day-first as day then month (not swapped)', () => {
    const d = parseDateInput('02-06-2016 00:00');
    expect(d.getUTCDate()).toBe(2);
    expect(d.getUTCMonth()).toBe(5); // June
  });
  it('accepts / and . separators and optional seconds/time', () => {
    expect(parseDateInput('02/06/2016 01:02').getUTCMinutes()).toBe(2);
    expect(parseDateInput('02.06.2016 01:02:03').getUTCSeconds()).toBe(3);
    expect(parseDateInput('02-06-2016').getUTCHours()).toBe(0);
  });
  it('rejects malformed or out-of-range input', () => {
    expect(parseDateInput('')).toBeNull();
    expect(parseDateInput('2016-06-02 00:00')).toBeNull(); // year-first not accepted
    expect(parseDateInput('32-06-2016 00:00')).toBeNull();
    expect(parseDateInput('02-13-2016 00:00')).toBeNull();
    expect(parseDateInput('02-06-2016 25:00')).toBeNull();
  });
});

describe('setDateInput', () => {
  it('shows the UTC time in a flatpickr field too', () => {
    const el = { _flatpickr: { setDate: vi.fn() } };
    setDateInput(el, new Date(Date.UTC(2020, 0, 1, 0, 0, 0)));
    expect(el._flatpickr.setDate).toHaveBeenCalledWith('01-01-2020 00:00:00', false, 'd-m-Y H:i:S');
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

  it('extracts reason.message from PromiseRejectionEvent', () => {
    installDomMock();
    installErrorBoundary('s');
    if (typeof PromiseRejectionEvent !== 'undefined') {
      window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { reason: new Error('rejected!') }));
    } else {
      const ev = new Event('unhandledrejection');
      ev.reason = new Error('rejected!');
      window.dispatchEvent(ev);
    }
    expect(document.getElementById('s').textContent).toContain('rejected!');
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

describe('runWithConcurrency', () => {
  it('runs all tasks and returns results in order', async () => {
    const results = await runWithConcurrency([
      () => Promise.resolve(1),
      () => Promise.resolve(2),
      () => Promise.resolve(3),
    ], 2);
    expect(results).toEqual([1, 2, 3]);
  });

  it('respects the concurrency limit', async () => {
    let active = 0;
    let maxActive = 0;
    const makeTask = (ms) => () => new Promise(resolve => {
        active++;
        maxActive = Math.max(maxActive, active);
        setTimeout(() => { active--; resolve(ms); }, ms);
    });
    await runWithConcurrency([makeTask(10), makeTask(10), makeTask(10), makeTask(10)], 2);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('handles an empty task list', async () => {
    expect(await runWithConcurrency([], 3)).toEqual([]);
  });
});
