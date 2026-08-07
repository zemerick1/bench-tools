# Subnet Planner

Greenfield **multi-building IPv4 scheme** designer. Not a CIDR calculator with delusions of grandeur.

## What it does

1. Buildings × roles (device types) with **devices per building**
2. **≥50% headroom** on counts → suggested prefix
3. Optional VLAN (else auto **10, 20, 30…**); optional **oversize** prefix
4. **Meshed** placement: aligned parent per role, **spaced** reserved lane per building
5. Gateway always **`.1`**
6. Sticky note + CSV export

## What it is not

- Brownfield IPAM / “don’t touch this /16”
- Floor/room design
- DHCP or firewall policy
- IPv6
- Permission to put everything on VLAN 1

## Rules worth knowing

| Rule | Behavior |
|------|----------|
| Headroom | `ceil(devices × 1.5)` then smallest fitting prefix |
| Min size | **`/25` floor** — no `/26`–`/30` |
| Oversize | Allowed (larger block than math); never tighter than `/25` |
| Undersize | Rejected |
| Site position | **Second** number (`10.<site>.…`) or **third** (`10.<vlan>.<site>.…`) — human site 1, 2, 3… |
| Third-number mode | Only `/24`–`/25` so site stays literally the third number (no `10.20.32.0` for site 1) |
| Second-number mode | Site owns `10.<site>.0.0/16`; roles packed under it with growth lanes |
| Spacing | Reserved lane for growth; **reservation ends** = last IP in lane |
| VLAN 1 | Rejected as a design choice |
| Duplicate VLAN | One VLAN per role row |
| Connected | Unique subnets required |

## Local

```bash
python3 -m http.server 8080
# http://localhost:8080/tools/subnet-planner/

node tools/subnet-planner/test_planner.js
```

## Files

- `planner.js` — pure allocation + validation
- `app.js` — UI
- `index.html` — page copy
- `test_planner.js` — node tests
