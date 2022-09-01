from datetime import datetime, timedelta

from pyramid.view import view_config
import speasy as spz
from bokeh.plotting import figure
from bokeh.models import CrosshairTool, DataRange1d, LogScale
from bokeh.resources import CDN
from bokeh.embed import file_html
from bokeh.palettes import Set1_9 as palette
import itertools
from pyramid.response import Response
import logging
from random import choice, uniform
import numpy as np

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
            log.debug(f'Got data')
            if len(data) > 10000:
                data = data[:10000]
            return product, data.replace_fillval_by_nan(inplace=True)
    return product, None


def plot_vector(plot, product, data):
    if len(data) > 0:
        colors = itertools.cycle(palette)
        if len(data.columns) != data.values.shape[1]:
            columns = [f'component {i}' for i in range(data.values.shape[1])]
        else:
            columns = data.columns
        for comp, color in zip(range(data.values.shape[1]), colors):
            plot.line(data.time, data.values[:, comp], legend_label=columns[comp], line_color=color)
        html = file_html(plot, CDN, "my plot")
        return html


def plot_spectrogram(plot, product, data):
    if len(data) > 0:
        def map_color(values):
            from matplotlib import cm, colors
            norm = colors.LogNorm(vmin=max(np.nanmin(values), 1e-10), vmax=np.nanmax(values))
            viridis = cm.get_cmap('viridis')
            img = np.empty(values.shape, dtype=np.uint32)

            #            for i in range(values.shape[0]):
            #                for j in range(values.shape[1]):
            def pix(v):
                c = viridis(norm(v))
                return (255 * 256 * 256 * 256) + int(c[2] * 255) * 256 * 256 + (int(c[1] * 255) * 256) + int(c[0] * 255)

            img = np.vectorize(pix)(values)
            return img

        image = map_color(data.values)
        plot.x_range = DataRange1d(data.time[0], data.time[-1])
        plot.y_scale = LogScale()
        plot.image_rgba(image=[image.transpose()], x=data.time[0], y=data.axes[1][0],
                        dw=data.time[-1] - data.time[0], dh=data.axes[1][-1] - data.axes[1][0])
        html = file_html(plot, CDN, "my plot")
        return html


def plot_data(product, data):
    if data is not None and len(data) > 0:
        plot = figure(plot_width=900, plot_height=500, x_axis_type="datetime", sizing_mode='stretch_both',
                      title=f"{product.spz_uid()} from {product.spz_provider()} between {str(data.time[0])} {str(data.time[-1])}"
                      )
        plot.add_tools(CrosshairTool())
        if len(data.values.shape) == 2 and data.values.shape[1] < 6:
            return plot_vector(plot, product, data)
        if len(data.values.shape) == 2 and data.meta.get('DISPLAY_TYPE', '') == 'spectrogram':
            return plot_spectrogram(plot, product, data)
    log.debug(f"Can't plot {product}")


@view_config(route_name='chart_roulette')
def chart_roulette(request):
    log.debug(f'Client asking for random plot page from {request.user_agent}')
    return Response(plot_data(*get_product_random_range(random_pick_product())) or "Oops try again")
