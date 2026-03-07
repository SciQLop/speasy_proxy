# Interactive Plot Page Design

## Overview

A new `/plot` route serving a standalone single-page plotting interface. Users browse the inventory tree, select a product, pick a time range, and get a reactive ECharts plot with smart data fetching on zoom/pan.

## Decisions

- **Plotting library:** ECharts (via CDN) — good performance with large datasets, supports heatmaps for future spectrogram support, ~800KB tree-shakeable
- **No build step:** vanilla JS inline in a Jinja2 template, consistent with existing `index.html`
- **Separate page:** `/plot` route, linked from home page. Status dashboard stays untouched.

## Architecture

### Frontend Components

1. **Inventory browser** (left sidebar)
   - Searchable tree view built from `get_inventory?format=json&provider=all`
   - Expandable hierarchy: provider > mission > instrument > product
   - Search bar at top filters the tree in real-time
   - Clicking a leaf product populates the product path

2. **Controls bar** (top area)
   - Product path display (read-only, filled by tree selection)
   - Two datetime inputs (start/stop)
   - "Plot" button to trigger initial load

3. **Plot area** (main content)
   - ECharts instance with `dataZoom` (slider + inside scroll/drag)
   - Line plots for vector data (one series per component)
   - Debounced fetch on zoom/pan beyond loaded range

### Data Flow

1. Page loads → fetch inventory from `/get_inventory?format=json&provider=all`
2. User selects product + time range → fetch from `/get_data?format=json&path=...&start_time=...&stop_time=...`
3. User zooms/pans → debounced (300ms) check: if view extends beyond cached range, fetch missing data, merge into local cache, update chart

### Client-Side Cache Strategy

- Store fetched data as sorted arrays keyed by product path
- Track covered time intervals as a list of `[start, end]` ranges
- On new view: compute gaps between cached ranges and visible range, fetch only gaps
- Merge new data into sorted array
- Cap cache size (~500k points) — evict ranges furthest from current view

### URL State

- Encode product/start/stop in query params: `/plot?path=amda/c1_b_gsm&start=...&stop=...`
- Shareable/bookmarkable plot URLs
- On page load, if params present, auto-plot

## File Changes

- **New:** `speasy_proxy/templates/plot.html`
- **Edit:** `speasy_proxy/frontend/home.py` — add `/plot` route
- **Edit:** `speasy_proxy/templates/index.html` — add "Plot" button link

## Out of Scope

- Spectrograms (future work using ECharts heatmaps)
- Multiple products on one plot
- Metadata panel
- Collaboration features
