from fastapi import Request, Header
from typing import Annotated
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from .routes import router
import logging
import os

log = logging.getLogger(__name__)

templates = Jinja2Templates(directory=f"{os.path.dirname(os.path.abspath(__file__))}/../templates")


@router.get('/', response_class=HTMLResponse)
def home(request: Request, user_agent: Annotated[str | None, Header()] = None):
    log.debug(f'Client asking for home page from {user_agent}')
    base_url = str(request.base_url)
    if base_url.endswith('/'):
        base_url = base_url[:-1]
    return templates.TemplateResponse("index.html", {"request": request, 'base_url': base_url})
