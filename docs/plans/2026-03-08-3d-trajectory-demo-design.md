# 3D Trajectory Demo Design

## Goal

A fun demo page that renders satellite trajectories in 3D using ECharts GL, served as a temporary `demo_3d` route.

## Architecture

Self-contained HTML template (`demo_3d.html`) with no new backend data logic. Reuses existing `/get_data` and `/get_inventory` endpoints.

### Backend Changes

- Add `/demo_3d` route in `frontend/home.py` to serve the template.

### Frontend: `templates/demo_3d.html`

**Libraries:**
- ECharts v5 (CDN) + echarts-gl (CDN)

**Layout (dark theme, matching existing plot.html aesthetic):**
- Sidebar:
  - SSCWeb inventory tree (from `/get_inventory?provider=ssc&format=json`)
  - Coordinate system dropdown (GSE, GSM, GEO, SM, GEITOD, GEIJ2000)
  - Start/stop time inputs
  - "Plot" button
  - List of plotted satellites (color swatch + remove button)
- Main area: ECharts `grid3D` with `line3D` series

**Rendering:**
- Earth: `surface3D` parametric sphere at origin, radius = 1 Re
- Trajectories: `line3D` series per satellite, distinct colors
- Axes: X, Y, Z labeled in Re, auto-scaled to data extent
- User can rotate, zoom, pan the 3D scene (built-in ECharts GL behavior)

### Data Flow

```
User selects satellite from SSCWeb tree
  -> sets time range and coordinate system
  -> clicks Plot
  -> GET /get_data?path=ssc/<sat>&coordinate_system=<cs>&format=json&start_time=...&stop_time=...
  -> JS converts km to Re (divide by 6371.0)
  -> adds line3D series to chart
```

Multiple satellites can be plotted simultaneously with distinct colors.

## Non-goals

- No animation/playback (static orbits only)
- No data caching in the frontend beyond current session
- No preset system for the 3D view
