from fastapi.responses import PlainTextResponse
from .routes import router
import speasy as spz
import logging

log = logging.getLogger(__name__)


@router.get('/get_speasy_version', response_class=PlainTextResponse,
            description='Get the version of speasy used by the server')
def get_speasy_version():
    log.debug('Client asking for speasy version')
    return PlainTextResponse(content=spz.__version__)
