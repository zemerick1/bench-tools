#!/usr/bin/env python3
"""Resolve local ``$ref`` pointers in an OpenAPI document.

Not part of the documentation pipeline. Expanding ``$ref``s before split
makes a large spec substantially larger. Kept for optional local inspection
of a single source file or generated slice.

Usage::

    python spec_resolver.py <input_spec> <output_spec>
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class SpecResolver:
    """Resolves local ``#/`` $ref pointers recursively."""

    def __init__(self, spec: dict[str, Any]):
        self.spec = spec
        self.visited: set[str] = set()
        self.circular_refs: set[str] = set()

    def _get_ref_value(self, ref_path: str) -> Any:
        if not ref_path.startswith("#/"):
            raise ValueError(f"Only local refs supported: {ref_path}")

        parts = ref_path[2:].split("/")
        value: Any = self.spec
        for part in parts:
            # JSON Pointer unescape so this stays usable on escaped names.
            part = part.replace("~1", "/").replace("~0", "~")
            if isinstance(value, dict):
                value = value.get(part)
                if value is None:
                    raise ValueError(f"Ref not found: {ref_path}")
            else:
                raise ValueError(f"Invalid ref path: {ref_path}")
        return value

    def _resolve_value(self, value: Any, ref_chain: set[str]) -> Any:
        if isinstance(value, dict):
            if "$ref" in value:
                ref_path = value["$ref"]
                if ref_path in ref_chain:
                    schema_name = ref_path.split("/")[-1]
                    self.circular_refs.add(ref_path)
                    return {"$circular": schema_name}

                self.visited.add(ref_path)
                try:
                    ref_value = self._get_ref_value(ref_path)
                    return self._resolve_value(ref_value, ref_chain | {ref_path})
                except Exception as exc:
                    logger.warning("Failed to resolve %s: %s", ref_path, exc)
                    return value
            return {key: self._resolve_value(val, ref_chain) for key, val in value.items()}

        if isinstance(value, list):
            return [self._resolve_value(item, ref_chain) for item in value]
        return value

    def resolve(self) -> dict[str, Any]:
        logger.info("Starting spec resolution...")
        resolved = self._resolve_value(self.spec, set())
        logger.info(
            "Resolved %d unique $refs, found %d circular references",
            len(self.visited),
            len(self.circular_refs),
        )
        if self.circular_refs:
            logger.info("Circular refs: %s", ", ".join(sorted(self.circular_refs)[:10]))
        return resolved


def resolve_spec(input_path: str, output_path: str) -> None:
    input_file = Path(input_path)
    output_file = Path(output_path)

    logger.info("Loading spec from %s...", input_file)
    with open(input_file, encoding="utf-8") as handle:
        spec = json.load(handle)

    logger.info("Spec loaded: %d paths", len(spec.get("paths", {})))
    resolver = SpecResolver(spec)
    resolved_spec = resolver.resolve()

    output_file.parent.mkdir(parents=True, exist_ok=True)
    with open(output_file, "w", encoding="utf-8") as handle:
        json.dump(resolved_spec, handle, indent=2)
        handle.write("\n")

    input_size = input_file.stat().st_size / (1024 * 1024)
    output_size = output_file.stat().st_size / (1024 * 1024)
    logger.info("Resolution complete! Input: %.2fMB, Output: %.2fMB", input_size, output_size)


def main() -> int:
    logging.basicConfig(level=logging.INFO)
    if len(sys.argv) != 3:
        print("Usage: python spec_resolver.py <input_spec> <output_spec>")
        return 1
    resolve_spec(sys.argv[1], sys.argv[2])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
