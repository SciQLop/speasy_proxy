import math

import numba
import numpy as np


@numba.njit(cache=True)
def min_max_slots(buckets: np.ndarray, values: np.ndarray, n_buckets: int) -> np.ndarray:
    """Per time bucket and column, the rows of its two extremes in time order:
    slots[b, c] = [earlier, later], [-1, -1] where the bucket has no value. `buckets`
    holds each row's bucket, non-decreasing. Ties keep the first row, as numpy does."""
    n, n_cols = values.shape
    mins = np.full((n_buckets, n_cols), -1, dtype=np.int64)
    maxs = np.full((n_buckets, n_cols), -1, dtype=np.int64)
    for j in range(n):
        b = buckets[j]
        for col in range(n_cols):
            v = values[j, col]
            if math.isnan(v):
                continue
            if mins[b, col] < 0 or v < values[mins[b, col], col]:
                mins[b, col] = j
            if maxs[b, col] < 0 or v > values[maxs[b, col], col]:
                maxs[b, col] = j
    slots = np.empty((n_buckets, n_cols, 2), dtype=np.int64)
    for b in range(n_buckets):
        for col in range(n_cols):
            slots[b, col, 0] = min(mins[b, col], maxs[b, col])
            slots[b, col, 1] = max(mins[b, col], maxs[b, col])
    return slots


@numba.njit(cache=True)
def lttb_single_indices(values_1d: np.ndarray, n_out: int) -> np.ndarray:
    """Largest Triangle Three Buckets for a single 1D column."""
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

        next_sum = 0.0
        next_count = 0
        for k in range(next_bucket_start, next_bucket_end):
            v = values_1d[k]
            if not math.isnan(v):
                next_sum += v
                next_count += 1
        next_avg = next_sum / next_count if next_count > 0 else math.nan

        if bucket_start >= bucket_end:
            indices[i] = bucket_start
            prev_idx = bucket_start
            continue

        prev_val = values_1d[prev_idx]
        best_idx = bucket_start
        max_area = -1.0
        prev_is_nan = math.isnan(prev_val)
        next_is_nan = math.isnan(next_avg)

        if prev_is_nan or next_is_nan:
            # Pick first non-NaN point in bucket
            for j in range(bucket_start, bucket_end):
                if not math.isnan(values_1d[j]):
                    best_idx = j
                    break
        else:
            for j in range(bucket_start, bucket_end):
                v = values_1d[j]
                if math.isnan(v):
                    continue
                area = abs(
                    (j - prev_idx) * (next_avg - prev_val)
                    - (v - prev_val) * (next_bucket_start - prev_idx)
                )
                if area > max_area:
                    max_area = area
                    best_idx = j

        indices[i] = best_idx
        prev_idx = best_idx

    return indices
