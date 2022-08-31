import unittest

import pickle
from datetime import datetime, timezone

import zstd
from speasy.products.variable import SpeasyVariable, from_dictionary
from speasy.core.inventory import indexes
from pyramid import testing
from pyramid.paster import get_appsettings
from ddt import ddt, data, unpack
import itertools


class ViewTests(unittest.TestCase):
    def setUp(self):
        self.config = testing.setUp()

    def tearDown(self):
        testing.tearDown()

    def test_home(self):
        from .views.default import home
        request = testing.DummyRequest()
        request.user_agent = "blah"
        info = home(request)
        for key in ['entries', 'cache_disk_size', 'up_date', 'up_duration', 'cache_hits', 'cache_misses']:
            self.assertIn(key, info)


@ddt
class FunctionalTests(unittest.TestCase):
    def setUp(self):
        from speasy_proxy import main
        app = main(global_config=None, **get_appsettings('development.ini', name='main'))
        from webtest import TestApp
        self.testapp = TestApp(app)

    def _get_data(self, path, start, stop, format="speasy_variable", zstd_compression="false"):
        res = self.testapp.get(url='/get_data',
                               params={'start_time': start, 'stop_time': stop, 'path': path, 'format': format,
                                       'zstd_compression': zstd_compression},
                               status=200).body
        if zstd_compression == 'true':
            res = zstd.decompress(res)
        v = pickle.loads(res)
        if format == "python_dict":
            v = from_dictionary(v)
        self.assertIsNotNone(v)
        self.assertIs(type(v), SpeasyVariable)
        self.assertGreater(len(v), 0)

    def _get_inventory(self, provider, format="python_dict", zstd_compression="false"):
        res = self.testapp.get(url='/get_inventory',
                               params={'provider': provider, 'format': format,
                                       'zstd_compression': zstd_compression},
                               status=200).body
        if zstd_compression == 'true':
            res = zstd.decompress(res)
        if format == "python_dict":
            v = pickle.loads(res)
            v = indexes.from_dict(v)
        else:
            v = indexes.from_json(res)
        self.assertIsNotNone(v)
        self.assertIs(type(v), indexes.SpeasyIndex)

    def test_home(self):
        res = self.testapp.get('/', status=200)
        self.assertTrue(b'SPEASY proxy' in res.body)

    def test_get_data(self):
        start_time = datetime(2006, 1, 8, 1, 0, 0, tzinfo=timezone.utc)
        stop_time = datetime(2006, 1, 8, 1, 0, 5, tzinfo=timezone.utc)
        path = 'amda/c1_b_gsm'
        self._get_data(path=path, start=start_time, stop=stop_time)

    def test_get_data_as_python_dict(self):
        start_time = datetime(2006, 1, 8, 1, 0, 0, tzinfo=timezone.utc)
        stop_time = datetime(2006, 1, 8, 1, 0, 5, tzinfo=timezone.utc)
        path = 'amda/c1_b_gsm'
        self._get_data(path=path, start=start_time, stop=stop_time, format="python_dict")

    def test_get_data_as_zstd_python_dict(self):
        start_time = datetime(2006, 1, 8, 1, 0, 0, tzinfo=timezone.utc)
        stop_time = datetime(2006, 1, 8, 1, 0, 5, tzinfo=timezone.utc)
        path = 'amda/c1_b_gsm'
        self._get_data(path=path, start=start_time, stop=stop_time, format="python_dict", zstd_compression='true')

    @data(
        *list(itertools.product(['all', 'amda', 'csa', 'cda', 'ssc'], ['json', 'python_dict'], ['true', 'false']))
    )
    @unpack
    def test_get_inventory_as_zstd_python_dict(self, provider, format, zstd_compression):
        self._get_inventory(provider=provider, format=format, zstd_compression=zstd_compression)

    def test_get_data_time_format(self):
        stop_time = datetime(2006, 1, 8, 1, 0, 5, tzinfo=timezone.utc)
        path = 'amda/c1_b_gsm'
        for start_time in [datetime(2006, 1, 8, 1, 0, 0, tzinfo=timezone.utc),
                           datetime(2006, 1, 8, 1, 0, 0, tzinfo=timezone.utc).isoformat(),
                           '2006-01-08 00:00:00', '2006-01-08T00:00:00', '2006-01-08T00:00:00Z']:
            self._get_data(path=path, start=start_time, stop=stop_time)

    def test_get_cache_entries(self):
        res = self.testapp.get(url='/get_cache_entries', status=200)
        v = pickle.loads(res.body)
        self.assertIsNotNone(v)
        self.assertIs(type(v), list)
        self.assertGreater(len(v), 0)
        self.assertIs(type(v[0]), str)

    def test_get_api_doc(self):
        res = self.testapp.get(url='/api/v1/', status=200)

    def test_get_version(self):
        res = self.testapp.get(url='/get_version', status=200)
        from speasy_proxy import __version__
        self.assertTrue(str(__version__).encode() in res.body)
