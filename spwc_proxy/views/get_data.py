from pyramid.view import view_config
from pyramid.response import Response
import pickle
import spwc


@view_config(route_name='get_data', renderer='json')
def get_data(request):
    params = {}
    for parameter in ("path", "start_time", "stop_time"):
        value = request.params.get(parameter, None)
        if value is None:
            return Response(
                content_type="text/plain",
                body="Error: missing {name} parameter".format(name=parameter)
            )
        params[parameter] = value
    var = spwc.get_data(**params)
    result = pickle.dumps(var)
    return Response(content_type="text/plain", body=result)
