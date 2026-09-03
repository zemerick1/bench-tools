#!/usr/bin/env python3
"""
Build every unique HPESC CLI book for one or more AOS-CX trains.

Dedupes series that share a document id (6000/6100, 6300/6400, …), writes
full banks under full-banks/, then optionally layers them.

Usage (from tools/cli-explorer/):
  python3 scripts/build_html_train.py --version 10.18
  python3 scripts/build_html_train.py --version 10.18 --version 10.17.1000
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import OrderedDict
from pathlib import Path

from fetch_cli_json import (  # noqa: E402
    fetch_live_cli_json,
    normalize_doc,
    normalize_portal,
    write_snapshot,
)

SCRIPTS_DIR = Path(__file__).resolve().parent
APP_ROOT = SCRIPTS_DIR.parent
PORTAL = SCRIPTS_DIR / "portal" / "aoscx-cli.json"
BUILDER = SCRIPTS_DIR / "build_from_html.py"
DIFF = SCRIPTS_DIR / "diff_banks.py"
CATALOG = SCRIPTS_DIR / "build_catalog.py"
FULL_BANKS = APP_ROOT / "full-banks"

# Portal keys that should land in data/layers/aos-cx-<id>/
LAYER_VERSION = {
    "10.17.1000": "10.17",
    "10.17": "10.17",
    "10.18": "10.18",
    "10.18.xxxx": "10.18",
    "10.16": "10.16",
    "10.15": "10.15",
    "10.14": "10.14",
    "10.13": "10.13",
}


def load_portal(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    return {k: v for k, v in data.items() if not str(k).startswith("_")}


def unique_docs(series_map: dict, ver: str = "") -> list:
    """[(doc_id, [series, …])] in first-seen order."""
    by_id = OrderedDict()
    for series, doc in series_map.items():
        doc = normalize_doc(ver, str(series), str(doc))
        if not doc or not doc.startswith("sd"):
            continue
        by_id.setdefault(doc, [])
        if series not in by_id[doc]:
            by_id[doc].append(series)
    return list(by_id.items())


def series_label(series_list: list) -> str:
    def key(s):
        m = __import__("re").match(r"(\d+)", s)
        return (int(m.group(1)) if m else 99999, s.lower())

    return "/".join(sorted(series_list, key=key))


def layer_ver_of(ver: str) -> str:
    if ver in LAYER_VERSION:
        return LAYER_VERSION[ver]
    m = re.match(r"^(\d+\.\d+)", ver)
    return m.group(1) if m else ver


def bank_dir(layer_ver: str, doc_id: str) -> Path:
    return FULL_BANKS / "aos-cx-{0}-{1}".format(layer_ver, doc_id)


def build_one(doc_id, layer_ver, label, workers, refresh):
    out = bank_dir(layer_ver, doc_id)
    platform = label.split("/")[0]
    cmd = [
        sys.executable,
        str(BUILDER),
        "--doc-id",
        doc_id,
        "--version",
        layer_ver,
        "--platform",
        platform,
        "--bank",
        out.name,
        "--out",
        str(out),
        "--workers",
        str(workers),
    ]
    if refresh:
        cmd.append("--refresh")
    print("==== {0} {1} ({2}) → {3}".format(layer_ver, label, doc_id, out))
    rc = subprocess.call(cmd)
    if rc != 0:
        print("FAILED {0} rc={1}".format(doc_id, rc), file=sys.stderr)
    return rc, out


def layer_version(layer_ver, docs, match):
    banks = []
    for doc_id, series in docs:
        path = bank_dir(layer_ver, doc_id)
        if not (path / "entries.json").is_file():
            print("skip layer, missing bank {0}".format(path), file=sys.stderr)
            continue
        banks.append("{0}={1}".format(doc_id, path))
    if len(banks) < 2:
        print("Need ≥2 banks to layer {0}".format(layer_ver), file=sys.stderr)
        return 1
    cmd = [
        sys.executable,
        str(DIFF),
        "--group",
        "aos-cx-{0}".format(layer_ver),
        "--match",
        match,
    ]
    for b in banks:
        cmd.extend(["--bank", b])
    print("==== layer aos-cx-{0} ({1} platforms)".format(layer_ver, len(banks)))
    return subprocess.call(cmd)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--version",
        action="append",
        dest="versions",
        help="Portal version key (repeatable). Default: every train with sd0000 ids (deduped)",
    )
    ap.add_argument("--portal-json", type=Path, default=PORTAL)
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--skip-layer", action="store_true")
    ap.add_argument("--layer-only", action="store_true")
    ap.add_argument(
        "--offline",
        action="store_true",
        help="Do not fetch live cli.json; use the committed snapshot",
    )
    ap.add_argument("--match", default="core")
    args = ap.parse_args()

    if args.layer_only or args.offline:
        portal = load_portal(args.portal_json)
    else:
        print("Fetching live cli.json (HTTP/2 + Chrome UA) …")
        raw = fetch_live_cli_json()
        portal = normalize_portal(raw)
        write_snapshot(portal, args.portal_json)
        print(
            "  versions: {0}".format(
                [k for k in portal if not str(k).startswith("_")]
            )
        )

    if args.versions:
        versions = args.versions
    else:
        versions = []
        seen_layer = set()
        for ver, block in portal.items():
            if not isinstance(block, dict):
                continue
            if not any(str(v).startswith("sd") for v in block.values()):
                continue
            layer = layer_ver_of(ver)
            if layer in seen_layer:
                continue
            seen_layer.add(layer)
            versions.append(ver)
    fail = 0

    planned = []
    for ver in versions:
        if ver not in portal:
            print("No portal mapping for {0}".format(ver), file=sys.stderr)
            fail += 1
            continue
        layer_ver = layer_ver_of(ver)
        docs = unique_docs(portal[ver], ver)
        if not docs:
            print(
                "{0}: no HPESC sd0000 ids (still Flare filenames?)".format(ver),
                file=sys.stderr,
            )
            fail += 1
            continue
        planned.append((ver, layer_ver, docs))
        print(
            "{0} → layers aos-cx-{1}: {2} unique books".format(
                ver, layer_ver, len(docs)
            )
        )
        for doc_id, series in docs:
            print("  {0:18} {1}".format(doc_id, series_label(series)))

    built = 0
    if not args.layer_only:
        for ver, layer_ver, docs in planned:
            for doc_id, series in docs:
                label = series_label(series)
                out = bank_dir(layer_ver, doc_id)
                if (
                    not args.refresh
                    and (out / "entries.json").is_file()
                ):
                    print(
                        "  skip existing {0} {1} ({2})".format(
                            layer_ver, label, doc_id
                        )
                    )
                    continue
                rc, _out = build_one(
                    doc_id, layer_ver, label, args.workers, args.refresh
                )
                if rc:
                    fail += 1
                else:
                    built += 1

    do_layer = (not args.skip_layer) and (args.layer_only or built or args.refresh)
    if do_layer:
        for ver, layer_ver, docs in planned:
            rc = layer_version(layer_ver, docs, args.match)
            if rc:
                fail += 1
        print("==== catalog")
        rc = subprocess.call([sys.executable, str(CATALOG)])
        if rc:
            fail += 1
    else:
        print("No new HTML books; snapshot updated, layers unchanged")

    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
