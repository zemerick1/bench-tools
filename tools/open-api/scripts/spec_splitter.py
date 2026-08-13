#!/usr/bin/env python3
"""Split one OpenAPI document into feature-sized documents.

Each generated file contains the selected operations plus the local ``$ref``
closure those operations need. References are preserved, not expanded.

Usage::

    python spec_splitter.py --spec source/aruba-central/mrt/foo.json \\
        --api aruba-central --variant mrt --out-dir ../../specs
"""

from __future__ import annotations

import argparse
import json
import logging
import re
from collections import defaultdict
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from oasutil import (
    HTTP_METHODS,
    SWAGGER2_ROOT_BUCKETS,
    collect_ref_strings,
    dump_spec,
    iter_operations,
    lookup,
    normalize_servers,
    parse_ref,
    path_prefix_key,
    security_scheme_names,
    slugify,
)
from spec_indexer import looks_like_api_auth, operation_tags

logger = logging.getLogger(__name__)

DEFAULT_MAX_SLICE_BYTES = 500 * 1024
DEFAULT_MAX_SLICE_OPS = 200

TOOL_ROOT = Path(__file__).resolve().parent.parent


@dataclass
class Operation:
    path: str
    method: str
    operation: dict[str, Any]
    path_item: dict[str, Any]
    tags: tuple[str, ...]
    group_id: str
    group_title: str
    category: str | None


@dataclass
class SliceResult:
    api: str
    variant: str | None
    source_stem: str
    source_relpath: str
    group_id: str
    group_title: str
    category: str | None
    spec: dict[str, Any]
    operation_records: list[dict[str, str]]
    operation_count: int
    schema_count: int
    size_bytes: int
    unresolved: list[str]
    second_cut: bool
    warnings: list[str] = field(default_factory=list)
    spec_relpath: str = ""


def load_grouping(path: Path | None) -> dict[str, Any]:
    """Load grouping.yaml. An empty / comment-only file needs no PyYAML."""
    if path is None or not path.exists():
        return {"maps": []}
    text = path.read_text(encoding="utf-8")
    meaningful = [
        line
        for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    if not meaningful:
        return {"maps": []}
    # ``maps: []`` is the empty overlay shipped in-repo.
    if all(line.strip() in {"maps: []", "maps:", "maps: []"} for line in meaningful):
        return {"maps": []}
    try:
        import yaml  # type: ignore
    except ImportError as exc:
        raise SystemExit(
            f"{path} has grouping rules; install pyyaml to load them"
        ) from exc
    data = yaml.safe_load(text) or {}
    if not isinstance(data, dict):
        raise SystemExit(f"{path} must be a mapping")
    data.setdefault("maps", [])
    return data


def _apply_overlay(
    tag: str | None,
    path: str,
    method: str,
    operation: dict[str, Any],
    grouping: dict[str, Any],
) -> tuple[str, str, str | None] | None:
    operation_id = operation.get("operationId") or ""
    for rule in grouping.get("maps") or []:
        if not isinstance(rule, dict):
            continue
        match = rule.get("match") or {}
        if "tag" in match and tag != match["tag"]:
            continue
        if "tag_prefix" in match and not (tag or "").startswith(str(match["tag_prefix"])):
            continue
        if "path_prefix" in match and not path.startswith(str(match["path_prefix"])):
            continue
        if "path_re" in match:
            try:
                if not re.search(str(match["path_re"]), path):
                    continue
            except re.error:
                continue
        if "operation_id" in match and operation_id != match["operation_id"]:
            continue
        if "method" in match and method != str(match["method"]).lower():
            continue
        title = str(rule.get("title") or tag or "Uncategorized")
        group_id = slugify(str(rule.get("group") or title))
        category = rule.get("category")
        return group_id, title, str(category) if category else None
    return None


def assign_group(
    path: str,
    method: str,
    operation: dict[str, Any],
    grouping: dict[str, Any],
) -> tuple[str, str, str | None, tuple[str, ...]]:
    tags = tuple(operation_tags(operation))
    primary = tags[0] if tags else None
    overlay = _apply_overlay(primary, path, method, operation, grouping)
    if overlay:
        return (*overlay, tags)
    if looks_like_api_auth(path):
        return "authentication", "Authentication", "Authentication", tags
    if primary:
        return slugify(primary), primary, None, tags
    return "uncategorized", "Uncategorized", None, tags


def _component_anchor(parts: list[str]) -> tuple[str, str, str] | None:
    """Return ``(location, bucket, name)`` for a local component pointer."""
    if len(parts) >= 3 and parts[0] == "components":
        return "components", parts[1], parts[2]
    if len(parts) >= 2 and parts[0] in SWAGGER2_ROOT_BUCKETS:
        return "root", parts[0], parts[1]
    return None


def _is_swagger2(spec: dict[str, Any]) -> bool:
    return bool(spec.get("swagger")) and not spec.get("openapi")


def _sanitize_info(info: dict[str, Any]) -> dict[str, Any]:
    """Keep title/version. Drop contact, license, logos, and marketing HTML."""
    clean: dict[str, Any] = {}
    for key in ("title", "version", "summary"):
        if key in info:
            clean[key] = deepcopy(info[key])
    description = info.get("description")
    if isinstance(description, str):
        text = description.strip()
        if (
            text
            and "<" not in text
            and "http://" not in text.lower()
            and "https://" not in text.lower()
            and len(text) <= 400
        ):
            clean["description"] = text
    if "title" not in clean:
        clean["title"] = "API"
    if "version" not in clean:
        clean["version"] = info.get("version") or "0.0.0"
    return clean


def _copy_root_metadata(spec: dict[str, Any]) -> dict[str, Any]:
    raw_info = spec.get("info") if isinstance(spec.get("info"), dict) else {}
    info = _sanitize_info(raw_info)
    out: dict[str, Any] = {
        "info": info,
        "paths": {},
    }
    if _is_swagger2(spec):
        out["swagger"] = spec.get("swagger") or "2.0"
        for key in ("host", "basePath", "schemes", "consumes", "produces", "securityDefinitions"):
            if key in spec:
                out[key] = deepcopy(spec[key])
        if spec.get("host"):
            schemes = spec.get("schemes") or ["https"]
            base = spec.get("basePath") or ""
            out["servers"] = [
                {"url": f"{scheme}://{spec['host']}{base}"} for scheme in schemes
            ]
    else:
        out["openapi"] = spec.get("openapi") or "3.1.0"
        out["components"] = {}
        if "servers" in spec:
            out["servers"] = normalize_servers(deepcopy(spec.get("servers")))
    for key in ("jsonSchemaDialect", "security", "externalDocs"):
        if key in spec:
            out[key] = deepcopy(spec[key])
    return out


def _tag_objects(names: set[str], spec: dict[str, Any]) -> list[dict[str, Any]]:
    by_name: dict[str, dict[str, Any]] = {}
    for tag in spec.get("tags") or []:
        if isinstance(tag, dict) and tag.get("name"):
            by_name[str(tag["name"])] = deepcopy(tag)
    objects: list[dict[str, Any]] = []
    for name in sorted(names):
        objects.append(by_name.get(name) or {"name": name})
    return objects


# Scalar 1.64 only prefixes HTTP Basic/Bearer. ``scheme: Token`` is dropped
# from snippets, and apiKey values are copied onto the header as-is. Prefill
# the header value when the API wants ``Authorization: Token <key>``.
_TOKEN_PREFIX_HINTS = ("token {", "token <", "`token ", "'token ", '"token ')

# Injected when the source spec names a bearer scheme but never defines it.
# Matches central-mind sandbox.py auth_scheme values.
_AUTH_INJECT: dict[str, dict[str, Any]] = {
    "clearpass": {
        "name": "BearerAuth",
        "description": "ClearPass REST API. Authorization: Bearer <access_token>",
        "strip_empty_op_security": True,
        "public_paths": frozenset({"/oauth"}),
    },
    "uxi": {
        "name": "HTTPBearer",
        "description": "UXI REST API. Authorization: Bearer <access_token>",
    },
}


def _scheme_text(name: str, scheme: dict[str, Any]) -> str:
    return " ".join(
        str(part)
        for part in (name, scheme.get("scheme"), scheme.get("description"), scheme.get("name"))
        if part
    ).lower()


def _apikey_authorization(scheme: dict[str, Any], prefix: str, placeholder: str) -> dict[str, Any]:
    """Keep apiKey + bake ``Prefix YOUR_…`` into the snippet header value."""
    out = dict(scheme)
    out["type"] = "apiKey"
    out.setdefault("in", "header")
    out["name"] = "Authorization"
    out["x-scalar-secret-token"] = f"{prefix} {placeholder}"
    if not out.get("description"):
        out["description"] = f"Authorization: {prefix} <token>"
    return out


def _rewrite_auth_scheme(
    name: str,
    scheme: dict[str, Any],
    *,
    swagger2: bool,
) -> dict[str, Any]:
    """Make snippet headers match how each API actually authenticates."""
    if not isinstance(scheme, dict):
        return scheme

    # Scalar ignores non-basic/bearer HTTP schemes — convert Token back.
    if scheme.get("type") == "http":
        if str(scheme.get("scheme") or "").lower() == "token":
            return _apikey_authorization(scheme, "Token", "YOUR_API_TOKEN")
        return scheme

    if scheme.get("type") != "apiKey":
        return scheme
    if str(scheme.get("name") or "").lower() != "authorization":
        return scheme

    text = _scheme_text(name, scheme)
    if any(hint in text for hint in _TOKEN_PREFIX_HINTS):
        return _apikey_authorization(scheme, "Token", "YOUR_API_TOKEN")
    if "bearer" in text or "jwt" in text:
        if swagger2:
            return _apikey_authorization(scheme, "Bearer", "YOUR_JWT")
        return {
            "type": "http",
            "scheme": "bearer",
            "bearerFormat": "JWT",
            "description": scheme.get("description") or "Authorization: Bearer <token>",
        }
    return scheme


def _scheme_maps(doc: dict[str, Any]) -> list[dict[str, Any]]:
    maps: list[dict[str, Any]] = []
    components = doc.get("components")
    if isinstance(components, dict) and isinstance(components.get("securitySchemes"), dict):
        maps.append(components["securitySchemes"])
    if isinstance(doc.get("securityDefinitions"), dict):
        maps.append(doc["securityDefinitions"])
    return maps


def _iter_slice_operations(doc: dict[str, Any]):
    paths = doc.get("paths")
    if not isinstance(paths, dict):
        return
    methods = set(HTTP_METHODS)
    for path, item in paths.items():
        if not isinstance(item, dict):
            continue
        for method, operation in item.items():
            if method.lower() not in methods or not isinstance(operation, dict):
                continue
            yield str(path), method, operation


def _referenced_scheme_names(doc: dict[str, Any]) -> set[str]:
    names: set[str] = set()
    for requirement in doc.get("security") or []:
        if isinstance(requirement, dict):
            names.update(str(key) for key in requirement)
    for _path, _method, operation in _iter_slice_operations(doc):
        requirements = operation.get("security")
        if not isinstance(requirements, list):
            continue
        for requirement in requirements:
            if isinstance(requirement, dict):
                names.update(str(key) for key in requirement)
    return names


def _ensure_http_bearer(doc: dict[str, Any], name: str, description: str) -> None:
    if _is_swagger2(doc):
        bucket = doc.setdefault("securityDefinitions", {})
        if name not in bucket:
            bucket[name] = {
                "type": "apiKey",
                "in": "header",
                "name": "Authorization",
                "description": description,
                "x-scalar-secret-token": "Bearer YOUR_JWT",
            }
        return
    schemes = doc.setdefault("components", {}).setdefault("securitySchemes", {})
    if name not in schemes:
        schemes[name] = {
            "type": "http",
            "scheme": "bearer",
            "description": description,
        }


def _strip_empty_op_security(doc: dict[str, Any], public_paths: set[str]) -> None:
    """Empty ``security: []`` means no auth and overrides document security."""
    for path, _method, operation in _iter_slice_operations(doc):
        if operation.get("security") != []:
            continue
        if path in public_paths:
            continue
        del operation["security"]


def _available_scheme_names(doc: dict[str, Any]) -> set[str]:
    names: set[str] = set()
    for bucket in _scheme_maps(doc):
        names.update(bucket)
    return names


def _scheme_is_preferred(scheme: Any) -> bool:
    if not isinstance(scheme, dict):
        return False
    if scheme.get("type") == "oauth2":
        return True
    if str(scheme.get("scheme") or "").lower() in {"bearer", "token"}:
        return True
    return bool(scheme.get("x-scalar-secret-token"))


def _apply_auth_fixes(doc: dict[str, Any], *, api: str) -> None:
    """Fix scheme shapes and drop security entries that name missing schemes."""
    swagger2 = _is_swagger2(doc)
    for bucket in _scheme_maps(doc):
        for name, scheme in list(bucket.items()):
            if isinstance(scheme, dict):
                bucket[name] = _rewrite_auth_scheme(name, scheme, swagger2=swagger2)

    profile = _AUTH_INJECT.get(api)
    if profile:
        _ensure_http_bearer(doc, str(profile["name"]), str(profile["description"]))
        if profile.get("strip_empty_op_security"):
            _strip_empty_op_security(doc, set(profile.get("public_paths") or ()))
        if not doc.get("security"):
            doc["security"] = [{str(profile["name"]): []}]

    available = _available_scheme_names(doc)
    for name in _referenced_scheme_names(doc) - available:
        if "bearer" in name.lower():
            _ensure_http_bearer(doc, name, "Authorization: Bearer <token>")

    available = _available_scheme_names(doc)
    security = doc.get("security")
    if isinstance(security, list):
        kept = [
            req
            for req in security
            if isinstance(req, dict) and req and set(req).issubset(available)
        ]
        if kept:
            doc["security"] = kept
        elif available:
            preferred = next(
                (
                    name
                    for bucket in _scheme_maps(doc)
                    for name, scheme in bucket.items()
                    if _scheme_is_preferred(scheme)
                ),
                next(iter(available)),
            )
            doc["security"] = [{preferred: []}]
        else:
            doc.pop("security", None)


def _record_for(op: Operation) -> dict[str, str]:
    return {
        "method": op.method,
        "path": op.path,
        "operationId": str(op.operation.get("operationId") or ""),
        "summary": str(op.operation.get("summary") or ""),
        "tag": op.tags[0] if op.tags else "",
    }


def build_slice(
    spec: dict[str, Any],
    operations: list[Operation],
    *,
    title_suffix: str | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """Build one self-contained OpenAPI document for *operations*."""
    out = _copy_root_metadata(spec)
    if title_suffix:
        out["info"]["title"] = title_suffix

    pending: set[str] = set()
    used_tags: set[str] = set()
    used_schemes: set[str] = set()
    path_order: list[str] = []

    for op in operations:
        if op.path not in out["paths"]:
            extras = {
                key: deepcopy(value)
                for key, value in op.path_item.items()
                if key.lower() not in {"get", "put", "post", "delete", "options", "head", "patch", "trace"}
            }
            out["paths"][op.path] = extras
            path_order.append(op.path)
            pending.update(collect_ref_strings(extras))
        out["paths"][op.path][op.method] = deepcopy(op.operation)
        pending.update(collect_ref_strings(op.operation))
        used_tags.update(op.tags)
        used_schemes.update(security_scheme_names(op.operation, spec))

    if used_tags:
        out["tags"] = _tag_objects(used_tags, spec)

    swagger2 = _is_swagger2(spec)
    components_src = spec.get("components") if isinstance(spec.get("components"), dict) else {}
    if swagger2:
        schemes_src = spec.get("securityDefinitions") if isinstance(spec.get("securityDefinitions"), dict) else {}
        if used_schemes and schemes_src:
            out.setdefault("securityDefinitions", {})
            for name in sorted(used_schemes):
                if name in schemes_src:
                    out["securityDefinitions"][name] = deepcopy(schemes_src[name])
                    pending.update(collect_ref_strings(schemes_src[name]))
    else:
        schemes_src = components_src.get("securitySchemes") or {}
        if used_schemes and isinstance(schemes_src, dict):
            out.setdefault("components", {}).setdefault("securitySchemes", {})
            for name in sorted(used_schemes):
                if name in schemes_src:
                    out["components"]["securitySchemes"][name] = deepcopy(schemes_src[name])
                    pending.update(collect_ref_strings(schemes_src[name]))

    included: dict[tuple[str, str], Any] = {}
    seen_refs: set[str] = set()
    unresolved: list[str] = []

    while pending:
        ref = pending.pop()
        if ref in seen_refs:
            continue
        seen_refs.add(ref)

        if not isinstance(ref, str) or not ref.startswith("#/"):
            unresolved.append(ref)
            continue

        parts = parse_ref(ref)
        if parts is None:
            unresolved.append(ref)
            continue

        target = lookup(spec, ref)
        if target is None:
            unresolved.append(ref)
            continue

        anchor = _component_anchor(parts)
        if anchor:
            location, ctype, cname = anchor
            key = (location, ctype, cname)
            if key in included:
                continue
            bucket = spec.get(ctype) if location == "root" else components_src.get(ctype)
            if not isinstance(bucket, dict) or cname not in bucket:
                unresolved.append(ref)
                continue
            definition = deepcopy(bucket[cname])
            included[key] = definition
            pending.update(collect_ref_strings(definition))
            continue

        if parts[0] == "paths" and len(parts) >= 2:
            extra_path = parts[1]
            src_paths = spec.get("paths") or {}
            if extra_path not in out["paths"] and extra_path in src_paths:
                extra_item = deepcopy(src_paths[extra_path])
                out["paths"][extra_path] = extra_item
                pending.update(collect_ref_strings(extra_item))
            continue

        # Other in-document pointers (#/info/..., etc.) resolved successfully.

    for (location, ctype, cname), definition in sorted(included.items()):
        if location == "root":
            out.setdefault(ctype, {})[cname] = definition
        else:
            out.setdefault("components", {}).setdefault(ctype, {})[cname] = definition

    if "components" in out and not out["components"]:
        del out["components"]

    unresolved = sorted(set(unresolved))
    return out, unresolved


def _over_budget(op_count: int, size_bytes: int, max_ops: int, max_bytes: int) -> bool:
    return op_count > max_ops or size_bytes > max_bytes


def _split_by_path_prefix(operations: list[Operation]) -> dict[str, list[Operation]] | None:
    """Try to partition *operations* by path prefix. None if it does not help."""
    if len(operations) <= 1:
        return None
    for depth in (1, 2, 3):
        buckets: dict[str, list[Operation]] = defaultdict(list)
        for op in operations:
            buckets[path_prefix_key(op.path, depth)].append(op)
        if len(buckets) > 1:
            return dict(buckets)
    return None


def _chunk_by_path(operations: list[Operation], max_ops: int) -> list[list[Operation]]:
    """Pack operations into chunks without breaking a path's CRUD set."""
    by_path: dict[str, list[Operation]] = defaultdict(list)
    for op in operations:
        by_path[op.path].append(op)
    chunks: list[list[Operation]] = []
    current: list[Operation] = []
    current_count = 0
    for path in sorted(by_path):
        group = sorted(by_path[path], key=lambda op: op.method)
        if current and current_count + len(group) > max_ops:
            chunks.append(current)
            current = []
            current_count = 0
        current.extend(group)
        current_count += len(group)
    if current:
        chunks.append(current)
    return chunks


def _finalize_slice(
    spec: dict[str, Any],
    operations: list[Operation],
    *,
    api: str,
    variant: str | None,
    source_stem: str,
    source_relpath: str,
    group_id: str,
    group_title: str,
    category: str | None,
    second_cut: bool,
    max_ops: int,
    max_bytes: int,
) -> SliceResult:
    document, unresolved = build_slice(spec, operations, title_suffix=group_title)
    _apply_auth_fixes(document, api=api)
    encoded = dump_spec(document)
    size = len(encoded.encode("utf-8"))
    warnings: list[str] = []
    if len(operations) > max_ops:
        warnings.append(f"{len(operations)} operations exceeds {max_ops}")
    if size > max_bytes:
        warnings.append(f"{size} bytes exceeds {max_bytes}")
    schemas = 0
    components = document.get("components") or {}
    if isinstance(components.get("schemas"), dict):
        schemas = len(components["schemas"])
    elif isinstance(document.get("definitions"), dict):
        schemas = len(document["definitions"])
    return SliceResult(
        api=api,
        variant=variant,
        source_stem=source_stem,
        source_relpath=source_relpath,
        group_id=group_id,
        group_title=group_title,
        category=category,
        spec=document,
        operation_records=[_record_for(op) for op in sorted(operations, key=lambda o: (o.path, o.method))],
        operation_count=len(operations),
        schema_count=schemas,
        size_bytes=size,
        unresolved=unresolved,
        second_cut=second_cut,
        warnings=warnings,
    )


def _subdivide(
    spec: dict[str, Any],
    operations: list[Operation],
    *,
    group_id: str,
    group_title: str,
    category: str | None,
    api: str,
    variant: str | None,
    source_stem: str,
    source_relpath: str,
    max_ops: int,
    max_bytes: int,
    second_cut: bool,
) -> list[SliceResult]:
    probe = _finalize_slice(
        spec,
        operations,
        api=api,
        variant=variant,
        source_stem=source_stem,
        source_relpath=source_relpath,
        group_id=group_id,
        group_title=group_title,
        category=category,
        second_cut=second_cut,
        max_ops=max_ops,
        max_bytes=max_bytes,
    )
    if not _over_budget(probe.operation_count, probe.size_bytes, max_ops, max_bytes):
        return [probe]
    if len(operations) <= 1:
        probe.warnings.append("single operation still over budget; publishing as-is")
        return [probe]

    prefix_buckets = _split_by_path_prefix(operations)
    if prefix_buckets:
        results: list[SliceResult] = []
        for prefix, bucket in sorted(prefix_buckets.items()):
            sub_id = f"{group_id}__{slugify(prefix)}"
            sub_title = f"{group_title} · {prefix}"
            results.extend(
                _subdivide(
                    spec,
                    bucket,
                    group_id=sub_id,
                    group_title=sub_title,
                    category=category,
                    api=api,
                    variant=variant,
                    source_stem=source_stem,
                    source_relpath=source_relpath,
                    max_ops=max_ops,
                    max_bytes=max_bytes,
                    second_cut=True,
                )
            )
        return results

    # Too many operations — pack by path so GET/POST/PUT/PATCH/DELETE stay together.
    if probe.operation_count > max_ops:
        chunks = _chunk_by_path(operations, max_ops)
        if len(chunks) <= 1:
            probe.warnings.append(
                "over operation budget but paths cannot be split without breaking CRUD; publishing as-is"
            )
            return [probe]
        results = []
        offset = 0
        for chunk in chunks:
            start = offset + 1
            end = offset + len(chunk)
            offset = end
            sub_id = f"{group_id}__{start:03d}-{end:03d}"
            sub_title = f"{group_title} · {start}–{end}"
            results.extend(
                _subdivide(
                    spec,
                    chunk,
                    group_id=sub_id,
                    group_title=sub_title,
                    category=category,
                    api=api,
                    variant=variant,
                    source_stem=source_stem,
                    source_relpath=source_relpath,
                    max_ops=max_ops,
                    max_bytes=max_bytes,
                    second_cut=True,
                )
            )
        return results

    # Over the byte budget, but this is one resource (shared schemas / CRUD).
    # Splitting by verb does not shrink the file and hides the rest of the API.
    probe.warnings.append("over byte budget; keeping resource CRUD together")
    return [probe]


def split_spec(
    spec: dict[str, Any],
    *,
    api: str,
    source_stem: str,
    source_relpath: str = "",
    variant: str | None = None,
    grouping: dict[str, Any] | None = None,
    max_ops: int = DEFAULT_MAX_SLICE_OPS,
    max_bytes: int = DEFAULT_MAX_SLICE_BYTES,
) -> list[SliceResult]:
    grouping = grouping or {"maps": []}
    grouped: dict[str, list[Operation]] = defaultdict(list)
    titles: dict[str, str] = {}
    categories: dict[str, str | None] = {}

    for path, method, operation, path_item in iter_operations(spec):
        group_id, group_title, category, tags = assign_group(path, method, operation, grouping)
        if not tags and group_title != "Uncategorized":
            operation = deepcopy(operation)
            operation["tags"] = [group_title]
            tags = (group_title,)
        grouped[group_id].append(
            Operation(
                path=path,
                method=method,
                operation=operation,
                path_item=path_item,
                tags=tags,
                group_id=group_id,
                group_title=group_title,
                category=category,
            )
        )
        titles[group_id] = group_title
        categories[group_id] = category

    results: list[SliceResult] = []
    for group_id in sorted(grouped):
        results.extend(
            _subdivide(
                spec,
                grouped[group_id],
                group_id=group_id,
                group_title=titles[group_id],
                category=categories[group_id],
                api=api,
                variant=variant,
                source_stem=source_stem,
                source_relpath=source_relpath,
                max_ops=max_ops,
                max_bytes=max_bytes,
                second_cut=False,
            )
        )
    return results


def slice_output_path(tool_root: Path, result: SliceResult) -> Path:
    """``specs/<api>/<variant?>/<source-stem>/<group>.json`` — stem avoids tag collisions."""
    dest = tool_root / "specs" / result.api
    if result.variant:
        dest /= result.variant
    dest /= result.source_stem
    return dest / f"{result.group_id}.json"


def write_slices(results: list[SliceResult], tool_root: Path) -> list[Path]:
    written: list[Path] = []
    for result in results:
        dest = slice_output_path(tool_root, result)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(dump_spec(result.spec), encoding="utf-8")
        result.spec_relpath = dest.relative_to(tool_root).as_posix()
        result.size_bytes = dest.stat().st_size
        written.append(dest)
    return written


def main() -> int:
    parser = argparse.ArgumentParser(description="Split one OpenAPI file into feature slices.")
    parser.add_argument("--spec", type=Path, required=True, help="Source OpenAPI JSON")
    parser.add_argument("--api", required=True, help="API id, e.g. aruba-central")
    parser.add_argument("--variant", default=None, help="Optional variant folder (mrt, config)")
    parser.add_argument("--source-stem", default=None, help="Defaults to the spec filename stem")
    parser.add_argument("--grouping", type=Path, default=Path(__file__).with_name("grouping.yaml"))
    parser.add_argument("--out-dir", type=Path, default=TOOL_ROOT, help="Tool root (writes specs/)")
    parser.add_argument("--max-ops", type=int, default=DEFAULT_MAX_SLICE_OPS)
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_SLICE_BYTES)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    spec = json.loads(args.spec.read_text(encoding="utf-8"))
    results = split_spec(
        spec,
        api=args.api,
        variant=args.variant,
        source_stem=args.source_stem or args.spec.stem,
        source_relpath=str(args.spec),
        grouping=load_grouping(args.grouping),
        max_ops=args.max_ops,
        max_bytes=args.max_bytes,
    )
    written = write_slices(results, args.out_dir)
    for result, path in zip(results, written):
        logger.info(
            "%s  %d ops  %d schemas  %.1f KB%s",
            path,
            result.operation_count,
            result.schema_count,
            result.size_bytes / 1024,
            "  [second-cut]" if result.second_cut else "",
        )
        if result.unresolved:
            logger.error("  unresolved: %s", ", ".join(result.unresolved))
    return 1 if any(result.unresolved for result in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
