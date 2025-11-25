__author__ = """Alexis Jeandet"""
__email__ = 'alexis.jeandet@member.fsf.org'
__version__ = '0.13.1'

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os
from datetime import datetime, UTC
from .index import up_since
from .api.v1 import api_router as v1_api_router
from .frontend import frontend_router
import logging
from .backend.inventory_updater import update_inventory
from contextlib import asynccontextmanager

log = logging.getLogger(__name__)


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
    _app.mount("/static/", StaticFiles(directory=f"{os.path.dirname(os.path.abspath(__file__))}/static"), name="static")

    up_since.set(datetime.now(UTC))

    _app.add_middleware(
        CORSMiddleware,
        allow_origins=[str(origin) for origin in []],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    return _app


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Lifespan context manager for the FastAPI application.
    This is used to perform startup and shutdown tasks.
    """
    log.info("Starting up speasy-proxy...")
    await update_inventory()
    yield
    log.info("Shutting down speasy-proxy...")

app = get_application(lifespan=lifespan)

