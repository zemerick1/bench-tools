# AP Capacity

Practical “how many users can this AP support?” estimator. Not a PHY-rate brochure.

## What it does

1. IEEE MCS PHY from generation, width, streams, MCS/QAM, guard interval
2. Protocol efficiency from active client count (50% / 45% / 40%)
3. RF that’s actually yours (isolated 100% / typical **60%** / crowded 40%)
4. SSID beacon + probe tax (worse on 2.4 GHz)
5. Client vs AP negotiation (min streams, min generation, bands the device has)
6. Answers **how many people fit a target Mbps** and **Mbps each with N active**

## What it is not

- A coverage or channel plan
- MU-MIMO / OFDMA marketing multipliers
- Permission to quote datasheet gigabits as user speed

## Local

```bash
python3 -m http.server 8080
# http://localhost:8080/tools/ap-capacity/

python3 tools/ap-capacity/test_model.py
node tools/ap-capacity/test_model.js
```

## Files

- `model.js` — MCS + capacity math
- `app.js` — UI
- `index.html` — page copy
- `data/aps.json` — curated internal-antenna APs (radios + streams)
- `test_model.py` / `test_model.js` — IEEE PHY + classroom capacity checks

## AP catalog

Static snapshot the UI loads. **Custom** stays first-class; picking a SKU fills radios, generation, and streams. Channel width is not in this file.

| Vendor | What is in the list | Source of radio facts |
|--------|---------------------|------------------------|
| **HPE Aruba** | Internal-antenna campus models (503–755) | Public series specs, entered by hand |
| **HPE Juniper** | Mist APs (AP12–AP66), internal omni variants | Pathfinder [hwspecs](https://apps.juniper.net/home/ap43/hwspecs) (`POST /hardwaresrv/hct/specification-detail`) |

Not in the dropdown: connectorized / external-antenna SKUs, directional-only variants, dedicated **scan** radios. Mist “Radio Count” on Pathfinder includes the scanner; we only keep 2.4 / 5 / 6 client radios.

Refresh is still a human merge: new names can come from the hardware-platform Pathfinder catalog; radio rows still need a hwspecs look before they go `complete`.
