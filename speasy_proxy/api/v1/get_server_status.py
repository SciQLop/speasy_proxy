from fastapi.responses import JSONResponse
from .routes import router
from fastapi.encoders import jsonable_encoder
import logging
from speasy_proxy.backend import status

log = logging.getLogger(__name__)


@router.get('/get_server_status', description='Get server status', response_class=JSONResponse)
async def get_server_status():
    log.debug(f'Client asking for server status')
    return JSONResponse(content=jsonable_encoder(status()))
