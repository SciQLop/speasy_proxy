from typing import Annotated, Literal, Optional

from fastapi import Query
import speasy as spz

Provider = Annotated[str, Query(enum=spz.list_providers() + ["all"], examples=["ssc"],
                                description="Provider name, or 'all' for every provider.")]
ZstdCompression = Annotated[bool, Query(examples=[False], description="zstd-compress the whole response body.")]
Compression = Annotated[Optional[str], Query(
    examples=["blosc"],
    description="Per-array codec for format=python_dict, takes precedence over zstd_compression. "
                "'blosc': byte-shuffle + zstd per numpy array. Unknown values are ignored.")]
InventoryFormat = Annotated[Literal["json", "python_dict"], Query(
    examples=["json"], description="'json' is language-neutral; 'python_dict' is a Python pickle.")]
PickleProtocol = Annotated[int, Query(examples=[3], ge=1, le=5, description="Pickle protocol for the Python-only formats.")]
DataFormat = Annotated[Literal["python_dict", "speasy_variable", "html_bokeh", "json", "cdf"], Query(
    examples=["json"],
    description="Language-neutral: 'json' (NaN/fill values as null, times as int64 ns since 1970-01-01 UTC) and 'cdf' "
                "(ISTP CDF file). Python-only (pickle): 'python_dict' and 'speasy_variable'. "
                "'html_bokeh' returns an interactive HTML plot.")]
MaxPoints = Annotated[Optional[int], Query(ge=10, description="Target max points per component. None = full resolution.")]
ResampleStrategy = Annotated[Literal["lttb", "min_max"], Query(
    description="Downsampling used with max_points: 'lttb' keeps the visual shape, 'min_max' keeps each bucket's extremes.")]
