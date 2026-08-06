#!/usr/bin/env python3
"""
Diff multiple built CLI banks into a shared "common" pack + per-platform deltas.

Why
---
Full per-platform banks are ~7MB each (mostly entries.json). Most AOS-CX commands
are shared across series for a given train. This tool finds:

  * common   — leaves present in ALL input banks with identical content fingerprint
  * unique   — leaves only on that platform (or not universal)
  * override — same command title as another bank but different body (not put in
               common; full entry stored on each differing platform)

Output layout (default):
  data/layers/<group>/
    common/
      meta.json  tree.json  entries.json
    platforms/<platform-id>/
      meta.json  tree.json  entries.json
    manifest.json

Webapp load: fetch common + one platform, merge entries (platform wins) and
trees by title path. User only sees one bank.

Usage (from tools/cli-explorer/):
  .venv/bin/python scripts/diff_banks.py \\
      --group aos-cx-10.18 --match core \\
      --bank 6200=data/aos-cx-10.18-6200 \\
      --bank 6300=data/aos-cx-10.18-6300
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
APP_ROOT = SCRIPTS_DIR.parent
HERE = APP_ROOT
DATA_DIR = APP_ROOT / "data"
LAYERS_DIR = DATA_DIR / "layers"

# Fingerprint field presets. PDF extracts differ a lot in examples/preview even when
# the command is the same; "core" is the practical default for layering.
MATCH_PRESETS: dict[str, tuple[str, ...]] = {
    # title presence only — max compression, may hide platform-specific syntax
    "title": (),
    # command shape
    "syntax": ("syntax", "syntaxNo"),
    # shape + prose (recommended)
    "core": ("syntax", "syntaxNo", "description"),
    # include structured docs, still skip examples/preview (often platform-sample noise)
    "docs": (
        "syntax",
        "syntaxNo",
        "description",
        "parameters",
        "usage",
        "context",
        "authority",
        "platforms",
    ),
    # everything except raw preview/tables
    "full": (
        "syntax",
        "syntaxNo",
        "description",
        "examples",
        "parameters",
        "usage",
        "context",
        "authority",
        "platforms",
    ),
    # full + preview (strictest; almost no common across series)
    "strict": (
        "syntax",
        "syntaxNo",
        "description",
        "examples",
        "parameters",
        "usage",
        "context",
        "authority",
        "platforms",
        "preview",
        "paramRows",
        "historyRows",
    ),
}


def norm_title(title: str) -> str:
    t = re.sub(r"\s+", " ", (title or "").strip().lower())
    # normalize common unicode dashes / quotes
    t = t.replace("–", "-").replace("—", "-").replace("’", "'").replace("“", '"').replace("”", '"')
    return t


def content_fingerprint(entry: dict, fields: tuple[str, ...] = MATCH_PRESETS["core"]) -> str:
    """Hash selected entry fields. Empty fields tuple => title-only (always match)."""
    if not fields:
        return "title"
    payload: dict[str, Any] = {}
    for f in fields:
        val = entry.get(f)
        if val is None or val == "" or val == []:
            continue
        payload[f] = val
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def load_bank(path: Path) -> dict:
    path = path.resolve()
    entries_path = path / "entries.json"
    tree_path = path / "tree.json"
    meta_path = path / "meta.json"
    if not entries_path.is_file() or not tree_path.is_file():
        raise FileNotFoundError(f"Bank incomplete (need entries.json + tree.json): {path}")
    entries = json.loads(entries_path.read_text(encoding="utf-8"))
    tree_wrap = json.loads(tree_path.read_text(encoding="utf-8"))
    meta = {}
    if meta_path.is_file():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    return {
        "path": path,
        "entries": entries,
        "tree": tree_wrap.get("tree") or [],
        "meta": meta,
    }


def index_leaves(entries: dict[str, dict]) -> dict[str, dict]:
    """Map normalized title → entry for leaf nodes (commands)."""
    out: dict[str, dict] = {}
    collisions = 0
    for eid, ent in entries.items():
        if ent.get("leaf") is False:
            continue
        # Prefer explicit leaf True; also treat missing children-style parent rows
        # Non-leaves in flat entries usually have leaf=False
        if "leaf" in ent and not ent["leaf"]:
            continue
        key = norm_title(ent.get("title") or eid)
        if not key:
            continue
        if key in out:
            collisions += 1
            # Prefer longer description / richer entry
            prev = out[key]
            if len(json.dumps(ent, sort_keys=True)) > len(json.dumps(prev, sort_keys=True)):
                out[key] = ent
        else:
            out[key] = ent
    return out


def collect_tree_paths(nodes: list, prefix: tuple[str, ...] = ()) -> dict[str, list[str]]:
    """
    For each leaf title key, record the list of ancestor titles + self (path).
    Used to rebuild a minimal tree for a subset of leaves.
    """
    paths: dict[str, list[str]] = {}

    def walk(ns: list, path: list[str]) -> None:
        for n in ns:
            title = n.get("title") or ""
            here = path + [title]
            kids = n.get("children") or []
            if kids:
                walk(kids, here)
            else:
                key = norm_title(title)
                if key:
                    paths[key] = here

    walk(nodes, list(prefix))
    return paths


def rebuild_tree(paths: dict[str, list[str]], entries_by_key: dict[str, dict]) -> list[dict]:
    """
    Rebuild a nested tree from title paths. Node ids come from the entry id when
    known, else a stable slug of the title.
    """
    root_children: list[dict] = []
    # index: path_tuple -> node
    index: dict[tuple[str, ...], dict] = {}

    def ensure_path(parts: list[str], leaf_key: str | None) -> None:
        for i, part in enumerate(parts):
            tup = tuple(parts[: i + 1])
            if tup in index:
                continue
            is_leaf = i == len(parts) - 1 and leaf_key is not None
            ent = entries_by_key.get(leaf_key or "") if is_leaf else None
            node = {
                "id": (ent or {}).get("id") or re.sub(r"[^a-z0-9]+", "-", part.lower()).strip("-")[:80] or "item",
                "title": part,
                "page": (ent or {}).get("page") or 0,
                "pageEnd": (ent or {}).get("pageEnd") or (ent or {}).get("page") or 0,
                "chapter": parts[0] if parts else part,
                "leaf": bool(is_leaf),
            }
            if not is_leaf:
                node["children"] = []
                node["leaf"] = False
            index[tup] = node
            if i == 0:
                root_children.append(node)
            else:
                parent = index[tuple(parts[:i])]
                parent.setdefault("children", [])
                parent["children"].append(node)
                parent["leaf"] = False

    # stable order by first-seen path string
    for key in sorted(paths.keys(), key=lambda k: "/".join(paths[k]).lower()):
        ensure_path(paths[key], key)

    return root_children


def write_pack(out_dir: Path, tree: list, entries: dict, meta: dict) -> dict[str, int]:
    out_dir.mkdir(parents=True, exist_ok=True)
    tree_path = out_dir / "tree.json"
    entries_path = out_dir / "entries.json"
    meta_path = out_dir / "meta.json"
    tree_path.write_text(
        json.dumps({"tree": tree}, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    entries_path.write_text(
        json.dumps(entries, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    return {
        "tree_bytes": tree_path.stat().st_size,
        "entries_bytes": entries_path.stat().st_size,
        "meta_bytes": meta_path.stat().st_size,
        "entry_count": len(entries),
        "leaf_count": sum(1 for e in entries.values() if e.get("leaf", True)),
    }


def fmt_mb(n: int) -> str:
    return f"{n / (1024 * 1024):.2f} MB"


def diff_banks(
    banks: dict[str, dict],
    group: str,
    out_root: Path,
    match: str = "core",
    min_common_ratio: float = 1.0,
) -> dict:
    """
    banks: platform_id -> loaded bank dict
    match: fingerprint preset name (see MATCH_PRESETS)
    min_common_ratio: 1.0 = must appear in all banks; 0.8 = in ≥80% of banks
    """
    if match not in MATCH_PRESETS:
        raise ValueError(f"Unknown match preset {match!r}; choose from {list(MATCH_PRESETS)}")
    fp_fields = MATCH_PRESETS[match]

    platform_ids = list(banks.keys())
    n_plat = len(platform_ids)
    if n_plat < 2:
        raise ValueError("Need at least two banks to diff")

    # leaf indexes
    leaf_maps: dict[str, dict[str, dict]] = {
        pid: index_leaves(banks[pid]["entries"]) for pid in platform_ids
    }
    tree_paths: dict[str, dict[str, list[str]]] = {
        pid: collect_tree_paths(banks[pid]["tree"]) for pid in platform_ids
    }

    all_keys: set[str] = set()
    for m in leaf_maps.values():
        all_keys |= set(m.keys())

    threshold = max(1, int(round(n_plat * min_common_ratio)))
    if min_common_ratio >= 1.0:
        threshold = n_plat

    common_keys: set[str] = set()
    # title present everywhere but body differs
    diverge_keys: set[str] = set()
    # key -> set of platform ids that have it
    presence: dict[str, set[str]] = {}

    for key in all_keys:
        have = [pid for pid in platform_ids if key in leaf_maps[pid]]
        presence[key] = set(have)
        if len(have) < threshold:
            continue
        fps = {content_fingerprint(leaf_maps[pid][key], fp_fields) for pid in have}
        if len(fps) == 1:
            common_keys.add(key)
        else:
            diverge_keys.add(key)

    # Pick representative entry for common (first platform that has it, stable order)
    common_entries: dict[str, dict] = {}
    common_paths: dict[str, list[str]] = {}
    base_pid = platform_ids[0]
    for key in sorted(common_keys):
        # prefer base platform's entry for page numbers
        src_pid = base_pid if key in leaf_maps[base_pid] else next(
            pid for pid in platform_ids if key in leaf_maps[pid]
        )
        ent = copy.deepcopy(leaf_maps[src_pid][key])
        ent["_layer"] = "common"
        ent["_sourcePlatform"] = src_pid
        common_entries[ent["id"]] = ent
        # path from base if available else any
        if key in tree_paths[src_pid]:
            common_paths[key] = tree_paths[src_pid][key]
        else:
            for pid in platform_ids:
                if key in tree_paths[pid]:
                    common_paths[key] = tree_paths[pid][key]
                    break

    # Also include non-leaf chapter entries from base for common path ancestors?
    # rebuild_tree only needs titles in paths; entries for chapters optional.
    # Pull chapter entries from base bank when id matches for detail pane clicks.
    base_entries = banks[base_pid]["entries"]
    for key, path in common_paths.items():
        for title in path[:-1]:
            # find chapter entry by title
            for eid, ent in base_entries.items():
                if norm_title(ent.get("title", "")) == norm_title(title) and not ent.get(
                    "leaf", True
                ):
                    if eid not in common_entries:
                        ce = copy.deepcopy(ent)
                        ce["_layer"] = "common"
                        common_entries[eid] = ce
                    break

    common_tree = rebuild_tree(common_paths, {norm_title(e["title"]): e for e in common_entries.values()})

    platform_stats: dict[str, Any] = {}
    total_unique_entries = 0
    total_unique_bytes = 0

    for pid in platform_ids:
        leaves = leaf_maps[pid]
        plat_entries: dict[str, dict] = {}
        plat_paths: dict[str, list[str]] = {}

        for key, ent in leaves.items():
            if key in common_keys:
                continue  # pure common — not stored again
            # unique to this platform, partial, or content-divergent
            e = copy.deepcopy(ent)
            if key in diverge_keys:
                e["_layer"] = "override"
                e["_note"] = "Same title as other platforms but different body"
            elif presence[key] == {pid}:
                e["_layer"] = "unique"
            else:
                e["_layer"] = "partial"
                e["_alsoOn"] = sorted(presence[key] - {pid})
            plat_entries[e["id"]] = e
            if key in tree_paths[pid]:
                plat_paths[key] = tree_paths[pid][key]

        # Chapter shells for platform-only paths
        for key, path in plat_paths.items():
            for title in path[:-1]:
                for eid, ent in banks[pid]["entries"].items():
                    if norm_title(ent.get("title", "")) == norm_title(title) and not ent.get(
                        "leaf", True
                    ):
                        if eid not in plat_entries and eid not in common_entries:
                            pe = copy.deepcopy(ent)
                            pe["_layer"] = "unique"
                            plat_entries[eid] = pe
                        break

        plat_tree = rebuild_tree(
            plat_paths, {norm_title(e["title"]): e for e in plat_entries.values()}
        )

        sizes = write_pack(
            out_root / "platforms" / pid,
            plat_tree,
            plat_entries,
            {
                "layer": "platform",
                "platformId": pid,
                "group": group,
                "label": f"{group} · {pid} (delta)",
                "commonPath": f"data/layers/{group}/common",
                "uniqueLeaves": sum(1 for e in plat_entries.values() if e.get("_layer") == "unique"),
                "overrideLeaves": sum(
                    1 for e in plat_entries.values() if e.get("_layer") == "override"
                ),
                "partialLeaves": sum(
                    1 for e in plat_entries.values() if e.get("_layer") == "partial"
                ),
                "entryCount": len(plat_entries),
                # Prefer path relative to app root (never absolute home paths)
                "sourceBank": (
                    str(banks[pid]["path"].resolve().relative_to(APP_ROOT))
                    if banks[pid]["path"].is_absolute()
                    and str(banks[pid]["path"].resolve()).startswith(str(APP_ROOT))
                    else str(banks[pid]["path"])
                ),
            },
        )
        platform_stats[pid] = {
            **sizes,
            "source_entries": len(banks[pid]["entries"]),
            "source_leaves": len(leaves),
            "delta_keys": len(plat_paths),
        }
        total_unique_entries += sizes["entry_count"]
        total_unique_bytes += sizes["entries_bytes"]

    common_meta = {
        "layer": "common",
        "group": group,
        "label": f"{group} (common)",
        "platforms": platform_ids,
        "commonLeaves": len(common_keys),
        "divergedTitles": len(diverge_keys),
        "totalLeafUniverse": len(all_keys),
        "matchPreset": match,
        "matchFields": list(fp_fields),
        "minCommonRatio": min_common_ratio,
        "entryCount": len(common_entries),
    }
    common_sizes = write_pack(out_root / "common", common_tree, common_entries, common_meta)

    # Naive full multi-bank size vs layered
    full_bytes = sum(
        (banks[pid]["path"] / "entries.json").stat().st_size
        + (banks[pid]["path"] / "tree.json").stat().st_size
        for pid in platform_ids
    )
    layered_bytes = (
        common_sizes["entries_bytes"]
        + common_sizes["tree_bytes"]
        + sum(platform_stats[pid]["entries_bytes"] + platform_stats[pid]["tree_bytes"] for pid in platform_ids)
    )

    manifest = {
        "group": group,
        "platforms": platform_ids,
        "commonLeaves": len(common_keys),
        "divergedTitles": len(diverge_keys),
        "totalLeafUniverse": len(all_keys),
        "commonShareOfBase": round(
            len(common_keys) / max(1, len(leaf_maps[base_pid])), 4
        ),
        "sizes": {
            "common": common_sizes,
            "platforms": platform_stats,
            "fullBanksBytes": full_bytes,
            "layeredBytes": layered_bytes,
            "savedBytes": full_bytes - layered_bytes,
            "savedRatio": round(1 - (layered_bytes / full_bytes), 4) if full_bytes else 0,
        },
        "catalogHints": [
            {
                "id": f"{group}-{pid}",
                "label": f"{group} · {pid}",
                "family": "AOS-CX",
                "versionHint": group,
                "layers": {
                    "common": f"data/layers/{group}/common",
                    "platform": f"data/layers/{group}/platforms/{pid}",
                },
            }
            for pid in platform_ids
        ],
    }
    man_path = out_root / "manifest.json"
    man_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def parse_bank_arg(s: str) -> tuple[str, Path]:
    if "=" not in s:
        raise argparse.ArgumentTypeError(
            f"Expected platform=path, got {s!r} (example: 6200=data/aos-cx-10.18-6200)"
        )
    pid, path = s.split("=", 1)
    pid = pid.strip()
    if not pid:
        raise argparse.ArgumentTypeError(f"Empty platform id in {s!r}")
    return pid, Path(path)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument(
        "--group",
        required=True,
        help="Layer group name (e.g. aos-cx-10.18). Output under data/layers/<group>/",
    )
    ap.add_argument(
        "--bank",
        action="append",
        required=True,
        type=parse_bank_arg,
        metavar="PLATFORM=PATH",
        help="Platform id and path to a built bank directory (repeatable)",
    )
    ap.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output root (default: data/layers/<group>)",
    )
    ap.add_argument(
        "--match",
        choices=tuple(MATCH_PRESETS.keys()),
        default="core",
        help=(
            "How strictly bodies must match to be 'common' "
            "(default: core=syntax+description). "
            "full/strict barely dedupe across series because examples differ."
        ),
    )
    ap.add_argument(
        "--strict-preview",
        action="store_true",
        help="Deprecated alias for --match strict",
    )
    ap.add_argument(
        "--min-common-ratio",
        type=float,
        default=1.0,
        help="Fraction of platforms a command must appear on to be common (default 1.0 = all)",
    )
    args = ap.parse_args()

    match = "strict" if args.strict_preview else args.match

    banks: dict[str, dict] = {}
    for pid, path in args.bank:
        if not path.is_absolute():
            path = (HERE / path).resolve() if not path.exists() else path.resolve()
        print(f"Loading {pid} ← {path}")
        banks[pid] = load_bank(path)
        n_leaf = len(index_leaves(banks[pid]["entries"]))
        print(f"  entries={len(banks[pid]['entries'])}  leaves={n_leaf}")

    out_root = args.out or (LAYERS_DIR / args.group)
    if not out_root.is_absolute():
        out_root = (HERE / out_root).resolve()

    print(f"\nDiffing {len(banks)} banks → {out_root}  (match={match})")
    manifest = diff_banks(
        banks,
        group=args.group,
        out_root=out_root,
        match=match,
        min_common_ratio=args.min_common_ratio,
    )

    s = manifest["sizes"]
    print("\n=== Results ===")
    print(f"  leaf universe:     {manifest['totalLeafUniverse']}")
    print(f"  common leaves:     {manifest['commonLeaves']}  ({manifest['commonShareOfBase']*100:.1f}% of base)")
    print(f"  diverged titles:   {manifest['divergedTitles']}  (same name, different body)")
    print(f"  common entries:    {fmt_mb(s['common']['entries_bytes'])}  ({s['common']['entry_count']} entries)")
    for pid, st in s["platforms"].items():
        print(
            f"  platform {pid:12} {fmt_mb(st['entries_bytes']):>10}  "
            f"delta_leaves≈{st['delta_keys']}  (source leaves {st['source_leaves']})"
        )
    print(f"  full banks total:  {fmt_mb(s['fullBanksBytes'])}")
    print(f"  layered total:     {fmt_mb(s['layeredBytes'])}")
    print(f"  saved:             {fmt_mb(s['savedBytes'])}  ({s['savedRatio']*100:.1f}%)")
    print(f"\nManifest: {out_root / 'manifest.json'}")
    print("Catalog layer hints are in the manifest under catalogHints.")
    print("App: use bank.layers.common + bank.layers.platform (see app.js).")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
