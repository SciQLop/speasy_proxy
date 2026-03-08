# Multi-Plot Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend the ECharts plot UI to support multiple stacked/overlaid subplots with a shareable JSON config URL.

**Architecture:** Replace the single-product state model with an array-of-subplots state object mirroring the JSON config schema. A single ECharts instance uses multiple `grid`/`xAxis`/`yAxis` entries with shared `dataZoom`. The config is base64url-encoded in the URL for sharing.

**Tech Stack:** ECharts 5 (multi-grid), vanilla JS, base64url encoding

---

### Task 1: Refactor state model from single-product to multi-subplot

The current code uses flat globals (`cachedData`, `selectedProduct`, `plotType`, `logScale`, `logYAxis`, `currentView`). Replace with a structured state object.

**Files:**
- Modify: `speasy_proxy/templates/plot.html` (lines 293-303 — state declarations)

**Step 1: Replace global state with structured plotState**

Replace the current state variables (lines 293-303):
```javascript
let chart = null;
let inventory = null;
let selectedProduct = null;
let cachedData = null;
let leafIndex = [];
let zoomDebounceTimer = null;
let plotType = 'line';
let logScale = true;
let logYAxis = false;
let lastHeatmapImg = null;
```

With:
```javascript
let chart = null;
let inventory = null;
let selectedProduct = null;  // currently selected in the tree (not yet plotted)
let leafIndex = [];
let zoomDebounceTimer = null;

// Multi-plot state — single source of truth
// Each subplot entry in plotState.plots contains:
//   { products: [{path, label}], y_axis: {log}, plotType, cachedData: {...}, lastHeatmapImg }
const plotState = {
    version: 1,
    time_range: { start: null, stop: null },
    plots: []  // array of subplot objects
};

let currentView = { start: null, end: null };
let isFetching = false;

function createSubplotData() {
    return {
        products: [],      // [{path, label}]
        y_axis: { log: false },
        plotType: 'line',   // 'line' or 'heatmap'
        logScale: true,     // for heatmap Z-axis
        lastHeatmapImg: null,
        productData: {}     // keyed by product path, each: {intervals, times, columns, columnNames, unit, yAxis, yAxisName, yAxisUnit, rows, displayType}
    };
}

function createProductCache(path) {
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
```

**Step 2: Verify the page still loads (no JS errors)**

Open the plot page in a browser, check the console for errors. The page should load but plotting will be broken (expected — we'll fix in subsequent tasks).

**Step 3: Commit**

```bash
git add speasy_proxy/templates/plot.html
git commit -m "refactor: replace flat plot globals with multi-subplot state model"
```

---

### Task 2: Implement config URL encoding/decoding and backward-compat redirect

**Files:**
- Modify: `speasy_proxy/templates/plot.html` (lines 1421-1454 — URL state functions)

**Step 1: Replace updateURL and loadFromURLParams**

Replace the current `updateURL()` (line 1423) and `loadFromURLParams()` (line 1437) with:

```javascript
function stateToConfig() {
    // Build a shareable config object from current plotState
    const config = {
        version: 1,
        time_range: {
            start: plotState.time_range.start,
            stop: plotState.time_range.stop
        },
        plots: plotState.plots.map(sp => ({
            products: sp.products.map(p => ({ path: p.path, label: p.label })),
            y_axis: { log: sp.y_axis.log }
        }))
    };
    return config;
}

function configToBase64(config) {
    return btoa(JSON.stringify(config))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64ToConfig(b64) {
    const padded = b64.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(padded));
}

function updateURL() {
    if (plotState.plots.length === 0) return;
    const config = stateToConfig();
    const encoded = configToBase64(config);
    const newUrl = window.location.pathname + '?config=' + encoded;
    history.replaceState(null, '', newUrl);
}

function loadFromURLParams() {
    const params = new URLSearchParams(window.location.search);

    // Backward compat: redirect old ?path=&start=&stop= to ?config=
    const path = params.get('path');
    const start = params.get('start');
    const stop = params.get('stop');
    if (path) {
        const config = {
            version: 1,
            time_range: { start: start, stop: stop },
            plots: [{ products: [{ path: path }], y_axis: { log: false } }]
        };
        const encoded = configToBase64(config);
        history.replaceState(null, '', window.location.pathname + '?config=' + encoded);
        applyConfig(config);
        return;
    }

    // New format: ?config=base64
    const configParam = params.get('config');
    if (configParam) {
        try {
            const config = base64ToConfig(configParam);
            applyConfig(config);
        } catch (e) {
            console.error('Invalid config URL:', e);
            setStatus('Invalid config in URL.');
        }
    }
}

function applyConfig(config) {
    // Populate plotState from a config object, then fetch and render all subplots
    plotState.time_range.start = config.time_range.start;
    plotState.time_range.stop = config.time_range.stop;

    if (config.time_range.start) {
        document.getElementById('start-time').value = toLocalISOString(new Date(config.time_range.start));
    }
    if (config.time_range.stop) {
        document.getElementById('stop-time').value = toLocalISOString(new Date(config.time_range.stop));
    }

    plotState.plots = [];
    for (const plotDef of config.plots) {
        const subplot = createSubplotData();
        subplot.y_axis.log = plotDef.y_axis?.log || false;
        for (const prod of plotDef.products) {
            subplot.products.push({ path: prod.path, label: prod.label || prod.path });
            subplot.productData[prod.path] = createProductCache(prod.path);
        }
        plotState.plots.push(subplot);
    }

    // Set first product as selected in the input (for display)
    if (plotState.plots.length > 0 && plotState.plots[0].products.length > 0) {
        document.getElementById('product-path').value = plotState.plots[0].products[0].path;
        document.getElementById('btn-plot').disabled = false;
    }

    // Trigger fetch for all products
    setTimeout(() => fetchAllAndRender(), 100);
}
```

**Step 2: Add fetchAllAndRender stub**

Add after the above:
```javascript
async function fetchAllAndRender() {
    // Will be implemented in Task 4
    // For now, just call doPlot-like logic for the first product
    if (plotState.plots.length === 0) return;
    setStatus('Multi-plot fetch not yet implemented');
}
```

**Step 3: Commit**

```bash
git add speasy_proxy/templates/plot.html
git commit -m "feat: add config URL encoding/decoding with backward-compat redirect"
```

---

### Task 3: Add UI controls — "Add to plot" dropdown and "Share" button

**Files:**
- Modify: `speasy_proxy/templates/plot.html` (lines 247-260 — controls bar HTML, lines 555-577 — bindControls)

**Step 1: Add HTML for new controls**

Replace the controls bar (lines 247-260) with:
```html
<div class="controls-bar">
    <label for="product-path">Product</label>
    <input type="text" id="product-path" readonly placeholder="Select a product from the tree">

    <label for="start-time">Start</label>
    <input type="datetime-local" id="start-time">

    <label for="stop-time">Stop</label>
    <input type="datetime-local" id="stop-time">

    <button id="btn-plot" disabled>Plot</button>

    <div style="position:relative;display:inline-block;">
        <button id="btn-add" disabled>Add to plot ▾</button>
        <div id="add-dropdown" style="display:none;position:absolute;top:100%;left:0;z-index:100;background:#1a1f36;border:1px solid #2a3358;border-radius:6px;min-width:200px;padding:4px 0;box-shadow:0 4px 12px rgba(0,0,0,0.4);">
        </div>
    </div>

    <button id="btn-log-scale" style="display:none;" title="Toggle log/linear color scale">Log Z</button>
    <button id="btn-log-y" style="display:none;" title="Toggle log/linear Y axis">Log Y</button>

    <div style="position:relative;display:inline-block;">
        <button id="btn-share">Share</button>
        <div id="share-popover" style="display:none;position:absolute;top:100%;right:0;z-index:100;background:#1a1f36;border:1px solid #2a3358;border-radius:6px;padding:10px;box-shadow:0 4px 12px rgba(0,0,0,0.4);min-width:300px;">
            <input type="text" id="share-url" readonly style="width:100%;background:#0b0e17;border:1px solid #2a3358;color:#e0e6f0;padding:6px 8px;border-radius:4px;font-size:0.8rem;margin-bottom:6px;">
            <button id="btn-copy-url" style="width:100%;">Copy URL</button>
        </div>
    </div>
</div>
```

**Step 2: Add CSS for dropdown items**

Add in the `<style>` section:
```css
.add-dropdown-item {
    padding: 6px 12px;
    cursor: pointer;
    white-space: nowrap;
    color: #e0e6f0;
    font-size: 0.85rem;
}
.add-dropdown-item:hover {
    background: #2a3358;
}
```

**Step 3: Wire up the new buttons in bindControls**

Add to `bindControls()`:
```javascript
// Add to plot dropdown
document.getElementById('btn-add').addEventListener('click', () => {
    const dropdown = document.getElementById('add-dropdown');
    if (dropdown.style.display === 'none') {
        populateAddDropdown();
        dropdown.style.display = 'block';
    } else {
        dropdown.style.display = 'none';
    }
});

// Close dropdown on outside click
document.addEventListener('click', (e) => {
    const addBtn = document.getElementById('btn-add');
    const dropdown = document.getElementById('add-dropdown');
    if (!addBtn.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.style.display = 'none';
    }
    const shareBtn = document.getElementById('btn-share');
    const popover = document.getElementById('share-popover');
    if (!shareBtn.contains(e.target) && !popover.contains(e.target)) {
        popover.style.display = 'none';
    }
});

// Share button
document.getElementById('btn-share').addEventListener('click', () => {
    const popover = document.getElementById('share-popover');
    if (popover.style.display === 'none') {
        updateShareURL();
        popover.style.display = 'block';
    } else {
        popover.style.display = 'none';
    }
});

document.getElementById('btn-copy-url').addEventListener('click', () => {
    const urlInput = document.getElementById('share-url');
    navigator.clipboard.writeText(urlInput.value).then(() => {
        document.getElementById('btn-copy-url').textContent = 'Copied!';
        setTimeout(() => { document.getElementById('btn-copy-url').textContent = 'Copy URL'; }, 1500);
    });
});
```

**Step 4: Add populateAddDropdown and updateShareURL**

```javascript
function populateAddDropdown() {
    const dropdown = document.getElementById('add-dropdown');
    dropdown.innerHTML = '';

    // "New subplot" option
    const newItem = document.createElement('div');
    newItem.className = 'add-dropdown-item';
    newItem.textContent = '+ New subplot';
    newItem.addEventListener('click', () => {
        addProductToPlot(null); // null = new subplot
        dropdown.style.display = 'none';
    });
    dropdown.appendChild(newItem);

    // Existing subplots
    for (let i = 0; i < plotState.plots.length; i++) {
        const sp = plotState.plots[i];
        const label = sp.products.length > 0 ? sp.products[0].path.split('/').pop() : 'empty';
        const item = document.createElement('div');
        item.className = 'add-dropdown-item';
        item.textContent = 'Subplot ' + (i + 1) + ': ' + label;
        const idx = i;
        item.addEventListener('click', () => {
            addProductToPlot(idx);
            dropdown.style.display = 'none';
        });
        dropdown.appendChild(item);
    }
}

function addProductToPlot(subplotIndex) {
    const product = document.getElementById('product-path').value;
    const startTime = document.getElementById('start-time').value;
    const stopTime = document.getElementById('stop-time').value;

    if (!product) { setStatus('No product selected.'); return; }
    if (!startTime || !stopTime) { setStatus('Please set start and stop times.'); return; }

    plotState.time_range.start = new Date(startTime).toISOString();
    plotState.time_range.stop = new Date(stopTime).toISOString();

    let subplot;
    if (subplotIndex === null) {
        // New subplot
        subplot = createSubplotData();
        plotState.plots.push(subplot);
    } else {
        subplot = plotState.plots[subplotIndex];
    }

    // Don't add duplicates
    if (subplot.products.some(p => p.path === product)) {
        setStatus('Product already in this subplot.');
        return;
    }

    subplot.products.push({ path: product, label: product });
    subplot.productData[product] = createProductCache(product);

    updateURL();
    fetchProductAndRender(plotState.plots.indexOf(subplot), product);
}

function updateShareURL() {
    if (plotState.plots.length === 0) return;
    const config = stateToConfig();
    const encoded = configToBase64(config);
    const fullUrl = window.location.origin + window.location.pathname + '?config=' + encoded;
    document.getElementById('share-url').value = fullUrl;
}

async function fetchProductAndRender(subplotIndex, productPath) {
    // Will be fully implemented in Task 4
    setStatus('Fetching ' + productPath + '...');
}
```

**Step 5: Enable "Add to plot" button when a product is selected**

In `selectProduct()` (line 434), add after `document.getElementById('btn-plot').disabled = false;`:
```javascript
document.getElementById('btn-add').disabled = false;
```

**Step 6: Commit**

```bash
git add speasy_proxy/templates/plot.html
git commit -m "feat: add 'Add to plot' dropdown and 'Share' button UI"
```

---

### Task 4: Implement multi-subplot data fetching

Adapt `doPlot`, `fetchAndPlot`, and `mergeData` to work with the per-product cache in each subplot.

**Files:**
- Modify: `speasy_proxy/templates/plot.html` (lines 579-706 — doPlot, fetchAndPlot, fetchData, mergeData)

**Step 1: Rewrite doPlot to use plotState**

Replace `doPlot()` (line 579):
```javascript
async function doPlot() {
    const product = document.getElementById('product-path').value;
    const startTime = document.getElementById('start-time').value;
    const stopTime = document.getElementById('stop-time').value;

    if (!product) { setStatus('No product selected.'); return; }
    if (!startTime || !stopTime) { setStatus('Please set start and stop times.'); return; }

    // Reset: clear all subplots, create one with this product
    plotState.time_range.start = new Date(startTime).toISOString();
    plotState.time_range.stop = new Date(stopTime).toISOString();
    plotState.plots = [];

    const subplot = createSubplotData();
    subplot.products.push({ path: product, label: product });
    subplot.productData[product] = createProductCache(product);
    plotState.plots.push(subplot);

    updateURL();
    await fetchAllAndRender();
}
```

**Step 2: Implement fetchAllAndRender**

Replace the stub from Task 2:
```javascript
async function fetchAllAndRender() {
    showLoading(true);
    setStatus('Fetching data...');

    const startTime = plotState.time_range.start;
    const stopTime = plotState.time_range.stop;
    if (!startTime || !stopTime) { showLoading(false); return; }

    const startISO = new Date(startTime).toISOString();
    const stopISO = new Date(stopTime).toISOString();
    const fetchStartMs = new Date(startTime).getTime();
    const fetchStopMs = new Date(stopTime).getTime();

    // Fetch all products in parallel
    const fetchPromises = [];
    for (const subplot of plotState.plots) {
        for (const prod of subplot.products) {
            fetchPromises.push(
                fetchData(prod.path, startISO, stopISO)
                    .then(data => ({ subplot, path: prod.path, data }))
                    .catch(e => ({ subplot, path: prod.path, error: e }))
            );
        }
    }

    const results = await Promise.all(fetchPromises);

    for (const result of results) {
        if (result.error) {
            console.error('Fetch error for', result.path, result.error);
            continue;
        }
        const { subplot, path, data } = result;
        if (!data || !data.values || !data.axes || data.axes.length === 0) continue;

        const cache = subplot.productData[path];
        mergeProductData(cache, data, fetchStartMs, fetchStopMs);

        // Detect plot type from first product
        if (subplot.plotType === 'line' && subplot.products[0].path === path) {
            subplot.plotType = detectPlotType(data);
        }
    }

    currentView = { start: fetchStartMs, end: fetchStopMs };
    renderAllSubplots();

    const totalProducts = plotState.plots.reduce((n, sp) => n + sp.products.length, 0);
    setStatus('Loaded ' + totalProducts + ' product(s) across ' + plotState.plots.length + ' subplot(s)');
    showLoading(false);
}
```

**Step 3: Add mergeProductData — adapts existing mergeData to work on a per-product cache**

```javascript
function mergeProductData(cache, json, fetchStart, fetchStop) {
    const rawTimes = json.axes[0].values;
    const newTimes = rawTimes.map(t => t / 1e6);
    const newValues = json.values.values;
    const columns = json.columns || [];
    const unit = (json.values.meta && json.values.meta.UNITS) || '';

    const isHeatmap = detectPlotType(json) === 'heatmap';

    if (cache.times.length === 0) {
        cache.times = newTimes;
        cache.unit = unit;
        cache.intervals = [[fetchStart, fetchStop]];
        cache.displayType = (json.values.meta || {}).DISPLAY_TYPE || '';

        if (isHeatmap) {
            if (json.axes.length >= 2) {
                cache.yAxis = json.axes[1].values;
                cache.yAxisName = json.axes[1].name || '';
                cache.yAxisUnit = (json.axes[1].meta && json.axes[1].meta.UNITS) || '';
            } else {
                cache.yAxis = newValues[0] ? newValues[0].map((_, i) => i) : [];
            }
            cache.rows = newValues;
            cache.columnNames = columns;
        } else {
            cache.columnNames = columns.length > 0 ? columns :
                (newValues[0] ? newValues[0].map((_, i) => 'col_' + i) : ['value']);
            for (let c = 0; c < cache.columnNames.length; c++) {
                cache.columns[cache.columnNames[c]] = newValues.map(row => row[c]);
            }
        }
    } else {
        if (isHeatmap) {
            const merged = mergeSortedRows(cache.times, newTimes, cache.rows, newValues);
            cache.times = merged.times;
            cache.rows = merged.rows;
        } else {
            const merged = mergeSorted(cache.times, newTimes, cache.columns, newValues, cache.columnNames);
            cache.times = merged.times;
            cache.columns = merged.columns;
        }
        cache.intervals = mergeIntervals(cache.intervals.concat([[fetchStart, fetchStop]]));
    }
}
```

**Step 4: Implement fetchProductAndRender (used by "Add to plot")**

Replace the stub from Task 3:
```javascript
async function fetchProductAndRender(subplotIndex, productPath) {
    showLoading(true);
    setStatus('Fetching ' + productPath + '...');

    const startTime = plotState.time_range.start;
    const stopTime = plotState.time_range.stop;
    const startISO = new Date(startTime).toISOString();
    const stopISO = new Date(stopTime).toISOString();
    const fetchStartMs = new Date(startTime).getTime();
    const fetchStopMs = new Date(stopTime).getTime();

    try {
        const data = await fetchData(productPath, startISO, stopISO);
        if (!data || !data.values || !data.axes || data.axes.length === 0) {
            setStatus('No data returned for ' + productPath);
            showLoading(false);
            return;
        }

        const subplot = plotState.plots[subplotIndex];
        const cache = subplot.productData[productPath];
        mergeProductData(cache, data, fetchStartMs, fetchStopMs);

        // Update subplot plotType based on first product
        if (subplot.products[0].path === productPath) {
            subplot.plotType = detectPlotType(data);
        }

        renderAllSubplots();
        setStatus('Added ' + productPath);
    } catch (e) {
        setStatus('Error fetching ' + productPath + ': ' + e.message);
        console.error(e);
    } finally {
        showLoading(false);
    }
}
```

**Step 5: Commit**

```bash
git add speasy_proxy/templates/plot.html
git commit -m "feat: implement multi-product parallel data fetching with per-product cache"
```

---

### Task 5: Implement multi-grid ECharts rendering

The core rendering task: replace `renderChart`, `renderLineChart`, `renderHeatmap` with multi-subplot-aware versions.

**Files:**
- Modify: `speasy_proxy/templates/plot.html` (lines 797-1100 — rendering functions)

**Step 1: Implement renderAllSubplots**

This replaces `renderChart()` as the main render entry point:

```javascript
function renderAllSubplots(preserveView) {
    const n = plotState.plots.length;
    if (n === 0) return;

    const grids = [];
    const xAxes = [];
    const yAxes = [];
    const series = [];
    const graphics = [];
    const GAP = 40;       // vertical gap between subplots
    const TOP_PAD = 30;   // top padding for first subplot
    const BOT_PAD = 60;   // bottom padding for dataZoom slider
    const gridHeight = Math.max(80, (100 - ((GAP * (n - 1) + TOP_PAD + BOT_PAD) / chart.getHeight() * 100)) / n);

    // Compute pixel-based grid positions
    const chartHeight = chart.getHeight();
    const usableHeight = chartHeight - TOP_PAD - BOT_PAD - GAP * (n - 1);
    const subplotHeight = Math.max(80, usableHeight / n);

    for (let i = 0; i < n; i++) {
        const subplot = plotState.plots[i];
        const topPx = TOP_PAD + i * (subplotHeight + GAP);

        grids.push({
            left: 80, right: 20, top: topPx, height: subplotHeight, containLabel: false
        });

        // All subplots share the time range but each has its own xAxis instance
        // (linked via dataZoom xAxisIndex)
        const firstCache = subplot.productData[subplot.products[0]?.path];
        const times = firstCache?.times || [];

        xAxes.push({
            type: 'time',
            gridIndex: i,
            // Only show labels on bottom subplot
            axisLabel: { show: i === n - 1, color: '#8892b0' },
            axisLine: { lineStyle: { color: '#2a3358' } },
            splitLine: { show: false },
            min: times.length > 0 ? times[0] - (times[times.length-1] - times[0]) * 2 : undefined,
            max: times.length > 0 ? times[times.length-1] + (times[times.length-1] - times[0]) * 2 : undefined
        });

        if (subplot.plotType === 'heatmap' && firstCache) {
            // Heatmap subplot — use first product only (spectrograms don't overlay well)
            const yBins = firstCache.yAxis;
            const yBinsFlat = Array.isArray(yBins?.[0]) ? yBins[0] : (yBins || []);
            const yEdges = computeYEdges(yBinsFlat);
            const yLabel = firstCache.yAxisName + (firstCache.yAxisUnit ? ' (' + firstCache.yAxisUnit + ')' : '');

            yAxes.push({
                type: subplot.y_axis.log ? 'log' : 'value',
                gridIndex: i,
                name: yLabel,
                nameTextStyle: { color: '#8892b0' },
                axisLabel: { color: '#8892b0' },
                axisLine: { lineStyle: { color: '#2a3358' } },
                splitLine: { show: false },
                min: subplot.y_axis.log ? Math.max(yEdges[0], 1e-10) : yEdges[0],
                max: yEdges[yBinsFlat.length]
            });

            // Dummy scatter for axis management
            series.push({
                type: 'scatter',
                data: [],
                xAxisIndex: i,
                yAxisIndex: i,
                silent: true
            });

            // Render spectrogram image (will be positioned after chart.setOption)
            // Store index for post-render positioning
            subplot._gridIndex = i;
        } else {
            // Line subplot
            yAxes.push({
                type: subplot.y_axis.log ? 'log' : 'value',
                gridIndex: i,
                name: firstCache?.unit || '',
                nameTextStyle: { color: '#8892b0' },
                axisLabel: { color: '#8892b0' },
                axisLine: { lineStyle: { color: '#2a3358' } },
                splitLine: { lineStyle: { color: '#1e2640' } }
            });

            // Add series for each product in this subplot
            let colorIdx = 0;
            for (const prod of subplot.products) {
                const cache = subplot.productData[prod.path];
                if (!cache || cache.times.length === 0) continue;

                for (let c = 0; c < cache.columnNames.length; c++) {
                    const colName = cache.columnNames[c];
                    const seriesName = subplot.products.length > 1
                        ? prod.path.split('/').pop() + ' ' + colName
                        : colName;
                    series.push({
                        name: seriesName,
                        type: 'line',
                        showSymbol: false,
                        lineStyle: { width: 1.2 },
                        color: CHART_COLORS[colorIdx % CHART_COLORS.length],
                        data: buildSeriesData(cache.times, cache.columns[colName]),
                        sampling: 'lttb',
                        large: true,
                        largeThreshold: 50000,
                        xAxisIndex: i,
                        yAxisIndex: i
                    });
                    colorIdx++;
                }
            }
        }
    }

    // dataZoom links ALL xAxis instances
    const xAxisIndices = xAxes.map((_, i) => i);
    const firstTimes = plotState.plots[0].productData[plotState.plots[0].products[0]?.path]?.times || [];
    const dzStart = preserveView && currentView.start != null ? currentView.start : (firstTimes[0] || 0);
    const dzEnd = preserveView && currentView.end != null ? currentView.end : (firstTimes[firstTimes.length - 1] || 0);

    const dataZoom = [
        {
            type: 'inside',
            xAxisIndex: xAxisIndices,
            filterMode: 'none',
            zoomOnMouseWheel: false,
            moveOnMouseWheel: false,
            moveOnMouseMove: true,
            preventDefaultMouseMove: true,
            startValue: dzStart,
            endValue: dzEnd
        },
        {
            type: 'slider',
            xAxisIndex: xAxisIndices,
            bottom: 8,
            height: 20,
            borderColor: '#2a3358',
            backgroundColor: '#111627',
            fillerColor: 'rgba(107,138,253,0.15)',
            handleStyle: { color: '#6b8afd' },
            textStyle: { color: '#8892b0' },
            filterMode: 'none',
            startValue: dzStart,
            endValue: dzEnd
        }
    ];

    const option = {
        backgroundColor: 'transparent',
        animation: false,
        legend: {
            type: 'scroll',
            top: 5,
            textStyle: { color: '#e0e6f0' }
        },
        tooltip: {
            trigger: 'axis',
            backgroundColor: '#1a1f36',
            borderColor: '#2a3358',
            textStyle: { color: '#e0e6f0', fontSize: 12 }
        },
        grid: grids,
        xAxis: xAxes,
        yAxis: yAxes,
        dataZoom: dataZoom,
        series: series,
        graphic: []  // clear previous graphics
    };

    chart.setOption(option, true);

    if (!preserveView) {
        currentView.start = dzStart;
        currentView.end = dzEnd;
    }

    // Render and position spectrogram images
    for (const subplot of plotState.plots) {
        if (subplot.plotType === 'heatmap') {
            renderSubplotHeatmap(subplot);
        }
    }

    setupMultiZoomHandler();
    updateShareURL();
}
```

**Step 2: Add helper for Y-axis edges (extracted from renderHeatmap)**

```javascript
function computeYEdges(yBinsFlat) {
    const yEdges = new Array(yBinsFlat.length + 1);
    for (let i = 1; i < yBinsFlat.length; i++) {
        yEdges[i] = (yBinsFlat[i - 1] + yBinsFlat[i]) / 2;
    }
    yEdges[0] = yBinsFlat[0] - (yBinsFlat.length > 1 ? (yBinsFlat[1] - yBinsFlat[0]) / 2 : 0.5);
    yEdges[yBinsFlat.length] = yBinsFlat[yBinsFlat.length - 1] +
        (yBinsFlat.length > 1 ? (yBinsFlat[yBinsFlat.length-1] - yBinsFlat[yBinsFlat.length-2]) / 2 : 0.5);
    return yEdges;
}
```

**Step 3: Add renderSubplotHeatmap — positions spectrogram image for a specific subplot grid**

```javascript
function renderSubplotHeatmap(subplot) {
    const cache = subplot.productData[subplot.products[0]?.path];
    if (!cache || !cache.yAxis || cache.rows.length === 0) return;

    const yBinsFlat = Array.isArray(cache.yAxis[0]) ? cache.yAxis[0] : cache.yAxis;

    // Compute value range
    let vMin = Infinity, vMax = -Infinity;
    for (const row of cache.rows) {
        if (!row) continue;
        for (const val of row) {
            if (val != null && !isNaN(val) && val > 0) {
                if (val < vMin) vMin = val;
                if (val > vMax) vMax = val;
            }
        }
    }
    if (vMin === Infinity) vMin = 1e-30;
    if (vMax === -Infinity) vMax = 1;
    if (vMin === vMax) vMax = vMin * 10;

    const img = renderSpectrogramImage(cache.times, cache.rows, yBinsFlat, vMin, vMax, subplot.logScale);
    if (!img) return;

    subplot.lastHeatmapImg = img;
    updateSubplotHeatmapGraphic(subplot, img);
}
```

**Step 4: Update renderSpectrogramImage to accept logScale as parameter**

Change the signature of `renderSpectrogramImage` (line 919) to accept `logScaleParam` instead of reading the global `logScale`:
```javascript
function renderSpectrogramImage(times, rows, yBinsFlat, vMin, vMax, logScaleParam) {
```
And replace `if (logScale)` (line 965) with `if (logScaleParam)`.

**Step 5: Add updateSubplotHeatmapGraphic**

```javascript
function updateSubplotHeatmapGraphic(subplot, img) {
    const gridIdx = subplot._gridIndex;
    const tStartPx = chart.convertToPixel({ xAxisIndex: gridIdx }, img.tStart);
    const tEndPx = chart.convertToPixel({ xAxisIndex: gridIdx }, img.tEnd);
    const yMinPx = chart.convertToPixel({ yAxisIndex: gridIdx }, img.yMin);
    const yMaxPx = chart.convertToPixel({ yAxisIndex: gridIdx }, img.yMax);

    // Append to existing graphics
    const currentGraphic = chart.getOption().graphic || [];
    const newGraphic = {
        type: 'image',
        z: -1,
        style: {
            image: img.canvas,
            x: Math.min(tStartPx, tEndPx),
            y: Math.min(yMinPx, yMaxPx),
            width: Math.abs(tEndPx - tStartPx),
            height: Math.abs(yMaxPx - yMinPx)
        },
        silent: true,
        $action: 'merge'
    };

    chart.setOption({ graphic: [newGraphic] });
}
```

**Step 6: Commit**

```bash
git add speasy_proxy/templates/plot.html
git commit -m "feat: implement multi-grid ECharts rendering with stacked subplots"
```

---

### Task 6: Adapt zoom/pan handlers for multi-subplot

The existing `setupZoomHandler`, `handleWheel`, `onZoomPan` need to work with multiple subplots and their per-product caches.

**Files:**
- Modify: `speasy_proxy/templates/plot.html` (lines 1154-1419 — zoom/pan section)

**Step 1: Implement setupMultiZoomHandler**

```javascript
function setupMultiZoomHandler() {
    chart.off('datazoom');
    chart.on('datazoom', () => {
        if (zoomDebounceTimer) clearTimeout(zoomDebounceTimer);
        zoomDebounceTimer = setTimeout(onMultiZoomPan, 200);
    });

    const chartDom = chart.getDom();
    chartDom.removeEventListener('wheel', handleWheel, true);
    chartDom.addEventListener('wheel', handleWheel, { passive: false, capture: true });

    // Reposition heatmap images on zoom/resize
    chart.off('finished');
    chart.on('finished', () => {
        for (const subplot of plotState.plots) {
            if (subplot.plotType === 'heatmap' && subplot.lastHeatmapImg) {
                updateSubplotHeatmapGraphic(subplot, subplot.lastHeatmapImg);
            }
        }
    });
}
```

**Step 2: Implement onMultiZoomPan**

Replace `onZoomPan` with:
```javascript
async function onMultiZoomPan() {
    if (plotState.plots.length === 0) return;
    if (isFetching) return;

    const view = getVisibleRange();
    if (!view) return;
    currentView.start = view.start;
    currentView.end = view.end;

    // Update plotState time range for share URL
    plotState.time_range.start = new Date(view.start).toISOString();
    plotState.time_range.stop = new Date(view.end).toISOString();
    updateURL();

    const viewRange = view.end - view.start;
    const buffer = viewRange * BUFFER_RATIO;

    // Check each product in each subplot for gaps
    isFetching = true;
    let anyFetched = false;

    for (const subplot of plotState.plots) {
        for (const prod of subplot.products) {
            const cache = subplot.productData[prod.path];
            if (!cache || cache.times.length === 0) continue;

            const cachedStart = cache.times[0];
            const cachedEnd = cache.times[cache.times.length - 1];
            const cachedRange = cachedEnd - cachedStart;

            if (cachedRange > 0 && viewRange / cachedRange < REFETCH_THRESHOLD) {
                // Re-fetch at higher resolution
                showLoading(true);
                setStatus('Re-fetching ' + prod.path + ' at higher resolution...');
                try {
                    const data = await fetchData(prod.path,
                        new Date(view.start - buffer).toISOString(),
                        new Date(view.end + buffer).toISOString());
                    if (data?.values?.axes?.[0]?.values?.length > 0) {
                        resetProductCache(cache);
                        mergeProductData(cache, data, view.start - buffer, view.end + buffer);
                        anyFetched = true;
                    }
                } catch (e) {
                    console.error('Re-fetch error for', prod.path, e);
                }
                continue;
            }

            // Normal gap-based fetching
            const gaps = computeGaps(view.start - buffer, view.end + buffer, cache.intervals);
            for (const gap of gaps) {
                showLoading(true);
                setStatus('Fetching ' + prod.path + '...');
                try {
                    const data = await fetchData(prod.path,
                        new Date(gap[0]).toISOString(), new Date(gap[1]).toISOString());
                    if (data?.values?.axes?.[0]?.values?.length > 0) {
                        mergeProductData(cache, data, gap[0], gap[1]);
                        anyFetched = true;
                    } else {
                        cache.intervals = mergeIntervals(cache.intervals.concat([[gap[0], gap[1]]]));
                    }
                } catch (e) {
                    console.error('Gap fetch error for', prod.path, e);
                }
            }
        }
    }

    if (anyFetched) {
        renderAllSubplots(true);
    }

    showLoading(false);
    setStatus('Ready');
    isFetching = false;
}

function resetProductCache(cache) {
    cache.times = [];
    cache.intervals = [];
    cache.rows = [];
    for (const cn of cache.columnNames) {
        cache.columns[cn] = [];
    }
}
```

**Step 3: Commit**

```bash
git add speasy_proxy/templates/plot.html
git commit -m "feat: adapt zoom/pan handlers for multi-subplot data fetching"
```

---

### Task 7: Clean up — remove dead code and wire everything together

Remove the old single-product rendering functions that are now replaced, ensure all paths work.

**Files:**
- Modify: `speasy_proxy/templates/plot.html`

**Step 1: Remove old functions that are fully replaced**

Remove or mark as unused:
- Old `renderChart()` — replaced by `renderAllSubplots()`
- Old `renderLineChart()` — logic now in `renderAllSubplots()`
- Old `renderHeatmap()` — replaced by `renderSubplotHeatmap()`
- Old `updateHeatmapGraphic()` — replaced by `updateSubplotHeatmapGraphic()`
- Old `updateChartData()` — logic now in `onMultiZoomPan()`
- Old `setupZoomHandler()` — replaced by `setupMultiZoomHandler()`
- Old `onZoomPan()` — replaced by `onMultiZoomPan()`
- Old `cachedData` variable references
- Old `logScale`, `logYAxis`, `plotType`, `lastHeatmapImg` globals

Keep:
- `fetchData()` — unchanged, used by new code
- `mergeSorted()`, `mergeSortedRows()`, `mergeIntervals()` — used by `mergeProductData()`
- `buildSeriesData()` — used by `renderAllSubplots()`
- `renderSpectrogramImage()` — used by `renderSubplotHeatmap()`
- `handleWheel()`, `getVisibleRange()` — used by new zoom handler
- `computeGaps()`, `evictCache()` (adapt to per-product)
- All tree/search/sidebar code — unchanged

**Step 2: Update Log Z / Log Y buttons**

These now need to know which subplot they apply to. For MVP, make them apply to the first subplot:
```javascript
document.getElementById('btn-log-scale').addEventListener('click', () => {
    if (plotState.plots.length === 0) return;
    const sp = plotState.plots[0]; // TODO: target focused subplot
    sp.logScale = !sp.logScale;
    document.getElementById('btn-log-scale').textContent = sp.logScale ? 'Log Z' : 'Linear Z';
    if (sp.plotType === 'heatmap') renderAllSubplots(true);
});
document.getElementById('btn-log-y').addEventListener('click', () => {
    if (plotState.plots.length === 0) return;
    const sp = plotState.plots[0]; // TODO: target focused subplot
    sp.y_axis.log = !sp.y_axis.log;
    document.getElementById('btn-log-y').textContent = sp.y_axis.log ? 'Log Y' : 'Linear Y';
    renderAllSubplots(true);
});
```

**Step 3: Test end-to-end**

1. Open `/plot` — should load empty, sidebar works
2. Select a product, click "Plot" — should render single subplot
3. Select another product, click "Add to plot ▾" → "New subplot" — should stack
4. Select a third product, click "Add to plot ▾" → "Subplot 1: ..." — should overlay
5. Click "Share" — should show URL, copy works
6. Paste the URL in a new tab — should reproduce the plot layout
7. Test old-format URL `?path=amda/c1_b_gsm&start=2020-01-01&stop=2020-01-02` — should redirect to config format
8. Zoom/pan — should sync all subplots

**Step 4: Commit**

```bash
git add speasy_proxy/templates/plot.html
git commit -m "feat: complete multi-plot support — clean up dead code, wire everything together"
```

---

### Task 8: Update the share URL live on zoom/pan

Currently `updateShareURL()` is called in `renderAllSubplots`. Ensure it also updates the time_range in plotState when the user zooms/pans, so the share URL always reflects the current view.

**Files:**
- Modify: `speasy_proxy/templates/plot.html`

**Step 1: Update time range on zoom**

This is already partially done in `onMultiZoomPan` (Task 6, Step 2) where we update `plotState.time_range` and call `updateURL()`. Verify this also updates the share popover if it's open:

In `updateURL()`, add a call to `updateShareURL()`:
```javascript
function updateURL() {
    if (plotState.plots.length === 0) return;
    const config = stateToConfig();
    const encoded = configToBase64(config);
    const newUrl = window.location.pathname + '?config=' + encoded;
    history.replaceState(null, '', newUrl);
    // Also update the share popover if visible
    if (document.getElementById('share-popover').style.display !== 'none') {
        updateShareURL();
    }
}
```

**Step 2: Commit**

```bash
git add speasy_proxy/templates/plot.html
git commit -m "feat: keep share URL in sync with zoom/pan state"
```

---

Plan complete and saved to `docs/plans/2026-03-08-multi-plot-plan.md`. Two execution options:

**1. Subagent-Driven (this session)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** — Open new session with executing-plans, batch execution with checkpoints

Which approach?