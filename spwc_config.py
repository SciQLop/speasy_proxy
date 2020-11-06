import argparse
from spwc.config import cache_size, cache_path
from spwc_proxy.config import index_path

parser = argparse.ArgumentParser()
parser.add_argument("-s", "--cache-size", help="Set max cache size", default='')
parser.add_argument("-p", "--cache-path", help="Set cache path", default='')
parser.add_argument("-i", "--index-path", help="Set server index path", default='')
args = parser.parse_args()

if args.cache_size != '':
    cache_size.set(args.cache_size)

if args.cache_path != '':
    cache_path.set(args.cache_path)

if args.index_path != '':
    index_path.set(args.index_path)