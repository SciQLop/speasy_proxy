from pyramid.view import view_config
from spwc import cache
from humanize import filesize,time
from datetime import datetime
from ..index import index

@view_config(route_name='home', renderer='../templates/welcome.jinja2')
def my_view(request):
    up_since = index["up_since"]
    up_time = datetime.now() - up_since
    cache_stats = cache.stats()
    return {'entries': cache.cache_len(),
            'cache_disk_size': filesize.naturalsize(cache.cache_disk_size()),
            'up_date': time.naturaldate(up_since),
            'up_duration': time.naturaldelta(up_time),
            'cache_hits': str(cache_stats['hit']),
            'cache_misses': str(cache_stats['misses'])
            }
