// Shared UI helpers + time formatting for the viewer pages.
// Plain ES module: imported by page modules and by Vitest.

export function toLocalISOString(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
  );
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
