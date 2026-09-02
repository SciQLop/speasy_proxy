import importlib
from datetime import datetime, timezone

import numpy as np

from speasy.core.cache.cache import CacheItem
from speasy.products.variable import (DataContainer, SpeasyVariable,
                                      VariableTimeAxis, to_dictionary)

m = importlib.import_module("speasy_proxy.backend.oneshot_scrub_empty")

FLOOR = datetime(2025, 11, 1, tzinfo=timezone.utc)


def _var(times, values):
    time = VariableTimeAxis(values=np.array(times, dtype='datetime64[ns]'))
    values = DataContainer(values=np.array(values, dtype='float64'), meta={})
    cols = [f"c{i}" for i in range(np.array(values.values).shape[1])] if len(times) else ["c0"]
    return to_dictionary(SpeasyVariable(axes=[time], values=values, columns=cols))


def _zero_rows():
    time = VariableTimeAxis(values=np.array([], dtype='datetime64[ns]'))
    values = DataContainer(values=np.empty((0, 1), dtype='float64'), meta={})
    return to_dictionary(SpeasyVariable(axes=[time], values=values, columns=['c0']))


def _all_nan(n=2, cols=3):
    time = VariableTimeAxis(values=np.array(['2026-08-01T00:00:00'] * n, dtype='datetime64[ns]'))
    values = DataContainer(values=np.full((n, cols), np.nan, dtype='float64'), meta={})
    return to_dictionary(SpeasyVariable(axes=[time], values=values, columns=['a', 'b', 'c']))


def _finite(n=12, cols=3):
    time = VariableTimeAxis(values=np.array(['2026-08-01T00:00:00'] * n, dtype='datetime64[ns]'))
    values = DataContainer(values=np.ones((n, cols), dtype='float64'), meta={})
    return to_dictionary(SpeasyVariable(axes=[time], values=values, columns=['a', 'b', 'c']))


def test_fragment_datetime():
    assert m.fragment_datetime("amda/imf-cdf_istp/2026-08-01T00:00:00+00:00") == \
        datetime(2026, 8, 1, tzinfo=timezone.utc)
    assert m.fragment_datetime("cda/foo/2026-08-01T00:00:00") == \
        datetime(2026, 8, 1, tzinfo=timezone.utc)
    assert m.fragment_datetime("cache/version") is None


def test_is_empty_zero_rows():
    assert m.is_empty(_zero_rows()) is True


def test_is_empty_all_nan_pad():
    # AMDA returns ~2 NaN rows even out of range -- must count as empty.
    assert m.is_empty(_all_nan(2, 3)) is True
    assert m.is_empty(_all_nan(1, 3)) is True


def test_is_empty_finite_ephemeris_kept():
    # Finite future ephemeris (orbit prediction) is real data, not empty.
    assert m.is_empty(_finite(12, 3)) is False


def test_is_empty_large_fragment_skips_scan():
    assert m.is_empty(_finite(100, 3)) is False


def test_is_empty_non_variable_payload():
    assert m.is_empty({"not": "a variable"}) is False
    assert m.is_empty(None) is False


def test_should_drop_gating():
    empty = CacheItem(_zero_rows(), version="1")
    nan = CacheItem(_all_nan(2, 3), version="1")
    real = CacheItem(_finite(12, 3), version="1")
    after = datetime(2026, 8, 1, tzinfo=timezone.utc)
    before = datetime(2025, 1, 1, tzinfo=timezone.utc)
    assert m.should_drop(after, empty, FLOOR) is True
    assert m.should_drop(after, nan, FLOOR) is True
    assert m.should_drop(after, real, FLOOR) is False       # real data kept
    assert m.should_drop(before, empty, FLOOR) is False      # pre-floor gap kept
    assert m.should_drop(None, empty, FLOOR) is False


def test_scrub_empty_apply(monkeypatch):
    store = {
        "amda/imf-cdf_istp/2048-01-01T00:00:00+00:00": CacheItem(_zero_rows(), version="1"),   # future empty -> drop
        "amda/athp1_bs-cdf_istp/2026-08-05T00:00:00+00:00": CacheItem(_all_nan(2, 3), version="1"),  # NaN pad -> drop
        "amda/bepi_xyz_hee-cdf_istp/2026-09-02T12:00:00+00:00": CacheItem(_finite(12, 3), version="1"),  # ephemeris -> keep
        "amda/b_mgs_mso-cdf_istp/2004-12-25T12:00:00+00:00": CacheItem(_all_nan(1, 3), version="1"),  # pre-floor gap -> keep
        "cache/version": "1.8.0",                                                              # not provider data -> ignore
    }
    dropped = []
    from speasy.core import cache as real_cache
    monkeypatch.setattr(real_cache, "entries", lambda: list(store.keys()))
    monkeypatch.setattr(real_cache, "get_item", lambda k, default=None: store.get(k, default))
    monkeypatch.setattr(real_cache, "drop_item", lambda k: dropped.append(k))

    stats = m.scrub_empty(floor=FLOOR, apply=True)

    assert sorted(dropped) == [
        "amda/athp1_bs-cdf_istp/2026-08-05T00:00:00+00:00",
        "amda/imf-cdf_istp/2048-01-01T00:00:00+00:00",
    ]
    assert stats["amda"] == 2
    assert stats["_scanned"] == 4  # only the 4 amda/ keys are provider-data


def test_scrub_empty_dry_run(monkeypatch):
    store = {"amda/imf-cdf_istp/2048-01-01T00:00:00+00:00": CacheItem(_zero_rows(), version="1")}
    dropped = []
    from speasy.core import cache as real_cache
    monkeypatch.setattr(real_cache, "entries", lambda: list(store.keys()))
    monkeypatch.setattr(real_cache, "get_item", lambda k, default=None: store.get(k, default))
    monkeypatch.setattr(real_cache, "drop_item", lambda k: dropped.append(k))

    stats = m.scrub_empty(floor=FLOOR, apply=False)

    assert dropped == []
    assert stats["amda"] == 1
