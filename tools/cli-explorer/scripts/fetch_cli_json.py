#!/usr/bin/env python3
"""Fetch live ArubaDocPortal json/aoscx/cli.json (HTTP/2 + Chrome client hints).

Akamai 403s HTTP/1.1 urllib. curl --http2 with a Chrome UA and sec-ch-ua /
Sec-Fetch-* headers is what actually returns 200.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Optional

PORTAL_URL = (
    "https://arubanetworking.hpe.com/techdocs/ArubaDocPortal/"
    "content/new-portal/json/aoscx/cli.json"
)
PORTAL_PAGE = (
    "https://arubanetworking.hpe.com/techdocs/ArubaDocPortal/"
    "content/new-portal/aoscx.html"
)
CHROME_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.6778.86 Safari/537.36"
)
SEC_CH_UA = '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"'

# Live portal typos we have verified against HPESC titles.
DOC_FIXES = {
    ("10.18.xxxx", "10000"): "sd00007915en_us",
    ("10.18", "10000"): "sd00007915en_us",
}


def normalize_doc(ver: str, series: str, doc: str) -> str:
    d = (doc or "").strip().replace("en_usen_us", "en_us")
    fix = DOC_FIXES.get((ver, series))
    if fix and d.startswith("sd00007467"):
        return fix
    return d


def normalize_portal(raw: dict) -> dict:
    out = {}  # type: Dict[str, Any]
    for ver, block in raw.items():
        if str(ver).startswith("_") or not isinstance(block, dict):
            continue
        cleaned = {}
        for series, doc in block.items():
            cleaned[str(series)] = normalize_doc(str(ver), str(series), str(doc))
        out[str(ver)] = cleaned
        # Alias 10.18.xxxx → 10.18 so builders can look up either key
        if str(ver).endswith(".xxxx"):
            alias = str(ver).replace(".xxxx", "")
            if alias not in out:
                out[alias] = dict(cleaned)
    return out


def fetch_live_cli_json() -> dict:
    cmd = [
        "curl",
        "-sS",
        "--fail",
        "--compressed",
        "--http2",
        "-A",
        CHROME_UA,
        "-H",
        "Accept: application/json,text/javascript,*/*;q=0.1",
        "-H",
        "Accept-Language: en-US,en;q=0.9",
        "-H",
        "Referer: {0}".format(PORTAL_PAGE),
        "-H",
        "Origin: https://arubanetworking.hpe.com",
        "-H",
        "sec-ch-ua: {0}".format(SEC_CH_UA),
        "-H",
        "sec-ch-ua-mobile: ?0",
        "-H",
        'sec-ch-ua-platform: "macOS"',
        "-H",
        "Sec-Fetch-Dest: empty",
        "-H",
        "Sec-Fetch-Mode: cors",
        "-H",
        "Sec-Fetch-Site: same-origin",
        PORTAL_URL,
    ]
    try:
        blob = subprocess.check_output(cmd)
    except subprocess.CalledProcessError as err:
        raise RuntimeError(
            "cli.json fetch failed (need HTTP/2 + Chrome UA). curl rc={0}".format(
                err.returncode
            )
        )
    raw = json.loads(blob.decode("utf-8"))
    if not isinstance(raw, dict) or len(raw) < 3:
        raise RuntimeError("cli.json did not look like a version map")
    return raw


def write_snapshot(portal: dict, path: Path, comment: Optional[str] = None) -> None:
    payload = dict(portal)
    payload["_comment"] = comment or (
        "Fetched live from ArubaDocPortal json/aoscx/cli.json "
        "(HTTP/2 + Chrome sec-ch-ua). en_usen_us suffix stripped; "
        "10.18 10000 remapped off the 10.17 doc when HPE still points at sd00007467."
    )
    # Keep _comment first
    ordered = {"_comment": payload.pop("_comment")}
    ordered.update(payload)
    path.write_text(
        json.dumps(ordered, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def main() -> int:
    from pathlib import Path as P

    dest = P(__file__).resolve().parent / "portal" / "aoscx-cli.json"
    raw = fetch_live_cli_json()
    portal = normalize_portal(raw)
    write_snapshot(portal, dest)
    print(
        "Wrote {0} versions={1}".format(
            dest, [k for k in portal if not k.startswith("_")]
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
