#!/usr/bin/env python3
"""
Build a CLI Explorer bank from HPE Support Center HTML (DITA topics).

Does NOT run in the browser. Stdlib only.

Usage (from tools/cli-explorer/):
  python3 scripts/build_from_html.py --doc-id sd00007904en_us --bank aos-cx-10.18-html-4100i
  python3 scripts/build_from_html.py --version 10.18 --platform 4100i
  python3 scripts/build_from_html.py --doc-id sd00007904en_us --limit 20
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

from html_topic import parse_topic_html  # noqa: E402

APP_ROOT = SCRIPTS_DIR.parent
DATA_DIR = APP_ROOT / "data"
SOURCE_DIR = APP_ROOT / "source"
PORTAL_SNAPSHOT = SCRIPTS_DIR / "portal" / "aoscx-cli.json"

HPESC_HOST = "support.hpe.com"
HPESC_DOC = "https://support.hpe.com/hpesc/public/api/document/{doc_id}"
PORTAL_CLI_JSON = (
    "https://arubanetworking.hpe.com/techdocs/ArubaDocPortal/"
    "content/new-portal/json/aoscx/cli.json"
)
UA = "tools-cli-explorer/1.0 (+https://tools.emerickcc.com)"
_TLS = threading.local()

CX_FRONT_MATTER_L1 = {
    "about this document",
    "introduction to the aos-cx cli",
    "notices",
    "notice",
    "acknowledgements",
    "acknowledgments",
    "copyright",
    "copyright information",
    "title page",
    "contents",
    "table of contents",
    "legal notices",
    "trademarks",
    "support and other resources",
    "support and other resource",
}


def _norm_title(title: str) -> str:
    return re.sub(r"\s+", " ", (title or "").strip().lower())


def is_front_matter_l1(title: str) -> bool:
    low = _norm_title(title)
    if low in CX_FRONT_MATTER_L1:
        return True
    if "command-line interface" in low and "guide" in low:
        return True
    if "command line interface" in low and "guide" in low:
        return True
    if low.startswith("aos-cx ") and "reference" in low:
        return True
    if low.startswith("introduction to the aos-cx"):
        return True
    return False


def slugify(title: str, used: set) -> str:
    base = re.sub(r"[^a-zA-Z0-9]+", "-", (title or "").strip().lower()).strip("-")
    if not base:
        base = "item"
    base = base[:80]
    slug = base
    n = 2
    while slug in used:
        slug = "{0}-{1}".format(base, n)
        n += 1
    used.add(slug)
    return slug


def guid_from_link(link: str) -> str:
    if not link:
        return ""
    m = re.search(r"[?&]page=([^&]+)", link)
    if m:
        return m.group(1)
    return link.rsplit("/", 1)[-1]


def _hpesc_conn(reset: bool = False, timeout: int = 60):
    if reset:
        old = getattr(_TLS, "conn", None)
        if old is not None:
            try:
                old.close()
            except Exception:
                pass
        _TLS.conn = None
    conn = getattr(_TLS, "conn", None)
    if conn is None:
        conn = http.client.HTTPSConnection(HPESC_HOST, timeout=timeout)
        _TLS.conn = conn
    else:
        conn.timeout = timeout
    return conn


def http_get(url: str, timeout: int = 60) -> Tuple[str, bytes]:
    """GET with keep-alive to support.hpe.com (thread-local HTTPSConnection)."""
    parsed = urlparse(url)
    headers = {
        "User-Agent": UA,
        "Accept": "application/json, text/html;q=0.8, */*;q=0.5",
        "Connection": "keep-alive",
    }
    last_err = None  # type: Optional[BaseException]

    if parsed.netloc != HPESC_HOST:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.headers.get("Content-Type") or "", resp.read()

    path = parsed.path
    if parsed.query:
        path = path + "?" + parsed.query
    headers["Host"] = HPESC_HOST

    for attempt in range(4):
        try:
            conn = _hpesc_conn(reset=attempt > 0, timeout=timeout)
            conn.request("GET", path, headers=headers)
            resp = conn.getresponse()
            body = resp.read()
            ctype = resp.getheader("Content-Type") or ""
            if resp.status in (429, 500, 502, 503, 504) and attempt < 3:
                time.sleep(1.5 * (attempt + 1))
                continue
            if resp.status >= 400:
                raise RuntimeError(
                    "HTTP {0} for {1}".format(resp.status, url)
                )
            return ctype, body
        except (http.client.HTTPException, TimeoutError, OSError) as err:
            last_err = err
            _hpesc_conn(reset=True)
            if attempt < 3:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise
    raise last_err  # type: ignore[misc]


def http_get_json(url: str) -> Any:
    ctype, body = http_get(url)
    text = body.decode("utf-8", "replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise RuntimeError(
            "Expected JSON from {0} (content-type {1}), got: {2!r}".format(
                url, ctype, text[:200]
            )
        )


def load_portal_map(path: Optional[Path] = None) -> dict:
    p = path or PORTAL_SNAPSHOT
    data = json.loads(p.read_text(encoding="utf-8"))
    return {k: v for k, v in data.items() if not str(k).startswith("_")}


def resolve_doc_id(version: str, platform: str, portal: dict) -> str:
    ver = (version or "").strip()
    plat = (platform or "").strip()
    block = portal.get(ver)
    if not isinstance(block, dict):
        # try 10.17 vs 10.17.1000
        for key in portal:
            if key.startswith(ver + ".") or ver.startswith(key):
                block = portal[key]
                break
    if not isinstance(block, dict):
        raise SystemExit("No portal mapping for version {0}".format(ver))
    if plat in block:
        return str(block[plat])
    # 6000/6100 style labels
    for key, doc in block.items():
        if plat.lower() in key.lower() or key.lower() in plat.lower():
            return str(doc)
    raise SystemExit(
        "No doc id for {0} / {1}; known series: {2}".format(
            ver, plat, ", ".join(sorted(block))
        )
    )


def fetch_toc(doc_id: str, cache_dir: Path, refresh: bool) -> list:
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / "toc.json"
    if path.is_file() and not refresh:
        return json.loads(path.read_text(encoding="utf-8"))
    url = "{0}/toc?docLocale=en_US".format(HPESC_DOC.format(doc_id=doc_id))
    print("Fetching TOC {0} …".format(url))
    toc = http_get_json(url)
    path.write_text(json.dumps(toc, ensure_ascii=False) + "\n", encoding="utf-8")
    return toc


def flatten_toc(nodes: list, skip_front: bool = True) -> List[dict]:
    """Depth-first list of {title, guid, depth, parent_title, children_count}."""
    out: List[dict] = []

    def walk(ns: list, depth: int, parent: Optional[str]) -> None:
        for n in ns or []:
            title = re.sub(r"\s+", " ", (n.get("topicName") or "")).strip()
            if depth == 0 and skip_front and is_front_matter_l1(title):
                continue
            kids = n.get("children") or []
            guid = guid_from_link(n.get("topicLink") or "")
            out.append(
                {
                    "title": title,
                    "guid": guid,
                    "depth": depth,
                    "parent_title": parent,
                    "child_count": len(kids),
                    "leaf": not kids,
                }
            )
            if kids:
                walk(kids, depth + 1, title)

    walk(nodes, 0, None)
    return out


def render_url(doc_id: str, guid: str) -> str:
    page = guid if guid.lower().endswith(".html") else guid + ".html"
    return "{0}/render?page={1}".format(HPESC_DOC.format(doc_id=doc_id), page)


def cache_page_path(cache_dir: Path, guid: str) -> Path:
    safe = guid.replace("/", "_")
    if not safe.endswith(".json"):
        if safe.endswith(".html"):
            safe = safe + ".json"
        else:
            safe = safe + ".html.json"
    return cache_dir / "pages" / safe


def fetch_topic(doc_id: str, guid: str, cache_dir: Path, refresh: bool) -> dict:
    path = cache_page_path(cache_dir, guid)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file() and not refresh:
        return json.loads(path.read_text(encoding="utf-8"))
    data = http_get_json(render_url(doc_id, guid))
    path.write_text(json.dumps(data, ensure_ascii=False) + "\n", encoding="utf-8")
    return data


def toc_to_tree_and_entries(
    rows: List[dict],
    topic_fields: Dict[str, dict],
) -> Tuple[list, dict]:
    used = set()  # type: set
    nodes: List[dict] = []
    entries: Dict[str, dict] = {}
    stack: List[dict] = []  # node per depth

    for row in rows:
        depth = int(row["depth"])
        title = row["title"]
        nid = slugify(title, used)
        guid = row["guid"]
        chapter = title if depth == 0 else (stack[0]["title"] if stack else title)
        is_leaf = bool(row["leaf"])
        node = {
            "id": nid,
            "title": title,
            "page": 0,
            "pageEnd": 0,
            "chapter": chapter,
            "leaf": is_leaf,
        }
        if not is_leaf:
            node["children"] = []

        parent_id = None
        while stack and stack[-1]["_depth"] >= depth:
            stack.pop()
        if stack:
            parent = stack[-1]
            parent.setdefault("children", [])
            parent["children"].append(node)
            parent["leaf"] = False
            parent_id = parent["id"]
        else:
            nodes.append(node)

        entry = {
            "id": nid,
            "title": title,
            "page": 0,
            "pageEnd": 0,
            "chapter": chapter,
            "leaf": is_leaf,
            "parentId": parent_id,
            "guid": guid,
            "source": "html",
        }
        fields = topic_fields.get(guid) or {}
        if is_leaf:
            if fields.get("syntax"):
                entry["syntax"] = fields["syntax"]
            if fields.get("syntaxNo"):
                entry["syntaxNo"] = fields["syntaxNo"]
            if fields.get("description"):
                entry["description"] = fields["description"]
            if fields.get("examples"):
                entry["examples"] = fields["examples"]
            if fields.get("parameters"):
                entry["parameters"] = fields["parameters"]
            if fields.get("paramRows"):
                entry["paramRows"] = fields["paramRows"]
            if fields.get("usage"):
                entry["usage"] = fields["usage"]
            if fields.get("context"):
                entry["context"] = fields["context"]
            if fields.get("authority"):
                entry["authority"] = fields["authority"]
            if fields.get("platforms"):
                entry["platforms"] = fields["platforms"]
            if fields.get("historyRows"):
                entry["historyRows"] = fields["historyRows"]
            if fields.get("preview"):
                entry["preview"] = fields["preview"]
            if not entry.get("syntax"):
                entry["syntax"] = title
        entries[nid] = entry

        node["_depth"] = depth
        stack.append(node)

    def strip_depth(ns: list) -> None:
        for n in ns:
            n.pop("_depth", None)
            if n.get("children"):
                strip_depth(n["children"])

    strip_depth(nodes)
    return nodes, entries


def print_progress(done: int, total: int, started: float, item: str = "") -> None:
    if total <= 0:
        return
    elapsed = max(0.001, time.monotonic() - started)
    rate = done / elapsed
    remain = (total - done) / rate if rate else 0
    bar_w = 24
    filled = int(bar_w * done / total)
    bar = "#" * filled + "-" * (bar_w - filled)
    msg = "  [{0}] {1}/{2}  {3:.1f}/s  eta {4:.0f}s  {5}".format(
        bar, done, total, rate, remain, (item or "")[:48]
    )
    sys.stdout.write("\r" + msg[:120].ljust(120))
    sys.stdout.flush()
    if done >= total:
        sys.stdout.write("\n")


def build(
    doc_id: str,
    out_dir: Path,
    version: str,
    platform: str,
    platform_label: str,
    workers: int,
    limit: int,
    refresh: bool,
    skip_front: bool,
) -> None:
    cache_dir = SOURCE_DIR / "html" / doc_id
    t0 = time.monotonic()
    toc = fetch_toc(doc_id, cache_dir, refresh)
    toc_digest = hashlib.sha256(
        json.dumps(toc, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    digest_path = cache_dir / "toc.sha256"
    if (
        not refresh
        and (out_dir / "entries.json").is_file()
        and digest_path.is_file()
        and digest_path.read_text(encoding="utf-8").strip() == toc_digest
    ):
        print("  TOC unchanged, skip {0} ({1})".format(doc_id, out_dir.name))
        return
    rows = flatten_toc(toc, skip_front=skip_front)
    leaves = [r for r in rows if r["leaf"] and r.get("guid")]
    if limit and limit > 0:
        keep_guids = set(r["guid"] for r in leaves[:limit])
        # keep ancestors of kept leaves
        filtered = []
        wanted_titles = set()
        for r in reversed(rows):
            if r["guid"] in keep_guids or (not r["leaf"] and r["title"] in wanted_titles):
                filtered.append(r)
                if r.get("parent_title"):
                    wanted_titles.add(r["parent_title"])
        rows = list(reversed(filtered))
        leaves = [r for r in rows if r["leaf"] and r.get("guid")]

    print(
        "  doc={0}  toc_rows={1}  leaves={2}  cache={3}".format(
            doc_id, len(rows), len(leaves), cache_dir
        )
    )

    topic_fields = {}  # type: Dict[str, dict]
    errors = []  # type: List[str]
    started = time.monotonic()
    total = len(leaves)

    def job(row: dict) -> Tuple[str, dict]:
        guid = row["guid"]
        data = fetch_topic(doc_id, guid, cache_dir, refresh)
        html = data.get("page_html") or ""
        parsed = parse_topic_html(html)
        if not parsed.get("title"):
            parsed["title"] = row["title"]
        return guid, parsed

    if workers <= 1:
        for i, row in enumerate(leaves):
            try:
                guid, parsed = job(row)
                topic_fields[guid] = parsed
            except Exception as err:
                errors.append("{0}: {1}".format(row.get("guid"), err))
            print_progress(i + 1, total, started, row.get("title") or "")
    else:
        done = 0
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futs = {pool.submit(job, row): row for row in leaves}
            for fut in as_completed(futs):
                row = futs[fut]
                done += 1
                try:
                    guid, parsed = fut.result()
                    topic_fields[guid] = parsed
                except Exception as err:
                    errors.append("{0}: {1}".format(row.get("guid"), err))
                print_progress(done, total, started, row.get("title") or "")

    if errors:
        print("  {0} topic fetch/parse errors (first 8):".format(len(errors)))
        for e in errors[:8]:
            print("    {0}".format(e))

    tree, entries = toc_to_tree_and_entries(rows, topic_fields)
    leaf_count = sum(1 for e in entries.values() if e.get("leaf"))
    label = platform_label or platform or doc_id
    meta = {
        "source": "AOS-CX Command-Line Interface Guide",
        "label": "AOS-CX {0} · {1}".format(version, label) if version else label,
        "family": "AOS-CX",
        "versionHint": version,
        "platform": "html_{0}".format(platform) if platform else doc_id,
        "platformLabel": "{0} (HTML)".format(platform) if platform else doc_id,
        "sourceFormat": "html",
        "sourceNote": "Indexed from HPESC HTML ({0})".format(doc_id),
        "sourceDisclaimer": "Unofficial helper — confirm against current HPE docs.",
        "docId": doc_id,
        "tocMode": "html-topics",
        "pageCount": leaf_count,
        "tocCount": len(entries),
        "leafCount": leaf_count,
        "bankId": out_dir.name,
        "fetchErrors": len(errors),
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "meta.json").write_text(
        json.dumps(meta, indent=2) + "\n", encoding="utf-8"
    )
    (out_dir / "tree.json").write_text(
        json.dumps({"tree": tree}, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    (out_dir / "entries.json").write_text(
        json.dumps(entries, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print("Wrote {0}".format(out_dir / "meta.json"))
    print(
        "Wrote {0} ({1} KB)".format(
            out_dir / "tree.json", (out_dir / "tree.json").stat().st_size // 1024
        )
    )
    print(
        "Wrote {0} ({1} KB)".format(
            out_dir / "entries.json", (out_dir / "entries.json").stat().st_size // 1024
        )
    )
    digest_path.write_text(toc_digest + "\n", encoding="utf-8")
    print("Done in {0:.1f}s.".format(time.monotonic() - t0))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--doc-id", default=None, help="HPESC id, e.g. sd00007904en_us")
    ap.add_argument("--version", default=None, help="AOS-CX train, e.g. 10.18")
    ap.add_argument("--platform", default=None, help="Series key in cli.json, e.g. 4100i")
    ap.add_argument(
        "--bank",
        default=None,
        help="Output bank id (default: aos-cx-<ver>-html-<platform>)",
    )
    ap.add_argument("--out", type=Path, default=None, help="Output directory")
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--limit", type=int, default=0, help="Only first N command leaves")
    ap.add_argument("--refresh", action="store_true", help="Ignore on-disk HTML cache")
    ap.add_argument(
        "--keep-front-matter",
        action="store_true",
        help="Do not drop About/Intro/Support chapters",
    )
    ap.add_argument(
        "--portal-json",
        type=Path,
        default=None,
        help="Override json/aoscx/cli.json snapshot",
    )
    args = ap.parse_args()

    version = args.version or ""
    platform = args.platform or ""
    doc_id = args.doc_id
    if not doc_id:
        if not version or not platform:
            print("Need --doc-id, or both --version and --platform", file=sys.stderr)
            return 2
        portal = load_portal_map(args.portal_json)
        doc_id = resolve_doc_id(version, platform, portal)
        print("Resolved {0} / {1} → {2}".format(version, platform, doc_id))
    if not version and args.bank:
        m = re.match(r"aos-cx-(\d+(?:\.\d+)*)", args.bank, re.I)
        if m:
            version = m.group(1)
    if not platform and args.bank:
        m = re.search(r"html-([a-z0-9]+)$", args.bank, re.I)
        if m:
            platform = m.group(1)

    bank = args.bank
    if not bank:
        if version and platform:
            bank = "aos-cx-{0}-html-{1}".format(version, platform)
        else:
            bank = "html-{0}".format(doc_id)

    out = args.out
    if out is None:
        out = DATA_DIR / bank
    elif not out.is_absolute():
        out = APP_ROOT / out

    label = platform or doc_id
    build(
        doc_id=doc_id,
        out_dir=out,
        version=version,
        platform=platform,
        platform_label=label,
        workers=max(1, args.workers),
        limit=args.limit,
        refresh=args.refresh,
        skip_front=not args.keep_front_matter,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
