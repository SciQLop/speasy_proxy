"""The HAPI server, as a FastAPI app meant to be mounted at a path ending in /hapi (the spec asks for it).

Only depends on speasy: everything else comes through create_hapi_app's arguments.
"""
import asyncio
import html
import logging
from email.utils import format_datetime
from datetime import timedelta
from typing import Dict, List, Optional

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from .catalog import HapiDataset, split_fetch_key
from .encoding import build_columns, header_line, merge_time_axes, to_binary, to_csv
from .info import DatasetInfo, Fetch
from .service import HapiService
from .status import HAPI_VERSION, NO_DATA, OK, HapiError, ok
from .times import parse_hapi_time

log = logging.getLogger(__name__)

OUTPUT_FORMATS = {"csv": "text/csv; charset=utf-8", "binary": "application/octet-stream"}


def _query(request: Request, allowed: set) -> Dict[str, str]:
    params = dict(request.query_params)
    unknown = sorted(set(params) - allowed)
    if unknown:
        raise HapiError(1401, ", ".join(unknown))
    return params


def _first(params: Dict[str, str], *names: str) -> Optional[str]:
    """HAPI 3 renamed id/time.min/time.max to dataset/start/stop; both spellings are accepted."""
    return next((params[n] for n in names if n in params), None)


def _select(info: DatasetInfo, requested: Optional[str]) -> List[dict]:
    """Time plus the requested parameters (all when none), which must follow the /info order."""
    parameters = info.parameters
    names = [n for n in (requested or "").split(",") if n]
    if not names:
        return parameters
    if names == ["Time"]:
        return parameters[:1]
    if names[0] == "Time":
        names = names[1:]
    index = {p["name"]: i for i, p in enumerate(parameters)}
    unknown = [n for n in names if n not in index]
    if unknown:
        raise HapiError(1407, ", ".join(unknown))
    positions = [index[n] for n in names]
    if positions != sorted(set(positions)):
        raise HapiError(1411)
    return [parameters[0]] + [parameters[i] for i in positions]


def _info_body(dataset: HapiDataset, info: DatasetInfo, parameters: List[dict], status=OK) -> dict:
    body = {**ok(status), "startDate": dataset.start_date, "stopDate": dataset.stop_date,
            "sampleStartDate": info.sample_start, "sampleStopDate": info.sample_stop,
            "parameters": parameters}
    if dataset.description:
        body["description"] = dataset.description
    if dataset.resource_url:
        body["resourceURL"] = dataset.resource_url
    if info.cadence:
        body["cadence"] = info.cadence
    return body


def _landing(prefix: str, title: str) -> str:
    links = "".join(f'<li><a href="{prefix}/{e}">{e}</a></li>' for e in ("about", "capabilities", "catalog"))
    return (f"<!doctype html><html><head><meta charset='utf-8'><title>{html.escape(title)} HAPI server</title>"
            f"</head><body><h1>{html.escape(title)} HAPI server</h1>"
            f"<p>A <a href='https://hapi-server.org'>HAPI</a> {HAPI_VERSION} server.</p><ul>{links}</ul>"
            f"<p>Example: <code>{prefix}/info?dataset=&lt;id&gt;</code>, "
            f"<code>{prefix}/data?dataset=&lt;id&gt;&amp;start=&lt;time&gt;&amp;stop=&lt;time&gt;</code></p>"
            f"</body></html>")


def create_hapi_app(fetch: Fetch, info_cache_path: str, max_request_duration: timedelta,
                    server_id: str = "speasy", title: str = "Speasy", contact: str = "",
                    tree_lock=None, inventories=None, cors: bool = True) -> FastAPI:
    """`fetch(path, start, stop, **options)` returns the speasy variable of a product path (blocking);
    options are extra get_data arguments, such as a trajectory's coordinate frame.
    `tree_lock()` returns a context manager guarding reads of speasy's inventory tree against a
    concurrent refresh. `inventories` replaces speasy's own flat_inventories (tests, conformance runs).
    `cors=False` when the app it's mounted in already sends CORS headers (HAPI wants them for browser clients)."""
    service = HapiService(fetch, info_cache_path, tree_lock=tree_lock, inventories=inventories)
    app = FastAPI(title=f"{title} HAPI server", openapi_url=None, docs_url=None, redoc_url=None)
    app.state.hapi = service
    if cors:
        app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"])

    def metadata(body: dict) -> JSONResponse:
        # Metadata only changes with the inventory, i.e. when the catalog is rebuilt.
        return JSONResponse(body, headers={"Last-Modified": format_datetime(service.catalog_built_at, usegmt=True)})

    @app.exception_handler(HapiError)
    async def _hapi_error(request: Request, e: HapiError):
        return JSONResponse(status_code=e.http_status, content=e.body())

    @app.get("/", response_class=HTMLResponse)
    async def landing(request: Request):
        return _landing(request.scope.get("root_path", ""), title)

    @app.get("/about")
    async def about(request: Request):
        _query(request, set())
        return metadata({**ok(), "id": server_id, "title": title, "contact": contact})

    @app.get("/capabilities")
    async def capabilities(request: Request):
        _query(request, set())
        return metadata({**ok(), "outputFormats": list(OUTPUT_FORMATS)})

    @app.get("/catalog")
    async def catalog(request: Request):
        params = _query(request, {"depth"})
        if params.get("depth", "dataset") != "dataset":
            raise HapiError(1400, "only depth=dataset is supported")
        datasets = await run_in_threadpool(service.catalog)
        return metadata({**ok(), "catalog": [{"id": d.id, "title": d.title} for d in datasets.values()]})

    @app.get("/info")
    async def info(request: Request):
        params = _query(request, {"dataset", "id", "parameters", "resolve_references"})
        # Responses never contain references, so either value gives the same /info.
        if params.get("resolve_references", "true") not in ("true", "false"):
            raise HapiError(1412, params["resolve_references"])
        # The first call after an inventory refresh rebuilds the catalog: off the event loop.
        dataset = await run_in_threadpool(service.dataset, _first(params, "dataset", "id"))
        dataset_info = await run_in_threadpool(service.info, dataset)
        return metadata(_info_body(dataset, dataset_info, _select(dataset_info, params.get("parameters"))))

    @app.get("/data")
    async def data(request: Request):
        params = _query(request, {"dataset", "id", "start", "stop", "time.min", "time.max", "parameters",
                                  "format", "include"})
        dataset = await run_in_threadpool(service.dataset, _first(params, "dataset", "id"))
        start, stop = _time_range(params, max_request_duration)
        fmt, include = _output_options(params)

        dataset_info = await run_in_threadpool(service.info, dataset)
        parameters = _select(dataset_info, params.get("parameters"))
        # Time alone still needs a parameter fetched for its timestamps.
        paths = sorted({dataset_info.sources[p["name"]][0] for p in (parameters[1:] or dataset_info.parameters[1:2])})
        variables = await _fetch_all(service.fetch, paths, start, stop)
        body, n = await _encoded(dataset, parameters, dataset_info, variables, start, stop, fmt)
        if include == "header":
            header = {**_info_body(dataset, dataset_info, parameters, status=OK if n else NO_DATA), "format": fmt}
            body = header_line(header) + body
        return Response(content=body, media_type=OUTPUT_FORMATS[fmt])

    return app


def _output_options(params: Dict[str, str]):
    fmt = params.get("format") or "csv"
    if fmt not in OUTPUT_FORMATS:
        raise HapiError(1409, fmt)
    include = params.get("include")
    if include not in (None, "", "header"):
        raise HapiError(1410, include)
    return fmt, include


async def _encoded(dataset: HapiDataset, parameters, dataset_info: DatasetInfo, variables, start, stop, fmt):
    try:
        return await run_in_threadpool(_encode, parameters, dataset_info, variables, start, stop, fmt)
    except HapiError:
        raise
    except Exception as e:
        log.exception(f"HAPI: failed to encode {dataset.id}")
        raise HapiError(1500, str(e))


def _time_range(params: Dict[str, str], max_request_duration: timedelta):
    raw_start, raw_stop = _first(params, "start", "time.min"), _first(params, "stop", "time.max")
    if raw_start is None or raw_stop is None:
        raise HapiError(1400, "start and stop are required")
    try:
        start = parse_hapi_time(raw_start)
    except ValueError as e:
        raise HapiError(1402, str(e))
    try:
        stop = parse_hapi_time(raw_stop)
    except ValueError as e:
        raise HapiError(1403, str(e))
    if start >= stop:
        raise HapiError(1404)
    if stop - start > max_request_duration:
        raise HapiError(1408, f"at most {max_request_duration} per request")
    return start, stop


async def _fetch_all(fetch: Fetch, keys: List[str], start, stop):
    async def one(key):
        path, options = split_fetch_key(key)
        try:
            return key, await run_in_threadpool(lambda: fetch(path, start, stop, **options))
        except Exception as e:
            log.exception(f"HAPI: failed to get {key}")
            raise HapiError(1501, f"{key}: {e}")

    return dict(await asyncio.gather(*(one(k) for k in keys)))


def _encode(parameters, dataset_info: DatasetInfo, variables, start, stop, fmt):
    time, variables = merge_time_axes(variables, start, stop)
    columns = build_columns(parameters, dataset_info.sources, time, variables)
    body = to_csv(columns) if fmt == "csv" else to_binary(parameters, columns)
    return body, len(time)
