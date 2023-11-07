from pyramid.view import notfound_view_config
import logging

log = logging.getLogger(__name__)


@notfound_view_config(renderer='../templates/404.jinja2')
def notfound_view(request):
    log.debug(f'Client asking for unknown page from {request.user_agent}')
    request.response.status = 404
    return {}
