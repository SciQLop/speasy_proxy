from functools import wraps
from datetime import datetime, timedelta, UTC
from typing import Callable
import speasy as spz
from speasy.core.cache import CacheCall
import logging
import threading
from ..index import IndexEntry

log = logging.getLogger(__name__)
lock = threading.Lock()

last_update = IndexEntry("last_update", datetime.now(UTC) - timedelta(days=1))


@CacheCall(cache_retention=timedelta(minutes=30))
def ensure_update_inventory():
    if datetime.now(UTC) > (last_update.value() + timedelta(minutes=30)):
        with lock:
            log.debug("Updating runtime inventory")
            spz.update_inventories()
            last_update.set(datetime.now(UTC))


class EnsureUpdatedInventory(object):
    def __init__(self):
        pass

    def __call__(self, function: Callable):
        @wraps(function)
        def wrapped(*args, **kwargs):
            ensure_update_inventory()
            return function(*args, **kwargs)

        return wrapped
