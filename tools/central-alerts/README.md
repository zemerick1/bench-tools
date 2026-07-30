# Central Alerts & Insights

Searchable reference catalog of **Aruba Central** alert configurations and static **AI Insight** definitions.

This tool is a **static HTML page** served by the tools hub. A small **stdlib-only Python** script refreshes the page from the Central API when you have credentials.

## In the hub

- Card on the landing page → `tools/central-alerts/`
- Shared site header/footer; catalog UI is scoped under `.catalog`

## Files

| File | Role |
|------|------|
| `index.html` | Generated (or snapshot) page users open |
| `page_template.html` | Shell with tools chrome + `{{PLACEHOLDERS}}` |
| `update_catalog.py` | Fetches alerts + fills the template |
| `credentials.local.json` | Optional local secrets (**gitignored**) |

## Refresh the catalog

You need a GreenLake / Central API client (client credentials grant).

**Option A — environment variables**

```bash
export CENTRAL_CLIENT_ID="..."
export CENTRAL_CLIENT_SECRET="..."
# optional override:
# export CENTRAL_DOMAIN="internal.api.central.arubanetworks.com"

cd tools/central-alerts
python3 update_catalog.py
```

**Option B — local JSON** (never commit this file)

```bash
cp credentials.local.json.example credentials.local.json
# edit client_id / client_secret

python3 update_catalog.py
```

Then reload http://localhost:8080/tools/central-alerts/

## Security notes

- **Do not** put client secrets in `update_catalog.py` or commit them.
- If an older copy of this script on a USB/volume still has hardcoded secrets, **rotate those credentials** in GreenLake.
- The published `index.html` is a public-ish reference of alert *names/rules* from your tenant snapshot — treat it as internal if your alert config is sensitive.

## Offline / no API

Ship the current `index.html` snapshot with the site. Users can browse search/filter without Python. Re-run the script only when you want a fresher pull from Central.
