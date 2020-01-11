from pyramid.view import view_config
from spwc import cache
from humanize import filesize


@view_config(route_name='home', renderer='../templates/welcome.jinja2')
def my_view(request):
    return {'entries' : cache.cache_len(), 'cache_disk_size':filesize.naturalsize(cache.cache_disk_size())}
