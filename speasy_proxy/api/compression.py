import pyzstd


def compress_if_asked(data: bytes | str, mime: str, zstd_compression: bool = False) -> tuple[bytes | str, str]:
    if zstd_compression:
        if isinstance(data, str):
            data = data.encode()
        return pyzstd.compress(data), "application/x-zstd-compressed"
    return data, mime
