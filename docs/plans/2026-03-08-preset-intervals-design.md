# Preset Time Intervals (Vertical Spans)

## Goal

Add support for vertical transparent time-interval spans in preset plots. Intervals are global (appear on all subplots) and defined once at the preset level.

## Preset JSON Schema Addition

Top-level `intervals` array (optional):

```json
{
  "intervals": [
    {
      "start": "2025-01-15T06:00:00Z",
      "stop": "2025-01-15T12:00:00Z",
      "color": "rgba(255, 100, 100, 0.15)",
      "label": "Storm main phase"
    }
  ]
}
```

- `start`, `stop` — ISO 8601 timestamps (required)
- `color` — CSS color string (optional, default: `"rgba(100, 140, 255, 0.12)"`)
- `label` — tooltip text on hover (optional)

## Implementation

### 1. `applyConfig()` in plot.html

Store `config.intervals` (or `[]`) into `plotState.intervals`.

### 2. `buildOption()` in plot.html

For each subplot, inject `markArea` into the first series:

```js
series[0].markArea = {
    silent: false,
    data: plotState.intervals.map(iv => [{
        xAxis: iv.start,
        itemStyle: { color: iv.color || 'rgba(100, 140, 255, 0.12)' },
        name: iv.label || ''
    }, {
        xAxis: iv.stop
    }]),
    tooltip: { show: true }
};
```

### 3. No backend changes

The preset loader already passes through all keys in the config object.

## Files Modified

- `speasy_proxy/templates/plot.html` — `applyConfig()` and `buildOption()`
- Preset JSON files (to add example intervals if desired)
