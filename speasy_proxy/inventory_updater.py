from functools import wraps
from datetime import datetime, timedelta
from typing import Callable
import speasy as spz
import logging

_last_update = datetime.utcnow()

log = logging.getLogger(__name__)


class EnsureUpdatedInventory(object):
    def __init__(self):
        pass

    def __call__(self, function: Callable):
        @wraps(function)
        def wrapped(*args, **kwargs):
            global _last_update
            if datetime.utcnow() > (_last_update + timedelta(minutes=30)):
                log.debug("Updating runtime inventory")
                spz.update_inventories()
                _last_update = datetime.utcnow()
            return function(*args, **kwargs)

        return wrapped
