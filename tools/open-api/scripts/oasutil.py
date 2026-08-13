"""Shared OpenAPI helpers for the bench-tools docs pipeline."""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from typing import Any

HTTP_METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")
_HTTP_METHOD_SET = set(HTTP_METHODS)

ROOT_ORDER = (
    "openapi",
    "swagger",
    "info",
    "jsonSchemaDialect",
    "host",
    "basePath",
    "schemes",
    "consumes",
    "produces",
    "servers",
    "security",
    "tags",
    "externalDocs",
    "paths",
    "webhooks",
    "definitions",
    "parameters",
    "responses",
    "securityDefinitions",
    "components",
)

SWAGGER2_ROOT_BUCKETS = ("definitions", "parameters", "responses")

COMPONENT_ORDER = (
    "schemas",
    "responses",
    "parameters",
    "examples",
    "requestBodies",
    "headers",
    "securitySchemes",
    "links",
    "callbacks",
    "pathItems",
)

_SLUG_RE = re.compile(r"[^a-z0-9]+")
_VERSION_RE = re.compile(r"^v\d", re.I)
_SECRET_KEY_RE = re.compile(
    r"(secret|token|password|passwd|api[_-]?key|auth_token|(?<!id_)sid)$",
    re.I,
)
_SECRET_VALUE_RE = re.compile(
    r"^(AC[0-9a-fA-F]{32}|sk_live_[A-Za-z0-9]+|ghp_[A-Za-z0-9]+|"
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----)",
)


def slugify(value: str) -> str:
    """Filesystem-stable slug."""
    return _SLUG_RE.sub("-", (value or "").strip().lower()).strip("-") or "untitled"


def pointer_escape(value: str) -> str:
    return value.replace("~", "~0").replace("/", "~1")


def pointer_unescape(value: str) -> str:
    return value.replace("~1", "/").replace("~0", "~")


def parse_ref(ref: str) -> list[str] | None:
    """Split a local JSON Pointer ``$ref``. External refs return None."""
    if not isinstance(ref, str) or not ref.startswith("#/"):
        return None
    return [pointer_unescape(part) for part in ref[2:].split("/")]


def lookup(spec: dict[str, Any], ref: str) -> Any:
    """Resolve a local ``$ref`` against *spec*. Returns None if missing/external."""
    parts = parse_ref(ref)
    if parts is None:
        return None
    node: Any = spec
    for part in parts:
        if isinstance(node, dict):
            if part not in node:
                return None
            node = node[part]
        elif isinstance(node, list):
            try:
                node = node[int(part)]
            except (ValueError, IndexError):
                return None
        else:
            return None
    return node


def collect_ref_strings(node: Any) -> set[str]:
    """Collect every ``$ref`` string, plus discriminator mapping targets."""
    found: set[str] = set()

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            ref = value.get("$ref")
            if isinstance(ref, str):
                found.add(ref)
            mapping = value.get("mapping")
            if isinstance(mapping, dict) and value.get("propertyName") is not None:
                for mapped in mapping.values():
                    if isinstance(mapped, str) and mapped:
                        if mapped.startswith("#"):
                            found.add(mapped)
                        else:
                            found.add(f"#/components/schemas/{pointer_escape(mapped)}")
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(node)
    return found


def resolve_path_item(path_item: Any, spec: dict[str, Any]) -> dict[str, Any] | None:
    """Return a path item dict, following a path-item-level ``$ref`` once."""
    if not isinstance(path_item, dict):
        return None
    if "$ref" in path_item and isinstance(path_item["$ref"], str):
        target = lookup(spec, path_item["$ref"])
        if isinstance(target, dict):
            return target
        return None
    return path_item


def iter_operations(
    spec: dict[str, Any],
) -> Iterator[tuple[str, str, dict[str, Any], dict[str, Any]]]:
    """Yield ``(path, method, operation, path_item)`` for each HTTP operation."""
    paths = spec.get("paths")
    if not isinstance(paths, dict):
        return
    for path, raw_item in paths.items():
        path_item = resolve_path_item(raw_item, spec)
        if path_item is None:
            continue
        for method, operation in path_item.items():
            if method.lower() not in _HTTP_METHOD_SET or not isinstance(operation, dict):
                continue
            yield str(path), method.lower(), operation, path_item


def count_operations(spec: dict[str, Any]) -> int:
    return sum(1 for _ in iter_operations(spec))


def security_scheme_names(operation: dict[str, Any], spec: dict[str, Any]) -> set[str]:
    """Scheme names required by the operation or the document-level security."""
    requirements = operation.get("security")
    if requirements is None:
        requirements = spec.get("security") or []
    names: set[str] = set()
    if not isinstance(requirements, list):
        return names
    for requirement in requirements:
        if isinstance(requirement, dict):
            names.update(str(key) for key in requirement)
    return names


def path_prefix_key(path: str, depth: int = 1) -> str:
    """Stable grouping key from a path, skipping versions and template params."""
    parts: list[str] = []
    for part in path.split("/"):
        if not part or part.startswith("{"):
            continue
        if _VERSION_RE.match(part):
            continue
        parts.append(part)
    if not parts:
        return "other"
    return "-".join(parts[: max(1, depth)])


def order_spec(spec: dict[str, Any]) -> dict[str, Any]:
    """Deterministic top-level / path / component ordering. Nested property order kept."""
    ordered: dict[str, Any] = {}
    for key in ROOT_ORDER:
        if key in spec:
            ordered[key] = spec[key]
    for key, value in spec.items():
        if key not in ordered:
            ordered[key] = value

    tags = ordered.get("tags")
    if isinstance(tags, list):
        ordered["tags"] = sorted(
            tags,
            key=lambda tag: (tag.get("name") or "") if isinstance(tag, dict) else str(tag),
        )

    paths = ordered.get("paths")
    if isinstance(paths, dict):
        ordered["paths"] = {path: _order_path_item(paths[path]) for path in sorted(paths)}

    components = ordered.get("components")
    if isinstance(components, dict):
        ordered_components: dict[str, Any] = {}
        for key in COMPONENT_ORDER:
            if key in components and isinstance(components[key], dict):
                bucket = components[key]
                ordered_components[key] = {name: bucket[name] for name in sorted(bucket)}
        for key, value in components.items():
            if key in ordered_components:
                continue
            if isinstance(value, dict):
                ordered_components[key] = {name: value[name] for name in sorted(value)}
            else:
                ordered_components[key] = value
        ordered["components"] = ordered_components

    for key in ("definitions", "parameters", "responses", "securityDefinitions"):
        bucket = ordered.get(key)
        if isinstance(bucket, dict):
            ordered[key] = {name: bucket[name] for name in sorted(bucket)}

    return ordered


def _order_path_item(path_item: Any) -> Any:
    if not isinstance(path_item, dict):
        return path_item
    extras = {key: value for key, value in path_item.items() if key.lower() not in _HTTP_METHOD_SET}
    ordered: dict[str, Any] = dict(extras)
    for method in HTTP_METHODS:
        if method in path_item:
            ordered[method] = path_item[method]
        elif method.upper() in path_item:
            ordered[method.lower()] = path_item[method.upper()]
    for key, value in path_item.items():
        if key not in ordered and key.lower() in _HTTP_METHOD_SET:
            ordered[key.lower()] = value
    return ordered


def normalize_servers(servers: Any) -> list[dict[str, Any]]:
    """Turn hostless AOS-CX ``switch-ip/rest/v…`` URLs into real OpenAPI servers."""
    if not isinstance(servers, list):
        return []
    normalized: list[dict[str, Any]] = []
    for server in servers:
        if not isinstance(server, dict):
            continue
        url = str(server.get("url") or "").strip()
        match = re.match(
            r"^(?:https?://)?\{?switch-ip\}?/?(.*)$",
            url,
            flags=re.IGNORECASE,
        )
        if match:
            rest = match.group(1).lstrip("/")
            suffix = f"/{rest}" if rest else ""
            entry = {
                "url": f"https://{{switchIp}}{suffix}",
                "description": server.get("description") or "AOS-CX switch",
                "variables": {
                    "switchIp": {
                        "default": "192.0.2.1",
                        "description": "Switch management IP or hostname",
                    }
                },
            }
            normalized.append(entry)
            continue
        normalized.append(server)
    return normalized


def redact_example_secrets(
    node: Any,
    parent_key: str = "",
    *,
    secret_context: bool = False,
) -> Any:
    """Replace example-looking secrets so GitHub push protection does not fire.

    Mist (and similar) OAS files ship sample Twilio SIDs / OAuth client
    secrets. They are not live credentials, but secret scanning still
    blocks the commit. Secret-ness is inherited so ``examples: ["…"]``
    under ``oauth_cc_client_secret`` is redacted too.
    """
    secret = secret_context or bool(_SECRET_KEY_RE.search(parent_key or ""))
    if isinstance(node, dict):
        return {
            key: redact_example_secrets(value, str(key), secret_context=secret)
            for key, value in node.items()
        }
    if isinstance(node, list):
        return [
            redact_example_secrets(item, parent_key, secret_context=secret)
            for item in node
        ]
    if isinstance(node, str) and len(node) >= 16:
        if secret or _SECRET_VALUE_RE.match(node):
            return "REDACTED"
    return node


def dump_spec(spec: dict[str, Any]) -> str:
    """Canonical JSON for published slices."""
    return json.dumps(order_spec(redact_example_secrets(spec)), indent=2, ensure_ascii=False) + "\n"


def load_json(path: Any) -> Any:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)
