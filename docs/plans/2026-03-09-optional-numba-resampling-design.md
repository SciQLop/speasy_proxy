# Optional Numba Acceleration for Resampling

## Problem

Resampling code (`_min_max`, `_lttb_single`) uses Python loops over numpy arrays.
At millions of points, these loops become the bottleneck. Numba can JIT-compile
them to native code for 10-100x speedup, but shouldn't be a hard dependency.

## Design

### Dual backend with fallback dispatch

```
speasy_proxy/backend/
    resample.py          # public API + dispatch
    _resample_numpy.py   # pure NumPy implementations
    _resample_numba.py   # @njit implementations
```

`resample.py` tries to import the Numba backend; falls back to NumPy:

```python
try:
    from ._resample_numba import min_max, lttb_single
except ImportError:
    from ._resample_numpy import min_max, lttb_single
```

### Algorithm implementations

**min_max:**
- NumPy: vectorized `reshape` + `argmin`/`argmax` along axis (no Python loop)
- Numba: `@njit` loop over buckets and columns on raw arrays

**LTTB:**
- NumPy: outer loop over buckets (unavoidable sequential dependency), vectorized inner bucket scan
- Numba: `@njit` on the entire `_lttb_single` function

### Packaging

- `pyproject.toml`: add `fast = ["numba"]` under `[project.optional-dependencies]`
- `docker/Dockerfile`: install with `uv sync --no-dev --extra fast`

### Testing

- Parametrize existing tests to run against both backends explicitly
- Add a test verifying both backends produce identical results for same input
