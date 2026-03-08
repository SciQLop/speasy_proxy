import json
import logging
import time
import uuid
from datetime import datetime, UTC
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
from .query_parameters import ZstdCompression, PickleProtocol, DataFormat, MaxPoints, ResampleStrategy
from speasy_proxy.api.compression import compress_if_asked
from speasy_proxy.backend.bokeh_backend import plot_data
from speasy_proxy.backend.resample import resample
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


def to_json(var: SpeasyVariable) -> str:
    var = var.replace_fillval_by_nan(convert_to_float=True)
    return json.dumps(var.to_dictionary(array_to_list=True))


def _get_data(product, start_time, stop_time, extra_http_headers, **extra_params):
    return spz.get_data(product=product, start_time=start_time, stop_time=stop_time,
                        extra_http_headers=extra_http_headers, **extra_params)


@router.get('/get_data', description='Get data from cache or remote server')
async def get_data(request: Request,
                   path: str = Query(examples=["amda/c1_b_gsm"]),
                   start_time: datetime = Query(examples=["2018-10-24T00:00:00"]),
                   stop_time: datetime = Query(examples=["2018-10-24T02:00:00"]),
                   format: DataFormat = "python_dict",
                   zstd_compression: ZstdCompression = False,
                   output_format: Optional[str] = Query(None, enum=["CDF_ISTP"],
                                                        description="Data format used to retrieve data from remote server (such as AMDA), not the data format of the current request. Only available with AMDA."),
                   coordinate_system: Optional[str] = Query(None, enum=["geo", "gm", "gse", "gsm", "sm", "geitod",
                                                                        "geij2000"],
                                                            description="Coordinate system used to retrieve trajectories from SSCWeb."),
                   method: Optional[str] = Query(None, enum=["API", "BEST", "FILE"],
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

    try:
        var = await run_in_threadpool(_get_data, product=product, start_time=start_time, stop_time=stop_time,
                                      extra_http_headers=extra_http_headers, **extra_params)
    except Exception as e:
        log.error(f'{request_id}: Failed to get data for {product}: {e}')
        return JSONResponse(status_code=502, content={"error": f"Failed to get data for {product}", "detail": str(e)})

    if var is not None and max_points is not None and len(var) > max_points:
        var = await run_in_threadpool(resample, var, max_points, resample_strategy)

    try:
        result, mime = await run_in_threadpool(_compress_and_encode_output, var, path, start_time, stop_time, format,
                                               request, pickle_proto,
                                               zstd_compression)
    except Exception as e:
        log.error(f'{request_id}: Failed to encode data for {product}: {e}')
        return JSONResponse(status_code=500, content={"error": f"Failed to encode data for {product}", "detail": str(e)})

    request_duration = (time.time_ns() - request_start_time) / 1000000.

    if var is not None:
        if len(var.time):
            log.debug(
                f'{request_id}, duration = {request_duration}ms, Got data: data shape = {var.values.shape}, data start time = {var.time[0]}, data stop time = {var.time[-1]}')
        else:
            log.debug(f'{request_id}, duration = {request_duration}ms, Got empty data')
    else:
        log.debug(f'{request_id}, duration = {request_duration}ms, Got None')

    del var

    return Response(media_type=mime, content=result,
                    headers={'Content-Type': mime})


def encode_output(var, path: str, start_time: str, stop_time: str, format: str, request: Request,
                  pickle_proto: int = 3):
    data = None

    if var is None and format == "cdf":
        # create an empty speasy variable to be able to save it in CDF format
        var = SpeasyVariable(axes=[VariableTimeAxis(values=np.array([], dtype='datetime64[ns]'), meta={})],
                             values=DataContainer(values=np.array([]), meta={}, name="Unknown"))
    if var is not None:
        output_format = format
        if output_format == "python_dict":
            data = to_dictionary(var)
        elif output_format == "cdf":
            data = get_codec('application/x-cdf').save_variables([var])
            return bytes(data), "application/x-cdf"
        elif output_format == 'speasy_variable':
            data = var
        elif output_format == 'html_bokeh':
            return plot_data(product=path, data=var,
                             start_time=start_time, stop_time=stop_time,
                             request=request), 'text/html; charset=UTF-8'
        elif output_format == 'json':
            return to_json(var), 'application/json; charset=UTF-8'

    return pickle_data(data, pickle_proto), "application/python-pickle"



def _compress_and_encode_output(var, path, start_time, stop_time, format, request, pickle_proto,
                                      zstd_compression: bool = False):
    return compress_if_asked(*encode_output(var, path, start_time, stop_time, format, request, pickle_proto),
                             zstd_compression=zstd_compression)
