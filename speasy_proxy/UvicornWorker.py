from uvicorn.workers import UvicornWorker
import os


class SpeasyUvicornWorker(UvicornWorker):
    CONFIG_KWARGS = {
        "root_path": os.environ.get('SPEASY_PROXY_PREFIX', ''),
        "host": "0.0.0.0",
        "port": os.environ.get('PORT', 8000),
        "proxy_headers": True,
        "limit_concurrency": 1000,
        "log_config": os.environ.get("SPEASY_PROXY_LOG_CONFIG_FILE")
    }
