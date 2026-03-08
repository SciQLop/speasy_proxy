# Server-Side Resampling Design

## Goal

Reduce network payload and client-side rendering cost by resampling time-series data on the server. Must not break existing Speasy Python client API.

## API Surface

Two new optional query parameters on `GET /get_data`:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `max_points` | `int \| None` | `None` | Target max points per component. `None` = full resolution |
| `resample` | `str` | `"lttb"` | Strategy: `"lttb"` or `"min_max"` |

- No `max_points` = no resampling (backwards compatible).
- `resample` is ignored when `max_points` is absent.

## Resampling Logic

New module: `speasy_proxy/backend/resample.py`

`resample(var: SpeasyVariable, max_points: int, strategy: str) -> SpeasyVariable`

1. If `len(var) <= max_points`, return unchanged.
2. For each column independently, compute indices to keep:
   - **min_max**: Split into `max_points // 2` buckets. Per bucket per component, keep indices of min and max. Union all indices across components, sort, deduplicate.
   - **lttb**: LTTB per component (~30 lines pure numpy). Union selected indices, sort, deduplicate.
3. Build a new `SpeasyVariable` from original rows at the selected indices.

Output format is identical to unsampled data. Actual point count may exceed `max_points` (up to `max_points * n_components` worst case for min_max) since each component is resampled independently.

## Integration Point

In `get_data`, resample after data fetch and before encoding:

```python
var = await run_in_threadpool(_get_data, ...)

if var is not None and max_points is not None and len(var) > max_points:
    var = await run_in_threadpool(resample, var, max_points, resample_strategy)

result, mime = await run_in_threadpool(_compress_and_encode_output, ...)
```

Replaces the existing `MAX_BOKEH_DATA_LENGTH` hard truncation in `encode_output`.

## Frontend Changes

`fetchData` appends `max_points` based on chart container pixel width:

```javascript
const maxPoints = document.getElementById('chart-container').clientWidth || 2000;
```

Zoom/pan refetch paths use `fetchData`, so they get resampling automatically.
