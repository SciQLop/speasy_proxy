from typing import Annotated

from fastapi import Query
import speasy as spz

Provider = Annotated[str, Query(default="ssc", enum=spz.list_providers(), example="ssc")]
ZstdCompression = Annotated[bool, Query(default=False, example=False)]
InventoryFormat = Annotated[str, Query(default="json", example="json", enum=["json", "python_dict"])]
PickleProtocol = Annotated[int, Query(default=3, example=3, ge=0, le=5)]
DataFormat = Annotated[str, Query(
    default="python_dict", example="python_dict",
    enum=["python_dict", "speasy_variable", "html_bokeh", "json", "cdf"]
)]
