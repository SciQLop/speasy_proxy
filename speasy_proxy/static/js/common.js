// Shared UI helpers + time formatting for the viewer pages.
// Plain ES module: imported by page modules and by Vitest.

// Display for the date inputs: "YYYY-MM-DD HH:MM:SS", in UTC like the plot axes and the
// data (local time shifted every typed time by the browser's offset). Year-first is what
// catalogs, papers and speasy write; native datetime-local inputs render in the browser
// locale (often M/D/Y), so the viewer uses plain text fields with this explicit format.
export function formatDateInput(date) {
  return wallClockText(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds());
}

function wallClockText(year, month, day, hh, mm, ss) {
  const pad = (n) => String(n).padStart(2, '0');
  return year + '-' + pad(month + 1) + '-' + pad(day) + ' ' + pad(hh) + ':' + pad(mm) + ':' + pad(ss);
}

// Attach a flatpickr calendar+time picker to a text input. flatpickr only knows local
// time, so it is handed the UTC wall-clock as if it were local, both ways: the field then
// shows UTC and accepts whatever parseDateInput reads. onPick(): called when the calendar
// closes on a new value. flatpickr is a CDN global; if it failed to load, the field stays
// a plain text input (still parsed by parseDateInput), so this degrades gracefully.
export function attachDatePicker(el, onPick = () => {}) {
  if (!el || typeof window === 'undefined' || !window.flatpickr) return null;
  let opened = '';
  return window.flatpickr(el, {
    enableTime: true,
    time_24hr: true,
    allowInput: true,
    enableSeconds: true,
    minuteIncrement: 1,
    parseDate: (text) => {
      const d = parseDateInput(text);
      return d && new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
    },
    formatDate: (d) => wallClockText(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()),
    onOpen: () => { opened = el.value; },
    onClose: () => { if (el.value !== opened) onPick(); },
    // Phones would otherwise get a native local-time picker, not these UTC fields.
    disableMobile: true,
  });
}

// A time from the inventory, a config or a link, as a Date. They carry no zone
// ('1997-08-25 17:48:00', '2024-01-01T00:00:00') and JS would read those as local time;
// here a zone-less date-time is UTC. Explicit zones, bare dates and epoch ms pass through.
const ZONELESS_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
export function parseUtc(value) {
  const s = typeof value === 'string' ? value.trim() : value;
  return new Date(ZONELESS_DATETIME.test(s) ? s.replace(' ', 'T') + 'Z' : s);
}

// Set a date field, keeping the flatpickr calendar in sync when present (it reads the
// text through attachDatePicker's parseDate, as UTC wall-clock).
export function setDateInput(el, date) {
  if (!el) return;
  if (el._flatpickr) el._flatpickr.setDate(formatDateInput(date), false);
  else el.value = formatDateInput(date);
}

// Parse a UTC time typed or pasted into a date field: year-first ISO 8601
// ("2024-05-10 12:00", "2024-05-10T12:00:00.5Z") or day-first "DD-MM-YYYY HH:MM[:SS]"
// (separators -, / or .). Time is optional. Returns a Date, or null if malformed or
// out of range.
const YEAR_FIRST = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?Z?)?$/;
const DAY_FIRST = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

export function parseDateInput(str) {
  const text = String(str).trim();
  const iso = text.match(YEAR_FIRST);
  const dmy = !iso && text.match(DAY_FIRST);
  if (!iso && !dmy) return null;
  const [year, month, day] = iso ? [iso[1], iso[2], iso[3]] : [dmy[3], dmy[2], dmy[1]];
  const [hh, mm, ss] = (iso || dmy).slice(4, 7);
  return utcDate(Number(year), Number(month), Number(day), Number(hh || 0), Number(mm || 0),
    Number(ss || 0), iso?.[7] ? Math.round(Number(iso[7]) * 1000) : 0);
}

// Rejects overflow (e.g. 30 February rolling over into March) and out-of-range times.
function utcDate(year, month, day, hh, mm, ss, ms) {
  const date = new Date(Date.UTC(year, month - 1, day, hh, mm, ss, ms));
  const valid = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day && hh <= 23 && mm <= 59 && ss <= 59;
  return valid ? date : null;
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

export function fallbackCopy(inputEl, btn, label = 'Copy URL') {
    inputEl.select();
    try {
        document.execCommand('copy');
        btn.textContent = 'Copied!';
    } catch (_) {
        btn.textContent = 'Select & copy manually';
    }
    setTimeout(() => { btn.textContent = label; }, 2000);
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
