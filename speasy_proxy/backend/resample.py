import numpy as np
from speasy.products.variable import SpeasyVariable


def resample(var: SpeasyVariable, max_points: int, strategy: str = 'min_max') -> SpeasyVariable:
    if len(var) <= max_points:
        return var
    strategies = {'min_max': _min_max, 'lttb': _lttb}
    return strategies[strategy](var, max_points)


def _min_max(var: SpeasyVariable, max_points: int) -> SpeasyVariable:
    n = len(var)
    n_buckets = max(1, (max_points - 2) // 2)
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
