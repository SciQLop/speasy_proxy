import numba
import numpy as np


@numba.njit(cache=True)
def min_max_indices(values: np.ndarray, n_buckets: int) -> np.ndarray:
    """Return sorted unique indices capturing min and max per bucket per column."""
    n, n_cols = values.shape
    max_indices = 2 + 2 * n_cols * n_buckets
    raw = np.empty(max_indices, dtype=np.intp)
    count = 0
    raw[count] = 0
    count += 1
    raw[count] = n - 1
    count += 1

    for col in range(n_cols):
        for i in range(n_buckets):
            start = int(i * n / n_buckets)
            end = int((i + 1) * n / n_buckets)
            if start >= end:
                continue
            mn_idx = start
            mx_idx = start
            mn_val = values[start, col]
            mx_val = values[start, col]
            for j in range(start + 1, end):
                v = values[j, col]
                if v < mn_val:
                    mn_val = v
                    mn_idx = j
                if v > mx_val:
                    mx_val = v
                    mx_idx = j
            raw[count] = mn_idx
            count += 1
            raw[count] = mx_idx
            count += 1

    return np.unique(raw[:count])


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
        next_count = next_bucket_end - next_bucket_start
        for k in range(next_bucket_start, next_bucket_end):
            next_sum += values_1d[k]
        next_avg = next_sum / next_count if next_count > 0 else 0.0

        if bucket_start >= bucket_end:
            indices[i] = bucket_start
            prev_idx = bucket_start
            continue

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
