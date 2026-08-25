# Aruba Antenna Matrix

Unofficial helper: which **external** antenna for which Aruba AP, how many, omni vs directional.

Pairing comes from QuickSpecs **Select antennas (AP-xxx only)**. An antenna stays if it covers every band on that connector group — tri-band is valid on 2.4+5 ports. Radio *count* (tri-radio, flex) is not the same as 6 GHz.

## What you get

| View | Shows |
|------|--------|
| **By AP** | External-antenna models, compatible antennas grouped omni / directional |
| **By antenna** | SKU, pattern, and which APs it fits |

## Data

- `seed/models.json` — connectorized models + HPE BOM SKUs from QuickSpecs
- `seed/antenna_catalog.json` — SKU identity (bands, MIMO, connector, mount)
- `data/matrix.json` — filtered snapshot the UI loads

Rebuild:

```bash
cd tools/antenna-matrix
python3 update_data.py
```

`--live` only probes the HPE store catalog (usually 403 from datacenter IPs). Seed is still used until a saved-HTML path exists.

Saved QuickSpecs HTML/PDF belong in `source/` (gitignored). Do not copy research dumps, CSVs, or `C:\temp` prototypes into this folder.

## Refresh contract (when live parse lands)

1. List AP families from store category `c/4172284` (`/p/{oid}`).
2. PDP → **QuickSpecs** (`jumpid=in_pdp-psnow-qs`), not DDS Related Options.
3. Parse collaterals HTML `collateral.{docid}.html` (or files in `source/`) → Select antennas (AP-xxx only).
4. Keep even `AP-(\d+)`. Match connector, MIMO vs port groups, antenna bands ⊆ AP radios.
5. Enrich remaining SKUs via HPE search (`/search?text={SKU}`) and support family [`kmpmoid=1009431431`](https://support.hpe.com/connect/s/product?language=en_US&kmpmoid=1009431431&tab=manuals). `/p/{sku}` 404s for many JW* options.

Do **not** use marketing `downloadDoc?id=a00…enw` PDFs or DDS **Related Options** as the pairing table.

## Not official

Tables go stale. This snapshot is current-store families only. Confirm on current QuickSpecs before a BOM or a deploy.
