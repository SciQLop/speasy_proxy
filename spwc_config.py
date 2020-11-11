import argparse, os
from spwc.config import cache_size, cache_path
from spwc_proxy.config import index_path
from jinja2 import Environment, PackageLoader, select_autoescape


def is_true(value: str):
    if value == "True" or value == "true":
        return True
    return False


def write_config_file(env, path, port, proxy_prefix, enable_proxy, api_docs):
    with open(path, 'w') as ini_file:
        production_ini = env.get_template('production.ini.jinja2')
        ini_file.write(production_ini.render(host='0.0.0.0', port=port, proxy_prefix=proxy_prefix,
                                             enable_proxy=enable_proxy, api_docs=api_docs))


def write_openapi_file(env, path, server_url, url_prefix):
    with  open(path, 'w') as api_doc, open(f'{os.path.dirname(os.path.realpath(__file__))}/spwc_proxy/api_docs/openapi.yaml',
                                           'r') as api_doc_body:
        api_doc_template = env.get_template('openapi.yaml.jinja2')
        api_doc.write(api_doc_template.render(server_url=f"{server_url}{url_prefix}", body=api_doc_body.read()))


def configure_cache(size='', path=''):
    if size != '':
        cache_size.set(size)
    if path != '':
        cache_path.set(path)


def configure_index(path=''):
    if path != '':
        index_path.set(path)


if __name__ == "__main__":
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

    configure_cache(size=args.cache_size, path=args.cache_path)
    configure_index(path=args.index_path)

    if args.config_path != "":
        env = Environment(
            loader=PackageLoader('spwc_proxy', 'templates'),
            autoescape=select_autoescape(['ini'])
        )
        write_config_file(env, path=args.config_path, port=args.server_port, proxy_prefix=args.proxy_prefix,
                          enable_proxy=is_true(args.enable_proxy), api_docs="/tmp/openapi.yaml")
        write_openapi_file(env, path='/tmp/openapi.yaml', server_url=args.proxy_url, url_prefix=args.proxy_prefix)
