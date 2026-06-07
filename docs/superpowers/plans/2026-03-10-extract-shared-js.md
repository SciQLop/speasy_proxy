# Extract Shared JS from HTML Templates — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract shared UI code and testable pure functions from `plot.html` and `demo_3d.html` into standalone JS files served from `static/`, with lightweight tests via vitest — no bundler, no build step for serving.

**Architecture:** Static JS files loaded via `<script src>` tags before each template's inline script. Shared UI helpers (sidebar, controls collapse, status bar) go into `common.js`. Pure data-processing functions from `plot.html` (merge algorithms, interval math, config serialization) go into `plot-core.js`. A minimal vitest setup runs unit tests against the pure functions only — no DOM, no ECharts dependency in tests.

**Tech Stack:** Vanilla JS (ES modules for test files only, plain globals for browser), vitest (dev-only, not a runtime dependency), no bundler.

---

## File Structure

### New files to create

| File | Responsibility |
|------|---------------|
| `speasy_proxy/static/js/common.js` | Shared UI helpers: `setStatus`, `showLoading`, `showFetchBar`, `toLocalISOString`, `escapeHtml`, sidebar collapse, controls collapse |
| `speasy_proxy/static/js/plot-core.js` | Pure functions from plot.html: `mergeSorted`, `mergeSortedRows`, `mergeIntervals`, `detectPlotType`, `computeYEdges`, `buildSeriesData`, config encode/decode, subplot/cache factories |
| `speasy_proxy/static/js/inventory-tree.js` | Shared tree-building helpers: `getDisplayName`, `getProductPath`, `shouldSkipNode`, `SKIP_KEYS` constant |
| `tests/js/plot-core.test.js` | Unit tests for merge algorithms, interval math, config serialization |
| `tests/js/inventory-tree.test.js` | Unit tests for node filtering, path construction |
| `tests/js/common.test.js` | Unit tests for `toLocalISOString`, `escapeHtml` |
| `vitest.config.js` | Minimal vitest config (no DOM, no browser) |
| `package.json` | Dev-only: vitest dependency, `test:js` script |

### Files to modify

| File | Change |
|------|--------|
| `speasy_proxy/templates/plot.html` | Add `<script src>` tags for common.js, inventory-tree.js, plot-core.js; remove extracted functions from inline script |
| `speasy_proxy/templates/demo_3d.html` | Add `<script src>` tags for common.js, inventory-tree.js; remove extracted functions from inline script |
| `.gitignore` | Add `node_modules/` |

---

## Chunk 1: Foundation — vitest setup and pure utility extraction

### Task 1: Bootstrap vitest

**Files:**
- Create: `package.json`
- Create: `vitest.config.js`
- Create: `.gitignore` entry

- [ ] **Step 1: Create package.json with vitest dev dependency**

```json
{
  "private": true,
  "scripts": {
    "test:js": "vitest run",
    "test:js:watch": "vitest"
  },
  "devDependencies": {
    "vitest": "^3"
  }
}
```

- [ ] **Step 2: Create vitest.config.js**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/js/**/*.test.js'],
    environment: 'node'
  }
});
```

- [ ] **Step 3: Add node_modules/ to .gitignore**

Append `node_modules/` to the existing `.gitignore`.

- [ ] **Step 4: Install and verify**

Run: `npm install && npm run test:js`
Expected: vitest runs, finds 0 test files, exits cleanly.

- [ ] **Step 5: Commit**

```bash
git add package.json vitest.config.js .gitignore
git commit -m "chore: add vitest for JS unit testing (dev-only)"
```

---

### Task 2: Extract common.js — pure utility functions

**Files:**
- Create: `speasy_proxy/static/js/common.js`
- Create: `tests/js/common.test.js`

- [ ] **Step 1: Write failing tests for toLocalISOString and escapeHtml**

```js
// tests/js/common.test.js
import { describe, it, expect } from 'vitest';

// We import the functions from the static file.
// Since common.js uses globals (no export), we'll re-export for testing.
// The test helper will be added in step 3.
import { toLocalISOString, escapeHtml } from '../../speasy_proxy/static/js/common.js';

describe('toLocalISOString', () => {
  it('formats a date with zero-padded fields', () => {
    const d = new Date(2025, 0, 5, 3, 7, 9); // Jan 5, 2025 03:07:09
    expect(toLocalISOString(d)).toBe('2025-01-05T03:07:09');
  });

  it('handles end-of-year date', () => {
    const d = new Date(2024, 11, 31, 23, 59, 59);
    expect(toLocalISOString(d)).toBe('2024-12-31T23:59:59');
  });
});

describe('escapeHtml', () => {
  it('escapes angle brackets and ampersand', () => {
    expect(escapeHtml('<b>foo & "bar"</b>')).toBe('&lt;b&gt;foo &amp; &quot;bar&quot;&lt;/b&gt;');
  });

  it('returns empty string for empty input', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('passes through safe strings unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:js`
Expected: FAIL — cannot resolve import.

- [ ] **Step 3: Create common.js with exported pure functions**

```js
// speasy_proxy/static/js/common.js
//
// Shared UI utilities used by plot.html and demo_3d.html.
// In browsers: loaded via <script src>, functions become globals.
// In tests: imported as ES module.

function toLocalISOString(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' +
           pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' +
           pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

function escapeHtml(s) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return s.replace(/[&<>"']/g, c => map[c]);
}

function setStatus(msg) {
    const el = document.getElementById('status-bar') || document.getElementById('statusBar');
    if (el) el.textContent = msg;
}

function showLoading(visible) {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.classList.toggle('visible', visible);
}

function showFetchBar(active) {
    const el = document.getElementById('fetch-bar');
    if (el) el.classList.toggle('active', active);
}

function fallbackCopy(inputEl, btn) {
    inputEl.select();
    try {
        document.execCommand('copy');
        btn.textContent = 'Copied!';
    } catch (_) {
        btn.textContent = 'Select & copy manually';
    }
    setTimeout(() => { btn.textContent = 'Copy URL'; }, 2000);
}

function initSidebarCollapse(sidebarSelector, btnId, handleId) {
    const sidebar = document.querySelector(sidebarSelector);
    const btn = document.getElementById(btnId);
    const handle = handleId ? document.getElementById(handleId) : null;

    function updateBtn() {
        const collapsed = sidebar.classList.contains('collapsed');
        btn.innerHTML = collapsed ? '&#9654;' : '&#9664;';
        btn.style.left = collapsed ? '0' : sidebar.getBoundingClientRect().width + 'px';
        if (handle) handle.style.display = collapsed ? 'none' : '';
    }

    btn.addEventListener('click', () => {
        sidebar.classList.toggle('collapsed');
        updateBtn();
    });

    sidebar.addEventListener('transitionend', () => updateBtn());
    new ResizeObserver(() => updateBtn()).observe(sidebar);
    updateBtn();
}

function initControlsCollapse(barSelector, btnId) {
    const bar = document.querySelector(barSelector);
    const btn = document.getElementById(btnId);
    btn.addEventListener('click', () => {
        bar.classList.toggle('collapsed');
        btn.innerHTML = bar.classList.contains('collapsed') ? '&#9660;' : '&#9650;';
    });
}

// ES module exports for testing (ignored by browsers via <script src>)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { toLocalISOString, escapeHtml };
}
export { toLocalISOString, escapeHtml };
```

Note: The dual export pattern (`export` + `module.exports` guard) won't work cleanly. Instead, use a simpler approach — the vitest config can handle globals. Let's revise:

The file should be a plain script (no `export` statements). For testing, we'll use a thin wrapper:

**Revised `speasy_proxy/static/js/common.js`** — plain functions, no exports. Same code as above but remove the last 4 lines (the export block).

**Create `tests/js/_import-common.js`** — test helper:
```js
// tests/js/_import-common.js
// Re-export pure functions from common.js for vitest.
// We dynamically read the file and eval, since common.js is a plain script.
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(resolve(__dirname, '../../speasy_proxy/static/js/common.js'), 'utf-8');

// Strip any DOM-dependent functions, execute the pure ones
const sandbox = {};
const wrappedCode = `
  const document = { getElementById: () => null, querySelector: () => null };
  const ResizeObserver = class { observe() {} };
  ${code}
  return { toLocalISOString, escapeHtml };
`;
const factory = new Function(wrappedCode);
const exports = factory();

export const toLocalISOString = exports.toLocalISOString;
export const escapeHtml = exports.escapeHtml;
```

Actually, this is getting overcomplicated. Simpler approach — **write the pure functions as ES modules** with proper `export`, and **load them in the browser via `<script type="module">`**. Modern browsers all support this. The DOM helpers remain in the same file since they're simple enough.

**Final approach for all static JS files:** Use ES module syntax (`export function ...`). Load in templates with `<script type="module">`. Import in vitest directly. Clean and simple.

Update the test accordingly:

```js
// tests/js/common.test.js
import { describe, it, expect } from 'vitest';
import { toLocalISOString, escapeHtml } from '../../speasy_proxy/static/js/common.js';

describe('toLocalISOString', () => {
  it('formats a date with zero-padded fields', () => {
    const d = new Date(2025, 0, 5, 3, 7, 9);
    expect(toLocalISOString(d)).toBe('2025-01-05T03:07:09');
  });

  it('handles end-of-year date', () => {
    const d = new Date(2024, 11, 31, 23, 59, 59);
    expect(toLocalISOString(d)).toBe('2024-12-31T23:59:59');
  });
});

describe('escapeHtml', () => {
  it('escapes angle brackets and ampersand', () => {
    expect(escapeHtml('<b>foo & "bar"</b>')).toBe('&lt;b&gt;foo &amp; &quot;bar&quot;&lt;/b&gt;');
  });

  it('returns empty string for empty input', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('passes through safe strings unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});
```

- [ ] **Step 4: Create common.js as ES module**

```js
// speasy_proxy/static/js/common.js
//
// Shared UI utilities for plot.html and demo_3d.html.
// Loaded as <script type="module"> in templates.

export function toLocalISOString(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' +
           pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' +
           pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

export function escapeHtml(s) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return s.replace(/[&<>"']/g, c => map[c]);
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

export function initControlsCollapse(barSelector, btnId, onToggle) {
    const bar = document.querySelector(barSelector);
    const btn = document.getElementById(btnId);
    btn.addEventListener('click', () => {
        bar.classList.toggle('collapsed');
        btn.innerHTML = bar.classList.contains('collapsed') ? '&#9660;' : '&#9650;';
        if (onToggle) onToggle();
    });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:js`
Expected: All 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add speasy_proxy/static/js/common.js tests/js/common.test.js
git commit -m "feat: extract common.js with shared UI utilities and tests"
```

---

### Task 3: Extract inventory-tree.js — node helpers

**Files:**
- Create: `speasy_proxy/static/js/inventory-tree.js`
- Create: `tests/js/inventory-tree.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/js/inventory-tree.test.js
import { describe, it, expect } from 'vitest';
import { getDisplayName, getProductPath, shouldSkipNode, SKIP_KEYS } from '../../speasy_proxy/static/js/inventory-tree.js';

describe('getDisplayName', () => {
  it('returns __spz_name__ when present', () => {
    expect(getDisplayName({ __spz_name__: 'Density' }, 'n_e')).toBe('Density');
  });

  it('falls back to name property', () => {
    expect(getDisplayName({ name: 'Velocity' }, 'v')).toBe('Velocity');
  });

  it('falls back to key when node has no name', () => {
    expect(getDisplayName({}, 'raw_key')).toBe('raw_key');
  });

  it('falls back to key for null node', () => {
    expect(getDisplayName(null, 'fallback')).toBe('fallback');
  });
});

describe('getProductPath', () => {
  it('joins provider and uid', () => {
    const node = { __spz_provider__: 'amda', __spz_uid__: 'imf_mag' };
    expect(getProductPath(node)).toBe('amda/imf_mag');
  });
});

describe('shouldSkipNode', () => {
  it('skips null', () => {
    expect(shouldSkipNode(null)).toBe(true);
  });

  it('skips non-objects', () => {
    expect(shouldSkipNode('string')).toBe(true);
  });

  it('skips Catalog types', () => {
    expect(shouldSkipNode({ __spz_type__: 'CatalogIndex' })).toBe(true);
  });

  it('skips TimeTable types', () => {
    expect(shouldSkipNode({ __spz_type__: 'TimeTableIndex' })).toBe(true);
  });

  it('keeps ParameterIndex', () => {
    expect(shouldSkipNode({ __spz_type__: 'ParameterIndex' })).toBe(false);
  });

  it('keeps regular objects', () => {
    expect(shouldSkipNode({ __spz_type__: 'DatasetIndex' })).toBe(false);
  });
});

describe('SKIP_KEYS', () => {
  it('contains expected metadata keys', () => {
    expect(SKIP_KEYS.has('__spz_name__')).toBe(true);
    expect(SKIP_KEYS.has('description')).toBe(true);
    expect(SKIP_KEYS.has('UNITS')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — verify failure**

Run: `npm run test:js`
Expected: FAIL — cannot resolve inventory-tree.js.

- [ ] **Step 3: Create inventory-tree.js**

```js
// speasy_proxy/static/js/inventory-tree.js
//
// Inventory node helpers shared by plot.html and demo_3d.html.

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
    'COMPONENT_2', 'QUALITY', 'spaseId', 'dataSource'
]);

export function getDisplayName(node, key) {
    return (node && (node.__spz_name__ || node.name)) || key;
}

export function getProductPath(node) {
    return node.__spz_provider__ + '/' + node.__spz_uid__;
}

export function shouldSkipNode(node) {
    if (!node || typeof node !== 'object') return true;
    const t = node.__spz_type__ || '';
    if (t.indexOf('Catalog') !== -1 || t.indexOf('TimeTable') !== -1) return true;
    return false;
}
```

- [ ] **Step 4: Run tests — verify pass**

Run: `npm run test:js`
Expected: All inventory-tree tests PASS.

- [ ] **Step 5: Commit**

```bash
git add speasy_proxy/static/js/inventory-tree.js tests/js/inventory-tree.test.js
git commit -m "feat: extract inventory-tree.js with node helpers and tests"
```

---

### Task 4: Extract plot-core.js — data processing functions

**Files:**
- Create: `speasy_proxy/static/js/plot-core.js`
- Create: `tests/js/plot-core.test.js`

- [ ] **Step 1: Write failing tests for merge algorithms**

```js
// tests/js/plot-core.test.js
import { describe, it, expect } from 'vitest';
import {
    mergeSortedRows, mergeSorted, mergeIntervals,
    detectPlotType, computeYEdges, buildSeriesData,
    createSubplotData, createProductCache,
    subplotToConfig, subplotFromConfig,
    configToBase64, base64ToConfig
} from '../../speasy_proxy/static/js/plot-core.js';

describe('mergeSortedRows', () => {
  it('merges two non-overlapping sorted arrays', () => {
    const result = mergeSortedRows([1, 3], [2, 4], [['a'], ['c']], [['b'], ['d']]);
    expect(result.times).toEqual([1, 2, 3, 4]);
    expect(result.rows).toEqual([['a'], ['b'], ['c'], ['d']]);
  });

  it('handles duplicate timestamps (new wins)', () => {
    const result = mergeSortedRows([1, 2], [2, 3], [['a'], ['b_old']], [['b_new'], ['c']]);
    expect(result.times).toEqual([1, 2, 3]);
    expect(result.rows).toEqual([['a'], ['b_new'], ['c']]);
  });

  it('handles empty old array', () => {
    const result = mergeSortedRows([], [1, 2], [], [['a'], ['b']]);
    expect(result.times).toEqual([1, 2]);
    expect(result.rows).toEqual([['a'], ['b']]);
  });

  it('handles empty new array', () => {
    const result = mergeSortedRows([1, 2], [], [['a'], ['b']], []);
    expect(result.times).toEqual([1, 2]);
    expect(result.rows).toEqual([['a'], ['b']]);
  });
});

describe('mergeSorted', () => {
  it('merges column-based data', () => {
    const result = mergeSorted(
      [1, 3], [2],
      { x: [10, 30], y: [100, 300] },
      [[20, 200]],
      ['x', 'y']
    );
    expect(result.times).toEqual([1, 2, 3]);
    expect(result.columns.x).toEqual([10, 20, 30]);
    expect(result.columns.y).toEqual([100, 200, 300]);
  });

  it('replaces duplicates with new data', () => {
    const result = mergeSorted(
      [1, 2], [2],
      { x: [10, 20] },
      [[25]],
      ['x']
    );
    expect(result.times).toEqual([1, 2]);
    expect(result.columns.x).toEqual([10, 25]);
  });
});

describe('mergeIntervals', () => {
  it('merges overlapping intervals', () => {
    expect(mergeIntervals([[1, 5], [3, 8], [10, 12]])).toEqual([[1, 8], [10, 12]]);
  });

  it('merges adjacent intervals', () => {
    expect(mergeIntervals([[1, 5], [5, 10]])).toEqual([[1, 10]]);
  });

  it('handles single interval', () => {
    expect(mergeIntervals([[3, 7]])).toEqual([[3, 7]]);
  });

  it('handles empty array', () => {
    expect(mergeIntervals([])).toEqual([]);
  });

  it('sorts unsorted input', () => {
    expect(mergeIntervals([[5, 10], [1, 3]])).toEqual([[1, 3], [5, 10]]);
  });
});

describe('detectPlotType', () => {
  it('returns heatmap for spectrogram display type', () => {
    const json = {
      values: { values: [[1, 2, 3]], meta: { DISPLAY_TYPE: 'spectrogram' } },
      axes: [{}, {}]
    };
    expect(detectPlotType(json)).toBe('heatmap');
  });

  it('returns heatmap for many columns with 2+ axes', () => {
    const row = new Array(15).fill(0);
    const json = {
      values: { values: [row], meta: {} },
      axes: [{}, {}]
    };
    expect(detectPlotType(json)).toBe('heatmap');
  });

  it('returns line for few columns', () => {
    const json = {
      values: { values: [[1, 2, 3]], meta: {} },
      axes: [{}]
    };
    expect(detectPlotType(json)).toBe('line');
  });
});

describe('computeYEdges', () => {
  it('computes bin edges from centers', () => {
    const edges = computeYEdges([1, 3, 5]);
    expect(edges[0]).toBe(0);   // 1 - (3-1)/2
    expect(edges[1]).toBe(2);   // (1+3)/2
    expect(edges[2]).toBe(4);   // (3+5)/2
    expect(edges[3]).toBe(6);   // 5 + (5-3)/2
  });
});

describe('buildSeriesData', () => {
  it('zips times and values', () => {
    expect(buildSeriesData([10, 20, 30], [1, 2, 3])).toEqual([[10, 1], [20, 2], [30, 3]]);
  });
});

describe('config encode/decode', () => {
  it('round-trips through base64', () => {
    const config = { version: 1, time_range: { start: 'a', stop: 'b' }, plots: [] };
    const encoded = configToBase64(config);
    expect(base64ToConfig(encoded)).toEqual(config);
  });

  it('uses URL-safe base64', () => {
    const config = { data: '>>>???===' };
    const encoded = configToBase64(config);
    expect(encoded).not.toMatch(/[+/=]/);
  });
});

describe('createSubplotData', () => {
  it('returns correct defaults', () => {
    const sp = createSubplotData();
    expect(sp.products).toEqual([]);
    expect(sp.y_axis.log).toBe(false);
    expect(sp.logScale).toBe(true);
    expect(sp.plotType).toBe('line');
  });
});

describe('subplotToConfig / subplotFromConfig', () => {
  it('round-trips subplot config', () => {
    const sp = createSubplotData();
    sp.products.push({ path: 'amda/imf', label: 'IMF' });
    sp.y_axis.log = true;
    sp.logScale = false;
    sp.productData['amda/imf'] = createProductCache('amda/imf');

    const config = subplotToConfig(sp);
    expect(config.products).toEqual([{ path: 'amda/imf', label: 'IMF' }]);
    expect(config.y_axis.log).toBe(true);
    expect(config.log_z).toBe(false);

    const restored = subplotFromConfig(config);
    expect(restored.products).toEqual([{ path: 'amda/imf', label: 'IMF' }]);
    expect(restored.y_axis.log).toBe(true);
    expect(restored.logScale).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests — verify failure**

Run: `npm run test:js`
Expected: FAIL — cannot resolve plot-core.js.

- [ ] **Step 3: Create plot-core.js**

```js
// speasy_proxy/static/js/plot-core.js
//
// Pure data-processing functions for the plot viewer.
// No DOM or ECharts dependencies — fully testable.

export function createSubplotData() {
    return {
        products: [],
        y_axis: { log: false },
        logScale: true,
        plotType: 'line',
        lastHeatmapImg: null,
        productData: {}
    };
}

export function createProductCache(path) {
    return {
        path: path,
        intervals: [],
        times: [],
        columns: {},
        columnNames: [],
        unit: '',
        yAxis: null,
        yAxisName: '',
        yAxisUnit: '',
        rows: [],
        displayType: ''
    };
}

export function subplotToConfig(sp) {
    return {
        products: sp.products.map(p => ({ path: p.path, label: p.label })),
        y_axis: { log: sp.y_axis.log },
        log_z: sp.logScale
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
    if (displayType === 'spectrogram' || (numCols > 10 && json.axes.length >= 2)) {
        return 'heatmap';
    }
    return 'line';
}

export function mergeSortedRows(oldTimes, newTimes, oldRows, newRows) {
    const resultTimes = [];
    const resultRows = [];
    let i = 0, j = 0;
    while (i < oldTimes.length && j < newTimes.length) {
        if (oldTimes[i] < newTimes[j]) {
            resultTimes.push(oldTimes[i]);
            resultRows.push(oldRows[i]);
            i++;
        } else if (oldTimes[i] > newTimes[j]) {
            resultTimes.push(newTimes[j]);
            resultRows.push(newRows[j]);
            j++;
        } else {
            resultTimes.push(newTimes[j]);
            resultRows.push(newRows[j]);
            i++; j++;
        }
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
            for (let c = 0; c < columnNames.length; c++) {
                resultColumns[columnNames[c]].push(newValues[j][c]);
            }
            j++;
        } else {
            resultTimes.push(newTimes[j]);
            for (let c = 0; c < columnNames.length; c++) {
                resultColumns[columnNames[c]].push(newValues[j][c]);
            }
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
        for (let c = 0; c < columnNames.length; c++) {
            resultColumns[columnNames[c]].push(newValues[j][c]);
        }
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
        if (intervals[i][0] <= last[1]) {
            last[1] = Math.max(last[1], intervals[i][1]);
        } else {
            merged.push(intervals[i].slice());
        }
    }
    return merged;
}

export function computeYEdges(yBinsFlat) {
    const yEdges = new Array(yBinsFlat.length + 1);
    for (let i = 1; i < yBinsFlat.length; i++) {
        yEdges[i] = (yBinsFlat[i - 1] + yBinsFlat[i]) / 2;
    }
    yEdges[0] = yBinsFlat[0] - (yBinsFlat.length > 1 ? (yBinsFlat[1] - yBinsFlat[0]) / 2 : 0.5);
    yEdges[yBinsFlat.length] = yBinsFlat[yBinsFlat.length - 1] +
        (yBinsFlat.length > 1 ? (yBinsFlat[yBinsFlat.length - 1] - yBinsFlat[yBinsFlat.length - 2]) / 2 : 0.5);
    return yEdges;
}

export function buildSeriesData(times, values) {
    const data = new Array(times.length);
    for (let i = 0; i < times.length; i++) {
        data[i] = [times[i], values[i]];
    }
    return data;
}

export function configToBase64(config) {
    return btoa(JSON.stringify(config))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64ToConfig(b64) {
    const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(padded));
}
```

- [ ] **Step 4: Run tests — verify pass**

Run: `npm run test:js`
Expected: All plot-core tests PASS.

- [ ] **Step 5: Commit**

```bash
git add speasy_proxy/static/js/plot-core.js tests/js/plot-core.test.js
git commit -m "feat: extract plot-core.js with data processing functions and tests"
```

---

## Chunk 2: Wire extracted modules into templates

### Task 5: Update plot.html to use extracted modules

**Files:**
- Modify: `speasy_proxy/templates/plot.html`

The key constraint: ECharts is loaded via CDN as a classic script (not a module), so `echarts` is a global. Our modules need to import from the static JS files, then the remaining inline code uses those imports alongside the `echarts` global.

- [ ] **Step 1: Add module script imports to plot.html**

After the ECharts `<script>` tag (line 7) and before the closing `</head>`, there are no changes needed. The module imports go inside the existing `<script>` block. Replace the `<script>` on line 405 with `<script type="module">` and add imports at the top:

```html
<script type="module">
    import { toLocalISOString, escapeHtml, setStatus, showLoading, showFetchBar,
             fallbackCopy, initControlsCollapse } from '{{ base_url }}/static/js/common.js';
    import { getDisplayName, getProductPath, shouldSkipNode, SKIP_KEYS }
             from '{{ base_url }}/static/js/inventory-tree.js';
    import { createSubplotData, createProductCache, subplotToConfig, subplotFromConfig,
             detectPlotType, mergeSortedRows, mergeSorted, mergeIntervals,
             computeYEdges, buildSeriesData, configToBase64, base64ToConfig }
             from '{{ base_url }}/static/js/plot-core.js';

    const BASE_URL = '{{ base_url }}';
    const API_BASE = BASE_URL + '/';
    // ... rest of inline code with the extracted functions REMOVED
```

- [ ] **Step 2: Remove extracted function bodies from inline script**

Remove these function definitions from `plot.html`'s inline script (they are now imported):
- `escapeHtml` (lines 495-499)
- `toLocalISOString` (lines 501-506)
- `fallbackCopy` (lines 508-517)
- `getDisplayName` (lines 519-521)
- `getProductPath` (lines 523-525)
- `shouldSkipNode` (lines 544-549)
- `SKIP_KEYS` constant (lines 409-420)
- `createSubplotData` (lines 445-456)
- `createProductCache` (lines 477-491)
- `subplotToConfig` (lines 458-464)
- `subplotFromConfig` (lines 466-475)
- `detectPlotType` (lines 1063-1071)
- `mergeSortedRows` (lines 1073-1095)
- `mergeSorted` (lines 1097-1137)
- `mergeIntervals` (lines 1139-1152)
- `computeYEdges` (lines 1463-1472)
- `buildSeriesData` (lines 1668-1674)
- `configToBase64` (lines 1930-1933)
- `base64ToConfig` (lines 1935-1938)

Keep `showLoading` and `setStatus` referenced via imports — the inline code calls them by name, which works because the `import` brings them into module scope.

Also remove the `initControlsCollapse` function definition and replace its call in DOMContentLoaded with:
```js
initControlsCollapse('.controls-bar', 'controls-collapse-btn');
```

- [ ] **Step 3: Verify the page works**

Run: `uv run uvicorn speasy_proxy:app --reload`
Open `http://localhost:8000/plot` in a browser.
Verify: sidebar loads, inventory tree renders, selecting a product and plotting works.

- [ ] **Step 4: Commit**

```bash
git add speasy_proxy/templates/plot.html
git commit -m "refactor: plot.html imports shared modules instead of inline definitions"
```

---

### Task 6: Update demo_3d.html to use extracted modules

**Files:**
- Modify: `speasy_proxy/templates/demo_3d.html`

- [ ] **Step 1: Add module imports to demo_3d.html**

Change the inline `<script>` (line 502) to `<script type="module">` and add imports:

```html
<script type="module">
    import { toLocalISOString, setStatus, showLoading, showFetchBar,
             initControlsCollapse } from '{{ base_url }}/static/js/common.js';

    const API_BASE = '{{ base_url }}/';
    // ... rest of inline code
```

- [ ] **Step 2: Remove extracted function bodies**

Remove from demo_3d.html inline script:
- `setStatus` (lines 598-600)
- `showLoading` (lines 602-604)
- `showFetchBar` (lines 606-608)
- `toLocalISOString` (lines 1069-1072)

Replace the IIFE `initControlsCollapse` (lines 1233-1241) with:
```js
initControlsCollapse('#controls-bar', 'controls-collapse-btn', () => {
    setTimeout(() => chart && chart.resize(), 200);
});
```

Note: demo_3d.html uses `statusBar` as the element ID instead of `status-bar`. The `setStatus` in `common.js` already handles both via the `||` fallback.

Note: demo_3d.html has its own `METADATA_KEYS` and tree-building logic that is different from plot.html's tree (checkboxes, groups, etc.). Do NOT extract these — they are page-specific.

- [ ] **Step 3: Verify the page works**

Run: `uv run uvicorn speasy_proxy:app --reload`
Open `http://localhost:8000/demo_3d` in a browser.
Verify: sidebar loads, inventory tree renders, checking a satellite fetches and plots its orbit.

- [ ] **Step 4: Commit**

```bash
git add speasy_proxy/templates/demo_3d.html
git commit -m "refactor: demo_3d.html imports shared modules instead of inline definitions"
```

---

### Task 7: Extract shared CSS

**Files:**
- Create: `speasy_proxy/static/css/common.css`
- Modify: `speasy_proxy/templates/plot.html`
- Modify: `speasy_proxy/templates/demo_3d.html`

- [ ] **Step 1: Create common.css with shared styles**

Extract the identical CSS rules into `speasy_proxy/static/css/common.css`:

```css
/* speasy_proxy/static/css/common.css — shared layout and theme */

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif;
    background: #0b0e17;
    color: #e0e6f0;
    display: flex;
    height: 100vh;
    overflow: hidden;
}

/* ---- Sidebar ---- */
.sidebar {
    width: 320px;
    min-width: 260px;
    background: #111627;
    border-right: 1px solid #1e2640;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transition: width 0.15s, min-width 0.15s;
}

.sidebar.collapsed {
    width: 0;
    min-width: 0;
    border-right: none;
    overflow: hidden;
}

.sidebar-collapse-btn {
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    z-index: 10;
    width: 20px;
    height: 48px;
    background: #1a1f36;
    border: 1px solid #2a3358;
    border-left: none;
    border-radius: 0 6px 6px 0;
    color: #8892b0;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
    transition: left 0.15s;
}

.sidebar-collapse-btn:hover {
    background: #2a3358;
    color: #e0e6f0;
}

.sidebar-header {
    padding: 16px;
    border-bottom: 1px solid #1e2640;
}

.sidebar-header .back-link {
    display: inline-block;
    color: #6b8afd;
    text-decoration: none;
    font-size: 0.85rem;
    margin-bottom: 8px;
}

.sidebar-header .back-link:hover { text-decoration: underline; }

.sidebar-header h2 {
    font-size: 1.1rem;
    font-weight: 600;
    margin-bottom: 10px;
}

.sidebar-header input[type="text"] {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid #2a3358;
    border-radius: 6px;
    background: #0b0e17;
    color: #e0e6f0;
    font-size: 0.9rem;
    outline: none;
}

.sidebar-header input[type="text"]:focus { border-color: #6b8afd; }

/* ---- Main area ---- */
.main {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

/* Controls bar */
.controls-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    background: #111627;
    border-bottom: 1px solid #1e2640;
    flex-wrap: wrap;
    overflow: hidden;
    transition: height 0.15s, padding 0.15s;
}

.controls-bar.collapsed {
    height: 0;
    padding: 0 16px;
    border-bottom: none;
    overflow: hidden;
}

.controls-collapse-btn {
    background: #1a1f36;
    border: 1px solid #2a3358;
    border-top: none;
    border-radius: 0 0 6px 6px;
    color: #8892b0;
    cursor: pointer;
    font-size: 0.65rem;
    padding: 2px 16px;
    align-self: center;
    margin: 0 auto;
    display: block;
    transition: background 0.15s;
    position: relative;
    z-index: 5;
}

.controls-collapse-btn:hover {
    background: #2a3358;
    color: #e0e6f0;
}

.controls-bar label {
    font-size: 0.8rem;
    color: #8892b0;
    margin-right: 2px;
}

/* Chart area */
.chart-wrapper {
    flex: 1;
    position: relative;
    overflow: hidden;
}

.chart-loading-overlay {
    position: absolute;
    inset: 0;
    display: none;
    align-items: center;
    justify-content: center;
    background: rgba(11, 14, 23, 0.75);
    z-index: 10;
    pointer-events: none;
}

.chart-loading-overlay.visible { display: flex; }

.chart-loading-overlay .spinner {
    width: 36px;
    height: 36px;
    border: 3px solid #2a3358;
    border-top-color: #6b8afd;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

.fetch-bar {
    position: absolute;
    top: 0;
    left: 0;
    height: 2px;
    background: #6b8afd;
    z-index: 20;
    opacity: 0;
    transition: opacity 0.2s;
    animation: fetch-bar-slide 1.2s ease-in-out infinite;
}

.fetch-bar.active { opacity: 1; }

@keyframes fetch-bar-slide {
    0% { left: 0; width: 0; }
    30% { left: 0; width: 40%; }
    70% { left: 60%; width: 40%; }
    100% { left: 100%; width: 0; }
}

.status-bar {
    padding: 6px 16px;
    font-size: 0.78rem;
    color: #8892b0;
    background: #111627;
    border-top: 1px solid #1e2640;
}
```

- [ ] **Step 2: Add link to common.css in both templates**

In both `plot.html` and `demo_3d.html`, add inside `<head>` before the `<style>` tag:

```html
<link rel="stylesheet" href="{{ base_url }}/static/css/common.css">
```

- [ ] **Step 3: Remove duplicated CSS from both templates**

Remove the CSS rules from each template's `<style>` block that are now in `common.css`. Keep only page-specific styles:

For `plot.html`, keep:
- `.tree-container` (with its specific rules)
- `.tree-container .loading-text`
- `#chart` sizing
- `.resize-handle`
- `.controls-bar input[type="text"]`, `.controls-bar input[type="datetime-local"]`
- `.controls-bar button` styles
- `.add-dropdown-item`
- The `@media (max-width: 768px)` responsive rules

For `demo_3d.html`, keep:
- `.tree-container` with its specific rules
- `.tree-node`, `.tree-children`, `.tree-node.hidden` etc.
- `#chart3d` sizing
- `.controls-bar select`, `.controls-bar input[type="datetime-local"]`
- `.controls-sep`, `.controls-value`
- `.duration-btns` button styles
- `.overlay` (mobile-specific)
- Scrollbar styling
- The `@media (max-width: 700px)` responsive rules

- [ ] **Step 4: Verify both pages render correctly**

Run: `uv run uvicorn speasy_proxy:app --reload`
Check both `/plot` and `/demo_3d` — layouts, colors, transitions should be identical to before.

- [ ] **Step 5: Commit**

```bash
git add speasy_proxy/static/css/common.css speasy_proxy/templates/plot.html speasy_proxy/templates/demo_3d.html
git commit -m "refactor: extract shared CSS into common.css"
```

---

### Task 8: Final verification and cleanup

- [ ] **Step 1: Run all JS tests**

Run: `npm run test:js`
Expected: All tests pass.

- [ ] **Step 2: Manual smoke test**

1. Open `/plot`, search for a product, plot it, zoom/pan, add a subplot, share URL, reload from shared URL.
2. Open `/demo_3d`, search for a satellite, check it, toggle magnetopause, change coord system.
3. Verify no console errors in browser dev tools.

- [ ] **Step 3: Commit any final fixes**

If any issues found, fix and commit.

---

## Summary of final file tree

```
speasy_proxy/
├── static/
│   ├── css/
│   │   └── common.css              # shared layout & theme
│   ├── js/
│   │   ├── common.js               # shared UI helpers (ES module)
│   │   ├── inventory-tree.js       # node filtering helpers (ES module)
│   │   └── plot-core.js            # data processing functions (ES module)
│   ├── earth_bluemarble.jpg
│   └── ...logos...
├── templates/
│   ├── plot.html                   # imports from js/*.js, page-specific CSS & logic only
│   └── demo_3d.html                # imports from js/*.js, page-specific CSS & logic only
tests/
├── js/
│   ├── common.test.js
│   ├── inventory-tree.test.js
│   └── plot-core.test.js
package.json                        # dev-only: vitest
vitest.config.js
```
