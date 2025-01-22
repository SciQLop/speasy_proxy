from fastapi import Query

import speasy as spz

QueryProvider = Query(default="ssc", enum=spz.list_providers(), example="ssc")
QueryZstd = Query(default=False, example=False)
QueryFormat = Query(default="json", example="json", enum=["json", "python_dict"])
QueryPickleProto = Query(default=3, example=3, ge=0, le=5)
QueryDataFormat = Query(default="python_dict", example="python_dict",
                        enum=["python_dict", "speasy_variable", "html_bokeh", "json", "cdf"])
