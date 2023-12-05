from ..config import index as index_cfg
from diskcache import Index

_index = Index(index_cfg.path())


class IndexEntry:
    def __init__(self, key: str, default=None):
        self._key = key
        with _index.transact():
            _index[self._key] = default

    def value(self):
        with _index.transact():
            return _index[self._key]

    def set(self, value):
        with _index.transact():
            _index[self._key] = value


up_since = IndexEntry("up_since", None)
