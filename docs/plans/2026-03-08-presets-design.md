# Plot Presets System

## Goal

Allow server-side JSON preset files that define plot configurations, shown on the homepage (featured) and in the plot sidebar (all).

## Storage

Presets live at a configurable path (`SPEASY_PROXY_PRESETS_PATH` env var, default: `speasy_proxy/presets/`). Two levels:
- `featured/` subdirectory — shown on homepage and plot sidebar
- Root level — shown only in the plot sidebar

Each preset is a standalone `.json` file.

## Preset JSON Schema

```json
{
  "name": "Cluster 1 Magnetic Field",
  "description": "GSM magnetic field components from Cluster 1",
  "version": 1,
  "time_range": {
    "start": "2020-06-15T00:00:00Z",
    "stop": "2020-06-15T12:00:00Z"
  },
  "plots": [
    {
      "products": [{ "path": "amda/c1_b_gsm", "label": "C1 B GSM" }],
      "y_axis": { "log": false },
      "log_z": true
    }
  ]
}
```

Existing config schema plus `name` and optional `description` at the top level.

## Backend

`GET /get_presets` returns all presets as a JSON array. Each entry includes `name`, `description`, `featured` (boolean, derived from directory), and `config` (the plot config object). Presets are loaded once at startup and cached.

## Frontend — Homepage

Featured presets appear as clickable cards in a new section on `index.html`. Each card shows name + description and links to `/plot?config=<base64>`.

## Frontend — Plot sidebar

A collapsible "Presets" section at the top of the sidebar (above the product tree) listing all preset names. Clicking one applies the config.
