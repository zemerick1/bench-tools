# OpenAPI Documentation Pipeline — Plan

## Goal

Add a static OpenAPI documentation tool to bench-tools that can browse multiple HPE/Aruba API specs without ever loading a 17+ MB document into a browser viewer.

The pipeline is:

**Fetch per-source specs → split by feature with `$ref` closure → validate → commit slices + manifest → Cloudflare deploys**

Work locally while building. When the pipeline is deterministic and the slices stay under budget, a GitHub Action fetches, splits, validates, and commits the published JSON. Cloudflare Pages/Workers then deploys whatever is in the repo (`wrangler.jsonc` publishes the repo root as static assets).

The browser never parses a master specification during normal use.

## Constraints of this repo

bench-tools is static HTML/CSS/JS. No Node, no frontend build step. Tools live under `tools/<id>/` with their own refresh scripts. There is no root `scripts/` tree and no existing `.github/workflows/`.

CLI Explorer is the template:

- Offline generator next to the tool
- Small catalog/manifest for navigation
- Split data files the browser actually loads
- Heavy source artifacts stay out of git
- Site chrome from `assets/css/styles.css`

This tool follows that pattern. The ripped CentralMind files are a starting point, not a package we import.

## Starting point — adapt the ripped `spec_*` scripts

The files in `tools/open-api/` came from CentralMind. They already do most of the fetch/index/resolve work. They still assume they are `python -m centralmind.spec_*` and write to `<repo>/spec/`. Adapt them in place for this tool. Do not keep them working as a CentralMind package.

### `spec_fetcher.py` — keep discovery, change the product artifact

Keep:

- ReadMe SuperHub `ssr-props` discovery
- Fetch-by-uuid from `dash.readme.com/api/v1/api-registry/<uuid>`
- Project registry (`new-central`, `new-central-config`, `cppm`, `aoscx`, `uxi`)
- Retry / UA / SSL handling (useful on a laptop; harmless in Actions)
- `_looks_like_oas` and per-definition fetch

Change:

- Plain script under `tools/open-api/scripts/`, not `centralmind.spec_fetcher`
- Default output to `tools/open-api/source/` (gitignored), not `<repo>/spec/`
- **Write each uploaded definition as its own file.** Do not merge MRT + Config into one `central.json` on the docs path. The natural first split is already project → uploaded definition.
- Preserve provenance per file: project slug, ReadMe filename, registry uuid, upstream `info.title` / `info.version`, fetch time
- Stop stamping `info.version` to `1.0.0`
- `merge_specs()` can remain as an optional helper (for a one-off full download). It is not the input to the splitter.
- `--resolve` is not part of the docs pipeline

`httpx` stays. Pin it in `tools/open-api/scripts/requirements.txt`. The rest of this repo prefers stdlib; this fetch is the exception.

### `spec_resolver.py` — keep, do not run on the master

Do **not** resolve a whole spec before splitting. Expanding `$ref`s first makes a large document substantially larger.

Keep the resolver for optional local inspection and, later, for debugging a single slice. It only understands local `#/` refs, which is also the contract the splitter should enforce.

### `spec_indexer.py` — harvest ideas, replace the artifact

Do not generate the LLM tool-description text (“write a JS async arrow function”).

Reuse:

- Operation counting
- Tag-prefix grouping (`Orgs Devices` → scope + category)
- Theme-keyword seeds (Wireless, Monitoring, Switching, …)

Replace the output with the documentation manifest described below.

### New scripts

| Script | Role |
|--------|------|
| `spec_splitter.py` | Group operations, compute `$ref` closure, write one OpenAPI file per group |
| `spec_validate.py` | JSON / structure / local `$ref` / empty-doc checks; fail closed |
| `spec_manifest.py` | Build `data/manifest.json` (+ operation index) from splitter stats |

A thin `build.py` (or a documented sequence of the scripts above) is the one command humans and Actions both run.

## Architecture

```text
Upstream OpenAPI (ReadMe SuperHub)
        |
        v
Adapted spec_fetcher
        |
        v
Per-definition source specs          (gitignored)
  source/aruba-central/mrt/*.json
  source/aruba-central/config/*.json
  source/clearpass/*.json
  source/aos-cx/*.json
  source/uxi/*.json
        |
        v
Dependency-aware splitter
        |
        +------------------+
        |                  |
        v                  v
specs/<api>/<group>.json   data/manifest.json
  (committed)                (committed)
        |                  |
        +---------+--------+
                  |
                  v
        tools/open-api/ UI
                  |
                  v
     Cloudflare static deploy
```

Split hierarchy, coarsest first:

1. **API / project** (Central, ClearPass, AOS-CX, UXI)
2. **Uploaded definition** (MRT vs Config, or whatever ReadMe published)
3. **Tag / configured group** — only if that definition is still over budget
4. **Second cut** (path prefix or operation-count chunks) — only if a single tag is still over budget

Do not merge everything into one canonical 17 MB file and then carve it back apart.

## Layout

Keep the existing tool id `open-api`. User-facing title can be “OpenAPI Docs”.

```text
tools/open-api/
├── index.html
├── app.js
├── docs/
│   └── openapi-docs-plan.md
├── scripts/
│   ├── requirements.txt          # httpx (+ later validator extra if needed)
│   ├── spec_fetcher.py           # adapted
│   ├── spec_splitter.py          # new
│   ├── spec_validate.py          # new
│   ├── spec_manifest.py          # new
│   ├── spec_resolver.py          # kept, not on the docs path
│   ├── spec_indexer.py           # grouping helpers only
│   ├── grouping.yaml             # optional editorial overlay
│   └── build.py                  # fetch → split → manifest → validate
├── data/
│   └── manifest.json             # committed; what the UI loads first
├── specs/
│   ├── aruba-central/
│   ├── clearpass/
│   ├── aos-cx/
│   └── uxi/
└── source/                       # gitignored canonical pulls
```

Repo-level additions later:

```text
.github/workflows/update-openapi-docs.yml
assets/js/tools.js                # register the card when the UI is usable
```

Separation of concerns:

- `tools/open-api/` — UI + generator + published slices
- `source/` — fetch cache, not shipped
- `.github/workflows/` — the only new top-level automation

## What is committed vs gitignored

Cloudflare deploys the git tree. Commit only what the browser needs.

| Path | Git | Why |
|------|-----|-----|
| `specs/**/*.json` | commit | What the viewer loads |
| `data/manifest.json` | commit | Navigation + search index |
| `source/` | gitignore | 17 MB+ raw pulls; CI fetches fresh |
| `*.resolved.json` | gitignore | Not used by the docs path |

Generation timestamps belong in the manifest, not inside every spec file. Spec JSON must be byte-stable (sorted keys, stable tag order) so “commit only when output changed” is real.

Expect the committed slice tree to land in the 5–20 MB range once Central is fully split. That is acceptable for this deploy path. It is not acceptable to also commit the unsplit master.

## Dependency-aware splitter

The new component. It:

1. Loads one source OpenAPI document (one uploaded definition).
2. Enumerates operations (path + HTTP method).
3. Assigns each operation to a group (tag, then `grouping.yaml`, then `"uncategorized"`).
4. Collects the dependency closure: schemas, responses, parameters, request bodies, headers, examples, callbacks, links, path-level parameters, `allOf` / `oneOf` / `anyOf` / `not`, discriminator mappings, security schemes.
5. Follows local `$ref`s (`#/…`) recursively, including JSON Pointer escaping (`~1`, `~0`).
6. Writes a smaller valid OpenAPI document with those paths + required components.
7. Copies `info`, `servers`, used tags, and used `securitySchemes` into every slice so a viewer can render it alone.
8. Leaves `$ref`s intact inside the slice.
9. Emits deterministic JSON.
10. Emits stats: path count, operation count, schema count, byte size, unresolved refs, unassigned ops.

Do not copy every schema into every file. Each slice gets only its closure. Small duplication of common schemas is fine.

Multi-tag operations: **first tag wins**. Do not duplicate an operation into every matching group.

Circular `$ref`s: keep the `$ref` (do not expand). The existing resolver already detects these; the splitter should tolerate them.

### Size budget (Phase 1 pass/fail)

“Manageable” is a number, otherwise the experiment cannot fail.

| Check | Threshold |
|-------|-----------|
| Published slice size | **Target ≤ 500 KB**, warn above that — do not split CRUD to chase the number |
| Operations per slice | **Target ≤ 200**; if over, pack by **path** so GET/POST/PUT/PATCH/DELETE stay together |
| Unresolved local `$ref` | **Hard fail** |
| Empty `paths` / invalid JSON | **Hard fail** |
| Unassigned operations | Warn; they still ship under `uncategorized` |

A tag is one resource. Second-cut only when path prefixes are different families (or when there are more than 200 operations). Never emit one file per HTTP method — shared schemas mean that does not shrink the document, and it hides the rest of the API.

## Grouping

Automatic first. `grouping.yaml` is an optional overlay that maps tags / path prefixes / `operationId` patterns onto a nicer tree. Anything unmapped still publishes.

Example overlay (illustrative — real groups come from the specs):

```text
Monitoring
  Access Points
  Clients
  Devices
  Gateways
  Sites
Wireless
  AirMatch
  AirGroup
  WLAN
  Location
Switching
  CX Switches
  Interfaces
  VLAN
Administration
  Jobs
  Firmware
  Webhooks
```

Central’s tags look like `Orgs Devices` / `Sites WLANs`. The indexer already splits those into scope + category. Use that before inventing editorial names.

## Documentation manifest

The UI loads only this file on first paint. Suggested shape:

```json
{
  "generatedAt": "2026-08-13T00:00:00Z",
  "apis": [
    {
      "id": "aruba-central",
      "title": "HPE Aruba Networking Central",
      "source": { "slug": "new-central", "version": "…" },
      "groups": [
        {
          "id": "clients",
          "title": "Clients",
          "category": "Monitoring",
          "spec": "specs/aruba-central/clients.json",
          "operations": 42,
          "bytes": 180234,
          "sourceFile": "source/aruba-central/mrt/….json"
        }
      ]
    }
  ],
  "operations": [
    {
      "api": "aruba-central",
      "group": "clients",
      "method": "get",
      "path": "/network-monitoring/v1alpha1/clients",
      "operationId": "ListClients",
      "summary": "List clients",
      "tag": "Clients"
    }
  ]
}
```

The `operations` array is the search index. Phase 5 must not grep OpenAPI files in the browser.

## Documentation UI

Static page under `tools/open-api/`, same header/footer as the other tools.

First load: manifest only.

Show:

- Supported APIs
- Categories / groups
- Endpoint counts
- File size and last generated time

Selecting a group fetches **that group’s spec only** into the viewer.

**Viewer decision:** Scalar (`@scalar/api-reference` from jsDelivr, version-pinned). Load one generated slice at a time via a same-origin URL. Do not send specs or try-it-out traffic through `proxy.scalar.com`. Disable Scalar Agent (do not upload OpenAPI to a third party). Try-it-out is best-effort against the cluster URL in the spec — the user supplies their own token; CORS may still block it. Deep-link which slice is open with a query string (`?s=…`) so Scalar can keep the URL hash for operations.

Register a card in `assets/js/tools.js` when the UI can render at least Central slices.

Disclaimer, same spirit as CLI Explorer: unofficial helper, HPE’s published docs win, specs can be stale between scheduled pulls.

## Validation

Run before any commit (local or CI):

- Valid JSON
- Has `openapi` / `swagger` and a non-empty `paths`
- HTTP methods are real methods
- Every local `$ref` in the slice exists
- Required components for the selected operations are present
- Reject empty or broken documents

A proper OpenAPI validator (`openapi-spec-validator` or similar) is a nice extra, not a substitute for the closure check.

If validation fails, the build exits non-zero. Actions must not commit a partial tree that silently drops half of Central.

## Local workflow (Phases 1–3)

From `tools/open-api/`:

```bash
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt
.venv/bin/python scripts/build.py          # fetch + split + manifest + validate
.venv/bin/python scripts/build.py --offline  # reuse source/, skip network
```

`--offline` is how we iterate on the splitter without hitting ReadMe every run.

## GitHub Actions (Phase 4)

Workflow: `.github/workflows/update-openapi-docs.yml`.

Triggers:

- `workflow_dispatch`
- Daily cron (`17 7 * * *` UTC)
- Push to `main` or `feature/openapi-docs` that touches `tools/open-api/scripts/**`, `tools/open-api/local/**`, or the workflow file

```text
Checkout
   |
Setup Python 3.12 + pip install -r tools/open-api/scripts/requirements.txt
   |
Unit tests (test_splitter.py)
   |
Seed tools/open-api/local/ → source/     (Mist / SDC / Axis)
   |
Fetch hub specs into source/             (not committed)
   |
Split → specs/  +  data/manifest.json
   |
Validate every generated spec
   |
If validation or any hub project failed: fail the job (no commit)
   |
If specs/ + manifest changed: commit and push
   |
Cloudflare Pages/Workers picks up the push
```

Operational notes:

- The fetcher scrapes ReadMe `ssr-props`. A portal HTML change will break the job. Fail loudly (zero specs **or any project fetch failure** = no commit). Do not publish a tree that silently dropped Central.
- `contents: write` on `GITHUB_TOKEN` is enough if the branch allows Actions to push. If `main` is protected, add a PAT as `OPENAPI_DOCS_TOKEN` and point `actions/checkout` at it.
- Do not commit `source/`. Hand-dropped specs that the hub does not publish live in committed `tools/open-api/local/`.
- GHA runners do not need the laptop `--no-ssl-verify` path.
- The commit only adds `tools/open-api/specs` and `data/manifest.json`, so it does not re-trigger this workflow.

## Why not resolve first?

Docs path:

```text
Fetch one uploaded definition (keep $refs)
  →
Split by group
  →
Dependency closure into that slice
  →
Small self-contained spec that still uses local $refs
```

Not:

```text
Fetch
  →
Merge MRT + Config into one 17 MB file
  →
Resolve every $ref
  →
Split
```

## Implementation phases

### Phase 1 — Splitter experiment

Highest-value work. No UI required.

- Move the ripped scripts under `tools/open-api/scripts/` and strip the `centralmind` package assumptions
- Point the fetcher at `source/`, one file per uploaded definition
- Write `spec_splitter.py` against **small fixture specs** first: nested refs, circular refs, `allOf`/`oneOf`, path-level parameters, multi-tag, untagged, JSON Pointer escaping
- Then run it on the real Central source files
- Print / write stats: document count, ops/file, bytes/file, schemas/file, unassigned, unresolved
- Apply the size budget; add a second cut if a tag is still huge
- `grouping.yaml` can be empty in this phase

Phase 1 is done when Central slices are valid, deterministic, and under budget.

### Phase 2 — Viewer spike, then the app

- Load the worst-case slice and a typical slice in Scalar. If a 500 KB file is still slow, tighten the budget before building navigation.
- Then: static `index.html` / `app.js`, manifest-driven nav, one spec at a time, bench-tools chrome.
- Register the landing-page card.

### Phase 3 — Multiple APIs

Wire the other fetcher targets through the same pipeline:

- Aruba Central (already done in Phase 1)
- ClearPass
- AOS-CX
- UXI

No splitter redesign. New APIs are more source directories and more manifest entries.

### Phase 4 — GitHub Actions

Done: `.github/workflows/update-openapi-docs.yml` automates **fetch → split → validate → commit**. After merge to `main`, generated docs refresh on the daily schedule (or via **Actions → Update OpenAPI docs → Run workflow**).

### Phase 5 — UI extras

Cheap if the manifest already has the operation index:

- Search APIs / groups / endpoints
- File sizes and last-updated (already in the manifest)
- Deep links (`#/aruba-central/clients`)
- Download this slice as OpenAPI JSON

## Desired end state

```text
Scheduled GitHub Action
        |
        +--> Fetch per-definition specs (ephemeral)
        +--> Split under size budget
        +--> Validate (fail closed)
        +--> Commit specs/ + data/manifest.json
        |
        v
Cloudflare Pages/Workers deploy
        |
        v
tools/open-api/
        |
        +--> Aruba Central
        |      +--> Access Points
        |      +--> Clients
        |      +--> Gateways
        |      +--> …
        +--> ClearPass
        +--> AOS-CX
        +--> UXI
```

Normal browsing never loads the 17+ MB Central specification. Adding another OpenAPI source later is a fetcher registry entry plus whatever `grouping.yaml` overlay it needs — not a new app.
