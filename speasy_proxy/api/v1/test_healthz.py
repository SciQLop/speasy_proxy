from fastapi import FastAPI
from fastapi.testclient import TestClient

from speasy_proxy.api.v1 import api_router


def test_healthz_answers_without_touching_providers():
    app = FastAPI()
    app.include_router(api_router)
    resp = TestClient(app).get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
