import numpy as np
import pytest
from speasy.products.variable import SpeasyVariable, VariableTimeAxis, DataContainer
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


def test_preserves_time_ordering():
    var = _make_var(5000, n_cols=2)
    result = resample(var, max_points=200, strategy='min_max')
    times = result.time
    assert np.all(times[1:] >= times[:-1])


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
    assert len(result) <= 200  # up to max_points * n_cols worst case


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


@pytest.mark.parametrize("n,n_cols,n_buckets", [
    (100, 1, 10), (1000, 3, 50), (10000, 2, 99),
])
def test_min_max_backends_match(n, n_cols, n_buckets):
    if not HAS_NUMBA:
        pytest.skip("numba not installed")
    values = np.random.default_rng(42).standard_normal((n, n_cols))
    np_idx = np_backend.min_max_indices(values, n_buckets)
    nb_idx = nb_backend.min_max_indices(values, n_buckets)
    np.testing.assert_array_equal(np_idx, nb_idx)


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


def test_min_max_backends_match_diverging_case():
    """Regression for BL-1: numpy used linspace edges, numba integer edges; they
    must agree. n=60, n_buckets=22 was a known divergence."""
    if not HAS_NUMBA:
        pytest.skip("numba not installed")
    values = np.random.default_rng(0).standard_normal((60, 2))
    np_idx = np_backend.min_max_indices(values, 22)
    nb_idx = nb_backend.min_max_indices(values, 22)
    np.testing.assert_array_equal(np_idx, nb_idx)


@pytest.mark.parametrize("seed", range(20))
def test_min_max_backends_match_randomized(seed):
    """Property: the two backends must return identical indices for any input,
    including NaNs, so the served data does not depend on whether numba is
    installed."""
    if not HAS_NUMBA:
        pytest.skip("numba not installed")
    rng = np.random.default_rng(seed)
    n = int(rng.integers(20, 5000))
    n_cols = int(rng.integers(1, 4))
    n_buckets = int(rng.integers(2, min(n, 300)))
    values = rng.standard_normal((n, n_cols))
    nan_mask = rng.random((n, n_cols)) < 0.1
    values[nan_mask] = np.nan
    np_idx = np_backend.min_max_indices(values, n_buckets)
    nb_idx = nb_backend.min_max_indices(values, n_buckets)
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
