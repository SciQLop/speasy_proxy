from fastapi.responses import PlainTextResponse
from .routes import router
from speasy_proxy import __version__
import logging

log = logging.getLogger(__name__)


@router.get('/get_version', response_class=PlainTextResponse, description='Get the version of speasy_proxy server')
def get_version():
    log.debug('Client asking for version')
    return PlainTextResponse(content=__version__)
