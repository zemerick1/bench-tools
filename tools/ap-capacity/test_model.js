#!/usr/bin/env node
/**
 * AP capacity model tests — run: node tools/ap-capacity/test_model.js
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  phyRateMbps,
  phyBreakdown,
  mcsValid,
  macEfficiency,
  estimateCapacity,
  capacityArithmetic,
  ssidAirtimeFraction,
  ssidAirtimeBreakdown,
  clampWidthMHz,
  clampBand,
  clampRadio,
  validBandsFor,
  defaultRadios,
  radiosFromAp,
  apMatchesRadios,
  apStreamLabel,
  sharedNss,
  deviceById,
  scenarioInput,
} from "./model.js";

const catalog = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "data", "aps.json"), "utf8"),
);

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

console.log("\nAP catalog\n");
const byId = Object.fromEntries((catalog.models || []).map((m) => [m.id, m]));
ok(Array.isArray(catalog.models) && catalog.models.length >= 12, `catalog has campus internals (got ${catalog.models.length})`);
ok(catalog.models.every((m) => m.radios.every((r) => r.band && r.nss >= 1)), "every radio has band + nss");
ok(catalog.models.every((m) => m.vendor === "aruba" || m.vendor === "juniper"), "every model has a vendor");
ok(catalog.models.filter((m) => m.vendor === "juniper").length >= 15, "Juniper Mist APs are in the catalog");
ok(apStreamLabel(byId["ap-515"]) === "2×2 / 4×4", `515 mixed streams (${apStreamLabel(byId["ap-515"])})`);
ok(apStreamLabel(byId["ap-655"]) === "4×4", "655 is 4×4 on every radio");
ok(apStreamLabel(byId["ap-555"]) === "4×4 / 8×8", "555 is 4×4 / 8×8 in dual-radio mode");
ok(apStreamLabel(byId["ap-745"]) === "2×2 / 4×4 / 4×4", "745 is 2×2 / 4×4 / 4×4");
ok(byId["ap-615"].radios.length === 2, "615 is dual-radio (tri-band flex)");
ok(byId["ap-725"].radios.length === 3 && byId["ap-725"].generation === "be", "725 is tri-radio Wi-Fi 7");
ok(apStreamLabel(byId.ap47) === "4×4" && byId.ap47.generation === "be", "Mist AP47 is 4×4 Wi-Fi 7");
ok(apStreamLabel(byId.ap33) === "2×2 / 4×4", "Mist AP33 is 2×2 / 4×4");
ok(byId.ap24.radios.length === 2, "Mist AP24 is dual-radio (2.4/6 flex + 5)");

const from515 = radiosFromAp(byId["ap-515"], [{ id: "r5", band: "5", widthMHz: 80, enabled: true, nss: 2 }]);
ok(from515[0].nss === 2 && from515[1].nss === 4, "515 radiosFromAp is 2 then 4");
ok(from515[1].widthMHz === 80, "SKU apply keeps prior 5 GHz width");
ok(apMatchesRadios(byId["ap-515"], from515, "ax"), "515 matches after apply");
ok(!apMatchesRadios(byId["ap-515"], from515, "be"), "generation drift is not a match");

const kept = clampRadio({ band: "5", standard: "ax", widthMHz: 20, nss: 4 }, "ax");
ok(kept.nss === 4, "clampRadio without nss arg keeps 4SS");
const stamped = clampRadio({ band: "5", standard: "ax", widthMHz: 20, nss: 4 }, "ax", 2);
ok(stamped.nss === 2, "clampRadio with nss arg stamps 2SS");
ok(sharedNss(from515) === "mixed", "515 sharedNss is mixed");
ok(sharedNss(radiosFromAp(byId["ap-635"])) === 2, "635 sharedNss is 2");

const mixedEst = estimateCapacity({
  radios: radiosFromAp(byId["ap-515"]),
  client: { standard: "ax", nss: 2, bands: ["2.4", "5"], maxWidthMHz: 80 },
  quality: "typical",
  neighbor: "typical",
  ssidCount: 3,
  activeClients: 20,
  targetMbps: 3,
  splitMode: "steered",
});
ok(mixedEst.radios.find((r) => r.band === "5")?.nss === 2, "client 2SS caps the 515's 4SS radio");

console.log("\nArithmetic drawer\n");
const he = phyBreakdown({ standard: "ax", widthMHz: 20, nss: 2, mcs: 9, giUs: 0.8 });
ok(he && he.nsd === 234 && he.nDbps === 3120, `HE 20 MHz 2SS MCS9 is 234 × 2 × 8 × 5/6 = 3120 (got ${he && he.nDbps})`);
ok(he && near(he.phyMbps, phyRateMbps({ standard: "ax", widthMHz: 20, nss: 2, mcs: 9, giUs: 0.8 }), 1e-9), "breakdown matches phyRateMbps");
ok(near(he.phyMbps, 229.411765, 1e-5), `HE PHY 229.411765 (got ${he.phyMbps})`);
const tax = ssidAirtimeBreakdown(2, "5");
ok(tax.extra === 1 && near(tax.fraction, 0.0068359375, 1e-12), `one extra 5 GHz SSID is 0.0068359375 (got ${tax.fraction})`);
ok(ssidAirtimeFraction(2, "5") === tax.fraction, "fraction helper matches breakdown");
ok(ssidAirtimeFraction(1, "2.4") === 0, "one SSID adds no extra tax");

const shot = estimateCapacity({
  radios: [
    { id: "r24", enabled: false, band: "2.4", standard: "ax", widthMHz: 20, nss: 2 },
    { id: "r5", enabled: true, band: "5", standard: "ax", widthMHz: 20, nss: 2 },
    { id: "r6", enabled: true, band: "6", standard: "ax", widthMHz: 40, nss: 2 },
  ],
  client: { standard: "ax", nss: 2, bands: ["2.4", "5", "6"], maxWidthMHz: 160 },
  quality: "typical",
  neighbor: "typical",
  ssidCount: 2,
  activeClients: 30,
  targetMbps: 5,
  splitMode: "steered",
});
const shotText = capacityArithmetic(shot).map((s) => s.text).join("\n");
ok(shotText.includes("234 × 2 × 8 × 5/6 = 3120"), "5 GHz N_DBPS line");
ok(shotText.includes("468 × 2 × 8 × 5/6 = 6240"), "6 GHz N_DBPS line");
ok(shotText.includes("3120 / 13.6 µs = 229.411765 Mbps"), "5 GHz PHY line");
ok(shotText.includes("0.0068359375"), "SSID tax shows the beacon fraction");
ok(shotText.includes("54.682445"), "5 GHz usable at working precision");
ok(shotText.includes("109.36489"), "6 GHz usable at working precision");
ok(shotText.includes("5 GHz: 15 people get 3.645496 Mbps each"), "5 GHz group speed, not a room average");
ok(shotText.includes("People on different radios do not share one speed."), "headline refuses the average");
ok(!shotText.includes("5.468244"), "room average is not printed");
ok(shot.bindingBand === "5", "5 GHz is the tight band at a 50/50 split");
ok(shot.modeledClients === 21, `screenshot seats floor to 21 (got ${shot.modeledClients})`);
ok(shotText.includes("floor = 21"), "seat line floors the tight radio");
ok(shot.recommendedClients === 14, "30% margin recommends 14");
ok(shotText.includes("Off. Left out of the pool."), "disabled 2.4 GHz is called out");

const alone = estimateCapacity({
  radios: [{ id: "r5", enabled: true, band: "5", standard: "ac", widthMHz: 20, nss: 3, giUs: 0.4 }],
  client: { standard: "ac", nss: 3, bands: ["2.4", "5"], maxWidthMHz: 80 },
  quality: "excellent",
  neighbor: "isolated",
  ssidCount: 1,
  activeClients: 1,
  targetMbps: 2,
  splitMode: "best",
});
const aloneText = capacityArithmetic(alone).map((s) => s.text).join("\n");
ok(aloneText.includes("MAC efficiency = 0.50"), "one client uses 50% MAC");
ok(aloneText.includes("The seat count uses MAC 0.40"), "seat count rescales to the 40% MAC");
ok(alone.radios[0].phyMath && near(alone.radios[0].phyMath.phyMbps, alone.radios[0].phyMbps, 1e-9), "radio carries matching PHY terms");

console.log("\nAP-755 with a Wi-Fi 6 laptop\n");
const ap755 = estimateCapacity({
  radios: radiosFromAp(byId["ap-755"]),
  client: { standard: "ax", nss: 2, bands: ["2.4", "5"], maxWidthMHz: 80 },
  quality: "typical",
  neighbor: "typical",
  ssidCount: 3,
  activeClients: 30,
  targetMbps: 2,
  splitMode: "steered",
});
const ap24 = ap755.radios.find((r) => r.band === "2.4");
const ap6 = ap755.radios.find((r) => r.band === "6");
ok(ap24.standardLabel === "Wi-Fi 6 (802.11ax)", `2.4 negotiated label (${ap24.standardLabel})`);
ok(!ap24.standardLabel.includes("6E"), "2.4 GHz does not say 6E");
ok(ap24.apStandard === "be", "2.4 AP PHY stays Wi-Fi 7");
ok(
  ap24.notes.some((n) => n.includes("The AP radio is Wi-Fi 7")),
  "2.4 note says the AP radio is Wi-Fi 7",
);
ok(
  ap6.skip && ap6.skip.startsWith("The client has no 6 GHz radio"),
  `6 GHz names the client (${ap6.skip})`,
);
ok(!/does not have a 6 GHz radio/i.test(ap6.skip || ""), "6 GHz does not blame the AP");
const ap755Text = capacityArithmetic(ap755).map((s) => `${s.heading}\n${s.text}`).join("\n");
ok(ap755Text.includes("Wi-Fi 6 (802.11ax)"), "arithmetic uses the Wi-Fi 6 label on 2.4");
ok(ap755Text.includes("The AP radio is Wi-Fi 7"), "arithmetic says the AP is Wi-Fi 7");
ok(ap755Text.includes("The client has no 6 GHz radio"), "arithmetic keeps the 6 GHz radio and names the client");

const ap755phone = estimateCapacity({
  radios: radiosFromAp(byId["ap-755"]),
  client: { standard: "be", nss: 2, bands: ["2.4", "5", "6"], maxWidthMHz: 160 },
  quality: "typical",
  neighbor: "typical",
  ssidCount: 2,
  activeClients: 30,
  targetMbps: 5,
  splitMode: "steered",
});
ok(ap755phone.radios.find((r) => r.band === "2.4").standard === "be", "Wi-Fi 7 client keeps Wi-Fi 7 on 2.4");
ok(ap755phone.radios.find((r) => r.band === "6").phyMbps > 0, "Wi-Fi 7 client uses the AP-755 6 GHz radio");

console.log("\nDefault dual-band story does not pool radios\n");
const dual = estimateCapacity({
  radios: [
    { id: "r24", enabled: true, band: "2.4", standard: "ax", widthMHz: 20, nss: 2 },
    { id: "r5", enabled: true, band: "5", standard: "ax", widthMHz: 20, nss: 2 },
  ],
  client: { standard: "ax", nss: 2, bands: ["2.4", "5"], maxWidthMHz: 80 },
  quality: "typical",
  neighbor: "typical",
  ssidCount: 3,
  activeClients: 30,
  targetMbps: 2,
  splitMode: "steered",
});
const dual24 = dual.radios.find((r) => r.band === "2.4");
const dual5 = dual.radios.find((r) => r.band === "5");
const dualAvg = (dual24.usableMbps + dual5.usableMbps) / 30;
ok(dual.bindingBand === "5", "default story is limited by 5 GHz");
ok(dual.modeledClients === 31, `modeled maximum floors to 31 (got ${dual.modeledClients})`);
ok(dual.recommendedClients === 21, `30% margin recommends 21 (got ${dual.recommendedClients})`);
ok(near(dual5.perUserMbps, 2.13, 0.05), `5 GHz group gets ~2.13 Mbps (got ${dual5.perUserMbps.toFixed(2)})`);
ok(near(dual24.perUserMbps, 8.4, 0.15), `2.4 GHz group gets ~8.4 Mbps (got ${dual24.perUserMbps.toFixed(2)})`);
ok(dual.perUserMbps === dual5.perUserMbps, "reported speed is the tight band, not a blend");
ok(Math.abs(dual.perUserMbps - dualAvg) > 0.5, "room average is not the reported speed");
ok(dual.speedStory === "crowd", "30 people on both bands is a crowd");
ok(dual.verdict === "fits", "30 people meet 2 Mbps and sit past the recommended cap");

const dualOne = estimateCapacity({
  radios: [
    { id: "r24", enabled: true, band: "2.4", standard: "ax", widthMHz: 20, nss: 2 },
    { id: "r5", enabled: true, band: "5", standard: "ax", widthMHz: 20, nss: 2 },
  ],
  client: { standard: "ax", nss: 2, bands: ["2.4", "5"], maxWidthMHz: 80 },
  quality: "typical",
  neighbor: "typical",
  ssidCount: 3,
  activeClients: 1,
  targetMbps: 2,
  splitMode: "steered",
});
const oneSum = dualOne.radios.reduce((sum, r) => sum + (r.usableMbps || 0), 0);
ok(dualOne.speedStory === "station", "one client does not share both radios");
ok(near(dualOne.perUserMbps, 67.9, 0.5), `one client reports the faster radio ~68 Mbps (got ${dualOne.perUserMbps.toFixed(1)})`);
ok(dualOne.perUserMbps < oneSum - 20, "one client does not add the radios");

console.log("\nDevice presets and stories\n");
const m4book = deviceById("macbook-pro-m4");
const m4pad = deviceById("ipad-pro-m4");
const air2device = deviceById("ipad-air-2");
ok(m4book.standard === "ax" && m4book.bands.includes("6") && m4book.detail.includes("6E"), "M4 MacBook Pro is Wi-Fi 6E");
ok(m4pad.standard === "ax" && m4pad.bands.includes("6") && m4pad.detail.includes("6E"), "M4 iPad Pro is Wi-Fi 6E");
ok(air2device.maxWidthMHz === 80 && air2device.nss === 2, "iPad Air 2 can do 80 MHz");

const air2narrow = estimateCapacity({
  radios: [{ id: "r5", enabled: true, band: "5", standard: "ac", widthMHz: 20, nss: 3 }],
  client: { standard: air2device.standard, nss: air2device.nss, bands: air2device.bands, maxWidthMHz: air2device.maxWidthMHz },
  quality: "excellent",
  neighbor: "isolated",
  ssidCount: 1,
  activeClients: 30,
  targetMbps: 2,
  splitMode: "best",
});
ok(air2narrow.radios[0].widthMHz === 20 && near(air2narrow.radios[0].phyMbps, 173.3), "Air 2 on a 20 MHz AP stays at 173 Mbps");

const air2wide = estimateCapacity({
  radios: [{ id: "r5", enabled: true, band: "5", standard: "ac", widthMHz: 80, nss: 2 }],
  client: { standard: air2device.standard, nss: air2device.nss, bands: air2device.bands, maxWidthMHz: air2device.maxWidthMHz },
  quality: "excellent",
  neighbor: "isolated",
  ssidCount: 1,
  activeClients: 1,
  targetMbps: 2,
  splitMode: "best",
});
ok(air2wide.radios[0].widthMHz === 80, "Air 2 takes 80 MHz when the AP offers it");

const officeA = scenarioInput("office");
officeA.radios[1].widthMHz = 80;
officeA.radios[0].enabled = false;
officeA.mcsOverride = 11;
const officeB = scenarioInput("office");
ok(officeB.radios.length === 2 && officeB.radios.every((r) => r.enabled && r.widthMHz === 20), "office story radios are a fresh 20 MHz pair");
ok(officeB.mcsOverride == null && officeB.margin === 0.3 && officeB.splitMode === "steered", "office story clears MCS and resets the margin");
ok(scenarioInput("office") !== officeB && scenarioInput("ipad1").radios[0].widthMHz === 20, "each story call is its own snapshot");
ok(scenarioInput("air2").deviceId === "ipad-air-2" && scenarioInput("triband").radios[2].widthMHz === 40, "air2 and tri-band snapshots");

const perBand = estimateCapacity({
  radios: [
    { id: "r24", enabled: true, band: "2.4", standard: "ax", widthMHz: 20, nss: 2 },
    { id: "r5", enabled: true, band: "5", standard: "ax", widthMHz: 20, nss: 2 },
  ],
  client: { standard: "ax", nss: 2, bands: ["2.4", "5"], maxWidthMHz: 80 },
  quality: "typical",
  neighbor: "typical",
  neighborByBand: { "2.4": "crowded" },
  ssidCount: 1,
  activeClients: 30,
  targetMbps: 2,
  splitMode: "steered",
});
ok(perBand.radios.find((r) => r.band === "2.4").rfUsable === 0.4, "2.4 GHz can be crowded on its own");
ok(perBand.radios.find((r) => r.band === "5").rfUsable === 0.6, "5 GHz keeps the floor assumption");
ok(perBand.sameRf === false, "mixed RF is called out");

console.log();
if (failed) {
  console.error(`${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`all ${passed} passed`);
