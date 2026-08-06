# CLI Explorer

Searchable browser for Aruba/HPE CLI guides (AOS-CX and AOS 10).

## How data is produced

1. **Acquire** the official CLI PDF for a product / version / switch series.
2. **Extract** commands into structured JSON (`tree` + `entries`) for the UI.
3. **Interpolate** shared commands across platforms for the same train into
   `data/layers/` (common + per-platform deltas). The browser merges those at
   load time so we do not ship every full bank.

The web app serves static HTML/JS, `data/catalog.json`, layered packs under
`data/layers/`, and AOS 10 under `data/aos-10/`. Offline tooling lives in
`scripts/` (repo only — not part of the product UI).

## Using the app

Open `/tools/cli-explorer/` from the site root.

Pick **Product** → for AOS-CX also **Version** and **Switch series**, or just
**AOS 10**. Filter the tree and open a command.

### Why “Raw extracted block” exists

HPE would rather we not scrape their pretty web docs, so we don’t. We take the
official PDFs they *do* publish, run them through a PDF parser, and hope for the
best. PDF-to-text is not an exact science: columns wander, tables get creative,
and the occasional line looks like it lost a fight with a photocopier.

The structured fields (syntax, description, examples) are our best guess at a
clean view. **Raw extracted block** is the unvarnished page text we pulled for
that command—kept so you can still see what the PDF actually said when the
pretty fields are incomplete, weird, or slightly haunted. When in doubt, trust
the official PDF over our optimism.

## Offline tooling (`scripts/`)

Run from `tools/cli-explorer/` with a local venv:

```bash
python3 -m venv .venv
.venv/bin/pip install pymupdf

# PDF → JSON bank (keep full builds in full-banks/, not data/)
.venv/bin/python scripts/build_from_pdf.py \
  --pdf source/your-guide.pdf \
  --bank aos-cx-10.18-cli_6200 \
  --out full-banks/aos-cx-10.18-cli_6200 \
  --toc-mode nested

# Shared vs per-platform packs (same version) → data/layers/
.venv/bin/python scripts/diff_banks.py --group aos-cx-10.18 --match core \
  --bank cli_6200=full-banks/aos-cx-10.18-cli_6200 \
  --bank cli_6300-6400=full-banks/aos-cx-10.18-cli_6300-6400

# Build catalog from layered packs (what the UI uses)
.venv/bin/python scripts/build_catalog.py
# Optional: drop pre-10.13 from the catalog
# .venv/bin/python scripts/build_catalog.py --min-version 10.13

# Optional: export full banks to Markdown (needs full banks on disk)
.venv/bin/python scripts/banks_to_markdown.py --bank aos-cx-10.18-cli_6200
```

PDFs go in `source/` (gitignored). Full per-platform banks from
`build_from_pdf` should live in `full-banks/` (gitignored) so long builds are
kept locally without bloating the repo. **Ship `data/layers/` + `catalog.json`**
(and `data/aos-10/`). Markdown exports default to `markdown/` (gitignored).
