# CLI Explorer

Searchable browser for Aruba/HPE CLI guides (AOS-CX and AOS 10).

## How data is produced

1. **Acquire** the official CLI PDF for a product / version / switch series.
2. **Extract** commands into structured JSON (`tree` + `entries`) for the UI.
3. **Interpolate** shared commands across platforms for the same train so the
   data shown to users stays much smaller than shipping every full guide alone.

The web app only serves static HTML/JS and the JSON under `data/`. Offline
tooling lives in `scripts/` (repo only — not part of the product UI).

## Using the app

Open `/tools/cli-explorer/` from the site root.

Pick **Product** → for AOS-CX also **Version** and **Switch series**, or just
**AOS 10**. Filter the tree and open a command.

## Offline tooling (`scripts/`)

Run from `tools/cli-explorer/` with a local venv:

```bash
python3 -m venv .venv
.venv/bin/pip install pymupdf

# PDF → JSON bank
.venv/bin/python scripts/build_from_pdf.py \
  --pdf source/your-guide.pdf \
  --bank aos-cx-10.18-6200 \
  --out data/aos-cx-10.18-6200 \
  --toc-mode nested

# Shared vs per-platform packs (same version)
.venv/bin/python scripts/diff_banks.py --group aos-cx-10.18 --match core \
  --bank 6100=data/aos-cx-10.18-6100 \
  --bank 6200=data/aos-cx-10.18-6200

# Refresh data/catalog.json after adding banks
.venv/bin/python scripts/build_from_pdf.py --catalog-only

# Optional: export banks to Markdown
.venv/bin/python scripts/banks_to_markdown.py --bank aos-cx-10.18-6200
```

PDFs go in `source/` (gitignored). Generated JSON under `data/` is what the
site uses. Markdown exports default to `markdown/` (also gitignored).
