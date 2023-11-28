from fastapi import Request, Header
from typing import Annotated
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from .routes import router
from speasy.core import cache
from speasy import inventories
from humanize import filesize, time
from datetime import datetime, UTC
import logging
from speasy_proxy.index import index
from speasy_proxy.backend.inventory_updater import _last_update, ensure_update_inventory
import os
from threading import Thread
from urllib.parse import urljoin

log = logging.getLogger(__name__)

_inventory_refresh_thread = None


def _refresh_inventory():
    global _inventory_refresh_thread
    if _inventory_refresh_thread is None or not _inventory_refresh_thread.is_alive():
        _inventory_refresh_thread = Thread(target=ensure_update_inventory)
        _inventory_refresh_thread.start()


templates = Jinja2Templates(directory=f"{os.path.dirname(os.path.abspath(__file__))}/../templates")


@router.get('/', response_class=HTMLResponse)
def home(request: Request, user_agent: Annotated[str | None, Header()] = None):
    log.debug(f'Client asking for home page from {user_agent}')
    up_since = index["up_since"]
    up_time = datetime.now(UTC) - up_since
    cache_stats = cache.stats()
    _refresh_inventory()
    return templates.TemplateResponse("welcome.html",
                                      {"request": request,
                                       'entries': cache.cache_len(),
                                       'cache_disk_size': filesize.naturalsize(
                                           cache.cache_disk_size()),
                                       'up_date': time.naturaldate(up_since),
                                       'up_duration': time.naturaldelta(up_time),
                                       'cache_hits': str(cache_stats['hit']),
                                       'cache_misses': str(cache_stats['misses']),
                                       'inventory_update': str(_last_update.isoformat()),
                                       'inventory_size': str(
                                           sum(map(lambda p: len(p.parameters),
                                                   set(inventories.flat_inventories.__dict__.values())))),
                                       'docs': urljoin(str(request.base_url), "docs"),
                                       })
