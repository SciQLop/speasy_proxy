from .routes import router
import logging
from speasy_proxy.backend import status
from .models import ServerStatus

log = logging.getLogger(__name__)


@router.get('/get_server_status', description='Get server status', response_model=ServerStatus)
async def get_server_status():
    log.debug('Client asking for server status')
    return status()
