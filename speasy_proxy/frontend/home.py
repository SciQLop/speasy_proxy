from fastapi import Request, Header
from typing import Annotated
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from .routes import router
import logging
import os

log = logging.getLogger(__name__)

templates = Jinja2Templates(directory=f"{os.path.dirname(os.path.abspath(__file__))}/../templates")


def _build_base_url(request: Request, x_scheme: str | None = None) -> str:
    scheme = x_scheme or request.url.scheme
    base_url = str(scheme) + "://" + str(request.url.netloc)
    root_path = request.scope.get('root_path', '')
    if root_path:
        base_url = base_url.rstrip('/') + root_path.rstrip('/')
    if base_url.endswith('/'):
        base_url = base_url[:-1]
    return base_url


@router.get('/', response_class=HTMLResponse)
def home(request: Request, user_agent: Annotated[str | None, Header()] = None,
         x_scheme: Annotated[str | None, Header()] = None):
    log.debug(f'Client asking for home page from {user_agent}')
    base_url = _build_base_url(request, x_scheme)
    return templates.TemplateResponse(request, name="index.html", context={"request": request, 'base_url': base_url})


@router.get('/plot', response_class=HTMLResponse)
def plot(request: Request, x_scheme: Annotated[str | None, Header()] = None):
    base_url = _build_base_url(request, x_scheme)
    return templates.TemplateResponse(request, name="plot.html", context={"request": request, 'base_url': base_url})
