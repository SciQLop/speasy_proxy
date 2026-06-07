from diskcache import Index

import speasy_proxy.index as index_mod


def test_index_entry_preserves_existing_value(tmp_path, monkeypatch):
    """Regression for BL-8: constructing an IndexEntry for a key that already has a
    value must NOT clobber it back to the default (the store is meant to persist)."""
    monkeypatch.setattr(index_mod, "_index", Index(str(tmp_path / "idx")))
    index_mod.IndexEntry("k", default="initial").set("changed")
    assert index_mod.IndexEntry("k", default="initial").value() == "changed"


def test_index_entry_sets_default_when_absent(tmp_path, monkeypatch):
    monkeypatch.setattr(index_mod, "_index", Index(str(tmp_path / "idx")))
    assert index_mod.IndexEntry("fresh", default="d").value() == "d"
