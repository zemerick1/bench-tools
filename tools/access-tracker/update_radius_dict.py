#!/usr/bin/env python3
"""
Build radius-dict.json from ClearPass TipsContents RadiusDictionary XML exports.

Default input: tools/access-tracker/dictionaries/*.xml
Default output: tools/access-tracker/radius-dict.json

Usage:
  python3 update_radius_dict.py
  python3 update_radius_dict.py --src /path/to/folder-with-xmls
"""

from __future__ import annotations

import argparse
import json
import xml.etree.ElementTree as ET
from pathlib import Path


def local(tag: str) -> str:
    return tag.split("}")[-1] if "}" in tag else tag


def parse_dictionaries(xml_paths: list[Path]) -> dict:
    vendors: dict = {}
    attrs_by_full: dict = {}
    short_index: dict = {}

    for p in xml_paths:
        root = ET.fromstring(p.read_bytes())
        for vendor in root.iter():
            if local(vendor.tag) != "Vendor":
                continue
            prefix = vendor.attrib.get("prefix", "")
            vname = vendor.attrib.get("name", f"Radius:{prefix}")
            vid = vendor.attrib.get("id", "")
            vendors[prefix] = {
                "id": int(vid) if str(vid).isdigit() else vid,
                "name": vname,
                "prefix": prefix,
            }
            for attr in vendor.iter():
                if local(attr.tag) != "Attribute":
                    continue
                aname = attr.attrib.get("name", "")
                aid = attr.attrib.get("id", "")
                atype = attr.attrib.get("type", "")
                enums: dict[str, str] = {}
                for vv in attr.iter():
                    if local(vv.tag) != "ValidValue":
                        continue
                    ord_ = vv.attrib.get("enumOrdinal", "")
                    val = vv.attrib.get("value", "")
                    if ord_ != "":
                        enums[str(ord_)] = val
                cppm_key = f"{vname}:{aname}"
                rec = {
                    "id": int(aid) if str(aid).isdigit() else aid,
                    "type": atype,
                    "vendor": prefix,
                    "name": aname,
                }
                if enums:
                    rec["enums"] = enums
                attrs_by_full[cppm_key] = rec
                # Prefer IETF for ambiguous short names
                if aname not in short_index or prefix == "IETF":
                    short_index[aname] = cppm_key

    return {
        "meta": {
            "source": "ClearPass TipsContents RadiusDictionary exports",
            "vendors": list(vendors.keys()),
            "attributeCount": len(attrs_by_full),
        },
        "vendors": vendors,
        "attrs": attrs_by_full,
        "shortIndex": short_index,
    }


def main() -> None:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--src",
        type=Path,
        default=here / "dictionaries",
        help="Folder containing RadiusDictionary XML files",
    )
    ap.add_argument(
        "--out",
        type=Path,
        default=here / "radius-dict.json",
        help="Output JSON path",
    )
    args = ap.parse_args()

    xmls = sorted(args.src.glob("*.xml"))
    if not xmls:
        raise SystemExit(f"No *.xml files in {args.src}")

    data = parse_dictionaries(xmls)
    args.out.write_text(
        json.dumps(data, separators=(",", ":"), ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(
        f"Wrote {args.out} ({args.out.stat().st_size} bytes) "
        f"from {len(xmls)} XML file(s), {data['meta']['attributeCount']} attributes, "
        f"vendors={data['meta']['vendors']}"
    )


if __name__ == "__main__":
    main()
