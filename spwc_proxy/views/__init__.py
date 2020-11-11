import pickle


def _protocol(request):
    return min(int(request.params.get("pickle_proto", 3)), pickle.HIGHEST_PROTOCOL)


def pickle_data(data, request):
    return pickle.dumps(data, protocol=_protocol(request))
