# Import each endpoint module for its side-effect (registering routes on the shared
# router via @router.get). Use `from . import X` rather than `from .X import *` so the
# endpoint functions don't shadow their same-named submodules in this namespace (BL-10).
from . import (
    chart_roulette,
    get_cache_entries,
    get_data,
    get_presets,
    get_inventory,
    get_speasy_version,
    get_version,
    get_server_status,
    is_up,
    ws_collaboration,
)
from .routes import router as api_router
