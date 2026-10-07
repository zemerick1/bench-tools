#!/usr/bin/env python3
"""Build CLI Explorer banks from Aruba CLI-Bank MadCap Flare HTML.

How a book is discovered
------------------------
Landing pages (aos10-home.htm, cppm-home.htm, …) do **not** embed the command
list. Letter chips load AMD shards::

    https://arubanetworking.hpe.com/techdocs/CLI-Bank/Data/Tocs/<PREFIX>__<Letter>_Chunk0.js

AOS 10 PREFIX = ``AOS10__Commands``
ClearPass PREFIX = ``cppm__Command_List``  (note: Command_List, not Commands)

To add the next product (AOS-8, Instant, SD-Branch, …):

1. Open the landing page with the Chrome UA from ``fetch_cli_json.py``
   (Akamai 403s urllib / curl without Chrome UA + sec-ch-ua + Sec-Fetch-*).
   DevTools → Network, click
   letter A, copy the Toc JS URL, take the PREFIX before ``__A_Chunk0.js``.
2. Add a ``BOOKS`` entry below. ``min_leaves`` is the GitHub Actions floor.
3. Catalog + UI treat ``platform: null`` families as a single Product pick
   (no version/model). ``build_catalog.py`` already scans ``data/<bank_id>/``.
4. GitHub Actions: ``.github/workflows/update-cli-html.yml`` runs
   ``python scripts/build_from_cli_bank.py --all`` after the AOS-CX HTML
   trains. Cache ``tools/cli-explorer/source/cli-bank``. Commit
   ``data/aos-10``, ``data/clearpass``, ``data/catalog.json``.

Fetch recipe (same client hints as fetch_cli_json.py)::

    curl --http2
    Chrome UA + sec-ch-ua / sec-ch-ua-mobile / sec-ch-ua-platform: "macOS"
    Sec-Fetch-Dest / Sec-Fetch-Mode / Sec-Fetch-Site on every request
    Referer: that book's landing page

Akamai 403s a cold crawl that opens many connections at once. Every request
shares one pace (a few per second) and a 403/429 is retried. A missing letter
chunk is HTTP 404 and ends that letter; any other chunk failure fails the book.

Usage (from tools/cli-explorer/)::

    python3 scripts/build_from_cli_bank.py --book aos-10
    python3 scripts/build_from_cli_bank.py --book clearpass
    python3 scripts/build_from_cli_bank.py --all
    python3 scripts/build_from_cli_bank.py --book clearpass --offline
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

from fetch_cli_json import CHROME_UA, SEC_CH_UA  # noqa: E402
from flare_topic import group_title, parse_flare_topic, parse_toc_chunk  # noqa: E402

APP_ROOT = SCRIPTS_DIR.parent
DATA_DIR = APP_ROOT / "data"
SOURCE_ROOT = APP_ROOT / "source" / "cli-bank"

CLI_BANK = "https://arubanetworking.hpe.com/techdocs/CLI-Bank"
LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

# Akamai 403s HTTP/1.1 and a bare UA. CHROME_UA / SEC_CH_UA match
# fetch_cli_json.py; the platform hint has to match that Macintosh UA.

# Shared front-matter titles across CLI-Bank books.
PREFACE_TITLES = {
    "aos 10",
    "accessing aos 10 cli",
    "accessing the aos 10.x cli",
    "command line editing",
    "command-line editing",
    "saving configuration changes",
    "specifying addresses and identifiers in commands",
    "typographic conventions",
    "clearpass",
    "about this guide",
}

# chunk_prefix is the stem before ``__A_Chunk0.js``.
BOOKS: Dict[str, Dict[str, Any]] = {
    "aos-10": {
        "bank_id": "aos-10",
        "chunk_prefix": "AOS10__Commands",
        "landing": CLI_BANK + "/Content/landing-pages/aos10-home.htm",
        "family": "AOS 10",
        "label": "AOS 10.x",
        "version_hint": "10.x",
        "source": "AOS-10.x Command-Line Interface Reference Guide",
        "source_note": "Indexed from Aruba CLI-Bank HTML (AOS 10 letter shards)",
        "min_leaves": 200,
        "cache_name": "aos10",
    },
    "clearpass": {
        "bank_id": "clearpass",
        "chunk_prefix": "cppm__Command_List",
        "landing": CLI_BANK + "/Content/landing-pages/cppm-home.htm",
        "family": "ClearPass",
        "label": "ClearPass",
        "version_hint": "Policy Manager",
        "source": "ClearPass Policy Manager Command-Line Interface Reference Guide",
        "source_note": "Indexed from Aruba CLI-Bank HTML (ClearPass letter shards)",
        "min_leaves": 40,
        "cache_name": "clearpass",
    },
}


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


# One gap for every CLI-Bank request. A 16-wide crawl from GitHub's runners
# did about 120 requests/second and Akamai answered 403 (curl rc 22). 4/s
# keeps a cold AOS 10 + ClearPass fetch under a few minutes.
HTTP_MIN_INTERVAL = 0.25
_HTTP_ATTEMPTS = 4
_RETRY_STATUSES = {403, 429, 500, 502, 503, 504}
_pace_lock = threading.Lock()
_next_http_at = 0.0


class HttpGetError(RuntimeError):
    def __init__(self, url: str, status: Optional[int], detail: str = "") -> None:
        self.url = url
        self.status = status
        self.detail = detail
        parts = ["GET failed"]
        if status is not None:
            parts.append("HTTP {0}".format(status))
        parts.append(url)
        if detail:
            parts.append("({0})".format(detail))
        super().__init__(" ".join(parts))


def _pace_http() -> None:
    global _next_http_at
    with _pace_lock:
        now = time.monotonic()
        wait = _next_http_at - now
        if wait > 0:
            time.sleep(wait)
            now = time.monotonic()
        _next_http_at = now + HTTP_MIN_INTERVAL


def parse_curl_http(stdout: bytes, stderr: bytes, returncode: int, url: str) -> Tuple[int, bytes]:
    """Split curl ``-w '\\n%{http_code}'`` output.

    curl stays exit 0 on an HTTP error when ``--fail`` is off, so the status
    is on the last line. A non-zero exit is a transport failure and has no
    status.
    """
    if returncode != 0:
        text = stderr.decode("utf-8", "replace").strip()
        detail = text.splitlines()[-1][:300] if text else "curl rc={0}".format(returncode)
        raise HttpGetError(url, None, detail)
    body, sep, code_b = stdout.rpartition(b"\n")
    if not sep or not code_b.isdigit():
        raise HttpGetError(url, None, "curl response had no HTTP status")
    return int(code_b), body


def curl_argv(url: str, *, dest: str, mode: str, referer: str) -> List[str]:
    """HTTP/2 Chrome request. Akamai 403s if any of these client hints are missing."""
    return [
        "curl",
        "-sS",
        "--compressed",
        "--http2",
        "--retry",
        "2",
        "--retry-delay",
        "1",
        "-A",
        CHROME_UA,
        "-H",
        "Accept: */*",
        "-H",
        "Accept-Language: en-US,en;q=0.9",
        "-H",
        "Referer: {0}".format(referer),
        "-H",
        "Origin: https://arubanetworking.hpe.com",
        "-H",
        "sec-ch-ua: {0}".format(SEC_CH_UA),
        "-H",
        "sec-ch-ua-mobile: ?0",
        "-H",
        'sec-ch-ua-platform: "macOS"',
        "-H",
        "Sec-Fetch-Dest: {0}".format(dest),
        "-H",
        "Sec-Fetch-Mode: {0}".format(mode),
        "-H",
        "Sec-Fetch-Site: same-origin",
        "-w",
        "\n%{http_code}",
        url,
    ]


def http_get(url: str, *, dest: str, mode: str, referer: str) -> bytes:
    cmd = curl_argv(url, dest=dest, mode=mode, referer=referer)
    last: Optional[HttpGetError] = None
    for attempt in range(1, _HTTP_ATTEMPTS + 1):
        _pace_http()
        try:
            proc = subprocess.run(cmd, capture_output=True)
            status, body = parse_curl_http(proc.stdout, proc.stderr, proc.returncode, url)
        except HttpGetError as err:
            last = err
            status = err.status
            body = b""
        else:
            if status == 200:
                return body
            last = HttpGetError(url, status)
        if status not in _RETRY_STATUSES and status is not None:
            raise last
        if attempt == _HTTP_ATTEMPTS:
            raise last
        time.sleep(attempt)
    raise last or HttpGetError(url, None, "no response")


def topic_url(path: str) -> str:
    if path.startswith("http"):
        return path
    if not path.startswith("/"):
        path = "/" + path
    # Flare filenames can contain spaces ("sh-overlay multicast-vlan.htm").
    encoded = quote(path, safe="/.-_")
    return CLI_BANK + encoded


def cache_path_for(book: Dict[str, Any], rel: str) -> Path:
    safe = rel.lstrip("/").replace("..", "_")
    return SOURCE_ROOT / book["cache_name"] / safe


def fetch_cached(
    url: str,
    dest_path: Path,
    *,
    dest: str,
    mode: str,
    referer: str,
    refresh: bool,
) -> bytes:
    if dest_path.is_file() and not refresh:
        return dest_path.read_bytes()
    blob = http_get(url, dest=dest, mode=mode, referer=referer)
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    dest_path.write_bytes(blob)
    return blob


def chunk_url(book: Dict[str, Any], letter: str, n: int) -> str:
    return "{0}/Data/Tocs/{1}__{2}_Chunk{3}.js".format(
        CLI_BANK, book["chunk_prefix"], letter, n
    )


def fetch_letter_chunks(
    book: Dict[str, Any], *, refresh: bool, offline: bool
) -> List[Dict[str, Any]]:
    commands: List[Dict[str, Any]] = []
    seen = set()
    referer = book["landing"]
    for letter in LETTERS:
        n = 0
        while n < 8:
            rel = "chunks/{0}__{1}_Chunk{2}.js".format(
                book["chunk_prefix"], letter, n
            )
            path = cache_path_for(book, rel)
            url = chunk_url(book, letter, n)
            if offline:
                if not path.is_file():
                    break
                blob = path.read_bytes()
            else:
                try:
                    blob = fetch_cached(
                        url,
                        path,
                        dest="script",
                        mode="no-cors",
                        referer=referer,
                        refresh=refresh,
                    )
                except HttpGetError as err:
                    # Chunk1 (and a letter with no commands) is a normal 404.
                    # 403/429/5xx used to look like an empty book.
                    if err.status == 404:
                        break
                    if path.is_file() and not refresh:
                        blob = path.read_bytes()
                    else:
                        raise
            text = blob.decode("utf-8", "replace")
            if text.lstrip().startswith("<"):
                break
            entries = parse_toc_chunk(text)
            if not entries:
                break
            for entry in entries:
                p = entry["path"]
                if p in seen:
                    continue
                seen.add(p)
                entry["letter"] = letter
                commands.append(entry)
            n += 1
    commands.sort(key=lambda e: ((e.get("title") or "").lower(), e.get("path") or ""))
    return commands


def is_preface(entry: Dict[str, Any]) -> bool:
    path = (entry.get("path") or "").lower()
    title = re.sub(r"\s+", " ", (entry.get("title") or "").strip().lower())
    if "/preface/" in path or "/landing-pages/" in path:
        return True
    return title in PREFACE_TITLES


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


def build_tree(
    commands: List[Dict[str, Any]], parsed: Dict[str, Dict[str, Any]]
) -> Tuple[list, dict]:
    used: set = set()
    groups: Dict[str, dict] = {}
    group_order: List[str] = []
    entries: Dict[str, dict] = {}

    for cmd in commands:
        title = cmd["title"]
        chapter = group_title(title)
        if chapter not in groups:
            gid = slugify("grp-" + chapter, used)
            node = {
                "id": gid,
                "title": chapter,
                "page": 0,
                "pageEnd": 0,
                "chapter": chapter,
                "leaf": False,
                "children": [],
            }
            groups[chapter] = node
            group_order.append(chapter)
            entries[gid] = {
                "id": gid,
                "title": chapter,
                "page": 0,
                "pageEnd": 0,
                "chapter": chapter,
                "leaf": False,
                "parentId": None,
                "source": "html",
            }

        parent = groups[chapter]
        nid = slugify(title, used)
        child = {
            "id": nid,
            "title": title,
            "page": 0,
            "pageEnd": 0,
            "chapter": chapter,
            "leaf": True,
        }
        parent["children"].append(child)

        fields = parsed.get(cmd["path"]) or {}
        entry = {
            "id": nid,
            "title": title,
            "page": 0,
            "pageEnd": 0,
            "chapter": chapter,
            "leaf": True,
            "parentId": parent["id"],
            "path": cmd["path"],
            "letter": cmd.get("letter") or "",
            "source": "html",
        }
        for key in (
            "syntax",
            "syntaxNo",
            "description",
            "examples",
            "parameters",
            "paramRows",
            "usage",
            "context",
            "authority",
            "platforms",
            "historyRows",
            "preview",
        ):
            val = fields.get(key)
            if val:
                entry[key] = val
        if not entry.get("syntax"):
            entry["syntax"] = title
        entries[nid] = entry

    tree = [groups[name] for name in group_order]
    return tree, entries


def build_book(
    book: Dict[str, Any],
    out_dir: Path,
    *,
    workers: int,
    limit: int,
    refresh: bool,
    offline: bool,
) -> int:
    t0 = time.monotonic()
    cache_dir = SOURCE_ROOT / book["cache_name"]
    cache_dir.mkdir(parents=True, exist_ok=True)
    try:
        commands = fetch_letter_chunks(book, refresh=refresh, offline=offline)
    except HttpGetError as err:
        print(
            "CLI-Bank chunk fetch failed for {0}: {1}".format(book["bank_id"], err),
            file=sys.stderr,
        )
        return 1
    commands = [c for c in commands if c.get("title") and not is_preface(c)]
    if not commands:
        print(
            "No commands in CLI-Bank letter chunks for {0}".format(book["bank_id"]),
            file=sys.stderr,
        )
        return 1
    if limit and limit > 0:
        commands = commands[:limit]

    digest = hashlib.sha256(
        json.dumps(
            [(c["path"], c["title"]) for c in commands],
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    digest_path = cache_dir / "toc.sha256"
    if (
        not refresh
        and not limit
        and (out_dir / "entries.json").is_file()
        and digest_path.is_file()
        and digest_path.read_text(encoding="utf-8").strip() == digest
    ):
        print("  CLI-Bank {0} TOC unchanged, skip".format(book["bank_id"]))
        return 0

    print(
        "  {0} commands={1}  cache={2}".format(
            book["bank_id"], len(commands), cache_dir
        )
    )

    parsed: Dict[str, Dict[str, Any]] = {}
    errors: List[str] = []
    started = time.monotonic()
    total = len(commands)
    referer = book["landing"]

    def job(cmd: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
        rel = cmd["path"].lstrip("/")
        path = cache_path_for(book, rel)
        if offline:
            if not path.is_file():
                raise RuntimeError("missing cache {0}".format(rel))
            html = path.read_text(encoding="utf-8", errors="replace")
        else:
            blob = fetch_cached(
                topic_url(cmd["path"]),
                path,
                dest="document",
                mode="navigate",
                referer=referer,
                refresh=refresh,
            )
            html = blob.decode("utf-8", "replace")
        fields = parse_flare_topic(html)
        if not fields.get("title"):
            fields["title"] = cmd["title"]
        return cmd["path"], fields

    if workers <= 1:
        for i, cmd in enumerate(commands):
            try:
                key, fields = job(cmd)
                parsed[key] = fields
            except Exception as err:
                errors.append("{0}: {1}".format(cmd.get("path"), err))
            print_progress(i + 1, total, started, cmd.get("title") or "")
    else:
        done = 0
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futs = {pool.submit(job, cmd): cmd for cmd in commands}
            for fut in as_completed(futs):
                cmd = futs[fut]
                done += 1
                try:
                    key, fields = fut.result()
                    parsed[key] = fields
                except Exception as err:
                    errors.append("{0}: {1}".format(cmd.get("path"), err))
                print_progress(done, total, started, cmd.get("title") or "")

    if errors:
        print("  {0} topic fetch/parse errors (first 8):".format(len(errors)))
        for e in errors[:8]:
            print("    {0}".format(e))
        if len(errors) > len(commands) // 2:
            print("Too many failures — refusing to publish", file=sys.stderr)
            return 1

    tree, entries = build_tree(commands, parsed)
    leaf_count = sum(1 for e in entries.values() if e.get("leaf"))
    min_leaves = int(book.get("min_leaves") or 0)
    if not limit and min_leaves and leaf_count < min_leaves:
        print(
            "{0} bank looks empty ({1} < {2}) — refusing to publish".format(
                book["bank_id"], leaf_count, min_leaves
            ),
            file=sys.stderr,
        )
        return 1

    meta = {
        "source": book["source"],
        "label": book["label"],
        "family": book["family"],
        "versionHint": book["version_hint"],
        "platform": None,
        "sourceFormat": "html",
        "sourceNote": book["source_note"],
        "sourceDisclaimer": "Unofficial helper — confirm against current HPE docs.",
        "sourceUrl": book["landing"],
        "tocMode": "cli-bank-letters",
        "chunkPrefix": book["chunk_prefix"],
        "pageCount": leaf_count,
        "tocCount": len(entries),
        "leafCount": leaf_count,
        "previewChars": 1200,
        "bankId": book["bank_id"],
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
    digest_path.write_text(digest + "\n", encoding="utf-8")
    print("Wrote {0}".format(out_dir / "meta.json"))
    print(
        "Wrote {0} ({1} KB, {2} commands, {3} groups)".format(
            out_dir / "entries.json",
            (out_dir / "entries.json").stat().st_size // 1024,
            leaf_count,
            sum(1 for e in entries.values() if not e.get("leaf")),
        )
    )
    print("Done {0} in {1:.1f}s.".format(book["bank_id"], time.monotonic() - t0))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--book",
        action="append",
        dest="books",
        choices=sorted(BOOKS),
        help="Book id (repeatable). Default: all books.",
    )
    ap.add_argument(
        "--all",
        action="store_true",
        help="Build every BOOKS entry (default when --book is omitted).",
    )
    ap.add_argument("--out", type=Path, default=None, help="Override output dir (single --book only)")
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--limit", type=int, default=0, help="Only first N commands")
    ap.add_argument("--refresh", action="store_true", help="Ignore on-disk HTML cache")
    ap.add_argument(
        "--offline",
        action="store_true",
        help="Reuse source/cli-bank/<book>/; skip network",
    )
    args = ap.parse_args()
    names = list(args.books or [])
    if args.all or not names:
        names = list(BOOKS)
    if args.out is not None and len(names) != 1:
        print("--out requires exactly one --book", file=sys.stderr)
        return 2

    rc = 0
    for name in names:
        book = BOOKS[name]
        if args.out is not None:
            out = args.out if args.out.is_absolute() else APP_ROOT / args.out
        else:
            out = DATA_DIR / book["bank_id"]
        book_rc = build_book(
            book,
            out,
            workers=max(1, args.workers),
            limit=args.limit,
            refresh=args.refresh,
            offline=args.offline,
        )
        if book_rc:
            rc = book_rc
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
