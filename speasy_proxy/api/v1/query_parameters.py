from typing import Annotated

from fastapi import Query
import speasy as spz

Provider = Annotated[str, Query(enum=spz.list_providers(), examples=["ssc"])]
ZstdCompression = Annotated[bool, Query(examples=[False])]
InventoryFormat = Annotated[str, Query(examples=["json"], enum=["json", "python_dict"])]
PickleProtocol = Annotated[int, Query(examples=[3], ge=0, le=5)]
DataFormat = Annotated[str, Query(
    examples=["python_dict"],
    enum=["python_dict", "speasy_variable", "html_bokeh", "json", "cdf"]
)]
