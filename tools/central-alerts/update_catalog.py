#!/usr/bin/env python3
"""
Aruba Central Alert & Insight Catalog Updater
===============================================
Pulls every alert configuration from /network-notifications/v1/alert-config
and combines it with the 22 static AI Insight definitions, then regenerates
index.html for the tools-page hub (tools/central-alerts/).

Dependencies: None (stdlib only — urllib, json, os, html, datetime).

Usage:
  1. Set CENTRAL_CLIENT_ID / CENTRAL_CLIENT_SECRET (or credentials.local.json).
  2. Run:  python3 update_catalog.py
  3. Open via the tools hub at tools/central-alerts/
"""

import urllib.request
import urllib.parse
import urllib.error
import json
import os
import html as html_mod
import datetime

# ============================================================
# CONFIGURATION — env vars or credentials.local.json (gitignored)
# ============================================================

def _load_credentials():
    """Load API credentials from environment or local JSON file."""
    client_id = os.environ.get("CENTRAL_CLIENT_ID", "").strip()
    client_secret = os.environ.get("CENTRAL_CLIENT_SECRET", "").strip()
    domain = os.environ.get(
        "CENTRAL_DOMAIN", "internal.api.central.arubanetworks.com"
    ).strip()

    local = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "credentials.local.json"
    )
    if os.path.isfile(local):
        with open(local, encoding="utf-8") as f:
            data = json.load(f)
        client_id = (data.get("client_id") or client_id).strip()
        client_secret = (data.get("client_secret") or client_secret).strip()
        domain = (data.get("central_domain") or domain).strip()

    return client_id, client_secret, domain


CLIENT_ID, CLIENT_SECRET, CENTRAL_DOMAIN = _load_credentials()

# HPE GreenLake SSO — token endpoint (do NOT change this)
SSO_TOKEN_URL = "https://sso.common.cloud.hpe.com/as/token.oauth2"


# ============================================================
# STATIC INSIGHT DEFINITIONS (22 AI Insight types)
# ============================================================
INSIGHT_DEFINITIONS = [
    {
        "insightId": "701",
        "title": "AP Probe Response Optimization",
        "category": "Wireless",
        "description": "Analyzes SSID-level probe and auth SNR thresholds and recommends optimal values to reduce unnecessary probe responses, improving airtime efficiency.",
        "dataFields": "Probe config impact per device type, probe config impact per SSID, probe config recommendation (current vs recommended SNR thresholds)"
    },
    {
        "insightId": "702",
        "title": "Access Point Firmware Recommendation",
        "category": "Wireless",
        "description": "Identifies access points running outdated firmware and recommends upgrades that provide new features and bug fixes.",
        "dataFields": "Firmware recommendation summary (model, current version, recommended version, reason), recommended firmware statistics"
    },
    {
        "insightId": "703",
        "title": "Switch Firmware Recommendation",
        "category": "Wired",
        "description": "Identifies switches running outdated firmware and recommends upgrades that provide new features and bug fixes. Covers both AOS-CX and AOS-S (ProVision).",
        "dataFields": "Firmware recommendation summary (model, current version, recommended version, reason), available firmware recommendation (CX and PVOS)"
    },
    {
        "insightId": "704",
        "title": "Gateway Firmware Recommendation",
        "category": "Wired",
        "description": "Identifies gateways running outdated firmware and recommends upgrades that provide new features and bug fixes.",
        "dataFields": "Firmware recommendation summary (model, current version, recommended version, reason), recommended firmware statistics"
    },
    {
        "insightId": "711",
        "title": "Wi-Fi 6 (802.11ax) Performance Optimization",
        "category": "Wireless",
        "description": "Evaluates per-SSID and per-client-OS Wi-Fi 6 performance gains. Identifies incompatible clients and quantifies projected TX rate improvements from enabling 11ax features.",
        "dataFields": "Per-WLAN performance (current vs projected TX rate), per-client OS model performance, incompatible client list, feature contribution breakdown"
    },
    {
        "insightId": "712",
        "title": "WPA3 Readiness & Compatibility",
        "category": "Wireless",
        "description": "Assesses per-SSID WPA3 client capability, recommends authentication mode upgrades, and identifies non-interoperable clients that would be impacted by a WPA3 migration.",
        "dataFields": "WPA3-capable client percentages per SSID, recommended auth mode per SSID, non-interoperable client list (MAC, vendor, year)"
    },
    {
        "insightId": "713",
        "title": "Green AP / Power Save Recommendation",
        "category": "Wireless",
        "description": "Recommends power-save schedules for eligible sites based on usage patterns. Estimates annual energy savings and identifies APs and groups that would benefit from Green AP.",
        "dataFields": "Percentage of energy savings, power save status, recommendation summary (eligible sites, schedule, annual savings), per-site power save actions"
    },
    {
        "insightId": "717",
        "title": "Gateway WAN Uplink Latency",
        "category": "WAN",
        "description": "Detects gateways with WAN uplink latency exceeding peer baselines. Compares per-uplink latency against peer gateways, broken down by ISP and uplink type.",
        "dataFields": "Impacted gateway count and percentage, per-uplink latency vs peer latency, ISP and uplink type breakdown"
    },
    {
        "insightId": "718",
        "title": "Wireless Client Onboarding Experience",
        "category": "Wireless",
        "description": "Measures time-to-connect across DHCP, authentication, and association stages. Identifies WLANs with high onboarding latency and the client device types most affected.",
        "dataFields": "Per-SSID latency by connectivity stage, time-to-connect distribution (good vs bad), impacted client breakdown by OS/vendor/year"
    },
    {
        "insightId": "720",
        "title": "Application Performance / SaaS Experience",
        "category": "WAN",
        "description": "Detects degraded application latency versus peer baselines. Provides daily and weekly impacted application lists, root-cause breakdown (gateway self-latency vs ISP), and per-app time-series.",
        "dataFields": "Impacted apps per site, daily and weekly impacted app lists, per-app latency time-series, root cause (app/gateway/peer/ISP)"
    },
    {
        "insightId": "722",
        "title": "Wired Client Onboarding Experience",
        "category": "Wired",
        "description": "Measures wired client time-to-connect across 802.1X/RADIUS stages. Identifies RADIUS servers with high latency or failure rates and the client OS types most affected.",
        "dataFields": "Per-server latency and connection counts, time-to-connect distribution, impacted clients by OS type and vendor"
    },
    {
        "insightId": "723",
        "title": "AP Association Capacity Optimization",
        "category": "Wireless",
        "description": "Analyzes per-SSID client-count trends and AP association success/failure rates. Recommends client-limit thresholds to balance load and reduce association failures.",
        "dataFields": "Client count time-series per SSID, AP association stats (success/fail counts, current vs recommended config), recommendation text"
    },
    {
        "insightId": "725",
        "title": "802.11r Fast Roaming Optimization",
        "category": "Wireless",
        "description": "Evaluates 11r (Fast BSS Transition) readiness per SSID. Analyzes roaming stats, client compatibility, and predicts latency improvement and RADIUS load reduction from enabling 11r.",
        "dataFields": "11r enable status, roaming experience stats, client compatibility distribution, predicted latency and auth-server improvements, impacted APs"
    },
    {
        "insightId": "727",
        "title": "DFS Channel Utilization",
        "category": "Wireless",
        "description": "Identifies sites where DFS channels are disabled or underutilized. Recommends enabling additional 5 GHz channels to reduce co-channel interference and improve capacity.",
        "dataFields": "DFS channel summary per AP group, enable channel list per site, site map with geo coordinates"
    },
    {
        "insightId": "728",
        "title": "Coverage Hole Detection",
        "category": "Wireless",
        "description": "Detects APs with poor signal coverage based on client-minute analysis at low SNR. Provides per-AP root cause, impacted client breakdown, and remediation recommendations.",
        "dataFields": "Coverage hole impact summary, per-AP actions and root cause, network impact by SNR bucket, impacted client types per SSID, floor plan device locations"
    },
    {
        "insightId": "729",
        "title": "Spanning Tree Protocol (STP) Optimization",
        "category": "Wired",
        "description": "Detects STP misconfigurations: incorrect root bridge election, suboptimal root port selection, incorrect bridge priority, and excessive topology change events. Recommends corrections.",
        "dataFields": "Incorrect root bridge (current vs recommended), incorrect root port, incorrect priority (current vs recommended), topology change count and root cause"
    },
    {
        "insightId": "731",
        "title": "AP Location Accuracy (Inferred Coordinates)",
        "category": "Wireless",
        "description": "Detects APs whose inferred physical location does not match their assigned floor-plan placement. Identifies missing APs and APs that may need to be swapped on the map.",
        "dataFields": "Per-floor inferred coordinates, missing AP list (with lat/long), APs to be swapped"
    },
    {
        "insightId": "732",
        "title": "AP Topology Resilience / Swap Recommendation",
        "category": "Wireless",
        "description": "Analyzes AP-to-switch topology and recommends AP port swaps to improve network resilience. Provides per-stack swap actions with stepwise resilience score gains.",
        "dataFields": "Swap actions per stack (step-by-step with gain), topology improvement summary (original vs recommended resilience score), per-stack swap distribution"
    },
    {
        "insightId": "733",
        "title": "Switch Memory Leak Detection",
        "category": "Wired",
        "description": "Detects switches exhibiting memory-leak signatures. Identifies impacted daemons, memory trend time-series, projected exhaustion time, and recommends firmware upgrades to resolve.",
        "dataFields": "Memory leak signature (impacted switches, modules, daemons, exit time), memory utilization trend time-series, recommended firmware"
    },
    {
        "insightId": "734",
        "title": "AP Radio Health & Country Code Mismatch",
        "category": "Wireless",
        "description": "Detects two conditions: (1) 2.4 GHz radios stuck in a non-transmitting state, and (2) APs operating with a country code that does not match their assigned regulatory domain.",
        "dataFields": "Stuck 2.4 GHz radio details (AP name, inactive minutes, impacted sessions), country code mismatch (assigned vs operating country, channel impact per band)"
    },
    {
        "insightId": "737",
        "title": "AP RF Coverage Score",
        "category": "Wireless",
        "description": "Computes a per-site, per-band coverage score. Identifies APs with poor coverage and recommends actions (e.g., power adjustments, AP additions) with projected score improvements.",
        "dataFields": "Coverage score per frequency band, uncovered vs healthy AP count, recommended actions with projected improvement percentage"
    },
    {
        "insightId": "739",
        "title": "Client Connection Latency Distribution",
        "category": "Wireless",
        "description": "Analyzes per-AP client-minute classification (good vs. bad) and latency distribution across connection stages. Provides chart data for latency trend visualization.",
        "dataFields": "Client minute classification time-series (good/bad counts), latency distribution per feature, chart titles and legends"
    },
]


# ============================================================
# 1. AUTHENTICATION — GreenLake SSO OAuth2 Client Credentials
# ============================================================
def get_access_token():
    """POST to HPE GreenLake SSO to get a bearer token for Central."""
    payload = urllib.parse.urlencode({
        "grant_type":    "client_credentials",
        "client_id":     CLIENT_ID,
        "client_secret": CLIENT_SECRET,
    }).encode("utf-8")

    req = urllib.request.Request(SSO_TOKEN_URL, data=payload, headers={
        "Content-Type":  "application/x-www-form-urlencoded",
        "Accept":        "application/json",
    })

    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())["access_token"]
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"\n--- SSO AUTH FAILURE ---")
        print(f"Status:  {e.code}")
        print(f"Headers: {dict(e.headers)}")
        print(f"Body:    {body}")
        print(f"--- END ---\n")
        raise


# ============================================================
# 2. DISCOVER GLOBAL SCOPE ID
# ============================================================
def get_global_scope_id(token):
    """GET /network-config/v1/global -> returns the tenant's global scope ID."""
    url = f"https://{CENTRAL_DOMAIN}/network-config/v1/global"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept":        "application/json",
    })
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
        return data["scopeId"]


# ============================================================
# 3. FETCH ALL ALERT CONFIGURATIONS (paginated)
# ============================================================
def fetch_all_alert_configs(token, scope_id):
    """Page through /network-notifications/v1/alert-config until exhausted."""
    configs = []
    offset = 0
    page_size = 20

    while True:
        params = urllib.parse.urlencode({
            "scope-id":   scope_id,
            "scope-type": "GLOBAL",
            "limit":      page_size,
            "next":       offset,
        })
        url = f"https://{CENTRAL_DOMAIN}/network-notifications/v1/alert-config?{params}"
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {token}",
            "Accept":        "application/json",
        })
        try:
            with urllib.request.urlopen(req) as resp:
                page = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            print(f"\n--- ALERT-CONFIG FETCH FAILURE ---")
            print(f"URL:     {url}")
            print(f"Status:  {e.code}")
            print(f"Body:    {body}")
            print(f"--- END ---\n")
            raise

        items = page.get("items", [])
        if not items:
            break
        configs.extend(items)
        print(f"     ... fetched {len(configs)} so far")
        offset += len(items)
        if len(items) < page_size:
            break

    return configs


# ============================================================
# 4. HTML GENERATION HELPERS
# ============================================================
def esc(text):
    """HTML-escape a string safely."""
    if text is None:
        return ""
    return html_mod.escape(str(text))


def humanize_metric(raw):
    """Turn a snake_case metric name into a readable label."""
    if not raw:
        return "Occurrences"
    return raw.replace("_", " ").title()


def badge_class(device_type):
    dt = (device_type or "").lower()
    if "ap" in dt or "access point" in dt:
        return "badge-ap"
    if "switch" in dt:
        return "badge-switch"
    if "gateway" in dt:
        return "badge-gateway"
    return "badge-other"


def category_badge(cat):
    c = (cat or "").lower()
    if "wireless" in c:
        return "badge-ap"
    if "wired" in c:
        return "badge-switch"
    if "wan" in c:
        return "badge-gateway"
    return "badge-other"


def render_rules(rules):
    """Build the threshold-rules HTML for one alert config."""
    if not rules:
        return ('<div class="no-rules-message">'
                "This is an event-based alert \u2014 it triggers immediately "
                "when the event occurs. No threshold rules apply.</div>")

    rows = ""
    for entry in rules:
        if not entry:
            continue
        rule = entry.get("rule")
        if not rule:
            continue
        duration = rule.get("duration", 0)
        for cond in (rule.get("condition") or []):
            if not cond:
                continue
            severity = cond.get("severity", "UNKNOWN")
            expr = cond.get("expression") or {}
            metric  = humanize_metric(expr.get("metric") or rule.get("metric"))
            op_raw  = expr.get("operator", "GTE")
            op_sym  = {"GTE": "\u2265", "LTE": "\u2264", "GT": ">", "LT": "<", "EQ": "="}.get(op_raw, op_raw)
            value   = expr.get("valueNumber", "N/A")
            rows += (
                f'<tr>'
                f'<td><span class="severity-badge severity-{severity.lower()}">{esc(severity)}</span></td>'
                f'<td><code>{esc(metric)}</code> {op_sym} <strong>{esc(str(value))}</strong></td>'
                f'<td>Sustained for <strong>{duration}</strong> min</td>'
                f'</tr>\n'
            )

    if not rows:
        return ('<div class="no-rules-message">'
                "System-monitored alert \u2014 custom threshold rules are "
                "not defined.</div>")

    return (
        '<table class="threshold-table">'
        "<thead><tr><th>Severity</th><th>Condition</th><th>Duration</th></tr></thead>"
        f"<tbody>{rows}</tbody></table>"
    )


def render_alert_card(c):
    """Render one alert config as an accordion item."""
    name        = esc(c.get("name", "Unnamed"))
    desc        = esc(c.get("description") or f"Triggers when '{name}' occurs.")
    device      = esc(c.get("deviceType", "Other"))
    category    = esc(c.get("category", ""))
    rule_source = esc(c.get("ruleSource", ""))
    clear_to    = c.get("clearTimeout")
    clear_str   = str(clear_to) if clear_to else "Event-based / Manual Clear"
    enabled     = "Enabled" if c.get("enabled") else "Disabled"
    bc          = badge_class(c.get("deviceType"))

    return f'''
    <div class="accordion-item" data-type="alert" data-device="{device}" data-category="{esc(category)}" data-name="{name.lower()}" data-desc="{desc.lower()}">
      <details class="accordion-details">
        <summary class="accordion-toggle">
          <div class="alert-header-info">
            <span class="type-tag type-alert">Alert</span>
            <span class="alert-name-link">{name}</span>
            <span class="badge {bc}">{device}</span>
          </div>
          <svg class="chevron-icon" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
        </summary>
        <div class="content-body">
          <div class="detail-grid">
            <div class="detail-card" style="grid-column: span 2;">
              <div class="detail-label">What triggers this alert</div>
              <div class="detail-val">{desc}</div>
            </div>
            <div class="detail-card">
              <div class="detail-label">Auto-Clear Timeout</div>
              <div class="detail-val">{esc(clear_str)}</div>
            </div>
            <div class="detail-card">
              <div class="detail-label">Category</div>
              <div class="detail-val">{rule_source} / {category}</div>
            </div>
            <div class="detail-card">
              <div class="detail-label">Default Status</div>
              <div class="detail-val">{enabled}</div>
            </div>
          </div>
          <h4 style="margin-top:1.25rem;font-size:.875rem;font-weight:600;color:var(--text-muted);">THRESHOLD RULES</h4>
          {render_rules(c.get("rules"))}
        </div>
      </details>
    </div>'''


def render_insight_card(ins):
    """Render one static insight definition as an accordion item."""
    title    = esc(ins["title"])
    desc     = esc(ins["description"])
    cat      = esc(ins["category"])
    iid      = esc(ins["insightId"])
    fields   = esc(ins["dataFields"])
    bc       = category_badge(ins["category"])

    return f'''
    <div class="accordion-item" data-type="insight" data-device="{cat}" data-category="{cat}" data-name="{title.lower()}" data-desc="{desc.lower()}">
      <details class="accordion-details">
        <summary class="accordion-toggle">
          <div class="alert-header-info">
            <span class="type-tag type-insight">Insight</span>
            <span class="alert-name-link">{title}</span>
            <span class="badge {bc}">{cat}</span>
          </div>
          <svg class="chevron-icon" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
        </summary>
        <div class="content-body">
          <div class="detail-grid">
            <div class="detail-card" style="grid-column: span 2;">
              <div class="detail-label">What this insight tells you</div>
              <div class="detail-val">{desc}</div>
            </div>
            <div class="detail-card">
              <div class="detail-label">Category</div>
              <div class="detail-val">{cat}</div>
            </div>
            <div class="detail-card">
              <div class="detail-label">Insight ID</div>
              <div class="detail-val">{iid}</div>
            </div>
            <div class="detail-card" style="grid-column: span 2;">
              <div class="detail-label">Data provided when active</div>
              <div class="detail-val">{fields}</div>
            </div>
          </div>
          <div class="no-rules-message" style="margin-top:1rem;">
            AI Insights are generated automatically by Central \u2014 they do not have user-configurable thresholds.
          </div>
        </div>
      </details>
    </div>'''

# ============================================================
# 5. FULL PAGE TEMPLATE (tools hub shell)
# ============================================================
def build_page(alert_configs, insight_defs):
    """Fill page_template.html with alert/insight cards."""
    alert_configs.sort(key=lambda c: (c.get("name") or "").lower())
    insight_defs.sort(key=lambda i: i["title"].lower())
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    alert_count = len(alert_configs)
    insight_count = len(insight_defs)
    total = alert_count + insight_count

    items_html = "\n".join(
        [render_alert_card(c) for c in alert_configs]
        + [render_insight_card(i) for i in insight_defs]
    )

    template_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "page_template.html"
    )
    with open(template_path, encoding="utf-8") as f:
        template = f.read()

    return (
        template
        .replace("{{ALERT_COUNT}}", str(alert_count))
        .replace("{{INSIGHT_COUNT}}", str(insight_count))
        .replace("{{TOTAL_COUNT}}", str(total))
        .replace("{{TIMESTAMP}}", now)
        .replace("{{ITEMS_HTML}}", items_html)
    )


# ============================================================
# 6. MAIN
# ============================================================
if __name__ == "__main__":
    if not CLIENT_ID or not CLIENT_SECRET:
        print("Missing Central API credentials.")
        print("Set CENTRAL_CLIENT_ID and CENTRAL_CLIENT_SECRET, or create")
        print("credentials.local.json next to this script (see README.md).")
        raise SystemExit(1)

    print("1/4  Authenticating...")
    token = get_access_token()

    print("2/4  Discovering global scope ID...")
    scope_id = get_global_scope_id(token)
    print(f"     \u2192 Global scope ID: {scope_id}")

    print("3/4  Fetching alert configurations (all pages)...")
    configs = fetch_all_alert_configs(token, scope_id)
    print(f"     \u2192 Retrieved {len(configs)} alert configurations.")

    print("4/4  Generating HTML catalog...")
    page_html = build_page(configs, INSIGHT_DEFINITIONS)

    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(page_html)

    print(f"\nDone \u2014 wrote {out}")
    print(
        f"  {len(configs)} alerts + {len(INSIGHT_DEFINITIONS)} insights = "
        f"{len(configs) + len(INSIGHT_DEFINITIONS)} total entries"
    )
