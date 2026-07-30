#!/usr/bin/env python3
"""
Refresh platforms.json from public HPE Aruba Networking docs.

Maintainer utility (not shown in the UI). Prefers a markdown proxy when the
origin blocks datacenter IPs; you can also pass local HTML/MD files.

Examples:
  python3 update_data.py
  python3 update_data.py --support-md ./supp-devices.md --releases-md ./all-releases.md
"""

from __future__ import annotations

import argparse
import json
import re
import urllib.request
from datetime import date
from pathlib import Path

ALL_RELEASES = (
    "https://arubanetworking.hpe.com/techdocs/AOS_10.x_RN_WebHelp/Content/all-releases.htm"
)
SOURCE_PAGE = (
    "https://arubanetworking.hpe.com/techdocs/new-central/content/get-started/supp-devices.htm"
)

# jina.ai reader often works when Akamai blocks direct bots
DEFAULT_SUPPORT_URL = "https://r.jina.ai/" + SOURCE_PAGE
DEFAULT_RELEASES_URL = "https://r.jina.ai/" + ALL_RELEASES


def fetch(url: str) -> str:
    req = urllib.request.Request(
        url, headers={"User-Agent": "tools-hardware-platform-support/1.0"}
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read().decode("utf-8", errors="replace")


def ver_key(v: str):
    parts = []
    for p in v.split("."):
        try:
            parts.append(int(p))
        except Exception:
            parts.append(0)
    while len(parts) < 4:
        parts.append(0)
    return tuple(parts[:4])


def parse_releases(text: str):
    releases = []
    section = None
    for line in text.splitlines():
        m = re.match(r"^##\s+(.+)$", line.strip())
        if m:
            section = m.group(1).strip()
            continue
        m = re.match(r"^\*\s+\[([0-9.]+)\]\((https://[^)]+)\)", line.strip())
        if m:
            releases.append(
                {"version": m.group(1), "url": m.group(2), "section": section}
            )
    return sorted(releases, key=lambda r: ver_key(r["version"]))


def parse_release_cell(cell: str):
    cell = (cell or "").strip()
    if not cell or cell.upper() == "N/A":
        return {"raw": "N/A", "version": None, "tags": [], "wildcard": False}
    tags = [t.upper() for t in re.findall(r"\((SSR|LSR)\)", cell, flags=re.I)]
    ver = re.sub(r"\s*\((SSR|LSR)\)\s*", "", cell, flags=re.I).strip()
    ver = re.sub(r"\s*or later\s*", "", ver, flags=re.I).strip()
    return {
        "raw": cell.strip(),
        "version": ver,
        "tags": tags,
        "wildcard": "x" in ver.lower(),
    }


def latest_release(releases_sorted):
    """Highest version on the all-releases index (what Home.htm points you toward)."""
    if not releases_sorted:
        return {
            "version": None,
            "url": ALL_RELEASES,
            "section": None,
            "homeUrl": "https://arubanetworking.hpe.com/techdocs/AOS_10.x_RN_WebHelp/Content/Home.htm",
        }
    r = releases_sorted[-1]
    return {
        "version": r["version"],
        "url": r["url"],
        "section": r.get("section"),
        "homeUrl": "https://arubanetworking.hpe.com/techdocs/AOS_10.x_RN_WebHelp/Content/Home.htm",
    }


def resolve_rn_url(cell_info, releases_sorted, latest=None):
    """
    Map a support-matrix version cell to a release-notes URL.
    N/A / missing → notes for the latest published AOS-10 build (not the index).
    Wildcard train (10.4.x.x) → newest notes under that train.
    """
    fallback = (latest or {}).get("url") or ALL_RELEASES
    if not cell_info or not cell_info.get("version"):
        return fallback
    ver = cell_info["version"]
    for r in reversed(releases_sorted):
        if r["version"] == ver:
            return r["url"]
    m = re.match(r"^(\d+\.\d+)", ver)
    if m:
        prefix = m.group(1)
        matches = [
            r
            for r in releases_sorted
            if r["version"].startswith(prefix + ".") or r["version"] == prefix
        ]
        if matches:
            return matches[-1]["url"]
    matches = [r for r in releases_sorted if r["version"].startswith(ver)]
    if matches:
        return matches[-1]["url"]
    return fallback


def build(support_md: str, releases_md: str) -> dict:
    releases_sorted = parse_releases(releases_md)
    latest = latest_release(releases_sorted)
    devices = []

    def add(**kw):
        devices.append(kw)

    # APs
    last_family = ""
    ap_table_started = False
    for line in support_md.splitlines():
        if "AP Family" in line and "AP Model" in line:
            ap_table_started = True
            continue
        if not ap_table_started:
            continue
        if line.startswith("##"):
            break
        if line.strip().startswith("| ---") or not line.strip().startswith("|"):
            continue
        cols = [c.strip() for c in line.strip().strip("|").split("|")]
        if not cols or cols[0] == "AP Family":
            continue
        note = ""
        if len(cols) >= 4:
            fam, model_cell, min_c, last_c = cols[0], cols[1], cols[2], cols[3]
            if fam:
                last_family = fam
            else:
                fam = last_family
        elif len(cols) == 3:
            fam = last_family
            model_cell, min_c, last_c = cols[0], cols[1], cols[2]
        else:
            continue
        models = re.findall(r"AP-[\w]+", model_cell)
        if "SDRAM" in model_cell or "serial number" in model_cell.lower():
            note = model_cell
            models = re.findall(r"AP-[\w]+", model_cell)
        if not models:
            continue
        min_info = parse_release_cell(min_c)
        last_info = parse_release_cell(last_c)
        for mod in models:
            add(
                id=mod.lower() if mod.lower().startswith("ap-") else "ap-" + mod.lower(),
                type="ap",
                typeLabel="Access Point",
                family=fam or last_family,
                model=mod,
                minRelease=min_info,
                lastRelease=last_info,
                status="parked" if last_info.get("version") else "current",
                notes=note,
                minRnUrl=resolve_rn_url(min_info, releases_sorted, latest),
                lastRnUrl=resolve_rn_url(last_info, releases_sorted, latest),
                firmwareKind="aos-10",
            )

    # Gateways
    gw_started = False
    last_family = ""
    for line in support_md.splitlines():
        if "Gateway Family" in line and "Gateway Model" in line:
            gw_started = True
            continue
        if not gw_started:
            continue
        if line.startswith("##") or line.startswith("**Note"):
            break
        if line.strip().startswith("| ---") or not line.strip().startswith("|"):
            continue
        cols = [c.strip() for c in line.strip().strip("|").split("|")]
        if cols[0] == "Gateway Family":
            continue
        if len(cols) >= 4:
            fam, models_c, min_c, last_c = cols[0], cols[1], cols[2], cols[3]
            if fam:
                last_family = fam
            else:
                fam = last_family
            models = [m.strip() for m in models_c.split(",") if m.strip()]
        elif len(cols) == 3:
            fam = last_family
            models = [cols[0]]
            min_c, last_c = cols[1], cols[2]
        else:
            continue
        min_info = parse_release_cell(min_c)
        last_info = parse_release_cell(last_c)
        for mod in models:
            add(
                id="gw-" + mod.lower().replace(" ", "-"),
                type="gateway",
                typeLabel="Gateway",
                family=fam or last_family,
                model=mod,
                minRelease=min_info,
                lastRelease=last_info,
                status="parked" if last_info.get("version") else "current",
                notes="",
                minRnUrl=resolve_rn_url(min_info, releases_sorted, latest),
                lastRnUrl=resolve_rn_url(last_info, releases_sorted, latest),
                firmwareKind="aos-10",
            )

    br_min = parse_release_cell("10.7.1.0")
    add(
        id="br-150",
        type="bridge",
        typeLabel="Bridge",
        family="Ethernet Bridge",
        model="BR-150",
        minRelease=br_min,
        lastRelease=parse_release_cell("N/A"),
        status="current",
        notes="5G Ethernet Bridge; listed for AOS-10.7.1.0 in Central supported platforms.",
        minRnUrl=resolve_rn_url(br_min, releases_sorted, latest),
        lastRnUrl=resolve_rn_url(parse_release_cell("N/A"), releases_sorted, latest),
        firmwareKind="aos-10",
    )

    # AOS-CX
    cx_started = False
    for line in support_md.splitlines():
        if (
            "Switch Platform" in line
            and "Minimum Software Release" in line
            and "Recommended Software Version" not in line
        ):
            cx_started = True
            continue
        if not cx_started:
            continue
        if line.startswith("##") or line.startswith("**Note"):
            break
        if line.strip().startswith("| ---") or not line.strip().startswith("|"):
            continue
        cols = [c.strip() for c in line.strip().strip("|").split("|")]
        if cols[0] == "Switch Platform" or len(cols) < 2:
            continue
        if not cols[0].startswith("AOS-CX"):
            continue
        platform, min_c = cols[0], cols[1]
        min_info = parse_release_cell(min_c)
        add(
            id="cx-" + re.sub(r"[^a-z0-9]+", "-", platform.lower()).strip("-"),
            type="aos-cx",
            typeLabel="AOS-CX Switch",
            family=platform,
            model=platform,
            minRelease={
                "raw": min_c.strip(),
                "version": min_info.get("version"),
                "tags": [],
                "wildcard": False,
            },
            lastRelease=parse_release_cell("N/A"),
            status="current",
            notes="AOS-CX firmware (not AOS-10 AP/gateway). Minimum for Central switch features.",
            minRnUrl=None,
            lastRnUrl=None,
            firmwareKind="aos-cx",
        )

    # AOS-S
    aos_started = False
    for line in support_md.splitlines():
        if "2530 Switch Series" in line:
            aos_started = True
        if not aos_started:
            continue
        if line.startswith("##") or line.startswith("Data sheets"):
            break
        if line.strip().startswith("| ---") or not line.strip().startswith("|"):
            continue
        cols = [c.strip() for c in line.strip().strip("|").split("|")]
        if cols[0] == "Switch Platform" or len(cols) < 4:
            continue

        def clean(s: str) -> str:
            return re.sub(r"\s+", " ", s).strip()

        platform, supported, recommended, stacking = (
            cols[0],
            cols[1],
            cols[2],
            cols[3],
        )
        stack_type = cols[4] if len(cols) > 4 else ""
        add(
            id="aos-s-"
            + re.sub(r"[^a-z0-9]+", "-", platform.lower()).strip("-"),
            type="aos-s",
            typeLabel="AOS-S Switch",
            family=platform,
            model=platform,
            minRelease={
                "raw": clean(supported)[:160],
                "version": None,
                "tags": [],
                "wildcard": False,
            },
            lastRelease=parse_release_cell("N/A"),
            status="current",
            notes=(
                "Recommended: "
                + clean(recommended)[:160]
                + ". Stacking: "
                + stacking
                + ". Type: "
                + stack_type
                + "."
            ),
            minRnUrl=None,
            lastRnUrl=None,
            firmwareKind="aos-s",
            recommended=clean(recommended)[:240],
            stacking=stacking,
            stackType=stack_type,
        )

    seen = {d["id"]: d for d in devices}
    devices = list(seen.values())
    order = {"ap": 0, "gateway": 1, "bridge": 2, "aos-cx": 3, "aos-s": 4}
    devices.sort(
        key=lambda d: (order.get(d["type"], 9), d.get("family", ""), d.get("model", ""))
    )

    return {
        "updated": date.today().isoformat(),
        "source": SOURCE_PAGE,
        "releasesSource": ALL_RELEASES,
        "releasesHomeUrl": latest.get("homeUrl"),
        "allReleasesUrl": ALL_RELEASES,
        "latestRelease": latest,
        "devices": devices,
        "releases": releases_sorted,
        "counts": {
            "total": len(devices),
            "ap": sum(1 for d in devices if d["type"] == "ap"),
            "gateway": sum(1 for d in devices if d["type"] == "gateway"),
            "bridge": sum(1 for d in devices if d["type"] == "bridge"),
            "aos-cx": sum(1 for d in devices if d["type"] == "aos-cx"),
            "aos-s": sum(1 for d in devices if d["type"] == "aos-s"),
            "parked": sum(1 for d in devices if d["status"] == "parked"),
            "current": sum(1 for d in devices if d["status"] == "current"),
        },
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--support-md", type=Path, help="Local markdown of support page")
    ap.add_argument("--releases-md", type=Path, help="Local markdown of all-releases")
    ap.add_argument(
        "--support-url",
        default=DEFAULT_SUPPORT_URL,
        help="URL to fetch support page (default: jina reader)",
    )
    ap.add_argument(
        "--releases-url",
        default=DEFAULT_RELEASES_URL,
        help="URL to fetch releases index",
    )
    args = ap.parse_args()

    if args.support_md:
        support_md = args.support_md.read_text(encoding="utf-8")
    else:
        print("Fetching support matrix…")
        support_md = fetch(args.support_url)

    if args.releases_md:
        releases_md = args.releases_md.read_text(encoding="utf-8")
    else:
        print("Fetching AOS-10 all-releases…")
        releases_md = fetch(args.releases_url)

    out = build(support_md, releases_md)
    dest = Path(__file__).resolve().parent / "data" / "platforms.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"Wrote {dest}")
    print("counts:", json.dumps(out["counts"]))


if __name__ == "__main__":
    main()
