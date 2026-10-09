"""Checks a HAPI server's compliance on every dataset of its catalog, in two phases:

1. the HAPI verifier (hapi-server/verifier-nodejs): fails on any verifier failure, and on any warning
   not listed in ALLOWED_WARNINGS below, so a new warning is either fixed or accepted here with a reason;
2. the data itself, which the verifier doesn't parse: every CSV field must be a number of the declared
   type, CSV and binary must agree value for value with the layout /info declares, and the official
   Python client (hapiclient) must read both formats to the same arrays.

    uv run --with hapiclient python tests/hapi_conformance/check.py --url http://127.0.0.1:8765 \
        --verifier path/to/verify.js
"""
import argparse
import json
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from collections import defaultdict

import numpy as np

# verifier test name -> why we accept that warning
ALLOWED_WARNINGS = {
    "is.CompressionAvailable": "gzip is left to the reverse proxy speasy-proxy is deployed behind "
                               "(Starlette's GZipMiddleware compresses on the event loop, see speasy_proxy/__init__.py)",
    "is.CIdentifier": "dataset ids are speasy paths (amda/..., cda/<DATASET>@<i>) on purpose, matching /get_data "
                      "and CDAWeb's own HAPI ids",
    "is.FileStructureOK": "asks for 'HAPI 1201' in the HTTP reason phrase, which uvicorn doesn't let an app set; "
                          "1201 is in the JSON header when include=header",
}


def _test_name(entry: dict) -> str:
    return entry["description"].split("(", 1)[0].strip()


def _report(raw: str) -> dict:
    """The JSON report comes after a few console lines."""
    start = raw.index("\n{\n") + 1
    report, _ = json.JSONDecoder().raw_decode(raw[start:])
    return report


def _verify(verifier: str, url: str, dataset: str, timeout_ms: int) -> dict:
    # To a file, not a pipe: the verifier ends with process.exit(), which truncates large piped output.
    with tempfile.TemporaryFile("w+") as stdout:
        out = subprocess.run(["node", verifier, "--url", url, "--dataset", dataset, "--output", "json",
                              "--datatimeout", str(timeout_ms), "--metatimeout", str(timeout_ms)],
                             stdout=stdout, stderr=subprocess.PIPE, text=True, timeout=30 * 60)
        stdout.seek(0)
        raw = stdout.read()
    try:
        return _report(raw)
    except ValueError:
        sys.exit(f"verifier output for {dataset} is not a JSON report:\n{raw[-2000:]}\n{out.stderr[-2000:]}")


def _get(url: str, **params) -> bytes:
    with urllib.request.urlopen(f"{url}?{urllib.parse.urlencode(params)}") as r:
        return r.read()


def _binary_dtype(parameters) -> np.dtype:
    fields = [("Time", f"S{parameters[0]['length']}")]
    for p in parameters[1:]:
        base = "<i4" if p["type"] == "integer" else "<f8"
        fields.append((p["name"], (base, tuple(p["size"])) if p.get("size") else base))
    return np.dtype(fields)


def _same(csv_value: float, binary_value: float) -> bool:
    # float32 data: CSV prints its shortest float32 form, binary its exact float64 widening.
    return (np.isnan(csv_value) and np.isnan(binary_value)) or csv_value == binary_value or \
        abs(csv_value - binary_value) <= 1.2e-7 * abs(binary_value)


def _check_csv_against_binary(parameters, csv: bytes, binary: bytes) -> list:
    dtype = _binary_dtype(parameters)
    if len(binary) % dtype.itemsize:
        return [f"binary length {len(binary)} is not a multiple of the {dtype.itemsize} byte record /info implies"]
    records = np.frombuffer(binary, dtype=dtype)
    rows = csv.decode("utf-8").splitlines()
    if len(rows) != len(records):
        return [f"{len(rows)} CSV rows but {len(records)} binary records"]
    problems = []
    for i, (row, record) in enumerate(zip(rows, records)):
        fields = row.split(",")
        if fields[0].encode() != record["Time"]:
            problems.append(f"row {i}: CSV time {fields[0]} != binary time {record['Time']}")
        values = fields[1:]
        expected = [(p, v) for p in parameters[1:] for v in np.ravel(record[p["name"]])]
        if len(values) != len(expected):
            problems.append(f"row {i}: {len(values)} values where /info implies {len(expected)}")
            continue
        for text, (p, binary_value) in zip(values, expected):
            try:
                value = int(text) if p["type"] == "integer" else float(text)
            except ValueError:
                problems.append(f"row {i}: {p['name']} = {text!r} is not a valid {p['type']}")
                continue
            fill = float(p["fill"]) if p.get("fill") not in (None, "NaN") else None
            # Clients find fill cells by exact comparison with /info's fill, in both formats.
            if fill is not None and (value == fill) != (binary_value == fill):
                problems.append(f"row {i}: {p['name']} is {text} in CSV and {binary_value!r} in binary, "
                                f"only one of them equal to the fill {p['fill']}")
            elif not _same(float(value), float(binary_value)):
                problems.append(f"row {i}: {p['name']} = {text} in CSV but {binary_value} in binary")
        if len(problems) >= 5:
            break
    return problems


def _check_with_hapiclient(url: str, dataset: str, start: str, stop: str) -> list:
    from hapiclient import hapi
    opts = {"logging": False, "usecache": False, "cache": False, "cachedir": tempfile.mkdtemp()}
    csv, _ = hapi(url, dataset, "", start, stop, format="csv", **opts)
    binary, _ = hapi(url, dataset, "", start, stop, format="binary", **opts)
    if csv.dtype.names != binary.dtype.names or csv.shape != binary.shape:
        return [f"hapiclient reads CSV as {csv.dtype} {csv.shape} but binary as {binary.dtype} {binary.shape}"]
    problems = []
    for name in csv.dtype.names[1:]:
        a, b = np.asarray(csv[name], dtype=float), np.asarray(binary[name], dtype=float)
        if not np.allclose(a, b, rtol=1.2e-7, atol=0, equal_nan=True):
            problems.append(f"hapiclient: {name} differs between CSV and binary")
    return problems


def check_data(url: str, dataset: str) -> list:
    info = json.loads(_get(f"{url}/info", dataset=dataset))
    start = info.get("sampleStartDate", info["startDate"])
    stop = info.get("sampleStopDate", info["stopDate"])
    request = dict(dataset=dataset, start=start, stop=stop)
    problems = _check_csv_against_binary(info["parameters"], _get(f"{url}/data", **request, format="csv"),
                                         _get(f"{url}/data", **request, format="binary"))
    return problems + _check_with_hapiclient(url, dataset, start, stop)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", required=True, help="HAPI server base URL (ending in /hapi when mounted)")
    parser.add_argument("--verifier", required=True, help="path to verifier-nodejs' verify.js")
    parser.add_argument("--timeout-ms", type=int, default=120_000)
    args = parser.parse_args()

    with urllib.request.urlopen(f"{args.url}/catalog") as r:
        datasets = [d["id"] for d in json.load(r)["catalog"]]

    failures, unexpected, accepted = [], defaultdict(set), defaultdict(int)
    for dataset in datasets:
        report = _verify(args.verifier, args.url, dataset, args.timeout_ms)
        print(f"{dataset}: {len(report['passes'])} passed, {len(report['warns'])} warnings, "
              f"{len(report['fails'])} failures")
        failures += [(dataset, f) for f in report["fails"]]
        for w in report["warns"]:
            name = _test_name(w)
            if name in ALLOWED_WARNINGS:
                accepted[name] += 1
            else:
                unexpected[name].add(f"{w['url']}\n      {w['description']}\n      got: {w.get('got', '')[:300]}")

    for name, count in sorted(accepted.items()):
        print(f"accepted warning {name} x{count}: {ALLOWED_WARNINGS[name]}")
    for name in sorted(set(ALLOWED_WARNINGS) - set(accepted)):
        print(f"note: allowed warning {name} no longer occurs, it can be removed from ALLOWED_WARNINGS")
    for name, details in sorted(unexpected.items()):
        print(f"\nUNEXPECTED WARNING {name}:")
        for d in sorted(details)[:5]:
            print(f"  {d}")
    for dataset, f in failures:
        print(f"\nFAILURE on {dataset}: {f['url']}\n  {f['description']}\n  got: {f.get('got', '')[:500]}")

    data_problems = {d: p for d in datasets if (p := check_data(args.url, d))}
    for dataset, problems in data_problems.items():
        print(f"\nDATA PROBLEM on {dataset}:")
        for p in problems:
            print(f"  {p}")

    ok = not failures and not unexpected and not data_problems
    print(f"\n{len(datasets)} datasets, {len(failures)} verifier failures, {len(unexpected)} unexpected warning "
          f"kinds, {len(data_problems)} datasets with data problems: {'OK' if ok else 'FAILED'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
