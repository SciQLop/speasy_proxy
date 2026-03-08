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
