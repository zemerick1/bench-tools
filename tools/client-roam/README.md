# Client Roam

A client walks rooms and a hallway. You see when it leaves an AP — and how long the hole is. Transmit power, min basic rate, and 802.11r/k/v stay yours.

## What it is

A teaching cartoon. Power versus the min basic rate is the whole plot. 802.11r shortens the hole. It does not decide when the device leaves.

## What it is not

- A coverage survey or channel plan
- Ekahau, drywall, or your device’s roam table
- Permission to quote these milliseconds in a design

## Local

```bash
python3 -m http.server 8080
# http://localhost:8080/tools/client-roam/

node tools/client-roam/test_model.js
```

## Files

- `model.js` — geometry, RSSI, roam, gap
- `viz.js` — SVG plan
- `app.js` — UI
- `index.html` — page copy
- `test_model.js` — node tests
