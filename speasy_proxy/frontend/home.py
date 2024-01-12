from fastapi import Request, Header
from typing import Annotated
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from .routes import router
from speasy.core.cache import _cache
from speasy import inventories
from humanize import filesize, time
from datetime import datetime, UTC
import logging
from speasy_proxy.index import up_since
from speasy_proxy.backend.inventory_updater import ensure_update_inventory, last_update
import os
from threading import Thread
from urllib.parse import urljoin

log = logging.getLogger(__name__)

index_html = open(f'{os.path.dirname(os.path.abspath(__file__))}/../static/index.html').read()


@router.get('/', response_class=HTMLResponse)
def home(request: Request, user_agent: Annotated[str | None, Header()] = None):
    log.debug(f'Client asking for home page from {user_agent}')
    return HTMLResponse(content=index_html, status_code=200)
