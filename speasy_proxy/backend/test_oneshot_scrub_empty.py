import importlib
from datetime import datetime, timedelta, timezone

import numpy as np

from speasy.core.cache.cache import CacheItem
from speasy.products.variable import (DataContainer, SpeasyVariable,
                                      VariableTimeAxis, to_dictionary)

m = importlib.import_module("speasy_proxy.backend.oneshot_scrub_empty")

NOW = datetime(2026, 9, 2, tzinfo=timezone.utc)
WINDOW = timedelta(days=60)


def _empty_var():
    time = VariableTimeAxis(values=np.array([], dtype='datetime64[ns]'))
    values = DataContainer(values=np.empty((0, 1), dtype='float64'), meta={})
    return to_dictionary(SpeasyVariable(axes=[time], values=values, columns=['a']))


def _healthy_var():
    time = VariableTimeAxis(values=np.array(['2016-06-02T00:00:00'], dtype='datetime64[ns]'))
    values = DataContainer(values=np.array([[1.0]], dtype='float64'), meta={})
    return to_dictionary(SpeasyVariable(axes=[time], values=values, columns=['a']))


def test_fragment_datetime_parses_trailing_iso():
    dt = m.fragment_datetime("amda/imf-cdf_istp/2026-08-01T00:00:00+00:00")
    assert dt == datetime(2026, 8, 1, tzinfo=timezone.utc)


def test_fragment_datetime_assumes_utc_when_naive():
    dt = m.fragment_datetime("cda/foo/2026-08-01T00:00:00")
    assert dt == datetime(2026, 8, 1, tzinfo=timezone.utc)


def test_fragment_datetime_returns_none_for_non_iso_tail():
    assert m.fragment_datetime("amda/imf-cdf_istp/not-a-date") is None
    assert m.fragment_datetime("cache/version") is None


def test_should_drop_empty_future_fragment():
    assert m.should_drop(datetime(2048, 1, 1, tzinfo=timezone.utc), NOW, True, WINDOW) is True


def test_should_drop_empty_recent_fragment():
    assert m.should_drop(NOW - timedelta(days=5), NOW, True, WINDOW) is True


def test_keep_empty_old_fragment_genuine_gap():
    # An empty fragment well before the window is a genuine historical data gap;
    # dropping it would only cause endless re-fetch of a known-empty range.
    assert m.should_drop(NOW - timedelta(days=365), NOW, True, WINDOW) is False


def test_keep_nonempty_recent_fragment():
    assert m.should_drop(NOW - timedelta(days=5), NOW, False, WINDOW) is False


def test_keep_unparseable_fragment():
    assert m.should_drop(None, NOW, True, WINDOW) is False


def test_scrub_empty_drops_only_recent_empties(monkeypatch):
    store = {
        "amda/imf-cdf_istp/2048-01-01T00:00:00+00:00": CacheItem(_empty_var(), version="1"),   # future empty -> drop
        "amda/imf-cdf_istp/2026-08-20T00:00:00+00:00": CacheItem(_empty_var(), version="1"),    # recent empty -> drop
        "amda/imf-cdf_istp/2016-06-02T00:00:00+00:00": CacheItem(_healthy_var(), version="1"),  # old real -> keep
        "amda/imf-cdf_istp/1990-01-01T00:00:00+00:00": CacheItem(_empty_var(), version="1"),    # old empty gap -> keep
        "cache/version": "1.8.0",                                                               # not provider data -> ignore
        "__internal__/CacheCall/x/y/z": CacheItem({"whatever": 1}, version=1),                  # not provider data -> ignore
    }
    dropped = []
    monkeypatch.setattr(m, "datetime", _FrozenNow)
    monkeypatch.setattr("speasy_proxy.backend.oneshot_scrub_empty.datetime", _FrozenNow, raising=False)

    from speasy.core import cache as real_cache
    monkeypatch.setattr(real_cache, "entries", lambda: list(store.keys()))
    monkeypatch.setattr(real_cache, "get_item", lambda k, default=None: store.get(k, default))
    monkeypatch.setattr(real_cache, "drop_item", lambda k: dropped.append(k))

    stats = m.scrub_empty(window=WINDOW, apply=True)

    assert sorted(dropped) == [
        "amda/imf-cdf_istp/2026-08-20T00:00:00+00:00",
        "amda/imf-cdf_istp/2048-01-01T00:00:00+00:00",
    ]
    assert stats["amda"] == 2
    assert stats["_scanned"] == 4  # only the 4 amda/ keys are provider-data


class _FrozenNow(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW


def test_scrub_empty_dry_run_does_not_drop(monkeypatch):
    store = {"amda/imf-cdf_istp/2048-01-01T00:00:00+00:00": CacheItem(_empty_var(), version="1")}
    dropped = []
    monkeypatch.setattr("speasy_proxy.backend.oneshot_scrub_empty.datetime", _FrozenNow, raising=False)
    from speasy.core import cache as real_cache
    monkeypatch.setattr(real_cache, "entries", lambda: list(store.keys()))
    monkeypatch.setattr(real_cache, "get_item", lambda k, default=None: store.get(k, default))
    monkeypatch.setattr(real_cache, "drop_item", lambda k: dropped.append(k))

    stats = m.scrub_empty(window=WINDOW, apply=False)

    assert dropped == []
    assert stats["amda"] == 1
