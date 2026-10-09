"""Maps speasy's inventory to HAPI datasets.

HAPI needs every parameter of a dataset on one time column, while speasy fetches parameter by
parameter. So a HAPI dataset is a group of speasy parameters known to share their time axis:

- amda, csa: a speasy dataset (its parameters share one time axis);
- cda: a speasy dataset split per time variable (DEPEND_0) the way CDAWeb's own HAPI server does,
  as ``<DATASET>@<i>`` when it has several, ``<DATASET>`` otherwise;
- ssc, cdpp3dview: a body's trajectory, with one parameter per coordinate frame
  (``position_gse``, ``position_GSM``...): all frames share the time axis, shape and units.

/data still checks the time axes really match before merging parameters.
"""
import logging
import re
from dataclasses import dataclass, field
from typing import Callable, Dict, Iterable, List, Optional, Tuple
from urllib.parse import parse_qsl, urlencode

from speasy.core.inventory.indexes import DatasetIndex, ParameterIndex, TemplatedParameterIndex

from .times import to_hapi_time

log = logging.getLogger(__name__)

# Trajectory frames offered as parameters, the provider's default (the one sampled for /info) first,
# spelled as each provider's API takes them; parameters are named position_<frame>.
SSC_FRAMES = ("gse", "gsm", "sm", "geo", "gm", "geitod", "geij2000")
CDPP3DVIEW_FRAMES = ("J2000", "ECLIPJ2000", "HEE", "HEEQ", "HCI", "GSE", "GSM", "SM")
_FRAME_OPTION = {"ssc": "coordinate_system", "cdpp3dview": "coordinate_frame"}
_FRAMES = {"ssc": SSC_FRAMES, "cdpp3dview": CDPP3DVIEW_FRAMES}


def fetch_key(path: str, options: Optional[Dict[str, str]] = None) -> str:
    """What identifies one upstream fetch: a speasy path, plus get_data options if any."""
    return f"{path}?{urlencode(sorted(options.items()))}" if options else path


def split_fetch_key(key: str) -> Tuple[str, Dict[str, str]]:
    path, _, query = key.partition("?")
    return path, dict(parse_qsl(query))


@dataclass(frozen=True)
class HapiParameterSource:
    name: str  # HAPI parameter name
    path: str  # speasy product path, as /get_data takes it
    description: Optional[str] = field(default=None, compare=False)
    options: Tuple[Tuple[str, str], ...] = ()  # extra get_data arguments (e.g. the coordinate frame)
    # Described as a copy of that parameter instead of being sampled (same shape and units).
    like: Optional[str] = None
    coordinate_system: Optional[str] = None

    @property
    def key(self) -> str:
        return fetch_key(self.path, dict(self.options))


@dataclass(frozen=True)
class HapiDataset:
    id: str
    title: str
    start_date: str
    stop_date: str
    parameters: Tuple[HapiParameterSource, ...]
    description: Optional[str] = None
    resource_url: Optional[str] = None
    extra: Dict[str, str] = field(default_factory=dict, compare=False, hash=False)


def _path(p: ParameterIndex) -> str:
    return f"{p.spz_provider()}/{p.spz_uid()}"


def _parameters_of(dataset: DatasetIndex) -> List[ParameterIndex]:
    return [v for v in dataset.__dict__.values()
            if isinstance(v, ParameterIndex) and not isinstance(v, TemplatedParameterIndex)]


def _is_public(p) -> bool:
    # AMDA marks parameters that need an account; their values are bools or 'True'/'False' strings.
    return str(getattr(p, "is_public", True)).lower() != "false"


def _dates(index) -> Optional[Tuple[str, str]]:
    try:
        return to_hapi_time(index.start_date), to_hapi_time(index.stop_date)
    except (AttributeError, ValueError, OverflowError):
        return None


def _make(dataset_id: str, title: str, index, params: List[ParameterIndex], name_of: Callable,
          description=None, resource_url=None) -> Optional[HapiDataset]:
    dates = _dates(index)
    if not params or dates is None:
        return None
    sources = tuple(HapiParameterSource(name=name_of(p), path=_path(p), description=_param_description(p))
                    for p in params)
    if len({s.name for s in sources}) != len(sources):
        log.warning(f"Skipping HAPI dataset {dataset_id}: duplicate parameter names")
        return None
    return HapiDataset(id=dataset_id, title=title or dataset_id, start_date=dates[0], stop_date=dates[1],
                       parameters=sources, description=description, resource_url=resource_url)


def _param_description(p: ParameterIndex) -> Optional[str]:
    # amda: description, csa: cat_description, cda: CATDESC
    for attr in ("description", "cat_description", "CATDESC"):
        if value := getattr(p, attr, None):
            return str(value)
    return None


def _plain(text: Optional[str]) -> Optional[str]:
    """AMDA descriptions are HTML snippets: 'CA60 - ACE EPAM 5-min Level 2 Data<br/> Sampling: 5M<br/> ...'."""
    if not text:
        return text
    parts = [re.sub(r"<[^>]+>", "", part).strip() for part in re.split(r"<br\s*/?>", str(text))]
    return "; ".join(p for p in parts if p)


def _uid_tail(p: ParameterIndex) -> str:
    return p.spz_uid().rsplit("/", 1)[-1]


def _amda(uid: str, ds: DatasetIndex) -> Iterable[HapiDataset]:
    if not _is_public(ds):
        return []
    params = [p for p in _parameters_of(ds) if _is_public(p)]
    description = _plain(getattr(ds, "desc", None))
    title = description.split(";", 1)[0] if description else ds.spz_name()
    return [_make(f"amda/{uid}", title, ds, params, _uid_tail, description=description)]


def _csa(uid: str, ds: DatasetIndex) -> Iterable[HapiDataset]:
    return [_make(f"csa/{uid}", getattr(ds, "title", None) or ds.spz_name(), ds, _parameters_of(ds), _uid_tail,
                  description=getattr(ds, "description", None))]


class _MissingDepend0(Exception):
    """Inventories built by speasy < SciQLop/speasy#401 don't record DEPEND_0: without it, which
    parameters share a time axis is unknown."""


def _cda_groups(params: List[ParameterIndex]) -> List[List[ParameterIndex]]:
    groups: Dict[str, List[ParameterIndex]] = {}
    for p in params:
        depend_0 = getattr(p, "DEPEND_0", None)
        if not depend_0:
            raise _MissingDepend0()
        groups.setdefault(depend_0, []).append(p)
    return list(groups.values())


def _cda(uid: str, ds: DatasetIndex) -> Iterable[HapiDataset]:
    groups = _cda_groups(_parameters_of(ds))
    title = getattr(ds, "description", None) or ds.spz_name()
    resource_url = f"https://cdaweb.gsfc.nasa.gov/misc/Notes{uid[0]}.html#{uid}"
    return [_make(f"cda/{uid}" if len(groups) == 1 else f"cda/{uid}@{i}", title, ds, group, _uid_tail,
                  description=title, resource_url=resource_url)
            for i, group in enumerate(groups)]


def _trajectories(provider: str):
    option, frames = _FRAME_OPTION[provider], _FRAMES[provider]

    def build(uid: str, p: ParameterIndex) -> Iterable[HapiDataset]:
        dates = _dates(p)
        if dates is None:
            return []
        first = f"position_{frames[0]}"
        sources = tuple(
            HapiParameterSource(name=f"position_{frame}", path=_path(p), options=((option, frame),),
                                description=f"{p.spz_name()} position in {frame.upper()}",
                                like=None if i == 0 else first, coordinate_system=frame.upper())
            for i, frame in enumerate(frames))
        return [HapiDataset(id=f"{provider}/{uid}", title=f"{p.spz_name()} trajectory", start_date=dates[0],
                            stop_date=dates[1], parameters=sources, description=getattr(p, "description", None))]
    return build


# provider -> (which flat inventory mapping to walk, builder of the HAPI datasets of one of its entries)
_PROVIDERS = {
    "amda": ("datasets", _amda),
    "cda": ("datasets", _cda),
    "csa": ("datasets", _csa),
    "ssc": ("parameters", _trajectories("ssc")),
    "cdpp3dview": ("parameters", _trajectories("cdpp3dview")),
}


def build_catalog(flat_inventories) -> Dict[str, HapiDataset]:
    """{dataset id: HapiDataset}, sorted by id. Reads the in-memory inventory only (no network).
    An entry that can't be mapped is left out on its own, never its whole provider."""
    datasets: Dict[str, HapiDataset] = {}
    for provider, (mapping, build) in _PROVIDERS.items():
        flat = flat_inventories.__dict__.get(provider)
        if flat is None:
            continue
        without_depend_0 = 0
        for uid, index in getattr(flat, mapping).items():
            try:
                datasets.update((d.id, d) for d in build(uid, index) if d is not None)
            except _MissingDepend0:
                without_depend_0 += 1
            except Exception as e:
                log.warning(f"HAPI: leaving {provider}/{uid} out of the catalog: {e!r}")
        if without_depend_0:
            log.warning(f"{without_depend_0} {provider} datasets left out of the HAPI catalog: their inventory "
                        f"has no DEPEND_0 (needs speasy with SciQLop/speasy#401)")
    return dict(sorted(datasets.items()))
