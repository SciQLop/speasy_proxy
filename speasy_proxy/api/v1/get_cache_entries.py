from fastapi import Response
from .routes import router
from speasy.core import cache
import logging
from speasy_proxy.api.pickle import pickle_data
from .query_parameters import QueryPickleProto

log = logging.getLogger(__name__)


@router.get('/get_cache_entries', description='Get the all cache entries keys actually in the cache')
async def get_cache_entries(pickle_proto: int = QueryPickleProto):
    log.debug(f'Client asking for cache entries')
    return Response(media_type="application/python-pickle", content=pickle_data(cache.entries(), pickle_proto))
