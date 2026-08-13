#!/usr/bin/env python3
"""Fetch OpenAPI specs from Aruba's ReadMe-hosted developer hub.

Each ReadMe project publishes one or more uploaded OpenAPI definitions.
This script writes **each definition as its own file** under
``tools/open-api/source/`` and records provenance in ``source/index.json``.

It does not merge MRT + Config and does not resolve ``$ref``s. Those are
the old CentralMind behaviors; the docs pipeline splits per-definition
source files instead.

Usage::

    python spec_fetcher.py
    python spec_fetcher.py --central-only
    python spec_fetcher.py --source-dir /tmp/oas-source
"""

from __future__ import annotations

import html as _html
import json
import logging
import re
import ssl
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from oasutil import slugify

logger = logging.getLogger(__name__)

HUB = "https://developer.arubanetworks.com"

# "slug" is the ReadMe project path. "api" / "variant" decide the
# source/ directory layout (variant is only used when one API has
# multiple ReadMe projects, i.e. Central MRT vs Config).
PROJECTS: list[dict[str, Any]] = [
    {
        "slug": "new-central",
        "api": "aruba-central",
        "variant": "mrt",
        "label": "Central MRT",
        "central": True,
    },
    {
        "slug": "new-central-config",
        "api": "aruba-central",
        "variant": "config",
        "label": "Central Config",
        "central": True,
    },
    {"slug": "uxi", "api": "uxi", "variant": None, "label": "UXI", "central": False},
    {"slug": "cppm", "api": "clearpass", "variant": None, "label": "ClearPass", "central": False},
    {"slug": "aoscx", "api": "aos-cx", "variant": None, "label": "AOS-CX", "central": False},
]

# Direct OpenAPI URLs (not on the HPE ReadMe hub). Same source/ layout as hub files.
REMOTE_SPECS: list[dict[str, Any]] = [
    {
        "api": "mist",
        "label": "Mist",
        "url": "https://raw.githubusercontent.com/mistsys/mist_openapi/refs/heads/master/mist.openapi.json",
        "filename": "mist.json",
        "central": False,
    },
]

_SSR_PROPS_RE = re.compile(r'<script id="ssr-props"[^>]*>(.*?)</script>', re.DOTALL)
_README_REGISTRY = "https://dash.readme.com/api/v1/api-registry"

_UA = "Mozilla/5.0 (compatible; bench-tools-oas-sync/1.0)"
_TIMEOUT = 60
_RETRIES = 3
_RETRY_BACKOFF = 3

_ssl_verify: ssl.SSLContext | bool = True

TOOL_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE_DIR = TOOL_ROOT / "source"
LOCAL_SOURCE_DIR = TOOL_ROOT / "local"


def _configure_ssl_verify(*, no_verify: bool = False) -> None:
    """Prefer the system CA store so corporate TLS proxies work locally."""
    global _ssl_verify  # noqa: PLW0603

    if no_verify:
        logger.warning("SSL verification DISABLED (--no-ssl-verify)")
        _ssl_verify = False
        return

    try:
        ctx = ssl.create_default_context()
        if ctx.get_ca_certs():
            logger.debug("Using system SSL cert store (%d CA certs)", len(ctx.get_ca_certs()))
            _ssl_verify = ctx
            return
    except Exception:
        pass

    logger.debug("Using certifi CA bundle (system cert store unavailable)")
    _ssl_verify = True


def _http_get(url: str) -> bytes:
    last_exc: Exception | None = None
    for attempt in range(1, _RETRIES + 1):
        try:
            resp = httpx.get(
                url,
                headers={"User-Agent": _UA},
                timeout=_TIMEOUT,
                follow_redirects=True,
                verify=_ssl_verify,
            )
            resp.raise_for_status()
            return resp.content
        except (httpx.HTTPError, TimeoutError) as exc:
            last_exc = exc
            if attempt < _RETRIES:
                wait = _RETRY_BACKOFF * attempt
                logger.warning("  attempt %d failed (%s), retrying in %ds…", attempt, exc, wait)
                time.sleep(wait)
    raise RuntimeError(f"GET failed after {_RETRIES} attempts: {url} ({last_exc})")


def _looks_like_oas(obj: Any) -> bool:
    return (
        isinstance(obj, dict)
        and bool(obj.get("openapi") or obj.get("swagger"))
        and isinstance(obj.get("paths"), dict)
        and len(obj["paths"]) > 0
    )


def _parse_ssr_props(slug: str) -> dict[str, Any]:
    logger.info("  fetching %s/%s/reference …", HUB, slug)
    page = _http_get(f"{HUB}/{slug}/reference").decode("utf-8", "replace")
    match = _SSR_PROPS_RE.search(page)
    if not match:
        raise RuntimeError(f"no ssr-props on {HUB}/{slug}/reference (portal structure changed?)")
    try:
        return json.loads(_html.unescape(match.group(1).strip()))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{slug}: ssr-props JSON did not parse ({exc})") from exc


def discover_specs(slug: str) -> list[dict[str, str]]:
    """Discover the current branch's OpenAPI specs as ``[{filename, uuid}]``."""
    props = _parse_ssr_props(slug)
    api_defs = props.get("apiDefinitions") or []
    registries = (
        (((props.get("context") or {}).get("project") or {}).get("stable") or {}).get(
            "apiRegistries"
        )
        or []
    )

    uuid_by_file: dict[str, str] = {}
    for reg in registries:
        filename, uuid = reg.get("filename"), reg.get("uuid")
        if filename and uuid:
            uuid_by_file[filename] = uuid

    specs: list[dict[str, str]] = []
    for definition in api_defs:
        if definition.get("type") not in (None, "openapi"):
            continue
        filename = definition.get("filename")
        uuid = uuid_by_file.get(filename or "")
        if not uuid:
            continue
        specs.append({"filename": filename, "uuid": uuid})

    if not specs:
        raise RuntimeError(f"{slug}: no OpenAPI definitions found in ssr-props apiDefinitions")
    return specs


def fetch_spec(uuid: str) -> dict[str, Any] | None:
    raw = _http_get(f"{_README_REGISTRY}/{uuid}")
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return obj if _looks_like_oas(obj) else None


def fetch_all_specs_for_project(slug: str) -> list[dict[str, Any]]:
    """Discover and fetch all valid OpenAPI specs for a project.

    Returns ``[{filename, uuid, spec}, ...]``.
    """
    discovered = discover_specs(slug)
    logger.info("  discovered %d definition(s) for '%s'", len(discovered), slug)

    specs: list[dict[str, Any]] = []
    for entry in discovered:
        uuid = entry["uuid"]
        filename = entry["filename"]
        logger.info("  fetching %s (uuid=%s) …", filename, uuid[:12])
        spec = fetch_spec(uuid)
        if spec is not None:
            path_count = len(spec.get("paths", {}))
            title = (spec.get("info") or {}).get("title", "?")
            logger.info("    ✓ %s — %d paths", title, path_count)
            specs.append({"filename": filename, "uuid": uuid, "spec": spec})
        else:
            logger.warning("    ✗ uuid %s did not return a valid OAS", uuid)
    return specs


def _definition_slug(filename: str, spec: dict[str, Any], used: set[str]) -> str:
    stem = Path(filename).stem if filename else ""
    candidate = slugify(stem) if stem else ""
    if not candidate:
        title = (spec.get("info") or {}).get("title") or "untitled"
        candidate = slugify(title)
    if candidate not in used:
        return candidate
    suffix = 2
    while f"{candidate}-{suffix}" in used:
        suffix += 1
    return f"{candidate}-{suffix}"


def _relpath_for(project: dict[str, Any], file_slug: str) -> str:
    api = project["api"]
    variant = project.get("variant")
    if variant:
        return f"{api}/{variant}/{file_slug}.json"
    return f"{api}/{file_slug}.json"


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def fetch_project(project: dict[str, Any], source_dir: Path) -> list[dict[str, Any]]:
    """Fetch one ReadMe project. Returns index entries (may be empty on failure)."""
    slug = project["slug"]
    logger.info("── %s (%s) ──", project["label"], slug)
    try:
        fetched = fetch_all_specs_for_project(slug)
    except Exception as exc:
        logger.error("  ✗ %s: %s", slug, exc)
        return []

    if not fetched:
        logger.warning("  ✗ %s: no valid specs", slug)
        return []

    entries: list[dict[str, Any]] = []
    used_slugs: set[str] = set()
    for item in fetched:
        spec = item["spec"]
        file_slug = _definition_slug(item["filename"], spec, used_slugs)
        used_slugs.add(file_slug)
        relpath = _relpath_for(project, file_slug)
        dest = source_dir / relpath
        _write_json(dest, spec)

        info = spec.get("info") or {}
        size = dest.stat().st_size
        logger.info(
            "  ✓ Wrote %s — %d paths (%.2f MB)",
            relpath,
            len(spec.get("paths") or {}),
            size / (1024 * 1024),
        )
        entries.append(
            {
                "path": relpath,
                "api": project["api"],
                "variant": project.get("variant"),
                "source_stem": file_slug,
                "slug": slug,
                "label": project["label"],
                "filename": item["filename"],
                "uuid": item["uuid"],
                "title": info.get("title") or project["label"],
                "version": info.get("version") or "",
                "paths": len(spec.get("paths") or {}),
                "bytes": size,
            }
        )
    return entries


def fetch_remote_spec(remote: dict[str, Any], source_dir: Path) -> list[dict[str, Any]]:
    """Download one OpenAPI document from a raw URL into source/."""
    label = remote["label"]
    url = remote["url"]
    logger.info("── %s (url) ──", label)
    try:
        raw = _http_get(url)
        spec = json.loads(raw)
    except Exception as exc:
        logger.error("  ✗ %s: %s", label, exc)
        return []
    if not _looks_like_oas(spec):
        logger.error("  ✗ %s: URL did not return a valid OpenAPI document", label)
        return []

    file_slug = Path(remote["filename"]).stem
    relpath = _relpath_for(remote, file_slug)
    dest = source_dir / relpath
    _write_json(dest, spec)
    info = spec.get("info") or {}
    size = dest.stat().st_size
    logger.info(
        "  ✓ Wrote %s — %d paths (%.2f MB)",
        relpath,
        len(spec.get("paths") or {}),
        size / (1024 * 1024),
    )
    return [
        {
            "path": relpath,
            "api": remote["api"],
            "variant": remote.get("variant"),
            "source_stem": file_slug,
            "slug": "",
            "label": label,
            "filename": remote["filename"],
            "uuid": "",
            "title": info.get("title") or label,
            "version": info.get("version") or "",
            "paths": len(spec.get("paths") or {}),
            "bytes": size,
            "url": url,
        }
    ]


def seed_local_sources(source_dir: Path, local_dir: Path | None = None) -> int:
    """Copy committed ``local/`` specs into gitignored ``source/``.

    Hub fetches never see SDC / Axis. CI has no leftover ``source/``,
    so those platforms only survive a scheduled run if they live here.
    """
    root = local_dir or LOCAL_SOURCE_DIR
    if not root.is_dir():
        return 0
    copied = 0
    for path in sorted(root.rglob("*.json")):
        rel = path.relative_to(root)
        dest = source_dir / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(path.read_bytes())
        copied += 1
        logger.info("  seeded local/%s", rel.as_posix())
    return copied


def local_source_entry(source_dir: Path, rel: str) -> dict[str, Any]:
    """Index metadata for a spec dropped into source/ by hand."""
    path = source_dir / rel
    try:
        spec = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        spec = {}
    info = spec.get("info") if isinstance(spec, dict) else {}
    if not isinstance(info, dict):
        info = {}
    parts = Path(rel).parts
    return {
        "path": rel,
        "api": parts[0],
        "variant": parts[1] if len(parts) == 3 else None,
        "source_stem": path.stem,
        "slug": "",
        "label": info.get("title") or parts[0],
        "filename": path.name,
        "uuid": "",
        "title": info.get("title") or path.stem,
        "version": info.get("version") or "",
        "paths": len(spec.get("paths") or {}) if isinstance(spec, dict) else 0,
        "bytes": path.stat().st_size if path.exists() else 0,
        "local": True,
    }


def merge_local_source_files(source_dir: Path, files: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep hand-dropped specs (axis/sdc, …) when rewriting index.json."""
    known = {entry.get("path") for entry in files}
    for path in sorted(source_dir.rglob("*.json")):
        if path.name == "index.json" or path.name.endswith(".meta.json"):
            continue
        rel = path.relative_to(source_dir).as_posix()
        if rel in known:
            continue
        files.append(local_source_entry(source_dir, rel))
    files.sort(key=lambda entry: entry.get("path") or "")
    return files


def fetch_all_specs(
    source_dir: Path,
    *,
    central_only: bool = False,
    apis: list[str] | None = None,
) -> dict[str, Any]:
    """Fetch configured specs into *source_dir* and write ``index.json``."""
    wanted_apis = set(apis or [])
    files: list[dict[str, Any]] = []
    failures: list[str] = []

    seed_local_sources(source_dir)

    for project in PROJECTS:
        if central_only and not project["central"]:
            continue
        if wanted_apis and project["api"] not in wanted_apis:
            continue
        entries = fetch_project(project, source_dir)
        if not entries:
            failures.append(project["slug"])
        files.extend(entries)

    for remote in REMOTE_SPECS:
        if central_only:
            continue
        if wanted_apis and remote["api"] not in wanted_apis:
            continue
        entries = fetch_remote_spec(remote, source_dir)
        if not entries:
            failures.append(remote["api"])
        files.extend(entries)

    files = merge_local_source_files(source_dir, files)
    index = {
        "fetchedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "files": files,
        "failures": failures,
    }
    _write_json(source_dir / "index.json", index)

    if not files:
        raise RuntimeError("No OpenAPI specs fetched — refusing to write an empty source tree")
    if failures:
        raise RuntimeError(
            "Fetch failed for: " + ", ".join(failures) + " — refusing a partial source tree"
        )

    return index


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(
        description="Fetch OpenAPI specs from Aruba's developer hub (one file per definition).",
    )
    parser.add_argument(
        "--central-only",
        action="store_true",
        help="Only fetch Central (MRT + Config) specs.",
    )
    parser.add_argument(
        "--api",
        action="append",
        dest="apis",
        help="Limit to this api id (repeatable): aruba-central, clearpass, aos-cx, uxi, mist.",
    )
    parser.add_argument(
        "--source-dir",
        type=Path,
        default=None,
        help=f"Output directory (default: {DEFAULT_SOURCE_DIR}).",
    )
    parser.add_argument(
        "--no-ssl-verify",
        "--no-verify-ssl",
        action="store_true",
        dest="no_ssl_verify",
        help="Disable SSL certificate verification (corporate proxy workaround).",
    )
    parser.add_argument("--debug", action="store_true", help="Enable debug logging.")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    _configure_ssl_verify(no_verify=args.no_ssl_verify)
    source_dir = args.source_dir or DEFAULT_SOURCE_DIR
    logger.info("Source output directory: %s", source_dir)

    try:
        index = fetch_all_specs(
            source_dir,
            central_only=args.central_only,
            apis=args.apis,
        )
    except Exception as exc:
        logger.error("Fatal: %s", exc, exc_info=True)
        return 1

    print("\n" + "═" * 60)
    print("  Spec Fetch Summary")
    print("═" * 60)
    for entry in index["files"]:
        mb = entry["bytes"] / (1024 * 1024)
        print(f"  {entry['path']:50s}  {mb:6.2f} MB  {entry['paths']:5d} paths")
    if index["failures"]:
        print(f"\n  Failed projects: {', '.join(index['failures'])}")
    print("═" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
