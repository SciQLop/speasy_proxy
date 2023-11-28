import itertools
import logging
import traceback

from fastapi import Request
import numpy as np
from bokeh.embed import components
from bokeh.events import RangesUpdate
from bokeh.layouts import column
from bokeh.models import (ColumnDataSource, CrosshairTool, CustomJS, DatetimeTickFormatter,
                          DataRange1d, Div, HoverTool, Paragraph, WheelPanTool)
from bokeh.models import TabPanel, Tabs, Spacer
from bokeh.palettes import Set1_9 as palette
from bokeh.plotting import figure
from bokeh.resources import INLINE
from jinja2 import Template
from speasy.core.requests_scheduling.request_dispatch import \
    provider_and_product
from speasy.products.variable import SpeasyVariable
import enum


class PlotType(enum.Enum):
    NONE = 0
    LINE = 1
    SPECTRO = 2


log = logging.getLogger(__name__)

SCALES_LUT = {
    'lin': 'linear',
    'linear': 'linear',
    'log': 'log',
    'logarithmic': 'log'
}

TEMPLATE = Template('''
<!DOCTYPE html>
<html>
    <head>
        <script src="https://code.jquery.com/jquery-3.6.1.min.js"></script>
        <script src="https://unpkg.com/json5@2/dist/index.min.js"></script>
        <script type="text/javascript">
            var last_range = [-1, -1];
            function transpose(array)
            {
                return array[0].map((_, colIndex) => array.map(row => row[colIndex]));
            }
        </script>
        {{ js_resources }}
        {{ css_resources }}
    </head>
    <body>
    {{ plot_div }}
    {{ plot_script }}
    </body>
</html>
''')

JS_TEMPLATE = Template("""
if ((last_range[0] > xr.start) || (last_range[1] < xr.end))
{
    last_range[0]=xr.start;
    last_range[1]=xr.end;
    var plot_data = source.data;
    request_url.text = '<a href="' + server_url + 'get_data?format=html_bokeh&path=' + product + '&start_time=' + new Date(xr.start).toISOString() + '&stop_time=' + new Date(xr.end).toISOString()+'">Plot URL</a>';
    jQuery.ajax({
        type: 'GET',
        url: server_url+'get_data?format=json&path=' + product + '&start_time=' + new Date(xr.start).toISOString() + '&stop_time=' + new Date(xr.end).toISOString(),
        converters: {
            'text json': function(result) {
                return JSON5.parse(result);
            }
        },
        success: function (json_from_server) {
            const data = source.data;
            var values = transpose(json_from_server['values']['values']);
            //console.log(json_from_server);
    {% for column in columns %}
            data['{{ column }}']=values[{{ loop.index0 }}];
    {% endfor %}
            data['time']=json_from_server['axes'][0]['values'].map(function(item) { return item/1000000 });
    
            source.change.emit();
        },
        error: function(xhr, ajaxOptions, thrownError) {
            console.log(xhr);
            console.log(ajaxOptions);
            console.log(thrownError);
        }
    });
}

""")

JSON_PANE_TEMPLATE = Template(
    """
<table style="width:100%">
  <tr>
    <th>Name</th>
    <th>Value</th>
  </tr>
  {% for key, value in meta.items() %}
  <tr>
    <td>{{ key }}</td>
    <td>{{ value }}</td>
  </tr>
  {% endfor %}
</table>
    """
)


def _metadata_viewer(data):
    return TabPanel(
        child=column(Div(text=JSON_PANE_TEMPLATE.render(meta=data.meta), sizing_mode='stretch_both'),
                     Spacer(sizing_mode='stretch_both'),
                     sizing_mode='stretch_both'),
        title="Metadata")


def _data_type(data: SpeasyVariable):
    if data is not None:
        if len(data.values.shape) == 2 and (
                data.meta.get('DISPLAY_TYPE', '') == 'spectrogram' or data.values.shape[1] > 10):
            return PlotType.SPECTRO
        if len(data.values.shape) == 2:
            return PlotType.LINE
    return PlotType.NONE


def _plot_vector(plot, provider_uid, product_uid, data, host_url, request_url):
    if len(data) > 0:
        colors = itertools.cycle(palette)
        if len(data.columns) != data.values.shape[1]:
            columns = [f'component {i}' for i in range(data.values.shape[1])]
        else:
            columns = data.columns

        source = ColumnDataSource()
        source.add(data=data.time, name="time")
        for comp in range(data.values.shape[1]):
            source.add(data=data.values[:, comp], name=columns[comp])

        for comp, color in zip(range(data.values.shape[1]), colors):
            l = plot.line(x='time', y=columns[comp], source=source, legend_label=columns[comp], line_color=color)

        plot.add_tools(HoverTool(
            renderers=[l],
            tooltips=[("time", "@time{%F %T}")] + [
                (columns[comp], f'@{columns[comp]}{{0.000}} {str(data.unit)}') for
                comp in
                range(data.values.shape[1])],
            formatters={"@time": "datetime"},
            mode='vline')
        )

        js = JS_TEMPLATE.render(columns=columns, start=str(data.time[0]), stop=str(data.time[-1]))
        callback = CustomJS(
            args=dict(source=source, xr=plot.x_range, product=f"{provider_uid}/{product_uid}", plot_title=plot.title,
                      request_url=request_url,
                      server_url=host_url),
            code=js)
        plot.js_on_event(RangesUpdate, callback)
        plot.x_range.max_interval = np.timedelta64(7, 'D')
        plot.legend.click_policy = "hide"
        plot.yaxis.axis_label = f"{data.name} ({data.unit})"


def _plot_spectrogram(plot, provider_uid, product_uid, data: SpeasyVariable, host_url, request_url):
    import matplotlib.colors as colors
    import matplotlib.pyplot as plt
    if len(data) > 0 and not np.isnan(data.values).all():
        plt.figure()
        plt.semilogy()

        values = data.values
        x = data.time
        if len(data.axes) >= 2:
            y = data.axes[1].values
            plot.yaxis.axis_label = f"{data.axes[1].name} ({data.axes[1].unit})"
        else:
            y = np.arange(values.shape[1]).T

        cm = plt.pcolormesh(x, y.T, values.T,
                            cmap='plasma',
                            norm=colors.LogNorm(vmin=np.nanmin(values[np.nonzero(values)]),
                                                vmax=np.nanmax(values)))
        flat_cmap = cm.cmap(cm.norm(cm.get_array()))
        image = np.empty((values.shape[1], values.shape[0]), dtype=np.uint32)
        view = image.view(dtype=np.uint8).reshape((image.shape[0], image.shape[1], 4))

        view[:] = flat_cmap.reshape(view.shape) * 255
        plot.x_range = DataRange1d(start=x[0], end=x[-1], max_interval=np.timedelta64(7, 'D'))
        ylim = cm.axes.get_ylim()
        plot.y_range = DataRange1d(start=ylim[0], end=ylim[1])
        plot.x_range.range_padding = plot.y_range.range_padding = 0
        plot.image_rgba(image=[image], x=x[0], y=cm.axes.get_ylim()[0],
                        dw=x[-1] - x[0], dh=cm.axes.get_ylim()[1])
        plot.add_tools(
            HoverTool(tooltips=[("x", "$x{%F %T}"), ("y", f"$y {data.axes[1].unit if len(data.axes) >= 2 else ''}")],
                      formatters={"$x": "datetime"}))


def plot_data(product, data: SpeasyVariable, start_time, stop_time, request: Request):
    provider_uid, product_uid = provider_and_product(product)
    try:
        if data is not None and len(data):
            plot_type = _data_type(data)
            data.replace_fillval_by_nan(inplace=True)
            y_axis_type = SCALES_LUT.get(data.meta.get('SCALETYP', 'linear').lower(), 'linear')
            plot = figure(min_width=900, min_height=500, x_axis_type="datetime", sizing_mode='stretch_both',
                          height_policy="max",
                          width_policy="max",
                          y_axis_type=y_axis_type,
                          toolbar_location="above"
                          )
            plot.xaxis.formatter = DatetimeTickFormatter(years="%Y/%m/%d %H:%M:%S",
                                                         months="%Y/%m/%d %H:%M:%S",
                                                         days="%Y/%m/%d %H:%M:%S",
                                                         hours="%Y/%m/%d %H:%M:%S",
                                                         hourmin="%Y/%m/%d %H:%M:%S",
                                                         minutes="%Y/%m/%d %H:%M:%S",
                                                         minsec="%Y/%m/%d %H:%M:%S",
                                                         seconds="%Y/%m/%d %H:%M:%S.%3N",
                                                         milliseconds="%Y/%m/%d %H:%M:%S.%3N",
                                                         microseconds="%Y/%m/%d %H:%M:%S.%f")
            plot_title = Div(
                text=f'<h1>{product_uid} from {provider_uid}</h1>', align='center')
            product_meta = Paragraph(text="")

            plot.add_tools(CrosshairTool())
            plot.add_tools(WheelPanTool())

            request_url = Div(
                text=f'<a href="{request.base_url}get_data?format=html_bokeh&path={provider_uid}/{product_uid}&start_time={str(data.time[0])}&stop_time={str(data.time[-1])}">Plot URL</a>')

            if plot_type == PlotType.SPECTRO:
                _plot_spectrogram(plot, provider_uid, product_uid, data, host_url=str(request.base_url),
                                  request_url=request_url)
            elif plot_type == PlotType.LINE:
                _plot_vector(plot, provider_uid, product_uid, data, host_url=str(request.base_url),
                             request_url=request_url)

            script, div = components(Tabs(sizing_mode='stretch_both',
                                          tabs=[TabPanel(child=column(plot_title, product_meta, request_url, plot,
                                                                      sizing_mode='stretch_both'),
                                                         title="Plot"), _metadata_viewer(data)]))
            html = TEMPLATE.render(plot_script=script,
                                   plot_div=div,
                                   js_resources=INLINE.render_js(),
                                   css_resources=INLINE.render_css())
            return html

        log.debug(f"Can't plot {product}, data shape: {data.values.shape if data is not None else None}")
        if data is not None and len(data) == 0:
            return f"No data for {product_uid} from {provider_uid} betweeen {start_time} and {stop_time}"

    except Exception as e:
        log.debug(''.join(traceback.format_exception(e)))
    return f"Oops, unable to plot {product_uid} from {provider_uid}"
