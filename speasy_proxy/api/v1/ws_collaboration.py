from asyncio import create_task

from fastapi import WebSocket
from pycrdt_websocket import WebsocketServer
from pycrdt_websocket.websocket import HttpxWebsocket

from .routes import router


@router.websocket("/collaboration")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    websocket_server = await get_websocket_server()
    await websocket_server.serve(HttpxWebsocket(websocket, "collaboration"))


async def get_websocket_server():
    global WEBSOCKET_SERVER
    if WEBSOCKET_SERVER is None:
        WEBSOCKET_SERVER = WebsocketServer()
        create_task(WEBSOCKET_SERVER.start())
        await WEBSOCKET_SERVER.started.wait()
    return  WEBSOCKET_SERVER


WEBSOCKET_SERVER = None
