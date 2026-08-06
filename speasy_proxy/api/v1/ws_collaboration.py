from speasy_proxy.config import collab_endpoint
import logging

log = logging.getLogger(__name__)

if collab_endpoint.enable():
    from asyncio import create_task, Lock
    from fastapi import WebSocket
    from pycrdt_websocket import WebsocketServer
    from pycrdt_websocket.websocket import HttpxWebsocket
    from .routes import router

    _init_lock = Lock()

    @router.websocket("/collaboration/{path:path}")
    async def websocket_endpoint(path: str, websocket: WebSocket):
        await websocket.accept()
        websocket_server = await get_websocket_server()
        await websocket_server.serve(HttpxWebsocket(websocket, path))


    async def get_websocket_server():
        # Double-checked locking (BL-33): concurrent first connections must all
        # wait for the single shared server to be fully started.
        global WEBSOCKET_SERVER
        if WEBSOCKET_SERVER is None:
            async with _init_lock:
                if WEBSOCKET_SERVER is None:
                    server = WebsocketServer()
                    create_task(server.start())
                    await server.started.wait()
                    WEBSOCKET_SERVER = server
        return WEBSOCKET_SERVER


    WEBSOCKET_SERVER = None

else:
    log.info(f'Collaboration endpoint is disabled, set {collab_endpoint.enable.env_var_name} to True to enable it')
