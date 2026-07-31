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
    r"^(AOS-CX\s+\d|"
    r"Chapter\s+\d|"
    r".+\scommands\s*\|\s*\d+|"  # e.g. "LLDP commands | 957"
    r"For more information on features that use this command|"
    r"\d{1,4}\s*$)",
    re.I,
)

SECTION_STOP = re.compile(
    r"^(Description|Examples?|Parameters?|Parameter|Usage|Command History|"
    r"Command Information|Platforms|Authority)\s*$",
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


def clean_lines(text: str) -> list[str]:
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
        # orphaned wrap from "…for your switch / model."
        if re.fullmatch(r"model\.?", s, re.I):
            continue
        lines.append(s)
    # collapse blank runs
    out: list[str] = []
    for s in lines:
        if s == "" and out and out[-1] == "":
            continue
        out.append(s)
    return out


def page_text(doc: fitz.Document, page_1based: int, page_end_1based: int) -> str:
    start = max(0, page_1based - 1)
    end = min(doc.page_count - 1, max(page_1based, page_end_1based) - 1)
    # allow one page past end_page — multi-command pages often spill
    end = min(doc.page_count - 1, end + 1)
    parts = []
    for pno in range(start, end + 1):
        parts.append(doc.load_page(pno).get_text("text"))
    return "\n".join(parts)


def find_title_index(lines: list[str], title: str) -> int:
    """Index of the command heading line (exact, then fuzzy)."""
    t = title.strip()
    t_low = t.lower()
    for i, ln in enumerate(lines):
        if ln == t or ln.lower() == t_low:
            return i
    # PDF sometimes drops spaces / soft hyphens
    compact = re.sub(r"\s+", "", t_low)
    for i, ln in enumerate(lines):
        if re.sub(r"\s+", "", ln.lower()) == compact:
            return i
    return -1


def slice_command_block(
    lines: list[str], title: str, next_titles: list[str]
) -> list[str]:
    """
    Isolate one command's section: from its title until the next sibling
    command title (or end). Critical when several commands share a PDF page.
    """
    start = find_title_index(lines, title)
    if start < 0:
        return []

    # Build stop set of next titles (exact lines that begin a new command)
    stops = {t.strip() for t in next_titles if t and t.strip() != title.strip()}
    stops_low = {s.lower() for s in stops}

    end = len(lines)
    for j in range(start + 1, len(lines)):
        ln = lines[j]
        if ln in stops or ln.lower() in stops_low:
            end = j
            break
        # also stop if we hit a line that is exactly another known short command heading
        # after Command Information block often ends before next title
    block = lines[start:end]

    # Drop leading duplicate title lines (heading often printed twice)
    while len(block) >= 2 and block[0].lower() == block[1].lower():
        # keep one as potential syntax if identical; handled in parse
        break
    return block


def section_body(block: list[str], header: str) -> str:
    """Text after a section header until the next known section header."""
    hdr = header.lower()
    start = None
    for i, ln in enumerate(block):
        if ln.lower() == hdr:
            start = i + 1
            break
    if start is None:
        return ""
    parts = []
    for ln in block[start:]:
        if SECTION_STOP.match(ln) and ln.lower() != hdr:
            break
        if ln.lower().startswith("for more information on features"):
            break
        if re.fullmatch(r"model\.?", ln, re.I):
            break
        parts.append(ln)
    # trim trailing empties
    while parts and parts[-1] == "":
        parts.pop()
    while parts and parts[0] == "":
        parts.pop(0)
    return "\n".join(parts).strip()


def parse_command_block(block: list[str], title: str) -> dict:
    """Parse AOS-CX command section layout into structured fields."""
    fields = {
        "syntax": "",
        "syntaxNo": "",
        "description": "",
        "examples": "",
        "parameters": "",
        "usage": "",
        "context": "",
        "authority": "",
        "platforms": "",
        "preview": "",
    }
    if not block:
        return fields

    t_low = title.strip().lower()
    # Syntax lines: after title heading(s), before Description
    syntax_lines = []
    i = 0
    # skip exact title repeats
    while i < len(block) and block[i].strip().lower() == t_low:
        i += 1
    # if first line was title only once, it may still be syntax when next is Description
    # re-scan from 0: collect lines until Description
    i = 0
    while i < len(block) and block[i].strip().lower() == t_low:
        # first title line is heading; second identical line is often syntax
        if i > 0:
            syntax_lines.append(block[i])
        i += 1
    while i < len(block):
        ln = block[i]
        if ln.lower() in (
            "description",
            "examples",
            "example",
            "parameter",
            "parameters",
            "usage",
            "command history",
            "command information",
        ):
            break
        # no-form syntax
        if ln.lower().startswith("no ") or "<" in ln or ln.lower().startswith(t_low.split()[0]):
            syntax_lines.append(ln)
        elif not syntax_lines and ln:
            syntax_lines.append(ln)
        i += 1

    # Prefer non-title-only syntax; if only title, use it
    if not syntax_lines:
        syntax_lines = [title]
    # de-dupe consecutive
    dedup = []
    for s in syntax_lines:
        if not dedup or dedup[-1] != s:
            dedup.append(s)
    # split no-form if present
    pos = [s for s in dedup if not s.lower().startswith("no ")]
    neg = [s for s in dedup if s.lower().startswith("no ")]
    fields["syntax"] = "\n".join(pos) if pos else title
    fields["syntaxNo"] = "\n".join(neg)

    desc = section_body(block, "Description")
    if desc:
        fields["description"] = re.sub(r"[ \t]+", " ", desc.replace("\n", " ")).strip()
        fields["description"] = re.sub(r"\s{2,}", " ", fields["description"])

    ex = section_body(block, "Examples") or section_body(block, "Example")
    if ex:
        fields["examples"] = ex

    params = section_body(block, "Parameter") or section_body(block, "Parameters")
    if params:
        fields["parameters"] = params

    usage = section_body(block, "Usage")
    if usage:
        fields["usage"] = re.sub(r"\s+", " ", usage.replace("\n", " ")).strip()

    # Command Information table is often:
    # Command Information
    # Platforms / Command context / Authority  (header row)
    # All platforms / config / Administrators...
    try:
        ci = block.index("Command Information")
        # look for values after header labels
        tail = block[ci : ci + 12]
        # find line after "Platforms" "Command context" "Authority"
        for j, ln in enumerate(tail):
            if ln.lower() == "platforms" and j + 1 < len(tail):
                # sometimes three headers then three values
                pass
        joined = "\n".join(tail)
        # Common pattern: headers on one "line" split across lines then values
        if "All platforms" in tail:
            fields["platforms"] = "All platforms"
        # context: Manager (#), config, ServiceOS, etc.
        for ln in tail:
            low = ln.lower()
            if low in ("platforms", "command context", "authority", "command information"):
                continue
            if "administrator" in low or "operator" in low or "execution rights" in low:
                fields["authority"] = (fields["authority"] + " " + ln).strip()
            elif any(
                x in low
                for x in (
                    "config",
                    "manager",
                    "operator",
                    "serviceos",
                    "svos",
                    "global",
                    "interface",
                )
            ) and "execution" not in low:
                if not fields["context"] and len(ln) < 80:
                    fields["context"] = ln
    except ValueError:
        pass

    # Compact preview of the isolated block
    preview = "\n".join(block)
    if len(preview) > 1200:
        preview = preview[:1199].rstrip() + "…"
    fields["preview"] = preview
    return fields


def sibling_titles(flat: list[dict], index: int) -> list[str]:
    """Titles that can appear after this entry on the same/nearby pages."""
    titles = []
    page = flat[index]["page"]
    # next ~40 TOC entries are enough to bound a page of commands
    for j in range(index + 1, min(len(flat), index + 40)):
        titles.append(flat[j]["title"])
        # once we've moved several pages past, stop
        if flat[j]["page"] > page + 2:
            break
    return titles


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

    # Cache cleaned page text by page range key to speed multi-cmd pages
    text_cache: dict[tuple[int, int], list[str]] = {}

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
            key = (n["page"], n["pageEnd"])
            if key not in text_cache:
                raw = page_text(doc, n["page"], n["pageEnd"])
                text_cache[key] = clean_lines(raw)
            lines = text_cache[key]
            block = slice_command_block(lines, n["title"], sibling_titles(flat, i))
            fields = parse_command_block(block, n["title"])
            # If we failed to find the title, fall back to whole cleaned page (rare)
            if not block:
                fields = parse_command_block(lines, n["title"])
                if not fields["description"] and not fields["syntax"]:
                    preview = "\n".join(lines)
                    if len(preview) > preview_chars:
                        preview = preview[: preview_chars - 1] + "…"
                    fields["preview"] = preview
                    fields["syntax"] = n["title"]

            entry["syntax"] = fields["syntax"]
            if fields.get("syntaxNo"):
                entry["syntaxNo"] = fields["syntaxNo"]
            entry["description"] = fields["description"]
            if fields.get("examples"):
                entry["examples"] = fields["examples"]
            if fields.get("parameters"):
                entry["parameters"] = fields["parameters"]
            if fields.get("usage"):
                entry["usage"] = fields["usage"]
            if fields.get("context"):
                entry["context"] = fields["context"]
            if fields.get("authority"):
                entry["authority"] = fields["authority"]
            if fields.get("platforms"):
                entry["platforms"] = fields["platforms"]
            entry["preview"] = fields.get("preview") or ""
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
