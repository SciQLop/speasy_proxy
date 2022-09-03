from math import prod

from jinja2 import Template
from speasy.products.variable import SpeasyVariable
from speasy import SpeasyIndex, provider_and_product
from bokeh.plotting import figure
from bokeh.models import CrosshairTool, DataRange1d, HoverTool, ColumnDataSource, CustomJS, Div
from bokeh.layouts import column
from bokeh.events import RangesUpdate
from bokeh.resources import INLINE
from bokeh.embed import components
from bokeh.palettes import Set1_9 as palette
import itertools
import logging
import numpy as np

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
    request_url.text = '<a href="' + server_url + '/get_data?format=html_bokeh&path=' + product + '&start_time=' + new Date(xr.start).toISOString() + '&stop_time=' + new Date(xr.end).toISOString()+'">Plot URL</a>';
    jQuery.ajax({
        type: 'GET',
        url: server_url+'/get_data?format=json&path=' + product + '&start_time=' + new Date(xr.start).toISOString() + '&stop_time=' + new Date(xr.end).toISOString(),
        converters: {
            'text json': function(result) {
                return JSON5.parse(result);
            }
        },
        success: function (json_from_server) {
            const data = source.data;
            //console.log(json_from_server);
    {% for column in columns %}
            data['{{ column }}']=json_from_server['values'][{{ loop.index0 }}];
    {% endfor %}
            data['time']=json_from_server['time'].map(function(item) { return item/1000000 });
    
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


def _plot_vector(plot, provider_uid, product_uid, data, host_url, request_url):
    if len(data) > 0:
        colors = itertools.cycle(palette)
        if len(data.columns) != data.values.shape[1]:
            columns = [f'component {i}' for i in range(data.values.shape[1])]
        else:
            columns = data.columns

        source = ColumnDataSource()
        source.add(data=data.time, name='time')
        for comp in range(data.values.shape[1]):
            source.add(data=data.values[:, comp], name=columns[comp])

        for comp, color in zip(range(data.values.shape[1]), colors):
            l = plot.line(x='time', y=columns[comp], source=source, legend_label=columns[comp], line_color=color)
            plot.add_tools(HoverTool(
                renderers=[l],
                tooltips=[("time", "@time{%F %T}"), (columns[comp], '$y{0.000}')],
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


def _plot_spectrogram(plot, provider_uid, product_uid, data: SpeasyVariable, host_url, request_url):
    import matplotlib.pyplot as plt
    import matplotlib.colors as colors
    if len(data) > 0:
        plt.figure()
        plt.semilogy()

        cm = plt.pcolormesh(data.axes[0], data.axes[1].T, data.values.T,
                            cmap='plasma',
                            norm=colors.LogNorm(vmin=np.nanmin(data.values[np.nonzero(data.values)]),
                                                vmax=np.nanmax(data.values)))
        flat_cmap = cm.cmap(cm.norm(cm.get_array()))
        image = np.empty((data.values.shape[1], data.values.shape[0]), dtype=np.uint32)
        view = image.view(dtype=np.uint8).reshape((image.shape[0], image.shape[1], 4))

        view[:] = flat_cmap.reshape(view.shape) * 255
        plot.x_range = DataRange1d(data.time[0], data.time[-1], max_interval=np.timedelta64(7, 'D'))
        plot.y_range = DataRange1d(*cm.axes.get_ylim())
        plot.x_range.range_padding = plot.y_range.range_padding = 0
        plot.image_rgba(image=[image], x=data.time[0], y=cm.axes.get_ylim()[0],
                        dw=data.time[-1] - data.time[0], dh=cm.axes.get_ylim()[1])
        plot.add_tools(
            HoverTool(tooltips=[("x", "$x{%F %T}"), ("y", "$y"), ("value", "@image")], formatters={"$x": "datetime"}))


def plot_data(product, data: SpeasyVariable, request):
    provider_uid, product_uid = provider_and_product(product)
    try:
        if data is not None and len(data) > 0:
            data.replace_fillval_by_nan(inplace=True)
            y_axis_type = SCALES_LUT.get(data.meta.get('SCALETYP', 'linear').lower(), 'linear')
            plot = figure(plot_width=900, plot_height=500, x_axis_type="datetime", sizing_mode='stretch_both',
                          y_axis_type=y_axis_type
                          )

            plot.title.text = f"{product_uid} from {provider_uid}"

            plot.title.align = "center"
            plot.title.text_font_size = "25px"
            plot.xaxis.axis_label = 'Time'

            plot.add_tools(CrosshairTool())

            request_url = Div(
                text=f'<a href="{request.application_url}/get_data?format=html_bokeh&path={provider_uid}/{product_uid}&start_time={str(data.time[0])}&stop_time={str(data.time[-1])}">Plot URL</a>')

            if len(data.values.shape) == 2 and (
                    data.meta.get('DISPLAY_TYPE', '') == 'spectrogram' or data.values.shape[1] > 10):
                _plot_spectrogram(plot, provider_uid, product_uid, data, host_url=request.application_url,
                                  request_url=request_url)
            elif len(data.values.shape) == 2:
                _plot_vector(plot, provider_uid, product_uid, data, host_url=request.application_url,
                             request_url=request_url)

            script, div = components(column(request_url, plot, sizing_mode='stretch_width'))
            html = TEMPLATE.render(plot_script=script,
                                   plot_div=div,
                                   js_resources=INLINE.render_js(),
                                   css_resources=INLINE.render_css())
            return html

        log.debug(f"Can't plot {product}, data shape: {data.values.shape if data is not None else None}")
    except:
        pass
    return f"Oops, unable to plot {product_uid} from {provider_uid}"
