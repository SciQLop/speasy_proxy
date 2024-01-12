from fastapi.responses import JSONResponse
from .routes import router
from fastapi.encoders import jsonable_encoder
import logging
from speasy_proxy.backend import statistics

log = logging.getLogger(__name__)


@router.get('/get_statistics', description='Get cache statistics', response_class=JSONResponse)
async def get_statistics():
    log.debug(f'Client asking for statistics')
    return JSONResponse(content=jsonable_encoder(statistics()))
