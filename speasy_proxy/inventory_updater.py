from functools import wraps
from datetime import datetime, timedelta, UTC
from typing import Callable
import speasy as spz
import logging

_last_update = datetime.now(UTC)

log = logging.getLogger(__name__)


def ensure_update_inventory():
    global _last_update
    if datetime.now(UTC) > (_last_update + timedelta(minutes=30)):
        log.debug("Updating runtime inventory")
        spz.update_inventories()
        _last_update = datetime.now(UTC)


class EnsureUpdatedInventory(object):
    def __init__(self):
        pass

    def __call__(self, function: Callable):
        @wraps(function)
        def wrapped(*args, **kwargs):
            ensure_update_inventory()
            return function(*args, **kwargs)

        return wrapped
