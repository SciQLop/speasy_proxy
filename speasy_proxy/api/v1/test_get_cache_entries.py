import importlib
import pickle

import pytest

from speasy.core import cache

m = importlib.import_module("speasy_proxy.api.v1.get_cache_entries")


@pytest.mark.anyio
async def test_get_cache_entries_returns_pickled_entry_keys():
    response = await m.get_cache_entries(pickle_proto=3)
    assert response.media_type == "application/python-pickle"
    entries = pickle.loads(response.body)
    assert entries == cache.entries()
    assert isinstance(entries, list)


@pytest.fixture
def anyio_backend():
    return "asyncio"
