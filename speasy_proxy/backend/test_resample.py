import numpy as np
import pytest
from speasy.products.variable import SpeasyVariable, VariableTimeAxis, VariableAxis, DataContainer
from speasy_proxy.backend.resample import resample


def _make_var(n_points, n_cols=1, values=None):
    times = np.arange(n_points).astype('datetime64[s]').astype('datetime64[ns]')
    if values is None:
        values = np.random.default_rng(42).standard_normal((n_points, n_cols))
    axis = VariableTimeAxis(values=times, meta={})
    data = DataContainer(values=values, meta={}, name='test')
    return SpeasyVariable(axes=[axis], values=data)


def test_min_max_reduces_points():
    var = _make_var(10000, n_cols=1)
    result = resample(var, max_points=200, strategy='min_max')
    assert len(result) <= 200
    assert len(result) > 0


def test_min_max_preserves_extremes():
    values = np.zeros((1000, 1))
    values[333, 0] = 100.0
    values[666, 0] = -100.0
    var = _make_var(1000, values=values)
    result = resample(var, max_points=100, strategy='min_max')
    assert 100.0 in result.values[:, 0]
    assert -100.0 in result.values[:, 0]


def test_min_max_multi_column_independent():
    values = np.zeros((1000, 3))
    values[100, 0] = 50.0
    values[200, 1] = 60.0
    values[300, 2] = 70.0
    var = _make_var(1000, values=values)
    result = resample(var, max_points=100, strategy='min_max')
    assert 50.0 in result.values[:, 0]
    assert 60.0 in result.values[:, 1]
    assert 70.0 in result.values[:, 2]


def test_no_resample_when_below_threshold():
    var = _make_var(50, n_cols=2)
    result = resample(var, max_points=100, strategy='min_max')
    assert len(result) == 50
    np.testing.assert_array_equal(result.values, var.values)


def test_3d_variable_passes_through_unresampled():
    """3-D+ products are not resampled (ready-to-plot 1-D/2-D only) — the
    variable must be served as-is instead of crashing the server."""
    values = np.random.default_rng(42).standard_normal((1000, 2, 3))
    var = _make_var(1000, values=values)
    result = resample(var, max_points=100, strategy='min_max')
    assert result is var


def test_2d_variable_still_resamples():
    var = _make_var(10000, n_cols=2)
    result = resample(var, max_points=200, strategy='min_max')
    assert result is not var
    assert len(result) < len(var)


def test_preserves_time_ordering():
    var = _make_var(5000, n_cols=2)
    result = resample(var, max_points=200, strategy='min_max')
    times = result.time
    assert np.all(times[1:] >= times[:-1])


def _key_gaps(times):
    """Steps SciQLopPlots (NeoQCP detectKeyGaps) breaks a line at: wider than 1.5 times
    the narrower of the two neighbouring steps."""
    steps = np.diff(np.asarray(times, dtype='int64')).astype(float)
    return [i for i in range(len(steps))
            if steps[i] > 1.5 * min(steps[j] for j in (i - 1, i + 1) if 0 <= j < len(steps))]


def _irregular_var_with_hole(n_cols=3):
    """Jittered 1 s sampling with a 1000 s hole, as real instruments give."""
    rng = np.random.default_rng(5)
    times_s = np.cumsum(rng.uniform(0.5, 1.5, 20000))
    keep = (times_s < 8000) | (times_s > 9000)
    times = (times_s[keep] * 1e9).astype('int64').astype('datetime64[ns]')
    values = rng.standard_normal((len(times), n_cols))
    return SpeasyVariable(axes=[VariableTimeAxis(values=times, meta={})],
                          values=DataContainer(values=values, meta={}, name='b'))


def test_min_max_rows_sit_on_a_regular_grid_and_only_real_gaps_break_the_line():
    """Each column's min and max at their real times were 0 to 2 buckets apart, so
    SciQLopPlots' gap detection chopped resampled lines into fragments. Two slots per
    time bucket, at its quarter and three quarters, keep the steps even."""
    var = _irregular_var_with_hole()
    result = resample(var, max_points=1000, strategy='min_max')
    assert len(result) <= 1000
    hole_start, hole_stop = np.datetime64(8000, 's'), np.datetime64(9000, 's')
    gaps = _key_gaps(result.time)
    assert len(gaps) == 1
    # A row sits up to one bucket from the data it stands for (sub-pixel on a plot).
    bucket = (var.time[-1] - var.time[0]) / 500
    assert hole_start - bucket < result.time[gaps[0]] < hole_start + bucket
    assert hole_stop - bucket < result.time[gaps[0] + 1] < hole_stop + bucket


def test_min_max_keeps_each_column_extremes_in_their_order():
    values = np.zeros((1000, 2))
    values[5, 0], values[15, 0] = 5.0, -5.0       # column 0: max, then min
    values[5, 1], values[15, 1] = -7.0, 7.0       # column 1: min, then max
    var = _make_var(1000, values=values)
    result = resample(var, max_points=100, strategy='min_max')
    assert list(result.values[:2, 0]) == [5.0, -5.0]
    assert list(result.values[:2, 1]) == [-7.0, 7.0]


def test_min_max_column_without_data_in_a_bucket_is_nan_there():
    values = np.random.default_rng(1).standard_normal((1000, 2))
    values[:100, 1] = np.nan
    var = _make_var(1000, values=values)
    result = resample(var, max_points=100, strategy='min_max')
    assert np.isnan(result.values[:2, 1]).all()
    assert not np.isnan(result.values[:, 0]).any()


def test_min_max_does_not_touch_the_fetched_variable():
    var = _irregular_var_with_hole()
    times, values = var.time.copy(), var.values.copy()
    resample(var, max_points=1000, strategy='min_max')
    assert np.array_equal(var.time, times) and np.array_equal(var.values, values)


def test_min_max_bucketing_survives_multi_year_spans():
    times = (np.arange(20000) * 3600).astype('datetime64[s]').astype('datetime64[ns]')
    var = SpeasyVariable(axes=[VariableTimeAxis(values=times, meta={})],
                         values=DataContainer(values=np.random.default_rng(2).standard_normal((20000, 2)),
                                              meta={}, name='b'))
    result = resample(var, max_points=10000, strategy='min_max')
    assert len(result) <= 10000
    assert np.all(np.diff(result.time.astype('int64')) > 0)


def test_lttb_reduces_points():
    var = _make_var(10000, n_cols=1)
    result = resample(var, max_points=200, strategy='lttb')
    assert len(result) <= 200
    assert len(result) > 0


def test_lttb_preserves_endpoints():
    var = _make_var(1000, n_cols=1)
    result = resample(var, max_points=100, strategy='lttb')
    np.testing.assert_equal(result.time[0], var.time[0])
    np.testing.assert_equal(result.time[-1], var.time[-1])


def test_lttb_multi_column():
    values = np.zeros((1000, 2))
    values[500, 0] = 100.0
    values[700, 1] = 100.0
    var = _make_var(1000, values=values)
    result = resample(var, max_points=100, strategy='lttb')
    assert len(result) > 0
    assert len(result) <= 100  # per-column budget divides max_points by n_cols


def test_min_max_wide_product_stays_within_max_points():
    """A many-channel product (e.g. a spectrogram) must not blow past
    max_points by a factor of n_cols: the per-bucket budget divides by n_cols."""
    var = _make_var(100_000, n_cols=64)
    result = resample(var, max_points=200, strategy='min_max')
    assert len(result) <= 200


def test_lttb_wide_product_stays_within_max_points():
    var = _make_var(100_000, n_cols=64)
    result = resample(var, max_points=200, strategy='lttb')
    assert len(result) <= 200


def _make_spectrogram(n_points, n_bins, values=None, step_s=1):
    times = (np.arange(n_points) * step_s).astype('datetime64[s]').astype('datetime64[ns]')
    if values is None:
        values = np.random.default_rng(7).lognormal(size=(n_points, n_bins))
    axes = [VariableTimeAxis(values=times, meta={}),
            VariableAxis(values=np.geomspace(10, 3e4, n_bins), meta={}, name='energy')]
    return SpeasyVariable(axes=axes, values=DataContainer(values=values, meta={}, name='flux'))


def test_spectrogram_keeps_rows_evenly_spread_in_time():
    """Per-channel min/max kept clusters of extreme rows with hours-long holes between
    them, which the /plot image then drew at the wrong times."""
    var = _make_spectrogram(20000, 31)
    result = resample(var, max_points=1000, strategy='min_max')
    kept = result.time.astype('int64') // 10**9
    assert 450 <= len(result) <= 500          # one row per image column: max_points / 2
    assert np.diff(kept).max() <= 2 * 20000 / 500


def test_spectrogram_bucketing_survives_multi_year_spans():
    # Nanosecond offsets times the bucket count overflow int64 past a few years.
    var = _make_spectrogram(20000, 4, step_s=3600)   # ~2.3 years of hourly spectra
    result = resample(var, max_points=10000, strategy='min_max')
    kept = result.time.astype('int64') // 10**9
    assert 4500 <= len(result) <= 5000
    assert np.all(np.diff(kept) > 0)


def test_spectrogram_rows_sit_on_a_regular_grid_and_real_gaps_stay():
    """A bucket's most intense row can sit anywhere in it, so kept rows were unevenly
    spaced (0 to 2 buckets apart) and the /plot image mistook normal steps for data
    gaps: dark vertical stripes. Rows are stamped at their bucket centre instead."""
    rng = np.random.default_rng(3)
    var = _make_spectrogram(20000, 8)
    hole = np.r_[0:8000, 9000:20000]            # 1000 s without data, ~25 buckets
    var = var[hole]
    var.values[:] = rng.lognormal(size=var.values.shape)
    original_times = var.time.copy()
    result = resample(var, max_points=1000, strategy='min_max')
    assert np.array_equal(var.time, original_times)   # the fetched variable is not touched
    steps = np.unique(np.diff(result.time.astype('int64')))
    bucket = steps.min()
    assert np.all(steps % bucket <= 1)          # multiples of one bucket (ns rounding)
    assert steps.max() >= 20 * bucket           # the real gap is still there


def test_spectrogram_keeps_real_rows_and_bursts():
    values = np.ones((20000, 8))
    values[12345] = 1e6
    var = _make_spectrogram(20000, 8, values=values)
    for strategy in ('min_max', 'lttb'):
        result = resample(var, max_points=1000, strategy=strategy)
        assert result.values.max() == 1e6
        assert set(np.unique(result.values)) <= {1.0, 1e6}   # original rows, not blends


def test_invalid_strategy_raises():
    var = _make_var(100, n_cols=1)
    with pytest.raises(KeyError):
        resample(var, max_points=10, strategy='invalid')


# --- Backend equivalence tests ---

from speasy_proxy.backend import _resample_numpy as np_backend

try:
    from speasy_proxy.backend import _resample_numba as nb_backend
    HAS_NUMBA = True
except ImportError:
    HAS_NUMBA = False


def _random_slots_input(rng):
    n = int(rng.integers(20, 5000))
    n_cols = int(rng.integers(1, 4))
    n_buckets = int(rng.integers(2, min(n, 300)))
    buckets = np.sort(rng.integers(0, n_buckets, n))     # some buckets stay empty
    values = rng.standard_normal((n, n_cols))
    values[rng.random((n, n_cols)) < 0.1] = np.nan
    values[rng.random((n, n_cols)) < 0.05] = 0.0          # ties: the first one wins
    return buckets, values, n_buckets


@pytest.mark.parametrize("seed", range(20))
def test_min_max_slots_backends_match_randomized(seed):
    """Property: the two backends must return identical slots for any input,
    including NaNs, ties and empty buckets, so the served data does not depend on
    whether numba is installed."""
    if not HAS_NUMBA:
        pytest.skip("numba not installed")
    buckets, values, n_buckets = _random_slots_input(np.random.default_rng(seed))
    np.testing.assert_array_equal(np_backend.min_max_slots(buckets, values, n_buckets),
                                  nb_backend.min_max_slots(buckets, values, n_buckets))


def test_min_max_slots_hold_the_earlier_then_the_later_extreme():
    buckets = np.array([0, 0, 0, 2, 2])
    values = np.array([[1.0], [3.0], [-1.0], [np.nan], [4.0]])
    slots = np_backend.min_max_slots(buckets, values, 3)
    assert slots[:, 0].tolist() == [[1, 2], [-1, -1], [4, 4]]


@pytest.mark.parametrize("n,n_out", [
    (100, 10), (1000, 50), (5000, 99),
])
def test_lttb_backends_match(n, n_out):
    if not HAS_NUMBA:
        pytest.skip("numba not installed")
    values = np.random.default_rng(42).standard_normal(n)
    np_idx = np_backend.lttb_single_indices(values, n_out)
    nb_idx = nb_backend.lttb_single_indices(values, n_out)
    np.testing.assert_array_equal(np_idx, nb_idx)


def test_lttb_numpy_no_empty_slice_warning():
    """Regression for BL-12: numpy lttb must not emit RuntimeWarning when a
    next-bucket window is empty/all-NaN (numba returns nan silently). Replays a
    seed known to trigger it; the warning is promoted to an error."""
    import warnings
    rng = np.random.default_rng(6)
    n = int(rng.integers(20, 5000))
    n_out = int(rng.integers(10, min(n, 300)))
    values = rng.standard_normal(n)
    values[rng.random(n) < 0.1] = np.nan
    with warnings.catch_warnings():
        warnings.simplefilter("error", RuntimeWarning)
        np_backend.lttb_single_indices(values, n_out)


@pytest.mark.parametrize("seed", range(20))
def test_lttb_backends_match_randomized(seed):
    if not HAS_NUMBA:
        pytest.skip("numba not installed")
    rng = np.random.default_rng(seed)
    n = int(rng.integers(20, 5000))
    n_out = int(rng.integers(10, min(n, 300)))
    values = rng.standard_normal(n)
    values[rng.random(n) < 0.1] = np.nan
    np_idx = np_backend.lttb_single_indices(values, n_out)
    nb_idx = nb_backend.lttb_single_indices(values, n_out)
    np.testing.assert_array_equal(np_idx, nb_idx)
