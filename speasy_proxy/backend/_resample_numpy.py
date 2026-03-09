import numpy as np


def min_max_indices(values: np.ndarray, n_buckets: int) -> np.ndarray:
    """Return sorted unique indices capturing min and max per bucket per column."""
    n, n_cols = values.shape
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
        next_avg = np.mean(values_1d[next_bucket_start:next_bucket_end])

        if bucket_start >= bucket_end:
            indices[i] = bucket_start
            prev_idx = bucket_start
            continue

        prev_val = values_1d[prev_idx]
        j = np.arange(bucket_start, bucket_end)
        areas = np.abs(
            (j - prev_idx) * (next_avg - prev_val)
            - (values_1d[j] - prev_val) * (next_bucket_start - prev_idx)
        )
        best_idx = bucket_start + int(np.argmax(areas))

        indices[i] = best_idx
        prev_idx = best_idx

    return indices
