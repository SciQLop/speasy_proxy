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
    resample_lines = strategies[strategy]
    return _spectrogram(var, max_points) if _is_spectrogram(var) else resample_lines(var, max_points)


def _is_spectrogram(var: SpeasyVariable) -> bool:
    # A second axis (DEPEND_1: energy, frequency, ...) makes the columns bins of one
    # quantity, drawn as an image, rather than independent lines.
    return len(var.axes) > 1


def _spectrogram(var: SpeasyVariable, max_points: int) -> SpeasyVariable:
    # One real row per time bucket, buckets evenly spread in time, so the image keeps an
    # even coverage; each bucket keeps its most intense row so bursts survive. The line
    # strategies kept clusters of per-channel extremes with long holes between them.
    # max_points is sized for lines (a min and a max per pixel); an image column needs
    # one row, hence half as many buckets.
    n_buckets = max(1, max_points // 2)
    t = var.time.astype('int64')
    # Float: nanosecond offsets times n_buckets overflow int64 over multi-year spans.
    buckets = np.minimum(((t - t[0]) / (t[-1] - t[0] + 1) * n_buckets).astype(np.int64), n_buckets - 1)
    intensity = np.nansum(np.asarray(var.values, dtype=float), axis=1)
    order = np.lexsort((-intensity, buckets))
    _, first_of_bucket = np.unique(buckets[order], return_index=True)
    return var[np.sort(order[first_of_bucket])]


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
