import pickle
from fastapi import Request


def _protocol(pickle_proto: int = 3):
    return min(pickle_proto, pickle.HIGHEST_PROTOCOL)


def pickle_data(data, pickle_proto: int = 3):
    return pickle.dumps(data, protocol=_protocol(pickle_proto))
