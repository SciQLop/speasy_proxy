import os
from pathlib import Path
from .routes import router
import logging

from speasy_proxy.backend.presets import load_presets

log = logging.getLogger(__name__)

_default_presets_dir = Path(__file__).parent.parent.parent / "presets"


@router.get("/get_presets", description="Get plot presets")
def get_presets():
    presets_dir = os.environ.get("SPEASY_PROXY_PRESETS_PATH", str(_default_presets_dir))
    return load_presets(presets_dir)
