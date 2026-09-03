import asyncio
import logging
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse, StreamingResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from speasy_proxy.backend.request_logging import RequestLoggingMiddleware, ACCESS_LOGGER_NAME


async def fixed_body(request):
    return PlainTextResponse("hello world")  # 11 bytes


async def streamed_body(request):
    async def gen():
        yield b"abc"
        yield b"defgh"

    return StreamingResponse(gen(), media_type="text/plain")  # 8 bytes total


def _build_client():
    app = Starlette(routes=[
        Route("/fixed", fixed_body),
        Route("/streamed", streamed_body),
    ])
    app.add_middleware(RequestLoggingMiddleware)
    return TestClient(app)


def test_logs_one_info_record_with_method_path_status_duration_and_bytes(caplog):
    client = _build_client()
    with caplog.at_level(logging.INFO, logger=ACCESS_LOGGER_NAME):
        response = client.get("/fixed")

    assert response.status_code == 200
    records = [r for r in caplog.records if r.name == ACCESS_LOGGER_NAME]
    assert len(records) == 1
    record = records[0]
    assert record.levelno == logging.INFO
    assert record.method == "GET"
    assert record.path == "/fixed"
    assert record.status == 200
    assert record.bytes == 11
    assert record.duration_ms >= 0


def test_sums_bytes_across_streamed_chunks(caplog):
    client = _build_client()
    with caplog.at_level(logging.INFO, logger=ACCESS_LOGGER_NAME):
        response = client.get("/streamed")

    assert response.content == b"abcdefgh"
    records = [r for r in caplog.records if r.name == ACCESS_LOGGER_NAME]
    assert len(records) == 1
    assert records[0].bytes == 8


def test_response_body_reaches_the_client_unmodified():
    client = _build_client()
    response = client.get("/fixed")
    assert response.text == "hello world"


def test_does_not_double_count_root_path(caplog):
    # uvicorn's own scope construction already bakes root_path into `path`
    # (see uvicorn/protocols/http/httptools_impl.py: `scope["path"] = root_path
    # + path`), on top of exposing it separately as `scope["root_path"]`. A
    # request to https://host/cache/get_version, behind SPEASY_PROXY_PREFIX=/cache,
    # arrives with scope["path"] == "/cache/get_version" and
    # scope["root_path"] == "/cache" already -- prepending root_path again
    # produces "/cache/cache/get_version". Confirmed live in prod (see
    # /DATA/log/speasy/access.log on sciqlop after the 2026-09-03 v0.19.0 deploy).
    calls = []

    async def app(scope, receive, send):
        calls.append(scope)
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    middleware = RequestLoggingMiddleware(app)

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    sent = []

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "method": "GET",
        "path": "/cache/get_version",
        "root_path": "/cache",
    }

    with caplog.at_level(logging.INFO, logger=ACCESS_LOGGER_NAME):
        asyncio.run(middleware(scope, receive, send))

    records = [r for r in caplog.records if r.name == ACCESS_LOGGER_NAME]
    assert len(records) == 1
    assert records[0].path == "/cache/get_version"


def test_does_not_log_for_non_http_scopes():
    # Exercises the ASGI passthrough for scope types other than "http" (e.g.
    # "lifespan"/"websocket") without needing a real websocket handshake.
    calls = []

    async def app(scope, receive, send):
        calls.append(scope["type"])

    middleware = RequestLoggingMiddleware(app)

    async def receive():
        raise AssertionError("should not be called")

    async def send(message):
        raise AssertionError("should not be called")

    asyncio.run(middleware({"type": "websocket"}, receive, send))
    assert calls == ["websocket"]
