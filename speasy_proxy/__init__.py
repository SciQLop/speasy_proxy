__author__ = """Alexis Jeandet"""
__email__ = 'alexis.jeandet@member.fsf.org'
__version__ = '0.25.1'

import asyncio
import contextlib
from datetime import timedelta
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os
from datetime import datetime, UTC
from .index import up_since
from .api.v1 import api_router as v1_api_router
from .frontend import frontend_router
import logging
from .backend.inventory_updater import InventoryManager
from .backend.cache_scrubber import periodic_scrub_loop, scrub_state_path
from .backend.shared_inventory_store import SharedInventoryStore
from .backend.request_logging import RequestLoggingMiddleware
from .config import core as config, index as index_cfg
from .hapi import create_hapi_app
from contextlib import asynccontextmanager
import speasy as spz

log = logging.getLogger(__name__)

log.info("Updating inventories at import time (runs once with --preload)...")
spz.update_inventories()
log.info("Inventories updated.")


class RevalidatingJSStaticFiles(StaticFiles):
    # Unbundled, unhashed JS modules: without forced revalidation, browsers can
    # heuristically cache one imported module fresh and its importer stale (or
    # vice versa) across a deploy, breaking `import` resolution.
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if path.endswith(".js"):
            response.headers["Cache-Control"] = "no-cache"
        return response


def _make_hapi_app(parent: FastAPI) -> FastAPI:
    def tree_lock():
        # The inventory manager only exists once the parent app's lifespan has started.
        mgr = getattr(parent.state, "inventory_manager", None)
        return mgr.tree_lock if mgr is not None else contextlib.nullcontext()

    return create_hapi_app(
        fetch=lambda path, start, stop, **options: spz.get_data(path, start, stop, **options),
        info_cache_path=os.path.join(index_cfg.path(), "hapi_info"),
        max_request_duration=timedelta(days=config.max_query_span_days.get()),
        server_id="speasy-proxy",
        title="speasy-proxy",
        contact="https://github.com/SciQLop/speasy_proxy/issues",
        tree_lock=tree_lock,
        cors=False,  # added to the whole app below
    )


def get_application(lifespan=None) -> FastAPI:
    root_path = os.environ.get('SPEASY_PROXY_PREFIX', '')
    if root_path:
        log.info(f'Root path set to {root_path}')
        if not root_path.startswith('/'):
            root_path = '/' + root_path
        if root_path.endswith('/'):
            root_path = root_path[:-1]
    else:
        root_path = ''

    _app = FastAPI(
        title="speasy-proxy",
        description="A fast speasy cache server",
        debug=False,
        root_path=root_path,
        lifespan=lifespan
    )
    _app.include_router(frontend_router)
    _app.include_router(v1_api_router)
    _app.mount("/hapi", _make_hapi_app(_app))
    _app.mount("/static/", RevalidatingJSStaticFiles(directory=f"{os.path.dirname(os.path.abspath(__file__))}/static"), name="static")

    up_since.set(datetime.now(UTC))

    _app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    # Added last so it wraps outermost (FastAPI/Starlette: last-added middleware
    # runs first on the way in), timing the full request including CORS.
    _app.add_middleware(RequestLoggingMiddleware)
    # No GZipMiddleware: Starlette's implementation compresses response bodies
    # synchronously on the event loop (no threadpool option), which this project
    # otherwise deliberately avoids (see api/compression.py's compress_if_asked,
    # always run via run_in_threadpool/a background thread). gzip for plain
    # JSON/HTML responses is expected to be handled by the reverse proxy this
    # app is deployed behind (see SPEASY_PROXY_PREFIX); zstd_compression=true
    # requests are already compressed off-loop by compress_if_asked.
    return _app


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Starting up speasy-proxy...")
    mgr = InventoryManager(update_interval_seconds=config.inventory_update_interval.get())
    app.state.inventory_manager = mgr
    mgr.build_inventories()
    task = asyncio.create_task(mgr.periodic_update_loop())
    scrub_task = asyncio.create_task(periodic_scrub_loop(
        interval_seconds=config.cache_scrub_interval.get(),
        batch_size=config.cache_scrub_batch_size.get(),
        store=SharedInventoryStore(scrub_state_path()),
    ))
    yield
    task.cancel()
    scrub_task.cancel()
    log.info("Shutting down speasy-proxy...")

app = get_application(lifespan=lifespan)

