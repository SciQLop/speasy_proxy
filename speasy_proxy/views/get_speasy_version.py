from pyramid.view import view_config
from pyramid.response import Response
from speasy import __version__
import logging

log = logging.getLogger(__name__)


@view_config(route_name='get_speasy_version', openapi=True)
def get_cache_entries(request):
    return Response(content_type="text/plain", body=__version__)
