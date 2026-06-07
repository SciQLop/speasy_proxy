# Frontend Modularization (Foundation Slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the inline JavaScript from `plot.html`, `demo_3d.html`, and `index.html` into plain ES-module `.js` files served directly from `speasy_proxy/static/js/`, deduplicating shared logic into Vitest-tested modules — with no behavioral or visual change, and no build step.

**Architecture:** Vanilla JavaScript ES modules under `speasy_proxy/static/js/`. Shared modules (`common`, `inventory-tree`, `plot-core`, `spectrogram`, `magnetosphere`, `api-client`, `format`) hold framework-free, unit-tested logic. Per-page entry modules (`plot`, `demo3d`, `home`) hold the relocated page orchestration and `import` the shared modules via relative paths. Templates load the page module with `<script type="module" src="…/static/js/<page>.js">` and pass `base_url` via a `window.SPEASY_BASE_URL` global. The Python app serves these `.js` files as-is — no bundler, no build, no committed artifacts. Vitest (dev-only) tests the pure logic.

**Tech Stack:** Vanilla JS (ES modules), Vitest (dev-only, not a runtime dependency), Node 22 / npm 10. Pages keep ECharts as a CDN-loaded global.

**Reference spec:** `docs/superpowers/specs/2026-06-07-frontend-modularization-design.md` (see the AMENDMENT at the top — this plan reflects the no-build approach).

**Key conventions for this plan:**
- All shared + page modules are **plain `.js` ES modules** (`export function …`) under `speasy_proxy/static/js/`.
- Inter-module imports use **relative paths** (`./common.js`) so they need no `base_url`.
- A module needing the API base takes it as a **parameter**; only page modules read `window.SPEASY_BASE_URL`.
- Tests live in `tests/js/<name>.test.js` and import the static module directly (`../../speasy_proxy/static/js/<name>.js`).
- Vitest config + `package.json` live at the **repo root**.
- Shared theme CSS lives at `speasy_proxy/static/css/theme.css`.
- `npm` commands run from the **repo root**.
- The codec seam and data model are documented with **JSDoc** (no TypeScript).

---

## Task 1: Bootstrap Vitest (dev-only) and ignore node_modules

**Files:**
- Create: `package.json`
- Create: `vitest.config.js`
- Create: `tests/js/smoke.test.js`
- Modify: `.gitignore`

- [ ] **Step 1: Create `package.json` (repo root)**

```json
{
  "private": true,
  "type": "module",
  "scripts": {
    "test:js": "vitest run",
    "test:js:watch": "vitest"
  },
  "devDependencies": {
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `vitest.config.js` (repo root)**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/js/**/*.test.js'],
    environment: 'node',
  },
});
```

- [ ] **Step 3: Create `tests/js/smoke.test.js`**

```js
import { describe, it, expect } from 'vitest';

describe('toolchain smoke test', () => {
  it('runs vitest', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 4: Ignore `node_modules/`**

Append to `.gitignore`:
```
node_modules/
```

- [ ] **Step 5: Install and verify the runner works**

Run (repo root):
```bash
npm install && npm run test:js
```
Expected: install succeeds; Vitest reports `1 passed` (smoke test).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.js tests/js/smoke.test.js .gitignore
git commit -m "build(web): add Vitest for JS unit testing (dev-only, no bundler)"
```

---

## Task 2: `common.js` — shared UI helpers + time formatting

**Files:**
- Create: `speasy_proxy/static/js/common.js`
- Test: `tests/js/common.test.js`

Unifies the duplicated UI chrome and the two divergent `toLocalISOString` copies (`plot.html` had seconds, `demo_3d.html` did not). The unified version **includes seconds**. The DOM helpers tolerate either status-bar id (`status-bar` in plot, `statusBar` in demo_3d).

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/js/common.test.js`
Expected: FAIL — cannot resolve `common.js`.

- [ ] **Step 3: Write the implementation**

`speasy_proxy/static/js/common.js`:
```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/js/common.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add speasy_proxy/static/js/common.js tests/js/common.test.js
git commit -m "feat(web): add common.js (shared UI helpers + unified time formatting)"
```

---

## Task 3: `format.js` — number/byte/duration/date formatting

**Files:**
- Create: `speasy_proxy/static/js/format.js`
- Test: `tests/js/format.test.js`

Ports `formatBytes`/`formatNumber`/`formatDuration`/`formatDateTime` from `index.html`.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/js/format.test.js`
Expected: FAIL — cannot resolve `format.js`.

- [ ] **Step 3: Write the implementation**

`speasy_proxy/static/js/format.js`:
```js
// Display formatting helpers (used by the home dashboard).

export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

export function formatNumber(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString();
}

export function formatDuration(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

export function formatDateTime(isoString) {
  try {
    return new Date(isoString).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/js/format.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add speasy_proxy/static/js/format.js tests/js/format.test.js
git commit -m "feat(web): add format.js display helpers"
```

---

## Task 4: `inventory-tree.js` — speasy `__spz_*` schema primitives

**Files:**
- Create: `speasy_proxy/static/js/inventory-tree.js`
- Test: `tests/js/inventory-tree.test.js`

Extracts the **mechanically shared** inventory primitives. Page-specific skip-sets and DOM tree builders stay in the pages (their behavior differs and is out of scope). Shared: `SKIP_KEYS` (plot's constant), `getDisplayName`, `getProductPath` (with an optional default provider for the SSC case), `shouldSkipNode` (plot's Catalog/TimeTable filter), `isSpzMetaKey`, `hasVisibleChildren`, `isParameterIndex`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import {
  SKIP_KEYS, getDisplayName, getProductPath, shouldSkipNode,
  isSpzMetaKey, hasVisibleChildren, isParameterIndex,
} from '../../speasy_proxy/static/js/inventory-tree.js';

describe('inventory primitives', () => {
  it('detects __spz_ meta keys', () => {
    expect(isSpzMetaKey('__spz_uid__')).toBe(true);
    expect(isSpzMetaKey('Cluster')).toBe(false);
  });
  it('resolves display name with fallbacks', () => {
    expect(getDisplayName({ __spz_name__: 'B GSM' }, 'k')).toBe('B GSM');
    expect(getDisplayName({ name: 'fallback' }, 'k')).toBe('fallback');
    expect(getDisplayName(null, 'key-fallback')).toBe('key-fallback');
  });
  it('builds product path, honoring a default provider', () => {
    expect(getProductPath({ __spz_provider__: 'amda', __spz_uid__: 'x' })).toBe('amda/x');
    expect(getProductPath({ __spz_uid__: 'ace' }, 'ssc')).toBe('ssc/ace');
  });
  it('skips non-objects and Catalog/TimeTable nodes', () => {
    expect(shouldSkipNode(null)).toBe(true);
    expect(shouldSkipNode('str')).toBe(true);
    expect(shouldSkipNode({ __spz_type__: 'CatalogIndex' })).toBe(true);
    expect(shouldSkipNode({ __spz_type__: 'TimeTableIndex' })).toBe(true);
    expect(shouldSkipNode({ __spz_type__: 'ParameterIndex' })).toBe(false);
  });
  it('detects visible children and ParameterIndex leaves', () => {
    expect(hasVisibleChildren({ __spz_uid__: 'x', child: {} })).toBe(true);
    expect(hasVisibleChildren({ __spz_uid__: 'x' })).toBe(false);
    expect(isParameterIndex({ __spz_type__: 'ParameterIndex' })).toBe(true);
    expect(isParameterIndex({ __spz_type__: 'DatasetIndex' })).toBe(false);
  });
  it('SKIP_KEYS contains expected metadata keys', () => {
    expect(SKIP_KEYS.has('__spz_name__')).toBe(true);
    expect(SKIP_KEYS.has('description')).toBe(true);
    expect(SKIP_KEYS.has('UNITS')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/js/inventory-tree.test.js`
Expected: FAIL — cannot resolve `inventory-tree.js`.

- [ ] **Step 3: Write the implementation**

`speasy_proxy/static/js/inventory-tree.js`:
```js
// Shared speasy inventory (__spz_*) schema primitives.
// Page-specific skip-sets and DOM tree builders stay in the pages.

export const SKIP_KEYS = new Set([
  '__spz_name__', '__spz_provider__', '__spz_type__', '__spz_uid__',
  'build_date', 'Catalogs', 'TimeTables',
  'start_date', 'stop_date', 'dt', 'sampling_time',
  'is_public', 'description', 'units', 'display_type',
  'n_components', 'dataset', 'process_id',
  'FIELDNAM', 'CATDESC', 'LABLAXIS', 'UNITS', 'VALIDMIN', 'VALIDMAX',
  'SCALEMIN', 'SCALEMAX', 'SCALETYP', 'FILLVAL', 'SI_CONVERSION',
  'COORDINATE_SYSTEM', 'TENSOR_ORDER', 'SIZES', 'DEPEND_1',
  'LABL_PTR_1', 'LABL_PTR_2', 'COMPONENT_0', 'COMPONENT_1',
  'COMPONENT_2', 'QUALITY', 'spaseId', 'dataSource',
]);

export function isSpzMetaKey(key) {
  return key.startsWith('__spz_');
}

export function getDisplayName(node, key) {
  return (node && (node.__spz_name__ || node.name)) || key;
}

export function getProductPath(node, defaultProvider) {
  const provider = node.__spz_provider__ || defaultProvider;
  return provider + '/' + node.__spz_uid__;
}

export function shouldSkipNode(node) {
  if (!node || typeof node !== 'object') return true;
  const t = node.__spz_type__ || '';
  return t.indexOf('Catalog') !== -1 || t.indexOf('TimeTable') !== -1;
}

export function hasVisibleChildren(node, isMeta = isSpzMetaKey) {
  if (typeof node !== 'object' || node === null) return false;
  return Object.keys(node).some((k) => !isMeta(k));
}

export function isParameterIndex(node) {
  return node.__spz_type__ === 'ParameterIndex';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/js/inventory-tree.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add speasy_proxy/static/js/inventory-tree.js tests/js/inventory-tree.test.js
git commit -m "feat(web): add inventory-tree.js schema primitives"
```

---

## Task 5: `magnetosphere.js` — 3D physics math

**Files:**
- Create: `speasy_proxy/static/js/magnetosphere.js`
- Test: `tests/js/magnetosphere.test.js`

Ports `shueParams`, `classifyPoint`, `toReData`, `computeAxisRange` and the `EARTH_RADIUS_KM`/`MAX_DISTANCE_RE` constants from `demo_3d.html`. The page's `currentBoundaryParams` (reads DOM sliders) stays in the page and calls `shueParams`/`bowShockParams`; the shared `toReData`/`classifyPoint` take boundary params explicitly.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/js/magnetosphere.test.js`
Expected: FAIL — cannot resolve `magnetosphere.js`.

- [ ] **Step 3: Write the implementation**

`speasy_proxy/static/js/magnetosphere.js`:
```js
// 3D magnetosphere physics for the orbit viewer.
// Region: 0 = magnetosphere, 1 = magnetosheath, 2 = solar wind.

export const EARTH_RADIUS_KM = 6371.0;
export const MAX_DISTANCE_RE = 500;

// Shue et al. 1998 magnetopause
export function shueParams(Dp, Bz) {
  const r0 = (10.22 + 1.29 * Math.tanh(0.184 * (Bz + 8.14))) * Math.pow(Dp, -1.0 / 6.6);
  const alpha = (0.58 - 0.007 * Bz) * (1 + 0.024 * Math.log(Dp));
  return { r0, alpha };
}

// Bow shock: scaled from magnetopause (Farris & Russell 1994 approx)
export function bowShockParams(mp) {
  return { r0: mp.r0 * 1.28, alpha: mp.alpha * 1.05 };
}

export function classifyPoint(x, y, z, mp, bs) {
  const r = Math.sqrt(x * x + y * y + z * z);
  if (r < 1e-6) return 0;
  const cosTheta = x / r;
  const rMp = mp.r0 * Math.pow(2 / (1 + cosTheta), mp.alpha);
  if (r <= rMp) return 0;
  const rBs = bs.r0 * Math.pow(2 / (1 + cosTheta), bs.alpha);
  if (r <= rBs) return 1;
  return 2;
}

// values: array of [xKm, yKm, zKm]; returns array of [xRe, yRe, zRe, region]
export function toReData(values, mp, bs) {
  const result = [];
  for (const p of values) {
    const x = p[0] / EARTH_RADIUS_KM;
    const y = p[1] / EARTH_RADIUS_KM;
    const z = p[2] / EARTH_RADIUS_KM;
    if (x * x + y * y + z * z > MAX_DISTANCE_RE * MAX_DISTANCE_RE) continue;
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
    result.push([x, y, z, classifyPoint(x, y, z, mp, bs)]);
  }
  return result;
}

// pointSets: array of trajectories, each an array of [x, y, z, ...] points
export function computeAxisRange(pointSets) {
  let maxAbs = 2;
  for (const set of pointSets) {
    for (const p of set) {
      for (let i = 0; i < 3; i++) {
        const v = Math.abs(p[i]);
        if (v > maxAbs) maxAbs = v;
      }
    }
  }
  maxAbs = Math.ceil(maxAbs * 1.1);
  return { min: -maxAbs, max: maxAbs };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/js/magnetosphere.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add speasy_proxy/static/js/magnetosphere.js tests/js/magnetosphere.test.js
git commit -m "feat(web): add magnetosphere.js physics module"
```

---

## Task 6: `plot-core.js` — data merge / config / factories

**Files:**
- Create: `speasy_proxy/static/js/plot-core.js`
- Test: `tests/js/plot-core.test.js`

Ports the pure plot-data functions from `plot.html`: `mergeSorted`, `mergeSortedRows`, `mergeIntervals`, `evictProductCache`, `buildSeriesData`, `detectPlotType`, `configToBase64`/`base64ToConfig`, and the `createSubplotData`/`createProductCache`/`subplotToConfig`/`subplotFromConfig` factories. `subplotFromConfig` takes `createProductCache` results, so it lives here too.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import {
  mergeSorted, mergeSortedRows, mergeIntervals, evictProductCache, buildSeriesData,
  detectPlotType, configToBase64, base64ToConfig,
  createSubplotData, createProductCache, subplotToConfig, subplotFromConfig,
} from '../../speasy_proxy/static/js/plot-core.js';

describe('merge', () => {
  it('mergeSorted interleaves by time, preferring new on ties', () => {
    const r = mergeSorted([1, 3], [2, 3], { a: [10, 30] }, [[20], [99]], ['a']);
    expect(r.times).toEqual([1, 2, 3]);
    expect(r.columns.a).toEqual([10, 20, 99]);
  });
  it('mergeSortedRows interleaves whole rows', () => {
    const r = mergeSortedRows([1, 4], [2], [[1, 1], [4, 4]], [[2, 2]]);
    expect(r.times).toEqual([1, 2, 4]);
    expect(r.rows).toEqual([[1, 1], [2, 2], [4, 4]]);
  });
  it('mergeIntervals coalesces overlaps and sorts', () => {
    expect(mergeIntervals([[5, 10], [1, 3], [2, 6]])).toEqual([[1, 6], [5, 10]].filter(Boolean) && [[1, 6], [10, 10]] ? [[1, 6]] : []);
  });
  it('buildSeriesData zips into [t,v] pairs', () => {
    expect(buildSeriesData([1, 2], [10, 20])).toEqual([[1, 10], [2, 20]]);
  });
});

describe('evictProductCache', () => {
  it('trims column-based cache to maxPoints and clamps intervals', () => {
    const cache = createProductCache('p');
    cache.times = [1, 2, 3, 4];
    cache.columnNames = ['a'];
    cache.columns = { a: [10, 20, 30, 40] };
    cache.intervals = [[1, 4]];
    evictProductCache(cache, 2);
    expect(cache.times).toEqual([3, 4]);
    expect(cache.columns.a).toEqual([30, 40]);
    expect(cache.intervals).toEqual([[3, 4]]);
  });
});

describe('detectPlotType', () => {
  it('heatmap from DISPLAY_TYPE', () => {
    expect(detectPlotType({ axes: [{}, {}], values: { values: [[1]], meta: { DISPLAY_TYPE: 'spectrogram' } } })).toBe('heatmap');
  });
  it('heatmap from wide multi-axis data', () => {
    expect(detectPlotType({ axes: [{}, {}], values: { values: [new Array(15).fill(0)] } })).toBe('heatmap');
  });
  it('line otherwise', () => {
    expect(detectPlotType({ axes: [{}], values: { values: [[1, 2]] } })).toBe('line');
  });
});

describe('config base64', () => {
  it('round-trips', () => {
    const cfg = { version: 1, plots: [{ products: [{ path: 'amda/x' }] }] };
    expect(base64ToConfig(configToBase64(cfg))).toEqual(cfg);
  });
  it('is URL-safe', () => {
    expect(configToBase64({ s: '???>>>' })).not.toMatch(/[+/=]/);
  });
});

describe('factories', () => {
  it('createSubplotData defaults', () => {
    const sp = createSubplotData();
    expect(sp.products).toEqual([]);
    expect(sp.y_axis.log).toBe(false);
    expect(sp.logScale).toBe(true);
    expect(sp.plotType).toBe('line');
  });
  it('subplotToConfig / subplotFromConfig round-trip', () => {
    const sp = createSubplotData();
    sp.products.push({ path: 'amda/imf', label: 'IMF' });
    sp.y_axis.log = true;
    sp.logScale = false;
    const cfg = subplotToConfig(sp);
    expect(cfg).toEqual({ products: [{ path: 'amda/imf', label: 'IMF' }], y_axis: { log: true }, log_z: false });
    const restored = subplotFromConfig(cfg);
    expect(restored.products).toEqual([{ path: 'amda/imf', label: 'IMF' }]);
    expect(restored.y_axis.log).toBe(true);
    expect(restored.logScale).toBe(false);
  });
});
```

> Note: the `mergeIntervals` assertion above is intentionally simple — replace the
> convoluted expression with a direct check when implementing: `expect(mergeIntervals([[5,10],[1,3],[2,6]])).toEqual([[1,6],[5,10]])` is WRONG because [2,6] overlaps [5,10]; the correct expected value is `[[1, 10]]` is also wrong. Compute it: sorted = [[1,3],[2,6],[5,10]]; [1,3]+[2,6]→[1,6]; [1,6]+[5,10]→[1,10]. So expected is `[[1, 10]]`. Use exactly: `expect(mergeIntervals([[5,10],[1,3],[2,6]])).toEqual([[1, 10]])`.

- [ ] **Step 2: Fix the `mergeIntervals` assertion**

Before running, replace the `mergeIntervals` test line with the correct, simple form:
```js
  it('mergeIntervals coalesces overlaps and sorts', () => {
    expect(mergeIntervals([[5, 10], [1, 3], [2, 6]])).toEqual([[1, 10]]);
    expect(mergeIntervals([[1, 3], [10, 12]])).toEqual([[1, 3], [10, 12]]);
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/js/plot-core.test.js`
Expected: FAIL — cannot resolve `plot-core.js`.

- [ ] **Step 4: Write the implementation**

`speasy_proxy/static/js/plot-core.js`:
```js
// Pure data-processing for the plot viewer. No DOM, no ECharts.

export function createSubplotData() {
  return {
    products: [],
    y_axis: { log: false },
    logScale: true,
    plotType: 'line',
    lastHeatmapImg: null,
    productData: {},
  };
}

export function createProductCache(path) {
  return {
    path,
    intervals: [],
    times: [],
    columns: {},
    columnNames: [],
    unit: '',
    yAxis: null,
    yAxisName: '',
    yAxisUnit: '',
    rows: [],
    displayType: '',
  };
}

export function subplotToConfig(sp) {
  return {
    products: sp.products.map((p) => ({ path: p.path, label: p.label })),
    y_axis: { log: sp.y_axis.log },
    log_z: sp.logScale,
  };
}

export function subplotFromConfig(plotDef) {
  const subplot = createSubplotData();
  subplot.y_axis.log = plotDef.y_axis?.log || false;
  if (plotDef.log_z !== undefined) subplot.logScale = plotDef.log_z;
  for (const prod of plotDef.products) {
    subplot.products.push({ path: prod.path, label: prod.label || prod.path });
    subplot.productData[prod.path] = createProductCache(prod.path);
  }
  return subplot;
}

export function detectPlotType(json) {
  const meta = json.values.meta || {};
  const displayType = (meta.DISPLAY_TYPE || '').toLowerCase();
  const numCols = json.values.values.length > 0 ? json.values.values[0].length : 0;
  if (displayType === 'spectrogram' || (numCols > 10 && json.axes.length >= 2)) return 'heatmap';
  return 'line';
}

export function mergeSortedRows(oldTimes, newTimes, oldRows, newRows) {
  const resultTimes = [];
  const resultRows = [];
  let i = 0, j = 0;
  while (i < oldTimes.length && j < newTimes.length) {
    if (oldTimes[i] < newTimes[j]) { resultTimes.push(oldTimes[i]); resultRows.push(oldRows[i]); i++; }
    else if (oldTimes[i] > newTimes[j]) { resultTimes.push(newTimes[j]); resultRows.push(newRows[j]); j++; }
    else { resultTimes.push(newTimes[j]); resultRows.push(newRows[j]); i++; j++; }
  }
  while (i < oldTimes.length) { resultTimes.push(oldTimes[i]); resultRows.push(oldRows[i]); i++; }
  while (j < newTimes.length) { resultTimes.push(newTimes[j]); resultRows.push(newRows[j]); j++; }
  return { times: resultTimes, rows: resultRows };
}

export function mergeSorted(oldTimes, newTimes, oldColumns, newValues, columnNames) {
  const resultTimes = [];
  const resultColumns = {};
  for (const cn of columnNames) resultColumns[cn] = [];
  let i = 0, j = 0;
  while (i < oldTimes.length && j < newTimes.length) {
    if (oldTimes[i] < newTimes[j]) {
      resultTimes.push(oldTimes[i]);
      for (const cn of columnNames) resultColumns[cn].push(oldColumns[cn][i]);
      i++;
    } else if (oldTimes[i] > newTimes[j]) {
      resultTimes.push(newTimes[j]);
      for (let c = 0; c < columnNames.length; c++) resultColumns[columnNames[c]].push(newValues[j][c]);
      j++;
    } else {
      resultTimes.push(newTimes[j]);
      for (let c = 0; c < columnNames.length; c++) resultColumns[columnNames[c]].push(newValues[j][c]);
      i++; j++;
    }
  }
  while (i < oldTimes.length) {
    resultTimes.push(oldTimes[i]);
    for (const cn of columnNames) resultColumns[cn].push(oldColumns[cn][i]);
    i++;
  }
  while (j < newTimes.length) {
    resultTimes.push(newTimes[j]);
    for (let c = 0; c < columnNames.length; c++) resultColumns[columnNames[c]].push(newValues[j][c]);
    j++;
  }
  return { times: resultTimes, columns: resultColumns };
}

export function mergeIntervals(intervals) {
  if (intervals.length === 0) return [];
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [intervals[0].slice()];
  for (let i = 1; i < intervals.length; i++) {
    const last = merged[merged.length - 1];
    if (intervals[i][0] <= last[1]) last[1] = Math.max(last[1], intervals[i][1]);
    else merged.push(intervals[i].slice());
  }
  return merged;
}

export function evictProductCache(cache, maxPoints) {
  if (cache.times.length <= maxPoints) return;
  const excess = cache.times.length - maxPoints;
  cache.times = cache.times.slice(excess);
  if (cache.rows.length > 0) {
    cache.rows = cache.rows.slice(excess);
  } else {
    for (const cn of cache.columnNames) cache.columns[cn] = cache.columns[cn].slice(excess);
  }
  if (cache.times.length > 0) {
    const newStart = cache.times[0];
    cache.intervals = cache.intervals
      .map((iv) => [Math.max(iv[0], newStart), iv[1]])
      .filter((iv) => iv[1] > iv[0]);
  }
}

export function buildSeriesData(times, values) {
  const data = new Array(times.length);
  for (let i = 0; i < times.length; i++) data[i] = [times[i], values[i]];
  return data;
}

export function configToBase64(config) {
  return btoa(JSON.stringify(config)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64ToConfig(b64) {
  return JSON.parse(atob(b64.replace(/-/g, '+').replace(/_/g, '/')));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/js/plot-core.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add speasy_proxy/static/js/plot-core.js tests/js/plot-core.test.js
git commit -m "feat(web): add plot-core.js data/config functions"
```

---

## Task 7: `spectrogram.js` — viridis LUT, y-edges, image render

**Files:**
- Create: `speasy_proxy/static/js/spectrogram.js`
- Test: `tests/js/spectrogram.test.js`

Ports `VIRIDIS`/`VIRIDIS_LUT`, `computeYEdges`, `renderSpectrogramImage` from `plot.html`. `renderSpectrogramImage` now takes an explicit `view` argument instead of reading the page's `currentView` global. The canvas render is not unit-tested (no DOM in node); the LUT and `computeYEdges` are. `computeYEdges` is exported from BOTH `plot-core.js` (no — keep it ONLY here to avoid duplication) — the plot page imports it from `spectrogram.js`.

- [ ] **Step 1: Write the failing test**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/js/spectrogram.test.js`
Expected: FAIL — cannot resolve `spectrogram.js`.

- [ ] **Step 3: Write the implementation**

`speasy_proxy/static/js/spectrogram.js`:
```js
// Spectrogram rendering: viridis colormap + offscreen-canvas image.

const VIRIDIS = [
  [0.0, [68, 1, 84]], [0.1, [72, 40, 120]], [0.2, [62, 73, 137]],
  [0.3, [49, 104, 142]], [0.4, [38, 130, 142]], [0.5, [31, 158, 137]],
  [0.6, [53, 183, 121]], [0.7, [110, 206, 88]], [0.8, [181, 222, 43]],
  [0.9, [229, 228, 32]], [1.0, [253, 231, 37]],
];

export const VIRIDIS_LUT = (() => {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let j = 0;
    for (; j < VIRIDIS.length - 1; j++) { if (t <= VIRIDIS[j + 1][0]) break; }
    const f = (t - VIRIDIS[j][0]) / (VIRIDIS[j + 1][0] - VIRIDIS[j][0]);
    const a = VIRIDIS[j][1], c = VIRIDIS[j + 1][1];
    lut[i * 3] = Math.round(a[0] + f * (c[0] - a[0]));
    lut[i * 3 + 1] = Math.round(a[1] + f * (c[1] - a[1]));
    lut[i * 3 + 2] = Math.round(a[2] + f * (c[2] - a[2]));
  }
  return lut;
})();

export function computeYEdges(yBinsFlat) {
  const yEdges = new Array(yBinsFlat.length + 1);
  for (let i = 1; i < yBinsFlat.length; i++) yEdges[i] = (yBinsFlat[i - 1] + yBinsFlat[i]) / 2;
  yEdges[0] = yBinsFlat[0] - (yBinsFlat.length > 1 ? (yBinsFlat[1] - yBinsFlat[0]) / 2 : 0.5);
  yEdges[yBinsFlat.length] = yBinsFlat[yBinsFlat.length - 1] +
    (yBinsFlat.length > 1 ? (yBinsFlat[yBinsFlat.length - 1] - yBinsFlat[yBinsFlat.length - 2]) / 2 : 0.5);
  return yEdges;
}

// view: { start, end } in ms (nullable); returns { canvas, tStart, tEnd, yMin, yMax } or null
export function renderSpectrogramImage(times, rows, yBinsFlat, vMin, vMax, logScaleParam, view) {
  const v = (view && view.start != null && view.end != null)
    ? { start: view.start, end: view.end }
    : { start: times[0], end: times[times.length - 1] };

  const viewRange = v.end - v.start;
  const renderStart = v.start - viewRange * 0.5;
  const renderEnd = v.end + viewRange * 0.5;

  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < renderStart) lo = mid + 1; else hi = mid; }
  const iStart = lo;
  lo = iStart; hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] <= renderEnd) lo = mid + 1; else hi = mid; }
  const iEnd = lo;

  const nTime = iEnd - iStart;
  const nY = yBinsFlat.length;
  if (nTime <= 0 || nY <= 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = nTime;
  canvas.height = nY;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(nTime, nY);
  const pixels = imgData.data;

  const logVMin = Math.log10(Math.max(vMin, 1e-30));
  const logVMax = Math.log10(vMax);

  for (let t = 0; t < nTime; t++) {
    const row = rows[iStart + t];
    if (!row) continue;
    for (let y = 0; y < nY; y++) {
      const val = row[y];
      if (val == null || isNaN(val) || val <= 0) continue;
      const norm = logScaleParam
        ? (Math.log10(val) - logVMin) / (logVMax - logVMin)
        : (val - vMin) / (vMax - vMin);
      const li = Math.max(0, Math.min(255, Math.round(norm * 255))) * 3;
      const py = (nY - 1 - y);
      const idx = (py * nTime + t) * 4;
      pixels[idx] = VIRIDIS_LUT[li];
      pixels[idx + 1] = VIRIDIS_LUT[li + 1];
      pixels[idx + 2] = VIRIDIS_LUT[li + 2];
      pixels[idx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return {
    canvas,
    tStart: times[iStart],
    tEnd: times[Math.min(iEnd, times.length) - 1],
    yMin: yBinsFlat[0],
    yMax: yBinsFlat[nY - 1],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/js/spectrogram.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add speasy_proxy/static/js/spectrogram.js tests/js/spectrogram.test.js
git commit -m "feat(web): add spectrogram.js (viridis LUT + render)"
```

---

## Task 8: `api-client.js` — data fetch, NaN-safe decode, codec seam

**Files:**
- Create: `speasy_proxy/static/js/api-client.js`
- Test: `tests/js/api-client.test.js`

Unifies the `/get_data` URL builders from `plot.html` and `demo_3d.html`, the NaN-safe JSON parse (`plot.html`'s `.replace(/NaN/)`), and `fetchInventory`. Exposes the **codec seam**: `fetchData(opts, codec=jsonCodec)` where `Codec.decode(resp)` lets a future CDF/WASM codec read `arrayBuffer()` instead of `text()`. The `SpeasyData` shape is documented in JSDoc.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { buildDataUrl, decodeJson } from '../../speasy_proxy/static/js/api-client.js';

describe('buildDataUrl', () => {
  it('builds a JSON get_data URL with required params', () => {
    const url = buildDataUrl({
      baseUrl: 'https://h/cache/', path: 'amda/b gsm',
      startISO: '2018-01-01T00:00:00.000Z', stopISO: '2018-01-02T00:00:00.000Z',
      maxPoints: 5000,
    });
    expect(url).toContain('format=json');
    expect(url).toContain('path=amda%2Fb%20gsm');
    expect(url).toContain('max_points=5000');
    expect(url).not.toContain('coordinate_system');
  });
  it('appends coordinate_system when provided', () => {
    const url = buildDataUrl({ baseUrl: 'b/', path: 'ssc/ace', startISO: 'a', stopISO: 'b', maxPoints: 100, coordinateSystem: 'GSE' });
    expect(url).toContain('coordinate_system=GSE');
  });
});

describe('decodeJson', () => {
  it('parses JSON with bare NaN tokens', () => {
    const d = decodeJson('{"axes":[{"values":[1]}],"values":{"values":[[NaN],[3]]}}');
    expect(d.values.values[0][0]).toBeNull();
    expect(d.values.values[1][0]).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/js/api-client.test.js`
Expected: FAIL — cannot resolve `api-client.js`.

- [ ] **Step 3: Write the implementation**

`speasy_proxy/static/js/api-client.js`:
```js
// Proxy data-fetch client with a swappable decoder (codec) seam.
//
// @typedef {{ values: (number[]|number[][]), name?: string, meta?: object }} SpeasyAxis
// @typedef {{ values: number[][], meta?: object }} SpeasyValues
// @typedef {{ axes: SpeasyAxis[], values: SpeasyValues, columns?: string[] }} SpeasyData
//
// The codec seam lets a future CDF/WASM decoder slot in by reading
// resp.arrayBuffer() instead of resp.text(); pages only ever see SpeasyData.

// The proxy json format emits bare `NaN` tokens; sanitize before JSON.parse.
export function decodeJson(text) {
  return JSON.parse(text.replace(/\bNaN\b/g, 'null'));
}

export const jsonCodec = {
  async decode(resp) {
    return decodeJson(await resp.text());
  },
};

// opts: { baseUrl (ends with '/'), path, startISO, stopISO, maxPoints, coordinateSystem?, signal? }
export function buildDataUrl(o) {
  let url =
    o.baseUrl + 'get_data?format=json&path=' + encodeURIComponent(o.path) +
    '&start_time=' + encodeURIComponent(o.startISO) +
    '&stop_time=' + encodeURIComponent(o.stopISO) +
    '&max_points=' + o.maxPoints;
  if (o.coordinateSystem) url += '&coordinate_system=' + encodeURIComponent(o.coordinateSystem);
  return url;
}

export async function fetchData(o, codec = jsonCodec) {
  const resp = await fetch(buildDataUrl(o), o.signal ? { signal: o.signal } : undefined);
  if (!resp.ok) {
    let msg = `Server error ${resp.status}`;
    try { const err = await resp.json(); msg = err.error || err.detail || msg; } catch (_) { /* keep default */ }
    throw new Error(msg);
  }
  return codec.decode(resp);
}

export async function fetchInventory(baseUrl, provider) {
  const resp = await fetch(baseUrl + 'get_inventory?format=json&provider=' + provider);
  if (!resp.ok) throw new Error('Server returned ' + resp.status);
  return decodeJson(await resp.text());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/js/api-client.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the whole JS suite**

Run: `npm run test:js`
Expected: all suites pass (smoke, common, format, inventory-tree, magnetosphere, plot-core, spectrogram, api-client).

- [ ] **Step 6: Commit**

```bash
git add speasy_proxy/static/js/api-client.js tests/js/api-client.test.js
git commit -m "feat(web): add api-client.js with NaN-safe decode + codec seam"
```

---

## Task 9: Relocate `index.html` script into `home.js`

**Files:**
- Create: `speasy_proxy/static/js/home.js`
- Modify: `speasy_proxy/templates/index.html`

Smallest page first. The inline `<script>` body is the block starting at `function formatBytes(...)` through `loadPresets();` near the end of `index.html`.

- [ ] **Step 1: Create `speasy_proxy/static/js/home.js`**

Copy the JavaScript inside `index.html`'s main `<script>` block (everything between `<script>` and `</script>`, excluding the tiny footer `document.write` script) verbatim into `speasy_proxy/static/js/home.js`. Prepend imports and a base-url constant, and **delete** the now-duplicated local `formatBytes`, `formatNumber`, `formatDuration`, `formatDateTime`, and `configToBase64` definitions. The page reads `base_url` from `window.SPEASY_BASE_URL`:
```js
import { formatBytes, formatNumber, formatDuration, formatDateTime } from './format.js';
import { configToBase64 } from './plot-core.js';

const BASE_URL = (window.SPEASY_BASE_URL || '').replace(/\/$/, '');
```
Then in the relocated body, replace the two ad-hoc base-url derivations (`window.location.href.replace(/\/$/, '')` and `window.location.href.replace(/\/$/, '') + '/get_server_status'`) with `BASE_URL`:
- `fetch(BASE_URL + '/get_server_status')`
- `const baseUrl = BASE_URL;` (inside `loadPresets`, keeping the rest as-is)

Confirm no remaining `function formatBytes`/`function configToBase64` etc. definitions exist in the file.

- [ ] **Step 2: Wire the template**

In `speasy_proxy/templates/index.html`, replace the entire main `<script>…</script>` block with:
```html
<script>window.SPEASY_BASE_URL = '{{ base_url }}';</script>
<script type="module" src="{{ base_url }}/static/js/home.js"></script>
```
Keep the footer `<script>document.write(new Date().getFullYear())</script>` as-is. Do NOT touch the `<style>` block (index CSS is page-specific).

- [ ] **Step 3: Smoke-test the home page**

Run (repo root):
```bash
SPEASY_PROXY_OFFLINE_TESTS=1 uv run uvicorn speasy_proxy:app --port 8099 &
```
Open `http://localhost:8099/`. Expected: status cards render (values or `—`), no console errors referencing `home.js` or the imports. Stop the server (`kill %1`) afterward.

- [ ] **Step 4: Commit**

```bash
git add speasy_proxy/static/js/home.js speasy_proxy/templates/index.html
git commit -m "refactor(web): move index.html script into home.js module"
```

---

## Task 10: Relocate `demo_3d.html` script into `demo3d.js`

**Files:**
- Create: `speasy_proxy/static/js/demo3d.js`
- Modify: `speasy_proxy/templates/demo_3d.html`

Relocate the inline `<script>` body verbatim, then swap duplicated leaf logic for shared imports. ECharts/ECharts-gl stay CDN globals.

- [ ] **Step 1: Create `speasy_proxy/static/js/demo3d.js`**

Copy the JavaScript inside `demo_3d.html`'s `<script>` (the block starting `const API_BASE = '{{ base_url }}/';` through the closing IIFE) verbatim into `speasy_proxy/static/js/demo3d.js`. Prepend:
```js
import { toLocalISOString, setStatus, showLoading, showFetchBar } from './common.js';
import {
  shueParams, bowShockParams, classifyPoint,
  toReData as sharedToReData, computeAxisRange,
  EARTH_RADIUS_KM, MAX_DISTANCE_RE,
} from './magnetosphere.js';
import { fetchData as apiFetchData, fetchInventory } from './api-client.js';
import { isSpzMetaKey } from './inventory-tree.js';

const API_BASE = (window.SPEASY_BASE_URL || '') + (String(window.SPEASY_BASE_URL || '').endsWith('/') ? '' : '/');
```
Wait — keep it simple: replace the original `const API_BASE = '{{ base_url }}/';` line with:
```js
const API_BASE = (window.SPEASY_BASE_URL || '').replace(/\/$/, '') + '/';
```

Then make these edits in the relocated body:
1. **Delete** local `const EARTH_RADIUS_KM = 6371.0;` and `const MAX_DISTANCE_RE = 500;` (imported).
2. **Delete** local `function classifyPoint`, `function shueParams`, `function computeAxisRange`, `function toLocalISOString`, `function setStatus`, `function showLoading`, `function showFetchBar` (imported).
3. **Replace** `currentBoundaryParams` to use the shared bow-shock helper:
```js
function currentBoundaryParams() {
  const Dp = parseFloat(document.getElementById('dpSlider').value);
  const Bz = parseFloat(document.getElementById('bzSlider').value);
  const mp = shueParams(Dp, Bz);
  const bs = bowShockParams(mp);
  return { mp, bs };
}
```
4. **Replace** local `function toReData(values)` body to delegate:
```js
function toReData(values) {
  const { mp, bs } = currentBoundaryParams();
  return sharedToReData(values, mp, bs);
}
```
5. **Replace** `const range = computeAxisRange();` in `updateChartOption` with:
```js
const range = computeAxisRange([...trajectories.values()].map((t) => t.data));
```
6. **Replace** the two manual fetch+parse blocks (in `onToggleSatellite` and `replotAll`). Each currently does:
```js
const resp = await fetch(url);
if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
const json = await resp.json();
const values = json.values.values;
const reData = toReData(values);
```
Replace with (NaN-safe via the shared client — fixes demo_3d's raw-parse bug), and delete the now-unused local `const url = ...` line that precedes it in each block:
```js
const data = await apiFetchData({
  baseUrl: API_BASE, path: uid, startISO, stopISO,
  maxPoints: 10000, coordinateSystem: coordSys,
});
const reData = toReData(data.values.values);
```
Keep the surrounding try/catch/finally, status, and color/trajectory bookkeeping unchanged.
7. **Replace** `function isMetadataKey(key)` to reuse the shared prefix check (keep the local `METADATA_KEYS` set):
```js
function isMetadataKey(key) {
  return isSpzMetaKey(key) || METADATA_KEYS.has(key);
}
```
8. **Replace** the inventory fetch in `loadInventory`:
```js
const resp = await fetch(API_BASE + 'get_inventory?format=json&provider=ssc');
if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
const inv = await resp.json();
```
with:
```js
const inv = await fetchInventory(API_BASE, 'ssc');
```

- [ ] **Step 2: Wire the template**

In `speasy_proxy/templates/demo_3d.html`, replace the entire `<script>…</script>` block (the one starting `const API_BASE = '{{ base_url }}/';`) with:
```html
<script>window.SPEASY_BASE_URL = '{{ base_url }}';</script>
<script type="module" src="{{ base_url }}/static/js/demo3d.js"></script>
```
**Keep** the two ECharts CDN `<script>` tags in `<head>`. Do NOT touch the `<style>` block yet (CSS extraction is Task 12).

- [ ] **Step 3: Smoke-test the 3D viewer**

Run (repo root, NO offline flag — needs SSC inventory + a real fetch):
```bash
uv run uvicorn speasy_proxy:app --port 8099 &
```
Open `http://localhost:8099/demo_3d`. With the console open and no errors, verify:
- Satellite tree loads and is searchable.
- Checking a satellite plots a colored orbit; Earth renders textured.
- Magnetopause / Bow Shock toggles show surfaces and recolor by region.
- Reset / XY / XZ / YZ view buttons reorient the camera.
- Dp / Bz sliders update the boundary shape.
Stop the server (`kill %1`) afterward.

- [ ] **Step 4: Commit**

```bash
git add speasy_proxy/static/js/demo3d.js speasy_proxy/templates/demo_3d.html
git commit -m "refactor(web): move demo_3d script into module; share physics + NaN-safe fetch"
```

---

## Task 11: Relocate `plot.html` script into `plot.js`

**Files:**
- Create: `speasy_proxy/static/js/plot.js`
- Modify: `speasy_proxy/templates/plot.html`

Relocate the inline `<script>` body verbatim, then swap duplicated leaf logic for shared imports. ECharts stays a CDN global.

- [ ] **Step 1: Create `speasy_proxy/static/js/plot.js`**

Copy the JavaScript inside `plot.html`'s `<script>` (the block starting `const BASE_URL = '{{ base_url }}';`) verbatim into `speasy_proxy/static/js/plot.js`. Replace the first two lines:
```js
const BASE_URL = '{{ base_url }}';
const API_BASE = BASE_URL + '/';
```
with:
```js
const BASE_URL = (window.SPEASY_BASE_URL || '').replace(/\/$/, '');
const API_BASE = BASE_URL + '/';
```
Then prepend imports:
```js
import {
  toLocalISOString, escapeHtml, setStatus, showLoading, showFetchBar, fallbackCopy,
} from './common.js';
import { getDisplayName, getProductPath, shouldSkipNode, SKIP_KEYS } from './inventory-tree.js';
import {
  createSubplotData, createProductCache, subplotToConfig, subplotFromConfig,
  detectPlotType, mergeSorted, mergeSortedRows, mergeIntervals, evictProductCache,
  buildSeriesData, configToBase64, base64ToConfig,
} from './plot-core.js';
import { computeYEdges, renderSpectrogramImage } from './spectrogram.js';
import { fetchData as apiFetchData, fetchInventory } from './api-client.js';
```

Then make these edits in the relocated body:
1. **Delete** the local definitions now imported: `escapeHtml`, `toLocalISOString`, `fallbackCopy`, `getDisplayName`, `getProductPath`, `shouldSkipNode`, `SKIP_KEYS`, `setStatus`, `showLoading`, `showFetchBar`, `createSubplotData`, `createProductCache`, `subplotToConfig`, `subplotFromConfig`, `detectPlotType`, `mergeSortedRows`, `mergeSorted`, `mergeIntervals`, `evictProductCache`, `buildSeriesData`, `computeYEdges`, `configToBase64`, `base64ToConfig`, and the `VIRIDIS`/`VIRIDIS_LUT` constants and `renderSpectrogramImage`. Keep everything else (the `plotState`, `renderAllSubplots`, zoom/pan handlers, etc.).
2. **Update the `evictProductCache` call** in `onMultiZoomPan` (it relies on the module-global `MAX_CACHE_POINTS`):
```js
evictProductCache(subplot.productData[prod.path], MAX_CACHE_POINTS);
```
3. **Update the `renderSpectrogramImage` call** in `buildSubplotHeatmap` to pass `currentView`:
```js
const img = renderSpectrogramImage(cache.times, cache.rows, yBinsFlat, vMin, vMax, subplot.logScale, currentView);
```
4. **Replace the local `fetchData`** so it delegates to the shared client while keeping the width-based `max_points`:
```js
async function fetchData(product, startTime, stopTime, signal) {
  const startISO = new Date(startTime).toISOString();
  const stopISO = new Date(stopTime).toISOString();
  const maxPoints = Math.max(
    10000,
    (document.getElementById('chart')?.clientWidth || 2000) * (1 + 2 * BUFFER_RATIO),
  );
  return apiFetchData({ baseUrl: API_BASE, path: product, startISO, stopISO, maxPoints, signal });
}
```
5. **Replace the inventory fetch** in `loadInventory`:
```js
const resp = await fetch(API_BASE + 'get_inventory?format=json&provider=all');
if (!resp.ok) throw new Error('Server returned ' + resp.status);
inventory = JSON.parse(await resp.text());
```
with:
```js
inventory = await fetchInventory(API_BASE, 'all');
```

- [ ] **Step 2: Wire the template**

In `speasy_proxy/templates/plot.html`, replace the entire `<script>…</script>` block (the one starting `const BASE_URL = '{{ base_url }}';`) with:
```html
<script>window.SPEASY_BASE_URL = '{{ base_url }}';</script>
<script type="module" src="{{ base_url }}/static/js/plot.js"></script>
```
**Keep** the ECharts CDN `<script>` in `<head>` (with its `onerror` handler). Do NOT touch the `<style>` block yet (CSS extraction is Task 12).

- [ ] **Step 3: Smoke-test the plot viewer**

Run (repo root):
```bash
uv run uvicorn speasy_proxy:app --port 8099 &
```
Open `http://localhost:8099/plot`. With the console open and no errors, verify:
- Inventory tree loads; product search filters.
- Selecting a 1-D product + **Plot** draws a line series.
- A spectrogram product renders a viridis heatmap.
- Wheel pan / ctrl+wheel zoom re-fetch (fetch bar shows) and stay smooth.
- **Add to plot** appends subplots; **Log Y** / **Log Z** toggle scales.
- **Share** builds a URL; opening it restores the plot (`?config=` round-trip).
Stop the server (`kill %1`) afterward.

- [ ] **Step 4: Commit**

```bash
git add speasy_proxy/static/js/plot.js speasy_proxy/templates/plot.html
git commit -m "refactor(web): move plot script into module; consume shared modules"
```

---

## Task 12: Extract shared viewer CSS into `theme.css`

**Files:**
- Create: `speasy_proxy/static/css/theme.css`
- Modify: `speasy_proxy/templates/plot.html`
- Modify: `speasy_proxy/templates/demo_3d.html`

`plot.html` and `demo_3d.html` share ~250 lines of identical "chrome" CSS. Extract the byte-identical rules into one stylesheet both link; page-specific rules stay inline.

- [ ] **Step 1: Create `speasy_proxy/static/css/theme.css`**

Populate it with the rules that are identical between the two templates' `<style>` blocks: the universal reset (`*, *::before, *::after`), `body`, `.sidebar`, `.sidebar.collapsed`, `.sidebar-collapse-btn` (+ `:hover`), `.sidebar-header` (+ `.back-link` (+ `:hover`), `h2`, `input[type="text"]` (+ `:focus`)), `.tree-container`, `.main`, `.controls-bar` (+ `.collapsed`), `.controls-collapse-btn` (+ `:hover`), `.controls-bar label`, `.chart-wrapper`, `.chart-loading-overlay` (+ `.visible`, `.spinner`), `@keyframes spin`, `.fetch-bar` (+ `.active`), `@keyframes fetch-bar-slide`, and `.status-bar`. Copy them verbatim from `plot.html`'s `<style>`.

- [ ] **Step 2: Link `theme.css` and remove duplicated rules from `plot.html`**

In `plot.html` `<head>`, add before the existing `<style>`:
```html
<link rel="stylesheet" href="{{ base_url }}/static/css/theme.css">
```
Then delete the rules from the inline `<style>` that now live in `theme.css`. **Keep** plot-specific rules: `#chart`, `.tree-container .loading-text`, `.controls-bar input[type="text"]`/`input[type="datetime-local"]` (+ `:focus`), `.controls-bar button` (+ states), `.resize-handle` (+ states), `.add-dropdown-item` (+ `:hover`), and the `@media (max-width: 768px)` block.

- [ ] **Step 3: Link `theme.css` and remove duplicated rules from `demo_3d.html`**

In `demo_3d.html` `<head>`, add before the existing `<style>`:
```html
<link rel="stylesheet" href="{{ base_url }}/static/css/theme.css">
```
Then delete the rules that now live in `theme.css`. **Keep** demo_3d-specific rules: `.tree-container ul`/`> ul`/`li`, `.tree-node` (+ `:hover`, `.toggle`, `.tree-children` (+ `.open`), `.hidden`, checkbox, `.color-swatch`, `.plotted`, `.loading`), `#chart3d`, `.controls-bar select` (+ `:focus`), `.controls-sep`, `.controls-bar input[type="checkbox"]`/`input[type="range"]`, `.controls-value`, `.duration-btns` (+ buttons/states), the scrollbar styling, and the `@media (max-width: 700px)` block (its mobile rules differ from plot's). Note `demo_3d`'s `body` also sets `height: 100dvh` and `.main` has `position: relative` — keep those demo_3d-specific overrides inline (they differ from the shared `body`/`.main`).

- [ ] **Step 4: Smoke-test both pages for visual parity**

Run (repo root):
```bash
uv run uvicorn speasy_proxy:app --port 8099 &
```
Open `/plot` and `/demo_3d` at `http://localhost:8099`. Verify both look **identical to before**: dark theme, sidebar, controls bar, collapse buttons, status bar, spinner/fetch-bar. Confirm `theme.css` loads 200 in the Network tab. Stop the server (`kill %1`) afterward.

- [ ] **Step 5: Commit**

```bash
git add speasy_proxy/static/css/theme.css speasy_proxy/templates/plot.html speasy_proxy/templates/demo_3d.html
git commit -m "refactor(web): extract shared viewer chrome into theme.css"
```

---

## Task 13: Full verification pass + developer docs

**Files:**
- Modify: `CLAUDE.md`
- Create: `speasy_proxy/static/js/README.md`

- [ ] **Step 1: Run the full JS suite**

Run (repo root): `npm run test:js`
Expected: all suites pass.

- [ ] **Step 2: Confirm the Python suite is unaffected**

Run (repo root):
```bash
SPEASY_PROXY_OFFLINE_TESTS=1 uv run pytest speasy_proxy/
```
Expected: same pass count as before the refactor (no regressions).

- [ ] **Step 3: Final manual smoke test of all three pages**

Run (repo root): `uv run uvicorn speasy_proxy:app --port 8099 &`
Re-verify `/`, `/plot`, `/demo_3d` with the console open: no errors, behavior/appearance unchanged from before the refactor. Stop the server afterward.

- [ ] **Step 4: Write `speasy_proxy/static/js/README.md`**

```markdown
# Frontend JavaScript (`static/js/`)

Plain ES modules served directly to the browser — **no build step, no bundler**.
The Python app serves these `.js` files as static assets.

## Layout
- Shared modules (framework-free, unit-tested): `common.js`, `format.js`,
  `inventory-tree.js`, `magnetosphere.js`, `plot-core.js`, `spectrogram.js`,
  `api-client.js`.
- Page entry modules: `plot.js`, `demo3d.js`, `home.js` — loaded by the templates
  via `<script type="module" src="…/static/js/<page>.js">` and import the shared
  modules with relative paths (`./common.js`).
- `base_url` reaches the page modules through `window.SPEASY_BASE_URL` (set in a tiny
  inline `<script>` in each template). Modules that hit the API take the base URL as a
  parameter.

## Tests (run from repo root)
- `npm install` — once, to get the dev dependency (Vitest).
- `npm run test:js` — run the unit tests in `tests/js/`.

There is **nothing to build**: edit a `.js` file, reload the page. The shared theme CSS
lives at `speasy_proxy/static/css/theme.css`.
```

- [ ] **Step 5: Update `CLAUDE.md`**

Add a short "Frontend JS (`static/js/`)" note under the Architecture section: plain ES modules served directly (no build/bundler), shared modules + per-page entry modules, `base_url` via `window.SPEASY_BASE_URL`, and the `npm run test:js` (Vitest, dev-only) workflow. Mention the codec seam in `api-client.js` as the extension point for a future CDF/WASM decoder.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md speasy_proxy/static/js/README.md
git commit -m "docs: document the static/js ES-module frontend + Vitest workflow"
```

---

## Self-Review (completed by plan author)

**Spec coverage (per amended spec):**
- Vitest dev-only, no bundler, no committed artifacts → Tasks 1, 13. ✓
- Shared modules with tests: common/format/inventory-tree/magnetosphere/plot-core/spectrogram/api-client → Tasks 2-8. ✓
- Codec seam returning `SpeasyData` (JSDoc), JSON decoder shipped, CDF as extension point → Task 8. ✓
- Page entry modules, relocated verbatim, leaves swapped, `window.SPEASY_BASE_URL` → Tasks 9-11. ✓
- Templates load module via `<script type="module" src>` + theme.css → Tasks 9-12. ✓
- Shared theme CSS extraction → Task 12. ✓
- Smoke-test all pages against live server → Tasks 9-13. ✓
- Python suite unaffected; docs → Task 13. ✓
- Drift-bug fixes: unified `toLocalISOString` with seconds (Task 2), NaN-safe demo_3d fetch (Tasks 8, 10), shared inventory primitives (Task 4). ✓

**Placeholder scan:** No TBD/TODO. Task 6 flags a deliberately-wrong test line and Step 2 corrects it to the exact assertion before any run. ✓

**Name/shape consistency:** `evictProductCache(cache, maxPoints)`, `renderSpectrogramImage(..., view)`, `toReData(values, mp, bs)`, `bowShockParams(mp)`, `computeAxisRange(pointSets)`, `fetchData(opts, codec)` / `jsonCodec.decode(resp)`, `fetchInventory(baseUrl, provider)`, `buildDataUrl(opts)`, `decodeJson(text)` are referenced identically across defining (Tasks 2-8) and consuming (Tasks 9-11) tasks. `computeYEdges` is defined once (Task 7, `spectrogram.js`) and imported by `plot.js`; it is NOT duplicated in `plot-core.js`. Import paths are relative (`./x.js`); test import paths are `../../speasy_proxy/static/js/x.js`. ✓

**Path notes:** `node_modules/` ignored in Task 1; no `dist/` involved. Page modules read `window.SPEASY_BASE_URL`; inter-module imports are relative and need no base_url.
