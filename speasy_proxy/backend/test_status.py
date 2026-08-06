from datetime import datetime, timedelta, UTC

from speasy_proxy.backend import status
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
