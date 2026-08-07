# Hardware Platform Support

Interactive matrix of **HPE Aruba** and **HPE Juniper** platforms. **One card per model**, grouped by series/type.

| Vendor | What you get | Source |
|--------|----------------|--------|
| **HPE Aruba** | Correlated **firmware tracks** (first / last support) | See below |
| **HPE Juniper** | Series, lifecycle (EOL), **Pathfinder** deep-link | Pathfinder catalog |

## Aruba tracks

| Track | Source |
|--------|--------|
| **AOS-10** | [New Central supported devices](https://arubanetworking.hpe.com/techdocs/new-central/content/get-started/supp-devices.htm) + [AOS-10 RNs](https://arubanetworking.hpe.com/techdocs/AOS_10.x_RN_WebHelp/Content/all-releases.htm) |
| **Instant (IAP 8.x)** | [Classic Central Supported Instant APs](https://arubanetworking.hpe.com/techdocs/central/2.5.8/content/nms/access-points/supported-platforms/supported-aps.htm) |

700 Series Instant floor `8.13.3.x` is added manually (not on the published Instant table). Campus / other AOS-8 modes can be layered later.

## Juniper (v1)

| Series | Type filter | Notes |
|--------|-------------|--------|
| **EX Series** | EX | Switches |
| **QFX Series** | QFX | Switches |
| **Access Points** | APs | Mist APs |

Catalog: `POST https://apps.juniper.net/hardwaresrv/pf/home`  
Product page: `https://apps.juniper.net/home/{productCodeName}/overview`  
(e.g. [ex4300](https://apps.juniper.net/home/ex4300/overview))

Fields kept: `platform` → model, `productCodeName`, `productKey`, `isEOL`, series, category, `pathfinderUrl`.  
No Junos first/last firmware matrix yet — Pathfinder is the deep-link target.

## Data

- `data/platforms.json` — static snapshot (`devices[]` with `vendor`, optional `tracks[]`)
- Rebuild AOS-10 base: `python3 update_data.py`, then re-merge Instant tracks
- Refresh Juniper only (leaves Aruba intact): `python3 update_juniper.py`

## Refresh the snapshot

```bash
cd tools/hardware-platform-support
# Aruba AOS-10 slice (overwrites platforms.json base — re-merge Instant after)
python3 update_data.py
# optional offline:
# python3 update_data.py --support-md ./supp-devices.md --releases-md ./all-releases.md

# Juniper EX / QFX / Mist APs (merges into existing platforms.json)
python3 update_juniper.py
# optional offline:
# python3 update_juniper.py --catalog-json ./pathfinder-home.json
```

## UI behavior

| Filter | Behavior |
|--------|----------|
| **Vendor** | All / HPE Aruba / HPE Juniper |
| **Firmware track** | AOS-10, Instant, Junos, Mist AP |
| **Type** | APs, Gateways, Bridge, AOS-CX, AOS-S, EX, QFX |
| **Status** | Current vs parked / EOL |

Results are **grouped by series** (Juniper) or type/family (Aruba). Groups and product cards start collapsed unless search or a tight filter opens groups. Expand a card for tracks (Aruba) or Pathfinder (Juniper).

| Last supported (Aruba) | Primary RN button |
|---|---|
| Specific / train (`10.4.x.x`) | Newest matching train entry on all-releases |
| `N/A` | **Latest AOS-10** build from the all-releases list |

`platforms.json` includes `latestRelease: { version, url, homeUrl }` for the UI badge/labels, plus `juniperUpdated` / `juniperSource` when Juniper has been merged.
