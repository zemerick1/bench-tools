# Aruba Antenna Matrix

Unofficial helper: which **external** antenna for which Aruba AP, how many, omni vs directional.

Pairing comes from QuickSpecs **Select antennas (AP-xxx only)**. An antenna stays if it covers every band on that connector group — tri-band is valid on 2.4+5 ports. Radio *count* (tri-radio, flex) is not the same as 6 GHz.

## What you get

| View | Shows |
|------|--------|
| **By AP** | External-antenna models, compatible antennas grouped omni / directional |
| **By antenna** | SKU, pattern, and which APs it fits |

## Data

- `seed/models.json` — AP chassis (ports, connector, bands) plus last-known BOM SKUs
- `seed/antenna_catalog.json` — SKU identity when the live name is thin
- `data/matrix.json` — filtered snapshot the UI loads

Port maps stay in the seed: HPE does not put jack layout in the antenna BOM table.

Rebuild (live — default):

```bash
cd tools/antenna-matrix
python3 -m pip install -r requirements.txt   # curl_cffi + pdfplumber
python3 update_data.py
```

Primary: QuickSpecs HTML `collateral.{id}.html` Description/SKU rows (same as the hand seed).  
Backup: `downloadDoc` PDF via pdfplumber if HPE serves a viewer.

`--offline` uses seed lists only.

## Refresh contract

1. One fetch per seed `quickSpecsId`.
2. HTML `uct-row` tables under **For NNN Std**, not DDS Related Options.
3. Keep the SKU if connector matches (N-type on RP-SMA needs the adapter cable), MIMO fits a port group, and the antenna covers every band on that group. Tri-band is valid on 2.4+5.
4. Store links are HPE search (`/search?text={SKU}`). Support family [`kmpmoid=1009431431`](https://support.hpe.com/connect/s/product?language=en_US&kmpmoid=1009431431&tab=manuals).

Do **not** use marketing `a00…enw` datasheet PDFs or DDS **Related Options**.

## Not official

Tables go stale. This snapshot is current-store families only. Confirm on current QuickSpecs before a BOM or a deploy.
