from pyramid.view import view_config
from pyramid.response import Response
import pickle
from spwc import cache
import logging

log = logging.getLogger(__name__)


@view_config(route_name='get_cache_entries', openapi=True)
def get_cache_entries(request):
    return Response(content_type="text/plain", body=pickle.dumps(cache.entries()))
