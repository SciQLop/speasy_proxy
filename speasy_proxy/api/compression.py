import numpy as np
import pyzstd
from numcodecs import Blosc
from numcodecs.blosc import MAX_BUFFERSIZE

BLOSC_MIME = "application/x-speasy-blosc-pickle"

# Byte-shuffle + zstd level 1 per array (https://www.blosc.org/): on real float series this is ~2x smaller
# and several times faster than zstd over the whole pickle. Standard blosc v1 chunks, so numcodecs,
# python-blosc and blosc2 can all decode them.
_BLOSC = Blosc(cname="zstd", clevel=1, shuffle=Blosc.SHUFFLE)
_NUMERIC_KINDS = "biufcmM"


def compress_if_asked(data: bytes | str, mime: str, zstd_compression: bool = False) -> tuple[bytes | str, str]:
    if zstd_compression:
        if isinstance(data, str):
            data = data.encode()
        return pyzstd.compress(data), "application/x-zstd-compressed"
    return data, mime


def _blosc_array(value):
    # empty arrays stay raw: numcodecs cannot decode the chunk it makes for them
    if isinstance(value, np.ndarray) and value.dtype.kind in _NUMERIC_KINDS and 0 < value.nbytes <= MAX_BUFFERSIZE:
        # datetime64/timedelta64 don't expose the buffer protocol; same bytes seen as int64
        raw = value.view("i8") if value.dtype.kind in "mM" else value
        return {"__blosc__": _BLOSC.encode(np.ascontiguousarray(raw)), "dtype": value.dtype.str,
                "shape": value.shape}
    return value


def blosc_arrays(obj):
    """Replace every numeric numpy array in a nested dict/list by {"__blosc__": chunk, "dtype", "shape"}."""
    if isinstance(obj, dict):
        return {k: blosc_arrays(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [blosc_arrays(v) for v in obj]
    return _blosc_array(obj)
