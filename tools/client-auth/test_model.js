#!/usr/bin/env node
/**
 * Client auth model tests — run: node tools/client-auth/test_model.js
 */
import { DEFAULTS, STORIES, simulate, hopAt, hopsHappened } from "./model.js";

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

function mergeStory(story) {
  return { ...DEFAULTS, ...story };
}

function runOf(src = {}) {
  return simulate({ ...DEFAULTS, ...src });
}

function radiusHops(run) {
  return run.hops.filter((h) => h.wire === "radius");
}

function deviceRadius(h) {
  return (h.from === "device" && h.to === "radius") || (h.from === "radius" && h.to === "device");
}

const ACTORS = new Set(["device", "authenticator", "radius", "portal"]);
const WIRES = {
  eap: ["device", "authenticator"],
  assoc: ["device", "authenticator"],
  radius: ["authenticator", "radius"],
  https: ["device", "portal"],
};

function wireOk(h) {
  const ends = WIRES[h.wire];
  if (!ends) return false;
  return (h.from === ends[0] && h.to === ends[1]) || (h.from === ends[1] && h.to === ends[0]);
}

console.log("Shape\n");
ok(DEFAULTS.method === "open", "default method Open");
ok(DEFAULTS.medium === "ap", "default medium AP");
ok(STORIES.length === 6, "six stories, security order");
ok(
  STORIES.map((s) => s.id).join(" ") === "open mac portal peap teap eap-tls",
  "story ids Open → MAC → portal → tunneled EAP → EAP-TLS",
);

console.log("\nNo device ↔ RADIUS\n");
const methods = ["open", "eap-tls", "peap", "eap-ttls", "teap", "mac", "portal"];
for (const method of methods) {
  const run = runOf({ method, clientCert: method === "eap-tls" ? "trusted" : "none" });
  ok(!run.hops.some(deviceRadius), `${method}: no device↔radius`);
}
for (const story of STORIES) {
  const run = runOf(mergeStory(story));
  ok(!run.hops.some(deviceRadius), `story ${story.id}: no device↔radius`);
  ok(
    run.hops.every((h) => ACTORS.has(h.from) && ACTORS.has(h.to) && wireOk(h)),
    `story ${story.id}: actors and wires`,
  );
  if (story.method !== "portal") {
    ok(
      run.hops.every((h) => h.from !== "portal" && h.to !== "portal"),
      `story ${story.id}: portal actor stays off stage`,
    );
  }
}

console.log("\nMAC\n");
const mac = runOf({ method: "mac", clientCert: "none" });
ok(mac.hops.every((h) => h.wire !== "eap"), "MAC: zero EAP hops");
ok(mac.hops.some((h) => h.wire === "radius" && h.kind === "mac"), "MAC: RADIUS Access-Request with MAC");
ok(mac.trust.deviceTrustsServer === null && mac.trust.serverTrustsDevice === null, "MAC: trust n/a");
ok(mac.certs.server === null && mac.certs.client === null, "MAC: no certs");

console.log("\nPEAP + unknown server\n");
const peapBad = runOf({ method: "peap", serverCert: "unknown", clientCert: "none" });
ok(!peapBad.hops.some((h) => h.kind === "inner" && /password/i.test(h.label)), "PEAP unknown: no inner password hop");
ok(!peapBad.hops.some((h) => h.kind === "inner"), "PEAP unknown: no inner hops at all");
ok(peapBad.outcome === "reject", "PEAP unknown: outcome reject");
ok(peapBad.trust.deviceTrustsServer === false, "PEAP unknown: deviceTrustsServer false");
ok(peapBad.hops[peapBad.hops.length - 1].kind === "reject", "PEAP unknown: fail closed at reject");

console.log("\nEAP-TLS expired client\n");
const expired = runOf({ method: "eap-tls", clientCert: "expired" });
const expKinds = expired.hops.map((h) => h.kind);
const certIdx = expKinds.lastIndexOf("tls-client-cert");
ok(certIdx >= 0, "expired client: has tls-client-cert");
ok(expKinds[certIdx + 1] === "reject", "expired client: reject at client-cert");
ok(expired.outcome === "reject", "expired client: outcome reject");
ok(expired.trust.serverTrustsDevice === false, "expired client: serverTrustsDevice false");
ok(expired.trust.deviceTrustsServer === true, "expired client: device still trusted the server");
ok(!expired.hops.some((h) => h.kind === "success" || h.kind === "key"), "expired client: no success/key");

console.log("\nOpen\n");
const openNet = runOf({ method: "open" });
ok(openNet.hops.every((h) => h.wire !== "eap" && h.wire !== "radius"), "open: no EAP, no RADIUS");
ok(openNet.hops.length === 1, "open: just the join");
ok(!openNet.hops.some((h) => h.kind === "key"), "open: no 4-way");
ok(openNet.certs.server === null && openNet.certs.client === null, "open: no certs");

console.log("\nEAP-TLS happy\n");
const happy = runOf({ method: "eap-tls", clientCert: "trusted" });
ok(happy.trust.deviceTrustsServer === true, "happy: deviceTrustsServer");
ok(happy.trust.serverTrustsDevice === true, "happy: serverTrustsDevice");
ok(happy.outcome === "accept", "happy: accept");
const lastRad = radiusHops(happy).at(-1);
ok(lastRad && lastRad.kind === "accept", "happy: last RADIUS kind accept");
ok(happy.hops.some((h) => h.wire === "eap" && h.kind === "success"), "happy: EAP success hop");
ok(happy.hops.filter((h) => h.kind === "key").length === 1, "happy: one 4-way beat, not four messages");
ok(happy.hops.some((h) => h.kind === "key" && h.label === "4-way"), "happy: 4-way is labeled");
ok(happy.hops.length >= 8 && happy.hops.length <= 22, `happy TLS grouped hops (got ${happy.hops.length})`);
const eapId = happy.hops.find((h) => h.wire === "eap" && h.label === "EAP-Request");
ok(eapId && eapId.from === "authenticator" && eapId.to === "device", "EAP-Request is NAD → device");
ok(
  radiusHops(happy).every((h) => h.from === "authenticator" || h.from === "radius"),
  "RADIUS packets never start at the device",
);
ok(
  radiusHops(happy).filter((h) => h.label === "Access-Request").every((h) => h.from === "authenticator" && h.to === "radius"),
  "Access-Request is NAD → RADIUS, never NAD → device",
);
ok(
  radiusHops(happy).some((h) => h.label === "Access-Request"),
  "happy: RADIUS Access-Request is a real packet name",
);
ok(lastRad && lastRad.label === "Access-Accept", "happy: last RADIUS is Access-Accept");
ok(
  happy.hops.every((h) => typeof h.what === "string" && h.what.length > 20),
  "every hop has a real-world what",
);
ok(
  /username|name on the cert/i.test(happy.hops.find((h) => h.label === "EAP-Response")?.what || ""),
  "EAP-TLS response is the username (or cert name)",
);
ok(happy.certs.server?.ok === true && happy.certs.client?.ok === true, "happy: both certs ok");

console.log("\nPortal\n");
const portal = runOf({ method: "portal", clientCert: "none" });
ok(
  portal.hops.some((h) => h.wire === "https" && h.from === "device" && h.to === "portal"),
  "portal: HTTPS device→portal",
);
ok(
  portal.hops.some((h) => h.wire === "https" && h.from === "portal" && h.to === "device"),
  "portal: HTTPS portal→device",
);
ok(
  portal.hops.filter((h) => h.wire === "https").every((h) => (h.from === "device" || h.from === "portal") && (h.to === "device" || h.to === "portal")),
  "portal: HTTPS is only device↔portal",
);
ok(
  radiusHops(portal).every((h) => (h.from === "authenticator" && h.to === "radius") || (h.from === "radius" && h.to === "authenticator")),
  "portal: RADIUS only authenticator↔radius",
);
ok(!portal.hops.some((h) => h.wire === "eap"), "portal: no EAP");

console.log("\nPEAP RADIUS names\n");
const peapOk = runOf({ method: "peap", clientCert: "none" });
ok(
  peapOk.hops.some((h) => h.wire === "radius" && h.label === "Access-Request"),
  "PEAP: Access-Request on the right wire",
);
ok(
  peapOk.hops.some((h) => h.wire === "radius" && h.label === "Access-Challenge"),
  "PEAP: Access-Challenge on the right wire",
);
ok(
  radiusHops(peapOk).at(-1)?.label === "Access-Accept",
  "PEAP: last RADIUS hop is Access-Accept",
);
ok(
  peapOk.hops.some((h) => h.kind === "inner" && h.wire === "radius" && h.label === "Access-Request"),
  "PEAP: inner password is wrapped in Access-Request, not left as EAP-only",
);
ok(
  /anonymous|not the real username/i.test(peapOk.hops.find((h) => h.label === "EAP-Response")?.what || ""),
  "PEAP EAP-Response is an outer name, not the real username",
);
ok(
  /real username/i.test(peapOk.hops.find((h) => h.kind === "inner" && h.label === "inner id")?.what || ""),
  "PEAP inner hop is where the real username is sent",
);
ok(
  /password proof/i.test(peapOk.hops.find((h) => h.label === "password")?.what || ""),
  "PEAP password hop says password proof",
);
ok(peapOk.hops.some((h) => h.kind === "tunnel"), "PEAP: tunnel-established hop");
ok(
  peapOk.hops.filter((h) => h.kind === "inner").every((h) => h.inTunnel),
  "PEAP: inner hops ride inside the tunnel",
);
ok(peapOk.hops.some((h) => h.kind === "key" && h.label === "4-way"), "PEAP: 4-way after success");

console.log("\nTimes and helpers\n");
ok(
  happy.hops.every((h) => h.dur >= 1.3 && h.dur <= 1.6),
  "dur ~1.45s so the chip is readable",
);
ok(Math.abs(happy.duration - (happy.hops.at(-1).t + happy.hops.at(-1).dur)) < 1e-9, "duration = last t+dur");
ok(happy.hops[0].t === 0, "first hop at 0");
ok(
  happy.hops.every((h, i) => i === 0 || Math.abs(h.t - (happy.hops[i - 1].t + happy.hops[i - 1].dur)) < 1e-9),
  "hop.t is cumulative",
);
ok(hopAt(happy, -1) === null, "hopAt before start is null");
ok(hopAt(happy, 0) === happy.hops[0], "hopAt(0) is first hop");
ok(hopAt(happy, happy.hops[0].t + happy.hops[0].dur / 2) === happy.hops[0], "hopAt mid-first");
ok(hopsHappened(happy, -1).length === 0, "hopsHappened before start is empty");
ok(hopsHappened(happy, 0).length === 1, "hopsHappened at 0 includes first");
ok(hopsHappened(happy, happy.duration).length === happy.hops.length, "hopsHappened at end is all");
const mid = happy.hops[3];
ok(hopsHappened(happy, mid.t).every((h) => h.t <= mid.t), "hopsHappened t <= now");

console.log("\nFail closed\n");
for (const src of [
  { method: "peap", serverCert: "expired", clientCert: "none" },
  { method: "peap", serverCert: "name", clientCert: "none" },
  { method: "eap-tls", ocsp: "unreachable" },
  { method: "eap-tls", clientCert: "revoked" },
  { method: "peap", clientCert: "none", passwordOk: false },
]) {
  const run = runOf(src);
  const i = run.hops.findIndex((h) => h.kind === "reject");
  ok(run.outcome === "reject" && i === run.hops.length - 1, `fail closed ${JSON.stringify(src)}`);
}

const teap = runOf({ method: "teap", inner: "mschapv2", clientCert: "none" });
ok(teap.hops.some((h) => h.kind === "tls-server-cert"), "TEAP: outer TLS");
ok(teap.hops.some((h) => h.kind === "inner"), "TEAP: one inner");
ok(!teap.hops.some((h) => /tlv/i.test(h.label)), "TEAP: not every TLV");

console.log("\nHop counts\n");
for (const story of STORIES) {
  const run = runOf(mergeStory(story));
  console.log(`  ${story.id.padEnd(18)} ${String(run.hops.length).padStart(2)}  ${run.outcome}`);
  ok(run.hops.length > 0, `${story.id} has hops`);
}

console.log();
if (failed) {
  console.error(`${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`all ${passed} passed`);
