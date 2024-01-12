from speasy.core.cache import _cache
from speasy_proxy.index import up_since
from speasy_proxy import __version__
from speasy_proxy.backend.inventory_updater import ensure_update_inventory, last_update
from datetime import datetime, UTC
import speasy as spz


def statistics():
    """Return statistics about the backend."""
    _up_since = up_since.value()
    up_time = datetime.now(UTC) - _up_since

    with _cache.transact():
        cache_stats = _cache.stats()
        cache_len = len(_cache)
        cache_disk = _cache.disk_size()
    return {
        'entries': cache_len,
        'cache_disk_size': cache_disk,
        'up_since': _up_since.isoformat(),
        'up_duration': up_time.total_seconds(),
        'cache_hits': cache_stats['hit'],
        'cache_misses': cache_stats['misses'],
        'inventory_update': last_update.value().isoformat(),
        'inventory_size': str(
            sum(map(lambda p: len(p.parameters),
                    set(spz.inventories.flat_inventories.__dict__.values())))),
        'docs': 'https://speasyproxy.readthedocs.io/en/latest/',
        'speasy_version': spz.__version__,
        'version': __version__
    }
