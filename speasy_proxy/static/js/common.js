// Shared UI helpers + time formatting for the viewer pages.
// Plain ES module: imported by page modules and by Vitest.

export function toLocalISOString(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
  );
}

// Day-first display for the date inputs: "DD-MM-YYYY HH:MM:SS" (local time).
// Native datetime-local inputs render in the browser locale (often M/D/Y), so the
// viewer uses plain text fields with this explicit, unambiguous day-first format.
export function formatDateInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    pad(date.getDate()) + '-' + pad(date.getMonth() + 1) + '-' + date.getFullYear() +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
  );
}

// Attach a flatpickr calendar+time picker (day-first DD-MM-YYYY HH:MM) to a text input.
// flatpickr is a CDN global; if it failed to load, the field stays a plain text input
// (still parsed by parseDateInput), so this degrades gracefully.
export function attachDatePicker(el) {
  if (!el || typeof window === 'undefined' || !window.flatpickr) return null;
  return window.flatpickr(el, {
    enableTime: true,
    time_24hr: true,
    dateFormat: 'd-m-Y H:i',
    allowInput: true,
    minuteIncrement: 1,
  });
}

// Set a date field, keeping the flatpickr calendar in sync when present.
export function setDateInput(el, date) {
  if (!el) return;
  if (el._flatpickr) el._flatpickr.setDate(date, false);
  else el.value = formatDateInput(date);
}

// Parse "DD-MM-YYYY HH:MM[:SS]" (separators -, / or .; seconds optional; time optional)
// as local time. Returns a Date, or null if malformed / out of range.
export function parseDateInput(str) {
  const m = String(str).trim().match(
    /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (!m) return null;
  const [day, month, year, hh, mm, ss] =
    [m[1], m[2], m[3], m[4] || 0, m[5] || 0, m[6] || 0].map(Number);
  const date = new Date(year, month - 1, day, hh, mm, ss);
  // Reject overflow (e.g. 32-13-2020 rolling over) and out-of-range time.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
      || hh > 23 || mm > 59 || ss > 59) {
    return null;
  }
  return date;
}

export function escapeHtml(s) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(s).replace(/[&<>"']/g, (c) => map[c]);
}

export function setStatus(msg) {
  const el = document.getElementById('status-bar') || document.getElementById('statusBar');
  if (el) el.textContent = msg;
}

export function showLoading(visible) {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) overlay.classList.toggle('visible', visible);
}

export function showFetchBar(active) {
  const el = document.getElementById('fetch-bar');
  if (el) el.classList.toggle('active', active);
}

export function fallbackCopy(inputEl, btn) {
    inputEl.select();
    try {
        document.execCommand('copy');
        btn.textContent = 'Copied!';
    } catch (_) {
        btn.textContent = 'Select & copy manually';
    }
    setTimeout(() => { btn.textContent = 'Copy URL'; }, 2000);
}

// Run an array of async tasks with bounded concurrency. Useful for fetches:
// without a limit, restoring a URL with N satellites fires N simultaneous requests,
// which overwhelms the browser and server. Yields (awaits) between starting tasks
// once `limit` are in flight.
export async function runWithConcurrency(tasks, limit = 3) {
    const results = [];
    let idx = 0;
    async function worker() {
        while (idx < tasks.length) {
            const i = idx++;
            results[i] = await tasks[i]();
        }
    }
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

// Shared palette for series/trajectory colors across viewers.
export const CHART_COLORS = [
    '#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de',
    '#3ba272', '#fc8452', '#9a60b4', '#ea7ccc',
];

// Magnetopause region colors: magnetosphere, magnetosheath, solar wind.
export const REGION_COLORS = ['#91cc75', '#fac858', '#ee6666'];

// Install a top-level error handler that surfaces uncaught exceptions in the
// status bar instead of failing silently. Returns a cleanup function.
export function installErrorBoundary(statusBarId) {
    const handler = (event) => {
        const msg = (event.error && event.error.message) || (event.reason && event.reason.message) || event.message || 'Unknown error';
        console.error('Uncaught error:', event.error || event.reason || event.message);
        const el = document.getElementById(statusBarId);
        if (el) el.textContent = 'Error: ' + msg + ' — reload the page.';
    };
    window.addEventListener('error', handler);
    window.addEventListener('unhandledrejection', handler);
    return () => {
        window.removeEventListener('error', handler);
        window.removeEventListener('unhandledrejection', handler);
    };
}
