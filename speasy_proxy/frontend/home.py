from fastapi import Request, Header
from typing import Annotated
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from .routes import router
from ..config import sciqlopplots as sciqlopplots_cfg
import logging
import os

log = logging.getLogger(__name__)

# Wasm threads need SharedArrayBuffer, which browsers only give cross-origin isolated
# pages. credentialless rather than require-corp: the page also loads flatpickr from a CDN.
CROSS_ORIGIN_ISOLATION = {"Cross-Origin-Opener-Policy": "same-origin",
                          "Cross-Origin-Embedder-Policy": "credentialless"}

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


def _plot_backend(requested: str | None) -> str:
    return "sciqlopplots" if requested == "sciqlopplots" and sciqlopplots_cfg.path.get() else ""


@router.get('/plot', response_class=HTMLResponse)
def plot(request: Request, backend: str | None = None, x_scheme: Annotated[str | None, Header()] = None):
    base_url = _build_base_url(request, x_scheme)
    plot_backend = _plot_backend(backend)
    response = templates.TemplateResponse(request, name="plot.html", context={
        "request": request, 'base_url': base_url, 'plot_backend': plot_backend})
    if plot_backend:
        response.headers.update(CROSS_ORIGIN_ISOLATION)
    return response


@router.get('/demo_3d', response_class=HTMLResponse)
def demo_3d(request: Request, x_scheme: Annotated[str | None, Header()] = None):
    base_url = _build_base_url(request, x_scheme)
    return templates.TemplateResponse(request, name="demo_3d.html", context={"request": request, 'base_url': base_url})
