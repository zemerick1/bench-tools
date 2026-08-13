#!/usr/bin/env python3
"""Validate generated OpenAPI slices. Fail closed on broken documents."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from oasutil import HTTP_METHODS, collect_ref_strings, lookup

_HTTP = set(HTTP_METHODS)


@dataclass
class ValidationResult:
    path: Path
    ok: bool
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def validate_spec(spec: Any, *, path: Path | None = None) -> ValidationResult:
    result = ValidationResult(path=path or Path("<memory>"), ok=True)

    if not isinstance(spec, dict):
        result.ok = False
        result.errors.append("document is not a JSON object")
        return result

    if not (spec.get("openapi") or spec.get("swagger")):
        result.ok = False
        result.errors.append("missing openapi/swagger version")

    paths = spec.get("paths")
    if not isinstance(paths, dict) or not paths:
        result.ok = False
        result.errors.append("paths is missing or empty")
        return result

    op_count = 0
    for path_key, path_item in paths.items():
        if not isinstance(path_item, dict):
            result.errors.append(f"{path_key}: path item is not an object")
            continue
        for method, operation in path_item.items():
            if method.lower() not in _HTTP:
                continue
            op_count += 1
            if not isinstance(operation, dict):
                result.errors.append(f"{method.upper()} {path_key}: operation is not an object")

    if op_count == 0:
        result.errors.append("no HTTP operations found")

    for ref in sorted(collect_ref_strings(spec)):
        if not isinstance(ref, str) or not ref.startswith("#/"):
            result.errors.append(f"non-local $ref: {ref}")
            continue
        if lookup(spec, ref) is None:
            result.errors.append(f"unresolved $ref: {ref}")

    result.ok = not result.errors
    return result


def validate_file(path: Path) -> ValidationResult:
    try:
        spec = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return ValidationResult(path=path, ok=False, errors=[f"invalid JSON: {exc}"])
    except OSError as exc:
        return ValidationResult(path=path, ok=False, errors=[f"unreadable: {exc}"])
    return validate_spec(spec, path=path)


def iter_spec_files(specs_dir: Path) -> list[Path]:
    if not specs_dir.exists():
        return []
    return sorted(path for path in specs_dir.rglob("*.json") if path.is_file())


def validate_dir(specs_dir: Path) -> list[ValidationResult]:
    files = iter_spec_files(specs_dir)
    if not files:
        return [
            ValidationResult(
                path=specs_dir,
                ok=False,
                errors=["no generated spec files found"],
            )
        ]
    return [validate_file(path) for path in files]


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate generated OpenAPI slices.")
    parser.add_argument(
        "--specs-dir",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "specs",
    )
    args = parser.parse_args()

    results = validate_dir(args.specs_dir)
    failed = 0
    for item in results:
        if item.ok:
            print(f"OK    {item.path}")
            continue
        failed += 1
        print(f"FAIL  {item.path}")
        for error in item.errors:
            print(f"        {error}")
    if failed:
        print(f"\n{failed} file(s) failed validation")
        return 1
    print(f"\n{len(results)} file(s) ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
