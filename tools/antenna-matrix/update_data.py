#!/usr/bin/env python3
"""
Build data/matrix.json.

AP chassis (ports, connector, bands) lives in seed/models.json — that is not
in the BOM table and does not change with every QuickSpecs edit.

Live refresh (default) re-reads each model's QuickSpecs the same way the seed
was built: collaterals HTML Description/SKU rows. PDF is backup when HPE
serves a viewer instead of HTML.

  python3 update_data.py
  python3 update_data.py --offline
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import date
from html import unescape
from io import BytesIO
from pathlib import Path

import pdfplumber
from curl_cffi import requests as cf_requests

HERE = Path(__file__).resolve().parent
SEED = HERE / "seed"
DEST = HERE / "data" / "matrix.json"

SUPPORT_ANTENNAS = (
    "https://support.hpe.com/connect/s/product"
    "?language=en_US&kmpmoid=1009431431&tab=manuals"
)
COLLATERAL = "https://www.hpe.com/us/en/collaterals/collateral.{id}.html"
PDF = "https://www.hpe.com/psnow/downloadDoc/{id}.pdf?id={id}.pdf"

SKU_RE = re.compile(r"\b([A-Z][A-Z0-9]{4,6}A)\b")
ANT_RE = re.compile(
    r"\b((?:AP-ANT|eANT|ANT)-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)", re.I
)
FOR_AP_RE = re.compile(r"For\s+(?:AP-)?(\d{3,4})\s+Std", re.I)
SKIP_RE = re.compile(r"MNT|CBL|AFC7|surge|arrestor|mount kit", re.I)

GROUP_WHERE = {
    "wifi": "dual-band jacks",
    "db": "2.4/5 GHz jacks",
    "6g": "6 GHz jacks",
    "2g": "2.4 GHz jacks",
    "5g": "5 GHz jacks",
}


def even_ap(model: str) -> bool:
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
    """Tri-band is valid on 2.4+5. 5/6-only is not, because those jacks still need 2.4."""
    return set(group_bands).issubset(set(ant_bands))


def sku_find_url(sku: str) -> str:
    return "https://buy.hpe.com/us/en/search?text=" + sku


def antenna_pattern(ant: dict) -> str:
    blob = f"{ant.get('id', '')} {ant.get('name', '')}".lower()
    if any(w in blob for w in ("panel", "directional", "d30", "d60", "d707", "5314", "sector")):
        return "directional"
    return "omni"


def short_name(ant: dict) -> str:
    n = ant.get("name") or ant.get("id") or ""
    n = re.sub(r"^HPE (Aruba Networking|Networking)\s+", "", n)
    n = re.sub(r"^(AP-ANT-\S+|ANT-\S+|eANT-\S+)\s+", "", n)
    n = re.sub(r"\s+Antenna$", "", n, flags=re.I)
    return n.strip() or ant.get("id") or ""


def group_where(g: dict) -> str:
    return g.get("where") or GROUP_WHERE.get(g["id"], g.get("layout") or g["id"])


def ports_summary(model: dict) -> str:
    conn = model["connector"]
    groups = model["portGroups"]
    if len(groups) == 1:
        g = groups[0]
        return f"{g['count']} {conn} · {' + '.join(g['bands'])} GHz on each"
    return "; ".join(
        f"{g['count']} {conn} for {' + '.join(g['bands'])} GHz" for g in groups
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
        bits.append(f"{'one' if q == 1 else q} on {where}")
    return "Need " + str(sum(h["qty"] for h in group_hits)) + " — " + ", ".join(bits)


def http_get(url: str, timeout: int = 60):
    last = None
    for attempt in range(3):
        try:
            r = cf_requests.get(
                url,
                impersonate="chrome",
                timeout=timeout,
                allow_redirects=True,
                headers={"User-Agent": "tools-antenna-matrix/1.0", "Accept": "*/*"},
            )
            if r.status_code == 200 and r.content:
                return r
            last = RuntimeError(f"HTTP {r.status_code} for {url}")
            if r.status_code in (404, 403, 410):
                raise last
        except Exception as exc:
            last = exc
        time.sleep(1.2 * (attempt + 1))
    raise last or RuntimeError(f"GET failed {url}")


def strip_html(blob: str) -> str:
    blob = re.sub(r"(?is)<script.*?</script>|<style.*?</style>", " ", blob)
    blob = re.sub(r"(?i)<br\s*/?>|</p>|</tr>", "\n", blob)
    blob = re.sub(r"(?i)</td>", "\t", blob)
    blob = re.sub(r"<[^>]+>", " ", blob)
    blob = unescape(blob)
    blob = re.sub(r"[ \t]+", " ", blob)
    return re.sub(r"\n+", "\n", blob).strip()


def fetch_quickspecs(doc_id: str) -> tuple[str, str]:
    """HTML collaterals first; PDF if that 404s or is a viewer shell."""
    try:
        r = http_get(COLLATERAL.format(id=doc_id), timeout=45)
        html = r.text
        if (
            "uct-row" in html
            and "collateral." in r.url.lower()
            and ANT_RE.search(html)
        ):
            return "html", html
    except Exception as exc:
        print(f"    html {doc_id}: {exc}")
    raw = http_get(PDF.format(id=doc_id), timeout=90).content
    if not raw.startswith(b"%PDF"):
        raise RuntimeError(f"{doc_id} was not HTML or PDF")
    with pdfplumber.open(BytesIO(raw)) as pdf:
        text = "\n".join((p.extract_text() or "") for p in pdf.pages)
    return "pdf", text


def parse_html_bom(
    html: str, default_models: list[str]
) -> dict[str, list[tuple[str, str]]]:
    """uct-row Description | SKU. Scoped to For NNN Std, else every model on this QS."""
    out: dict[str, list[tuple[str, str]]] = {m: [] for m in default_models}
    scoped = list(default_models)
    for tr in re.finditer(
        r'<tr[^>]*class="[^"]*uct-row[^"]*"[^>]*>(.*?)</tr>', html, re.I | re.S
    ):
        cells = [
            strip_html(c)
            for c in re.findall(r"<td[^>]*>(.*?)</td>", tr.group(1), re.I | re.S)
        ]
        cells = [c for c in cells if c]
        if not cells:
            continue
        joined = " ".join(cells)
        low = joined.lower()
        if low.strip() in ("antennas", "antenna"):
            scoped = list(default_models)
            continue
        m = FOR_AP_RE.search(joined)
        if m and "series" not in low:
            ap = f"AP-{m.group(1)}"
            scoped = [ap] if ap in out else []
            continue
        if "antenna mount" in low or low.startswith("power"):
            scoped = []
            continue
        if SKIP_RE.search(joined) or len(cells) < 2:
            continue
        sku_m = SKU_RE.search(cells[-1])
        if not (sku_m and ANT_RE.search(cells[0])):
            continue
        row = (sku_m.group(1), cells[0])
        for ap in scoped:
            out[ap].append(row)
    return out


def parse_text_bom(
    text: str, default_models: list[str]
) -> dict[str, list[tuple[str, str]]]:
    """PDF backup: same For-NNN Std scoping, one antenna name + SKU per line."""
    out: dict[str, list[tuple[str, str]]] = {m: [] for m in default_models}
    scoped = list(default_models)
    pending = ""
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        m = FOR_AP_RE.search(line)
        if m and "series" not in line.lower():
            ap = f"AP-{m.group(1)}"
            scoped = [ap] if ap in out else []
            pending = ""
            continue
        if re.search(r"Antenna Mount|Power Options|^Cables\b", line, re.I):
            scoped = []
            pending = ""
            continue
        if not scoped or SKIP_RE.search(line):
            continue
        sku_m = SKU_RE.search(line)
        ant_m = ANT_RE.search(line) or ANT_RE.search(pending)
        if sku_m and ant_m:
            name = (pending + " " + line[: sku_m.end()]).strip()
            row = (sku_m.group(1), name)
            for ap in scoped:
                out[ap].append(row)
            pending = ""
        elif ANT_RE.search(line):
            pending = line
        else:
            pending = ""
    return out


def derive_antenna(sku: str, name: str) -> dict | None:
    name = re.sub(r"\s+", " ", SKU_RE.sub("", name)).strip(" -")
    blob = name.lower()
    ident_m = ANT_RE.search(name)
    ident = ident_m.group(1) if ident_m else sku
    ident = re.sub(r"^ap-ant", "AP-ANT", ident, flags=re.I)
    ident = re.sub(r"^eant", "eANT", ident, flags=re.I)
    ident = re.sub(r"^ant", "ANT", ident, flags=re.I)

    mm = re.search(r"(\d)\s*[x×]\s*(\d)", blob)
    if mm:
        mimo = f"{mm.group(1)}x{mm.group(2)}"
    elif "4 element" in blob or "4-element" in blob:
        mimo = "4x4"
    elif "2-pk" in blob or "2pk" in blob or "dipole" in blob:
        mimo = "1x1"
    else:
        return None

    if "tri-band" in blob or "tri band" in blob:
        bands = ["2.4", "5", "6"]
    elif re.search(r"5\s*/\s*6|eant-[^\s]*-56", blob):
        bands = ["5", "6"]
    elif "dual-band" in blob or "dual band" in blob:
        bands = ["2.4", "5"]
    elif "2.4" in blob and "5" in blob:
        bands = ["2.4", "5"]
    elif "2.4" in blob:
        bands = ["2.4"]
    elif "6 ghz" in blob or "6ghz" in blob:
        bands = ["6"]
    elif "5 ghz" in blob or "5ghz" in blob:
        bands = ["5"]
    else:
        bands = ["2.4", "5"]

    if ident.upper().startswith("AP-ANT"):
        connector = "RP-SMA"
    elif ident.upper().startswith(("EANT", "ANT-")):
        connector = "N-type"
    else:
        connector = "RP-SMA"
    if "n-type" in blob or re.search(r"\bnf\b", blob):
        connector = "N-type"
    if "rp-sma" in blob or "rpsma" in blob:
        connector = "RP-SMA"

    rec = {
        "id": ident,
        "name": name,
        "bands": bands,
        "mimo": mimo,
        "connector": connector,
        "env": "outdoor" if ("outdoor" in blob or connector == "N-type") else "indoor",
        "mount": "direct" if "direct" in blob else "pigtail",
    }
    rec["pattern"] = antenna_pattern(rec)
    return rec


def match_model(model: dict, catalog: dict):
    accepted, rejected = [], []
    for sku in model.get("hpeBomSkus", []):
        ant = catalog.get(sku)
        if not ant:
            rejected.append({"sku": sku, "antenna": sku, "reason": "unknown-sku", "model": model["model"]})
            continue
        adapter = None
        if ant["connector"] != model["connector"]:
            if ant["connector"] == "N-type" and model["connector"] == "RP-SMA":
                adapter = "Needs an RP-SMA to N-type cable (ANT-CBL-RPSMA-Nm)"
            else:
                rejected.append(
                    {
                        "sku": sku,
                        "antenna": ant["id"],
                        "reason": "connector-mismatch",
                        "detail": f"{ant['connector']} vs {model['connector']}",
                        "model": model["model"],
                    }
                )
                continue
        hits = []
        for g in model["portGroups"]:
            qty = mimo_qty(ant["mimo"], g["count"])
            if qty is None or not covers(ant["bands"], g["bands"]):
                continue
            hits.append(
                {"group": g["id"], "where": group_where(g), "qty": qty, "groupBands": g["bands"]}
            )
        if not hits:
            rejected.append(
                {
                    "sku": sku,
                    "antenna": ant["id"],
                    "reason": "mimo-or-band-does-not-fit-port-groups",
                    "detail": f"mimo {ant['mimo']} bands {ant['bands']}",
                    "model": model["model"],
                }
            )
            continue
        fit = fit_label(model, ant, hits)
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
                "onGroups": hits,
                "qtyTotal": sum(h["qty"] for h in hits),
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
    rows = list(used.values())
    rows.sort(key=lambda r: (r["id"], r["sku"]))
    return rows


def load_seed():
    models = json.loads((SEED / "models.json").read_text(encoding="utf-8"))["models"]
    catalog = json.loads((SEED / "antenna_catalog.json").read_text(encoding="utf-8"))[
        "antennas"
    ]
    return models, catalog


def refresh_boms(models: list) -> tuple[str, dict[str, str]]:
    """Fetch each QuickSpecs once. HTML first; PDF if HPE serves a viewer."""
    names: dict[str, str] = {}
    by_doc: dict[str, list] = {}
    for m in models:
        by_doc.setdefault(m["quickSpecsId"], []).append(m)

    bits = []
    for doc_id, group in by_doc.items():
        kind, body = fetch_quickspecs(doc_id)
        aps = [m["model"] for m in group]
        bom = (
            parse_html_bom(body, aps)
            if kind == "html"
            else parse_text_bom(body, aps)
        )
        aps = ", ".join(aps)
        n = sum(len(bom.get(m["model"], [])) for m in group)
        print(f"  {doc_id} [{kind}] {aps}: {n} BOM SKUs")
        bits.append(f"{doc_id}:{kind}")
        for m in group:
            rows = bom.get(m["model"]) or []
            if rows:
                m["hpeBomSkus"] = [sku for sku, _ in rows]
                for sku, name in rows:
                    names[sku] = name
            else:
                print(f"    {m['model']}: no live BOM, keeping seed list")
        time.sleep(0.3)
    note = "live: QuickSpecs " + ", ".join(bits)
    return note, names


def write_matrix(models, catalog, source: str, extra_names: dict[str, str] | None = None):
    for sku, name in (extra_names or {}).items():
        rec = derive_antenna(sku, name)
        if rec:
            catalog[sku] = rec

    out, rejected = [], []
    for model in models:
        if not even_ap(model["model"]):
            continue
        ants, rej = match_model(model, catalog)
        rejected.extend(rej)
        oid, qsid = model.get("familyOid"), model.get("quickSpecsId")
        out.append(
            {
                "model": model["model"],
                "family": model["family"],
                "familyOid": oid,
                "quickSpecsId": qsid,
                "ddsUrl": f"https://www.hpe.com/psnow/doc/PSN{oid}WWEN.pdf" if oid else None,
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
    out.sort(key=lambda m: m["model"])
    antennas = build_antenna_index(catalog, out)
    payload = {
        "updated": date.today().isoformat(),
        "source": source,
        "supportAntennasUrl": SUPPORT_ANTENNAS,
        "filters": [
            "even-numbered AP-nnn (connectorized)",
            "connector type match",
            "mimo fits a port group",
            "antenna covers every band on that connector group",
        ],
        "counts": {
            "models": len(out),
            "compatibleRows": sum(len(m["antennas"]) for m in out),
            "antennas": len(antennas),
            "antennasWithAps": sum(1 for a in antennas if a["usedBy"]),
            "rejectedBomRows": len(rejected),
        },
        "models": out,
        "antennas": antennas,
        "rejected": rejected,
    }
    DEST.parent.mkdir(parents=True, exist_ok=True)
    DEST.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {DEST}")
    print("counts:", json.dumps(payload["counts"]))
    print("source:", payload["source"])
    return payload


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--offline", action="store_true", help="Seed only, no network.")
    args = ap.parse_args()

    models, catalog = load_seed()
    names = {}
    if args.offline:
        source = "offline: seed QuickSpecs lists, locally filtered"
    else:
        print(f"Refreshing {len(models)} seed models from QuickSpecs…")
        source, names = refresh_boms(models)

    write_matrix(models, catalog, source, names)
    empty = [m["model"] for m in models if even_ap(m["model"]) and not m.get("hpeBomSkus")]
    if empty:
        print("empty BOM:", empty, file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
