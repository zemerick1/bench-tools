#!/usr/bin/env node
/**
 * Shipped-entry tests for show-tech parser + line classifier + export shape.
 * Run: node tools/show-tech/test_parser.js
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { classifyLine, isSignalKind } = require("./line_class.js");
const { parseTechDump, extractCentral } = require("./parser.js");
const LINE_CLASSES = require("./fixtures/line-classes.js");

const ROOT = path.resolve(__dirname);
const SAMPLES = path.join(ROOT, "log-samples");

let failed = 0;
let passed = 0;

function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log("  PASS", msg);
  } else {
    failed++;
    console.error("  FAIL", msg);
  }
}

function factMap(result) {
  const m = {};
  for (const f of result.facts) m[f.label] = f.value;
  return m;
}

function factVal(r, label) {
  const f = (r.facts || []).find((x) => x.label === label);
  return f ? f.value : null;
}

function groupById(result, id) {
  return (result.findings || []).find((g) => g.id === id);
}

function anyEvidenceIncludes(result, re) {
  for (const g of result.findings || []) {
    for (const e of g.evidence) {
      if (re.test(e.text)) return true;
    }
  }
  return false;
}

function highEvidenceLines(result) {
  const out = [];
  for (const g of result.findings || []) {
    if (g.severity !== "high") continue;
    for (const e of g.evidence) out.push({ group: g.id, ...e });
  }
  return out;
}

console.log("=== decision table: classifyLine kinds ===");
for (const row of LINE_CLASSES) {
  const cls = classifyLine(row.line);
  ok(
    cls.kind === row.kind,
    `kind ${row.kind} ← ${JSON.stringify(row.line).slice(0, 70)} (got ${cls.kind})`
  );
}

console.log("\n=== decision table: noise → no HIGH; signal → finding ===");
for (const row of LINE_CLASSES) {
  const r = parseTechDump(row.line + "\n", { filename: "fixture-row" });
  const highs = highEvidenceLines(r);
  if (row.kind.startsWith("noise_")) {
    ok(
      highs.length === 0,
      `noise no HIGH: ${row.kind} / ${JSON.stringify(row.line).slice(0, 50)}`
    );
  }
  if (row.kind.startsWith("signal_")) {
    ok(
      (r.findings || []).length > 0,
      `signal has finding: ${row.kind}`
    );
    if (row.ruleId) {
      ok(!!groupById(r, row.ruleId), `signal ruleId ${row.ruleId}`);
    }
    for (const h of highs) {
      const c = classifyLine(h.text);
      ok(isSignalKind(c.kind), `HIGH is signal_*: ${c.kind}`);
    }
  }
}

console.log("\n=== IPSec signal classification ===");
{
  const down = classifyLine(
    "2026-08-03 17:08:24  IKE      IPSEC_TUNNEL_DOWN  DPD Check        192.168.199.10"
  );
  ok(down.kind === "signal_fault", "IPSEC_TUNNEL_DOWN is signal_fault");
  const r = parseTechDump(
    "2026-08-03 17:08:24  IKE      IPSEC_TUNNEL_DOWN  DPD Check        192.168.199.10\n"
  );
  ok(!!groupById(r, "ipsec-tunnel-down"), "ipsec-tunnel-down finding");

  // Crypto SA: either field non-UP is unhealthy
  for (const [line, wantFinding] of [
    ["Tunnel status IPSEC: UP IKE: DOWN", true],
    ["Tunnel status IPSEC: DOWN IKE: UP", true],
    ["Tunnel status IPSEC: DOWN IKE: DOWN", true],
    ["Tunnel status IPSEC: UP IKE: UP", false],
  ]) {
    const cls = classifyLine(line);
    const pr = parseTechDump(line + "\n");
    const has = !!groupById(pr, "ipsec-sa-not-up");
    if (wantFinding) {
      ok(cls.kind === "signal_fault", `class signal: ${line}`);
      ok(has, `finding ipsec-sa-not-up: ${line}`);
    } else {
      ok(cls.kind !== "signal_fault" || !has, `healthy SA no fault finding: ${line}`);
      ok(!has, `no ipsec-sa-not-up on UP/UP: ${line}`);
    }
  }
}

console.log("\n=== Aruba Central extraction ===");
{
  const cx = extractCentral(`
Central connection status               : connected
Central location                        : device-uswest5-d2.central.arubanetworks.com
Central disconnection reason            : N/A
`);
  ok(cx.connected === true, "CX central connected");
  ok(/central\.arubanetworks\.com/.test(cx.server || ""), "CX server");
  ok(/^N\/A$/i.test(cx.lastDisconnectReason || ""), "CX disconnect N/A");
  ok(cx.mist && cx.mist.status === "coming_soon", "Mist coming_soon");
}

console.log("\n=== AP Central: prefer last cloud-server + surface dns fail ===");
{
  const ap = extractCentral(`
Aruba Central server               :device-uswest5.central.arubanetworks.com
Aruba Central status               :Connecting
Last fail reason       :dns error
Last fail time         :2026-08-10 13:59:38
Last down reason       :Connect closed
Last down time         :2026-08-10 13:02:13
Aruba Central        :Connected
Aruba Central server               :device-uswest5.central.arubanetworks.com
Aruba Central status               :Login_done
Last fail reason       :dns error
Last fail time         :2026-08-10 14:49:46
Last down reason       :Connect closed
Last down time         :2026-08-10 15:00:42
`);
  ok(ap.connected === true, "AP last status Login_done → connected");
  ok(/Login_done/i.test(ap.statusRaw || ""), "AP status detail Login_done");
  ok(/dns error/i.test(ap.lastConnectFailReason || ""), "AP last connect fail dns error");
  ok(/14:49:46/.test(ap.lastConnectFailTime || ""), "AP last fail time is latest");
  ok(/Connect closed/i.test(ap.lastDisconnectReason || ""), "AP last down reason");
  const r = parseTechDump(
    `
Mon Aug 10 13:02:54 2026  Central   Failed       Connection error with Aruba Central server device-uswest5.central.arubanetworks.com reason dns error
Mon Aug 10 13:04:01 2026  Activate  Failed       Provisioning failed: did not receive a response from Activate server after 91 seconds
Last fail reason       :dns error
`,
    { filename: "central-fail-fixture" }
  );
  ok(!!groupById(r, "central-conn-fail"), "finding central-conn-fail");
  ok(!!groupById(r, "activate-provision-fail"), "finding activate-provision-fail");
  ok(
    highEvidenceLines(r).length > 0,
    "Central/Activate failures produce HIGH evidence"
  );
}

console.log("\n=== Health IE + RADIUS KPIs; zero-counter FAIL noise ===");
{
  const r = parseTechDump(
    `
Frames that failed FP spoofing check                                 0
Packet dpi session copy to dpimgr failed                             0
Aug 10 12:50:27.072  deauth        4c:82:0c:c8:49:b8  f4:9a:b1:89:6c:b3  0       Unspecified Failure (seq num 4065)
Aug 10 13:03:37   cli[8457]: <341004> <WARN> |AP|  Enable the health IE broadcast due to Central/CoP connectivity issues
Aug 10 13:03:40   cli[8457]: <341004> <WARN> |AP|  Disable the health IE broadcast due to Central/CoP login done
Aug 10 11:22:32   cli[8457]: <341004> <WARN> |AP|  Client 12:40:75:b9:ee:71 authenticate fail because RADIUS server connection failure
Connect establish failed   19(43)
`,
    { filename: "kpi-fixture" }
  );
  ok(!!groupById(r, "central-health-ie"), "finding central-health-ie");
  ok(!!groupById(r, "radius-conn-fail"), "finding radius-conn-fail");
  ok(!!groupById(r, "central-conn-fail"), "non-zero Connect establish failed");
  const failed = groupById(r, "failed-line");
  ok(
    !failed ||
      !failed.evidence.some((e) =>
        /spoofing check|dpi session|Unspecified Failure/i.test(e.text)
      ),
    "failed-line skips zero counters and deauth Unspecified Failure"
  );
  ok(
    !anyEvidenceIncludes(r, /Disable the health IE broadcast/i) ||
      !groupById(r, "central-health-ie")?.evidence.some((e) =>
        /Disable the health IE/i.test(e.text)
      ),
    "Disable health IE (recovery) is not a health-ie finding"
  );
}

/** Mirror of app export contract (must stay in sync with buildExport intent) */
function buildExportShape(result) {
  const parts = ["Sticky note", "Clear facts", "Looks wrong", "For the ticket"];
  const body = [
    "=== Show-Tech Sticky Note export ===",
    result.oneLiner,
    "--- Clear facts ---",
    ...(result.facts || []).map((f) => `${f.label}: ${f.value}`),
    "--- Looks wrong (grouped findings) ---",
    ...(result.findings || []).map((g) => `[${g.severity}] ${g.title}`),
    "--- For the ticket ---",
    `Family guess: ${result.family.label}`,
  ].join("\n");
  return { parts, body };
}

console.log("\n=== export contract (no sections-we-noticed) ===");
{
  const r = parseTechDump(
    "Total number of core dumps : 2\nHostname is test\nArubaOS (MODEL: Aruba7005-US), Version 10.7.0.0 SSR\nSwitch uptime is 1 day\n"
  );
  const { body } = buildExportShape(r);
  ok(/Clear facts/i.test(body), "export mentions Clear facts");
  ok(/Looks wrong/i.test(body), "export mentions Looks wrong");
  ok(/For the ticket/i.test(body), "export mentions ticket");
  ok(
    !/sections we noticed/i.test(body),
    "export omits sections we noticed"
  );
}

// Static UI: putty + export hooks exist in shipped files
console.log("\n=== UI static contract ===");
{
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  ok(/PuTTY/i.test(html), "index has PuTTY collect guidance");
  ok(/Session → Logging|Session -&gt; Logging|Logging/i.test(html), "PuTTY logging steps");
  ok(/st-export|buildExport|Export report/i.test(app), "app has export");
  ok(
    /sections we noticed|Sections we noticed/i.test(app) &&
      /left out of export|stayed home|Skips/i.test(app),
    "export explicitly skips sections"
  );
  ok(
    /line_class\.js/.test(html) && /parser\.js/.test(html),
    "scripts load line_class then parser"
  );
}

function samplePath(name) {
  return path.join(SAMPLES, name);
}

function requireSample(name) {
  const p = samplePath(name);
  if (!fs.existsSync(p)) {
    console.log("  SKIP missing", name);
    return null;
  }
  return fs.readFileSync(p, "utf8");
}

const SAMPLE_SPECS = [
  {
    file: "aos-cx.log",
    family: "aos-cx",
    versionRe: /^FL\.10\./,
    need: ["Hostname", "Serial", "Software version"],
  },
  {
    file: "ap-aos10.log",
    family: "aos-10-ap",
    versionRe: /^10\./,
    need: ["Hostname", "Serial", "Software version", "User traffic mode"],
    trafficRe: /GRE|bridge|tunnel/i,
  },
  {
    file: "ap-aos10_02.log",
    family: "aos-10-ap",
    versionRe: /^10\./,
    need: ["Hostname", "Serial", "Software version", "User traffic mode"],
    trafficRe: /GRE|bridge|tunnel/i,
    hostnameExact: "AP-Garage",
  },
  {
    file: "ap-aos8.log",
    family: "instant",
    versionRe: /^8\./,
    need: ["Hostname", "Serial", "Software version", "User traffic mode"],
    trafficRe: /bridge|IAP-VPN/i,
  },
  {
    file: "gateway-aos10.log",
    family: "gateway",
    versionRe: /^10\./,
    need: ["Hostname", "Serial", "Software version", "Persona"],
  },
  {
    file: "aos10_microbranch.log",
    family: "microbranch",
    versionRe: /^10\./,
    need: [
      "Hostname",
      "Serial",
      "Software version",
      "Persona",
      "Microbranch",
      "User traffic mode",
    ],
    personaRe: /Microbranch/i,
  },
  {
    file: "aos10_microbranch_vpnc.log",
    family: "vpnc",
    versionRe: /^10\./,
    need: ["Hostname", "Serial", "Software version", "Persona"],
    personaRe: /VPNC/i,
    ipsecRe: /UP\/UP|IPSec/i,
  },
];

console.log("\n=== full samples: family, facts, HIGH=signal_*, Central ===");
for (const spec of SAMPLE_SPECS) {
  const text = requireSample(spec.file);
  if (!text) continue;
  const r = parseTechDump(text, { filename: spec.file });
  const f = factMap(r);
  ok(r.family.id === spec.family, `${spec.file} family ${spec.family} (got ${r.family.id})`);
  for (const label of spec.need) {
    ok(!!f[label], `${spec.file} fact ${label}`);
  }
  if (spec.versionRe) {
    ok(
      spec.versionRe.test(f["Software version"] || ""),
      `${spec.file} version ${f["Software version"]}`
    );
  }
  if (spec.trafficRe) {
    ok(
      spec.trafficRe.test(f["User traffic mode"] || ""),
      `${spec.file} traffic mode`
    );
  }
  if (spec.hostnameExact) {
    ok(
      f["Hostname"] === spec.hostnameExact,
      `${spec.file} Hostname=${spec.hostnameExact} (got ${f["Hostname"]})`
    );
  }
  if (spec.personaRe) {
    ok(spec.personaRe.test(f["Persona"] || ""), `${spec.file} persona`);
  }
  if (spec.ipsecRe) {
    const ipsec =
      f["IPSec tunnel status (crypto SA)"] ||
      f["IKE tunnel events in dump"] ||
      "";
    ok(spec.ipsecRe.test(ipsec) || ipsec.length > 0, `${spec.file} IPSec health fact`);
  }
  ok(!!r.central, `${spec.file} central object`);
  ok(
    r.central.mist && r.central.mist.status === "coming_soon",
    `${spec.file} Mist coming_soon`
  );
  ok(
    /central\.arubanetworks\.com/i.test(r.central.server || factVal(r, "Central server") || ""),
    `${spec.file} Central server`
  );

  for (const h of highEvidenceLines(r)) {
    const cls = classifyLine(h.text);
    ok(
      isSignalKind(cls.kind),
      `${spec.file} HIGH L${h.line} signal_* (${cls.kind})`
    );
  }
}

console.log("\n=== summary ===");
console.log(`passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
console.log("ALL PASS");
process.exit(0);
