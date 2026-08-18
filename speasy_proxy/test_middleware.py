import asyncio
import os
import time

import pytest
from httpx import ASGITransport, AsyncClient
from starlette.responses import Response

from speasy_proxy import get_application


@pytest.mark.anyio
async def test_get_application_does_not_starve_event_loop_on_large_response():
    """Regression: Starlette's GZipMiddleware compresses response bodies
    synchronously on the event loop (it has no threadpool option), contradicting
    this project's documented rule that compression must never run on the loop
    (see api/compression.py + get_data.py/get_inventory.py, which always offload
    zstd compression to a thread). A sizeable response requested with
    Accept-Encoding: gzip must not block other requests served by the same
    worker while it is compressed."""
    app = get_application()
    body = os.urandom(15_000_000)  # low-compressibility: gzip lvl 9 takes real time

    @app.get("/__test_large__")
    async def _large():
        return Response(content=body, media_type="application/octet-stream")

    ticks = 0
    # Absolute deadline shared by both coroutines (set before either starts),
    # so a synchronous block inside fetch() is actually observed as lost ticks
    # instead of just delaying when the ticker's own window begins.
    deadline = time.monotonic() + 0.2

    async def ticker():
        nonlocal ticks
        while time.monotonic() < deadline:
            ticks += 1
            await asyncio.sleep(0.005)

    async def fetch():
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            await client.get("/__test_large__", headers={"Accept-Encoding": "gzip"})

    await asyncio.gather(fetch(), ticker())

    # If a response-compressing middleware runs synchronously on the loop, the
    # ticker is starved for the whole compression (ticks stays at 0 within this
    # window). With no such middleware, the ticker runs freely (~40 ticks).
    assert ticks > 20


@pytest.fixture
def anyio_backend():
    return "asyncio"
