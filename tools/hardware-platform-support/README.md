# Hardware Platform Support

Interactive matrix of HPE Aruba Networking platforms (APs, gateways, bridge, AOS-CX, AOS-S) with **first supported** / **parked last** software and links into **AOS-10 release notes**.

## Data

- `data/platforms.json` — static snapshot (served to the browser)
- Source docs:
  - [Supported Devices](https://arubanetworking.hpe.com/techdocs/new-central/content/get-started/supp-devices.htm)
  - [AOS-10 All Releases](https://arubanetworking.hpe.com/techdocs/AOS_10.x_RN_WebHelp/Content/all-releases.htm)

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
