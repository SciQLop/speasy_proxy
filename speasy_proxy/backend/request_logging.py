"""Per-request access logging as a plain ASGI middleware.

Deliberately not `BaseHTTPMiddleware` (or the `@app.middleware("http")` sugar
over it): that wraps every request through an extra anyio memory-stream
indirection, the same class of event-loop tax this project already avoids
elsewhere (see the GZipMiddleware comment in `speasy_proxy/__init__.py`). A
plain ASGI middleware times the request and sums response bytes by observing
the `send` messages directly, with no extra indirection and no dependency.

Covers every endpoint uniformly, replacing the ad hoc per-request timing that
used to live only in `api/v1/get_data.py` (and only at DEBUG, which prod runs
above). Emitted at INFO on a dedicated logger so it can be routed to its own
log file independently of the rest of the `speasy_proxy` logger tree.
"""
import logging
import time

ACCESS_LOGGER_NAME = "speasy_proxy.access"

log = logging.getLogger(ACCESS_LOGGER_NAME)


class RequestLoggingMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        start = time.perf_counter()
        status = {"code": None}
        bytes_sent = 0

        async def wrapped_send(message):
            nonlocal bytes_sent
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
            elif message["type"] == "http.response.body":
                bytes_sent += len(message.get("body", b""))
            await send(message)

        await self.app(scope, receive, wrapped_send)

        duration_ms = (time.perf_counter() - start) * 1000.0
        # scope["path"] already has root_path baked in by the ASGI server (see
        # uvicorn's httptools_impl.py: `scope["path"] = root_path + path`) --
        # root_path is exposed separately too, but only for apps that need it
        # standalone (e.g. URL generation). Concatenating it here double-counts.
        path = scope["path"]
        log.info(
            "%s %s %s %.2fms %db",
            scope["method"],
            path,
            status["code"],
            duration_ms,
            bytes_sent,
            extra={
                "method": scope["method"],
                "path": path,
                "status": status["code"],
                "duration_ms": duration_ms,
                "bytes": bytes_sent,
            },
        )
