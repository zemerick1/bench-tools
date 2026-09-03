#!/usr/bin/env python3
"""Independent IEEE PHY and classroom-capacity checks for the AP math.

Does not import the JS engine — it re-derives the same PHY formula so we can
run without Node. Keep in lockstep with model.js.

Run: python3 tools/ap-capacity/test_model.py
"""

from __future__ import annotations

import math
import sys

passed = 0
failed = 0


def ok(cond: bool, msg: str) -> None:
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok  — {msg}")
    else:
        failed += 1
        print(f"  FAIL — {msg}", file=sys.stderr)


MCS = {
    0: (1, 1 / 2),
    1: (2, 1 / 2),
    2: (2, 3 / 4),
    3: (4, 1 / 2),
    4: (4, 3 / 4),
    5: (6, 2 / 3),
    6: (6, 3 / 4),
    7: (6, 5 / 6),
    8: (8, 3 / 4),
    9: (8, 5 / 6),
    10: (10, 3 / 4),
    11: (10, 5 / 6),
    12: (12, 3 / 4),
    13: (12, 5 / 6),
}

NSD_OFDM = {20: 52, 40: 108, 80: 234, 160: 468}
NSD_OFDMA = {20: 234, 40: 468, 80: 980, 160: 1960, 320: 3920}
MAX_MCS = {"n": 7, "ac": 9, "ax": 11, "be": 13}


def nsd(standard: str, width: int) -> int:
    table = NSD_OFDM if standard in ("n", "ac") else NSD_OFDMA
    return table[width]


def tsym(standard: str, gi_us: float) -> float:
    if standard in ("n", "ac"):
        return 3.2 + gi_us
    return 12.8 + gi_us


def phy_mbps(standard: str, width: int, nss: int, mcs: int, gi_us: float) -> float | None:
    if mcs > MAX_MCS[standard]:
        return None
    if standard == "n" and width > 40:
        return None
    if standard in ("ac", "ax") and width > 160:
        return None
    bpscs, coding = MCS[mcs]
    dbps = nsd(standard, width) * nss * bpscs * coding
    # Integer N_DBPS is a VHT/HT BCC constraint, not HE/EHT (LDPC).
    if standard in ("n", "ac") and abs(dbps - round(dbps)) > 1e-6:
        return None
    return (dbps / (tsym(standard, gi_us) * 1e-6)) / 1e6


def near(a: float, b: float, tol: float = 0.15) -> bool:
    return abs(a - b) <= tol


def mac_eff(n: int) -> float:
    if n <= 1:
        return 0.5
    if n <= 10:
        return 0.45
    return 0.4


def ssid_air(count: int, band: str) -> float:
    extra = max(0, count - 1)
    if extra == 0:
        return 0
    beacon_bytes = 350
    beacons_per_sec = 1000 / 102.4
    rate = 1 if band == "2.4" else 6
    one = ((beacon_bytes * 8 * beacons_per_sec) / (rate * 1e6)) * 1.5
    return min(0.65, extra * one)


print("PHY rates (IEEE)\n")

r = phy_mbps("n", 20, 1, 7, 0.4)
ok(r is not None and near(r, 72.2), f"11n 20 MHz 1SS MCS7 SGI = 72.2 (got {r:.2f})")

r = phy_mbps("n", 20, 1, 7, 0.8)
ok(r is not None and near(r, 65.0), f"11n 20 MHz 1SS MCS7 LGI = 65 (got {r:.2f})")

r = phy_mbps("ac", 20, 2, 8, 0.4)
ok(r is not None and near(r, 173.3), f"11ac 20 MHz 2SS MCS8 SGI = 173.3 (got {r:.2f})")

r = phy_mbps("ac", 20, 1, 9, 0.4)
ok(r is None, "VHT MCS 9 @ 20 MHz 1SS is invalid")

r = phy_mbps("ac", 20, 2, 9, 0.4)
ok(r is None, "VHT MCS 9 @ 20 MHz 2SS is invalid")

r = phy_mbps("ac", 20, 3, 9, 0.4)
ok(r is not None and near(r, 288.9), f"11ac 20 MHz 3SS MCS9 SGI = 288.9 (got {r:.2f})")

r = phy_mbps("ac", 80, 1, 9, 0.4)
ok(r is not None and near(r, 433.3), f"11ac 80 MHz 1SS MCS9 SGI = 433.3 (got {r:.2f})")

r = phy_mbps("ax", 80, 2, 11, 0.8)
ok(r is not None and near(r, 1201.0, 1.0), f"11ax 80 MHz 2SS MCS11 GI0.8 = 1201 (got {r:.1f})")

r = phy_mbps("be", 320, 2, 13, 0.8)
ok(r is not None and near(r, 5764.7, 2.0), f"11be 320 MHz 2SS MCS13 GI0.8 = 5764.7 (got {r:.1f})")

print("\nClassroom load example\n")

# iPad 1: 72 Mbps × 40% / 30 = 950 kbps
phy = phy_mbps("n", 20, 1, 7, 0.4)
usable = phy * 0.40
per = usable / 30
ok(near(usable, 29, 1.0), f"iPad 1 aggregate ~29 Mbps (got {usable:.1f})")
ok(near(per, 0.95, 0.05), f"iPad 1 per client ~950 kbps (got {per*1000:.0f} kbps)")
ok(per < 2.0, "iPad 1 cannot hold 2 Mbps unicast video")

# iPad Air 2: 173 × 40% / 30 = 2.3 Mbps
phy = phy_mbps("ac", 20, 2, 8, 0.4)
usable = phy * 0.40
per = usable / 30
ok(near(usable, 69, 1.5), f"iPad Air 2 aggregate ~69 Mbps (got {usable:.1f})")
ok(near(per, 2.3, 0.1), f"iPad Air 2 per client ~2.3 Mbps (got {per:.2f})")
ok(per >= 2.0, "iPad Air 2 clears 2 Mbps unicast video")

# MacBook alone: 289 × 50% = 145
phy = phy_mbps("ac", 20, 3, 9, 0.4)
usable = phy * 0.50
ok(near(usable, 145, 2.0), f"3SS MacBook alone ~145 Mbps (got {usable:.1f})")

print("\nEfficiency buckets & RF\n")
ok(mac_eff(1) == 0.5, "1 client → 50%")
ok(mac_eff(8) == 0.45, "small room → 45%")
ok(mac_eff(30) == 0.4, "30 clients → 40%")

typical = phy_mbps("n", 20, 1, 7, 0.4) * 0.40 * 0.60
ok(near(typical, 17.3, 0.5), f"same iPad 1 radio with 60% RF ~17 Mbps (got {typical:.1f})")

air24 = ssid_air(4, "2.4")
air5 = ssid_air(4, "5")
ok(air24 > 0.08, f"4 SSIDs on 2.4 eat noticeable airtime ({air24*100:.1f}%)")
ok(air5 < air24 / 3, f"4 SSIDs on 5 GHz are cheaper ({air5*100:.1f}%)")
ok(ssid_air(1, "5") == 0, "1 SSID is inside the protocol factor, not extra tax")

print("\nHarmonic mix (slow clients dominate airtime)\n")
# 2/3 at 72.2, 1/3 at 144.4 (2SS n 20 SGI MCS7)
p1 = phy_mbps("n", 20, 1, 7, 0.4)
p2 = phy_mbps("n", 20, 2, 7, 0.4)
blend = 1 / ((2 / 3) / p1 + (1 / 3) / p2)
arith = (2 / 3) * p1 + (1 / 3) * p2
ok(blend < arith, f"harmonic {blend:.1f} < arithmetic {arith:.1f}")
ok(near(p2, 144.4), f"2SS n 20 MCS7 SGI = 144.4 (got {p2:.1f})")

print("\nIllegal widths have no PHY\n")
ok(phy_mbps("n", 160, 2, 7, 0.4) is None, "11n has no 160 MHz rate")
ok(phy_mbps("n", 80, 2, 7, 0.4) is None, "11n has no 80 MHz rate")

print()
if failed:
    print(f"{failed} failed, {passed} passed")
    sys.exit(1)
print(f"all {passed} passed")
