/**
 * Node tests for Subnet Planner — real buildPlan entry point.
 * Run: node tools/subnet-planner/test_planner.js
 */

import {
  buildPlan,
  suggestPrefix,
  sizedFor,
  usableHosts,
  rangesOverlap,
  parseCidr,
  HEADROOM,
  MIN_PREFIX,
  normalizeSitePosition,
  intToIp,
  reservedPrefixFor,
} from "./planner.js";

let passed = 0;
let failed = 0;

/** @param {boolean} cond @param {string} msg */
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ok  — ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL — ${msg}`);
  }
}

/** Second dotted number of an IPv4/CIDR */
function secondNum(cidr) {
  return Number(cidr.split("/")[0].split(".")[1]);
}
/** Third dotted number */
function thirdNum(cidr) {
  return Number(cidr.split("/")[0].split(".")[2]);
}

console.log("Subnet Planner tests\n");

console.log("sizing");
ok(HEADROOM === 1.5, "50% headroom");
ok(sizedFor(1000) === 1500, "1000 → 1500 sized");
ok(suggestPrefix(1000) === 21, "1000 students → /21");
ok(MIN_PREFIX === 25, "floor /25");
ok(suggestPrefix(3) === 25, "tiny role floors at /25");
ok(normalizeSitePosition("before-vlan") === "second", "legacy before-vlan → second");
ok(normalizeSitePosition("after-vlan") === "third", "legacy after-vlan → third");
ok(normalizeSitePosition("second") === "second", "second stays second");

// —— Third number = site (literal 10.vlan.site) ——————————————————————————

console.log("\nsite as third number");
const third = buildPlan({
  privateSpace: "10.0.0.0/8",
  connectionModel: "connected",
  sitePosition: "third",
  buildings: [
    { name: "HQ", index: 1 },
    { name: "Building 2", index: 2 },
  ],
  roles: [
    { name: "Infrastructure", devicesPerBuilding: 50, vlanId: 10 },
    { name: "Staff", devicesPerBuilding: 50, vlanId: 30 },
    { name: "IoT", devicesPerBuilding: 10, vlanId: 40 },
  ],
});
ok(third.ok, "third-number plan succeeds");
if (!third.ok) console.error(third.errors);

const hqInfra = third.rows.find((r) => r.building === "HQ" && /Infra/i.test(r.role));
const b2Infra = third.rows.find((r) => r.building === "Building 2" && /Infra/i.test(r.role));
ok(hqInfra?.subnet === "10.10.1.0/25", `site 1 infra is 10.10.1.0/25 (got ${hqInfra?.subnet})`);
ok(b2Infra?.subnet === "10.10.2.0/25", `site 2 infra is 10.10.2.0/25 (got ${b2Infra?.subnet})`);
ok(
  third.rows.every((r) => thirdNum(r.subnet) === r.buildingIndex),
  "every row: third number === site number"
);
ok(
  third.rows.every((r) => secondNum(r.subnet) === r.vlanId),
  "every row: second number === VLAN"
);
ok(hqInfra?.gateway === "10.10.1.1", "gateway .1 on site 1");
ok(!third.rows.some((r) => thirdNum(r.subnet) === 0), "no site uses third number 0");
ok(!third.rows.some((r) => /10\.\d+\.32\./.test(r.subnet)), "no stomp-to-.32 for small roles");

// Large role must fail in third mode (would stomp third number)
const thirdBig = buildPlan({
  privateSpace: "10.0.0.0/8",
  connectionModel: "connected",
  sitePosition: "third",
  buildings: [{ name: "HQ", index: 1 }],
  roles: [{ name: "Students", devicesPerBuilding: 2000, vlanId: 20 }],
});
ok(!thirdBig.ok, "2000 students rejected in third-number mode");
ok(
  thirdBig.errors.some((e) => /third number|second number/i.test(e)),
  "error explains third-number limit"
);

// —— Second number = site (literal 10.site.…) ————————————————————————————

console.log("\nsite as second number");
const second = buildPlan({
  privateSpace: "10.0.0.0/8",
  connectionModel: "connected",
  sitePosition: "second",
  buildings: [
    { name: "HQ", index: 1 },
    { name: "Building 2", index: 2 },
  ],
  roles: [
    { name: "Infrastructure", devicesPerBuilding: 50, vlanId: 10 },
    { name: "Students", devicesPerBuilding: 2000, vlanId: 20 },
  ],
});
ok(second.ok, "second-number plan succeeds with large students");
if (!second.ok) console.error(second.errors);

ok(
  second.rows.filter((r) => r.buildingIndex === 1).every((r) => secondNum(r.subnet) === 1),
  "site 1 → all addresses 10.1.x.x"
);
ok(
  second.rows.filter((r) => r.buildingIndex === 2).every((r) => secondNum(r.subnet) === 2),
  "site 2 → all addresses 10.2.x.x"
);
ok(
  !second.rows.some((r) => secondNum(r.subnet) === 0),
  "site never lands on second number 0"
);

const s1 = second.rows.filter((r) => r.buildingIndex === 1);
const s1Students = s1.find((r) => /Students/i.test(r.role));
const s1Infra = s1.find((r) => /Infra/i.test(r.role));
ok(s1Students?.usedPrefix === 20, "students get /20 under site");
ok(secondNum(s1Students.subnet) === 1, "students still under 10.1");
ok(secondNum(s1Infra.subnet) === 1, "infra still under 10.1");

// No live overlaps
let overlap = false;
for (let i = 0; i < second.rows.length; i++) {
  for (let j = i + 1; j < second.rows.length; j++) {
    if (rangesOverlap(parseCidr(second.rows[i].subnet), parseCidr(second.rows[j].subnet))) {
      overlap = true;
    }
  }
}
ok(!overlap, "no overlapping live subnets in second-number plan");

// Lanes under same site do not overlap
const s1Lanes = s1.map((r) => parseCidr(r.reservedLane));
let laneO = false;
for (let i = 0; i < s1Lanes.length; i++) {
  for (let j = i + 1; j < s1Lanes.length; j++) {
    if (rangesOverlap(s1Lanes[i], s1Lanes[j])) laneO = true;
  }
}
ok(!laneO, "reserved lanes under site 1 do not overlap");

// Sticky / capacity mention position
ok(/second number/i.test(second.sticky), "sticky says second number");
ok(/third number/i.test(third.sticky), "sticky says third number");

// Gateway first usable
ok(
  second.rows.every((r) => {
    const n = parseCidr(r.subnet);
    return r.gateway === intToIp((n.network + 1) >>> 0);
  }),
  "gateways are network+1"
);

console.log("\nreserved growth tax");
ok(reservedPrefixFor(25, "second") === 24, "/25 live → reserved /24");
ok(reservedPrefixFor(17, "second") === 17, "/17 live is NOT doubled to /16 (would eat whole site)");
ok(reservedPrefixFor(20, "second") === 19, "/20 live → reserved /19");
ok(reservedPrefixFor(25, "third") === 24, "third mode reserved always /24");

// Screenshot-scale config: many roles + mega + mega-ultra must fit in 10.1.0.0/16
console.log("\nheavy second-number pack (screenshot-scale)");
const heavy = buildPlan({
  privateSpace: "10.0.0.0/8",
  connectionModel: "connected",
  sitePosition: "second",
  buildings: [
    { name: "HQ", index: 1 },
    { name: "Building 2", index: 2 },
  ],
  roles: [
    { name: "Infrastructure (switches & APs)", devicesPerBuilding: 20 },
    { name: "Students", devicesPerBuilding: 2000 },
    { name: "Staff", devicesPerBuilding: 100 },
    { name: "IoT", devicesPerBuilding: 19 },
    { name: "Admin", devicesPerBuilding: 5 },
    { name: "asdf", devicesPerBuilding: 1 },
    { name: "boooo", devicesPerBuilding: 20 },
    { name: "3215", devicesPerBuilding: 25 },
    { name: "mega", devicesPerBuilding: 5000 },
    { name: "mega-ultra", devicesPerBuilding: 15000 },
  ],
});
ok(heavy.ok, "screenshot-scale role list packs into per-site /16");
if (!heavy.ok) console.error(heavy.errors);
ok(heavy.rows.length === 20, "2 sites × 10 roles = 20 rows");
ok(
  heavy.rows.every((r) => secondNum(r.subnet) === r.buildingIndex),
  "heavy pack still keeps site as second number"
);
const ultra = heavy.rows.find((r) => r.buildingIndex === 1 && /mega-ultra/i.test(r.role));
ok(ultra?.subnet === "10.1.0.0/17" || ultra?.usedPrefix === 17, `mega-ultra under 10.1 (/17), got ${ultra?.subnet}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
