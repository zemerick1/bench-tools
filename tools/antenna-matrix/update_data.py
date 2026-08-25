#!/usr/bin/env python3
"""
Build data/matrix.json for the antenna matrix UI.

Default: apply pairing filters to the committed QuickSpecs seed
(even-numbered connectorized APs, connector + MIMO + band match).

Live HPE fetches are optional and usually 403 from datacenter IPs —
same pattern as hardware-platform-support. Pass saved HTML later.

  python3 update_data.py
  python3 update_data.py --live
"""

from __future__ import annotations

import argparse
import json
import re
import ssl
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
SEED = HERE / "seed"
DEST = HERE / "data" / "matrix.json"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
CATALOG = (
    "https://buy.hpe.com/us/en/networking/wireless-devices/"
    "wlan-access-points/c/4172284"
)
SUPPORT_ANTENNAS = (
    "https://support.hpe.com/connect/s/product"
    "?language=en_US&kmpmoid=1009431431&tab=manuals"
)


def even_ap_model(model: str) -> bool:
    m = re.search(r"AP-(\d+)", model.upper())
    return bool(m) and int(m.group(1)) % 2 == 0


def mimo_qty(mimo: str, port_count: int):
    if mimo == "1x1":
        return port_count
    if mimo == "2x2" and port_count % 2 == 0:
        return port_count // 2
    if mimo == "4x4" and port_count % 4 == 0:
        return port_count // 4
    return None


def covers(ant_bands, group_bands) -> bool:
    """Antenna must cover every band on that connector group.

    Tri-band (2.4/5/6) is valid on 2.4+5 ports. A 5/6-only antenna is not,
    because those ports still need 2.4 GHz. AP radio *count* (tri-radio,
    flex) is not the same as 6 GHz.
    """
    return set(group_bands).issubset(set(ant_bands))


def sku_find_url(sku: str) -> str:
    # /p/{sku} 404s for many JW* (and some current) option SKUs.
    return "https://buy.hpe.com/us/en/search?text=" + sku


def antenna_pattern(ant: dict) -> str:
    if ant.get("pattern"):
        return ant["pattern"]
    blob = f"{ant.get('id', '')} {ant.get('name', '')}".lower()
    if any(
        w in blob
        for w in ("panel", "directional", "d30", "d60", "d707", "5314")
    ):
        return "directional"
    return "omni"


def short_name(ant: dict) -> str:
    n = ant.get("name") or ant.get("id") or ""
    n = re.sub(r"^HPE (Aruba Networking|Networking)\s+", "", n)
    n = re.sub(r"^(AP-ANT-\S+|ANT-\S+|eANT-\S+)\s+", "", n)
    n = re.sub(r"\s+Antenna$", "", n, flags=re.I)
    return n.strip() or ant.get("id") or ""


GROUP_WHERE = {
    "wifi": "dual-band jacks",
    "db": "2.4/5 GHz jacks",
    "6g": "6 GHz jacks",
    "2g": "2.4 GHz jacks",
    "5g": "5 GHz jacks",
}


def group_where(g: dict) -> str:
    if g.get("where"):
        return g["where"]
    return GROUP_WHERE.get(g["id"], g.get("layout") or g["id"])


def ports_summary(model: dict) -> str:
    conn = model["connector"]
    groups = model["portGroups"]
    if len(groups) == 1:
        g = groups[0]
        bands = " + ".join(g["bands"])
        return f"{g['count']} {conn} · {bands} GHz on each"
    return "; ".join(
        f"{g['count']} {conn} for {' + '.join(g['bands'])} GHz"
        for g in groups
    )


def fit_label(model: dict, ant: dict, group_hits: list) -> str:
    by_id = {g["id"]: g for g in model["portGroups"]}
    if len(group_hits) == 1:
        h = group_hits[0]
        g = by_id[h["group"]]
        where = group_where(g)
        q = h["qty"]
        if q == 1 and ant["mimo"] != "1x1":
            if g["count"] == 2:
                return f"Need 1 (both {where})"
            return f"Need 1 (all {g['count']} {where})"
        if q == g["count"] and ant["mimo"] == "1x1":
            return f"Need {q} (one per jack)"
        return f"Need {q} for the {where}"
    bits = []
    for h in group_hits:
        g = by_id[h["group"]]
        q = h["qty"]
        where = group_where(g)
        if q == 1:
            bits.append(f"one on {where}")
        else:
            bits.append(f"{q} on {where}")
    return "Need " + str(sum(h["qty"] for h in group_hits)) + " — " + ", ".join(bits)


def try_live_catalog() -> str:
    ctx = ssl.create_default_context()
    req = urllib.request.Request(
        CATALOG,
        headers={"User-Agent": UA, "Accept": "text/html"},
    )
    with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
        return f"HTTP {resp.status} {resp.geturl()}"


def match_model(model: dict, catalog: dict):
    accepted = []
    rejected = []
    for sku in model.get("hpeBomSkus", []):
        ant = catalog.get(sku)
        if not ant:
            rejected.append(
                {"sku": sku, "antenna": sku, "reason": "unknown-sku"}
            )
            continue
        needs_n_adapter = (
            ant["connector"] == "N-type"
            and model["connector"] == "RP-SMA"
            and model.get("env") == "outdoor"
        )
        if ant["connector"] != model["connector"] and not needs_n_adapter:
            rejected.append(
                {
                    "sku": sku,
                    "antenna": ant["id"],
                    "reason": "connector-mismatch",
                    "detail": f"{ant['connector']} vs {model['connector']}",
                }
            )
            continue
        group_hits = []
        for g in model["portGroups"]:
            qty = mimo_qty(ant["mimo"], g["count"])
            if qty is None:
                continue
            if not covers(ant["bands"], g["bands"]):
                continue
            group_hits.append(
                {
                    "group": g["id"],
                    "where": group_where(g),
                    "qty": qty,
                    "groupBands": g["bands"],
                }
            )
        if not group_hits:
            rejected.append(
                {
                    "sku": sku,
                    "antenna": ant["id"],
                    "reason": "mimo-or-band-does-not-fit-port-groups",
                    "detail": f"mimo {ant['mimo']} bands {ant['bands']}",
                }
            )
            continue
        adapter = (
            "Needs an RP-SMA to N-type cable (ANT-CBL-RPSMA-Nm)"
            if needs_n_adapter
            else None
        )
        fit = fit_label(model, ant, group_hits)
        if adapter:
            fit = fit + ". " + adapter
        accepted.append(
            {
                "sku": sku,
                "id": ant["id"],
                "name": ant["name"],
                "shortName": short_name(ant),
                "mimo": ant["mimo"],
                "pattern": antenna_pattern(ant),
                "connector": ant["connector"],
                "antennaBands": ant["bands"],
                "env": ant["env"],
                "mount": ant["mount"],
                "adapter": adapter,
                "findUrl": sku_find_url(sku),
                "supportFamilyUrl": SUPPORT_ANTENNAS,
                "onGroups": group_hits,
                "qtyTotal": sum(h["qty"] for h in group_hits),
                "fit": fit,
            }
        )
    return accepted, rejected


def build_antenna_index(catalog: dict, models: list) -> list:
    used = {}
    for m in models:
        for a in m["antennas"]:
            rec = used.setdefault(
                a["sku"],
                {
                    "sku": a["sku"],
                    "id": a["id"],
                    "name": a["name"],
                    "shortName": a.get("shortName") or a["id"],
                    "mimo": a["mimo"],
                    "pattern": a.get("pattern") or "omni",
                    "connector": a["connector"],
                    "bands": a["antennaBands"],
                    "env": a["env"],
                    "mount": a["mount"],
                    "findUrl": a.get("findUrl") or sku_find_url(a["sku"]),
                    "supportFamilyUrl": SUPPORT_ANTENNAS,
                    "usedBy": [],
                },
            )
            rec["usedBy"].append(
                {
                    "model": m["model"],
                    "family": m["family"],
                    "qty": a["qtyTotal"],
                    "fit": a.get("fit"),
                    "adapter": a.get("adapter"),
                }
            )
    # Keep catalog-only antennas (context) even if unused after filters
    for sku, ant in catalog.items():
        if sku in used:
            continue
        used[sku] = {
            "sku": sku,
            "id": ant["id"],
            "name": ant["name"],
            "shortName": short_name(ant),
            "mimo": ant["mimo"],
            "pattern": antenna_pattern(ant),
            "connector": ant["connector"],
            "bands": ant["bands"],
            "env": ant["env"],
            "mount": ant["mount"],
            "findUrl": sku_find_url(sku),
            "supportFamilyUrl": SUPPORT_ANTENNAS,
            "usedBy": [],
        }
    rows = list(used.values())
    rows.sort(key=lambda r: (r["id"], r["sku"]))
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--live",
        action="store_true",
        help="Probe the HPE store catalog (usually 403). Seed is still used.",
    )
    args = ap.parse_args()

    live_note = "seed: QuickSpecs Select antennas (AP-xxx only), locally filtered"
    if args.live:
        try:
            live_note = try_live_catalog()
        except Exception as e:
            live_note = f"live-failed: {type(e).__name__}: {e}; using seed"

    catalog = json.loads((SEED / "antenna_catalog.json").read_text(encoding="utf-8"))[
        "antennas"
    ]
    models_in = json.loads((SEED / "models.json").read_text(encoding="utf-8"))["models"]

    out_models = []
    rejected = []
    skipped_odd = []
    for model in models_in:
        if not even_ap_model(model["model"]):
            skipped_odd.append(model["model"])
            continue
        ants, rej = match_model(model, catalog)
        for r in rej:
            r["model"] = model["model"]
            rejected.append(r)
        oid = model.get("familyOid")
        qsid = model.get("quickSpecsId")
        out_models.append(
            {
                "model": model["model"],
                "family": model["family"],
                "familyOid": oid,
                "quickSpecsId": qsid,
                "ddsUrl": (
                    f"https://www.hpe.com/psnow/doc/PSN{oid}WWEN.pdf" if oid else None
                ),
                "quickSpecsUrl": (
                    f"https://www.hpe.com/us/en/collaterals/collateral.{qsid}.html"
                    if qsid
                    else None
                ),
                "confidence": model.get("confidence"),
                "wifi": model["wifi"],
                "bands": model["bands"],
                "connector": model["connector"],
                "env": model["env"],
                "portsSummary": ports_summary(model),
                "portGroups": model["portGroups"],
                "antennas": ants,
            }
        )

    antennas = build_antenna_index(catalog, out_models)
    payload = {
        "updated": date.today().isoformat(),
        "source": live_note,
        "supportAntennasUrl": SUPPORT_ANTENNAS,
        "filters": [
            "even-numbered AP-nnn (connectorized)",
            "connector type match",
            "mimo fits a port group",
            "antenna covers every band on that connector group",
        ],
        "counts": {
            "models": len(out_models),
            "compatibleRows": sum(len(m["antennas"]) for m in out_models),
            "antennas": len(antennas),
            "antennasWithAps": sum(1 for a in antennas if a["usedBy"]),
            "rejectedBomRows": len(rejected),
            "skippedOddModels": skipped_odd,
        },
        "models": out_models,
        "antennas": antennas,
        "rejected": rejected,
    }

    DEST.parent.mkdir(parents=True, exist_ok=True)
    DEST.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {DEST}")
    print("counts:", json.dumps(payload["counts"]))
    print("source:", payload["source"])


if __name__ == "__main__":
    main()
