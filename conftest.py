import os

# Opt-in offline mode for unit tests: when SPEASY_PROXY_OFFLINE_TESTS is set, make
# importing speasy_proxy network-free and fast. The resample / is_up / bokeh /
# get_inventory unit tests need no live provider. Inert by default, so network-bound
# tests such as tests/test_api.py are unaffected. See BACKLOG BL-11.
if os.environ.get("SPEASY_PROXY_OFFLINE_TESTS"):
    # speasy instantiates every provider at `import speasy` (eager init probe); a
    # degraded provider can hang the whole import. Disabling them is speasy's own
    # supported, provider-agnostic mechanism (SPEASY_CORE_DISABLED_PROVIDERS). Must
    # be set before speasy is imported.
    os.environ.setdefault(
        "SPEASY_CORE_DISABLED_PROVIDERS",
        "amda,cda,cdaweb,csa,ssc,sscweb,archive,uiowaephtool",
    )

    import speasy

    # Also skip the import-time inventory fetch speasy_proxy/__init__.py performs.
    speasy.update_inventories = lambda *args, **kwargs: None
