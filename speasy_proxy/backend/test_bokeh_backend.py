import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
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
