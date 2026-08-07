# Frontend Review — Plot UI & Orbit Viewer

**Date:** 2026-08-07  
**Scope:** `plot.html`, `plot.js`, `plot-core.js`, `spectrogram.js`, `demo_3d.html`, `demo3d.js`, `magnetosphere.js`, `common.js`, `inventory-tree.js`, `theme.css`

---

## Plot UI

### Bugs

| # | Location | Issue |
|---|----------|-------|
| 1 | `plot.js:562` | **Share URL drops `base_url` prefix** — `window.location.origin + pathname` is wrong behind a reverse proxy with `SPEASY_PROXY_PREFIX`. |
| 2 | `plot.js:1402` | **`applyWheelView` padding is 5× the view** — `(next.end - next.start) * 2` on each side makes data look tiny. `AXIS_PAD_RATIO` (0.5) exists but isn't used here. |
| 3 | `spectrogram.js:87-89` | **Unbounded canvas width** — `canvas.width = nTime` for a 50k-point spectrogram creates a 50k-pixel-wide canvas (browser limit ~16k–32k). Should cap and `drawImage`-scale. |
| 4 | `plot.js:1017-1029` | **vMin/vMax scans entire cache** — O(n×m) over all rows even when only a slice is visible. Should scope to the render window. |
| 5 | `plot.js:162-168` | **Default date window is 1 day** — "stop − 2 months, then 1 day earlier" gives a 1-day window, which is almost never useful. |

### UX

| # | Proposal |
|---|----------|
| 6 | **No per-product removal** — can only nuke whole subplots. Add a ✕ per product in the "Add to plot" dropdown. |
| 7 | **No "Now" / quick-now button** — for recent data, users manually pick dates. Add a "Now" chip that sets stop = current time. |
| 8 | **No per-product loading spinner** — the global overlay covers the whole chart. Add a spinner badge on the tree node or subplot title. |
| 9 | **"Log Z" / "Log Y" button labels are ambiguous** — inconsistent about showing current state vs. action. Unify convention. |
| 10 | **CSV export silently skips heatmaps** — status says "Exported N products" but heatmaps are excluded without warning. |
| 11 | **No keyboard shortcut for "Add to plot"** — only "Plot" has Enter. |

### Performance

| # | Proposal |
|---|----------|
| 12 | **Spectrogram canvas capping** — cap `canvas.width` to ~4096 and scale via `drawImage`. Huge perf + memory win. |
| 13 | **`buildSeriesData` allocates `[t, v]` pairs** — for 50k points that's 100k elements. Allocation churn on every render adds up. |
| 14 | **`renderAllSubplots` rebuilds the full option object even for `dataOnly`** — grids/xAxes/yAxes recreated pointlessly. |

### Cleanup

| # | Proposal |
|---|----------|
| 15 | **`plot.js` is 1761 lines** — split into `plot-ui.js` (DOM/controls), `plot-render.js` (ECharts option building). |
| 16 | **Inconsistent indentation** — some blocks have extra 2-space indent (e.g. `apiFetchData` calls at line 502). |
| 17 | **`CHART_COLORS` duplicated** across `plot.js` and `demo3d.js`. Extract to shared module. |

---

## Orbit Viewer

### Bugs

| # | Location | Issue |
|---|----------|-------|
| 1 | `demo3d.js:71-80` | **Earth texture: per-vertex color callback** — `sampleEarthColor` runs on every frame for all 64,800 surface vertices. This is the #1 perf killer. Pre-compute a canvas texture once and use `itemStyle.texture`. |
| 2 | `demo3d.js:800-810` | **`applyPendingUids` fires N parallel fetches** — restoring a URL with many satellites hammers the server. Should serialize or limit concurrency. |
| 3 | `demo3d.js:528-578` | **`replotAll` has no concurrency limit** — same issue on coord-sys change. |
| 4 | `demo3d.js:614-617` | **"Reset" view doesn't reset axis range** — only resets alpha/beta/distance, not the data-derived axis bounds. |

### UX

| # | Proposal |
|---|----------|
| 5 | **No "Clear all" button** — users must uncheck each satellite individually. Add a "Clear" button. |
| 6 | **No PNG export** — the plot page has it, the orbit viewer doesn't. |
| 7 | **No tooltip / cursor readout** — can't see satellite position (Re coordinates) at cursor. Add a zrender mousemove handler showing nearest point. |
| 8 | **Duration buttons don't sync with manual edits** — if the user changes start/stop manually, the active duration button stays highlighted despite no longer matching. |
| 9 | **No trajectory legend** — colors are auto-assigned but there's no legend mapping color → satellite name. |
| 10 | **No loading progress** — "Fetching X..." but no "3/5 satellites loaded" indicator. |

### Performance

| # | Proposal |
|---|----------|
| 11 | **Earth texture** — pre-compute a 2D canvas texture from the image data, use it as `parametricEquation` texture map instead of per-vertex callback. Massive frame-rate improvement. |
| 12 | **`reclassifyAllTrajectories` on every slider tick** — debounced to 500ms but still iterates all points. Could defer to render time or use a Web Worker for large datasets. |
| 13 | **`updateChartOption` rebuilds everything** — Earth + trajectories don't change on Dp/Bz change. Only magnetopause/bow shock + region colors do. Use targeted `setOption`. |

### Cleanup

| # | Proposal |
|---|----------|
| 14 | **`demo3d.js` is 849 lines** — split into `orbit-ui.js`, `orbit-chart.js`. |
| 15 | **`METADATA_KEYS` duplicates `SKIP_KEYS`** — consolidate into `inventory-tree.js`. |
| 16 | **`COLORS` / `REGION_COLORS` duplicated** — extract to shared module. |
| 17 | **`isMetadataKey` wraps `isSpzMetaKey`** — the wrapping is thin enough to inline or unify. |

---

## Cross-cutting

| # | Proposal |
|---|----------|
| 1 | **CSS divergence** — both templates have nearly identical `.sidebar`, `.controls-bar`, `.status-bar` rules inline. Unify into `theme.css` to stop drift. |
| 2 | **No error boundary** — an uncaught exception leaves the UI broken with no recovery. Add `window.onerror` → "Something went wrong, reload". |
| 3 | **`format.js` unused by viewers** — only `home.js` uses it. Both viewers re-implement number formatting inline (`toPrecision(4)`). |

---

## Completed Fixes

| # | Item | Status | Details |
|---|------|--------|---------|
| 1 | Earth texture perf | **Done** | Replaced per-vertex `sampleEarthColor` callback with pre-computed `earthTextureCanvas` used as `itemStyle.texture`. Work moves from every-frame to load-time. |
| 2 | Spectrogram canvas capping | **Done** | Added `MAX_SPECTROGRAM_CANVAS_WIDTH = 4096`; columns decimated when slice exceeds cap. 5 new tests added. |
| 3 | Share URL `base_url` fix | **Done** | `updateShareURL` now uses `BASE_URL` instead of `window.location.origin`. |
| 4 | Clear all + PNG export | **Done** | Added `btn-clear` and `btn-export-png` to orbit viewer controls bar with `clearAllTrajectories` and `exportPng` functions. Buttons auto-show/hide based on trajectory count. |

**Test status:** 106 JS tests pass (101 original + 5 new), 122 Python tests pass. No regressions.

## Deferred

| # | Item | Reason |
|---|------|--------|
| 5 | CSS unification | `body`, `.main`, `.status-bar` rules have diverged between templates (different padding, colors, `position: relative`, `height: 100dvh`). Needs careful side-by-side visual pass to avoid regressions. |

## Remaining Open Items

### Plot UI Bugs
- [ ] #2 `applyWheelView` padding 5× the view (`plot.js:1402`)
- [ ] #4 vMin/vMax scans entire cache (`plot.js:1017`)
- [ ] #5 Default date window is 1 day (`plot.js:162`)

### Plot UI UX
- [ ] #6 No per-product removal from subplot
- [ ] #7 No "Now" button for time selection
- [ ] #8 No per-product loading spinner
- [ ] #9 "Log Z"/"Log Y" button label ambiguity
- [ ] #10 CSV export silently skips heatmaps
- [ ] #11 No keyboard shortcut for "Add to plot"

### Plot UI Performance
- [ ] #13 `buildSeriesData` allocation churn
- [ ] #14 `renderAllSubplots` rebuilds full option on `dataOnly`

### Plot UI Cleanup
- [ ] #15 Split `plot.js` (1761 lines)
- [ ] #16 Inconsistent indentation
- [ ] #17 `CHART_COLORS` duplication

### Orbit Viewer Bugs
- [ ] #2 `applyPendingUids` fires N parallel fetches
- [ ] #3 `replotAll` no concurrency limit
- [ ] #4 "Reset" view doesn't reset axis range

### Orbit Viewer UX
- [ ] #7 No tooltip / cursor readout
- [ ] #8 Duration buttons don't sync with manual edits
- [ ] #9 No trajectory legend
- [ ] #10 No loading progress indicator

### Orbit Viewer Performance
- [ ] #12 `reclassifyAllTrajectories` on every slider tick
- [ ] #13 `updateChartOption` rebuilds everything on Dp/Bz change

### Orbit Viewer Cleanup
- [ ] #14 Split `demo3d.js` (872 lines)
- [ ] #15 `METADATA_KEYS` duplicates `SKIP_KEYS`
- [ ] #16 `COLORS`/`REGION_COLORS` duplication
- [ ] #17 `isMetadataKey` thin wrapper

### Cross-cutting
- [ ] #2 No error boundary
- [ ] #3 `format.js` unused by viewers
