from jinja2 import Template
from speasy.products.variable import SpeasyVariable
from speasy import SpeasyIndex
from bokeh.plotting import figure
from bokeh.models import CrosshairTool, DataRange1d, HoverTool, ColumnDataSource, CustomJS
from bokeh.resources import CDN, INLINE
from bokeh.embed import file_html, components
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
        <script src="https://code.jquery.com/jquery-3.1.0.min.js"></script>
        {{ js_resources }}
        {{ css_resources }}
    </head>
    <body>
    {{ plot_div }}
    {{ plot_script }}
    </body>
</html>
''')


def _plot_vector(plot, product, data):
    if len(data) > 0:
        if isinstance(product, SpeasyIndex):
            product = product.spz_uid()
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

        callback = CustomJS(args=dict(source=source, xr=plot.x_range, product=product), code="""
            var plot_data = source.data;
            jQuery.ajax({
                type: 'GET',
                url: '/get_data?format=json&path=' + product + '&start_time=' + '2018-10-24T00:00:00' + '&stop_time=' + '2018-10-24T01:00:00',
                success: function (json_from_server) {
                    // alert(JSON.stringify(json_from_server));
                    source.change.emit();
                },
                error: function() {
                    alert("Oh no, something went wrong. Search for an error " +
                          "message in Flask log and browser developer tools.");
                }
            });
            """)
        plot.x_range.js_on_change('start', callback)
        plot.legend.click_policy = "hide"
        script, div = components(plot)
        html = TEMPLATE.render(plot_script=script,
                               plot_div=div,
                               js_resources=INLINE.render_js(),
                               css_resources=INLINE.render_css())
        return html


def _plot_spectrogram(plot, product, data: SpeasyVariable):
    import matplotlib.pyplot as plt
    import matplotlib.colors as colors
    if len(data) > 0:
        plt.figure()
        plt.semilogy()
        cm = plt.pcolormesh(data.axes[0], data.axes[1].T, data.values.T,
                            norm=colors.LogNorm(vmin=max(np.nanmin(data.values), 1e-100), vmax=np.nanmax(data.values)))
        colors = cm.cmap(cm.norm(cm.get_array()))
        image = np.empty((data.values.shape[1], data.values.shape[0]), dtype=np.uint32)
        view = image.view(dtype=np.uint8).reshape((image.shape[0], image.shape[1], 4))

        view[:] = colors.reshape(view.shape) * 255
        plot.x_range = DataRange1d(data.time[0], data.time[-1])
        plot.y_range = DataRange1d(*cm.axes.get_ylim())

        plot.image_rgba(image=[image], x=data.time[0], y=cm.axes.get_ylim()[0],
                        dw=data.time[-1] - data.time[0], dh=cm.axes.get_ylim()[1])
        plot.add_tools(
            HoverTool(tooltips=[("x", "$x{%F %T}"), ("y", "$y"), ("value", "@image")], formatters={"$x": "datetime"}))
        html = file_html(plot, CDN, "my plot")
        return html


def plot_data(product, data: SpeasyVariable):
    if data is not None and len(data) > 0:
        y_axis_type = SCALES_LUT.get(data.meta.get('SCALETYP', 'linear').lower(), 'linear')
        plot = figure(plot_width=900, plot_height=500, x_axis_type="datetime", sizing_mode='stretch_both',
                      y_axis_type=y_axis_type
                      )
        if isinstance(product, SpeasyIndex):
            plot.title.text = f"{product.spz_uid()} from {product.spz_provider()} between {str(data.time[0])} {str(data.time[-1])}"
        else:
            plot.title.text = f"{product} between {str(data.time[0])} {str(data.time[-1])}"

        plot.title.align = "center"
        plot.title.text_font_size = "25px"
        plot.xaxis.axis_label = 'Time'
        plot.add_tools(CrosshairTool())
        if len(data.values.shape) == 2 and data.meta.get('DISPLAY_TYPE', '') == 'spectrogram':
            return _plot_spectrogram(plot, product, data)
        if len(data.values.shape) == 2:
            return _plot_vector(plot, product, data)

    log.debug(f"Can't plot {product}, data shape: {data.values.shape if data is not None else None}")
