def includeme(config):
    config.add_static_view('static', 'speasy_proxy:static', cache_max_age=3600)
    config.add_route('home', '/')
    config.add_route('get_data', '/get_data')
    config.add_route('get_cache_entries', '/get_cache_entries')
    config.add_route('get_speasy_version', '/get_speasy_version')
    config.add_route('get_version', '/get_version')
