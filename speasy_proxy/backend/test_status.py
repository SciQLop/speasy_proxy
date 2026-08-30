from datetime import datetime, timedelta, UTC

from speasy_proxy.backend import status, _cache
from speasy_proxy.api.v1.models import ServerStatus


def test_status_returns_all_server_status_fields():
    result = status(last_inventory_update=datetime(2020, 1, 1, tzinfo=UTC),
                    update_interval_seconds=3600,
                    inventory_size="42")
    ServerStatus.model_validate(result)
    assert result["entries"] >= 0
    assert result["cache_disk_size"] >= 0
    assert result["up_duration"] >= 0
    assert result["last_inventory_update"] == "2020-01-01T00:00:00+00:00"
    assert result["inventory_size"] == "42"
    assert result["inventory_update_interval"] == str(timedelta(seconds=3600))
    datetime.fromisoformat(result["up_since"])


def test_status_never_updated_reports_never():
    result = status(last_inventory_update=None)
    assert result["last_inventory_update"] == "never"
    assert result["inventory_size"] == "0"


def test_status_does_not_take_a_whole_cache_lock(monkeypatch):
    # transact() with no key is a whole-cache exclusive lock on a plain (non-Fanout)
    # Cache -- fine for a small diskcache instance, but at production scale (millions
    # of entries) it made this endpoint hang indefinitely and blocked concurrent
    # get_data requests too. Reading approximate stats doesn't need a consistent
    # cross-field snapshot badly enough to justify that.
    def _boom(*args, **kwargs):
        raise AssertionError("status() must not call _cache.transact()")

    # Cache uses __slots__ -- patch the class, not the instance.
    monkeypatch.setattr(type(_cache), "transact", _boom)
    status(last_inventory_update=None)
