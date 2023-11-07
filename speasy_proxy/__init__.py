__author__ = """Alexis Jeandet"""
__email__ = 'alexis.jeandet@member.fsf.org'
__version__ = '0.8.0'

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os
from datetime import datetime
from .index import index
from .api.v1 import api_router as v1_api_router
from .frontend import frontend_router
from apscheduler.schedulers.background import BackgroundScheduler
import speasy as spz
import logging

log = logging.getLogger(__name__)


def background_inventory_refresh():
    log.info("Background inventory refresh")
    spz.update_inventories()


scheduler = BackgroundScheduler()

scheduler.add_job(background_inventory_refresh, 'interval', hours=2)

scheduler.start()


def get_application() -> FastAPI:
    _app = FastAPI(
        title="speasy-proxy",
        description="A fast speasy cache server",
        debug=True,
    )
    _app.include_router(frontend_router)
    _app.include_router(v1_api_router)
    _app.mount("/static", StaticFiles(directory=f"{os.path.dirname(os.path.abspath(__file__))}/static"), name="static")

    index["up_since"] = datetime.now()

    _app.add_middleware(
        CORSMiddleware,
        allow_origins=[str(origin) for origin in []],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    return _app


app = get_application()
