import time

from pyramid.view import view_config
from pyramid.response import Response
import speasy
from datetime import datetime
from speasy.products.variable import SpeasyVariable, to_dictionary
import zstd
import logging
import uuid

from . import pickle_data

log = logging.getLogger(__name__)


def dt_to_str(dt: datetime):
    return dt.isoformat()


def ts_to_str(ts: float):
    return dt_to_str(datetime.utcfromtimestamp(ts))


def encode_output(var, request):
    data = None
    if var is not None:
        output_format = request.params.get("format", "python_dict")
        if output_format == "python_dict":
            data = to_dictionary(var)
        elif output_format == 'speasy_variable':
            data = var

    return pickle_data(data, request), "application/python-pickle"


def compress_if_asked(data, mime, request):
    if request.params.get("zstd_compression", "false") == "true":
        mime = "application/x-zstd-compressed"
        data = zstd.compress(data)
    return data, mime


@view_config(route_name='get_data', openapi=True)
def get_data(request):
    request_start_time = time.time_ns()
    request_id = uuid.uuid4()
    extra_params = {}
    product = request.params.get("path", None)
    start_time = request.params.get("start_time", None)
    stop_time = request.params.get("stop_time", None)

    for value, name in ((product, "path"), (start_time, "start_time"), (stop_time, "stop_time")):
        if value is None:
            log.error(f'Missing parameter: {name}')
            return Response(
                content_type="text/plain",
                body=f"Error: missing {name} parameter"
            )
    for parameter in ("coordinate_system",):
        if parameter in request.params:
            extra_params[parameter] = request.params[parameter]

    log.debug(f'New request {request_id}: {product} {start_time} {stop_time}')

    var = speasy.get_data(product=product, start_time=start_time, stop_time=stop_time, **extra_params)

    result, mime = compress_if_asked(*encode_output(var, request), request)

    request_duration = (time.time_ns() - request_start_time) / 1000.

    if var is not None:
        if len(var.time):
            log.debug(
                f'{request_id}, duration = {request_duration}us, Got data: data shape = {var.data.shape}, data start time = {var.time[0]}, data stop time = {var.time[-1]}')
        else:
            log.debug(f'{request_id}, duration = {request_duration}us,Got empty data')
    else:
        log.debug(f'{request_id}, duration = {request_duration}us, Got None')

    del var

    return Response(content_type=mime, body=result)
