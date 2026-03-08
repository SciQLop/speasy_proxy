# Plot Zoom/Pan UX Fix — Design

**Date:** 2026-03-08
**File:** `speasy_proxy/templates/plot.html`
**Backend changes:** None

## Problems

### 1. Browser hijacks Ctrl+Scroll during data loading

When data is loading, the `.chart-loading-overlay` div covers the chart (`position: absolute; inset: 0; z-index: 10`). Wheel events hit the overlay instead of the chart container, so the custom `handleWheel` listener never fires and `preventDefault()` never runs. The browser sees unhandled Ctrl+wheel and performs page zoom.

### 2. Undersampled data after zoom-in

Data is fetched at full resolution and accumulated in cache. The axis range only grows ("never shrink"). ECharts' LTTB sampling operates on the full cached range, so after zooming out to a wide range and then zooming back in, the data appears undersampled — LTTB chose representative points for the large range, not the small visible window.

## Solutions

### Fix 1: Loading overlay — `pointer-events: none`

Add `pointer-events: none` to `.chart-loading-overlay` CSS. The overlay remains visually visible (spinner + dimming) but transparent to mouse/wheel events, allowing `handleWheel` on the chart container to fire and call `preventDefault()` as intended.

### Fix 2: Sliding window re-fetch on zoom-in

Track the ratio of visible range to cached range. When the view shrinks below a threshold relative to the cache, discard the cache and re-fetch centered on the current view.

**Behavior:**
- After each zoom/pan, compute `viewRange / cachedRange`
- If this ratio falls below `REFETCH_THRESHOLD` (0.3), trigger a reset:
  - Clear cached data
  - Re-fetch data for `[viewStart - viewRange * BUFFER_RATIO, viewEnd + viewRange * BUFFER_RATIO]`
  - Rebuild the chart with the new data
- The axis range tracks the buffer extent instead of growing forever (remove "never shrink" policy)

**Constants:**
- `BUFFER_RATIO = 1.0` — pre-fetch 1x view width on each side (unchanged)
- `REFETCH_THRESHOLD = 0.3` — if view < 30% of cached range, reset and re-fetch

**Changes to existing functions:**
- `onZoomPan()` — add ratio check before gap-based fetching; on threshold breach, clear cache and re-fetch
- `updateChartData()` — remove "never shrink axis range" logic; set axis min/max based on current buffer extent
- Add `REFETCH_THRESHOLD = 0.3` constant
