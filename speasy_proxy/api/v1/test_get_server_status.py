import importlib
from datetime import datetime, UTC

import pytest

from speasy_proxy.api.v1.models import ServerStatus

m = importlib.import_module("speasy_proxy.api.v1.get_server_status")


class _FakeManager:
    last_update = datetime(2020, 1, 1, tzinfo=UTC)
    update_interval = 3600
    inventory_size = "42"


@pytest.mark.anyio
async def test_get_server_status_reports_manager_state():
    result = await m.get_server_status(inventory_mgr=_FakeManager())
    ServerStatus.model_validate(result)
    assert result["last_inventory_update"] == "2020-01-01T00:00:00+00:00"
    assert result["inventory_update_interval"] == "1:00:00"
    assert result["inventory_size"] == "42"


@pytest.fixture
def anyio_backend():
    return "asyncio"
