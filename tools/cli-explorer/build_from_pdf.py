#!/usr/bin/env python3
"""
Offline builder: CLI PDF → JSON for the multi-bank static explorer UI.

Does NOT run in the browser. Requires:
  python3 -m venv .venv && .venv/bin/pip install pymupdf
  place PDFs under source/ (gitignored)

Usage:
  .venv/bin/python build_from_pdf.py --bank aos-cx-10.17
  .venv/bin/python build_from_pdf.py --bank aos-10
  .venv/bin/python build_from_pdf.py --pdf source/foo.pdf --bank my-bank --toc-mode commands
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
SOURCE_DIR = HERE / "source"
DATA_DIR = HERE / "data"

# Known bank presets (local PDFs only — no scraping).
BANK_PRESETS: dict[str, dict] = {
    "aos-cx-10.17": {
        "pdf": "cli_6200.pdf",
        "source": "AOS-CX Command-Line Interface Guide",
        "versionHint": "10.17",
        "sourceNote": "Indexed from the AOS-CX 10.17 CLI PDF (6200 reference guide)",
        "sourceDisclaimer": (
            "Many commands exist across AOS-CX platforms; "
            "confirm model-specific notes in official docs."
        ),
        "tocMode": "nested",
        "label": "AOS-CX 10.17",
        "family": "AOS-CX",
    },
    "aos-10": {
        "pdf": "aos10_cli_guide.pdf",
        "source": "AOS 10.x CLI Reference Guide",
        "versionHint": "10.x",
        "sourceNote": "Indexed from the AOS 10.x CLI reference PDF (local copy)",
        "sourceDisclaimer": "Confirm against current HPE docs for your version.",
        "tocMode": "commands",
        "label": "AOS 10.x",
        "family": "AOS 10",
    },
}

# Footer / noise lines to strip from previews (CX + AOS 10)
NOISE_RE = re.compile(
    r"^(AOS-CX\s+\d|"
    r"AOS10?\s*\||"
    r"AOS\s*10\s*\||"
    r"Chapter\s+\d|"
    r".+\scommands\s*\|\s*\d+|"  # e.g. "LLDP commands | 957"
    r".+\s*\|\s*Reference Guide|"
    r"For more information on features that use this command|"
    r"\d{1,4}\s*$)",
    re.I,
)

SECTION_NAMES = (
    "description",
    "descriptions",
    "example",
    "examples",
    "parameter",
    "parameters",
    "usage",
    "usage guidelines",
    "command history",
    "command information",
    "platforms",
    "authority",
    "related commands",
    "syntax",
)

SECTION_STOP = re.compile(
    r"^(Description|Descriptions|Examples?|Parameters?|Parameter|Usage|"
    r"Usage Guidelines|Command History|Command Information|Platforms|"
    r"Authority|Related Commands|Syntax)\s*$",
    re.I,
)

# TOC titles that are section chrome, not navigable commands
SECTION_TOC_TITLES = {
    "description",
    "descriptions",
    "example",
    "examples",
    "command history",
    "command information",
    "parameter",
    "parameters",
    "usage",
    "usage guidelines",
    "related commands",
    "syntax",
    "power status",
    "mtu guidelines",
}

# Front matter / prose chapters (AOS 10-style books)
FRONT_MATTER_TITLES = {
    "revision history",
    "contacting support",
    "command-line editing",
    "specifying addresses and identifiers in commands",
    "terminology change",
    "accessing the aos 10.x cli",
    "new commands in aos 10.3.1.0",
}


def looks_like_cli_command(title: str) -> bool:
    """
    AOS 10 TOC puts real commands in lowercase (show aaa …) and front matter
    in Title Case. Prefer that signal; also drop known prose headings.
    """
    t = title.strip()
    if not t:
        return False
    low = t.lower()
    if low in SECTION_TOC_TITLES or low in FRONT_MATTER_TITLES:
        return False
    if low.startswith("about ") or low.startswith("what's new") or low.startswith("what’s new"):
        return False
    if low.startswith("example") and len(t) < 40:
        return False
    if low.startswith("executing ") or low.startswith("accessing "):
        return False
    # Title Case multi-word prose
    if " " in t and t[0].isupper() and not t[0:4].lower() == "show":
        # allow ALL-CAPS tokens? rare. Drop Title Case.
        words = t.split()
        if all(w[:1].isupper() for w in words if w[:1].isalpha()):
            return False
    # CLI verbs / lowercase statements
    if re.match(
        r"^(show|clear|aaa|ap|interface|ip|ipv6|crypto|configure|no|copy|"
        r"ping|traceroute|commit|write|reload|banner|hostname|logging|ntp|"
        r"snmp|vlan|vrrp|cluster|airgroup|stm|license|database|local-userdb|"
        r"mgmt-user|user-table|web-server|captive-portal|firewall|acl|"
        r"netdestination|netservice|time-range|wlan|rf|ap-group|ap-name|"
        r"ids|wms|process|memory|version|inventory|clock|activate)\b",
        low,
    ):
        return True
    # lowercase multi-word CLI-looking titles
    if t[0].islower() and " " in t:
        return True
    if t[0].islower() and re.match(r"^[a-z][a-z0-9_-]+$", t):
        return True
    return False


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


def filter_toc(toc: list, mode: str) -> list:
    """
    Normalize / optionally strip section-heading TOC rows.

    nested   — keep full outline (AOS-CX style chapters → commands)
    commands — drop Description/Example/etc. chrome (AOS 10 flat CLI books)
    """
    rows = [(int(level), str(title).strip(), int(page)) for level, title, page in toc]
    if mode == "nested":
        return rows

    if mode != "commands":
        raise ValueError(f"Unknown toc mode: {mode}")

    out = []
    for level, title, page in rows:
        low = title.lower().strip()
        if low in SECTION_TOC_TITLES:
            continue
        if low.startswith("example—") or low.startswith("example-") or low.startswith("example–"):
            continue
        # Example subheads sometimes embed command names; skip those under sections
        if level >= 3 and low.startswith("show ") and " and " in low:
            continue
        if not looks_like_cli_command(title):
            continue
        # Flatten to level-1 leaves — hierarchy is rebuilt by group_flat_by_prefix
        out.append((1, title, page))
    return out


def toc_to_flat(rows: list) -> list[dict]:
    """Flatten filtered TOC into nodes with page ranges and parent links."""
    if not rows:
        return []

    flat = []
    used_slugs: set[str] = set()
    stack: list[dict] = []  # ancestors by level

    for i, (level, title, page) in enumerate(rows):
        next_page = rows[i + 1][2] if i + 1 < len(rows) else None
        end_page = (next_page - 1) if next_page and next_page > page else page

        while stack and stack[-1]["level"] >= level:
            stack.pop()
        parent_id = stack[-1]["id"] if stack else None
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
            "leaf": True,
        }
        if stack:
            stack[-1]["leaf"] = False
        flat.append(node)
        stack.append(node)

    return flat


def group_key_for_command(title: str) -> str:
    """
    Bucket key for flat CLI books. Prefer 'show ap' / 'show datapath' style
    prefixes when everything is a show-command.
    """
    parts = title.strip().split()
    if not parts:
        return "other"
    first = parts[0].lower()
    if first in {"show", "clear", "debug", "no"} and len(parts) >= 2:
        second = parts[1].lower().rstrip("*+")
        return f"{first} {second}"
    return first


def group_flat_by_prefix(flat: list[dict]) -> list[dict]:
    """
    When the book is nearly flat (many L1 commands), bucket leaves under
    a short prefix for a usable tree. Only applies if there are almost no
    real nested parents among command leaves.
    """
    leaves = [n for n in flat if n.get("leaf")]
    non_leaves = [n for n in flat if not n.get("leaf")]
    if non_leaves and len(non_leaves) >= max(3, len(leaves) // 20):
        return flat

    used: set[str] = set()
    groups: dict[str, list[dict]] = {}
    order: list[str] = []
    for n in leaves:
        token = group_key_for_command(n["title"])
        if token not in groups:
            groups[token] = []
            order.append(token)
        groups[token].append(n)

    if len(order) < 2:
        return flat

    new_flat: list[dict] = []
    for token in order:
        kids = groups[token]
        gid = slugify(f"grp-{token}", used)
        gtitle = token
        new_flat.append(
            {
                "id": gid,
                "title": gtitle,
                "level": 1,
                "page": kids[0]["page"],
                "pageEnd": kids[-1]["pageEnd"],
                "parentId": None,
                "chapter": gtitle,
                "leaf": False,
            }
        )
        for kid in kids:
            new_flat.append(
                {
                    **kid,
                    "parentId": gid,
                    "chapter": gtitle,
                    "level": 2,
                    "leaf": True,
                }
            )
    return new_flat


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


def page_layout_text(page: fitz.Page, y_tol: float = 3.0, min_gap: float = 1.15) -> str:
    """
    Reconstruct page text from word bounding boxes so multi-column tables
    keep horizontal alignment (default get_text('text') stacks cells vertically).
    """
    words = page.get_text("words")  # x0, y0, x1, y1, word, block, line, word_no
    if not words:
        return ""

    # Cluster into visual lines by vertical mid-point
    items = sorted(words, key=lambda w: ((w[1] + w[3]) / 2.0, w[0]))
    lines: list[list] = []
    cur: list = []
    cur_y: float | None = None
    for w in items:
        y = (w[1] + w[3]) / 2.0
        if cur_y is None or abs(y - cur_y) <= y_tol:
            cur.append(w)
            cur_y = y if cur_y is None else (cur_y * 0.65 + y * 0.35)
        else:
            lines.append(cur)
            cur = [w]
            cur_y = y
    if cur:
        lines.append(cur)

    widths = [(w[2] - w[0]) / max(len(w[4]), 1) for w in words if w[4].strip()]
    cw = sorted(widths)[len(widths) // 2] if widths else 5.0
    if cw < 2:
        cw = 2.0

    out_lines: list[str] = []
    for line in lines:
        line = sorted(line, key=lambda w: w[0])
        s = ""
        xcursor: float | None = None
        for w in line:
            if xcursor is None:
                s = w[4]
                xcursor = w[2]
                continue
            gap = w[0] - xcursor
            if gap > cw * min_gap:
                nsp = max(1, int(round(gap / cw)))
                s += " " * nsp
            elif not s.endswith(" "):
                s += " "
            s += w[4]
            xcursor = w[2]
        out_lines.append(s.rstrip())
    return "\n".join(out_lines)


def _col_count(ln: str) -> int:
    """Rough column count for layout-aligned lines (2+ spaces as separators)."""
    parts = [p for p in re.split(r"\s{2,}", ln.strip()) if p]
    return len(parts)


def rejoin_soft_wrapped_rows(lines: list[str]) -> list[str]:
    """
    PDF pages often wrap wide CLI tables onto the next visual line:
      Station   User   …   Authenticated By
      Authenticated On
      64:27:…   test1  …   RadServer1
      2014-04-01 01:54

    Rejoin those soft wraps so mono display reads as one row per record.
    """
    out: list[str] = []
    date_line = re.compile(
        r"^\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?(?:\s+\w+)?$"
    )
    # "02-28 18:59 PDT" after a line ending in "2021-"
    date_frag = re.compile(r"^\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?(?:\s+\w+)*$")
    # lone header words / short phrase without digits
    header_cont = re.compile(r"^[A-Za-z][A-Za-z0-9 /_-]{0,40}$")
    dash_only = re.compile(r"^-{3,}$")

    for ln in lines:
        if not out:
            out.append(ln)
            continue
        prev = out[-1]
        s = ln.strip()
        if not s:
            out.append(ln)
            continue

        # Date row continuation under a multi-column data row
        if date_line.match(s) and _col_count(prev) >= 2:
            out[-1] = prev.rstrip() + "  " + s
            continue

        # Split ISO date across lines: "... 2021-" + "02-28 18:59 PDT"
        if re.search(r"\d{4}-$", prev.rstrip()) and date_frag.match(s):
            out[-1] = prev.rstrip() + s
            continue

        # Dash underline continuation ("-----" under last column)
        if dash_only.match(s) and re.search(r"-{3,}", prev) and _col_count(prev) >= 2:
            out[-1] = prev.rstrip() + "  " + s
            continue

        # Header label that wrapped (e.g. "Authenticated On")
        if (
            header_cont.match(s)
            and _col_count(prev) >= 3
            and not re.search(r"\d", s)
            and not line_section_name(s)
            and not s.lower().startswith("command")
            and not s.lower().startswith("total ")
            and len(s.split()) <= 4
            and not prev.rstrip().endswith(".")
        ):
            out[-1] = prev.rstrip() + "  " + s
            continue

        # Short continuation that looks like last-column wrap
        if (
            _col_count(prev) >= 3
            and _col_count(ln) == 1
            and len(s) <= 48
            and not line_section_name(s)
            and not s.lower().startswith("the ")
            and not s.lower().startswith("this ")
            and not s.lower().startswith("command")
            and not s.lower().startswith("total ")
            and not re.match(r"^[a-fA-F0-9]{2}(:[a-fA-F0-9]{2}){5}$", s)
            and not prev.rstrip().endswith((".", ":", ";"))
        ):
            out[-1] = prev.rstrip() + "  " + s
            continue

        out.append(ln)
    return out


def clean_lines(text: str) -> list[str]:
    """
    Drop footer/page-number noise. Preserve internal multi-space padding so
    reconstructed tables stay aligned. Rejoin soft-wrapped table rows.
    """
    lines = []
    for line in text.splitlines():
        s = line.rstrip()
        stripped = s.strip()
        if not stripped:
            if lines and lines[-1] != "":
                lines.append("")
            continue
        if NOISE_RE.search(stripped):
            continue
        if re.fullmatch(r"\d{1,4}", stripped):
            continue
        if re.fullmatch(r"model\.?", stripped, re.I):
            continue
        # Keep left indent modest (drop huge left margin only)
        lines.append(stripped)
    out: list[str] = []
    for s in lines:
        if s == "" and out and out[-1] == "":
            continue
        out.append(s)
    return rejoin_soft_wrapped_rows(out)


def page_text(doc: fitz.Document, page_1based: int, page_end_1based: int) -> str:
    start = max(0, page_1based - 1)
    end = min(doc.page_count - 1, max(page_1based, page_end_1based) - 1)
    # allow one page past end — multi-command pages often spill
    end = min(doc.page_count - 1, end + 1)
    parts = []
    for pno in range(start, end + 1):
        parts.append(page_layout_text(doc.load_page(pno)))
    return "\n".join(parts)


def extract_page_tables(doc: fitz.Document, page_1based: int, page_end_1based: int) -> list[list[list[str]]]:
    """Structured tables via PyMuPDF table finder (Parameters, Command History, …)."""
    start = max(0, page_1based - 1)
    end = min(doc.page_count - 1, max(page_1based, page_end_1based) - 1)
    end = min(doc.page_count - 1, end + 1)
    tables: list[list[list[str]]] = []
    for pno in range(start, end + 1):
        page = doc.load_page(pno)
        try:
            found = page.find_tables()
        except Exception:
            continue
        tab_list = getattr(found, "tables", None) or list(found)
        for tab in tab_list:
            try:
                raw = tab.extract()
            except Exception:
                continue
            if not raw or len(raw) < 2:
                continue
            cleaned = []
            for row in raw:
                cleaned.append([("" if c is None else str(c).strip()) for c in row])
            # skip empty / single-cell junk
            if any(any(c for c in row) for row in cleaned):
                tables.append(cleaned)
    return tables


def classify_tables(tables: list[list[list[str]]]) -> dict[str, list[list[str]]]:
    """Pick Parameters and Command History tables when headers match."""
    out: dict[str, list[list[str]]] = {}
    for tab in tables:
        header = " ".join(tab[0]).lower()
        if "parameter" in header and "description" in header and "paramRows" not in out:
            out["paramRows"] = tab
        elif (
            ("version" in header and "modification" in header)
            or ("command history" in header)
        ) and "historyRows" not in out:
            out["historyRows"] = tab
        elif "platform" in header and "platformsRows" not in out:
            out["platformsRows"] = tab
    return out


def line_section_name(ln: str) -> str | None:
    """
    Detect section headers, including layout-merged two-column headers like
    'Parameters          Description'.
    """
    s = ln.strip()
    if not s:
        return None
    low = s.lower()
    if low in SECTION_NAMES:
        return low
    # multi-space split (layout columns)
    parts = re.split(r"\s{2,}", s)
    if parts and parts[0].lower() in SECTION_NAMES:
        return parts[0].lower()
    # single-space: "Parameters Description" as TOC-like header row
    first = low.split(None, 1)[0] if low.split() else ""
    if first in SECTION_NAMES and len(s) < 48:
        rest = low[len(first) :].strip()
        if not rest or rest in SECTION_NAMES:
            return first
    return None


def find_title_index(lines: list[str], title: str) -> int:
    t = title.strip()
    t_low = t.lower()
    for i, ln in enumerate(lines):
        stripped = ln.strip()
        if stripped == t or stripped.lower() == t_low:
            return i
    compact = re.sub(r"\s+", "", t_low)
    for i, ln in enumerate(lines):
        if re.sub(r"\s+", "", ln.strip().lower()) == compact:
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

    stops = {t.strip() for t in next_titles if t and t.strip() != title.strip()}
    stops_low = {s.lower() for s in stops}

    end = len(lines)
    for j in range(start + 1, len(lines)):
        ln = lines[j].strip()
        if ln in stops or ln.lower() in stops_low:
            end = j
            break
    return lines[start:end]


def section_body(block: list[str], header: str) -> str:
    """
    Text after a section header until the next known section.
    Keeps layout-aligned header rows like 'Parameters    Description'.
    """
    hdr = header.lower()
    start = None
    include_header_row = False
    for i, ln in enumerate(block):
        sec = line_section_name(ln)
        if sec == hdr or ln.strip().lower() == hdr:
            start = i + 1
            # Dual-column layout header — keep the line for mono table display
            if len(re.split(r"\s{2,}", ln.strip())) >= 2:
                include_header_row = True
                start = i
            break
    if start is None:
        return ""

    parts: list[str] = []
    for offset, ln in enumerate(block[start:]):
        if offset == 0 and include_header_row:
            parts.append(ln)
            continue
        sec = line_section_name(ln)
        if sec and sec != hdr:
            break
        if SECTION_STOP.match(ln.strip()) and ln.strip().lower() != hdr:
            break
        if ln.strip().lower().startswith("for more information on features"):
            break
        if re.fullmatch(r"model\.?", ln.strip(), re.I):
            break
        parts.append(ln)
    while parts and parts[-1] == "":
        parts.pop()
    while parts and parts[0] == "":
        parts.pop(0)
    return "\n".join(parts).strip()


def parse_command_block(block: list[str], title: str) -> dict:
    """Parse command section layout into structured fields (CX + AOS 10-ish)."""
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
    syntax_lines = []
    i = 0
    # Skip exact title heading lines; a repeated title is often the syntax line
    while i < len(block) and block[i].strip().lower() == t_low:
        if i > 0:
            syntax_lines.append(block[i])
        i += 1
    while i < len(block):
        ln = block[i]
        if line_section_name(ln) in {
            "description",
            "descriptions",
            "example",
            "examples",
            "parameter",
            "parameters",
            "usage",
            "usage guidelines",
            "command history",
            "command information",
        }:
            break
        low = ln.strip().lower()
        if low.startswith("no ") or "<" in ln or (
            t_low.split() and low.startswith(t_low.split()[0])
        ):
            syntax_lines.append(ln)
        elif not syntax_lines and ln.strip():
            syntax_lines.append(ln)
        i += 1

    if not syntax_lines:
        syntax_lines = [title]
    dedup = []
    for s in syntax_lines:
        if not dedup or dedup[-1] != s:
            dedup.append(s)
    pos = [s for s in dedup if not s.lower().startswith("no ")]
    neg = [s for s in dedup if s.lower().startswith("no ")]
    fields["syntax"] = "\n".join(pos) if pos else title
    fields["syntaxNo"] = "\n".join(neg)

    desc = section_body(block, "Description") or section_body(block, "Descriptions")
    if desc:
        fields["description"] = re.sub(r"[ \t]+", " ", desc.replace("\n", " ")).strip()
        fields["description"] = re.sub(r"\s{2,}", " ", fields["description"])

    ex = section_body(block, "Examples") or section_body(block, "Example")
    if ex:
        fields["examples"] = ex

    params = section_body(block, "Parameter") or section_body(block, "Parameters")
    if params:
        fields["parameters"] = params

    usage = section_body(block, "Usage") or section_body(block, "Usage Guidelines")
    if usage:
        fields["usage"] = re.sub(r"\s+", " ", usage.replace("\n", " ")).strip()

    try:
        ci = block.index("Command Information")
        tail = block[ci : ci + 12]
        if "All platforms" in tail:
            fields["platforms"] = "All platforms"
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

    preview = "\n".join(block)
    if len(preview) > 1200:
        preview = preview[:1199].rstrip() + "…"
    fields["preview"] = preview
    return fields


def sibling_titles(flat: list[dict], index: int) -> list[str]:
    titles = []
    page = flat[index]["page"]
    for j in range(index + 1, min(len(flat), index + 40)):
        titles.append(flat[j]["title"])
        if flat[j]["page"] > page + 2:
            break
    return titles


def write_catalog(banks_on_disk: list[dict] | None = None) -> None:
    """Refresh data/catalog.json from presets + existing data folders."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    existing_ids = set()
    banks: list[dict] = []

    # Prefer known presets in stable order when their data dir exists
    for bank_id, preset in BANK_PRESETS.items():
        bank_dir = DATA_DIR / bank_id
        if not (bank_dir / "tree.json").is_file():
            continue
        existing_ids.add(bank_id)
        banks.append(
            {
                "id": bank_id,
                "label": preset.get("label", bank_id),
                "family": preset.get("family", ""),
                "versionHint": preset.get("versionHint", ""),
                "default": bank_id == "aos-cx-10.17" or (not banks and True),
                "dataPath": f"data/{bank_id}",
            }
        )

    # Discover extra banks not in presets
    if DATA_DIR.is_dir():
        for child in sorted(DATA_DIR.iterdir()):
            if not child.is_dir() or child.name in existing_ids:
                continue
            if not (child / "tree.json").is_file():
                continue
            meta_path = child / "meta.json"
            label = child.name
            family = ""
            version = ""
            if meta_path.is_file():
                try:
                    m = json.loads(meta_path.read_text(encoding="utf-8"))
                    label = m.get("label") or m.get("source") or label
                    family = m.get("family") or ""
                    version = m.get("versionHint") or ""
                except json.JSONDecodeError:
                    pass
            banks.append(
                {
                    "id": child.name,
                    "label": label,
                    "family": family,
                    "versionHint": version,
                    "default": not banks,
                    "dataPath": f"data/{child.name}",
                }
            )

    # Ensure exactly one default
    if banks and not any(b.get("default") for b in banks):
        banks[0]["default"] = True
    defaults = [b for b in banks if b.get("default")]
    if len(defaults) > 1:
        for b in banks[1:]:
            b["default"] = False
        banks[0]["default"] = True

    catalog = {"banks": banks}
    path = DATA_DIR / "catalog.json"
    path.write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {path} ({len(banks)} bank(s))")


def build(
    pdf_path: Path,
    out_dir: Path,
    preview_chars: int,
    skip_preview: bool,
    toc_mode: str,
    meta_extra: dict,
) -> None:
    if not pdf_path.is_file():
        print(f"PDF not found: {pdf_path}", file=sys.stderr)
        print(f"Place the CLI guide under {SOURCE_DIR}/", file=sys.stderr)
        sys.exit(1)

    print(f"Opening {pdf_path} …")
    print(f"  out={out_dir}  toc_mode={toc_mode}")
    doc = fitz.open(pdf_path)
    page_count = doc.page_count
    raw_toc = doc.get_toc(simple=True)
    rows = filter_toc(raw_toc, toc_mode)
    print(f"  pages={page_count}  toc_raw={len(raw_toc)}  toc_kept={len(rows)}")

    flat = toc_to_flat(rows)
    if toc_mode == "commands":
        flat = group_flat_by_prefix(flat)
    tree = flat_to_tree(flat)

    text_cache: dict[tuple[int, int], list[str]] = {}
    table_cache: dict[tuple[int, int], list[list[list[str]]]] = {}
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
                table_cache[key] = extract_page_tables(doc, n["page"], n["pageEnd"])
            lines = text_cache[key]
            block = slice_command_block(lines, n["title"], sibling_titles(flat, i))
            fields = parse_command_block(block, n["title"])
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

            # Structured tables (when PDF table finder succeeds)
            classified = classify_tables(table_cache.get(key, []))
            if classified.get("paramRows"):
                entry["paramRows"] = classified["paramRows"]
            if classified.get("historyRows"):
                entry["historyRows"] = classified["historyRows"]
        entries[n["id"]] = entry
        if (i + 1) % 200 == 0:
            print(f"  processed {i + 1}/{len(flat)} …")

    doc.close()

    out_dir.mkdir(parents=True, exist_ok=True)
    meta = {
        "source": meta_extra.get("source") or "CLI Guide",
        "label": meta_extra.get("label") or out_dir.name,
        "family": meta_extra.get("family") or "",
        "versionHint": meta_extra.get("versionHint") or "",
        "sourceNote": meta_extra.get("sourceNote") or f"Indexed from {pdf_path.name}",
        "sourceDisclaimer": meta_extra.get("sourceDisclaimer") or "",
        "pdfFile": pdf_path.name,
        "tocMode": toc_mode,
        "pageCount": page_count,
        "tocCount": len(flat),
        "leafCount": sum(1 for n in flat if n["leaf"]),
        "previewChars": 0 if skip_preview else preview_chars,
        "bankId": out_dir.name,
    }

    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    (out_dir / "tree.json").write_text(
        json.dumps({"tree": tree}, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    (out_dir / "entries.json").write_text(
        json.dumps(entries, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )

    print(f"Wrote {out_dir / 'meta.json'}")
    print(f"Wrote {out_dir / 'tree.json'} ({(out_dir / 'tree.json').stat().st_size // 1024} KB)")
    print(f"Wrote {out_dir / 'entries.json'} ({(out_dir / 'entries.json').stat().st_size // 1024} KB)")
    write_catalog()
    print("Done.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--bank",
        type=str,
        default=None,
        help="Bank id (e.g. aos-cx-10.17, aos-10). Sets defaults for PDF/out/meta.",
    )
    ap.add_argument("--pdf", type=Path, default=None, help="Path to CLI PDF")
    ap.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Output directory (default: data/<bank>)",
    )
    ap.add_argument(
        "--toc-mode",
        choices=("nested", "commands"),
        default=None,
        help="nested=full outline (CX); commands=strip section TOC rows (AOS 10)",
    )
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
    ap.add_argument(
        "--catalog-only",
        action="store_true",
        help="Only refresh data/catalog.json from existing bank folders",
    )
    args = ap.parse_args()

    if args.catalog_only:
        write_catalog()
        return

    preset: dict = {}
    bank = args.bank
    if bank and bank in BANK_PRESETS:
        preset = dict(BANK_PRESETS[bank])
    elif bank is None and args.pdf is None:
        bank = "aos-cx-10.17"
        preset = dict(BANK_PRESETS[bank])

    pdf = args.pdf
    if pdf is None:
        pdf_name = preset.get("pdf", "cli_6200.pdf")
        pdf = SOURCE_DIR / pdf_name
    pdf = pdf.resolve() if not pdf.is_absolute() else pdf
    # Allow relative paths from CWD as well as from tool dir
    if not pdf.is_file():
        alt = (HERE / args.pdf) if args.pdf else None
        if alt and alt.is_file():
            pdf = alt.resolve()
        elif not pdf.is_file() and (SOURCE_DIR / Path(str(args.pdf or "")).name).is_file():
            pdf = (SOURCE_DIR / Path(str(args.pdf)).name).resolve()

    out = args.out
    if out is None:
        if bank:
            out = DATA_DIR / bank
        else:
            out = DATA_DIR / "custom"
    else:
        out = out if out.is_absolute() else (HERE / out)
    out = out.resolve()

    toc_mode = args.toc_mode or preset.get("tocMode") or "nested"
    meta_extra = {
        "source": preset.get("source"),
        "label": preset.get("label") or bank or out.name,
        "family": preset.get("family") or "",
        "versionHint": preset.get("versionHint") or "",
        "sourceNote": preset.get("sourceNote") or "",
        "sourceDisclaimer": preset.get("sourceDisclaimer") or "",
    }

    build(pdf, out, args.preview_chars, args.skip_preview, toc_mode, meta_extra)


if __name__ == "__main__":
    main()
