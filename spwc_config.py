import argparse
from spwc.config import cache_size, cache_path
from spwc_proxy.config import index_path
from jinja2 import Environment, PackageLoader, select_autoescape


def is_true(value: str):
    if value == "True" or value == "true":
        return True
    return False


env = Environment(
    loader=PackageLoader('spwc_proxy', 'templates'),
    autoescape=select_autoescape(['ini'])
)

parser = argparse.ArgumentParser()
parser.add_argument("-s", "--cache-size", help="Set max cache size", default='')
parser.add_argument("-p", "--cache-path", help="Set cache path", default='')
parser.add_argument("-i", "--index-path", help="Set server index path", default='')
parser.add_argument("-u", "--proxy-url", help="Proxy URL", default='')
parser.add_argument("-w", "--server-port", help="Set server port", default='6543')
parser.add_argument("-x", "--enable-proxy", help="Enable proxy server in waitress config", default='')
parser.add_argument("-y", "--proxy-prefix", help="Add proxy prefix path waitress config", default='')
parser.add_argument("-z", "--config-path", help="Sever .ini config file path", default='')
args = parser.parse_args()

if args.cache_size != '':
    cache_size.set(args.cache_size)

if args.cache_path != '':
    cache_path.set(args.cache_path)

if args.index_path != '':
    index_path.set(args.index_path)

if args.config_path != "":
    with open(args.config_path, 'w') as ini_file, open('/tmp/openapi.yaml', 'w') as api_doc:
        production_ini = env.get_template('production.ini.jinja2')
        ini_file.write(production_ini.render(host='0.0.0.0', port=args.server_port, proxy_prefix=args.proxy_prefix,
                                             enable_proxy=is_true(args.enable_proxy), api_docs="/tmp/openapi.yaml"))
        api_doc_template = env.get_template('openapi.yaml.jinja2')
        api_doc.write(api_doc_template.render(server_url=f"{args.proxy_url}{args.proxy_prefix}"))
