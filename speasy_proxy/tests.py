import unittest

import pickle
from datetime import datetime, timezone
from speasy.common.variable import SpeasyVariable

from pyramid import testing
from pyramid.paster import get_appsettings


class ViewTests(unittest.TestCase):
    def setUp(self):
        self.config = testing.setUp()

    def tearDown(self):
        testing.tearDown()

    def test_my_view(self):
        from .views.default import my_view
        request = testing.DummyRequest()
        request.user_agent = "blah"
        info = my_view(request)
        for key in ['entries', 'cache_disk_size', 'up_date', 'up_duration', 'cache_hits', 'cache_misses']:
            self.assertIn(key, info)


class FunctionalTests(unittest.TestCase):
    def setUp(self):
        from speasy_proxy import main
        app = main(global_config=None, **get_appsettings('development.ini', name='main'))
        from webtest import TestApp
        self.testapp = TestApp(app)

    def _get_data(self, path, start, stop):
        res = self.testapp.get(url='/get_data', params={'start_time': start, 'stop_time': stop, 'path': path},
                               status=200)
        v = pickle.loads(res.body)
        self.assertIsNotNone(v)
        self.assertIs(type(v), SpeasyVariable)
        self.assertGreater(len(v), 0)

    def test_home(self):
        res = self.testapp.get('/', status=200)
        self.assertTrue(b'SPEASY proxy' in res.body)

    def test_get_data(self):
        start_time = datetime(2006, 1, 8, 1, 0, 0, tzinfo=timezone.utc)
        stop_time = datetime(2006, 1, 8, 1, 0, 5, tzinfo=timezone.utc)
        path = 'amda/c1_b_gsm'
        self._get_data(path=path, start=start_time, stop=stop_time)

    def test_get_data_time_format(self):
        stop_time = datetime(2006, 1, 8, 1, 0, 5, tzinfo=timezone.utc)
        path = 'amda/c1_b_gsm'
        for start_time in [datetime(2006, 1, 8, 1, 0, 0, tzinfo=timezone.utc),
                           datetime(2006, 1, 8, 1, 0, 0, tzinfo=timezone.utc).isoformat(),
                           '2006-01-08 00:00:00','2006-01-08T00:00:00','2006-01-08T00:00:00Z']:
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