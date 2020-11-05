from pyramid.config import Configurator
from spwc import cache
from datetime import datetime


def main(global_config, **settings):
    """ This function returns a Pyramid WSGI application.
    """
    cache._cache["up_since"] = datetime.now()
    with Configurator(settings=settings) as config:
        config.include('pyramid_jinja2')
        config.include('.routes')
        config.scan()
        config.pyramid_openapi3_spec('api_docs/openapi.yaml', route='/api/v1/openapi.yaml')
        config.pyramid_openapi3_add_explorer(route='/api/v1/')
    return config.make_wsgi_app()
