import json
import logging
from pathlib import Path

log = logging.getLogger(__name__)

_cached_presets: list[dict] | None = None


def load_presets(presets_dir: str | Path) -> list[dict]:
    global _cached_presets
    if _cached_presets is not None:
        return _cached_presets

    presets_path = Path(presets_dir)
    presets = []

    if not presets_path.is_dir():
        log.warning(f"Presets directory not found: {presets_path}")
        _cached_presets = presets
        return presets

    for json_file in sorted(presets_path.glob("*.json")):
        preset = _load_preset_file(json_file, featured=False)
        if preset:
            presets.append(preset)

    featured_dir = presets_path / "featured"
    if featured_dir.is_dir():
        for json_file in sorted(featured_dir.glob("*.json")):
            preset = _load_preset_file(json_file, featured=True)
            if preset:
                presets.append(preset)

    _cached_presets = presets
    log.info(f"Loaded {len(presets)} presets ({sum(1 for p in presets if p['featured'])} featured)")
    return presets


def _load_preset_file(path: Path, featured: bool) -> dict | None:
    try:
        with open(path) as f:
            data = json.load(f)
        name = data.pop("name", path.stem)
        description = data.pop("description", "")
        return {
            "name": name,
            "description": description,
            "featured": featured,
            "config": data,
        }
    except Exception as e:
        log.error(f"Failed to load preset {path}: {e}")
        return None
