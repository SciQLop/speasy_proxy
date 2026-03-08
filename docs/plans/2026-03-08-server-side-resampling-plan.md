# Server-Side Resampling Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add server-side resampling to `get_data` via `max_points` and `resample` query parameters, reducing payload size for visualization without breaking existing Speasy client API.

**Architecture:** New `backend/resample.py` module with two strategies (LTTB, min/max). Resampling is applied in the `get_data` endpoint after fetching data and before encoding, gated by the optional `max_points` parameter. Per-component independent resampling with union of selected indices to preserve the shared time axis format.

**Tech Stack:** numpy (no new dependencies), FastAPI query parameters, SpeasyVariable

---

### Task 1: Resampling module — min_max strategy

**Files:**
- Create: `speasy_proxy/backend/resample.py`
- Create: `speasy_proxy/backend/test_resample.py`

**Step 1: Write the failing tests**

```python
import numpy as np
import pytest
from speasy.products.variable import SpeasyVariable, VariableTimeAxis, DataContainer


def _make_var(n_points, n_cols=1, values=None):
    times = np.arange(n_points).astype('datetime64[s]').astype('datetime64[ns]')
    if values is None:
        values = np.random.default_rng(42).standard_normal((n_points, n_cols))
    axis = VariableTimeAxis(values=times, meta={})
    data = DataContainer(values=values, meta={}, name='test')
    return SpeasyVariable(axes=[axis], values=data)


def test_min_max_reduces_points():
    var = _make_var(10000, n_cols=1)
    result = resample(var, max_points=200, strategy='min_max')
    assert len(result) <= 200
    assert len(result) > 0


def test_min_max_preserves_extremes():
    values = np.zeros((1000, 1))
    values[333, 0] = 100.0  # global max
    values[666, 0] = -100.0  # global min
    var = _make_var(1000, values=values)
    result = resample(var, max_points=100, strategy='min_max')
    assert 100.0 in result.values[:, 0]
    assert -100.0 in result.values[:, 0]


def test_min_max_multi_column_independent():
    values = np.zeros((1000, 3))
    values[100, 0] = 50.0
    values[200, 1] = 60.0
    values[300, 2] = 70.0
    var = _make_var(1000, values=values)
    result = resample(var, max_points=100, strategy='min_max')
    assert 50.0 in result.values[:, 0]
    assert 60.0 in result.values[:, 1]
    assert 70.0 in result.values[:, 2]


def test_no_resample_when_below_threshold():
    var = _make_var(50, n_cols=2)
    result = resample(var, max_points=100, strategy='min_max')
    assert len(result) == 50
    np.testing.assert_array_equal(result.values, var.values)


def test_preserves_time_ordering():
    var = _make_var(5000, n_cols=2)
    result = resample(var, max_points=200, strategy='min_max')
    times = result.time
    assert np.all(times[1:] >= times[:-1])
```

**Step 2: Run tests to verify they fail**

Run: `uv run pytest speasy_proxy/backend/test_resample.py -v`
Expected: FAIL — `resample` not defined

**Step 3: Implement min_max resampling**

```python
import numpy as np
from speasy.products.variable import SpeasyVariable, VariableTimeAxis, DataContainer


def resample(var: SpeasyVariable, max_points: int, strategy: str = 'min_max') -> SpeasyVariable:
    if len(var) <= max_points:
        return var
    strategies = {'min_max': _min_max, 'lttb': _lttb}
    return strategies[strategy](var, max_points)


def _min_max(var: SpeasyVariable, max_points: int) -> SpeasyVariable:
    n = len(var)
    n_buckets = max_points // 2
    n_cols = var.values.shape[1]
    values = np.asarray(var.values)

    indices = set()
    indices.add(0)
    indices.add(n - 1)

    bucket_edges = np.linspace(0, n, n_buckets + 1, dtype=int)
    for col in range(n_cols):
        col_data = values[:, col]
        for i in range(n_buckets):
            start, end = bucket_edges[i], bucket_edges[i + 1]
            if start >= end:
                continue
            bucket = col_data[start:end]
            indices.add(start + int(np.argmin(bucket)))
            indices.add(start + int(np.argmax(bucket)))

    sorted_indices = np.array(sorted(indices))
    return var[sorted_indices]
```

**Step 4: Add import to test file**

Add at top of test file:
```python
from speasy_proxy.backend.resample import resample
```

**Step 5: Run tests to verify they pass**

Run: `uv run pytest speasy_proxy/backend/test_resample.py -v`
Expected: all PASS

**Step 6: Commit**

```bash
git add speasy_proxy/backend/resample.py speasy_proxy/backend/test_resample.py
git commit -m "feat: add min_max resampling strategy for server-side downsampling"
```

---

### Task 2: LTTB strategy

**Files:**
- Modify: `speasy_proxy/backend/resample.py`
- Modify: `speasy_proxy/backend/test_resample.py`

**Step 1: Add failing tests**

```python
def test_lttb_reduces_points():
    var = _make_var(10000, n_cols=1)
    result = resample(var, max_points=200, strategy='lttb')
    assert len(result) <= 200
    assert len(result) > 0


def test_lttb_preserves_endpoints():
    var = _make_var(1000, n_cols=1)
    result = resample(var, max_points=100, strategy='lttb')
    np.testing.assert_equal(result.time[0], var.time[0])
    np.testing.assert_equal(result.time[-1], var.time[-1])


def test_lttb_multi_column():
    values = np.zeros((1000, 2))
    values[500, 0] = 100.0
    values[700, 1] = 100.0
    var = _make_var(1000, values=values)
    result = resample(var, max_points=100, strategy='lttb')
    assert len(result) > 0
    assert len(result) <= 200  # up to max_points * n_cols worst case


def test_invalid_strategy_raises():
    var = _make_var(100, n_cols=1)
    with pytest.raises(KeyError):
        resample(var, max_points=10, strategy='invalid')
```

**Step 2: Run to verify failures**

Run: `uv run pytest speasy_proxy/backend/test_resample.py::test_lttb_reduces_points -v`
Expected: FAIL — `_lttb` raises or is not implemented

**Step 3: Implement LTTB**

Add to `resample.py`:

```python
def _lttb_single(values_1d: np.ndarray, n_out: int) -> np.ndarray:
    n = len(values_1d)
    indices = np.zeros(n_out, dtype=int)
    indices[0] = 0
    indices[n_out - 1] = n - 1

    bucket_size = (n - 2) / (n_out - 2)
    prev_idx = 0

    for i in range(1, n_out - 1):
        bucket_start = int((i - 1) * bucket_size) + 1
        bucket_end = int(i * bucket_size) + 1

        next_bucket_start = int(i * bucket_size) + 1
        next_bucket_end = min(int((i + 1) * bucket_size) + 1, n)
        next_avg = np.mean(values_1d[next_bucket_start:next_bucket_end])

        best_idx = bucket_start
        max_area = -1.0
        prev_val = values_1d[prev_idx]

        for j in range(bucket_start, min(bucket_end, n)):
            area = abs((j - prev_idx) * (next_avg - prev_val) -
                       (values_1d[j] - prev_val) * (next_bucket_start - prev_idx))
            if area > max_area:
                max_area = area
                best_idx = j

        indices[i] = best_idx
        prev_idx = best_idx

    return indices


def _lttb(var: SpeasyVariable, max_points: int) -> SpeasyVariable:
    n_cols = var.values.shape[1]
    values = np.asarray(var.values)
    n_out = max(max_points, 3)

    indices = set()
    for col in range(n_cols):
        col_indices = _lttb_single(values[:, col], n_out)
        indices.update(col_indices.tolist())

    sorted_indices = np.array(sorted(indices))
    return var[sorted_indices]
```

**Step 4: Run tests**

Run: `uv run pytest speasy_proxy/backend/test_resample.py -v`
Expected: all PASS

**Step 5: Commit**

```bash
git add speasy_proxy/backend/resample.py speasy_proxy/backend/test_resample.py
git commit -m "feat: add LTTB resampling strategy"
```

---

### Task 3: Wire into get_data endpoint

**Files:**
- Modify: `speasy_proxy/api/v1/get_data.py`
- Modify: `speasy_proxy/api/v1/query_parameters.py`

**Step 1: Add query parameter types**

In `speasy_proxy/api/v1/query_parameters.py`, add:

```python
MaxPoints = Annotated[Optional[int], Query(None, ge=10, description="Target max points per component. None = full resolution.")]
ResampleStrategy = Annotated[str, Query("lttb", enum=["lttb", "min_max"], description="Resampling strategy.")]
```

Add `from typing import Optional` to imports.

**Step 2: Add parameters and resampling call to get_data**

In `speasy_proxy/api/v1/get_data.py`:

Add import:
```python
from speasy_proxy.backend.resample import resample
from .query_parameters import ZstdCompression, PickleProtocol, DataFormat, MaxPoints, ResampleStrategy
```

Add parameters to `get_data` signature:
```python
max_points: MaxPoints = None,
resample_strategy: ResampleStrategy = "lttb",
```

Add resampling after the `_get_data` try/except block, before encoding:
```python
if var is not None and max_points is not None and len(var) > max_points:
    var = await run_in_threadpool(resample, var, max_points, resample_strategy)
```

**Step 3: Remove MAX_BOKEH_DATA_LENGTH truncation**

In `encode_output`, remove the `MAX_BOKEH_DATA_LENGTH` checks for `html_bokeh` and `json` formats. Replace with direct calls:

```python
elif output_format == 'html_bokeh':
    return plot_data(product=path, data=var,
                     start_time=start_time, stop_time=stop_time,
                     request=request), 'text/html; charset=UTF-8'
elif output_format == 'json':
    return to_json(var), 'application/json; charset=UTF-8'
```

Remove the `MAX_BOKEH_DATA_LENGTH` constant.

**Step 4: Run tests**

Run: `uv run pytest speasy_proxy/ -v`
Expected: all PASS

**Step 5: Commit**

```bash
git add speasy_proxy/api/v1/get_data.py speasy_proxy/api/v1/query_parameters.py
git commit -m "feat: wire max_points and resample_strategy into get_data endpoint"
```

---

### Task 4: Frontend integration

**Files:**
- Modify: `speasy_proxy/templates/plot.html`

**Step 1: Update fetchData to pass max_points**

In the `fetchData` function, add `max_points` to the URL:

```javascript
async function fetchData(product, startTime, stopTime) {
    const startISO = new Date(startTime).toISOString();
    const stopISO = new Date(stopTime).toISOString();
    const maxPoints = document.getElementById('chart-container')?.clientWidth || 2000;
    const url = API_BASE + 'get_data?format=json&path=' +
                encodeURIComponent(product) +
                '&start_time=' + encodeURIComponent(startISO) +
                '&stop_time=' + encodeURIComponent(stopISO) +
                '&max_points=' + maxPoints;
    // ... rest unchanged
}
```

**Step 2: Manual test**

1. Run: `uv run uvicorn speasy_proxy:app --reload`
2. Open the plot page, add a product with lots of data points (e.g. 1-year range of 1-second data)
3. Verify the response payload is small (check Network tab — should be proportional to screen width, not data duration)
4. Verify zoom in triggers refetch with appropriate resolution
5. Verify the plot looks visually correct (peaks preserved)

**Step 3: Commit**

```bash
git add speasy_proxy/templates/plot.html
git commit -m "feat: pass max_points from frontend based on chart width"
```

---

### Task 5: Verify backwards compatibility

**Step 1: Test that no max_points = full resolution**

```bash
uv run python -c "
import speasy as spz
# This should return full resolution data (no resampling)
var = spz.get_data('amda/omni_hro2_1min_b_gsm', '2025-01-01', '2025-01-02')
print('Points:', len(var))
print('Shape:', var.values.shape)
"
```

Expected: full resolution (1440 points for 1-min data over 1 day)

**Step 2: Test with max_points via direct HTTP**

```bash
uv run python -c "
import requests
resp = requests.get('http://127.0.0.1:8000/get_data', params={
    'format': 'json',
    'path': 'amda/omni_hro2_1min_b_gsm',
    'start_time': '2025-01-01',
    'stop_time': '2025-01-02',
    'max_points': 200,
    'resample_strategy': 'min_max',
})
import json
data = json.loads(resp.text.replace('NaN', 'null'))
print('Points:', len(data['axes'][0]['values']))
print('Status:', resp.status_code)
"
```

Expected: ~200-600 points (depends on component overlap), status 200
