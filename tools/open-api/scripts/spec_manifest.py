#!/usr/bin/env python3
"""Build the documentation manifest from splitter results.

No wall-clock timestamp: the committed file should stay byte-stable when
upstream specs (and therefore the slices) have not changed.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from spec_splitter import SliceResult

TOOL_ROOT = Path(__file__).resolve().parent.parent

API_TITLES = {
    "aruba-central": "HPE Aruba Networking Central",
    "clearpass": "ClearPass",
    "aos-cx": "AOS-CX",
    "uxi": "UXI",
    "mist": "Mist",
    "sdc": "Security Director Cloud",
    "axis": "Axis Security",
}


def build_manifest(
    slices: list[SliceResult],
    *,
    source_index: dict[str, Any] | None = None,
) -> dict[str, Any]:
    files_by_path = {
        entry.get("path"): entry
        for entry in (source_index or {}).get("files") or []
        if isinstance(entry, dict) and entry.get("path")
    }

    apis: dict[str, dict[str, Any]] = {}
    operations: list[dict[str, Any]] = []

    for result in slices:
        api = apis.setdefault(
            result.api,
            {
                "id": result.api,
                "title": API_TITLES.get(result.api, result.api),
                "sources": [],
                "groups": [],
            },
        )
        source_entry = files_by_path.get(result.source_relpath)

        source_key = (result.variant, result.source_relpath)
        already = {(s.get("variant"), s.get("path")) for s in api["sources"]}
        if source_key not in already:
            api["sources"].append(
                {
                    "variant": result.variant,
                    "stem": result.source_stem,
                    "path": result.source_relpath,
                    "title": (source_entry or {}).get("title") or result.source_stem,
                    "version": (source_entry or {}).get("version") or "",
                    "uuid": (source_entry or {}).get("uuid") or "",
                    "filename": (source_entry or {}).get("filename") or "",
                    "slug": (source_entry or {}).get("slug") or "",
                }
            )

        api["groups"].append(
            {
                "id": result.group_id,
                "title": result.group_title,
                "category": result.category,
                "spec": result.spec_relpath,
                "operations": result.operation_count,
                "schemas": result.schema_count,
                "bytes": result.size_bytes,
                "secondCut": result.second_cut,
                "sourceFile": result.source_relpath,
                "variant": result.variant,
            }
        )

        for record in result.operation_records:
            operations.append(
                {
                    "api": result.api,
                    "group": result.group_id,
                    "method": record["method"],
                    "path": record["path"],
                    "operationId": record["operationId"],
                    "summary": record["summary"],
                    "tag": record["tag"],
                    "spec": result.spec_relpath,
                }
            )

    api_list = []
    for api_id in sorted(apis):
        api = apis[api_id]
        api["groups"].sort(key=lambda group: (group.get("category") or "", group["title"], group["id"]))
        api["sources"].sort(key=lambda source: (source.get("variant") or "", source.get("stem") or ""))
        # Use a stable API title: first source title if the id leaked through.
        api["title"] = API_TITLES.get(api_id, api["title"] or api_id)
        api_list.append(api)

    operations.sort(key=lambda row: (row["api"], row["path"], row["method"]))

    return {
        "apis": api_list,
        "operations": operations,
    }


def write_manifest(manifest: dict[str, Any], tool_root: Path | None = None) -> Path:
    root = tool_root or TOOL_ROOT
    dest = root / "data" / "manifest.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return dest
