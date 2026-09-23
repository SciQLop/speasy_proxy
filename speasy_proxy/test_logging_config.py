import logging.handlers
import pathlib

import yaml

LOGGING_YAML = pathlib.Path(__file__).parent.parent / "logging.yaml"


def test_file_handlers_are_safe_with_several_worker_processes():
    """gunicorn runs many workers on one log file. A rotating handler rotates it from every worker on its own,
    so the others keep writing into the renamed file: rotated logs end up shuffled and truncated (seen in prod).
    Only WatchedFileHandler is safe: it never rotates, it reopens the file once the host's logrotate moved it."""
    handlers = yaml.safe_load(LOGGING_YAML.read_text())["handlers"]
    file_handlers = {name: h["class"] for name, h in handlers.items() if "filename" in h}

    assert file_handlers, "logging.yaml is expected to write log files"
    assert all(cls == "logging.handlers.WatchedFileHandler" for cls in file_handlers.values()), file_handlers
