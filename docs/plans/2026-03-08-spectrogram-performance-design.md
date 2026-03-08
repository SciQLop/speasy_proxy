# Spectrogram Performance Optimizations — Design

**Date:** 2026-03-08
**File:** `speasy_proxy/templates/plot.html`
**Backend changes:** None

## Problem

Spectrogram rendering is slow due to per-pixel color computation with linear search, unnecessary bitmap re-rendering on zoom/pan, synchronous PNG encoding, and linear time-range scanning.

## Solutions

### 1. Pre-computed color LUT

Replace per-pixel `viridisRGB()` (linear search through 11 color stops) with a 256-entry `Uint8Array` lookup table built once at init. Per-pixel cost drops from a loop + interpolation to a single array index.

### 2. Only re-render bitmap on new data

The `chart.on('finished')` callback currently re-renders the full spectrogram bitmap on every zoom/pan/resize. Change it to only reposition the existing image via `updateHeatmapGraphic`. Bitmap re-rendering only happens when `renderHeatmap` is called with new data.

### 3. Binary search for visible time range

Replace the O(n) linear scan in `renderSpectrogramImage` (finding iStart/iEnd within the visible range) with O(log n) binary search.

### 4. Pass canvas element instead of toDataURL()

`canvas.toDataURL()` does synchronous PNG encode + base64. ECharts' graphic `image` element accepts a canvas element directly — skip encoding entirely.
