# Show-Tech Sticky Note

Turn an Aruba **show-tech** / support text dump into:

1. **Sticky note** — one-liner identity + Central + mood  
2. **Clear facts** — platform identity, traffic mode, Central, IPSec health when relevant  
3. **Looks wrong** — grouped findings with line context (noise filtered)  
4. **For the ticket** — copy/paste block  
5. **Export report (.txt)** — sticky + facts + findings + ticket (**not** “sections we noticed”)

## What this is / is not

### What this is

A **deciphering aid** for huge session logs. An AOS-CX `show tech` can easily run past **~220,000 lines**. Nobody wants to hand that to a human and say “good luck.” This tool:

- Pulls **clear facts** the dump already states (hostname, model, serial, version, uptime, Central, etc.)
- **Highlights** lines that already look loud (core dumps, CRITICAL, IPSec down events, …) with a bit of neighbor context
- Gives you a **sticky note + ticket paste** so the next person isn’t starting from page 1 of the novel

All offline in the browser. You bring the text; we don’t phone home.

### What this is **not**

| Not this | Why |
|----------|-----|
| **A root-cause analysis (RCA)** | We do not conclude *why* the box is broken or name a single guilty feature. |
| **A health score / “all clear”** | No findings ≠ healthy. We only flag patterns we know how to spot. |
| **TAC or official HPE support** | Tables go stale; dumps disagree; edge cases win. Confirm on source docs and live TAC when it matters. |
| **A full support-bundle unpacker** | Plain-text PuTTY (or similar) logs only—not `.tar.gz` tech bundles. |

If you need an RCA, use this output as **orientation**, then do the real work in the log, the lab, and the ticket thread.

## Personas sniffed

| Family | Signals (examples) |
|--------|---------------------|
| **AOS-CX** | `FL.10.x`, Chassis Serial Nbr |
| **AOS-10 campus AP** | AOS-10 / ArubaOS 10.x AP banner; **GRE/IPSec to gateway** vs local bridge |
| **Instant / AOS-8 IAP** | `ArubaOS (MODEL: …), Version 8.x`; bridge by default; **IAP-VPN** if set |
| **AOS-10 Microbranch AP** | `Microbranch AP is Enabled`, microbranch-tunnel-*, overlay to **VPNC** |
| **AOS-10 VPNC** | Hostname/role VPNC, crypto map **Tunnel status IPSEC/IKE** |
| **AOS-10 gateway / MD** | Hostname is…, Switch uptime (AOS-8 “controller” vernacular → gateway) |

## Aruba Central

Always extracted when present: connected?, server, last disconnect reason.  
**Mist: coming soon** (called out on the page and in export).

## Docs (local reference)

Place under `docs/` (gitignored PDFs):

- AOS-CX / AOS-S **Event Log Message Reference** — switch `Event|####` lines  
- **Aruba VSG SD-Branch Deploy** — Microbranch + VPNC / IPSec / overlay mental model  

## PuTTY capture

Collapsible “How to collect a log with PuTTY” on the page: Session → Logging → all session output → `show tech-support` (persona-specific).

## Local

```bash
python3 -m http.server 8080
# http://localhost:8080/tools/show-tech/
node tools/show-tech/test_parser.js
```

## Files

- `line_class.js` — single noise/signal classifier  
- `parser.js` — family, facts, Central, IPSec health, findings  
- `app.js` — UI, PuTTY help, export  
- `fixtures/line-classes.js` — decision-table tests (**synthetic lab strings only**)  
- `test_parser.js` — unit fixtures + optional local `log-samples/` (gitignored; customer dumps stay offline)  
