#!/usr/bin/env python3
"""Fetch → split → manifest → validate.

Humans and GitHub Actions both run this. Use ``--offline`` to reuse
``source/`` without hitting the developer hub.

Usage::

    python build.py
    python build.py --offline
    python build.py --central-only --no-ssl-verify
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import sys
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
TOOL_ROOT = SCRIPTS_DIR.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from spec_fetcher import (
    DEFAULT_SOURCE_DIR,
    _configure_ssl_verify,
    fetch_all_specs,
    merge_local_source_files,
)
from spec_manifest import build_manifest, write_manifest
from spec_splitter import (
    DEFAULT_MAX_SLICE_BYTES,
    DEFAULT_MAX_SLICE_OPS,
    SliceResult,
    load_grouping,
    split_spec,
    write_slices,
)
from spec_validate import validate_dir

logger = logging.getLogger(__name__)


def _load_source_index(source_dir: Path) -> dict[str, Any]:
    index_path = source_dir / "index.json"
    if index_path.exists():
        data = json.loads(index_path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("files"):
            data["files"] = merge_local_source_files(source_dir, list(data["files"]))
            return data

    files: list[dict[str, Any]] = []
    for path in sorted(source_dir.rglob("*.json")):
        if path.name in {"index.json"} or path.name.endswith(".meta.json"):
            continue
        rel = path.relative_to(source_dir).as_posix()
        parts = Path(rel).parts
        api = parts[0]
        variant = parts[1] if len(parts) == 3 else None
        files.append(
            {
                "path": rel,
                "api": api,
                "variant": variant,
                "source_stem": path.stem,
                "title": path.stem,
                "version": "",
                "uuid": "",
                "filename": path.name,
                "slug": "",
            }
        )
    return {"files": files, "failures": []}


def _replace_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def _print_stats(results: list[SliceResult], max_ops: int, max_bytes: int) -> None:
    print("\n" + "═" * 88)
    print(
        f"{'API':<16} {'Src':<10} {'Group':<32} {'Ops':>5} {'Sch':>5} {'KB':>8}  Flags"
    )
    print("─" * 88)
    over = 0
    unresolved = 0
    unassigned = 0
    second = 0
    for result in results:
        flags: list[str] = []
        if result.second_cut:
            flags.append("cut")
            second += 1
        if result.unresolved:
            flags.append(f"unref={len(result.unresolved)}")
            unresolved += len(result.unresolved)
        if result.group_id == "uncategorized" or result.group_id.startswith("uncategorized__"):
            flags.append("unassigned")
            unassigned += result.operation_count
        if result.size_bytes > max_bytes or result.operation_count > max_ops:
            flags.append("OVER")
            over += 1
        src = result.variant or result.source_stem
        print(
            f"{result.api:<16} {src:<10} {result.group_id:<32} "
            f"{result.operation_count:5d} {result.schema_count:5d} "
            f"{result.size_bytes / 1024:8.1f}  {' '.join(flags)}"
        )
    print("─" * 88)
    print(
        f"{len(results)} documents  |  "
        f"{sum(r.operation_count for r in results)} ops  |  "
        f"{over} over budget  |  "
        f"{second} second-cut  |  "
        f"{unassigned} unassigned ops  |  "
        f"{unresolved} unresolved $refs"
    )
    print("═" * 88)


def run_build(
    *,
    offline: bool = False,
    central_only: bool = False,
    apis: list[str] | None = None,
    source_dir: Path | None = None,
    tool_root: Path | None = None,
    no_verify_ssl: bool = False,
    max_ops: int = DEFAULT_MAX_SLICE_OPS,
    max_bytes: int = DEFAULT_MAX_SLICE_BYTES,
    grouping_path: Path | None = None,
) -> int:
    root = tool_root or TOOL_ROOT
    source = source_dir or DEFAULT_SOURCE_DIR
    grouping = load_grouping(grouping_path or (SCRIPTS_DIR / "grouping.yaml"))

    if not offline:
        _configure_ssl_verify(no_verify=no_verify_ssl)
        logger.info("Fetching OpenAPI specs into %s", source)
        fetch_all_specs(source, central_only=central_only, apis=apis)

    if not source.exists():
        logger.error("No source directory at %s (fetch first, or drop --offline)", source)
        return 1

    index = _load_source_index(source)
    files = index.get("files") or []
    if apis:
        files = [entry for entry in files if entry.get("api") in set(apis)]
    elif central_only:
        files = [entry for entry in files if entry.get("api") == "aruba-central"]

    if not files:
        logger.error("No source specs to split")
        return 1

    results: list[SliceResult] = []
    for entry in files:
        rel = entry["path"]
        spec_path = source / rel
        if not spec_path.exists():
            logger.error("Missing source file %s", spec_path)
            return 1
        logger.info("Splitting %s", rel)
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
        results.extend(
            split_spec(
                spec,
                api=entry["api"],
                variant=entry.get("variant"),
                source_stem=entry.get("source_stem") or spec_path.stem,
                source_relpath=rel,
                grouping=grouping,
                max_ops=max_ops,
                max_bytes=max_bytes,
            )
        )

    specs_dir = root / "specs"
    _replace_dir(specs_dir)
    write_slices(results, root)

    manifest = build_manifest(results, source_index=index)
    manifest_path = write_manifest(manifest, root)
    logger.info("Wrote %s (%d groups, %d operations)", manifest_path, len(results), len(manifest["operations"]))

    _print_stats(results, max_ops, max_bytes)

    hard_fail = False
    for result in results:
        if result.unresolved:
            logger.error("%s unresolved $refs: %s", result.group_id, ", ".join(result.unresolved))
            hard_fail = True
        for warning in result.warnings:
            logger.warning("%s: %s", result.group_id, warning)

    validations = validate_dir(specs_dir)
    for item in validations:
        if not item.ok:
            hard_fail = True
            for error in item.errors:
                logger.error("%s: %s", item.path, error)

    if hard_fail:
        logger.error("Validation failed — not a publishable tree")
        return 1

    over = [
        result
        for result in results
        if result.size_bytes > max_bytes or result.operation_count > max_ops
    ]
    if over:
        logger.warning("%d slice(s) still over budget (published with warnings)", len(over))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Build published OpenAPI slices + manifest.")
    parser.add_argument("--offline", action="store_true", help="Reuse source/; skip network.")
    parser.add_argument("--central-only", action="store_true", help="Only Central MRT + Config.")
    parser.add_argument("--api", action="append", dest="apis", help="Limit to this api id.")
    parser.add_argument("--source-dir", type=Path, default=None)
    parser.add_argument(
        "--no-ssl-verify",
        "--no-verify-ssl",
        action="store_true",
        dest="no_ssl_verify",
        help="Disable SSL certificate verification (corporate proxy workaround).",
    )
    parser.add_argument("--max-ops", type=int, default=DEFAULT_MAX_SLICE_OPS)
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_SLICE_BYTES)
    parser.add_argument("--grouping", type=Path, default=None)
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )
    return run_build(
        offline=args.offline,
        central_only=args.central_only,
        apis=args.apis,
        source_dir=args.source_dir,
        no_verify_ssl=args.no_ssl_verify,
        max_ops=args.max_ops,
        max_bytes=args.max_bytes,
        grouping_path=args.grouping,
    )


if __name__ == "__main__":
    raise SystemExit(main())
