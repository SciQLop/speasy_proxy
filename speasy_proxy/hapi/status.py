"""HAPI status codes (https://github.com/hapi-server/data-specification, "Status Codes")."""

HAPI_VERSION = "3.2"

OK = (1200, "OK")
NO_DATA = (1201, "OK - no data for time range")

# The spec's own wording: clients and the verifier look for the 'HAPI error <code>' prefix.
_MESSAGES = {
    1400: "HAPI error 1400: user input error",
    1401: "HAPI error 1401: unknown API parameter name",
    1402: "HAPI error 1402: error in start time",
    1403: "HAPI error 1403: error in stop time",
    1404: "HAPI error 1404: start time equal to or after stop time",
    1405: "HAPI error 1405: time outside valid range",
    1406: "HAPI error 1406: unknown dataset id",
    1407: "HAPI error 1407: unknown dataset parameter",
    1408: "HAPI error 1408: too much time or data requested",
    1409: "HAPI error 1409: unsupported output format",
    1410: "HAPI error 1410: unsupported include value",
    1411: "HAPI error 1411: out of order or duplicate parameters",
    1500: "HAPI error 1500: internal server error",
    1501: "HAPI error 1501: upstream request error",
}

_HTTP_STATUS = {1406: 404, 1407: 404, 1500: 500, 1501: 502}


class HapiError(Exception):
    def __init__(self, code: int, detail: str = ""):
        super().__init__(detail or _MESSAGES[code])
        self.code = code
        self.detail = detail

    @property
    def http_status(self) -> int:
        return _HTTP_STATUS.get(self.code, 400)

    def body(self) -> dict:
        message = _MESSAGES[self.code] + (f": {self.detail}" if self.detail else "")
        return {"HAPI": HAPI_VERSION, "status": {"code": self.code, "message": message}}


def ok(status=OK) -> dict:
    code, message = status
    return {"HAPI": HAPI_VERSION, "status": {"code": code, "message": message}}
