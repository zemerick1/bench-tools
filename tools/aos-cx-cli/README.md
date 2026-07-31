# AOS-CX CLI Explorer

Searchable hierarchy of the AOS-CX CLI guide (6200 series), Juniper CLI Explorer–style.

## Data pipeline (offline)

The browser only loads JSON under `data/`. You rebuild from the PDF on your machine:

```bash
cd tools/aos-cx-cli
python3 -m venv .venv
.venv/bin/pip install pymupdf
# place official PDF here (gitignored):
#   source/cli_6200.pdf
.venv/bin/python build_from_pdf.py
```

Outputs:

| File | Purpose |
|------|---------|
| `data/meta.json` | Version / counts |
| `data/tree.json` | Hierarchy from PDF bookmarks |
| `data/entries.json` | Per-node page range + text preview |

Fast tree-only build (no page text):

```bash
.venv/bin/python build_from_pdf.py --skip-preview
```

## UI

Open `/tools/aos-cx-cli/` (via `python3 -m http.server` from repo root).

## Notes

- Unofficial helper; PDF structure drives quality.
- Do not commit the multi‑MB PDF or `.venv/`.
- Check HPE doc license before redistributing large derived text dumps publicly if needed.
