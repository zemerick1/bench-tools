#!/usr/bin/env python3
"""
Rebuild oui-data.json from IEEE Registration Authority CSVs.
Maintainer utility — not shown in the web UI.

  python3 update_oui.py
"""

import csv
import json
import re
import urllib.request
from datetime import date
from pathlib import Path

SOURCES = {
    "mal": "https://standards-oui.ieee.org/oui/oui.csv",
    "mam": "https://standards-oui.ieee.org/oui28/mam.csv",
    "mas": "https://standards-oui.ieee.org/oui36/oui36.csv",
}


def fetch_csv(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "tools-mac-lookup/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read().decode("utf-8", errors="replace")


def parse_assignments(text: str) -> dict:
    out = {}
    reader = csv.DictReader(text.splitlines())
    for row in reader:
        asn = (row.get("Assignment") or "").strip().upper()
        org = (row.get("Organization Name") or "").strip()
        asn = re.sub(r"[^0-9A-F]", "", asn)
        if asn and org:
            out[asn] = org
    return out


def main() -> None:
    here = Path(__file__).resolve().parent
    data = {
        "updated": date.today().isoformat(),
        "source": "IEEE Registration Authority MA-L / MA-M / MA-S CSV",
        "mal": {},
        "mam": {},
        "mas": {},
    }
    for key, url in SOURCES.items():
        print(f"Fetching {key}: {url}")
        text = fetch_csv(url)
        data[key] = parse_assignments(text)
        print(f"  → {len(data[key])} entries")

    out = here / "oui-data.json"
    out.write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"Wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
