# Show-Tech Sticky Note

Turn an Aruba **show-tech** / support text dump into:

1. **Sticky note** — one-liner identity + Central + mood  
2. **Clear facts** — platform identity, traffic mode, Central, IPSec health when relevant  
3. **Looks wrong** — grouped findings with line context (noise filtered)  
4. **For the ticket** — copy/paste block  
5. **Export report (.txt)** — sticky + facts + findings + ticket (**not** “sections we noticed”)

Not a root-cause engine. Not a health score. Not TAC with worse benefits.

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
- `fixtures/line-classes.js` — decision-table tests  
- `test_parser.js` — shipped-entry tests against `log-samples/`  
