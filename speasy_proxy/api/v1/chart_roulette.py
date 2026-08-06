from datetime import datetime, timedelta, UTC

from fastapi import Request, Header
from typing import Annotated
from fastapi.responses import HTMLResponse
from .routes import router
import speasy as spz
import logging
from random import choice, uniform
from speasy_proxy.backend.bokeh_backend import plot_data

log = logging.getLogger(__name__)


def random_pick_product():
    provider = choice(['amda', 'cda', 'ssc'])
    product = choice(list(spz.inventories.flat_inventories.__dict__[provider].parameters.values()))
    log.debug(f'Pick {product}: {product.spz_provider()}/{product.spz_uid()}')
    return product


def get_product_random_range(product, request):
    max_range = spz.core.dataprovider.PROVIDERS[product.spz_provider()]._parameter_range(product)
    for i in range(3):
        start_ts = uniform(max_range.start_time.timestamp(), max_range.stop_time.timestamp() - (3600 * 24))
        start = datetime.fromtimestamp(start_ts, tz=UTC)
        stop = datetime.fromtimestamp(start_ts, tz=UTC) + timedelta(hours=24)
        log.debug(f'Pick range: {start} -> {stop}')
        if 'X-Forwarded-For' in request.headers:
            extra_http_headers = {'X-Forwarded-For': request.headers['X-Forwarded-For']}
        else:
            extra_http_headers = None
        data = spz.get_data(product, start, stop, extra_http_headers=extra_http_headers)
        if data is not None:
            log.debug(f'Got data, shape: {data.values.shape}')
            if len(data) > 10000:
                data = data[:10000]
            return product, data.replace_fillval_by_nan(inplace=True, convert_to_float=True), start, stop
    # No usable range to report when every attempt failed (BL-22)
    return product, None, None, None


@router.get('/chart_roulette', response_class=HTMLResponse, description='Get a random plot page')
def chart_roulette(request: Request, user_agent: Annotated[str | None, Header()] = None):
    log.debug(f'Client asking for random plot page from {user_agent}')
    # A random walk over live providers hits edge cases (empty inventories,
    # products without a known range, ranges shorter than the 24h window...);
    # never let one turn the fun endpoint into a 500 (BL-32).
    try:
        product, data, start, stop = get_product_random_range(random_pick_product(), request)
        content = plot_data(product, data, start, stop, request)
    except Exception:
        log.exception('chart_roulette failed to produce a plot')
        content = "Oops, try again"
    return HTMLResponse(content=content)
