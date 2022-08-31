from datetime import datetime, timedelta

from pyramid.view import view_config
import speasy as spz
from bokeh.plotting import figure
from bokeh.resources import CDN
from bokeh.embed import file_html
from bokeh.palettes import Dark2_5 as palette
import itertools
from pyramid.response import Response
import logging
from random import choice, uniform

log = logging.getLogger(__name__)


def random_pick_product():
    provider = choice(['amda', 'cda', 'ssc'])
    product = choice(list(spz.inventories.flat_inventories.__dict__[provider].parameters.values()))
    log.debug(f'Pick {product}')
    return product


def get_product_random_range(product):
    max_range = spz.core.dataprovider.PROVIDERS[product.spz_provider()]._parameter_range(product)
    for i in range(10):
        start_ts = uniform(max_range.start_time.timestamp(), max_range.stop_time.timestamp() - (3600 * 24))
        data = spz.get_data(product, datetime.utcfromtimestamp(start_ts),
                            datetime.utcfromtimestamp(start_ts) + timedelta(hours=24))
        if data is not None:
            log.debug(f'Got data')
            if len(data) > 10000:
                data = data[:10000]
            return product, data.replace_fillval_by_nan(inplace=True)
    return product, None


def plot_vector(product, data):
    if len(data) > 0:
        plot = figure(plot_width=900, plot_height=500, x_axis_type="datetime", sizing_mode='stretch_both',
                      title=f"{product.spz_uid()} from {product.spz_provider()} between {str(data.time[0])} {str(data.time[-1])}")
        colors = itertools.cycle(palette)
        for comp, color in zip(range(data.values.shape[1]), colors):
            plot.line(data.time, data.values[:, comp], legend_label=data.columns[comp], line_color=color)
        html = file_html(plot, CDN, "my plot")
        return html


def plot_data(product, data):
    if data is not None:
        if len(data.values.shape) == 2 and data.values.shape[1] < 6:
            return plot_vector(product, data)
    log.debug(f"Can't plot {product}")


@view_config(route_name='chart_roulette')
def chart_roulette(request):
    log.debug(f'Client asking for random plot page from {request.user_agent}')
    return Response(plot_data(*get_product_random_range(random_pick_product())) or "Oops try again")
