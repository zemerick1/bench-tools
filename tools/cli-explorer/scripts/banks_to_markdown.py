#!/usr/bin/env python3
"""
Convert CLI explorer bank JSON (tree + entries) to Markdown.

Usage (from tools/cli-explorer/):
  .venv/bin/python scripts/banks_to_markdown.py
  .venv/bin/python scripts/banks_to_markdown.py --bank aos-cx-10.18-6200
  .venv/bin/python scripts/banks_to_markdown.py --all --out markdown

Writes one .md file per bank under markdown/ (gitignored by default).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
APP_ROOT = SCRIPTS_DIR.parent
DATA_DIR = APP_ROOT / "data"
DEFAULT_OUT = APP_ROOT / "markdown"


def slug(s: str) -> str:
    s = re.sub(r"[^\w\s.-]+", "", s, flags=re.UNICODE)
    s = re.sub(r"\s+", "-", s.strip())
    return s[:80] or "section"


def md_escape_fence(text: str) -> str:
    """Avoid breaking fenced blocks if content contains triple backticks."""
    return (text or "").replace("```", "``\u200b`")


def render_entry(entry: dict) -> list[str]:
    lines: list[str] = []
    title = entry.get("title") or entry.get("id") or "Command"
    lines.append(f"### {title}")
    lines.append("")

    page = entry.get("page")
    page_end = entry.get("pageEnd")
    if page:
        if page_end and page_end != page:
            lines.append(f"*Source pages: {page}–{page_end}*")
        else:
            lines.append(f"*Source page: {page}*")
        lines.append("")

    chapter = entry.get("chapter")
    if chapter and chapter != title:
        lines.append(f"**Chapter:** {chapter}")
        lines.append("")

    syntax = entry.get("syntax") or ""
    syntax_no = entry.get("syntaxNo") or ""
    if syntax or syntax_no:
        lines.append("**Syntax**")
        lines.append("")
        lines.append("```")
        block = "\n".join(x for x in (syntax, syntax_no) if x).strip()
        lines.append(md_escape_fence(block))
        lines.append("```")
        lines.append("")

    if entry.get("description"):
        lines.append("**Description**")
        lines.append("")
        lines.append(entry["description"].strip())
        lines.append("")

    if entry.get("parameters"):
        lines.append("**Parameters**")
        lines.append("")
        lines.append("```")
        lines.append(md_escape_fence(str(entry["parameters"]).rstrip()))
        lines.append("```")
        lines.append("")

    if entry.get("paramRows"):
        lines.append("**Parameters (table)**")
        lines.append("")
        rows = entry["paramRows"]
        if rows:
            header = rows[0]
            lines.append("| " + " | ".join(str(c or "") for c in header) + " |")
            lines.append("| " + " | ".join("---" for _ in header) + " |")
            for row in rows[1:]:
                lines.append("| " + " | ".join(str(c or "") for c in row) + " |")
            lines.append("")

    if entry.get("examples"):
        lines.append("**Examples**")
        lines.append("")
        lines.append("```")
        lines.append(md_escape_fence(str(entry["examples"]).rstrip()))
        lines.append("```")
        lines.append("")

    if entry.get("usage"):
        lines.append("**Usage**")
        lines.append("")
        lines.append(str(entry["usage"]).strip())
        lines.append("")

    bits = []
    if entry.get("platforms"):
        bits.append(f"Platforms: {entry['platforms']}")
    if entry.get("context"):
        bits.append(f"Context: {entry['context']}")
    if entry.get("authority"):
        bits.append(f"Authority: {entry['authority']}")
    if bits:
        lines.append("**Command information**")
        lines.append("")
        for b in bits:
            lines.append(f"- {b}")
        lines.append("")

    lines.append("---")
    lines.append("")
    return lines


def walk_tree(nodes: list, entries: dict, out: list[str], depth: int = 0) -> None:
    for node in nodes or []:
        title = node.get("title") or node.get("id") or "Section"
        kids = node.get("children") or []
        nid = node.get("id")
        entry = entries.get(nid) if nid else None
        is_leaf = node.get("leaf", not kids)

        if kids:
            level = min(2 + depth, 6)
            out.append("#" * level + f" {title}")
            out.append("")
            walk_tree(kids, entries, out, depth + 1)
        elif is_leaf and entry:
            out.extend(render_entry(entry))
        elif is_leaf:
            out.append(f"### {title}")
            out.append("")
            out.append("*No entry payload.*")
            out.append("")
            out.append("---")
            out.append("")


def convert_bank(bank_dir: Path, out_path: Path) -> dict:
    tree_path = bank_dir / "tree.json"
    entries_path = bank_dir / "entries.json"
    meta_path = bank_dir / "meta.json"
    if not tree_path.is_file() or not entries_path.is_file():
        raise FileNotFoundError(f"Bank incomplete: {bank_dir}")

    tree_wrap = json.loads(tree_path.read_text(encoding="utf-8"))
    entries = json.loads(entries_path.read_text(encoding="utf-8"))
    meta = {}
    if meta_path.is_file():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            meta = {}

    tree = tree_wrap.get("tree") or tree_wrap
    label = meta.get("label") or bank_dir.name
    lines: list[str] = [
        f"# {label}",
        "",
        f"*Bank id: `{bank_dir.name}`*",
        "",
    ]
    if meta.get("versionHint"):
        lines.append(f"- Version: {meta['versionHint']}")
    if meta.get("pageCount"):
        lines.append(f"- Source pages: {meta['pageCount']}")
    if meta.get("leafCount"):
        lines.append(f"- Commands: {meta['leafCount']}")
    if meta.get("sourceNote"):
        lines.append(f"- Note: {meta['sourceNote']}")
    lines.append("")
    lines.append("---")
    lines.append("")

    walk_tree(tree, entries, lines)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    text = "\n".join(lines).rstrip() + "\n"
    out_path.write_text(text, encoding="utf-8")
    return {
        "bank": bank_dir.name,
        "out": str(out_path),
        "bytes": out_path.stat().st_size,
        "lines": text.count("\n") + 1,
    }


def discover_banks() -> list[Path]:
    if not DATA_DIR.is_dir():
        return []
    banks = []
    for child in sorted(DATA_DIR.iterdir()):
        if not child.is_dir() or child.name in {"layers"}:
            continue
        if (child / "tree.json").is_file() and (child / "entries.json").is_file():
            banks.append(child)
    return banks


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--bank",
        action="append",
        dest="banks",
        help="Bank id under data/ (repeatable). Default: all banks.",
    )
    ap.add_argument(
        "--all",
        action="store_true",
        help="Convert every bank under data/ (default if --bank omitted).",
    )
    ap.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUT,
        help=f"Output directory (default: {DEFAULT_OUT})",
    )
    args = ap.parse_args()

    out_root = args.out if args.out.is_absolute() else (APP_ROOT / args.out)

    if args.banks:
        bank_dirs = []
        for bid in args.banks:
            d = DATA_DIR / bid
            if not d.is_dir():
                print(f"error: bank not found: {d}", file=sys.stderr)
                return 1
            bank_dirs.append(d)
    else:
        bank_dirs = discover_banks()

    if not bank_dirs:
        print("No banks found under data/", file=sys.stderr)
        return 1

    print(f"Writing markdown under {out_root}")
    for d in bank_dirs:
        out_path = out_root / f"{d.name}.md"
        try:
            info = convert_bank(d, out_path)
            print(
                f"  {info['bank']}: {info['bytes'] / 1024 / 1024:.2f} MB, "
                f"{info['lines']} lines → {out_path.relative_to(APP_ROOT)}"
            )
        except Exception as e:
            print(f"  FAIL {d.name}: {e}", file=sys.stderr)
            return 1
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
