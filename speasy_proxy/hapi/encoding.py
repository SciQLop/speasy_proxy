"""Writes /data responses that match /info exactly: same parameters, shapes, types and time length.

Values are taken as fetched and only reshaped/cast to what /info declared; anything that doesn't
fit (other shape, other time axis) is an error rather than a response a client would choke on.
"""
import io
import json
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from speasy.products.variable import SpeasyVariable

from .status import HapiError
from .times import format_times


def _trim(var: Optional[SpeasyVariable], start: datetime, stop: datetime) -> Optional[SpeasyVariable]:
    """HAPI ranges are [start, stop)."""
    if var is None:
        return None
    time = var.time
    lo, hi = np.searchsorted(time, [np.datetime64(start.replace(tzinfo=None), "ns"),
                                    np.datetime64(stop.replace(tzinfo=None), "ns")], side="left")
    return var[int(lo):int(hi)]


def merge_time_axes(variables: Dict[str, Optional[SpeasyVariable]], start: datetime,
                    stop: datetime) -> Tuple[np.ndarray, Dict[str, Optional[SpeasyVariable]]]:
    """Trims every variable to [start, stop) and checks they all share the same time axis."""
    trimmed = {path: _trim(var, start, stop) for path, var in variables.items()}
    time = None
    for path, var in trimmed.items():
        t = var.time if var is not None else np.array([], dtype="datetime64[ns]")
        if time is None:
            time = t
        elif not np.array_equal(time, t):
            raise HapiError(1500, f"the parameters don't share their time axis ({path} differs)")
    return time, trimmed


def _column(meta: Dict[str, Any], source: Tuple[str, Optional[int]], variables, n: int) -> np.ndarray:
    path, axis = source
    var = variables[path]
    if var is None or n == 0:
        values = np.empty((0,))
    else:
        values = np.asarray(var.values if axis is None else var.axes[axis].values)
    size = meta.get("size", [])
    if values.size != n * int(np.prod(size, dtype=np.int64)):
        raise HapiError(1500, f"{meta['name']} has shape {values.shape[1:]} where /info declares {size or 'a scalar'}")
    values = values.reshape((n, *size))
    if meta["type"] == "integer":
        return values.astype("<i4")
    # float32 stays float32 so that CSV prints its shortest float32 repr, not float64 noise.
    return values if values.dtype in (np.float32, np.float64) else values.astype("<f8")


def build_columns(parameters: List[Dict[str, Any]], sources: Dict[str, Tuple[str, Optional[int]]],
                  time: np.ndarray, variables) -> List[np.ndarray]:
    """One array per parameter (Time first, as strings of the declared length)."""
    n = len(time)
    columns = [format_times(time, parameters[0]["length"])]
    columns += [_column(meta, sources[meta["name"]], variables, n) for meta in parameters[1:]]
    return columns


def header_line(header: dict) -> bytes:
    return ("#" + json.dumps(header) + "\n").encode("utf-8")


def to_csv(columns: List[np.ndarray]) -> bytes:
    flat = {}
    for i, col in enumerate(columns):
        if col.ndim == 1:
            flat[f"{i}"] = col
        else:
            for j, sub in enumerate(col.reshape(len(col), int(np.prod(col.shape[1:]))).T):
                flat[f"{i}_{j}"] = sub
    buffer = io.StringIO()
    # pandas writes NaN as an empty field by default, which HAPI clients can't read as a double.
    pd.DataFrame(flat).to_csv(buffer, index=False, header=False, na_rep="NaN", lineterminator="\n")
    return buffer.getvalue().encode("utf-8")


def _widen(col: np.ndarray, fill: Optional[str]) -> np.ndarray:
    """float32 -> float64 for binary, keeping fill cells equal to the fill /info declares: a float32
    fill widens to -1.0000000150474662e+30, while /info spells it as float32 prints, -1e+30."""
    if col.dtype != np.float32:
        return col
    wide = col.astype(np.float64)
    if fill is not None and fill != "NaN":
        wide[col == np.float32(fill)] = float(fill)
    return wide


def to_binary(parameters: List[Dict[str, Any]], columns: List[np.ndarray]) -> bytes:
    fields = [("Time", f"S{parameters[0]['length']}")]
    for meta in parameters[1:]:
        base = "<i4" if meta["type"] == "integer" else "<f8"
        fields.append((meta["name"], (base, tuple(meta["size"])) if meta.get("size") else base))
    out = np.empty(len(columns[0]), dtype=np.dtype(fields))
    out["Time"] = columns[0]
    for meta, col in zip(parameters[1:], columns[1:]):
        out[meta["name"]] = _widen(col, meta.get("fill"))
    return out.tobytes()
