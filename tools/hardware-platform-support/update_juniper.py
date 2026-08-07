#!/usr/bin/env python3
"""
Merge HPE Juniper (Pathfinder) switches + APs into platforms.json.

Does not rebuild or alter Aruba rows beyond tagging vendor="aruba" when missing.
Fetches the public Pathfinder catalog:

  POST https://apps.juniper.net/hardwaresrv/pf/home

Scope (v1): EX Series, QFX Series, Access Points.
Deep-links: https://apps.juniper.net/home/{productCodeName}/overview

Examples:
  python3 update_juniper.py
  python3 update_juniper.py --catalog-json ./juniper-catalog.json
"""

from __future__ import annotations

import argparse
import json
import ssl
import subprocess
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

PATHFINDER_HOME = "https://apps.juniper.net/hardwaresrv/pf/home"
PATHFINDER_PRODUCT = "https://apps.juniper.net/home/{code}/overview"

# seriesName values we keep from productsByCategory
INCLUDE_SERIES = {
    "EX Series": {
        "type": "ex",
        "typeLabel": "EX Switch",
        "firmwareKind": "junos",
        "firmwareLabel": "Junos",
    },
    "QFX Series": {
        "type": "qfx",
        "typeLabel": "QFX Switch",
        "firmwareKind": "junos",
        "firmwareLabel": "Junos",
    },
    "Access Points": {
        "type": "ap",
        "typeLabel": "Access Point",
        "firmwareKind": "mist",
        "firmwareLabel": "Mist AP",
    },
}

DATA_DIR = Path(__file__).resolve().parent / "data"
PLATFORMS = DATA_DIR / "platforms.json"


def fetch_catalog_bytes() -> bytes:
    """POST empty JSON body; fall back to curl if SSL/certs fail in urllib."""
    body = b"{}"
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "tools-hardware-platform-support/1.0",
    }
    try:
        ctx = ssl.create_default_context()
        req = urllib.request.Request(
            PATHFINDER_HOME, data=body, headers=headers, method="POST"
        )
        with urllib.request.urlopen(req, timeout=120, context=ctx) as resp:
            return resp.read()
    except (urllib.error.URLError, ssl.SSLError, TimeoutError) as exc:
        print(f"urllib POST failed ({exc}); trying curl…")
        proc = subprocess.run(
            [
                "curl",
                "-sS",
                "-X",
                "POST",
                PATHFINDER_HOME,
                "-H",
                "Content-Type: application/json",
                "-H",
                "Accept: application/json",
                "-H",
                "User-Agent: tools-hardware-platform-support/1.0",
                "-d",
                "{}",
                "--max-time",
                "120",
            ],
            check=True,
            capture_output=True,
        )
        return proc.stdout


def parse_juniper_devices(catalog: dict) -> list[dict]:
    data = catalog.get("data") or {}
    categories = data.get("productsByCategory") or []
    devices: list[dict] = []
    seen: set[str] = set()

    for cat in categories:
        category_name = (cat.get("categoryName") or "").strip()
        for series in cat.get("seriesVOList") or []:
            series_name = (series.get("seriesName") or "").strip()
            meta = INCLUDE_SERIES.get(series_name)
            if not meta:
                continue
            for p in series.get("prodVOList") or []:
                if (p.get("productType") or "Product") != "Product":
                    continue
                code = (p.get("productCodeName") or "").strip()
                platform = (p.get("platform") or "").strip()
                if not code or not platform:
                    continue
                dev_id = f"juniper-{code.lower()}"
                if dev_id in seen:
                    continue
                seen.add(dev_id)

                is_eol = str(p.get("isEOL", "0")).strip() in ("1", "true", "True")
                status = "parked" if is_eol else "current"
                pathfinder_url = PATHFINDER_PRODUCT.format(code=code)
                product_key = p.get("productKey")
                notes = (
                    "Marked EOL in the Juniper Pathfinder product catalog."
                    if is_eol
                    else "Listed in the Juniper Pathfinder product catalog."
                )

                track = {
                    "kind": meta["firmwareKind"],
                    "label": meta["firmwareLabel"],
                    "minRelease": {
                        "raw": "—",
                        "version": None,
                        "tags": [],
                        "wildcard": False,
                    },
                    "lastRelease": {
                        "raw": "EOL" if is_eol else "N/A",
                        "version": None,
                        "tags": [],
                        "wildcard": False,
                    },
                    "status": status,
                    "notes": notes,
                    "source": "juniper-pathfinder",
                    "pathfinderUrl": pathfinder_url,
                    "minRnUrl": None,
                    "lastRnUrl": None,
                }

                devices.append(
                    {
                        "id": dev_id,
                        "vendor": "juniper",
                        "vendorLabel": "HPE Juniper",
                        "type": meta["type"],
                        "typeLabel": meta["typeLabel"],
                        "family": series_name,
                        "series": series_name,
                        "category": category_name,
                        "model": platform,
                        "productCodeName": code,
                        "productKey": product_key,
                        "pathfinderUrl": pathfinder_url,
                        "isEol": is_eol,
                        "status": status,
                        "notes": notes,
                        "firmwareKind": meta["firmwareKind"],
                        "firmwareLabel": meta["firmwareLabel"],
                        "minRelease": track["minRelease"],
                        "lastRelease": track["lastRelease"],
                        "minRnUrl": None,
                        "lastRnUrl": None,
                        "tracks": [track],
                        "sources": ["juniper-pathfinder"],
                        "firmwareKinds": [meta["firmwareKind"]],
                        "firmwareLabels": [meta["firmwareLabel"]],
                    }
                )

    devices.sort(
        key=lambda d: (
            {"ex": 0, "qfx": 1, "ap": 2}.get(d["type"], 9),
            d.get("series") or "",
            d.get("model") or "",
        )
    )
    return devices


def recompute_counts(devices: list[dict]) -> dict:
    def tracks_of(d: dict) -> list:
        if d.get("tracks"):
            return d["tracks"]
        kind = d.get("firmwareKind") or "aos-10"
        return [{"kind": kind, "status": d.get("status") or "current"}]

    def overall_status(d: dict) -> str:
        tr = tracks_of(d)
        if any(t.get("status") == "current" for t in tr):
            return "current"
        if any(t.get("status") == "parked" for t in tr):
            return "parked"
        return d.get("status") or "current"

    def vendor_of(d: dict) -> str:
        return d.get("vendor") or "aruba"

    counts = {
        "total": len(devices),
        "ap": sum(1 for d in devices if d.get("type") == "ap"),
        "gateway": sum(1 for d in devices if d.get("type") == "gateway"),
        "bridge": sum(1 for d in devices if d.get("type") == "bridge"),
        "aos-cx": sum(1 for d in devices if d.get("type") == "aos-cx"),
        "aos-s": sum(1 for d in devices if d.get("type") == "aos-s"),
        "ex": sum(1 for d in devices if d.get("type") == "ex"),
        "qfx": sum(1 for d in devices if d.get("type") == "qfx"),
        "parked": sum(1 for d in devices if overall_status(d) == "parked"),
        "current": sum(1 for d in devices if overall_status(d) == "current"),
        "aruba": sum(1 for d in devices if vendor_of(d) == "aruba"),
        "juniper": sum(1 for d in devices if vendor_of(d) == "juniper"),
        "aos-10": sum(
            1
            for d in devices
            if any(t.get("kind") == "aos-10" for t in tracks_of(d))
        ),
        "aos-8-iap": sum(
            1
            for d in devices
            if any(t.get("kind") == "aos-8-iap" for t in tracks_of(d))
        ),
        "junos": sum(
            1
            for d in devices
            if any(t.get("kind") == "junos" for t in tracks_of(d))
        ),
        "mist": sum(
            1
            for d in devices
            if any(t.get("kind") == "mist" for t in tracks_of(d))
        ),
    }
    return counts


def merge(platforms: dict, juniper_devices: list[dict]) -> dict:
    existing = platforms.get("devices") or []
    kept = []
    for d in existing:
        if (d.get("vendor") or "aruba") == "juniper":
            continue
        if d.get("id", "").startswith("juniper-"):
            continue
        # Preserve Aruba rows; ensure vendor tag for filters.
        if not d.get("vendor"):
            d = {**d, "vendor": "aruba", "vendorLabel": d.get("vendorLabel") or "HPE Aruba"}
        elif not d.get("vendorLabel") and d.get("vendor") == "aruba":
            d = {**d, "vendorLabel": "HPE Aruba"}
        kept.append(d)

    devices = kept + juniper_devices
    # Stable-ish order: Aruba first (existing order), then Juniper sorted
    platforms["devices"] = devices
    platforms["counts"] = recompute_counts(devices)
    platforms["juniperUpdated"] = date.today().isoformat()
    platforms["juniperSource"] = PATHFINDER_HOME
    platforms["pathfinderBase"] = "https://apps.juniper.net/home/"

    sources = platforms.get("sources") or {}
    sources["juniperPathfinder"] = PATHFINDER_HOME
    sources["juniperPathfinderProduct"] = PATHFINDER_PRODUCT
    platforms["sources"] = sources

    note = platforms.get("aos8Note") or ""
    jnote = (
        "Juniper EX / QFX / Mist APs from Pathfinder catalog "
        f"({PATHFINDER_HOME}); deep-link to /home/{{productCodeName}}/overview."
    )
    if "Pathfinder" not in note:
        platforms["aos8Note"] = (note + " " + jnote).strip() if note else jnote

    return platforms


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--catalog-json",
        type=Path,
        help="Local Pathfinder home JSON (skip network fetch)",
    )
    ap.add_argument(
        "--platforms",
        type=Path,
        default=PLATFORMS,
        help="platforms.json to merge into (default: data/platforms.json)",
    )
    args = ap.parse_args()

    if args.catalog_json:
        raw = args.catalog_json.read_bytes()
        print(f"Loaded catalog from {args.catalog_json}")
    else:
        print("Fetching Pathfinder catalog (POST)…")
        raw = fetch_catalog_bytes()

    catalog = json.loads(raw.decode("utf-8", errors="replace"))
    status = (catalog.get("status") or {}).get("success")
    if status is False:
        raise SystemExit(f"Pathfinder catalog error: {catalog.get('status')}")

    juniper = parse_juniper_devices(catalog)
    if not juniper:
        raise SystemExit("No EX / QFX / Access Point products parsed from catalog")

    if not args.platforms.is_file():
        raise SystemExit(f"Missing {args.platforms}")

    platforms = json.loads(args.platforms.read_text(encoding="utf-8"))
    out = merge(platforms, juniper)
    args.platforms.write_text(
        json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"Wrote {args.platforms}")
    print(
        "juniper:",
        sum(1 for d in juniper if d["type"] == "ex"),
        "EX,",
        sum(1 for d in juniper if d["type"] == "qfx"),
        "QFX,",
        sum(1 for d in juniper if d["type"] == "ap"),
        "AP;",
        "counts:",
        json.dumps(out["counts"]),
    )


if __name__ == "__main__":
    main()
