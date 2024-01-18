__author__ = """Alexis Jeandet"""
__email__ = 'alexis.jeandet@member.fsf.org'
__version__ = '0.9.0'

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os
from datetime import datetime, UTC
from .index import up_since
from .api.v1 import api_router as v1_api_router
from .frontend import frontend_router
from apscheduler.schedulers.background import BackgroundScheduler
import logging
from .backend.inventory_updater import ensure_update_inventory

log = logging.getLogger(__name__)

scheduler = BackgroundScheduler()

scheduler.add_job(ensure_update_inventory, 'interval', hours=2)

scheduler.start()


def get_application() -> FastAPI:
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


app = get_application()
