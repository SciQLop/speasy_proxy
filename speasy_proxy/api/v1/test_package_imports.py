import types


def test_endpoint_submodules_not_shadowed():
    """Regression for BL-10: star-imports bound each endpoint *function* into the
    package namespace, shadowing the same-named submodule. The submodules must stay
    importable as modules."""
    from speasy_proxy.api.v1 import is_up, get_data, get_inventory
    assert isinstance(is_up, types.ModuleType)
    assert isinstance(get_data, types.ModuleType)
    assert isinstance(get_inventory, types.ModuleType)


def test_api_router_exported_with_routes():
    from speasy_proxy.api.v1 import api_router
    paths = {getattr(r, "path", "") for r in api_router.routes}
    assert any("get_data" in p for p in paths)
    assert any("get_inventory" in p for p in paths)
