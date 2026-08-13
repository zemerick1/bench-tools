#!/usr/bin/env python3
"""
Rebuild oui-data.json from IEEE Registration Authority CSVs.
Maintainer utility — not shown in the web UI.

  python3 update_oui.py
  python3 update_oui.py --force   # rewrite even if assignments are unchanged

Only mal / mam / mas are compared to the current file. The "updated" date is
bumped only when those tables change (or --force), so a weekly Action does
not commit a date-only rewrite.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import urllib.request
from datetime import date
from pathlib import Path

SOURCES = {
    "mal": "https://standards-oui.ieee.org/oui/oui.csv",
    "mam": "https://standards-oui.ieee.org/oui28/mam.csv",
    "mas": "https://standards-oui.ieee.org/oui36/oui36.csv",
}
TABLES = tuple(SOURCES)
# Hard floors so a truncated IEEE response cannot ship. Counts grow over time;
# a drop vs the current file is also rejected below.
MIN_COUNTS = {"mal": 20000, "mam": 3000, "mas": 3000}
SOURCE_LABEL = "IEEE Registration Authority MA-L / MA-M / MA-S CSV"


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


def load_existing(path: Path) -> dict | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Ignoring unreadable {path}: {exc}", file=sys.stderr)
        return None
    if not isinstance(data, dict):
        return None
    return data


def assert_sane(new: dict, old: dict | None) -> None:
    for key in TABLES:
        n = len(new[key])
        floor = MIN_COUNTS[key]
        if n < floor:
            raise SystemExit(f"{key} has only {n} entries (floor {floor}) — refusing to write")
        if old and isinstance(old.get(key), dict):
            prev = len(old[key])
            if prev and n < int(prev * 0.8):
                raise SystemExit(
                    f"{key} shrank {prev} → {n}; refusing to overwrite a likely truncated fetch"
                )


def tables_equal(old: dict | None, new: dict) -> bool:
    if not old:
        return False
    return all(old.get(key) == new[key] for key in TABLES)


def print_delta(old: dict | None, new: dict) -> None:
    for key in TABLES:
        new_n = len(new[key])
        if not old or not isinstance(old.get(key), dict):
            print(f"  {key}: {new_n} (new file)")
            continue
        old_map = old[key]
        new_map = new[key]
        old_n = len(old_map)
        added = sum(1 for k in new_map if k not in old_map)
        removed = sum(1 for k in old_map if k not in new_map)
        renamed = sum(
            1 for k, org in new_map.items() if k in old_map and old_map[k] != org
        )
        print(
            f"  {key}: {old_n} → {new_n}  "
            f"(+{added} / -{removed} / renamed {renamed})"
        )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--force",
        action="store_true",
        help="rewrite oui-data.json even when assignment tables match",
    )
    args = ap.parse_args()

    here = Path(__file__).resolve().parent
    out = here / "oui-data.json"
    existing = load_existing(out)

    data = {
        "updated": date.today().isoformat(),
        "source": SOURCE_LABEL,
        "mal": {},
        "mam": {},
        "mas": {},
    }
    for key, url in SOURCES.items():
        print(f"Fetching {key}: {url}")
        text = fetch_csv(url)
        data[key] = parse_assignments(text)
        print(f"  → {len(data[key])} entries")

    assert_sane(data, existing)

    if tables_equal(existing, data) and not args.force:
        counts = " ".join(f"{k}={len(data[k])}" for k in TABLES)
        print(f"No assignment changes ({counts}); left {out} untouched")
        return

    print("Assignments changed:" if not args.force else "Writing (--force):")
    print_delta(existing, data)

    out.write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"Wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
