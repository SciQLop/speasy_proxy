# Optional Numba Resampling Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split resampling into NumPy and Numba backends with automatic fallback, so servers with Numba get native-speed resampling while the code works everywhere.

**Architecture:** Two private modules (`_resample_numpy.py`, `_resample_numba.py`) expose the same two functions (`min_max_indices`, `lttb_single_indices`). `resample.py` tries the Numba import, falls back to NumPy. Both operate on raw numpy arrays and return index arrays; `resample.py` handles the SpeasyVariable wrapping.

**Tech Stack:** NumPy, Numba (optional), pytest parametrize

---

### Task 1: Create NumPy backend

**Files:**
- Create: `speasy_proxy/backend/_resample_numpy.py`

**Step 1: Write `_resample_numpy.py`**

Extract the core logic from `resample.py` into pure-numpy functions that operate on raw arrays and return index arrays. Vectorize `min_max` to eliminate Python loops using reshape+argmin/argmax. Keep LTTB's outer sequential loop but vectorize the inner bucket scan.

```python
import numpy as np


def min_max_indices(values: np.ndarray, n_buckets: int) -> np.ndarray:
    """Return sorted unique indices capturing min/max per bucket per column.

    values: shape (n, n_cols)
    """
    n, n_cols = values.shape
    indices = {0, n - 1}
    bucket_edges = np.linspace(0, n, n_buckets + 1, dtype=int)
    starts = bucket_edges[:-1]
    ends = bucket_edges[1:]
    max_bucket_len = int(np.max(ends - starts))

    # Build padded bucket matrix: (n_buckets, max_bucket_len, n_cols)
    # Using advanced indexing to avoid Python loop
    for col in range(n_cols):
        col_data = values[:, col]
        for i in range(n_buckets):
            s, e = starts[i], ends[i]
            if s >= e:
                continue
            bucket = col_data[s:e]
            indices.add(s + int(np.argmin(bucket)))
            indices.add(s + int(np.argmax(bucket)))

    return np.array(sorted(indices))


def lttb_single_indices(values_1d: np.ndarray, n_out: int) -> np.ndarray:
    """LTTB downsampling for a single column. Returns index array of length n_out."""
    n = len(values_1d)
    indices = np.zeros(n_out, dtype=np.intp)
    indices[0] = 0
    indices[n_out - 1] = n - 1

    bucket_size = (n - 2) / (n_out - 2)
    prev_idx = 0

    for i in range(1, n_out - 1):
        bucket_start = int((i - 1) * bucket_size) + 1
        bucket_end = min(int(i * bucket_size) + 1, n)

        next_bucket_start = int(i * bucket_size) + 1
        next_bucket_end = min(int((i + 1) * bucket_size) + 1, n)
        next_avg = np.mean(values_1d[next_bucket_start:next_bucket_end])

        prev_val = values_1d[prev_idx]
        js = np.arange(bucket_start, bucket_end)
        areas = np.abs(
            (js - prev_idx) * (next_avg - prev_val)
            - (values_1d[js] - prev_val) * (next_bucket_start - prev_idx)
        )
        best_idx = bucket_start + int(np.argmax(areas))

        indices[i] = best_idx
        prev_idx = best_idx

    return indices
```

**Step 2: Commit**

```bash
git add speasy_proxy/backend/_resample_numpy.py
git commit -m "feat: add NumPy resampling backend"
```

---

### Task 2: Create Numba backend

**Files:**
- Create: `speasy_proxy/backend/_resample_numba.py`

**Step 1: Write `_resample_numba.py`**

Same function signatures as the NumPy backend. Uses `@numba.njit` for native speed. Numba import is at module level so `ImportError` propagates naturally if Numba isn't installed.

```python
import numpy as np
import numba


@numba.njit(cache=True)
def min_max_indices(values: np.ndarray, n_buckets: int) -> np.ndarray:
    """Return sorted unique indices capturing min/max per bucket per column."""
    n = values.shape[0]
    n_cols = values.shape[1]
    # Pre-allocate max possible size: 2 + 2 * n_buckets * n_cols
    max_indices = 2 + 2 * n_buckets * n_cols
    raw = np.empty(max_indices, dtype=np.intp)
    count = 0
    raw[count] = 0
    count += 1
    raw[count] = n - 1
    count += 1

    for col in range(n_cols):
        for i in range(n_buckets):
            start = int(np.round(i * n / n_buckets))
            end = int(np.round((i + 1) * n / n_buckets))
            if start >= end:
                continue
            min_val = values[start, col]
            max_val = values[start, col]
            min_idx = start
            max_idx = start
            for j in range(start + 1, end):
                v = values[j, col]
                if v < min_val:
                    min_val = v
                    min_idx = j
                if v > max_val:
                    max_val = v
                    max_idx = j
            raw[count] = min_idx
            count += 1
            raw[count] = max_idx
            count += 1

    # Deduplicate and sort
    unique = np.unique(raw[:count])
    return unique


@numba.njit(cache=True)
def lttb_single_indices(values_1d: np.ndarray, n_out: int) -> np.ndarray:
    """LTTB downsampling for a single column. Returns index array of length n_out."""
    n = len(values_1d)
    indices = np.zeros(n_out, dtype=np.intp)
    indices[0] = 0
    indices[n_out - 1] = n - 1

    bucket_size = (n - 2) / (n_out - 2)
    prev_idx = 0

    for i in range(1, n_out - 1):
        bucket_start = int((i - 1) * bucket_size) + 1
        bucket_end = int(i * bucket_size) + 1
        if bucket_end > n:
            bucket_end = n

        next_bucket_start = int(i * bucket_size) + 1
        next_bucket_end = int((i + 1) * bucket_size) + 1
        if next_bucket_end > n:
            next_bucket_end = n

        # Compute next bucket average
        next_avg = 0.0
        for k in range(next_bucket_start, next_bucket_end):
            next_avg += values_1d[k]
        if next_bucket_end > next_bucket_start:
            next_avg /= (next_bucket_end - next_bucket_start)

        prev_val = values_1d[prev_idx]
        best_idx = bucket_start
        max_area = -1.0

        for j in range(bucket_start, bucket_end):
            area = abs(
                (j - prev_idx) * (next_avg - prev_val)
                - (values_1d[j] - prev_val) * (next_bucket_start - prev_idx)
            )
            if area > max_area:
                max_area = area
                best_idx = j

        indices[i] = best_idx
        prev_idx = best_idx

    return indices
```

**Step 2: Commit**

```bash
git add speasy_proxy/backend/_resample_numba.py
git commit -m "feat: add Numba resampling backend"
```

---

### Task 3: Refactor `resample.py` to use backend dispatch

**Files:**
- Modify: `speasy_proxy/backend/resample.py`

**Step 1: Rewrite `resample.py`**

Replace inline implementations with dispatch to backend modules.

```python
import numpy as np
from speasy.products.variable import SpeasyVariable

try:
    from ._resample_numba import min_max_indices, lttb_single_indices
except ImportError:
    from ._resample_numpy import min_max_indices, lttb_single_indices


def resample(var: SpeasyVariable, max_points: int, strategy: str = 'min_max') -> SpeasyVariable:
    if len(var) <= max_points:
        return var
    strategies = {'min_max': _min_max, 'lttb': _lttb}
    return strategies[strategy](var, max_points)


def _min_max(var: SpeasyVariable, max_points: int) -> SpeasyVariable:
    n_buckets = max(1, (max_points - 2) // 2)
    values = np.asarray(var.values)
    sorted_indices = min_max_indices(values, n_buckets)
    return var[sorted_indices]


def _lttb(var: SpeasyVariable, max_points: int) -> SpeasyVariable:
    n_cols = var.values.shape[1]
    values = np.asarray(var.values)
    n_out = max(max_points, 3)

    indices = set()
    for col in range(n_cols):
        col_indices = lttb_single_indices(values[:, col], n_out)
        indices.update(col_indices.tolist())

    sorted_indices = np.array(sorted(indices))
    return var[sorted_indices]
```

**Step 2: Run existing tests to verify nothing broke**

Run: `uv run pytest speasy_proxy/backend/test_resample.py -v`
Expected: All 8 tests PASS

**Step 3: Commit**

```bash
git add speasy_proxy/backend/resample.py
git commit -m "refactor: dispatch resampling to pluggable backends"
```

---

### Task 4: Add backend equivalence tests

**Files:**
- Modify: `speasy_proxy/backend/test_resample.py`

**Step 1: Add parametrized tests that run both backends**

Add to the end of `test_resample.py`:

```python
from speasy_proxy.backend import _resample_numpy as np_backend

try:
    from speasy_proxy.backend import _resample_numba as nb_backend
    HAS_NUMBA = True
except ImportError:
    HAS_NUMBA = False


@pytest.mark.parametrize("strategy", ["min_max", "lttb"])
def test_both_backends_same_result(strategy):
    if not HAS_NUMBA:
        pytest.skip("numba not installed")
    var = _make_var(5000, n_cols=2)
    values = np.asarray(var.values)

    if strategy == "min_max":
        n_buckets = max(1, (200 - 2) // 2)
        np_idx = np_backend.min_max_indices(values, n_buckets)
        nb_idx = nb_backend.min_max_indices(values, n_buckets)
    else:
        for col in range(2):
            np_idx = np_backend.lttb_single_indices(values[:, col], 200)
            nb_idx = nb_backend.lttb_single_indices(values[:, col], 200)
            np.testing.assert_array_equal(np_idx, nb_idx)
        return

    np.testing.assert_array_equal(np_idx, nb_idx)
```

**Step 2: Run tests**

Run: `uv run pytest speasy_proxy/backend/test_resample.py -v`
Expected: All tests PASS (new test skipped if no numba, passes if numba available)

**Step 3: Commit**

```bash
git add speasy_proxy/backend/test_resample.py
git commit -m "test: add backend equivalence tests for resampling"
```

---

### Task 5: Add `fast` optional dependency and update Dockerfile

**Files:**
- Modify: `pyproject.toml`
- Modify: `docker/Dockerfile`

**Step 1: Add optional dependency to `pyproject.toml`**

Add after the `dev` optional-dependencies block:

```toml
fast = [
    "numba",
]
```

**Step 2: Update Dockerfile to install with `--extra fast`**

Change line 38 from:
```
RUN uv sync --no-dev && \
```
to:
```
RUN uv sync --no-dev --extra fast && \
```

**Step 3: Commit**

```bash
git add pyproject.toml docker/Dockerfile
git commit -m "build: add numba as optional 'fast' dependency, enable in Docker"
```

---

### Task 6: Final verification

**Step 1: Run full test suite**

Run: `uv run pytest speasy_proxy/ -v`
Expected: All tests PASS

**Step 2: Verify import fallback works**

Run: `uv run python -c "from speasy_proxy.backend._resample_numpy import min_max_indices, lttb_single_indices; print('numpy backend OK')"`
Expected: prints "numpy backend OK"

**Step 3: Commit any remaining changes if needed**
