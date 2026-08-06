#!/usr/bin/env python3
"""
Build data/catalog.json from layered packs (+ optional AOS 10 full bank).

Prefers data/layers/aos-cx-<version>/{common,platforms/*} so the UI can load
common + platform deltas without shipping full per-platform banks.

Usage (from tools/cli-explorer/):
  .venv/bin/python scripts/build_catalog.py
  .venv/bin/python scripts/build_catalog.py --min-version 10.13
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
APP_ROOT = SCRIPTS_DIR.parent
DATA_DIR = APP_ROOT / "data"
LAYERS_DIR = DATA_DIR / "layers"

# HPE doc ids → human series labels (from Aruba cli.json mapping)
DOC_ID_LABELS: dict[str, str] = {
    # 10.18
    "sd00007915en_us": "10000",
    "sd00007886en_us": "10040",
    "sd00007904en_us": "4100i",
    "sd00007911en_us": "5420",
    "sd00007899en_us": "6000/6100",
    "sd00007900en_us": "6200",
    "sd00007913en_us": "6300/6400",
    "sd00007891en_us": "8100/8360",
    "sd00007921en_us": "8320/8325",
    "sd00007890en_us": "8400",
    "sd00007887en_us": "9300",
    # 10.17.1000
    "sd00007467en_us": "10000",
    "sd00007225en_us": "9300/10040",
    "sd00007458en_us": "4100i",
    "sd00007461en_us": "5420",
    "sd00007465en_us": "6000/6100",
    "sd00007468en_us": "6200",
    "sd00007217en_us": "6300/6400",
    "sd00007451en_us": "8100/8360",
    "sd00007417en_us": "8320/8325",
    "sd00007382en_us": "8400",
}


def ver_tuple(v: str) -> tuple[int, ...]:
    parts = []
    for x in v.split("."):
        try:
            parts.append(int(x))
        except ValueError:
            parts.append(0)
    return tuple(parts)


def pretty_platform(key: str) -> str:
    if key in DOC_ID_LABELS:
        return DOC_ID_LABELS[key]
    if key.startswith("cli_"):
        return key[4:]  # cli_6200 → 6200, cli_6000-6100 → 6000-6100
    return key


def platform_sort_key(key: str) -> tuple:
    label = pretty_platform(key)
    # numeric-ish sort on leading digits
    m = re.match(r"(\d+)", label)
    return (int(m.group(1)) if m else 99999, label.lower())


def build_catalog(min_version: str | None = None) -> dict:
    banks: list[dict] = []
    min_t = ver_tuple(min_version) if min_version else None

    # AOS 10 full bank (not layered)
    aos10 = DATA_DIR / "aos-10"
    if (aos10 / "tree.json").is_file() and (aos10 / "entries.json").is_file():
        banks.append(
            {
                "id": "aos-10",
                "label": "AOS 10.x",
                "family": "AOS 10",
                "versionHint": "10.x",
                "platform": None,
                "default": False,
                "dataPath": "data/aos-10",
            }
        )

    if not LAYERS_DIR.is_dir():
        print("warning: no data/layers/ directory", file=sys.stderr)
    else:
        for group_dir in sorted(LAYERS_DIR.iterdir()):
            if not group_dir.is_dir():
                continue
            if group_dir.name.endswith("-syntax"):
                continue
            m = re.match(r"^aos-cx-(\d+(?:\.\d+)*)$", group_dir.name)
            if not m:
                continue
            version = m.group(1)
            if min_t is not None and ver_tuple(version) < min_t:
                continue

            common = group_dir / "common"
            platforms_root = group_dir / "platforms"
            if not (common / "entries.json").is_file() or not platforms_root.is_dir():
                print(f"skip incomplete layer group {group_dir.name}", file=sys.stderr)
                continue

            platform_ids = sorted(
                [p.name for p in platforms_root.iterdir() if p.is_dir() and (p / "entries.json").is_file()],
                key=platform_sort_key,
            )
            for plat in platform_ids:
                plat_dir = platforms_root / plat
                if not (plat_dir / "tree.json").is_file():
                    continue
                label_plat = pretty_platform(plat)
                bank_id = f"aos-cx-{version}-{plat}"
                banks.append(
                    {
                        "id": bank_id,
                        "label": f"AOS-CX {version} · {label_plat}",
                        "family": "AOS-CX",
                        "versionHint": version,
                        "platform": plat,
                        "platformLabel": label_plat,
                        "default": False,
                        "layers": {
                            "common": f"data/layers/{group_dir.name}/common",
                            "platform": f"data/layers/{group_dir.name}/platforms/{plat}",
                        },
                    }
                )

    # Default: newest train's 6200-class platform if present
    preferred_platforms = (
        "sd00007900en_us",  # 10.18 6200
        "cli_6200",
        "sd00007913en_us",  # 10.18 6300/6400
        "cli_6300-6400",
    )
    cx_banks = [b for b in banks if b["family"] == "AOS-CX"]
    if cx_banks:
        newest_ver = max(cx_banks, key=lambda b: ver_tuple(b.get("versionHint") or "0"))[
            "versionHint"
        ]
        on_newest = [b for b in cx_banks if b["versionHint"] == newest_ver]
        chosen = None
        for pref in preferred_platforms:
            hit = next((b for b in on_newest if b.get("platform") == pref), None)
            if hit:
                chosen = hit
                break
        if chosen is None:
            chosen = on_newest[0]
        chosen["default"] = True
    elif banks:
        banks[0]["default"] = True

    return {"banks": banks}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--min-version",
        default=None,
        help="Skip AOS-CX layer groups older than this (e.g. 10.13)",
    )
    ap.add_argument(
        "--out",
        type=Path,
        default=DATA_DIR / "catalog.json",
        help="Output catalog path",
    )
    args = ap.parse_args()

    catalog = build_catalog(min_version=args.min_version)
    out = args.out if args.out.is_absolute() else (APP_ROOT / args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    n = len(catalog["banks"])
    cx = sum(1 for b in catalog["banks"] if b["family"] == "AOS-CX")
    print(f"Wrote {out} ({n} banks, {cx} AOS-CX layered)")
    defaults = [b["id"] for b in catalog["banks"] if b.get("default")]
    print(f"default: {defaults}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
