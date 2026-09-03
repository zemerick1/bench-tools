#!/usr/bin/env node
/**
 * AP capacity model tests — run: node tools/ap-capacity/test_model.js
 */
import {
  phyRateMbps,
  mcsValid,
  macEfficiency,
  estimateCapacity,
  ssidAirtimeFraction,
  clampWidthMHz,
  clampBand,
  validBandsFor,
  defaultRadios,
} from "./model.js";

let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ok  — ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL — ${msg}`);
  }
}

function near(a, b, tol = 0.15) {
  return Math.abs(a - b) <= tol;
}

console.log("PHY rates\n");
ok(near(phyRateMbps({ standard: "n", widthMHz: 20, nss: 1, mcs: 7, giUs: 0.4 }), 72.2), "n 20 1SS MCS7 SGI 72.2");
ok(mcsValid("ac", 20, 1, 9) === false, "VHT MCS9 20 MHz 1SS invalid");
ok(mcsValid("ac", 20, 2, 9) === false, "VHT MCS9 20 MHz 2SS invalid");
ok(near(phyRateMbps({ standard: "ac", widthMHz: 20, nss: 3, mcs: 9, giUs: 0.4 }), 288.9), "ac 20 3SS MCS9 288.9");
ok(near(phyRateMbps({ standard: "ac", widthMHz: 20, nss: 2, mcs: 8, giUs: 0.4 }), 173.3), "ac 20 2SS MCS8 173.3");
ok(near(phyRateMbps({ standard: "ax", widthMHz: 80, nss: 2, mcs: 11, giUs: 0.8 }), 1201, 1), "ax 80 2SS MCS11 1201");

console.log("\nClassroom load via estimateCapacity\n");

const ipad1 = estimateCapacity({
  radios: [{ id: "r5", enabled: true, band: "5", standard: "n", widthMHz: 20, nss: 3, giUs: 0.4 }],
  client: { standard: "n", nss: 1, bands: ["2.4", "5"], maxWidthMHz: 20 },
  quality: "excellent",
  neighbor: "isolated",
  ssidCount: 1,
  activeClients: 30,
  targetMbps: 2,
  splitMode: "best",
});
ok(near(ipad1.radios[0].phyMbps, 72.2), `iPad 1 PHY 72.2 (got ${ipad1.radios[0].phyMbps.toFixed(1)})`);
ok(near(ipad1.perUserMbps, 0.96, 0.05), `iPad 1 ~950 kbps/client (got ${ipad1.perUserMbps.toFixed(3)})`);
ok(near(ipad1.radios[0].protocolMbps, 28.9, 1), `iPad 1 protocol pool ~29 Mbps (got ${ipad1.radios[0].protocolMbps.toFixed(1)})`);
ok(ipad1.verdict === "short", "iPad 1 is short of 2 Mbps");
ok(ipad1.clientsThatFit > 13 && ipad1.clientsThatFit < 16, `iPad 1 seats ~14 at 2 Mbps, not 30 (got ${ipad1.clientsThatFit.toFixed(1)})`);

const air2 = estimateCapacity({
  radios: [{ id: "r5", enabled: true, band: "5", standard: "ac", widthMHz: 20, nss: 3, giUs: 0.4 }],
  client: { standard: "ac", nss: 2, bands: ["2.4", "5"], maxWidthMHz: 40 },
  quality: "excellent",
  neighbor: "isolated",
  ssidCount: 1,
  activeClients: 30,
  targetMbps: 2,
  splitMode: "best",
});
ok(near(air2.radios[0].phyMbps, 173.3), `Air 2 PHY 173.3 (got ${air2.radios[0].phyMbps.toFixed(1)})`);
ok(near(air2.perUserMbps, 2.3, 0.15), `Air 2 ~2.3 Mbps/client (got ${air2.perUserMbps.toFixed(2)})`);
ok(air2.verdict === "fits" || air2.verdict === "plenty", "Air 2 clears 2 Mbps");

const mac = estimateCapacity({
  radios: [{ id: "r5", enabled: true, band: "5", standard: "ac", widthMHz: 20, nss: 3, giUs: 0.4 }],
  client: { standard: "ac", nss: 3, bands: ["2.4", "5"], maxWidthMHz: 80 },
  quality: "excellent",
  neighbor: "isolated",
  ssidCount: 1,
  activeClients: 1,
  targetMbps: 2,
  splitMode: "best",
});
ok(near(mac.perUserMbps, 144.4, 2), `MacBook alone ~145 Mbps (got ${mac.perUserMbps.toFixed(1)})`);

console.log("\nTypical RF derate\n");
const derated = estimateCapacity({
  radios: [{ id: "r5", enabled: true, band: "5", standard: "n", widthMHz: 20, nss: 1, giUs: 0.4 }],
  client: { standard: "n", nss: 1, bands: ["5"], maxWidthMHz: 20 },
  quality: "excellent",
  neighbor: "typical",
  ssidCount: 1,
  activeClients: 30,
  targetMbps: 2,
  splitMode: "best",
});
ok(near(derated.rfUsable, 0.6), "typical neighbor factor is 60%");
ok(derated.perUserMbps < ipad1.perUserMbps * 0.7, "60% RF cuts per-user vs isolated");

ok(macEfficiency(1) === 0.5 && macEfficiency(30) === 0.4, "efficiency buckets");
ok(ssidAirtimeFraction(4, "2.4") > ssidAirtimeFraction(4, "5") * 3, "2.4 SSID tax > 5 GHz");

console.log("\nIoT cannot use 5/6 GHz\n");
const iot = estimateCapacity({
  radios: [
    { id: "r24", enabled: true, band: "2.4", standard: "ax", widthMHz: 20, nss: 2 },
    { id: "r5", enabled: true, band: "5", standard: "ax", widthMHz: 20, nss: 2 },
    { id: "r6", enabled: true, band: "6", standard: "ax", widthMHz: 40, nss: 2 },
  ],
  client: { standard: "n", nss: 1, bands: ["2.4"], maxWidthMHz: 20 },
  quality: "typical",
  neighbor: "typical",
  ssidCount: 3,
  activeClients: 20,
  targetMbps: 1,
  splitMode: "steered",
});
const iot5 = iot.radios.find((r) => r.band === "5");
ok(iot5 && iot5.share === 0, "IoT share on 5 GHz is 0");
ok(iot.radios.find((r) => r.band === "2.4")?.share === 1, "IoT all on 2.4");

console.log("\n2.4 typical is 64-QAM, not 256-QAM\n");
const twoFour = estimateCapacity({
  radios: [{ id: "r24", enabled: true, band: "2.4", standard: "ax", widthMHz: 20, nss: 2 }],
  client: { standard: "ax", nss: 2, bands: ["2.4", "5"], maxWidthMHz: 80 },
  quality: "typical",
  neighbor: "typical",
  ssidCount: 1,
  activeClients: 10,
  targetMbps: 2,
  splitMode: "best",
});
ok(twoFour.radios[0].mcs === 7, `typical 2.4 MCS 7 (got ${twoFour.radios[0].mcs})`);
ok(twoFour.radios[0].qam === 64, "typical 2.4 is 64-QAM");

console.log("\nIllegal PHY combos are clamped\n");
ok(clampWidthMHz("n", "5", 160) === 40, "Wi-Fi 4 + 160 MHz snaps to 40");
ok(clampWidthMHz("n", "2.4", 80) === 40, "2.4 GHz + 80 MHz snaps to 40");
ok(clampWidthMHz("ac", "5", 320) === 160, "Wi-Fi 5 + 320 MHz snaps to 160");
ok(clampBand("n", "6") === "5", "Wi-Fi 4 has no 6 GHz");
ok(!validBandsFor("ac").includes("6"), "Wi-Fi 5 has no 6 GHz");
ok(phyRateMbps({ standard: "n", widthMHz: 160, nss: 2, mcs: 7, giUs: 0.4 }) == null, "n @ 160 MHz is not a rate");
const wifi4 = estimateCapacity({
  radios: [{ id: "r5", enabled: true, band: "5", standard: "n", widthMHz: 160, nss: 2 }],
  client: { standard: "n", nss: 2, bands: ["5"], maxWidthMHz: 40 },
  quality: "excellent",
  neighbor: "isolated",
  ssidCount: 1,
  activeClients: 1,
  targetMbps: 2,
  splitMode: "best",
});
ok(wifi4.radios[0].widthMHz === 40, `estimate clamps n/160 to 40 MHz (got ${wifi4.radios[0].widthMHz})`);
ok(!defaultRadios(3, "n").some((r) => r.band === "6"), "3-radio Wi-Fi 4 does not keep a 6 GHz radio");

console.log();
if (failed) {
  console.error(`${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`all ${passed} passed`);
