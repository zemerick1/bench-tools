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
| **Cert Assembler** | Key + cert + chain → PEMs or PFX/P12 |
| **MAC / OUI Lookup** | Parse MACs, randomized-MAC hint, offline OUI vendor |
| **Hardware Platform Support** | AOS-10 first/last support matrix + release notes |
| **Central Alerts & Insights** | Searchable Aruba Central alert / insight catalog |
| **Access Tracker Translator** | ClearPass session export → sticky-note story + why |
| **AOS-CX CLI Explorer** | Searchable hierarchy of the 6200 CLI guide (from PDF TOC) |

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
│   └── access-tracker/
│       ├── decoder.js
│       ├── radius-dict.json
│       ├── update_radius_dict.py
│       └── dictionaries/        # ClearPass RadiusDictionary XML sources
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

- Key + leaf + chain → Apache/Nginx PEMs or PFX/P12
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

## Deploy

Point nginx or Caddy at this directory over HTTPS. No application runtime.

## License

See [LICENSE](./LICENSE). Vendored libraries under `assets/vendor/` keep their own licenses (see `assets/vendor/README.md`).
