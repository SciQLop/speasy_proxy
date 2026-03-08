# Plot Zoom/Pan UX Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix two zoom/pan UX issues in the interactive plot page: browser hijacking Ctrl+scroll during data loading, and undersampled data after zoom-in.

**Architecture:** All changes are in `speasy_proxy/templates/plot.html` (client-side JS/CSS). No backend changes. Fix 1 is a one-line CSS change. Fix 2 modifies the `onZoomPan()` and `updateChartData()` functions to implement a sliding window that re-fetches when the view shrinks below a threshold of the cached range.

**Tech Stack:** HTML/CSS/JavaScript, ECharts 5

**Design doc:** `docs/plans/2026-03-08-plot-zoom-pan-fix-design.md`

---

### Task 1: Fix loading overlay blocking wheel events

**Files:**
- Modify: `speasy_proxy/templates/plot.html:161-169`

**Step 1: Add `pointer-events: none` to the overlay CSS**

In the `.chart-loading-overlay` CSS rule (line 161), add `pointer-events: none;` so wheel events pass through to the chart container underneath.

Change:
```css
.chart-loading-overlay {
    position: absolute;
    inset: 0;
    display: none;
    align-items: center;
    justify-content: center;
    background: rgba(11, 14, 23, 0.75);
    z-index: 10;
}
```

To:
```css
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
```

**Step 2: Manual test**

1. Open `/plot`, select a product, plot it
2. Pan to trigger a data fetch (loading spinner appears)
3. While the spinner is visible, Ctrl+scroll on the chart
4. Expected: chart zooms, browser page zoom does NOT activate
5. Also test pinch-zoom on a touch device or trackpad if available

**Step 3: Commit**

```bash
git add speasy_proxy/templates/plot.html
git commit -m "fix: prevent loading overlay from blocking wheel events"
```

---

### Task 2: Add REFETCH_THRESHOLD constant and sliding window check in onZoomPan

**Files:**
- Modify: `speasy_proxy/templates/plot.html:1167` (constants section)
- Modify: `speasy_proxy/templates/plot.html:1242-1296` (`onZoomPan` function)

**Step 1: Add the REFETCH_THRESHOLD constant**

After line 1167 (`const BUFFER_RATIO = 1.0;`), add:

```javascript
const REFETCH_THRESHOLD = 0.3; // if view < 30% of cached range, re-fetch
```

**Step 2: Add sliding window logic to `onZoomPan()`**

Replace the entire `onZoomPan` function (lines 1242-1296) with:

```javascript
async function onZoomPan() {
    if (!cachedData || cachedData.times.length === 0) return;
    if (isFetching) return;

    const view = getVisibleRange();
    if (!view) return;
    currentView.start = view.start;
    currentView.end = view.end;

    const viewStart = currentView.start;
    const viewEnd = currentView.end;
    const viewRange = viewEnd - viewStart;
    const buffer = viewRange * BUFFER_RATIO;

    // Check if we've zoomed in far enough that cached data is oversampled
    // for the wide range — if so, discard and re-fetch for current view
    const cachedStart = cachedData.times[0];
    const cachedEnd = cachedData.times[cachedData.times.length - 1];
    const cachedRange = cachedEnd - cachedStart;

    if (cachedRange > 0 && viewRange / cachedRange < REFETCH_THRESHOLD) {
        // Sliding window reset: discard cache and re-fetch at current zoom level
        isFetching = true;
        showLoading(true);
        setStatus('Re-fetching at higher resolution...');

        const fetchStart = new Date(viewStart - buffer).toISOString();
        const fetchEnd = new Date(viewEnd + buffer).toISOString();

        try {
            const data = await fetchData(selectedProduct, fetchStart, fetchEnd);
            if (data && data.values && data.axes && data.axes.length > 0 &&
                data.axes[0].values.length > 0) {
                // Reset cache entirely
                cachedData.times = [];
                cachedData.intervals = [];
                if (plotType === 'heatmap') {
                    cachedData.rows = [];
                } else {
                    for (const cn of cachedData.columnNames) {
                        cachedData.columns[cn] = [];
                    }
                }
                mergeData(data, viewStart - buffer, viewEnd + buffer);
                updateChartData(viewStart, viewEnd);
            }
        } catch (e) {
            console.error('Sliding window re-fetch error:', e);
        }

        showLoading(false);
        setStatus('Loaded ' + cachedData.times.length + ' timestamps, ' +
                   cachedData.columnNames.length + ' columns');
        isFetching = false;
        return;
    }

    // Normal gap-based fetching
    const fetchStart = viewStart - buffer;
    const fetchEnd = viewEnd + buffer;

    const gaps = computeGaps(fetchStart, fetchEnd, cachedData.intervals);
    if (gaps.length === 0) return;

    isFetching = true;
    showLoading(true);

    let fetched = false;
    for (const gap of gaps) {
        setStatus('Fetching: ' + new Date(gap[0]).toISOString().slice(0,19) +
                   ' to ' + new Date(gap[1]).toISOString().slice(0,19));
        try {
            const data = await fetchData(selectedProduct,
                new Date(gap[0]).toISOString(), new Date(gap[1]).toISOString());
            if (data && data.values && data.axes && data.axes.length > 0 &&
                data.axes[0].values.length > 0) {
                mergeData(data, gap[0], gap[1]);
                fetched = true;
            } else {
                cachedData.intervals = mergeIntervals(
                    cachedData.intervals.concat([[gap[0], gap[1]]]));
            }
        } catch (e) {
            console.error('Gap fetch error:', e);
        }
    }

    if (fetched) {
        evictCache();
        updateChartData(viewStart, viewEnd);
    }

    showLoading(false);
    setStatus('Loaded ' + cachedData.times.length + ' timestamps, ' +
               cachedData.columnNames.length + ' columns');
    isFetching = false;
}
```

**Step 3: Manual test**

1. Open `/plot`, select a product, plot a wide range (e.g., 1 month)
2. Zoom out further to load more data
3. Now zoom in to ~1 day — view should be well below 30% of cached range
4. Expected: status bar shows "Re-fetching at higher resolution...", then chart redraws with full-resolution data for the narrow view
5. Verify the chart data looks crisp/detailed, not coarsely sampled

**Step 4: Commit**

```bash
git add speasy_proxy/templates/plot.html
git commit -m "feat: sliding window re-fetch when zooming into undersampled data"
```

---

### Task 3: Remove "never shrink" axis range policy from updateChartData

**Files:**
- Modify: `speasy_proxy/templates/plot.html:1298-1341` (`updateChartData` function)

**Step 1: Replace `updateChartData` with buffer-tracking axis range**

Replace the entire `updateChartData` function (lines 1298-1341) with:

```javascript
function updateChartData(viewStart, viewEnd) {
    const times = cachedData.times;
    const viewRange = viewEnd - viewStart;
    const axisBuffer = viewRange * 3;

    // Set axis range based on current buffer — allow it to shrink on re-fetch
    const newMin = Math.min(times[0], viewStart) - axisBuffer;
    const newMax = Math.max(times[times.length - 1], viewEnd) + axisBuffer;

    let series;
    if (plotType === 'heatmap') {
        // Re-render the full heatmap (custom series needs full rebuild)
        renderHeatmap(true);
        return;
    } else {
        series = [];
        for (let c = 0; c < cachedData.columnNames.length; c++) {
            const colName = cachedData.columnNames[c];
            series.push({
                name: colName,
                type: 'line',
                showSymbol: false,
                lineStyle: { width: 1.2 },
                color: CHART_COLORS[c % CHART_COLORS.length],
                data: buildSeriesData(times, cachedData.columns[colName]),
                sampling: 'lttb',
                large: true,
                largeThreshold: 5000
            });
        }
    }

    chart.setOption({
        xAxis: { min: newMin, max: newMax },
        dataZoom: [
            { type: 'inside', startValue: viewStart, endValue: viewEnd },
            { type: 'slider', startValue: viewStart, endValue: viewEnd }
        ],
        series: series
    });
}
```

**Step 2: Manual test**

1. Plot data, zoom out, then zoom back in
2. Verify the axis range contracts to fit the new buffer (no infinite growth)
3. Verify panning still works smoothly — axis extends as you pan, contracts on re-fetch
4. Test with both line plots and spectrograms

**Step 3: Commit**

```bash
git add speasy_proxy/templates/plot.html
git commit -m "fix: axis range tracks buffer instead of growing forever"
```

---

### Task 4: Update strategy comment

**Files:**
- Modify: `speasy_proxy/templates/plot.html:1158-1163`

**Step 1: Update the comment block to reflect the new strategy**

Replace:
```javascript
// ===== Continuous Pan/Zoom =====
//
// Strategy: track the visible time window explicitly (not via dataZoom %).
// On every zoom/pan, ensure we have data covering visible range + 1x buffer
// on each side. The xAxis min/max is set wider than the data so the user
// can always pan further without hitting a wall.
```

With:
```javascript
// ===== Continuous Pan/Zoom =====
//
// Strategy: track the visible time window explicitly (not via dataZoom %).
// On every zoom/pan, ensure we have data covering visible range + 1x buffer
// on each side. When the view shrinks below REFETCH_THRESHOLD of the cached
// range (e.g. after zooming out then back in), discard the cache and re-fetch
// at the current zoom level for full-resolution data.
```

**Step 2: Commit**

```bash
git add speasy_proxy/templates/plot.html
git commit -m "docs: update pan/zoom strategy comment"
```
