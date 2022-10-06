from pyramid.view import view_config
from speasy.core import cache
from speasy import inventories
from humanize import filesize, time
from datetime import datetime
import logging
from ..index import index
from ..inventory_updater import _last_update, ensure_update_inventory
from threading import Thread

log = logging.getLogger(__name__)

_inventory_refresh_thread = None


def _refresh_inventory():
    global _inventory_refresh_thread
    if _inventory_refresh_thread is None or not _inventory_refresh_thread.is_alive():
        _inventory_refresh_thread = Thread(target=ensure_update_inventory)
        _inventory_refresh_thread.start()


@view_config(route_name='home', renderer='../templates/welcome.jinja2')
def home(request):
    log.debug(f'Client asking for home page from {request.user_agent}')
    up_since = index["up_since"]
    up_time = datetime.now() - up_since
    cache_stats = cache.stats()
    _refresh_inventory()
    return {'entries': cache.cache_len(),
            'cache_disk_size': filesize.naturalsize(cache.cache_disk_size()),
            'up_date': time.naturaldate(up_since),
            'up_duration': time.naturaldelta(up_time),
            'cache_hits': str(cache_stats['hit']),
            'cache_misses': str(cache_stats['misses']),
            'inventory_update': str(_last_update.isoformat()),
            'inventory_size': str(
                sum(map(lambda p: len(p.parameters), set(inventories.flat_inventories.__dict__.values()))))
            }
