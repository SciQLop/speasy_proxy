from speasy.core.cache import _cache
from speasy_proxy.index import up_since
from speasy_proxy import __version__
from datetime import datetime, UTC, timedelta
import speasy as spz


def status(last_inventory_update: datetime = None, update_interval_seconds: int = 7200, inventory_size: str = "0"):
    _up_since = up_since.value()
    up_time = datetime.now(UTC) - _up_since

    # No transact(): on a plain (non-Fanout) Cache it's a whole-cache exclusive lock,
    # which at production scale (millions of entries) blocks every other cache user
    # for as long as len()/disk_size() take -- and those aren't cheap either at that
    # size. A perfectly consistent snapshot of these two numbers isn't worth that.
    cache_len = len(_cache)
    cache_disk = _cache.disk_size()
    return {
        'entries': cache_len,
        'cache_disk_size': cache_disk,
        'up_since': _up_since.isoformat(),
        'up_duration': up_time.total_seconds(),
        'last_inventory_update': last_inventory_update.isoformat() if last_inventory_update else 'never',
        'inventory_size': inventory_size,
        'docs': 'https://speasyproxy.readthedocs.io/en/latest/',
        'speasy_version': spz.__version__,
        'version': __version__,
        'inventory_update_interval': str(timedelta(seconds=update_interval_seconds)),
    }
