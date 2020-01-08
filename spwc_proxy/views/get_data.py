from pyramid.view import view_config
from pyramid.response import Response
import pickle
import spwc
from datetime import datetime
from spwc import SpwcVariable
import logging

log = logging.getLogger(__name__)


@view_config(route_name='get_data', renderer='json')
def get_data(request):
    params = {}
    for parameter in ("path", "start_time", "stop_time"):
        value = request.params.get(parameter, None)
        if value is None:
            log.error('Missing parameter: {name}'.format(name=parameter))
            return Response(
                content_type="text/plain",
                body="Error: missing {name} parameter".format(name=parameter)
            )
        params[parameter] = value
    log.debug('New request: {path} {start_time} {stop_time}'.format(**params))
    var: SpwcVariable = spwc.get_data(**params)
    if var is not None:
        if len(var.time):
            log.debug(
                'Got data: data shape = {shape}, data start time = {start_time}, data stop time = {stop_time}'.format(
                    shape=var.data.shape, start_time=datetime.fromtimestamp(var.time[0]),
                    stop_time=datetime.fromtimestamp(var.time[-1])))
        else:
            log.debug('Got empty data')
    else:
        log.debug('Got None')
    result = pickle.dumps(var)
    del var
    return Response(content_type="text/plain", body=result)
