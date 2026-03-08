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


def _lttb(var: SpeasyVariable, max_points: int) -> SpeasyVariable:
    raise NotImplementedError("LTTB resampling is not yet implemented")
