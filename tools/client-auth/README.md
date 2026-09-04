# Client Auth

A device logs in. You see who it actually talks to — and who trusts the cert. Open, MAC auth, captive portal, PEAP, TTLS, TEAP, and EAP-TLS stay yours.

## What it is

A teaching cartoon. The device talks to the authenticator; the NAC sits on the other wire, speaking RADIUS. Who trusts the cert is the whole plot.

## What it is not

- A packet capture or RADIUS log
- A NAC design or ClearPass policy
- Permission to quote these hops as a trace

## Local

```bash
python3 -m http.server 8080
# http://localhost:8080/tools/client-auth/

node tools/client-auth/test_model.js
```

## Files

- `model.js` — hops, trust, certs
- `viz.js` — stage
- `app.js` — UI
- `index.html` — page copy
- `test_model.js` — node tests
