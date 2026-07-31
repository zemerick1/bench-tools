# CLI Explorer

Searchable multi-platform CLI hierarchy (Juniper CLI Explorer–style) for
Aruba/HPE guides. Each **bank** is a static JSON pack under `data/<bank>/`.

Current presets:

| Bank | PDF (local) | Notes |
|------|-------------|--------|
| `aos-cx-10.17` | `source/cli_6200.pdf` | AOS-CX nested outline |
| `aos-10` | `source/aos10_cli_guide.pdf` | AOS 10 flat commands (section TOC stripped) |

PDFs are **not** scraped from the web — place your own copies in `source/`
(gitignored).

## Data pipeline (offline)

```bash
cd tools/cli-explorer
python3 -m venv .venv
.venv/bin/pip install pymupdf

# AOS-CX (already built if data/aos-cx-10.17/ exists)
.venv/bin/python build_from_pdf.py --bank aos-cx-10.17

# AOS 10
.venv/bin/python build_from_pdf.py --bank aos-10

# Tree only (fast)
.venv/bin/python build_from_pdf.py --bank aos-10 --skip-preview

# Refresh catalog.json from folders on disk
.venv/bin/python build_from_pdf.py --catalog-only
```

Outputs per bank:

| File | Purpose |
|------|---------|
| `data/<bank>/meta.json` | Version / counts / labels |
| `data/<bank>/tree.json` | Hierarchy from PDF bookmarks |
| `data/<bank>/entries.json` | Per-node page range + text preview |
| `data/catalog.json` | Platform list for the UI selector |

## UI

Open `/tools/cli-explorer/` (via `python3 -m http.server` from repo root).
Use the **Platform** dropdown to switch banks.

## Notes

- Unofficial helper; PDF structure drives quality.
- Do not commit multi‑MB PDFs or `.venv/`.
- Check HPE doc license before redistributing large derived text dumps publicly if needed.
