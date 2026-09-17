#!/usr/bin/env python3
"""Build the AOS 10 CLI Explorer bank from Aruba CLI-Bank Flare HTML.

Letter shards live at::

    Data/Tocs/AOS10__Commands__A_Chunk0.js
    Data/Tocs/AOS10__Commands__B_Chunk0.js
    …

Akamai 403s HTTP/1.1 urllib. curl --http2 with the Edge UA + sec-ch-ua /
Sec-Fetch-* headers is what actually returns 200.

Usage (from tools/cli-explorer/)::

    python3 scripts/build_from_cli_bank.py
    python3 scripts/build_from_cli_bank.py --limit 20 --workers 4
    python3 scripts/build_from_cli_bank.py --offline
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

from flare_topic import group_title, parse_flare_topic, parse_toc_chunk  # noqa: E402

APP_ROOT = SCRIPTS_DIR.parent
DATA_DIR = APP_ROOT / "data"
SOURCE_DIR = APP_ROOT / "source" / "cli-bank" / "aos10"

CLI_BANK = "https://arubanetworking.hpe.com/techdocs/CLI-Bank"
LANDING = CLI_BANK + "/Content/landing-pages/aos10-home.htm"
CHUNK_URL = CLI_BANK + "/Data/Tocs/AOS10__Commands__{letter}_Chunk{n}.js"
LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

EDGE_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0"
)
SEC_CH_UA = '"Chromium";v="152", "Not?A_Brand";v="24", "Microsoft Edge";v="152"'

PREFACE_TITLES = {
    "aos 10",
    "accessing aos 10 cli",
    "accessing the aos 10.x cli",
    "command line editing",
    "command-line editing",
    "saving configuration changes",
    "specifying addresses and identifiers in commands",
    "typographic conventions",
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


def http_get(url: str, *, dest: str, mode: str) -> bytes:
    cmd = [
        "curl",
        "-sS",
        "--fail",
        "--compressed",
        "--http2",
        "--retry",
        "3",
        "--retry-delay",
        "2",
        "-A",
        EDGE_UA,
        "-H",
        "Accept: */*",
        "-H",
        "Accept-Language: en-US,en;q=0.9",
        "-H",
        "Referer: {0}".format(LANDING),
        "-H",
        "Origin: https://arubanetworking.hpe.com",
        "-H",
        "sec-ch-ua: {0}".format(SEC_CH_UA),
        "-H",
        "sec-ch-ua-mobile: ?0",
        "-H",
        'sec-ch-ua-platform: "Windows"',
        "-H",
        "Sec-Fetch-Dest: {0}".format(dest),
        "-H",
        "Sec-Fetch-Mode: {0}".format(mode),
        "-H",
        "Sec-Fetch-Site: same-origin",
        url,
    ]
    try:
        return subprocess.check_output(cmd, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError as err:
        raise RuntimeError("GET failed rc={0} {1}".format(err.returncode, url)) from err


def topic_url(path: str) -> str:
    if path.startswith("http"):
        return path
    if not path.startswith("/"):
        path = "/" + path
    # Flare filenames can contain spaces ("sh-overlay multicast-vlan.htm").
    encoded = quote(path, safe="/.-_")
    return CLI_BANK + encoded


def cache_path_for(rel: str) -> Path:
    safe = rel.lstrip("/").replace("..", "_")
    return SOURCE_DIR / safe


def fetch_cached(url: str, dest_path: Path, *, dest: str, mode: str, refresh: bool) -> bytes:
    if dest_path.is_file() and not refresh:
        return dest_path.read_bytes()
    blob = http_get(url, dest=dest, mode=mode)
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    dest_path.write_bytes(blob)
    return blob


def fetch_letter_chunks(*, refresh: bool, offline: bool) -> List[Dict[str, Any]]:
    commands: List[Dict[str, Any]] = []
    seen = set()
    for letter in LETTERS:
        n = 0
        while n < 8:
            rel = "chunks/AOS10__Commands__{0}_Chunk{1}.js".format(letter, n)
            path = cache_path_for(rel)
            url = CHUNK_URL.format(letter=letter, n=n)
            if offline:
                if not path.is_file():
                    break
                blob = path.read_bytes()
            else:
                try:
                    blob = fetch_cached(
                        url, path, dest="script", mode="no-cors", refresh=refresh
                    )
                except RuntimeError:
                    if path.is_file() and not refresh:
                        blob = path.read_bytes()
                    else:
                        break
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


def build_tree(commands: List[Dict[str, Any]], parsed: Dict[str, Dict[str, Any]]) -> Tuple[list, dict]:
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


def build(
    out_dir: Path,
    *,
    workers: int,
    limit: int,
    refresh: bool,
    offline: bool,
) -> int:
    t0 = time.monotonic()
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    commands = fetch_letter_chunks(refresh=refresh, offline=offline)
    commands = [c for c in commands if c.get("title") and not is_preface(c)]
    if not commands:
        print("No AOS 10 commands in CLI-Bank letter chunks", file=sys.stderr)
        return 1
    if limit and limit > 0:
        commands = commands[:limit]

    digest = hashlib.sha256(
        json.dumps(
            [(c["path"], c["title"]) for c in commands],
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    digest_path = SOURCE_DIR / "toc.sha256"
    if (
        not refresh
        and not limit
        and (out_dir / "entries.json").is_file()
        and digest_path.is_file()
        and digest_path.read_text(encoding="utf-8").strip() == digest
    ):
        print("  CLI-Bank AOS 10 TOC unchanged, skip")
        return 0

    print("  aos-10 commands={0}  cache={1}".format(len(commands), SOURCE_DIR))

    parsed: Dict[str, Dict[str, Any]] = {}
    errors: List[str] = []
    started = time.monotonic()
    total = len(commands)

    def job(cmd: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
        rel = cmd["path"].lstrip("/")
        path = cache_path_for(rel)
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
    meta = {
        "source": "AOS-10.x Command-Line Interface Reference Guide",
        "label": "AOS 10.x",
        "family": "AOS 10",
        "versionHint": "10.x",
        "platform": None,
        "sourceFormat": "html",
        "sourceNote": "Indexed from Aruba CLI-Bank HTML (AOS 10 letter shards)",
        "sourceDisclaimer": "Unofficial helper — confirm against current HPE docs.",
        "sourceUrl": LANDING,
        "tocMode": "cli-bank-letters",
        "pageCount": leaf_count,
        "tocCount": len(entries),
        "leafCount": leaf_count,
        "previewChars": 1200,
        "bankId": "aos-10",
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
    print("Done in {0:.1f}s.".format(time.monotonic() - t0))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--out",
        type=Path,
        default=DATA_DIR / "aos-10",
        help="Output bank directory (default: data/aos-10)",
    )
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--limit", type=int, default=0, help="Only first N commands")
    ap.add_argument("--refresh", action="store_true", help="Ignore on-disk HTML cache")
    ap.add_argument(
        "--offline",
        action="store_true",
        help="Reuse source/cli-bank/aos10/; skip network",
    )
    args = ap.parse_args()
    out = args.out if args.out.is_absolute() else APP_ROOT / args.out
    return build(
        out,
        workers=max(1, args.workers),
        limit=args.limit,
        refresh=args.refresh,
        offline=args.offline,
    )


if __name__ == "__main__":
    raise SystemExit(main())
