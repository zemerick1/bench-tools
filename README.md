# Bench Tools

A small, slightly informal hub of static utilities for lab nights, cert headaches, and ClearPass Access Tracker archaeology.

**Static HTML/CSS/JS.** No Node, no build step. Works locally and deploys as a folder (nginx, Caddy, etc.).

> Keep secrets local. Tools that touch keys or session dumps run in the browser; nothing is required to call a backend.

## Quick start

```bash
git clone https://github.com/zemerick1/bench-tools.git
cd bench-tools
python3 -m http.server 8080
# http://localhost:8080
```

## What’s on the bench

| Tool | What it does |
|------|----------------|
| **CSR Generator** | Key + CSR in the browser (RSA / ECDSA, SANs) |
| **Cert Assembler** | Key + cert + chain → ordered PEMs or PKCS#12 (PFX/P12) |
| **MAC / OUI Lookup** | Parse MACs, randomized-MAC hint, offline OUI vendor |
| **Hardware Platform Support** | Aruba AOS-10/Instant matrix + Juniper EX/QFX/AP Pathfinder |
| **Central Alerts & Insights** | Searchable Aruba Central alert / insight catalog |
| **Access Tracker Translator** | ClearPass session export → sticky-note story + why |
| **CLI Explorer** | AOS-CX 10.13.x–10.18.x (per switch series) + AOS 10 CLI hierarchy from local PDF TOC |

## Structure

```
bench-tools/
├── index.html
├── assets/
│   ├── css/styles.css
│   ├── js/tools.js              # Landing-page tool registry
│   └── vendor/                  # jsrsasign, forge (see vendor/README.md)
├── tools/
│   ├── csr-generator/
│   ├── cert-assembler/
│   ├── mac-lookup/
│   ├── hardware-platform-support/
│   ├── central-alerts/
│   ├── access-tracker/
│   │   ├── decoder.js
│   │   ├── radius-dict.json
│   │   ├── update_radius_dict.py
│   │   └── dictionaries/        # ClearPass RadiusDictionary XML sources
│   └── cli-explorer/            # AOS-CX 10.13.x–10.18.x + AOS 10
│       ├── index.html / app.js
│       ├── scripts/             # Offline PDF → layers pipeline (not web UI)
│       ├── data/                # catalog.json, layers/, aos-10/
│       ├── full-banks/          # Local full extracts only (gitignored)
│       └── source/              # Local CLI PDFs only (gitignored)
├── docs/                        # Ideas / design notes
└── README.md
```

## Adding a tool

1. Put it under `tools/<tool-id>/`.
2. Register a card in `assets/js/tools.js`.
3. Prefer zero build steps and no secrets in the repo.

## Tool notes

### CSR Generator

- Key + CSR created **in the browser** (vendored [jsrsasign](https://github.com/kjur/jsrsasign))
- RSA / ECDSA, SANs, optional subject fields
- Live equivalent OpenSSL commands

Private keys never leave the tab — there is no generation backend.

### Cert Assembler

- Key + leaf + CA chain → separate PEM files or PKCS#12 (PFX/P12)
- Fullchain / PKCS#12 order: **server (end-entity) first**, then intermediates as pasted (root last when required — e.g. ClearPass-style packs)
- Optional passphrase add/remove
- Uses vendored [forge](https://github.com/digitalbazaar/forge) in the browser

### Access Tracker Translator

- Unzip `DashboardDetails.zip`, then drop the session folder (or pick the three files)
- Reads `Dashboard_Details.txt` + optional `Request_Logs.html` / `Service_Config.xml`
- Summary: accept/reject, who / where / how, Tips roles (internal), full output attributes
- **Why**: service rules, role mapping, ClearPass-style enforcement policy table
- Distinguishes Tips roles vs on-the-wire AVPs (Aruba-User-Role, Filter-Id, VLAN tunnels, etc.)
- RADIUS dictionaries (IETF, Aruba, HPE, Juniper) for enum labels and attribute metadata

Rebuild dictionaries after dropping new ClearPass XML exports into `tools/access-tracker/dictionaries/`:

```bash
python3 tools/access-tracker/update_radius_dict.py
```

### Central Alerts & Insights

- Static searchable catalog under `tools/central-alerts/`
- Refresh from Central API with `update_catalog.py` (stdlib only) — see that folder’s README
- Put secrets in `credentials.local.json` or env vars (**gitignored**)

### Hardware Platform Support / MAC Lookup

- Data files ship with the tool; maintainer refresh scripts live alongside each tool
- Juniper EX / QFX / Mist APs: `tools/hardware-platform-support/update_juniper.py` (merges Pathfinder catalog into `platforms.json` without rewriting Aruba rows)

### CLI Explorer

Searchable, hierarchical browser for Aruba/HPE CLI reference guides (Juniper CLI Explorer–style). The UI only loads static JSON; PDFs stay on your machine.

| Product | What’s indexed |
|---------|----------------|
| **AOS-CX 10.13.x – 10.18.x** | Nested TOC from the official per-series CLI PDFs (layered common + platform packs for each software train) |
| **AOS 10.x** | AOS 10 controller/gateway CLI reference PDF |

- Pick **Product → Version → Switch series** for AOS-CX (or product alone for AOS 10)
- Catalog + layered packs (`data/catalog.json`, `data/layers/`, `data/aos-10/`)
- Tree filter, command detail (syntax, description, parameters, examples, raw extract)
- Offline extract pipeline under `tools/cli-explorer/scripts/` (not part of the public UI)
- Unofficial helper — always defer to current HPE docs for production decisions

Rebuild / layer after placing official PDFs under `tools/cli-explorer/source/` (gitignored):

```bash
cd tools/cli-explorer
python3 -m venv .venv
.venv/bin/pip install pymupdf
# PDF → full bank (keep under full-banks/, gitignored)
.venv/bin/python scripts/build_from_pdf.py \
  --pdf source/your-guide.pdf \
  --bank aos-cx-10.18-cli_6200 \
  --out full-banks/aos-cx-10.18-cli_6200 \
  --toc-mode nested
# Shared vs per-platform layers for one train → data/layers/
.venv/bin/python scripts/diff_banks.py --group aos-cx-10.18 --match core \
  --bank cli_6200=full-banks/aos-cx-10.18-cli_6200 \
  --bank cli_6300-6400=full-banks/aos-cx-10.18-cli_6300-6400
.venv/bin/python scripts/build_catalog.py
```

See [tools/cli-explorer/README.md](./tools/cli-explorer/README.md) for the full pipeline and ship surface.

## Deploy

Point nginx or Caddy at this directory over HTTPS. No application runtime.

## License

See [LICENSE](./LICENSE). Vendored libraries under `assets/vendor/` keep their own licenses (see `assets/vendor/README.md`).
