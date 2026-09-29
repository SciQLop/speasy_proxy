from .routes import router


@router.get('/healthz', description='Liveness probe: answers as long as the server process serves requests. '
                                    'Never contacts a data provider (use /is_up for that).')
def healthz():
    return {"status": "ok"}
