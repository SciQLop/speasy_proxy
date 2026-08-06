import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from pathlib import Path
from speasy.products.variable import SpeasyVariable, VariableTimeAxis, DataContainer

from speasy_proxy.backend.bokeh_backend import plot_data


class _FakeRequest:
    base_url = "http://test/"


def _spectro_var(n=200, n_freq=16):
    times = np.arange(n).astype("datetime64[s]").astype("datetime64[ns]")
    values = np.abs(np.random.default_rng(0).standard_normal((n, n_freq))) + 1e-3
    axis = VariableTimeAxis(values=times, meta={})
    data = DataContainer(values=values, meta={"DISPLAY_TYPE": "spectrogram"}, name="spec")
    return SpeasyVariable(axes=[axis], values=data)


def test_unique_columns_dedupes_duplicates():
    """Regression for BL-9: duplicate component names must be made unique so each
    line gets its own ColumnDataSource entry instead of overwriting another."""
    from speasy_proxy.backend.bokeh_backend import _unique_columns
    assert _unique_columns(["a", "a", "b", "a"]) == ["a", "a_1", "b", "a_2"]


def test_unique_columns_preserves_unique():
    from speasy_proxy.backend.bokeh_backend import _unique_columns
    assert _unique_columns(["x", "y", "z"]) == ["x", "y", "z"]


def test_spectrogram_render_does_not_leak_figures():
    """Regression for BL-2: rendering an html_bokeh spectrogram must not leave
    matplotlib figures registered in pyplot's global manager (a per-request leak
    and a thread-safety hazard since rendering runs in a threadpool)."""
    plt.close("all")
    before = len(plt.get_fignums())
    for _ in range(5):
        html = plot_data("amda/spec", _spectro_var(), "2020-01-01", "2020-01-02", _FakeRequest())
        assert html and "Oops" not in html
    assert len(plt.get_fignums()) == before


def _line_var(values, meta=None, dtype=None):
    times = np.arange(len(values)).astype("datetime64[s]").astype("datetime64[ns]")
    axis = VariableTimeAxis(values=times, meta={})
    data = DataContainer(values=np.asarray(values, dtype=dtype), meta=meta or {}, name="x")
    return SpeasyVariable(axes=[axis], values=data)


def test_line_plot_with_integer_fillval_data_renders():
    """Regression for BL-31: an integer variable carrying a FILLVAL must still
    plot (fill values replaced by NaN, converted to float), not be dropped with
    'Oops' because assigning NaN into an integer array raises ValueError."""
    var = _line_var([[1], [2], [-999], [4], [5]], meta={"FILLVAL": -999}, dtype=np.int32)
    html = plot_data("amda/x", var, "2020-01-01", "2020-01-02", _FakeRequest())
    assert html and "Oops" not in html


def test_plot_data_does_not_mutate_input_variable():
    """Regression for BL-14: plot_data must not modify the caller's variable
    in place (the json path already returns a copy; both paths must agree)."""
    var = _line_var([[1.0], [-1e31], [3.0]], meta={"FILLVAL": -1e31})
    before = var.values.copy()
    html = plot_data("amda/x", var, "2020-01-01", "2020-01-02", _FakeRequest())
    assert html and "Oops" not in html
    assert np.array_equal(var.values, before)


def test_bokeh_page_scripts_are_vendored():
    """Regression for BL-23: the html_bokeh page must not depend on third-party
    CDNs (availability + integrity); jquery/json5 are vendored under
    static/js/vendor and loaded with a relative URL (root_path friendly)."""
    html = plot_data("amda/x", _line_var([[1.0], [2.0]]), "2020-01-01", "2020-01-02", _FakeRequest())
    assert html and "Oops" not in html
    assert "code.jquery.com" not in html
    assert "unpkg.com" not in html
    assert 'src="static/js/vendor/jquery-3.6.1.min.js"' in html
    assert 'src="static/js/vendor/json5-2.2.3.min.js"' in html
    vendor_dir = Path(__file__).parent.parent / "static" / "js" / "vendor"
    assert (vendor_dir / "jquery-3.6.1.min.js").is_file()
    assert (vendor_dir / "json5-2.2.3.min.js").is_file()
