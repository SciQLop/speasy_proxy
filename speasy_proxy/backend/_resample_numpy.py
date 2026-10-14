import numpy as np


def min_max_slots(buckets: np.ndarray, values: np.ndarray, n_buckets: int) -> np.ndarray:
    """Per time bucket and column, the rows of its two extremes in time order:
    slots[b, c] = [earlier, later], [-1, -1] where the bucket has no value. `buckets`
    holds each row's bucket, non-decreasing. Ties keep the first row, as numba does."""
    n, n_cols = values.shape
    slots = np.full((n_buckets, n_cols, 2), -1, dtype=np.int64)
    rows = np.arange(n)
    for col in range(n_cols):
        valid = ~np.isnan(values[:, col])
        r, b, v = rows[valid], buckets[valid], values[valid, col]
        kept, mins = _first_per_bucket(b, r, np.lexsort((r, v, b)))
        _, maxs = _first_per_bucket(b, r, np.lexsort((r, -v, b)))
        slots[kept, col, 0] = np.minimum(mins, maxs)
        slots[kept, col, 1] = np.maximum(mins, maxs)
    return slots


def _first_per_bucket(buckets, rows, order):
    kept, first = np.unique(buckets[order], return_index=True)
    return kept, rows[order][first]


def lttb_single_indices(values_1d: np.ndarray, n_out: int) -> np.ndarray:
    """Largest Triangle Three Buckets for a single 1D column (vectorized inner loop)."""
    n = len(values_1d)
    indices = np.zeros(n_out, dtype=int)
    indices[0] = 0
    indices[n_out - 1] = n - 1

    bucket_size = (n - 2) / (n_out - 2)
    prev_idx = 0

    for i in range(1, n_out - 1):
        bucket_start = int((i - 1) * bucket_size) + 1
        bucket_end = min(int(i * bucket_size) + 1, n)

        next_bucket_start = int(i * bucket_size) + 1
        next_bucket_end = min(int((i + 1) * bucket_size) + 1, n)
        next_slice = values_1d[next_bucket_start:next_bucket_end]
        # Mirror the numba backend (next_count > 0 else nan) and avoid numpy's
        # "Mean of empty slice" RuntimeWarning on empty/all-NaN buckets (BL-12).
        next_avg = np.nanmean(next_slice) if next_slice.size and not np.isnan(next_slice).all() else np.nan

        if bucket_start >= bucket_end:
            indices[i] = bucket_start
            prev_idx = bucket_start
            continue

        prev_val = values_1d[prev_idx]
        j = np.arange(bucket_start, bucket_end)
        candidate_vals = values_1d[j]

        if np.isnan(prev_val) or np.isnan(next_avg):
            # Can't compute areas meaningfully; pick first non-NaN point
            valid_mask = ~np.isnan(candidate_vals)
            if valid_mask.any():
                best_idx = j[valid_mask][0]
            else:
                best_idx = bucket_start
        else:
            areas = np.abs(
                (j - prev_idx) * (next_avg - prev_val)
                - (candidate_vals - prev_val) * (next_bucket_start - prev_idx)
            )
            # NaN areas (from NaN candidates) should not win
            areas = np.where(np.isnan(areas), -1.0, areas)
            best_idx = bucket_start + int(np.argmax(areas))

        indices[i] = best_idx
        prev_idx = best_idx

    return indices
