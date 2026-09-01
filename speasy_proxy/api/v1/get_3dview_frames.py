import logging

from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

import speasy as spz

from .routes import router

log = logging.getLogger(__name__)


@router.get('/get_3dview_frames', response_class=JSONResponse,
            description='Get the coordinate frames available from the 3DView provider')
async def get_3dview_frames():
    if not hasattr(spz, 'cdpp3dview'):
        # Disabled (SPEASY_CORE_DISABLED_PROVIDERS) or running a speasy version
        # without 3DView support -- not an error, just nothing to offer.
        return JSONResponse(content={"frames": []})
    try:
        frames = await run_in_threadpool(spz.cdpp3dview.get_frames)
    except Exception:
        log.exception("Failed to retrieve 3DView coordinate frames.")
        frames = []
    return JSONResponse(content={"frames": frames})
