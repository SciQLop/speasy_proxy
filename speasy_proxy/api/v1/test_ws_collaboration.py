import asyncio
import importlib

import pytest

import speasy_proxy.api.v1.ws_collaboration as ws_mod


@pytest.fixture
def enabled_collaboration(monkeypatch):
    monkeypatch.setenv("SPEASY_PROXY_COLLAB_ENDPOINT_ENABLE", "True")
    importlib.reload(ws_mod)
    yield ws_mod
    monkeypatch.delenv("SPEASY_PROXY_COLLAB_ENDPOINT_ENABLE", raising=False)
    importlib.reload(ws_mod)


class _FakeWebsocketServer:
    instances = []

    def __init__(self):
        self.started = asyncio.Event()
        _FakeWebsocketServer.instances.append(self)

    async def start(self):
        await asyncio.sleep(0.01)
        self.started.set()


@pytest.mark.anyio
async def test_concurrent_first_connections_share_one_started_server(enabled_collaboration, monkeypatch):
    """Regression for BL-33: concurrent first connections must not proceed with
    a server whose start() has not completed, and must share a single instance."""
    _FakeWebsocketServer.instances = []
    monkeypatch.setattr(enabled_collaboration, "WebsocketServer", _FakeWebsocketServer)

    started_at_return = []

    async def connect():
        server = await enabled_collaboration.get_websocket_server()
        started_at_return.append(server.started.is_set())
        return server

    first, second = await asyncio.gather(connect(), connect())

    assert first is second
    assert len(_FakeWebsocketServer.instances) == 1
    # both callers must only get the server once it is actually started
    assert started_at_return == [True, True]


@pytest.fixture
def anyio_backend():
    return "asyncio"
