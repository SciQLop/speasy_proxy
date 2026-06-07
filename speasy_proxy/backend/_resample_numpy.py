import numpy as np


def min_max_indices(values: np.ndarray, n_buckets: int) -> np.ndarray:
    """Return sorted unique indices capturing min and max per bucket per column."""
    n, n_cols = values.shape
    indices = set()
    indices.add(0)
    indices.add(n - 1)

    for col in range(n_cols):
        col_data = values[:, col]
        for i in range(n_buckets):
            # Identical integer edges to the numba backend so both return the
            # same indices regardless of which backend is installed (BL-1).
            start = int(i * n / n_buckets)
            end = int((i + 1) * n / n_buckets)
            if start >= end:
                continue
            bucket = col_data[start:end]
            valid = ~np.isnan(bucket)
            if not valid.any():
                continue
            indices.add(start + int(np.nanargmin(bucket)))
            indices.add(start + int(np.nanargmax(bucket)))

    return np.array(sorted(indices))


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
