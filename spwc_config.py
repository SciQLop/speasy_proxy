import argparse
from spwc.config import cache_size, cache_path


parser = argparse.ArgumentParser()
parser.add_argument("-s", "--cache-size", help="Set max cache size", default='')
parser.add_argument("-p", "--cache-path", help="Set cache path", default='')
args = parser.parse_args()

if args.cache_size != '':
    cache_size.set(args.cache_size)

if args.cache_path != '':
    cache_path.set(args.cache_path)