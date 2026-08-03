# Hardware Platform Support

Interactive matrix of HPE Aruba Networking platforms. **One card per model**, with correlated **firmware tracks** (first / last support each).

| Track | Source |
|--------|--------|
| **AOS-10** | [New Central supported devices](https://arubanetworking.hpe.com/techdocs/new-central/content/get-started/supp-devices.htm) + [AOS-10 RNs](https://arubanetworking.hpe.com/techdocs/AOS_10.x_RN_WebHelp/Content/all-releases.htm) |
| **Instant (IAP 8.x)** | [Classic Central Supported Instant APs](https://arubanetworking.hpe.com/techdocs/central/2.5.8/content/nms/access-points/supported-platforms/supported-aps.htm) |

700 Series Instant floor `8.13.3.x` is added manually (not on the published Instant table). Campus / other AOS-8 modes can be layered later.

## Data

- `data/platforms.json` — static snapshot (`devices[].tracks[]` per model)
- Rebuild AOS-10 base: `python3 update_data.py`, then re-merge Instant tracks

## Refresh the snapshot

```bash
cd tools/hardware-platform-support
python3 update_data.py
```

If HPE blocks the fetch, save the pages (or jina reader markdown) locally:

```bash
python3 update_data.py \
  --support-md ./supp-devices.md \
  --releases-md ./all-releases.md
```

## UI behavior

| Last supported | Primary RN button |
|---|---|
| Specific / train (`10.4.x.x`) | Newest matching train entry on all-releases |
| `N/A` | **Latest AOS-10** build from the all-releases list (derived at snapshot time; Home.htm points at that tree) |

`platforms.json` includes `latestRelease: { version, url, homeUrl }` for the UI badge/labels.

Rows start **collapsed** (model + first/last in the header). Expand for tags, notes, and buttons.
