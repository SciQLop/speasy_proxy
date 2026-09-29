import json
import logging
import math
import time
import uuid
from datetime import datetime, timedelta, UTC
from typing import Optional
import numpy as np
import speasy as spz
from astropy.units.quantity import Quantity
from fastapi import Response, Request, Query, Depends
from fastapi.responses import JSONResponse
from pydantic.types import Json
from starlette.concurrency import run_in_threadpool

from .routes import router

from speasy.products.variable import SpeasyVariable, VariableTimeAxis, DataContainer
from speasy.products.variable import to_dictionary
from speasy.core.codecs import get_codec

from speasy_proxy.api import pickle_data
from .query_parameters import ZstdCompression, Compression, PickleProtocol, DataFormat, MaxPoints, ResampleStrategy
from speasy_proxy.api.compression import compress_if_asked, blosc_arrays, BLOSC_MIME
from speasy_proxy.backend.bokeh_backend import plot_data
from speasy_proxy.backend.resample import resample
from speasy_proxy.config import core as core_config
from speasy_proxy.dependencies import trigger_inventory_check

log = logging.getLogger(__name__)


def dt_to_str(dt: datetime):
    return dt.isoformat()


def ts_to_str(ts: float):
    return dt_to_str(datetime.fromtimestamp(ts, tz=UTC))


def _values_as_array(values):
    if type(values) is Quantity:
        return values.view(np.ndarray)
    return values


def _json_default(o):
    # Byte-string label axes (numpy |S dtype, e.g. CDAWeb's `cartesian` component labels)
    # surface as bytes, which json can't serialize on its own.
    if isinstance(o, bytes):
        return o.decode('utf-8', 'replace')
    raise TypeError(f'Object of type {type(o).__name__} is not JSON serializable')


def _finite_or_none(o):
    # Bare NaN/Infinity tokens are not JSON: strict parsers (JS, jq, Julia...) reject the whole body.
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, list):
        return [_finite_or_none(x) for x in o]
    if isinstance(o, dict):
        return {k: _finite_or_none(v) for k, v in o.items()}
    return o


def to_json(var: SpeasyVariable) -> str:
    var = var.replace_fillval_by_nan(convert_to_float=True)
    return json.dumps(_finite_or_none(var.to_dictionary(array_to_list=True)), default=_json_default, allow_nan=False)


def _get_data(product, start_time, stop_time, extra_http_headers, **extra_params):
    return spz.get_data(product=product, start_time=start_time, stop_time=stop_time,
                        extra_http_headers=extra_http_headers, **extra_params)


class _PhaseTimer:
    """Wall time per request phase, sent as a Server-Timing header (https://www.w3.org/TR/server-timing/).

    `queue` is the time spent waiting for a free threadpool thread, summed over every hop:
    the pool is bounded, so a saturated worker shows up here instead of inflating `fetch`.
    """

    def __init__(self):
        self.ms = {}

    async def run(self, phase: str, fn, *args, **kwargs):
        submitted = started = time.perf_counter()

        def timed():
            nonlocal started
            started = time.perf_counter()
            return fn(*args, **kwargs)

        try:
            return await run_in_threadpool(timed)
        finally:
            self._add("queue", started - submitted)
            self._add(phase, time.perf_counter() - started)

    def _add(self, phase: str, seconds: float):
        self.ms[phase] = self.ms.get(phase, 0.) + seconds * 1000.

    def headers(self) -> dict:
        return {"Server-Timing": ", ".join(f"{phase};dur={ms:.1f}" for phase, ms in self.ms.items()),
                "Access-Control-Expose-Headers": "Server-Timing"}


def _invalid_time_range_reason(start_time: datetime, stop_time: datetime) -> Optional[str]:
    # speasy does not validate ordering or span itself (DateTimeRange has no
    # such check), so an inverted or unbounded range would otherwise be
    # dispatched straight into the threadpool.
    if stop_time <= start_time:
        return f"stop_time ({stop_time}) must be after start_time ({start_time})"
    max_span = timedelta(days=core_config.max_query_span_days.get())
    if stop_time - start_time > max_span:
        return f"Requested time range ({stop_time - start_time}) exceeds the maximum allowed span ({max_span})"
    return None


_NOT_FOUND_MESSAGES = ("Unknown product", "Can't find a provider", "Given string does not look like a path")


def _fetch_failure_status(e: Exception) -> int:
    # speasy has no dedicated exception for an unknown path, only these ValueError messages;
    # anything else is blamed on upstream.
    return 404 if isinstance(e, ValueError) and str(e).startswith(_NOT_FOUND_MESSAGES) else 502


def _download_headers(fmt: str, path: str, start_time: datetime, stop_time: datetime) -> dict:
    if fmt != "cdf":
        return {}
    stem = f"{path.replace('/', '_')}_{start_time:%Y%m%dT%H%M%S}_{stop_time:%Y%m%dT%H%M%S}"
    return {"Content-Disposition": f'attachment; filename="{stem}.cdf"'}


@router.get('/get_data', description='Get data from cache or remote server',
            responses={400: {"description": "Invalid time range"},
                       404: {"description": "Unknown provider or product"},
                       500: {"description": "The data could not be encoded in the requested format"},
                       502: {"description": "The upstream data provider failed"}})
async def get_data(request: Request,
                   path: str = Query(examples=["amda/c1_b_gsm"],
                                     description="'<provider>/<product id>', as found in /get_inventory "
                                                 "(the __spz_provider__ and __spz_uid__ of a parameter)."),
                   start_time: datetime = Query(examples=["2018-10-24T00:00:00"],
                                                description="ISO-8601 (UTC when no offset is given) or Unix epoch seconds."),
                   stop_time: datetime = Query(examples=["2018-10-24T02:00:00"],
                                               description="Same format as start_time, must be after it."),
                   format: DataFormat = "python_dict",
                   zstd_compression: ZstdCompression = False,
                   compression: Compression = None,
                   output_format: Optional[str] = Query(None, examples=["CDF_ISTP"],
                                                        description="Data format used to retrieve data from remote server (such as AMDA), not the data format of the current request. Only available with AMDA."),
                   coordinate_system: Optional[str] = Query(None, examples=["gse"],
                                                            description="Frame of trajectories: SSCWeb (geo, gm, gse, gsm, sm, geitod, geij2000) "
                                                                        "or CDPP 3DView (see /get_3dview_frames)."),
                   method: Optional[str] = Query(None, examples=["BEST"],
                                                 description="Method used to retrieve data from CDA."),
                   product_inputs: Optional[Json] = Query(None, description="Product input parameters (in JSON format) used used for example in AMDA templates parameters"),
                   pickle_proto: PickleProtocol = 3,
                   max_points: MaxPoints = None,
                   resample_strategy: ResampleStrategy = "lttb",
                   _=Depends(trigger_inventory_check)):
    request_start_time = time.time_ns()
    request_id = uuid.uuid4()
    extra_params = {}
    product = path
    if 'X-Real-IP' in request.headers:
        extra_http_headers = {'X-Forwarded-For': request.headers['X-Real-IP']}
        client_chain = request.headers['X-Real-IP']
    else:
        client_chain = str(request.client.host)
        extra_http_headers = None

    if coordinate_system:
        extra_params["coordinate_system"] = coordinate_system
    if output_format:
        extra_params["output_format"] = output_format
    if method:
        extra_params["method"] = method
    if product_inputs:
        extra_params["product_inputs"] = product_inputs

    log.debug(f'New request {request_id}: {product} {start_time} {stop_time} from {client_chain}')

    invalid_reason = _invalid_time_range_reason(start_time, stop_time)
    if invalid_reason is not None:
        log.debug(f'{request_id}: rejected invalid time range: {invalid_reason}')
        return JSONResponse(status_code=400, content={"error": "Invalid time range", "detail": invalid_reason})

    timer = _PhaseTimer()
    try:
        var = await timer.run("fetch", _get_data, product=product, start_time=start_time, stop_time=stop_time,
                                      extra_http_headers=extra_http_headers, **extra_params)
    except Exception as e:
        log.error(f'{request_id}: Failed to get data for {product}: {e}')
        return JSONResponse(status_code=_fetch_failure_status(e),
                            content={"error": f"Failed to get data for {product}", "detail": str(e)},
                            headers=timer.headers())

    if var is not None and max_points is not None and len(var) > max_points:
        var = await timer.run("resample", resample, var, max_points, resample_strategy)

    try:
        result, mime = await timer.run("encode", _compress_and_encode_output, var, path, start_time, stop_time, format,
                                               request, pickle_proto,
                                               zstd_compression, compression)
    except Exception as e:
        log.error(f'{request_id}: Failed to encode data for {product}: {e}')
        return JSONResponse(status_code=500, content={"error": f"Failed to encode data for {product}", "detail": str(e)},
                            headers=timer.headers())

    request_duration = (time.time_ns() - request_start_time) / 1000000.

    if var is not None:
        if len(var.time):
            log.debug(
                f'{request_id}, duration = {request_duration}ms, Got data: data shape = {var.values.shape}, data start time = {var.time[0]}, data stop time = {var.time[-1]}')
        else:
            log.debug(f'{request_id}, duration = {request_duration}ms, Got empty data')
    else:
        log.debug(f'{request_id}, duration = {request_duration}ms, Got None')

    return Response(media_type=mime, content=result,
                    headers={'Content-Type': mime, **timer.headers(),
                             **_download_headers(format, path, start_time, stop_time)})


def encode_output(var, path: str, start_time: str, stop_time: str, fmt: str, request: Request,
                  pickle_proto: int = 3):
    data = None

    if var is None:
        # Respond in the requested format instead of a pickled None (BL-6).
        if fmt == "json":
            return "null", 'application/json; charset=UTF-8'
        if fmt == "html_bokeh":
            return plot_data(product=path, data=None, start_time=start_time, stop_time=stop_time,
                             request=request), 'text/html; charset=UTF-8'
        if fmt == "cdf":
            # create an empty speasy variable to be able to save it in CDF format
            var = SpeasyVariable(axes=[VariableTimeAxis(values=np.array([], dtype='datetime64[ns]'), meta={})],
                                 values=DataContainer(values=np.array([]), meta={}, name="Unknown"))
    if var is not None:
        if fmt == "python_dict":
            data = to_dictionary(var)
        elif fmt == "cdf":
            data = get_codec('application/x-cdf').save_variables([var])
            return bytes(data), "application/x-cdf"
        elif fmt == 'speasy_variable':
            data = var
        elif fmt == 'html_bokeh':
            return plot_data(product=path, data=var,
                             start_time=start_time, stop_time=stop_time,
                             request=request), 'text/html; charset=UTF-8'
        elif fmt == 'json':
            return to_json(var), 'application/json; charset=UTF-8'

    return pickle_data(data, pickle_proto), "application/python-pickle"



def _compress_and_encode_output(var, path, start_time, stop_time, fmt, request, pickle_proto,
                                      zstd_compression: bool = False, compression: Optional[str] = None):
    if compression == "blosc" and fmt == "python_dict" and var is not None:
        return pickle_data(blosc_arrays(to_dictionary(var)), pickle_proto), BLOSC_MIME
    return compress_if_asked(*encode_output(var, path, start_time, stop_time, fmt, request, pickle_proto),
                             zstd_compression=zstd_compression)
