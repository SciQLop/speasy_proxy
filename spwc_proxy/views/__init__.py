import pickle


def _protocol(request):
    return int(request.params.get("pickle_proto", 3))


def pickle_data(data, request):
    return pickle.dumps(data, protocol=_protocol(request))
