# Plot Presets Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add server-side JSON preset files that define plot configurations, served via API and displayed on homepage (featured) and plot sidebar (all).

**Architecture:** Presets are JSON files in a configurable directory. A `featured/` subdirectory flags homepage presets. A new `GET /get_presets` endpoint loads and caches them. Both `index.html` and `plot.html` fetch and display them.

**Tech Stack:** FastAPI, JSON, Jinja2 templates, vanilla JS

---

### Task 1: Create preset loader module and API endpoint

**Files:**
- Create: `speasy_proxy/backend/presets.py`
- Create: `speasy_proxy/api/v1/get_presets.py`
- Modify: `speasy_proxy/api/v1/routes.py`

**Step 1: Create the preset loader**

Create `speasy_proxy/backend/presets.py`:

```python
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
```

**Step 2: Create the API endpoint**

Create `speasy_proxy/api/v1/get_presets.py`:

```python
import os
from pathlib import Path
from fastapi import APIRouter
from ...backend.presets import load_presets

router = APIRouter()

_default_presets_dir = Path(__file__).parent.parent.parent / "presets"


@router.get("/get_presets")
def get_presets():
    presets_dir = os.environ.get("SPEASY_PROXY_PRESETS_PATH", str(_default_presets_dir))
    return load_presets(presets_dir)
```

**Step 3: Register the route**

Add to `speasy_proxy/api/v1/routes.py`:

```python
from .get_presets import router as presets_router
router.include_router(presets_router)
```

Wait — looking at the current `routes.py`, it's just `router = APIRouter()`. Let me check how other endpoints are registered.

Actually, looking at `__init__.py` of `api/v1/`, the routes are likely imported there. Let me check and adapt.

**Step 4: Commit**

```bash
git add speasy_proxy/backend/presets.py speasy_proxy/api/v1/get_presets.py speasy_proxy/api/v1/routes.py
git commit -m "feat: add preset loader and GET /get_presets API endpoint"
```

---

### Task 2: Create sample preset files

**Files:**
- Create: `speasy_proxy/presets/featured/cluster1_magnetic_field.json`
- Create: `speasy_proxy/presets/featured/cluster1_ion_spectrogram.json`
- Create: `speasy_proxy/presets/mms1_fgm.json`

**Step 1: Create presets directory structure and sample files**

These are example presets using common AMDA products.

**Step 2: Commit**

```bash
git add speasy_proxy/presets/
git commit -m "feat: add sample preset files"
```

---

### Task 3: Add presets to homepage

**Files:**
- Modify: `speasy_proxy/templates/index.html`

**Step 1: Add a "Featured Plots" section between the hero and the dashboard**

After the hero section closing tag, before `<main class="dashboard">`, add a new section that fetches `/get_presets` and renders featured preset cards. Each card links to `/plot?config=<base64>`.

Add CSS for the preset cards matching the existing dark theme.

**Step 2: Add JS to fetch and render preset cards**

In the script section, fetch `get_presets`, filter for `featured: true`, and create cards dynamically. Each card uses the same `configToBase64` encoding as the plot page.

**Step 3: Commit**

```bash
git add speasy_proxy/templates/index.html
git commit -m "feat: show featured presets on homepage"
```

---

### Task 4: Add presets to plot sidebar

**Files:**
- Modify: `speasy_proxy/templates/plot.html`

**Step 1: Add a collapsible "Presets" section above the product tree**

In the sidebar HTML, add a new section between the sidebar header and the tree container. It should load presets from `/get_presets` and list them as clickable items.

**Step 2: Wire clicking a preset to applyConfig**

When a preset is clicked, call `applyConfig(preset.config)` which already handles populating plotState and triggering fetches.

**Step 3: Commit**

```bash
git add speasy_proxy/templates/plot.html
git commit -m "feat: add presets section to plot sidebar"
```
