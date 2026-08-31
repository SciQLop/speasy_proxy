__author__ = """Alexis Jeandet"""
__email__ = 'alexis.jeandet@member.fsf.org'
__version__ = '0.16.0'

import asyncio
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
from .backend.cache_scrubber import periodic_scrub_loop
from .config import core as config
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
    _app.mount("/static/", RevalidatingJSStaticFiles(directory=f"{os.path.dirname(os.path.abspath(__file__))}/static"), name="static")

    up_since.set(datetime.now(UTC))

    _app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
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
    ))
    yield
    task.cancel()
    scrub_task.cancel()
    log.info("Shutting down speasy-proxy...")

app = get_application(lifespan=lifespan)

