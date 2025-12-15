from fastapi.responses import JSONResponse
from fastapi import Request
from .routes import router
from .query_parameters import QueryProvider
import logging
from speasy.core.http import is_server_up
from speasy.core.cache import CacheCall
from speasy.data_providers import CdaWebservice, CsaWebservice, SscWebservice, AmdaWebservice
from speasy.data_providers.uiowa_eph_tool import UiowaEphTool

log = logging.getLogger(__name__)

PROVIDERS = {
    'cda': CdaWebservice,
    'csa': CsaWebservice,
    'ssc': SscWebservice,
    'amda': AmdaWebservice,
    'uiowaephtool': UiowaEphTool,
}


# TODO: migrate this when Speasy 1.7.1 is released
@CacheCall(cache_retention=60, is_pure=True)
def is_server_up(ws_class):
    """Check if the webservice server is up. Will first look for an 'is_server_up' method in the class,
    then for a 'BASE_URL' attribute to use the generic 'is_server_up' function finally returns True if none of these are found.

    Parameters
    ----------
    ws_class : class
        The webservice class to check.
    Returns
    -------
    bool
        True if the server is up, False otherwise.
    """
    if hasattr(ws_class, 'is_server_up'):
        return ws_class.is_server_up()
    elif hasattr(ws_class, 'BASE_URL'):
        return is_server_up(ws_class.BASE_URL)
    return True


@router.get('/is_up', response_class=JSONResponse, description='Check if the server is up')
def is_up(request: Request, provider: str = QueryProvider):
    log.debug(f'Client asking if {provider} is up')
    ws_class = PROVIDERS.get(provider.lower())
    response = {
        'provider': provider,
        'is_up': False
    }
    if ws_class:
        response['is_up'] = is_server_up(ws_class)
        return JSONResponse(content=response)
    else:
        response['error'] = f'Provider {provider} not found'
        return JSONResponse(content=response, status_code=404)
