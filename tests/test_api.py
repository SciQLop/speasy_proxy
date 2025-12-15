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
        self.assertIn(b'Speasy', response.content)

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

    def test_is_up_known_provider(self):
        response = self.client.get("/is_up?provider=ssc")
        self.assertEqual(response.status_code, 200)
        json_response = response.json()
        self.assertIn('provider', json_response)
        self.assertIn('is_up', json_response)
        self.assertEqual(json_response['provider'], 'ssc')
        self.assertIsInstance(json_response['is_up'], bool)
        self.assertEqual(json_response['is_up'], True)

    def test_is_up_unknown_provider(self):
        response = self.client.get("/is_up?provider=unknown_provider")
        self.assertEqual(response.status_code, 404)
        json_response = response.json()
        self.assertIn('provider', json_response)
        self.assertIn('is_up', json_response)
        self.assertIn('error', json_response)
        self.assertEqual(json_response['provider'], 'unknown_provider')
        self.assertEqual(json_response['is_up'], False)
        self.assertIn('Provider unknown_provider not found', json_response['error'])

    def test_get_inventory_of_unknown_provider(self):
        response = self.client.get("/get_inventory?provider=unknown_provider")
        self.assertEqual(response.status_code, 400)
        self.assertIn('Unknown or disabled provider', response.text)

    @data(("Sat, 01 Jan 2000 00:00:00 GMT", 200), ("Sat, 01 Jan 2000 00:00:00 UTC", 200),
          ("Sat, 01 Jan 2100 00:00:00 GMT", 304), (datetime.now().isoformat(), 304),
          (datetime.now(UTC).isoformat(), 304))
    @unpack
    def test_get_inventory_up_to_date(self, if_modified_since, code):
        response = self.client.get("/get_inventory?provider=ssc", headers={"If-Modified-Since": if_modified_since})
        self.assertEqual(response.status_code, code)

    def test_get_data(self):
        response = self.client.get("/get_data?path=amda/c1_b_gsm&start_time=2018-10-24T00:00:00&stop_time=2018-10-24T02:00:00&format=python_dict&zstd_compression=False")
        self.assertEqual(response.status_code, 200)
        self.assertIsNotNone(response.content)

    def test_get_cache_entries(self):
        response = self.client.get("/get_cache_entries")
        self.assertEqual(response.status_code, 200)
        self.assertIsNotNone(response.content)
