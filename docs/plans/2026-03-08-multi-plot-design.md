# Multi-Plot with Shareable Config URLs

## Goal

Extend the ECharts-based plot UI to support multiple products displayed as overlaid series or stacked subplots with a shared time axis. Plot configurations are encoded as a JSON object in the URL, enabling SciQLop to generate shareable links that reproduce its plot panel in the proxy.

## JSON Config Schema (v1)

```json
{
  "version": 1,
  "time_range": {
    "start": "2020-01-01T00:00:00Z",
    "stop": "2020-01-02T00:00:00Z"
  },
  "plots": [
    {
      "products": [
        { "path": "amda/c1_b_gsm", "label": "C1 B GSM" }
      ],
      "y_axis": { "log": false, "label": "B (nT)" }
    },
    {
      "products": [
        { "path": "amda/c1_n", "label": "C1 density" },
        { "path": "amda/c3_n", "label": "C3 density" }
      ],
      "y_axis": { "log": true }
    }
  ]
}
```

The config is base64url-encoded in the URL: `/plot?config=eyJ2ZXJzaW9uIjoxLC...`

The schema is versioned for forward compatibility. Future versions may add:
- Per-series colors and line styles
- Z-axis / colormap settings for spectrograms
- Catalog event spans (time intervals overlaid on plots)
- Axis min/max ranges
- Per-product coordinate system or method overrides

## URL Handling

Old `?path=&start=&stop=` URLs are redirected to their `?config=` equivalent (single-product config).

## UI Changes

### Controls bar

- **"Plot" button** (existing): replaces the entire view with the selected product as a single subplot.
- **"Add to plot" button + dropdown** (new): dropdown lists "New subplot" and existing subplots labeled by their first product name (e.g., "Subplot 1: c1_b_gsm"). Adds the selected product to the chosen target.
- **"Share" button** (new): opens a popover with the live-updating config URL and a copy-to-clipboard button. URL updates in real time as the user modifies the plot (add/remove products, zoom, change axis settings).

### Chart area

- Vertically stacked subplots within a single ECharts instance using multiple `grid`, `xAxis`, `yAxis` entries.
- All subplots share the same X (time) axis — zoom/pan on one syncs all others via shared `dataZoom` components.
- Each subplot has an independent Y axis with its own log/linear toggle.

## Architecture

### Client-side only

No backend API changes required. The frontend already fetches data via `GET /get_data?path=...&start_time=...&stop_time=...&format=json`. Multi-plot means multiple parallel fetches.

### State management

A JS object mirroring the JSON config schema is the single source of truth. Any mutation (add product, change axis, zoom/pan) updates this state, which triggers:
1. Chart re-render
2. Share URL update

### ECharts layout

Single ECharts instance with N `grid` components stacked vertically. Each grid has its own `xAxis`/`yAxis` pair. A shared `dataZoom` component links all X axes for synchronized zoom/pan.

### Data caching

Extend the existing cache to be keyed per product path. Each product gets its own loaded-intervals tracker and independent fetch lifecycle.

### Reuse

- Product tree / sidebar: unchanged
- Data fetching logic: reused per product
- Line chart and spectrogram rendering: reused per subplot
- Status bar: unchanged

## Out of scope (future work)

- Drag & drop products onto subplots
- Per-series color/style customization
- Catalog event span overlays
- Axis range locking
