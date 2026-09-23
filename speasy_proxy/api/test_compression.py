import numpy as np
import pytest
import pyzstd
from numcodecs import Blosc

from speasy_proxy.api.compression import blosc_arrays


def _unblosc(obj):
    """Reference client-side decoder for the `compression=blosc` wire format."""
    if isinstance(obj, dict) and "__blosc__" in obj:
        return np.frombuffer(Blosc().decode(obj["__blosc__"]), dtype=obj["dtype"]).reshape(obj["shape"])
    if isinstance(obj, dict):
        return {k: _unblosc(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_unblosc(v) for v in obj]
    return obj


@pytest.mark.parametrize("array", [
    np.linspace(0, 1, 1000),
    np.linspace(0, 1, 3000, dtype="float32").reshape(1000, 3),
    np.arange(1000, dtype="int16"),
    np.random.default_rng(0).normal(size=(50, 32, 4)),
    np.arange(1000).astype("datetime64[ns]"),
], ids=["float64", "float32-2d", "int16", "float64-3d", "datetime64"])
def test_numeric_arrays_round_trip(array):
    encoded = blosc_arrays({"values": array})

    assert isinstance(encoded["values"], dict)
    decoded = _unblosc(encoded)["values"]
    assert decoded.dtype == array.dtype
    np.testing.assert_array_equal(decoded, array)


def test_empty_arrays_pass_through():
    empty = np.array([], dtype="float64")

    assert blosc_arrays({"values": empty})["values"] is empty


def test_non_numeric_arrays_and_scalars_pass_through():
    labels = np.array([b"Bx GSE", b"By GSE"], dtype="S11")
    objects = np.array(["a", None], dtype=object)
    data = {"labels": labels, "objects": objects, "name": "B", "meta": {"UNITS": "nT"}, "columns": ["x", "y"]}

    encoded = blosc_arrays(data)

    assert encoded["labels"] is labels
    assert encoded["objects"] is objects
    assert encoded["name"] == "B" and encoded["meta"] == {"UNITS": "nT"} and encoded["columns"] == ["x", "y"]


def test_arrays_nested_in_lists_are_encoded():
    time = np.arange(10).astype("datetime64[s]")

    decoded = _unblosc(blosc_arrays({"axes": [{"values": time}]}))

    np.testing.assert_array_equal(decoded["axes"][0]["values"], time)


def test_beats_zstd_on_a_magnetometer_like_product():
    """Shaped like a real product (float32 components + regular datetime64 time axis): the time axis is where
    byte-shuffle wins most, its high bytes being near constant. Not true of every dtype -- e.g. float64 rounded
    decimals favour plain zstd -- the benchmark on real prod payloads is what justified the switch."""
    n = 100_000
    time = np.datetime64("2020-01-01", "ns") + np.arange(n) * np.timedelta64(62_500_000, "ns")
    field = np.cumsum(np.random.default_rng(0).normal(size=(n, 3)), axis=0).astype("float32")

    encoded = blosc_arrays({"time": time, "field": field})
    blosc_size = len(encoded["time"]["__blosc__"]) + len(encoded["field"]["__blosc__"])

    assert blosc_size < len(pyzstd.compress(time.view("i8").tobytes() + field.tobytes()))
