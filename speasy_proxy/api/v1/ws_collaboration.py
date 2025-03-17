from speasy_proxy.config import collab_endpoint
import logging

log = logging.getLogger(__name__)

if collab_endpoint.enable():
    from asyncio import create_task
    from fastapi import WebSocket
    from pycrdt_websocket import WebsocketServer
    from pycrdt_websocket.websocket import HttpxWebsocket
    from .routes import router


    @router.websocket("/collaboration/{path:path}")
    async def websocket_endpoint(path: str, websocket: WebSocket):
        await websocket.accept()
        websocket_server = await get_websocket_server()
        await websocket_server.serve(HttpxWebsocket(websocket, path))


    async def get_websocket_server():
        global WEBSOCKET_SERVER
        if WEBSOCKET_SERVER is None:
            WEBSOCKET_SERVER = WebsocketServer()
            create_task(WEBSOCKET_SERVER.start())
            await WEBSOCKET_SERVER.started.wait()
        return WEBSOCKET_SERVER


    WEBSOCKET_SERVER = None

else:
    log.info(f'Collaboration endpoint is disabled, set {collab_endpoint.enable.env_var_name} to True to enable it')
