#!/usr/bin/env python3
"""Parse one MadCap Flare CLI-Bank command topic into explorer fields.

CLI-Bank pages are not HPESC DITA. Typical shape::

    <h1 class="cmd">show ap active</h1>
    <p class="CLI">show ap active</p>
    <h2>Description</h2>
    <h2>Example</h2>
    <div class="screen"><p class="CLI">…</p><p class="Output">…</p></div>
    <h2>Command History</h2>
    <table>…</table>
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Tuple

from html_topic import (
    H1_RE,
    html_to_text,
    parse_tables,
    strip_tags,
)

FLARE_H2_RE = re.compile(r"<h2\b[^>]*>(.*?)</h2>", re.I | re.S)
CLI_P_RE = re.compile(
    r'<p class="(?:CLI|Output)"[^>]*>(.*?)</p>',
    re.I | re.S,
)
MADCAP_RE = re.compile(r"</?MadCap:[^>]*>", re.I)
FOOTER_RE = re.compile(r'<div class="footer\b', re.I)
H1_CMD_RE = re.compile(
    r'<h1\b[^>]*class="[^"]*\bcmd\b[^"]*"[^>]*>',
    re.I,
)
ENTRY_RE = re.compile(
    r"'(/Content/[^']+)'\s*:\s*\{([^}]*)\}",
    re.S,
)
TITLE_RE = re.compile(r"t:\s*\[(.*?)\]", re.S)
INDEX_RE = re.compile(r"i:\s*\[(.*?)\]")
STR_RE = re.compile(r"'(.*?)'")


def topic_body(page_html: str) -> str:
    """Trim Flare chrome; keep from the command <h1> through the topic footer."""
    html = MADCAP_RE.sub("", page_html or "")
    m = H1_CMD_RE.search(html)
    if not m:
        m = re.search(r"<h1\b", html, re.I)
    start = m.start() if m else 0
    rest = html[start:]
    cut = FOOTER_RE.search(rest)
    if cut:
        rest = rest[: cut.start()]
    return rest


def split_flare_sections(html: str) -> Tuple[str, Dict[str, str]]:
    parts = FLARE_H2_RE.split(html or "")
    preamble = parts[0] if parts else ""
    sections: Dict[str, str] = {}
    i = 1
    while i + 1 < len(parts):
        title = re.sub(r"\s+", " ", html_to_text(parts[i])).strip().lower()
        if title:
            sections[title] = parts[i + 1]
        i += 2
    return preamble, sections


def _section(sections: Dict[str, str], *names: str) -> str:
    for n in names:
        if n in sections:
            return sections[n]
    return ""


def cli_lines(chunk: str) -> str:
    """Keep Flare CLI/Output paragraphs, including column padding."""
    lines: List[str] = []
    for raw in CLI_P_RE.findall(chunk or ""):
        line = strip_tags(raw, br_to=" ").replace("\n", " ")
        lines.append(line.rstrip())
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


def parse_toc_chunk(js: str) -> List[Dict[str, Any]]:
    """MadCap ``define({ '/Content/…': {i:[n], t:['title'], b:['']} })``."""
    text = (js or "").strip()
    if text.startswith("\ufeff"):
        text = text[1:]
    if text.lstrip().startswith("<"):
        return []
    m = re.search(r"define\((\{.*\})\)\s*;?\s*$", text, re.S)
    if not m:
        return []
    body = m.group(1)
    out: List[Dict[str, Any]] = []
    for em in ENTRY_RE.finditer(body):
        path, inner = em.group(1), em.group(2)
        title = ""
        tm = TITLE_RE.search(inner)
        if tm:
            strs = STR_RE.findall(tm.group(1))
            title = strs[0].strip() if strs else ""
        idx = None
        im = INDEX_RE.search(inner)
        if im:
            nums = re.findall(r"\d+", im.group(1))
            idx = int(nums[0]) if nums else None
        out.append({"path": path, "title": title, "index": idx})
    return out


def group_title(command: str) -> str:
    """``show aaa authentication …`` → ``show aaa`` (CLI-Bank second-word index)."""
    toks = (command or "").split()
    if len(toks) >= 2 and toks[0].lower() == "show":
        return "show " + toks[1]
    return toks[0] if toks else command


def parse_flare_topic(page_html: str) -> Dict[str, Any]:
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

    body = topic_body(page_html)
    h1 = H1_RE.search(body)
    if h1:
        fields["title"] = re.sub(r"\s+", " ", html_to_text(h1.group(1))).strip()

    preamble, sections = split_flare_sections(body)

    syn = cli_lines(preamble)
    if not syn and fields["title"]:
        syn = fields["title"]
    fields["syntax"] = syn

    desc = html_to_text(_section(sections, "description", "descriptions"))
    desc = re.sub(r"\s+", " ", desc).strip()
    fields["description"] = desc

    param_html = _section(sections, "parameter", "parameters")
    tables = parse_tables(param_html)
    for tab in tables:
        header = " ".join(tab[0]).lower()
        if "parameter" in header:
            fields["paramRows"] = tab
            fields["parameters"] = "\n".join("\t".join(r) for r in tab)
            break
    if not fields["parameters"] and param_html:
        fields["parameters"] = html_to_text(param_html)

    ex_html = _section(sections, "example", "examples")
    fields["examples"] = cli_lines(ex_html) or html_to_text(ex_html)

    usage_html = _section(sections, "usage", "usage guidelines")
    if usage_html:
        fields["usage"] = re.sub(r"\s+", " ", html_to_text(usage_html)).strip()

    hist_html = _section(sections, "command history")
    for tab in parse_tables(hist_html):
        header = " ".join(tab[0]).lower()
        if "release" in header or "modification" in header or "version" in header:
            fields["historyRows"] = tab
            break

    preview = html_to_text(body)
    if len(preview) > 1200:
        preview = preview[:1199].rstrip() + "…"
    fields["preview"] = preview
    return fields
