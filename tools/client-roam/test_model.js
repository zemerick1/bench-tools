#!/usr/bin/env node
/**
 * Client roam model tests — run: node tools/client-roam/test_model.js
 */
import {
  APS,
  DEFAULTS,
  JOURNEYS,
  MIN_RSSI_DBM,
  RF_FLOOR_DBM,
  ROAM,
  STORIES,
  WING,
  apById,
  countWalls,
  coverageGrid,
  deskOf,
  dist3dFt,
  pathLossDb,
  rssiDbm,
  range3dFt,
  cartoonRadiusFt,
  cellRadii,
  observeAt,
  roamFrames,
  roomById,
  simulateJourney,
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

function story(id) {
  return STORIES.find((item) => item.id === id);
}

function roamS(run) {
  return run.roams.map((r) => r.s);
}

console.log("Walls\n");
const a2 = apById("A2");
const a3 = apById("A3");
const b2 = apById("B2");
const deskA2 = deskOf(roomById("A2"));
ok(countWalls(deskA2.x, deskA2.y, a2.x, a2.y) === 0, "same room 0 walls");
ok(countWalls(deskA2.x, deskA2.y, a3.x, a3.y) === 1, "party wall 1 wall");
ok(countWalls(deskA2.x, deskA2.y, b2.x, b2.y) === 2, "across the hall 2 walls");

console.log("\nRF\n");
ok(dist3dFt(a2.x, a2.y, a2) > 0, "3D distance not zero under AP");
ok(near(dist3dFt(a2.x, a2.y, a2), WING.apHeightFt - WING.clientHeightFt), "under AP is the 5 ft height delta");
const dDesk = dist3dFt(deskA2.x, deskA2.y, a2);
ok(near(pathLossDb(dDesk, 1) - pathLossDb(dDesk, 0), 14), "extra wall ≈ +14 dB");
const r15 = range3dFt(15, 12, 0);
const r21 = range3dFt(21, 12, 0);
ok(near(r21 / r15, 10 ** (6 / 30), 1e-9), "+6 dB range ×10**(6/30)");
ok(MIN_RSSI_DBM[6] === -90 && MIN_RSSI_DBM[12] === -87 && MIN_RSSI_DBM[24] === -82, "min RSSI table");
ok(RF_FLOOR_DBM === -90, "RF floor −90");

console.log("\nCoverage\n");
const low = coverageGrid({ powerDbm: 15, minRateMbps: 6 }).cells;
const high = coverageGrid({ powerDbm: 15, minRateMbps: 24 }).cells;
const rfLow = low.filter((c) => c.rfPresent).length;
const rfHigh = high.filter((c) => c.rfPresent).length;
const connLow = low.filter((c) => c.connectIds.includes("A2")).length;
const connHigh = high.filter((c) => c.connectIds.includes("A2")).length;
ok(rfLow === rfHigh && rfLow > 0, "min rate does not change rf cells");
ok(connHigh < connLow, "min rate shrinks connect cells");
const quiet = coverageGrid({ powerDbm: 8, minRateMbps: 12 }).cells;
const loud = coverageGrid({ powerDbm: 20, minRateMbps: 12 }).cells;
const quietA2 = quiet.filter((c) => c.connectIds.includes("A2")).length;
const loudA2 = loud.filter((c) => c.connectIds.includes("A2")).length;
ok(loudA2 > quietA2, "more power grows A2’s usable cell");
const rQuiet = cartoonRadiusFt(8, MIN_RSSI_DBM[6]);
const rLoud = cartoonRadiusFt(20, MIN_RSSI_DBM[6]);
const rMbr = cartoonRadiusFt(15, MIN_RSSI_DBM[24]);
const rRf = cartoonRadiusFt(15, RF_FLOOR_DBM);
ok(rLoud > rQuiet, "cartoon rings grow with power");
ok(rMbr < rRf, "min-rate inner ring is smaller than RF ring");
ok(DEFAULTS.dwellSec === 5, "dwell defaults to 5 s");
ok(DEFAULTS.minRateMbps === 6, "min basic rate defaults to 6 Mbps");

console.log("\nRoam frames\n");
const frames = roamFrames();
ok(frames.gapMs === frames.scanMs + frames.handshakeMs, "roamFrames sums");
ok(
  frames.frames.reduce((n, f) => n + f.ms, 0) === frames.gapMs,
  "frame list sums to gap",
);
ok(
  roamFrames({ auth: "dot1x", r: false }).gapMs > roamFrames({ auth: "psk", r: false }).gapMs,
  "802.1X gap >> PSK without r",
);
ok(roamFrames({ auth: "dot1x", r: false }).handshakeMs === 800, "802.1X handshake 800 ms");
ok(roamFrames({ auth: "psk", r: false }).handshakeMs === 50, "PSK handshake 50 ms");
ok(roamFrames({ v: true }).scanMs === 0, "11v scan is none");
ok(roamFrames({ k: true, v: false }).scanMs === 40, "11k scan 40 ms");
ok(ROAM.holdDbm === -75, "sticky hold −75");

console.log("\n11r / 11k / 11v\n");
const sticky = story("sticky");
const base = simulateJourney(sticky);
const withR = simulateJourney({ ...sticky, r: true });
const withV = simulateJourney({ ...sticky, v: true });
ok(withV.roams.length > 0 && withV.roams[0].trigger === "btm", "11v is the AP asking the sticky client to leave");
ok(
  !base.roams.length || base.samples[base.samples.length - 1].servingId === "A2",
  "high power without v stays sticky — 11r alone does not unstick",
);
ok(!withR.roams.length || withR.roams[0].kind === "ft", "if 11r roams, it is FT");

const plain = simulateJourney(DEFAULTS);
const ft = simulateJourney({ ...DEFAULTS, r: true });
const withKDef = simulateJourney({ ...DEFAULTS, k: true });
ok(plain.roams.length > 0 && ft.roams.length > 0, "default A2→A3 roams");
ok(near(ft.roams[0].s, plain.roams[0].s, 1.2), "11r leaves at the same place");
ok(ft.roams[0].kind === "ft", "11r is FT, not a drop");
ok(
  plain.roams[0].kind === "drop" ||
    plain.roams[0].kind === "rejoin" ||
    plain.roams[0].kind === "hard",
  "without r the client drops or hard-roams",
);
ok(near(withKDef.roams[0].s, plain.roams[0].s, 1.2), "11k leaves at the same place");

ok(JOURNEYS.some((j) => j.id === "next-door" && j.fromId === "A2" && j.toId === "A3"), "next-door journey");
ok(APS.length === 8 && WING.w === 120 && WING.h === 50, "wing is 120×50 with 8 APs");
const flicker = simulateJourney({
  powerDbm: 12,
  minRateMbps: 24,
  fromId: "A1",
  toId: "A4",
  v: true,
  k: true,
  r: false,
  auth: "dot1x",
});
ok(flicker.roams.length < 12, `hallway at 12 dBm / 24 Mbps does not ping-pong (got ${flicker.roams.length})`);

console.log("\nDrop / FT\n");
const harsh = simulateJourney({
  powerDbm: 8,
  minRateMbps: 24,
  fromId: "A1",
  toId: "B4",
  r: false,
  k: false,
  v: false,
  auth: "dot1x",
});
ok(
  harsh.roams.some((r) => r.kind === "drop" || r.kind === "hard"),
  "without r, a weak cell causes a drop or hard roam",
);
ok(
  harsh.roams.filter((r) => r.kind === "drop" || r.kind === "rejoin").every((r) => r.kind !== "ft"),
  "drop and rejoin are never FT",
);
const desk = deskOf(roomById("A2"));
const apA2 = apById("A2");
const under = rssiDbm(15, dist3dFt(desk.x, desk.y, apA2), 0);
ok(under <= -35 && under >= -55, `in-room RSSI is in the −40s (got ${under.toFixed(1)})`);
const r8 = rssiDbm(8, dist3dFt(desk.x, desk.y, apA2), 0);
const r20 = rssiDbm(20, dist3dFt(desk.x, desk.y, apA2), 0);
ok(near(r20 - r8, 12, 0.2), "TX power is log: +12 dB at the AP is +12 dB at the client, not a linear fade to the cell edge");
ok(r8 > -58, "even at 8 dBm, sitting under the AP is still a strong signal");
const hallWalk = simulateJourney({ powerDbm: 15, minRateMbps: 6, fromId: "A2", toId: "A3" });
const hall = hallWalk.samples.find((s) => s.roomId === "hall");
ok(hall && hall.servingId, "in the hall at 15 dBm / 6 Mbps the client is still associated");
const relieved = simulateJourney({
  powerDbm: 20,
  minRateMbps: 6,
  fromId: "A1",
  toId: "B4",
  r: true,
  auth: "dot1x",
});
ok(!relieved.roams.some((r) => r.kind === "drop"), "power up + 6 Mbps does not drop the far walk");
ok(relieved.roams.some((r) => r.kind === "ft"), "associated roam with 11r is FT");

console.log();
if (failed) {
  console.error(`${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`all ${passed} passed`);
