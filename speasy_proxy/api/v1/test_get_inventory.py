import asyncio
import importlib
import time

import pytest

# import the submodule, not the star-imported endpoint function (see BL-10)
m = importlib.import_module("speasy_proxy.api.v1.get_inventory")

from speasy_proxy.backend.inventory_updater import InventoryManager
from speasy_proxy.backend.shared_inventory_store import SharedInventoryStore


class _FakeRequest:
    def __init__(self, headers=None):
        self.headers = headers or {}


def _manager_with(inventories, build_dates):
    mgr = InventoryManager(update_interval_seconds=3600, shared_store=SharedInventoryStore(path=None))
    mgr._inventories = inventories
    mgr._build_dates = build_dates
    return mgr


class _BlockingManager:
    """Simulates the worst case where the manager lookup does blocking work
    (e.g. an inline spz.update_inventories() network fetch on a cache miss)."""

    def get_inventory(self, *args, **kwargs):
        time.sleep(0.3)
        return b"inventory-bytes"


@pytest.mark.anyio
async def test_get_inventory_does_not_starve_event_loop():
    """Regression for BL-4: the async endpoint must not run the (potentially
    blocking) manager lookup directly on the event loop, or it starves every
    other request handled by the same worker."""
    ticks = 0
    # Absolute window shared by both coroutines, so the ticker's window overlaps
    # the endpoint's 0.3s blocking lookup (not measured only afterwards).
    deadline = time.monotonic() + 0.25

    async def ticker():
        nonlocal ticks
        while time.monotonic() < deadline:
            ticks += 1
            await asyncio.sleep(0.005)

    # provider="all" bypasses the list_providers() check
    await asyncio.gather(
        m.get_inventory(request=_FakeRequest(), provider="all", inventory_mgr=_BlockingManager()),
        ticker(),
    )

    # If the lookup runs on the loop, it is blocked for 0.3s and the ticker never
    # ticks within its 0.25s window. Offloaded to a threadpool, it ticks freely
    # (~50 times at 5ms each).
    assert ticks > 20


_BUILD_DATES = {"all": "2020-01-01T00:00:00+00:00"}


@pytest.mark.anyio
async def test_missing_format_returns_404():
    """Regression for BL-7: a format/version that was never built must be 404, not
    a misleading 304."""
    mgr = _manager_with({"inventory/all/json": "X"}, _BUILD_DATES)
    resp = await m.get_inventory(request=_FakeRequest(), provider="all", format="python_dict",
                                 version=2, pickle_proto=3, inventory_mgr=mgr)
    assert resp.status_code == 404


@pytest.mark.anyio
async def test_invalid_version_returns_400():
    mgr = _manager_with({"inventory/all/json": "X"}, _BUILD_DATES)
    resp = await m.get_inventory(request=_FakeRequest(), provider="all", format="json",
                                 version=5, inventory_mgr=mgr)
    assert resp.status_code == 400


@pytest.mark.anyio
async def test_not_newer_returns_304():
    mgr = _manager_with({"inventory/all/json": "X"}, _BUILD_DATES)
    resp = await m.get_inventory(request=_FakeRequest({"If-Modified-Since": "2030-01-01T00:00:00+00:00"}),
                                 provider="all", format="json", inventory_mgr=mgr)
    assert resp.status_code == 304


@pytest.mark.anyio
async def test_present_returns_200():
    mgr = _manager_with({"inventory/all/json": "X"}, _BUILD_DATES)
    resp = await m.get_inventory(request=_FakeRequest(), provider="all", format="json", inventory_mgr=mgr)
    assert resp.status_code == 200


@pytest.mark.anyio
async def test_bad_if_modified_since_does_not_500():
    """A malformed If-Modified-Since must never 500 — serve the data instead."""
    mgr = _manager_with({"inventory/all/json": "X"}, _BUILD_DATES)
    resp = await m.get_inventory(request=_FakeRequest({"If-Modified-Since": "not-a-date"}),
                                 provider="all", format="json", inventory_mgr=mgr)
    assert resp.status_code == 200


@pytest.fixture
def anyio_backend():
    return "asyncio"
