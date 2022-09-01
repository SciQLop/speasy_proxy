from datetime import datetime, timedelta

from pyramid.view import view_config
import speasy as spz
from pyramid.response import Response
import logging
from random import choice, uniform
from ..bokeh_backend import plot_data

log = logging.getLogger(__name__)


def random_pick_product():
    provider = choice(['amda', 'cda', 'ssc'])
    product = choice(list(spz.inventories.flat_inventories.__dict__[provider].parameters.values()))
    log.debug(f'Pick {product}: {product.spz_provider()}/{product.spz_uid()}')
    return product


def get_product_random_range(product):
    max_range = spz.core.dataprovider.PROVIDERS[product.spz_provider()]._parameter_range(product)
    for i in range(3):
        start_ts = uniform(max_range.start_time.timestamp(), max_range.stop_time.timestamp() - (3600 * 24))
        data = spz.get_data(product, datetime.utcfromtimestamp(start_ts),
                            datetime.utcfromtimestamp(start_ts) + timedelta(hours=24))
        if data is not None:
            log.debug(f'Got data, shape: {data.values.shape}')
            if len(data) > 10000:
                data = data[:10000]
            return product, data.replace_fillval_by_nan(inplace=True)
    return product, None


@view_config(route_name='chart_roulette')
def chart_roulette(request):
    log.debug(f'Client asking for random plot page from {request.user_agent}')
    return Response(plot_data(*get_product_random_range(random_pick_product()), request) or "Oops try again")
