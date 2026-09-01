import importlib
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from speasy.core.cache.cache import CacheItem
from speasy.products.variable import DataContainer, SpeasyVariable, VariableTimeAxis, to_dictionary

m = importlib.import_module("speasy_proxy.backend.cache_scrubber")


def _healthy_data():
    time = VariableTimeAxis(values=np.array(['2020-01-01T00:00:00'], dtype='datetime64[ns]'))
    values = DataContainer(values=np.array([[1.0, 2.0]], dtype='float64'), meta={})
    return to_dictionary(SpeasyVariable(axes=[time], values=values, columns=['a', 'b']))


def test_is_fossil_entry_flags_datetime_version():
    item = CacheItem(data=_healthy_data(), version=datetime(2025, 12, 1))
    assert m.is_fossil_entry(item) is True


def test_is_fossil_entry_flags_undeserializable_data():
    item = CacheItem(data=b"not a dict", version="1.0.0")
    assert m.is_fossil_entry(item) is True


def test_is_fossil_entry_accepts_healthy_entry():
    item = CacheItem(data=_healthy_data(), version="1.0.0")
    assert m.is_fossil_entry(item) is False


def test_is_stale_amda_entry_flags_entries_from_before_the_cdf_istp_switch():
    # speasy defaulted AMDA requests to ASCII until 2023-10-20 (commit 73d3bbd).
    # An entry cached before that is almost certainly ASCII-decoded, a different
    # (and possibly narrower) shape than today's CDF_ISTP decoder produces for
    # the same product -- confirmed live for amda/mex_els_spec_0, which crashed
    # merging a stale few-column fragment with a freshly-fetched 128-column one.
    item = CacheItem(data=_healthy_data(), version="1.0.0")
    item.created = datetime(2022, 1, 1, tzinfo=timezone.utc)
    assert m.is_stale_amda_entry("amda/mex_els_spec_0-cdf_istp/2004-05-25T12:00:00", item) is True


def test_is_stale_amda_entry_accepts_entries_written_after_the_switch():
    item = CacheItem(data=_healthy_data(), version="1.0.0")
    item.created = datetime.now(tz=timezone.utc) - timedelta(days=1)
    assert m.is_stale_amda_entry("amda/mex_els_spec_0-cdf_istp/2004-05-25T12:00:00", item) is False


def test_is_stale_amda_entry_ignores_non_amda_keys():
    # Other providers have their own cache mechanisms/self-heal (e.g.
    # UnversionedProviderCache's fossil-version check) -- an old entry there
    # isn't evidence of the ASCII/CDF_ISTP format switch this only applies to.
    item = CacheItem(data=_healthy_data(), version="1.0.0")
    item.created = datetime(2022, 1, 1, tzinfo=timezone.utc)
    assert m.is_stale_amda_entry("cda/some_product/2004-05-25T12:00:00", item) is False


def test_scrub_all_also_drops_stale_amda_entries(monkeypatch):
    stale_amda = CacheItem(data=_healthy_data(), version="1.0.0")
    stale_amda.created = datetime(2022, 1, 1, tzinfo=timezone.utc)
    fresh_amda = CacheItem(data=_healthy_data(), version="1.0.0")
    store = {"amda/old-cdf_istp/t": stale_amda, "amda/new-cdf_istp/t": fresh_amda}
    dropped_keys = []

    monkeypatch.setattr(m.cache, "entries", lambda: list(store.keys()))
    monkeypatch.setattr(m.cache, "get_item", lambda key, default=None: store.get(key, default))
    monkeypatch.setattr(m.cache, "drop_item", lambda key: dropped_keys.append(key))

    dropped = m.scrub_all(batch_size=500)

    assert dropped == 1
    assert dropped_keys == ["amda/old-cdf_istp/t"]


def test_scrub_all_drops_only_fossils(monkeypatch):
    good = CacheItem(data=_healthy_data(), version="1.0.0")
    bad = CacheItem(data=_healthy_data(), version=datetime(2025, 12, 1))
    store = {"good_key": good, "bad_key": bad}
    dropped_keys = []

    monkeypatch.setattr(m.cache, "entries", lambda: list(store.keys()))
    monkeypatch.setattr(m.cache, "get_item", lambda key, default=None: store.get(key, default))
    monkeypatch.setattr(m.cache, "drop_item", lambda key: dropped_keys.append(key))

    dropped = m.scrub_all(batch_size=500)

    assert dropped == 1
    assert dropped_keys == ["bad_key"]


def test_scrub_all_handles_empty_cache(monkeypatch):
    monkeypatch.setattr(m.cache, "entries", lambda: [])
    assert m.scrub_all(batch_size=10) == 0


def test_scrub_all_covers_every_key_across_multiple_batches(monkeypatch):
    """batch_size smaller than the number of keys must still check every key,
    not just the first batch."""
    store = {
        f"key_{i}": CacheItem(data=_healthy_data(),
                              version=(datetime(2025, 12, 1) if i % 3 == 0 else "1.0.0"))
        for i in range(23)
    }
    dropped_keys = []

    monkeypatch.setattr(m.cache, "entries", lambda: list(store.keys()))
    monkeypatch.setattr(m.cache, "get_item", lambda key, default=None: store.get(key, default))
    monkeypatch.setattr(m.cache, "drop_item", lambda key: dropped_keys.append(key))

    dropped = m.scrub_all(batch_size=5)  # 23 keys, 5 uneven batches

    expected = [k for k, v in store.items() if isinstance(v.version, datetime)]
    assert dropped == len(expected)
    assert sorted(dropped_keys) == sorted(expected)


@pytest.mark.anyio
async def test_periodic_scrub_loop_survives_tick_exception(monkeypatch):
    """A failing tick must be logged and swallowed, not kill the loop -- verified
    by getting past a first raising tick to a second call before cancellation."""
    calls = []

    def _boom(batch_size):
        calls.append(batch_size)
        raise RuntimeError("boom")

    monkeypatch.setattr(m, "scrub_all", _boom)

    task = None
    import asyncio

    async def _run():
        await m.periodic_scrub_loop(interval_seconds=0, batch_size=5)

    task = asyncio.create_task(_run())
    for _ in range(50):
        if len(calls) >= 2:
            break
        await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert len(calls) >= 2


@pytest.fixture
def anyio_backend():
    return "asyncio"
