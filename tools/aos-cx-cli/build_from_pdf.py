#!/usr/bin/env python3
"""
Offline builder: AOS-CX CLI PDF → JSON for the static explorer UI.

Does NOT run in the browser. Requires:
  python3 -m venv .venv && .venv/bin/pip install pymupdf
  place CLI PDF at source/cli_6200.pdf (gitignored)

Usage:
  .venv/bin/python build_from_pdf.py
  .venv/bin/python build_from_pdf.py --pdf /path/to/cli.pdf --preview-chars 600
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:
    print("PyMuPDF required:  .venv/bin/pip install pymupdf", file=sys.stderr)
    sys.exit(1)

HERE = Path(__file__).resolve().parent
DEFAULT_PDF = HERE / "source" / "cli_6200.pdf"
DATA_DIR = HERE / "data"

# Footer / noise lines to strip from previews
NOISE_RE = re.compile(
    r"^(AOS-CX\s+\d|Chapter\s+\d|Service OS CLI commands\s*\||"
    r"For more information on features that use this command|"
    r"\d{1,4}\s*$)",
    re.I,
)


def slugify(title: str, used: set[str]) -> str:
    base = re.sub(r"[^a-zA-Z0-9]+", "-", title.strip().lower()).strip("-")
    if not base:
        base = "item"
    base = base[:80]
    slug = base
    n = 2
    while slug in used:
        slug = f"{base}-{n}"
        n += 1
    used.add(slug)
    return slug


def toc_to_flat(toc: list) -> list[dict]:
    """Flatten PDF TOC into nodes with page ranges and parent links."""
    if not toc:
        return []

    # Normalize: [level, title, page]
    rows = [(int(level), str(title).strip(), int(page)) for level, title, page in toc]
    flat = []
    used_slugs: set[str] = set()
    stack: list[dict] = []  # ancestors by level

    for i, (level, title, page) in enumerate(rows):
        # page range: until next entry's page (inclusive start)
        next_page = rows[i + 1][2] if i + 1 < len(rows) else None
        end_page = (next_page - 1) if next_page and next_page > page else page

        while stack and stack[-1]["level"] >= level:
            stack.pop()
        parent_id = stack[-1]["id"] if stack else None
        # chapter = nearest level-1 ancestor title
        chapter = ""
        for a in reversed(stack):
            if a["level"] == 1:
                chapter = a["title"]
                break
        if level == 1:
            chapter = title

        node = {
            "id": slugify(title, used_slugs),
            "title": title,
            "level": level,
            "page": page,
            "pageEnd": max(page, end_page),
            "parentId": parent_id,
            "chapter": chapter,
            "leaf": True,  # set false if children appear
        }
        if stack:
            stack[-1]["leaf"] = False
        flat.append(node)
        stack.append(node)

    return flat


def flat_to_tree(flat: list[dict]) -> list[dict]:
    by_id = {n["id"]: {**n, "children": []} for n in flat}
    roots = []
    for n in flat:
        node = by_id[n["id"]]
        pid = n["parentId"]
        if pid and pid in by_id:
            by_id[pid]["children"].append(node)
        else:
            roots.append(node)
    # drop empty children arrays on leaves for smaller JSON
    def prune(nodes):
        out = []
        for n in nodes:
            item = {
                "id": n["id"],
                "title": n["title"],
                "page": n["page"],
                "pageEnd": n["pageEnd"],
                "chapter": n.get("chapter", ""),
                "leaf": n.get("leaf", not n["children"]),
            }
            if n["children"]:
                item["leaf"] = False
                item["children"] = prune(n["children"])
            out.append(item)
        return out

    return prune(roots)


def clean_preview(text: str, max_chars: int) -> str:
    lines = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            if lines and lines[-1] != "":
                lines.append("")
            continue
        if NOISE_RE.search(s):
            continue
        if re.fullmatch(r"\d{1,4}", s):
            continue
        lines.append(s)
    body = "\n".join(lines).strip()
    # collapse excessive blank lines
    body = re.sub(r"\n{3,}", "\n\n", body)
    if len(body) > max_chars:
        body = body[: max_chars - 1].rstrip() + "…"
    return body


def extract_preview(doc: fitz.Document, page: int, page_end: int, max_chars: int) -> str:
    # page numbers in TOC are 1-based
    start = max(0, page - 1)
    end = min(doc.page_count - 1, page_end - 1)
    parts = []
    for pno in range(start, min(end, start + 2) + 1):  # at most 3 pages for preview
        parts.append(doc.load_page(pno).get_text("text"))
    return clean_preview("\n".join(parts), max_chars)


def parse_fields(preview: str, title: str) -> dict:
    """Light heuristics for Description / syntax lines — best-effort for v1."""
    fields = {"syntax": "", "description": ""}
    if not preview:
        return fields

    # First non-empty line often repeats the command name / syntax
    lines = [ln for ln in preview.splitlines() if ln.strip()]
    if not lines:
        return fields

    # Prefer a line that looks like syntax (contains title token or < >)
    title_tok = title.split()[0].lower() if title else ""
    for ln in lines[:8]:
        low = ln.lower()
        if title_tok and title_tok in low and len(ln) < 200:
            fields["syntax"] = ln
            break
        if "<" in ln and ">" in ln and len(ln) < 200:
            fields["syntax"] = ln
            break
    if not fields["syntax"] and lines:
        # sometimes command name alone then syntax
        if len(lines) > 1 and lines[0].lower() == title.lower():
            fields["syntax"] = lines[1] if len(lines) > 1 else lines[0]
        else:
            fields["syntax"] = lines[0]

    # Description section
    m = re.search(
        r"(?is)\bDescription\b\s*(.+?)(?=\b(?:Example|Parameter|Usage|Command History|Command Information)\b|$)",
        preview,
    )
    if m:
        desc = re.sub(r"\s+", " ", m.group(1)).strip()
        fields["description"] = desc[:800] + ("…" if len(desc) > 800 else "")
    return fields


def build(pdf_path: Path, preview_chars: int, skip_preview: bool) -> None:
    if not pdf_path.is_file():
        print(f"PDF not found: {pdf_path}", file=sys.stderr)
        print("Place the CLI guide at tools/aos-cx-cli/source/cli_6200.pdf", file=sys.stderr)
        sys.exit(1)

    print(f"Opening {pdf_path} …")
    doc = fitz.open(pdf_path)
    page_count = doc.page_count
    toc = doc.get_toc(simple=True)
    print(f"  pages={page_count}  toc_entries={len(toc)}")

    flat = toc_to_flat(toc)
    tree = flat_to_tree(flat)

    entries: dict[str, dict] = {}
    for i, n in enumerate(flat):
        entry = {
            "id": n["id"],
            "title": n["title"],
            "page": n["page"],
            "pageEnd": n["pageEnd"],
            "chapter": n["chapter"],
            "leaf": n["leaf"],
            "parentId": n["parentId"],
        }
        if not skip_preview and n["leaf"]:
            preview = extract_preview(doc, n["page"], n["pageEnd"], preview_chars)
            fields = parse_fields(preview, n["title"])
            entry["preview"] = preview
            entry["syntax"] = fields["syntax"]
            entry["description"] = fields["description"]
        entries[n["id"]] = entry
        if (i + 1) % 200 == 0:
            print(f"  processed {i + 1}/{len(flat)} …")

    doc.close()

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    meta = {
        "source": "AOS-CX Command-Line Interface Guide",
        "productLine": "6200 Switch Series",
        "versionHint": "10.17",
        "pdfFile": pdf_path.name,
        "pageCount": page_count,
        "tocCount": len(flat),
        "leafCount": sum(1 for n in flat if n["leaf"]),
        "previewChars": 0 if skip_preview else preview_chars,
    }

    (DATA_DIR / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    (DATA_DIR / "tree.json").write_text(
        json.dumps({"tree": tree}, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    (DATA_DIR / "entries.json").write_text(
        json.dumps(entries, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )

    print(f"Wrote {DATA_DIR / 'meta.json'}")
    print(f"Wrote {DATA_DIR / 'tree.json'} ({(DATA_DIR / 'tree.json').stat().st_size // 1024} KB)")
    print(f"Wrote {DATA_DIR / 'entries.json'} ({(DATA_DIR / 'entries.json').stat().st_size // 1024} KB)")
    print("Done.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pdf", type=Path, default=DEFAULT_PDF)
    ap.add_argument(
        "--preview-chars",
        type=int,
        default=900,
        help="Max characters of page text per leaf (0 with --skip-preview)",
    )
    ap.add_argument(
        "--skip-preview",
        action="store_true",
        help="Only build tree/meta (fast); no page text extraction",
    )
    args = ap.parse_args()
    build(args.pdf, args.preview_chars, args.skip_preview)


if __name__ == "__main__":
    main()
