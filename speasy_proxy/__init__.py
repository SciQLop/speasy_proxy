__author__ = """Alexis Jeandet"""
__email__ = 'alexis.jeandet@member.fsf.org'
__version__ = '0.7.1'

from pyramid.config import Configurator
import os
from datetime import datetime
from .index import index
from apscheduler.schedulers.background import BackgroundScheduler
import speasy as spz
import logging

log = logging.getLogger(__name__)


def background_inventory_refresh():
    log.info("Background inventory refresh")
    spz.update_inventories()


scheduler = BackgroundScheduler()

scheduler.add_job(background_inventory_refresh, 'interval', hours=2)

scheduler.start()


def main(global_config, **settings):
    """ This function returns a Pyramid WSGI application.
    """
    index["up_since"] = datetime.now()
    with Configurator(settings=settings) as config:
        config.include('pyramid_jinja2')
        config.include('.routes')
        config.scan()
        config.pyramid_openapi3_spec(os.path.join(os.path.dirname(__file__), config.registry.settings["api_doc_path"]),
                                     route='/api/v1/spec')
        config.pyramid_openapi3_add_explorer(route='/api/v1/')
    return config.make_wsgi_app()
