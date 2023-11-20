from fastapi import FastAPI
from datetime import datetime, UTC
from fastapi.testclient import TestClient
from speasy_proxy import app, __version__
import speasy as spz
import unittest
from ddt import ddt, data, unpack


@ddt
class TestApi(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    def test_home(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'SPEASY proxy', response.content)

    def test_get_version(self):
        response = self.client.get("/get_version")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, __version__.encode())

    def test_get_speasy_version(self):
        response = self.client.get("/get_speasy_version")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, spz.__version__.encode())

    def test_get_inventory(self):
        response = self.client.get("/get_inventory?provider=ssc")
        self.assertEqual(response.status_code, 200)
        self.assertIsNotNone(response.content)
        self.assertIsNotNone(response.json())
        self.assertIn('Trajectories', response.json())

    @data(("Sat, 01 Jan 2000 00:00:00 GMT", 200), ("Sat, 01 Jan 2000 00:00:00 UTC", 200),
          ("Sat, 01 Jan 2100 00:00:00 GMT", 304), (datetime.now().isoformat(), 304),
          (datetime.now(UTC).isoformat(), 304))
    @unpack
    def test_get_inventory_up_to_date(self, if_modified_since, code):
        response = self.client.get("/get_inventory?provider=ssc", headers={"If-Modified-Since": if_modified_since})
        self.assertEqual(response.status_code, code)

    def test_get_cache_entries(self):
        response = self.client.get("/get_cache_entries")
        self.assertEqual(response.status_code, 200)
        self.assertIsNotNone(response.content)
