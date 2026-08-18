import numpy as np
from speasy.products.variable import SpeasyVariable

try:
    from ._resample_numba import min_max_indices, lttb_single_indices
except ImportError:
    from ._resample_numpy import min_max_indices, lttb_single_indices


def resample(var: SpeasyVariable, max_points: int, strategy: str = 'min_max') -> SpeasyVariable:
    # Resampling is for ready-to-plot 1-D/2-D data only; serve higher-dim data as-is.
    if var.values.ndim != 2:
        return var
    if len(var) <= max_points:
        return var
    strategies = {'min_max': _min_max, 'lttb': _lttb}
    return strategies[strategy](var, max_points)


def _min_max(var: SpeasyVariable, max_points: int) -> SpeasyVariable:
    # min_max_indices keeps up to 2 points per bucket PER COLUMN in one shared,
    # already-deduplicated index set; the per-bucket budget must shrink with
    # n_cols or a wide product (e.g. a many-channel spectrogram) blows past
    # max_points by a factor of n_cols.
    n_cols = var.values.shape[1]
    n_buckets = max(1, (max_points - 2) // (2 * n_cols))
    values = np.asarray(var.values)
    sorted_indices = min_max_indices(values, n_buckets)
    return var[sorted_indices]


def _lttb(var: SpeasyVariable, max_points: int) -> SpeasyVariable:
    # Each column is resampled independently and the results unioned, so the
    # per-column budget must be max_points / n_cols or the union can reach
    # n_cols * max_points for a wide product.
    n_cols = var.values.shape[1]
    values = np.asarray(var.values)
    n_out = max(max_points // n_cols, 3)

    per_column = [lttb_single_indices(values[:, col], n_out) for col in range(n_cols)]
    sorted_indices = np.unique(np.concatenate(per_column))
    return var[sorted_indices]
