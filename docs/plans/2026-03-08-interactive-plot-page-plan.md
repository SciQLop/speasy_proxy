# Interactive Plot Page Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `/plot` page with an inventory browser, time range picker, and reactive ECharts plot that auto-fetches data on zoom/pan.

**Architecture:** Single HTML template served by a new FastAPI route. ECharts from CDN, vanilla JS, no build step. Client-side cache of fetched time ranges to avoid redundant API calls. Inventory loaded from existing `get_inventory` endpoint, data from `get_data?format=json`.

**Tech Stack:** FastAPI, Jinja2, ECharts (CDN), vanilla JS

---

### Task 1: Add the `/plot` route

**Files:**
- Modify: `speasy_proxy/frontend/home.py`

**Step 1: Add the plot route**

Add a new route handler below the existing `home` function in `home.py`:

```python
@router.get('/plot', response_class=HTMLResponse)
def plot(request: Request, x_scheme: Annotated[str | None, Header()] = None):
    scheme = x_scheme or request.url.scheme
    base_url = str(scheme) + "://" + str(request.url.netloc)
    if base_url.endswith('/'):
        base_url = base_url[:-1]
    return templates.TemplateResponse(request, name="plot.html", context={"request": request, 'base_url': base_url})
```

**Step 2: Commit**

```bash
git add speasy_proxy/frontend/home.py
git commit -m "Add /plot route handler"
```

---

### Task 2: Add "Plot" link to home page

**Files:**
- Modify: `speasy_proxy/templates/index.html`

**Step 1: Add a Plot button to the hero-buttons div**

In `index.html`, inside the `<div class="hero-buttons">` section, add a third button after the GitHub link:

```html
<a href="plot" class="btn btn-primary">
    <svg viewBox="0 0 24 24"><path d="M3 3v18h18M9 17V9m4 8V5m4 12v-4"/></svg>
    Interactive Plot
</a>
```

**Step 2: Commit**

```bash
git add speasy_proxy/templates/index.html
git commit -m "Add Interactive Plot link to home page"
```

---

### Task 3: Create the plot page template — layout and styles

**Files:**
- Create: `speasy_proxy/templates/plot.html`

**Step 1: Create the HTML template with layout structure**

Create `speasy_proxy/templates/plot.html` with:
- A sidebar (left, ~300px) for inventory tree + search
- A main area with a controls bar (product path, datetime inputs, Plot button) and the chart container
- ECharts loaded from CDN: `https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js`
- Dark theme matching the existing home page (`#0b0e17` background, `#e0e6f0` text)
- Responsive: sidebar collapses on narrow screens

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Speasy Plot</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
    <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            color: #e0e6f0;
            background: #0b0e17;
            height: 100vh;
            display: flex;
            overflow: hidden;
        }

        a { color: #7eb8ff; text-decoration: none; }

        /* Sidebar */
        .sidebar {
            width: 320px;
            min-width: 260px;
            background: #0f1320;
            border-right: 1px solid rgba(255,255,255,0.07);
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .sidebar-header {
            padding: 1rem;
            border-bottom: 1px solid rgba(255,255,255,0.07);
            flex-shrink: 0;
        }

        .sidebar-header h2 {
            font-size: 1rem;
            font-weight: 600;
            color: #c0d0e8;
            margin-bottom: 0.6rem;
        }

        .sidebar-header a.back-link {
            font-size: 0.8rem;
            color: #6b7fa0;
            display: block;
            margin-bottom: 0.6rem;
        }

        #search-box {
            width: 100%;
            padding: 0.5rem 0.7rem;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 6px;
            color: #e0e6f0;
            font-size: 0.85rem;
            outline: none;
        }

        #search-box:focus {
            border-color: #3b6cb5;
        }

        #search-box::placeholder {
            color: #4a5a74;
        }

        .tree-container {
            flex: 1;
            overflow-y: auto;
            padding: 0.5rem;
        }

        /* Tree styles */
        .tree-node { user-select: none; }

        .tree-label {
            display: flex;
            align-items: center;
            gap: 0.3rem;
            padding: 0.2rem 0.4rem;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.82rem;
            color: #b0bdd0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .tree-label:hover { background: rgba(255,255,255,0.06); }

        .tree-label.selected {
            background: rgba(59, 108, 181, 0.25);
            color: #7eb8ff;
        }

        .tree-label .arrow {
            display: inline-block;
            width: 14px;
            text-align: center;
            font-size: 0.7rem;
            color: #4a5a74;
            flex-shrink: 0;
            transition: transform 0.15s;
        }

        .tree-label .arrow.open { transform: rotate(90deg); }

        .tree-label.leaf .arrow { visibility: hidden; }

        .tree-children {
            padding-left: 1rem;
            display: none;
        }

        .tree-children.open { display: block; }

        /* Main area */
        .main {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .controls {
            padding: 0.8rem 1rem;
            background: #0f1320;
            border-bottom: 1px solid rgba(255,255,255,0.07);
            display: flex;
            align-items: center;
            gap: 0.8rem;
            flex-wrap: wrap;
            flex-shrink: 0;
        }

        .controls label {
            font-size: 0.78rem;
            color: #6b7fa0;
            text-transform: uppercase;
            letter-spacing: 0.04em;
        }

        .controls input[type="text"],
        .controls input[type="datetime-local"] {
            padding: 0.4rem 0.6rem;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 6px;
            color: #e0e6f0;
            font-size: 0.85rem;
            outline: none;
        }

        .controls input:focus {
            border-color: #3b6cb5;
        }

        #product-path {
            flex: 1;
            min-width: 200px;
        }

        #btn-plot {
            padding: 0.45rem 1.2rem;
            background: linear-gradient(135deg, #3b6cb5, #5b4ea0);
            color: #fff;
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 6px;
            font-size: 0.85rem;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s ease;
        }

        #btn-plot:hover {
            background: linear-gradient(135deg, #4a7dc6, #6b5eb0);
            box-shadow: 0 4px 15px rgba(59, 108, 181, 0.4);
        }

        #btn-plot:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .chart-container {
            flex: 1;
            position: relative;
            min-height: 0;
        }

        #chart {
            width: 100%;
            height: 100%;
        }

        #status-bar {
            padding: 0.3rem 1rem;
            font-size: 0.75rem;
            color: #4a5a74;
            background: #0a0d15;
            border-top: 1px solid rgba(255,255,255,0.05);
            flex-shrink: 0;
        }

        .loading-overlay {
            position: absolute;
            inset: 0;
            background: rgba(11,14,23,0.7);
            display: flex;
            align-items: center;
            justify-content: center;
            color: #6b7fa0;
            font-size: 0.9rem;
            z-index: 10;
        }

        .loading-overlay.hidden { display: none; }

        @media (max-width: 700px) {
            body { flex-direction: column; }
            .sidebar { width: 100%; height: 40vh; min-width: unset; border-right: none; border-bottom: 1px solid rgba(255,255,255,0.07); }
        }
    </style>
</head>
<body>

<aside class="sidebar">
    <div class="sidebar-header">
        <a href="/" class="back-link">&larr; Back to dashboard</a>
        <h2>Products</h2>
        <input type="text" id="search-box" placeholder="Search products...">
    </div>
    <div class="tree-container" id="tree-container">
        <div style="padding:1rem; color:#4a5a74; font-size:0.85rem;">Loading inventory...</div>
    </div>
</aside>

<div class="main">
    <div class="controls">
        <label>Product</label>
        <input type="text" id="product-path" readonly placeholder="Select a product from the tree">
        <label>Start</label>
        <input type="datetime-local" id="start-time" step="1">
        <label>Stop</label>
        <input type="datetime-local" id="stop-time" step="1">
        <button id="btn-plot" disabled>Plot</button>
    </div>
    <div class="chart-container">
        <div id="loading-overlay" class="loading-overlay hidden">Loading data...</div>
        <div id="chart"></div>
    </div>
    <div id="status-bar">Ready</div>
</div>

<script>
/* ===== CONFIGURATION ===== */
const BASE_URL = '{{ base_url }}';
const API_BASE = BASE_URL + '/';

/* ===== STATE ===== */
let chart = null;
let inventory = null;
let selectedProduct = null;
let cachedData = null; // { product, intervals: [[start,end],...], times: Float64Array-like, columns: {name: [...values]}, columnNames: [] }

/* ===== INITIALIZATION ===== */
document.addEventListener('DOMContentLoaded', () => {
    initChart();
    loadInventory();
    bindControls();
    loadFromURLParams();
});

/* Content of the <script> will be filled in Tasks 4-7 */
</script>
</body>
</html>
```

**Step 2: Verify the page loads**

Run: `uv run uvicorn speasy_proxy:app --reload` and navigate to `http://localhost:8000/plot`

Expected: Page renders with sidebar showing "Loading inventory...", controls bar, and empty chart area.

**Step 3: Commit**

```bash
git add speasy_proxy/templates/plot.html
git commit -m "Add plot page template with layout and styles"
```

---

### Task 4: Implement inventory tree loading and rendering

**Files:**
- Modify: `speasy_proxy/templates/plot.html` (add JS inside the `<script>` block)

**Step 1: Implement `loadInventory()` and tree rendering**

Replace the placeholder comment in the script with the inventory loading logic. The inventory JSON from `/get_inventory?format=json&provider=all` has this structure:
```
{ __spz_name__, __spz_provider__, __spz_type__, __spz_uid__,
  amda: { Parameters: { ACE: { MFI: { ace_mfi_mag: { c1_b_gsm: {__spz_type__: "ParameterIndex", ...}, ...} } } } },
  cda: { ... }, ssc: { ... }, ... }
```

Leaf nodes have `__spz_type__` containing `"ParameterIndex"` or `"ComponentIndex"`. The `__spz_uid__` gives the product ID and `__spz_provider__` gives the provider. The plottable path is `provider/uid`.

Non-leaf nodes that have `__spz_type__` ending in `"Index"` (like `DatasetIndex`, `MissionIndex`, `InstrumentIndex`) are intermediate containers.

Skip `Catalogs`, `TimeTables` and nodes with `__spz_type__` containing `"Catalog"` or `"TimeTable"`.

```javascript
async function loadInventory() {
    try {
        const resp = await fetch(API_BASE + 'get_inventory?format=json&provider=all');
        if (!resp.ok) throw new Error('Failed to load inventory');
        inventory = JSON.parse(await resp.text());
        renderTree(inventory);
    } catch (e) {
        document.getElementById('tree-container').innerHTML =
            '<div style="padding:1rem;color:#ff6b6b;font-size:0.85rem;">Failed to load inventory</div>';
        console.error('Inventory load error:', e);
    }
}

const SKIP_KEYS = new Set(['__spz_name__', '__spz_provider__', '__spz_type__', '__spz_uid__',
    'build_date', 'Catalogs', 'TimeTables']);
const SKIP_TYPES = ['Catalog', 'TimeTable'];

function shouldSkip(key, node) {
    if (SKIP_KEYS.has(key)) return true;
    if (typeof node !== 'object' || node === null) return true;
    const t = node.__spz_type__ || '';
    return SKIP_TYPES.some(s => t.includes(s));
}

function isLeaf(node) {
    const t = node.__spz_type__ || '';
    return t === 'ParameterIndex';
}

function getProductPath(node) {
    return node.__spz_provider__ + '/' + node.__spz_uid__;
}

function getDisplayName(node, key) {
    return node.__spz_name__ || node.name || key;
}

function renderTree(data) {
    const container = document.getElementById('tree-container');
    container.innerHTML = '';
    // top-level: provider nodes
    for (const key of Object.keys(data).sort()) {
        if (shouldSkip(key, data[key])) continue;
        const node = buildTreeNode(data[key], key);
        if (node) container.appendChild(node);
    }
}

function buildTreeNode(data, key) {
    if (typeof data !== 'object' || data === null) return null;

    const div = document.createElement('div');
    div.className = 'tree-node';

    const label = document.createElement('div');
    label.className = 'tree-label';
    const name = getDisplayName(data, key);

    if (isLeaf(data)) {
        label.classList.add('leaf');
        label.innerHTML = '<span class="arrow">&#9654;</span>' + escapeHtml(name);
        label.addEventListener('click', () => selectProduct(data, label));
        // Store metadata for date prefill
        label.dataset.startDate = data.start_date || '';
        label.dataset.stopDate = data.stop_date || '';
    } else {
        const arrow = document.createElement('span');
        arrow.className = 'arrow';
        arrow.textContent = '\u25B6';
        label.appendChild(arrow);
        label.appendChild(document.createTextNode(name));

        const children = document.createElement('div');
        children.className = 'tree-children';

        const childKeys = Object.keys(data).filter(k => !shouldSkip(k, data[k])).sort();
        for (const ck of childKeys) {
            const childNode = buildTreeNode(data[ck], ck);
            if (childNode) children.appendChild(childNode);
        }

        if (children.children.length === 0) return null;

        label.addEventListener('click', () => {
            children.classList.toggle('open');
            arrow.classList.toggle('open');
        });

        div.appendChild(label);
        div.appendChild(children);
        return div;
    }

    div.appendChild(label);
    return div;
}

function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

let selectedLabel = null;
function selectProduct(node, label) {
    if (selectedLabel) selectedLabel.classList.remove('selected');
    label.classList.add('selected');
    selectedLabel = label;

    const path = getProductPath(node);
    selectedProduct = path;
    document.getElementById('product-path').value = path;
    document.getElementById('btn-plot').disabled = false;

    // Prefill dates from inventory metadata if available
    const startInput = document.getElementById('start-time');
    const stopInput = document.getElementById('stop-time');
    if (node.stop_date && !stopInput.value) {
        // Default to last 2 hours of available data
        const stop = new Date(node.stop_date);
        const start = new Date(stop.getTime() - 2 * 3600 * 1000);
        startInput.value = toLocalISOString(start);
        stopInput.value = toLocalISOString(stop);
    }

    updateURL();
}

function toLocalISOString(date) {
    const pad = n => String(n).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth()+1) + '-' + pad(date.getDate())
        + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}
```

**Step 2: Verify the tree loads**

Reload `/plot`. The sidebar should show the expandable provider tree. Clicking a `ParameterIndex` leaf should populate the product path and dates.

**Step 3: Commit**

```bash
git add speasy_proxy/templates/plot.html
git commit -m "Implement inventory tree loading and rendering"
```

---

### Task 5: Implement search/filter for the tree

**Files:**
- Modify: `speasy_proxy/templates/plot.html` (add to `<script>`)

**Step 1: Add search filter logic**

This builds a flat index of all leaf nodes on first load, then filters the tree display on input. When searching, it shows matching leaves as a flat list. When the search is cleared, it restores the tree.

```javascript
let leafIndex = []; // [{name, path, node, startDate, stopDate}]

function buildLeafIndex(data, breadcrumb) {
    if (typeof data !== 'object' || data === null) return;
    if (isLeaf(data)) {
        leafIndex.push({
            name: (breadcrumb + ' > ' + getDisplayName(data, '')).toLowerCase(),
            displayName: getDisplayName(data, ''),
            breadcrumb: breadcrumb,
            node: data,
            path: getProductPath(data)
        });
        return;
    }
    for (const k of Object.keys(data)) {
        if (shouldSkip(k, data[k])) continue;
        const childName = getDisplayName(data[k], k);
        buildLeafIndex(data[k], breadcrumb ? breadcrumb + ' > ' + childName : childName);
    }
}

function setupSearch() {
    leafIndex = [];
    buildLeafIndex(inventory, '');

    document.getElementById('search-box').addEventListener('input', (e) => {
        const query = e.target.value.trim().toLowerCase();
        if (query.length < 2) {
            renderTree(inventory);
            return;
        }
        renderSearchResults(query);
    });
}

function renderSearchResults(query) {
    const container = document.getElementById('tree-container');
    container.innerHTML = '';
    const terms = query.split(/\s+/);
    const matches = leafIndex.filter(leaf =>
        terms.every(t => leaf.name.includes(t))
    ).slice(0, 100); // Cap at 100 results

    if (matches.length === 0) {
        container.innerHTML = '<div style="padding:1rem;color:#4a5a74;font-size:0.85rem;">No results</div>';
        return;
    }

    for (const match of matches) {
        const div = document.createElement('div');
        div.className = 'tree-node';
        const label = document.createElement('div');
        label.className = 'tree-label leaf';
        label.innerHTML = '<span class="arrow">&#9654;</span>'
            + '<span style="color:#4a5a74;font-size:0.75rem;">' + escapeHtml(match.breadcrumb) + ' &gt; </span>'
            + escapeHtml(match.displayName);
        label.addEventListener('click', () => selectProduct(match.node, label));
        div.appendChild(label);
        container.appendChild(div);
    }
}
```

Then call `setupSearch()` at the end of `loadInventory()` after `renderTree(inventory)`:

```javascript
// In loadInventory(), after renderTree(inventory):
setupSearch();
```

**Step 2: Verify search works**

Type "c1 b gsm" in the search box. Should see matching AMDA parameters. Clear the search to restore the tree.

**Step 3: Commit**

```bash
git add speasy_proxy/templates/plot.html
git commit -m "Add search/filter for inventory tree"
```

---

### Task 6: Implement initial data fetch and ECharts plot

**Files:**
- Modify: `speasy_proxy/templates/plot.html` (add to `<script>`)

**Step 1: Implement chart initialization and data plotting**

The `get_data?format=json` endpoint returns:
```json
{
  "axes": [{"values": [nanosecond_timestamps, ...], "name": "time", ...}],
  "values": {"values": [[component_values], ...], "name": "...", ...},
  "columns": ["bx", "by", "bz"]
}
```

Time values are in nanoseconds since epoch. Values are 2D: `values[i]` is a row (one per timestamp), each row has one value per component.

```javascript
function initChart() {
    chart = echarts.init(document.getElementById('chart'), 'dark');
    window.addEventListener('resize', () => chart.resize());
}

function bindControls() {
    document.getElementById('btn-plot').addEventListener('click', doPlot);

    // Also allow Enter key in datetime fields
    document.getElementById('start-time').addEventListener('keydown', (e) => { if (e.key === 'Enter') doPlot(); });
    document.getElementById('stop-time').addEventListener('keydown', (e) => { if (e.key === 'Enter') doPlot(); });
}

async function doPlot() {
    const product = document.getElementById('product-path').value;
    const startStr = document.getElementById('start-time').value;
    const stopStr = document.getElementById('stop-time').value;

    if (!product || !startStr || !stopStr) {
        setStatus('Please select a product and time range');
        return;
    }

    const startTime = new Date(startStr);
    const stopTime = new Date(stopStr);

    if (startTime >= stopTime) {
        setStatus('Start time must be before stop time');
        return;
    }

    // Reset cache for new product
    cachedData = {
        product: product,
        intervals: [],
        times: [],
        columns: {},
        columnNames: [],
        unit: ''
    };

    updateURL();
    await fetchAndPlot(startTime, stopTime);
}

async function fetchAndPlot(startTime, stopTime) {
    showLoading(true);
    setStatus('Fetching data...');

    try {
        const data = await fetchData(cachedData.product, startTime, stopTime);
        if (!data) {
            setStatus('No data returned');
            showLoading(false);
            return;
        }

        mergeData(data, startTime, stopTime);
        renderChart();
        setStatus('Loaded ' + cachedData.times.length + ' points, ' + cachedData.columnNames.length + ' components');
    } catch (e) {
        setStatus('Error: ' + e.message);
        console.error(e);
    }
    showLoading(false);
}

async function fetchData(product, startTime, stopTime) {
    const url = API_BASE + 'get_data?format=json'
        + '&path=' + encodeURIComponent(product)
        + '&start_time=' + startTime.toISOString()
        + '&stop_time=' + stopTime.toISOString();

    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Server returned ' + resp.status);
    const text = await resp.text();
    // The JSON may contain NaN which isn't valid JSON — replace with null
    return JSON.parse(text.replace(/\bNaN\b/g, 'null'));
}

function mergeData(json, fetchStart, fetchStop) {
    const times = json.axes[0].values; // nanosecond timestamps
    const values = json.values.values;  // [[v0,v1,...], [v0,v1,...], ...]
    const columns = json.columns || [];
    const numComponents = values.length > 0 ? values[0].length : 0;
    const unit = json.values.meta?.SI_CONVERSION || json.values.meta?.UNITS || '';

    if (cachedData.times.length === 0) {
        // First load
        cachedData.times = times.map(t => t / 1e6); // nanoseconds to milliseconds
        cachedData.columnNames = columns.length > 0 ? columns
            : Array.from({length: numComponents}, (_, i) => 'component ' + i);
        cachedData.unit = unit;
        for (let c = 0; c < numComponents; c++) {
            cachedData.columns[cachedData.columnNames[c]] = values.map(row => row[c]);
        }
        cachedData.intervals = [[fetchStart.getTime(), fetchStop.getTime()]];
    } else {
        // Merge into existing data
        const newTimes = times.map(t => t / 1e6);
        const merged = mergeSorted(cachedData.times, newTimes, cachedData.columns, values, cachedData.columnNames);
        cachedData.times = merged.times;
        cachedData.columns = merged.columns;
        cachedData.intervals = mergeIntervals([...cachedData.intervals, [fetchStart.getTime(), fetchStop.getTime()]]);
    }
}

function mergeSorted(existingTimes, newTimes, existingCols, newValues, colNames) {
    // Build combined arrays, removing duplicates by time
    const combined = [];
    let ei = 0, ni = 0;
    while (ei < existingTimes.length && ni < newTimes.length) {
        if (existingTimes[ei] < newTimes[ni]) {
            const row = {};
            for (const c of colNames) row[c] = existingCols[c][ei];
            combined.push({time: existingTimes[ei], values: row});
            ei++;
        } else if (existingTimes[ei] > newTimes[ni]) {
            const row = {};
            for (let c = 0; c < colNames.length; c++) row[colNames[c]] = newValues[ni][c];
            combined.push({time: newTimes[ni], values: row});
            ni++;
        } else {
            // Same timestamp — keep existing
            const row = {};
            for (const c of colNames) row[c] = existingCols[c][ei];
            combined.push({time: existingTimes[ei], values: row});
            ei++; ni++;
        }
    }
    while (ei < existingTimes.length) {
        const row = {};
        for (const c of colNames) row[c] = existingCols[c][ei];
        combined.push({time: existingTimes[ei], values: row});
        ei++;
    }
    while (ni < newTimes.length) {
        const row = {};
        for (let c = 0; c < colNames.length; c++) row[colNames[c]] = newValues[ni][c];
        combined.push({time: newTimes[ni], values: row});
        ni++;
    }

    const resultTimes = combined.map(r => r.time);
    const resultCols = {};
    for (const c of colNames) resultCols[c] = combined.map(r => r.values[c]);
    return {times: resultTimes, columns: resultCols};
}

function mergeIntervals(intervals) {
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

const SERIES_COLORS = ['#5470c6','#91cc75','#fac858','#ee6666','#73c0de','#3ba272','#fc8452','#9a60b4','#ea7ccc'];

function renderChart() {
    const series = cachedData.columnNames.map((name, i) => ({
        name: name,
        type: 'line',
        showSymbol: false,
        data: cachedData.times.map((t, j) => [t, cachedData.columns[name][j]]),
        lineStyle: { width: 1.5 },
        color: SERIES_COLORS[i % SERIES_COLORS.length],
        large: true,
        largeThreshold: 5000,
        sampling: 'lttb'
    }));

    const option = {
        backgroundColor: '#0b0e17',
        animation: false,
        tooltip: {
            trigger: 'axis',
            backgroundColor: 'rgba(15,19,32,0.95)',
            borderColor: 'rgba(255,255,255,0.1)',
            textStyle: { color: '#e0e6f0', fontSize: 12 },
            formatter: function(params) {
                if (!params.length) return '';
                let s = new Date(params[0].value[0]).toISOString().replace('T',' ').replace('Z','') + '<br/>';
                for (const p of params) {
                    const val = p.value[1];
                    s += '<span style="color:' + p.color + '">&#9679;</span> '
                        + p.seriesName + ': '
                        + (val === null ? 'NaN' : val.toPrecision(6)) + '<br/>';
                }
                return s;
            }
        },
        legend: {
            data: cachedData.columnNames,
            textStyle: { color: '#b0bdd0', fontSize: 11 },
            top: 5,
            type: 'scroll'
        },
        grid: {
            left: 80,
            right: 40,
            top: 40,
            bottom: 80
        },
        xAxis: {
            type: 'time',
            axisLabel: { color: '#6b7fa0' },
            axisLine: { lineStyle: { color: '#2a2e3a' } },
            splitLine: { show: true, lineStyle: { color: '#1a1e2a' } }
        },
        yAxis: {
            type: 'value',
            name: cachedData.unit,
            nameTextStyle: { color: '#6b7fa0' },
            axisLabel: { color: '#6b7fa0' },
            axisLine: { lineStyle: { color: '#2a2e3a' } },
            splitLine: { lineStyle: { color: '#1a1e2a' } }
        },
        dataZoom: [
            {
                type: 'inside',
                xAxisIndex: 0,
                filterMode: 'none',
                throttle: 100
            },
            {
                type: 'slider',
                xAxisIndex: 0,
                filterMode: 'none',
                height: 25,
                bottom: 10,
                borderColor: 'rgba(255,255,255,0.1)',
                backgroundColor: 'rgba(255,255,255,0.03)',
                fillerColor: 'rgba(59,108,181,0.15)',
                handleStyle: { color: '#3b6cb5' },
                textStyle: { color: '#6b7fa0' },
                dataBackground: {
                    lineStyle: { color: '#3b6cb5', opacity: 0.5 },
                    areaStyle: { color: '#3b6cb5', opacity: 0.1 }
                }
            }
        ],
        toolbox: {
            feature: {
                restore: {},
                saveAsImage: { pixelRatio: 2 }
            },
            right: 20,
            iconStyle: { borderColor: '#6b7fa0' }
        },
        series: series
    };

    chart.setOption(option, true);
}

function showLoading(show) {
    document.getElementById('loading-overlay').classList.toggle('hidden', !show);
}

function setStatus(msg) {
    document.getElementById('status-bar').textContent = msg;
}
```

**Step 2: Verify initial plot works**

Navigate to `/plot`, select a product (e.g. `amda/c1_b_gsm`), enter a 2-hour time range, click Plot. Should see line chart with all components, zoom slider at bottom.

**Step 3: Commit**

```bash
git add speasy_proxy/templates/plot.html
git commit -m "Implement data fetch and ECharts plot rendering"
```

---

### Task 7: Implement smart data fetching on zoom/pan

**Files:**
- Modify: `speasy_proxy/templates/plot.html` (add to `<script>`)

**Step 1: Add debounced zoom/pan handler with gap detection**

```javascript
let fetchDebounceTimer = null;
const FETCH_DEBOUNCE_MS = 300;
const MAX_CACHE_POINTS = 500000;

function setupZoomHandler() {
    chart.on('datazoom', () => {
        if (fetchDebounceTimer) clearTimeout(fetchDebounceTimer);
        fetchDebounceTimer = setTimeout(onZoomPan, FETCH_DEBOUNCE_MS);
    });
}

async function onZoomPan() {
    if (!cachedData || cachedData.times.length === 0) return;

    const option = chart.getOption();
    const xAxis = option.xAxis[0];

    // Get visible range from dataZoom
    const zoom = option.dataZoom[0];
    const dataMin = cachedData.times[0];
    const dataMax = cachedData.times[cachedData.times.length - 1];
    const range = dataMax - dataMin;

    const visStart = dataMin + range * (zoom.start / 100);
    const visEnd = dataMin + range * (zoom.end / 100);

    // Compute gaps: visible range minus cached intervals
    const gaps = computeGaps(visStart, visEnd, cachedData.intervals);

    if (gaps.length === 0) return;

    setStatus('Fetching additional data...');
    showLoading(true);

    try {
        for (const [gapStart, gapEnd] of gaps) {
            const data = await fetchData(cachedData.product, new Date(gapStart), new Date(gapEnd));
            if (data && data.axes[0].values.length > 0) {
                mergeData(data, new Date(gapStart), new Date(gapEnd));
            }
        }
        // Evict if over cache limit
        evictCache();
        renderChart();
        setStatus('Loaded ' + cachedData.times.length + ' points');
    } catch (e) {
        setStatus('Error fetching data: ' + e.message);
        console.error(e);
    }
    showLoading(false);
}

function computeGaps(viewStart, viewEnd, intervals) {
    // Return array of [start,end] gaps within [viewStart, viewEnd] not covered by intervals
    const gaps = [];
    let cursor = viewStart;
    for (const [iStart, iEnd] of intervals) {
        if (iStart > cursor) {
            gaps.push([cursor, Math.min(iStart, viewEnd)]);
        }
        cursor = Math.max(cursor, iEnd);
        if (cursor >= viewEnd) break;
    }
    if (cursor < viewEnd) {
        gaps.push([cursor, viewEnd]);
    }
    return gaps.filter(([s, e]) => e > s);
}

function evictCache() {
    if (cachedData.times.length <= MAX_CACHE_POINTS) return;
    // Keep only the most recent MAX_CACHE_POINTS
    const excess = cachedData.times.length - MAX_CACHE_POINTS;
    cachedData.times = cachedData.times.slice(excess);
    for (const c of cachedData.columnNames) {
        cachedData.columns[c] = cachedData.columns[c].slice(excess);
    }
    // Update intervals
    const newStart = cachedData.times[0];
    cachedData.intervals = cachedData.intervals
        .map(([s, e]) => [Math.max(s, newStart), e])
        .filter(([s, e]) => e > s);
}
```

Then call `setupZoomHandler()` at the end of `renderChart()`:

```javascript
// At the end of renderChart():
setupZoomHandler();
```

**Step 2: Verify zoom/pan fetching**

Plot data for a 2-hour range. Then zoom out or pan beyond the range. After 300ms, new data should be fetched and the chart updated. The status bar should reflect the loading.

**Step 3: Commit**

```bash
git add speasy_proxy/templates/plot.html
git commit -m "Add smart data fetching on zoom/pan with client-side cache"
```

---

### Task 8: Implement URL state and auto-plot from params

**Files:**
- Modify: `speasy_proxy/templates/plot.html` (add to `<script>`)

**Step 1: Add URL state management**

```javascript
function updateURL() {
    const product = document.getElementById('product-path').value;
    const startStr = document.getElementById('start-time').value;
    const stopStr = document.getElementById('stop-time').value;
    const params = new URLSearchParams();
    if (product) params.set('path', product);
    if (startStr) params.set('start', startStr);
    if (stopStr) params.set('stop', stopStr);
    const newURL = window.location.pathname + '?' + params.toString();
    history.replaceState(null, '', newURL);
}

function loadFromURLParams() {
    const params = new URLSearchParams(window.location.search);
    const path = params.get('path');
    const start = params.get('start');
    const stop = params.get('stop');

    if (path) {
        document.getElementById('product-path').value = path;
        selectedProduct = path;
        document.getElementById('btn-plot').disabled = false;
    }
    if (start) document.getElementById('start-time').value = start;
    if (stop) document.getElementById('stop-time').value = stop;

    // Auto-plot if all params present
    if (path && start && stop) {
        // Wait for DOM to be ready, then plot
        setTimeout(doPlot, 100);
    }
}
```

**Step 2: Verify URL state**

Select a product and time range, click Plot. The URL should update to include `?path=...&start=...&stop=...`. Copy the URL, open in new tab — should auto-load the plot.

**Step 3: Commit**

```bash
git add speasy_proxy/templates/plot.html
git commit -m "Add URL state management for shareable plot links"
```

---

### Task 9: Final integration test

**Step 1: Run the server and test the full workflow**

```bash
uv run uvicorn speasy_proxy:app --reload
```

Test checklist:
- [ ] Home page has "Interactive Plot" button linking to `/plot`
- [ ] `/plot` loads and shows inventory tree in sidebar
- [ ] Search box filters products
- [ ] Clicking a leaf product populates path and dates
- [ ] Clicking Plot fetches data and renders ECharts line plot
- [ ] Zoom/pan triggers smart data fetching
- [ ] URL updates and is shareable

**Step 2: Final commit**

If any fixes were needed, commit them.

```bash
git commit -m "Interactive plot page: final fixes"
```
