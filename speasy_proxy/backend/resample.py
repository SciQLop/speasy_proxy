import numpy as np
from speasy.products.variable import SpeasyVariable

try:
    from ._resample_numba import min_max_slots, lttb_single_indices
except ImportError:
    from ._resample_numpy import min_max_slots, lttb_single_indices


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
    t0, width, buckets = _time_buckets(var, n_buckets)
    intensity = np.nansum(np.asarray(var.values, dtype=float), axis=1)
    order = np.lexsort((-intensity, buckets))
    kept_buckets, first_of_bucket = np.unique(buckets[order], return_index=True)
    result = var[order[first_of_bucket]]
    # The kept row can sit anywhere in its bucket, so real times would be 0 to 2 buckets
    # apart and the image would mistake ordinary steps for data gaps. Bucket centres
    # (at most half a bucket off, under a pixel) are regular; missing buckets stay gaps.
    result.time[:] = _grid_times(t0, width, kept_buckets + 0.5)
    return result


def _time_buckets(var: SpeasyVariable, n_buckets: int):
    """Equal slices of the variable's time span: (start, width, each row's bucket), in ns."""
    t = var.time.astype('int64')
    # Float: nanosecond offsets times n_buckets overflow int64 over multi-year spans.
    width = (t[-1] - t[0] + 1) / n_buckets
    return t[0], width, np.minimum(((t - t[0]) / width).astype(np.int64), n_buckets - 1)


def _grid_times(t0, width, positions):
    """Times at fractional bucket positions."""
    return (t0 + positions * width).astype(np.int64).astype('datetime64[ns]')


def _min_max(var: SpeasyVariable, max_points: int) -> SpeasyVariable:
    # Each time bucket gives two rows, at its quarter and three quarters, holding every
    # column's earlier and later extreme. At their real times, extremes were 0 to 2
    # buckets apart and SciQLopPlots took those uneven steps for data gaps; on this grid
    # the steps are even, and only a bucket without data leaves a gap. A row mixes
    # instants from different columns: resampled data is for plotting only.
    n_buckets = max(1, max_points // 2)
    t0, width, buckets = _time_buckets(var, n_buckets)
    values = np.asarray(var.values)
    slots = min_max_slots(buckets, values.astype(float, copy=False), n_buckets)
    kept = np.flatnonzero((slots[:, :, 0] >= 0).any(axis=1))
    picked = slots[kept].transpose(0, 2, 1).reshape(-1, values.shape[1])
    result = var[np.repeat(np.searchsorted(buckets, kept), 2)]
    result.values[:] = np.where(picked >= 0, values[picked, np.arange(values.shape[1])], np.nan)
    result.time[:] = _grid_times(t0, width, np.repeat(kept, 2) + np.tile([0.25, 0.75], len(kept)))
    return result


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
