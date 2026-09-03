#!/usr/bin/env python3
"""Parse one HPESC DITA-OT command topic (page_html) into explorer fields."""

from __future__ import annotations

import html as htmlmod
import re
from typing import Any, Dict, List, Tuple

H1_RE = re.compile(r"<h1\b[^>]*>(.*?)</h1>", re.I | re.S)
H2_RE = re.compile(
    r'<h2 class="title sectiontitle">(.*?)</h2>',
    re.I | re.S,
)
TABLE_RE = re.compile(r"<table\b[^>]*>(.*?)</table>", re.I | re.S)
TR_RE = re.compile(r"<tr\b[^>]*>(.*?)</tr>", re.I | re.S)
CELL_RE = re.compile(r"<t[dh]\b[^>]*>(.*?)</t[dh]>", re.I | re.S)
CODE_RE = re.compile(r"<code\b[^>]*>(.*?)</code>", re.I | re.S)
BR_RE = re.compile(r"<br\s*/?>", re.I)
TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"[ \t]+")
BLANK_RE = re.compile(r"\n{3,}")

# PDF/HTML mixed unicode hyphens → ASCII
HYPHEN_RE = re.compile(r"[\u2010\u2011\u2012\u2013\u2212]")


def _norm_hyphens(s: str) -> str:
    return HYPHEN_RE.sub("-", s)


def strip_tags(chunk: str, br_to: str = "\n") -> str:
    t = BR_RE.sub(br_to, chunk or "")
    t = TAG_RE.sub("", t)
    t = htmlmod.unescape(t)
    t = t.replace("\xa0", " ").replace("\u00a0", " ")
    t = _norm_hyphens(t)
    return t


def cell_text(chunk: str) -> str:
    t = strip_tags(chunk, br_to=" ")
    t = WS_RE.sub(" ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def html_to_text(chunk: str) -> str:
    t = chunk or ""
    t = re.sub(r"</(p|div|h[1-6]|tr|table|section|li|pre)>", "\n", t, flags=re.I)
    t = re.sub(r"<li\b[^>]*>", "\n- ", t, flags=re.I)
    t = strip_tags(t, br_to="\n")
    lines = [WS_RE.sub(" ", ln).strip() for ln in t.splitlines()]
    out: List[str] = []
    blank = False
    for ln in lines:
        if not ln:
            if out and not blank:
                out.append("")
            blank = True
        else:
            out.append(ln)
            blank = False
    return "\n".join(out).strip()


def parse_tables(chunk: str) -> List[List[List[str]]]:
    tables: List[List[List[str]]] = []
    for tbl in TABLE_RE.findall(chunk or ""):
        rows: List[List[str]] = []
        for tr in TR_RE.findall(tbl):
            cells = [cell_text(c) for c in CELL_RE.findall(tr)]
            if any(cells):
                rows.append(cells)
        if len(rows) >= 2:
            tables.append(rows)
    return tables


def code_blocks(chunk: str) -> List[str]:
    """Innermost <code> bodies, preserving CLI line breaks."""
    out: List[str] = []
    for raw in CODE_RE.findall(chunk or ""):
        # Skip tiny inline codeph used as emphasis inside prose if it has no br
        # and is very short — still useful in syntax sections, so keep all.
        t = strip_tags(raw, br_to="\n")
        lines = [WS_RE.sub(" ", ln).rstrip() for ln in t.split("\n")]
        # strip leading/trailing empty
        while lines and not lines[0].strip():
            lines.pop(0)
        while lines and not lines[-1].strip():
            lines.pop()
        block = "\n".join(lines).strip("\n")
        if block:
            out.append(block)
    return out


def split_sections(page_html: str) -> Tuple[str, Dict[str, str]]:
    """Return (preamble including h1, {section_title_lower: html})."""
    parts = H2_RE.split(page_html or "")
    preamble = parts[0] if parts else ""
    sections: Dict[str, str] = {}
    i = 1
    while i + 1 < len(parts):
        title = html_to_text(parts[i])
        body = parts[i + 1]
        key = re.sub(r"\s+", " ", title).strip().lower()
        if key:
            sections[key] = body
        i += 2
    return preamble, sections


def _section(sections: Dict[str, str], *names: str) -> str:
    for n in names:
        if n in sections:
            return sections[n]
    return ""


def split_syntax(text: str) -> Tuple[str, str]:
    """Positive forms vs `no …` lines."""
    pos: List[str] = []
    neg: List[str] = []
    for ln in (text or "").splitlines():
        if re.match(r"^no\s+\S", ln.strip(), re.I):
            neg.append(ln.rstrip())
        else:
            pos.append(ln.rstrip())
    while pos and not pos[0].strip():
        pos.pop(0)
    while pos and not pos[-1].strip():
        pos.pop()
    return "\n".join(pos).strip(), "\n".join(neg).strip()


_PORTAL_NOTE_RE = re.compile(
    r"^for more information on features that use this command",
    re.I,
)


def examples_text(chunk: str) -> str:
    """Keep caption paragraphs + CLI blocks in document order."""
    if not chunk:
        return ""
    tokens = re.finditer(
        r"<(p|pre)\b[^>]*>(.*?)</\1>",
        chunk,
        re.I | re.S,
    )
    parts: List[str] = []
    last_was_code = False
    for m in tokens:
        tag = m.group(1).lower()
        body = m.group(2)
        if tag == "p":
            txt = html_to_text(body)
            if not txt or _PORTAL_NOTE_RE.match(txt):
                continue
            if parts and last_was_code:
                parts.append("")
            parts.append(txt)
            last_was_code = False
        else:
            for b in code_blocks(m.group(0)):
                b = b.strip()
                if not b:
                    continue
                parts.append(b)
                last_was_code = True
    text = "\n".join(parts).strip()
    text = BLANK_RE.sub("\n\n", text)
    return text


def parse_command_info(tables: List[List[List[str]]]) -> Dict[str, str]:
    out = {"platforms": "", "context": "", "authority": ""}
    for tab in tables:
        header = [c.lower() for c in tab[0]]
        joined = " ".join(header)
        if "platform" not in joined:
            continue
        row = tab[1] if len(tab) > 1 else []
        # map columns
        def col(*needles: str) -> str:
            for i, h in enumerate(header):
                if any(n in h for n in needles):
                    return row[i] if i < len(row) else ""
            return ""

        out["platforms"] = col("platform")
        out["context"] = col("context")
        out["authority"] = col("authority")
        break
    return out


def parse_topic_html(page_html: str) -> Dict[str, Any]:
    """
    Structured fields matching build_from_pdf.parse_command_block, plus tables.
    """
    fields: Dict[str, Any] = {
        "title": "",
        "syntax": "",
        "syntaxNo": "",
        "description": "",
        "examples": "",
        "parameters": "",
        "paramRows": [],
        "usage": "",
        "context": "",
        "authority": "",
        "platforms": "",
        "historyRows": [],
        "preview": "",
    }
    if not page_html:
        return fields

    h1 = H1_RE.search(page_html)
    if h1:
        fields["title"] = html_to_text(h1.group(1))

    _preamble, sections = split_sections(page_html)

    syn_html = _section(sections, "syntax")
    codes = code_blocks(syn_html)
    # Syntax section often repeats the command name as a tiny codeph in h2;
    # keep blocks that look like CLI (newline or the title token).
    title_l = (fields["title"] or "").lower()
    syn_blocks = []
    for b in codes:
        if "\n" in b or (title_l and title_l in b.lower()) or len(b) > 24:
            syn_blocks.append(b)
    if not syn_blocks:
        syn_blocks = codes
    syntax_joined = "\n".join(syn_blocks).strip()
    pos, neg = split_syntax(syntax_joined)
    fields["syntax"] = pos or syntax_joined or fields["title"]
    fields["syntaxNo"] = neg

    desc_html = _section(sections, "description", "descriptions")
    # prose before the parameter table
    before_table = desc_html
    tpos = re.search(r"<table\b", desc_html or "", re.I)
    if tpos:
        before_table = desc_html[: tpos.start()]
    desc = html_to_text(before_table)
    desc = re.sub(r"\s+", " ", desc).strip()
    fields["description"] = desc
    if not fields["description"]:
        # Prose topics (application notes, error strings) have no Description h2
        body = html_to_text(page_html)
        lines = [
            ln
            for ln in body.splitlines()
            if ln and ln.lower() != (fields["title"] or "").lower()
        ]
        fields["description"] = re.sub(r"\s+", " ", " ".join(lines[:8])).strip()[:800]

    tables = parse_tables(desc_html) or parse_tables(_section(sections, "parameter", "parameters"))
    for tab in tables:
        header = " ".join(tab[0]).lower()
        if "parameter" in header and "description" in header:
            fields["paramRows"] = tab
            # also a plain-text fallback
            lines = ["\t".join(r) for r in tab]
            fields["parameters"] = "\n".join(lines)
            break
    if not fields["parameters"]:
        param_html = _section(sections, "parameter", "parameters")
        if param_html:
            fields["parameters"] = html_to_text(param_html)

    fields["examples"] = examples_text(_section(sections, "examples", "example"))

    usage_html = _section(sections, "usage", "usage guidelines")
    if usage_html:
        fields["usage"] = re.sub(r"\s+", " ", html_to_text(usage_html)).strip()

    hist_html = _section(sections, "command history")
    for tab in parse_tables(hist_html):
        header = " ".join(tab[0]).lower()
        if "release" in header or "modification" in header or "version" in header:
            fields["historyRows"] = tab
            break

    info_html = _section(sections, "command information")
    info = parse_command_info(parse_tables(info_html))
    fields.update(info)

    preview = html_to_text(page_html)
    if len(preview) > 1200:
        preview = preview[:1199].rstrip() + "…"
    fields["preview"] = preview
    return fields
