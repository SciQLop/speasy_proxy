from pyramid.config import Configurator
import os
from datetime import datetime
from .index import index


def main(global_config, **settings):
    """ This function returns a Pyramid WSGI application.
    """
    index["up_since"] = datetime.now()
    with Configurator(settings=settings) as config:
        config.include('pyramid_jinja2')
        config.include('.routes')
        config.scan()
        config.pyramid_openapi3_spec(os.path.join(os.path.dirname(__file__), "../api_docs/openapi.yaml"),
                                     route='/api/v1/openapi.yaml')
        config.pyramid_openapi3_add_explorer(route='/api/v1/')
    return config.make_wsgi_app()
