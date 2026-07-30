# Idea: ClearPass Access Tracker Decipher Tool

**Status:** Built (v1) — `tools/access-tracker/`  
**Hub name:** Access Tracker Translator  
**Date captured:** 2026-07-29  
**First ship:** 2026-07-30

## Problem

Customers export a session from ClearPass Access Tracker (zip/folder) and dump it in tickets. Digging through `Dashboard_Details.txt`, `Request_Logs.html`, and optional `Service_Config.xml` is slow. They want **super high-level** answers: did it work, who, MAC, how they authed, where from, why reject.

## Input

User provides the **full Access Tracker export** (zip or extracted folder), typically:

```text
R000000xx-01-xxxxxxxx/
  Dashboard_Details.txt    # primary
  Request_Logs.html        # root cause / timeline
  Service_Config.xml       # optional — service rules, NAD, enforcement
```

Works offline in the browser (static hub). Zip via JSZip or similar; no ClearPass API required.

## High-level output (what we promise)

| Question | Source |
|---|---|
| **Result** ACCEPT / REJECT | Dashboard |
| **When** + session id | Dashboard |
| **Who** (username) | Dashboard |
| **Client MAC** (if present) + formats; vendor if CPPM filled it | Dashboard computed attrs |
| **How** auth method + auth source (when classified) | Dashboard / logs |
| **Where from** NAD IP/name, device type/vendor/location | Dashboard |
| **Wireless context** SSID, AP name, AP MAC, AP group, controller (if present) | Input RADIUS + Aruba + Connection:* |
| **Service / roles / enforcement profiles** (when set) | Dashboard |
| **Reject reason** error code, category, message, alerts | Dashboard **Alerts** |
| **Warnings** no MAC, timeouts, empty service, etc. | Logs (+ dashboard) |
| **Timing** request processing / policy eval | Logs |

**One-liner shape:**

> **REJECT** — client **68:ff:7b:e8:fe:e3** (TP-Link) on SSID **Home-Net** via AP **AP-Garage** / controller **192.168.199.11**. Failed **before** normal auth: **service categorization timed out** (error **204**).

## If Service_Config.xml is present

- Why the service matched (rules, e.g. User-Name CONTAINS X AND NAS in group Y)
- Auth method / source / enforcement policy wiring
- Related NAD clients/groups (hygiene: name vs NAS-Identifier mismatch)

If missing: still useful; note “no service config in export.”

## What we do *not* claim

- Full RADIUS packet hex decode
- Live CoA or ClearPass API
- Password values
- Invented root cause when logs don’t support it

Optional later: enrich attribute lines with **IETF + Aruba + Juniper** dictionaries (ClearPass `RadiusDictionary*.xml` exports) for Tunnel-* / VSAs.

## Sample exports analyzed

| Sample | Path | Result | Notes |
|---|---|---|---|
| Accept | `Downloads/tmp/R000000ee-01-6a6ab8a5/` | ACCEPT | PAP local user `radius-tracking`; switch NAD; **no client MAC**; bare Allow Access; has Service_Config |
| Deny | `Downloads/tmp 3/R00000003-01-6a6abbc4/` | REJECT | Wireless MAC-auth style; full MAC/SSID/AP; error **204** service categorization failed (Policy Server **timeout**); no Service_Config |

Deny is the stronger “customer useful” template.

## Suggested v1 UX

1. Drop zip/folder  
2. **Summary card** (result, who, MAC, how, where, service/roles)  
3. **Failure card** if REJECT (code + plain English)  
4. **Warnings** list  
5. Collapsed sections: RADIUS input (optional dict decode), policy/log timeline, service config  

Static site, playful tone consistent with the tools hub. No scrape of HPE/ClearPass UIs.

## Related assets already on hand

- ClearPass dictionary XMLs in Downloads: IETF, Aruba (14823), Juniper (2636) — for attribute name/id/enum decode, not required for v1 summary  
- Tools hub pattern: `bench-tools/tools/<name>/`

## Implementation notes (v1)

- Path: `tools/access-tracker/` (`index.html` + `decoder.js`)
- **No zip library** — user extracts `DashboardDetails.zip`, then drops the session folder or picks files
- Parses `Dashboard_Details.txt` (required), `Request_Logs.html`, `Service_Config.xml`
- RADIUS + light TACACS summary shape
- Registered on hub as **Access Tracker Translator**

### RADIUS dictionaries (shipped)

- Sources under `tools/access-tracker/dictionaries/` (ietf, aruba, hpe, juniper ClearPass XML)
- Built JSON: `tools/access-tracker/radius-dict.json` via `update_radius_dict.py`
- Used for enum decode (NAS-Port-Type, Service-Type, …) and attr type/id metadata

### Possible next

- Optional JSZip for direct zip drop
- Fixture tests with redacted samples under `tools/access-tracker/fixtures/`
- More vendor dictionaries as needed
