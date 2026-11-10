/**
 * Role auditor: normalizer, rules engine, and the read-only client guards.
 * Run: node tools/role-auditor/test_engine.js
 */

import { aclDetail, displayAction, displayRuleType, normalize, permissionsFor, endpointIsAny, policyDetail, rolesUsingAny, serviceIsUnrestricted, serviceLabel, summarizeNetService } from "./model.js";
import { describeMatch, parseExtraRules, ruleColor, runRules, ruleMatches, tagsForPolicyRule, tagsForRole } from "./engine.js";
import { builtinRules } from "./rules.js";
import { exampleSnapshot } from "./example.js";
import {
  assertCentralBase,
  assertReadOnlyPath,
  centralGet,
  fetchToken,
  getAllPages,
  MISSING_PROXY,
  PROXY_PATH,
  scrub,
  TOKEN_URL,
} from "./api.js";
import worker, { allowedTarget, onRequestPost } from "../../functions/proxy.js";
import { CREDS_KEY, loadCreds, saveCreds, clearCreds } from "./creds.js";

let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log("  PASS", msg);
  } else {
    failed++;
    console.error("  FAIL", msg);
  }
}

function throws(fn, msg) {
  try {
    fn();
    ok(false, msg + " (no throw)");
  } catch (err) {
    ok(true, msg);
    return err;
  }
  return null;
}

function proxyResult(status, body) {
  const bag = new Map([["content-type", "application/json"]]);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "x",
    headers: {
      get(name) {
        return bag.has(String(name).toLowerCase()) ? bag.get(String(name).toLowerCase()) : null;
      },
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function finding(modelRun, owner, position) {
  return modelRun.findings.find((item) => item.name === owner && item.position === position);
}

const store = new Map();
globalThis.localStorage = {
  getItem(key) {
    return store.has(key) ? store.get(key) : null;
  },
  setItem(key, value) {
    store.set(key, String(value));
  },
  removeItem(key) {
    store.delete(key);
  },
};

const model = normalize(exampleSnapshot());
const result = runRules(model, builtinRules);

console.log("normalize");
ok(model.roles.length === 4, "three library roles plus the client-only contractor role");
ok(model.policies.length === 4, "four policies, including the canned DNS policy");
ok(model.roleAcls.length === 1, "one role ACL");
ok(model.rules.length === 8, "eight rules across policies and the ACL");
ok(model.netServices["svc-dns"].protocol === "UDP" && model.netServices["svc-dns"].ports === "53", "DNS net-service is UDP 53");
ok(summarizeNetService({ name: "svc-http", protocol: "IP_TCP", "port-range": { operator: "COMPARISON_EQ", min: 80 } }).ports === "80", "an equal port match is a single port");
ok(summarizeNetService({ name: "svc-high", protocol: "IP_TCP", "port-range": { operator: "COMPARISON_RANGE", min: 1024, max: 65535 } }).ports === "1024–65535", "a port range stays a range");
ok(summarizeNetService({ name: "svc-gt", protocol: "IP_TCP", "port-range": { operator: "COMPARISON_GT", min: 1024 } }).ports === "> 1024", "a greater-than port keeps the operator");
const employee = model.roles.find((role) => role.name === "employee");
ok(employee && employee.clientCount === 2 && employee.vlan === "30", "employee client count and VLAN");
ok(model.roles.find((role) => role.name === "guest").clientCount === 1, "guest client count");
ok(model.roles.find((role) => role.name === "iot").clientCount === 0, "iot has no connected clients");
ok(model.roles.find((role) => role.name === "contractor" && role.inLibrary === false), "client role missing from the library is listed");
ok(model.clients.unassigned === 1, "one connected client with no role");
const guestAcl = model.rules.find((rule) => rule.id === "role-acl:guest-acl:1");
ok(guestAcl && guestAcl.countEnabled === true && guestAcl.destination.any, "ACL count flag is kept and is not treated as a hit total");
ok(endpointIsAny({ type: "address_any" }), "ADDRESS_ANY is matched case-insensitively");
ok(!endpointIsAny({ "rule-type": "RULE_ANY" }), "RULE_ANY is a protocol, not an address");
ok(displayAction("ACTION_ALLOW") === "ALLOW" && displayAction("ACTION_DENY") === "DENY" && displayAction("PERMIT") === "PERMIT", "the action column drops the ACTION_ prefix");
ok(displayRuleType("RULE_ANY") === "ANY" && displayRuleType("RULE_TCP") === "TCP" && displayRuleType("RULE_NET_SERVICE") === "NET_SERVICE", "the service column drops the RULE_ prefix");
ok(endpointIsAny({ type: "ADDRESS_ROLE", role: "any" }), "a role literally named any counts");
ok(!endpointIsAny({ type: "ADDRESS_ROLE", role: "anyone" }), "anyone is not any");

console.log("any-any rule");
const addressAny = result.findings.filter((item) => item.ruleId === "any-any");
ok(addressAny.length === 6, "six rules have a source or destination of ANY");
const serviceAny = result.findings.filter((item) => item.ruleId === "dest-service-any");
ok(serviceAny.length === 4, "four rules have destination ANY and an any service");
ok(serviceAny.some((item) => item.name === "employee" && item.position === 10), "employee any-protocol to ANY is the canned rule");
ok(!serviceAny.some((item) => item.name === "employee" && item.position === 30), "a named service to ANY is not the canned rule");
ok(!serviceAny.some((item) => item.name === "canned-dns"), "a canned net-service policy is not destination plus any service");
ok(serviceAny.some((item) => item.name === "wide-open"), "wide-open is destination ANY with any protocol");
ok(serviceAny.some((item) => item.name === "deny-any" && item.position === 5), "a deny with no protocol still counts as any service");
ok(serviceAny.some((item) => item.name === "guest-acl" && item.position === 1), "a role ACL with no protocol counts as any service");
ok(!serviceAny.some((item) => item.position === 20), "a specific protocol such as TCP is not any service");
ok(!serviceAny.some((item) => item.name === "guest-acl" && item.position === 2), "a single host is not destination ANY");
const employeeAnyLine = model.rules.find((rule) => rule.owner === "employee" && rule.position === 10);
const employeeDnsLine = model.rules.find((rule) => rule.owner === "employee" && rule.position === 30);
const employeeHostLine = model.rules.find((rule) => rule.owner === "employee" && rule.position === 20);
ok(tagsForPolicyRule(result.findings, employeeAnyLine).some((item) => item.tag === "Any service"), "the canned rule tags the any-protocol line");
ok(tagsForPolicyRule(result.findings, employeeDnsLine).length === 0, "a named service line gets no Any service tag");
ok(tagsForPolicyRule(result.findings, employeeHostLine).length === 0, "a TCP line gets no Any service tag");
const cannedTags = tagsForRole(result.findings, "employee");
ok(cannedTags.length === 1 && cannedTags[0].tag === "Any service" && cannedTags[0].color === "red", "the employee row gets the Any service tag");
ok(!tagsForRole(result.findings, "contractor").length, "the default address rule does not tag a row");
ok(describeMatch({ destination: "any", service: "any" }) === "Destination is ANY · Service is ANY", "the canned match reads as destination and service ANY");
const dhcpModel = normalize({
  roles: { role: [{ name: "cx-homenet-iot" }] },
  policies: {
    policy: [
      {
        name: "cx-test-policy",
        "security-policy": {
          "policy-rule": [
            {
              position: 10,
              description: "allow dhcp",
              condition: {
                "rule-type": "RULE_UDP",
                source: { type: "ADDRESS_ROLE", role: "cx-homenet-iot" },
                destination: { type: "ADDRESS_ANY" },
                "transport-fields": { "destination-port": { operator: "COMPARISON_EQ", min: 67 } },
              },
              action: { type: "ACTION_ALLOW" },
            },
          ],
        },
      },
    ],
  },
});
const dhcpRule = dhcpModel.rules[0];
ok(dhcpRule && dhcpRule.ports === "67" && dhcpRule.destination.any, "a UDP policy keeps destination port 67");
ok(serviceLabel(dhcpRule, {}) === "UDP 67", "the service column shows UDP 67, not the description");
ok(!serviceIsUnrestricted(dhcpRule), "UDP 67 to ANY is not an unrestricted service");
ok(!ruleMatches(dhcpRule, { destination: "any", service: "any" }).matched, "UDP 67 does not match destination and service ANY");
ok(ruleMatches(dhcpRule, { either: "any" }).matched, "UDP 67 still has an address of ANY");
ok(rolesUsingAny(dhcpModel).some((role) => role.name === "cx-homenet-iot"), "the role that sources UDP 67 to ANY stays in the report");
ok(policyDetail(dhcpModel, "cx-homenet-iot").some((policy) => policy.name === "cx-test-policy"), "cx-test-policy stays under that role");
const dns = model.rules.find((rule) => rule.owner === "canned-dns");
ok(dns && dns.service && dns.service.name === "svc-dns" && dns.roles.length === 0, "a canned net-service policy is not a role");
const using = rolesUsingAny(model).map((role) => role.name).sort();
ok(using.join() === "employee,guest,iot", "the report roles are the ones that use an ANY policy");
const employeePolicy = policyDetail(model, "employee");
ok(employeePolicy.length === 1 && employeePolicy[0].rules.length === 3, "opening employee shows the whole policy");
ok(employeePolicy[0].rules.some((rule) => rule.service && rule.service.name === "svc-dns"), "the employee policy keeps the DNS service rule");
const guestDetail = aclDetail(model, "guest");
ok(guestDetail.length === 1 && guestDetail[0].rules.length === 2, "opening guest shows the full ACL");
ok(finding(result, "employee", 10) && finding(result, "employee", 10).side === "destination", "employee rule 10 is destination ANY");
ok(!finding(result, "employee", 20), "host-to-host rule is not flagged");
const wide = finding(result, "wide-open", 1);
ok(wide && wide.side === "both" && wide.action === "ACTION_ALLOW", "wide-open is any to any and allowed");
ok(finding(result, "deny-any", 5) && finding(result, "deny-any", 5).action === "ACTION_DENY", "deny to ANY is still flagged");
ok(finding(result, "guest-acl", 1) && finding(result, "guest-acl", 1).kind === "role-acl", "role ACL permit to ANY is flagged");
ok(!finding(result, "guest-acl", 2), "role ACL to a single host is not flagged");
ok(result.skipped.length === 0, "builtin rule uses only supported match keys");

const employeePerms = permissionsFor(model, "employee").map((rule) => rule.position);
ok(employeePerms.includes(10) && employeePerms.includes(20), "employee permissions include the source-role rule and the same-name policy rule");
ok(permissionsFor(model, "guest").some((rule) => rule.owner === "guest-acl"), "guest permissions include its role ACL");
ok(permissionsFor(model, "iot").some((rule) => rule.owner === "deny-any"), "iot is the source role on the deny policy");

console.log("engine scaffolding");
const disabled = runRules(model, [{ ...builtinRules[0], enabled: false }]);
ok(disabled.findings.length === 0, "a disabled rule does not flag");

const future = runRules(model, [
  { id: "hits", title: "Quiet rules", severity: "info", enabled: true, match: { hitCount: "zero" } },
]);
ok(future.findings.length === 0, "an unknown match key does not match every rule");
ok(future.skipped.length === 1 && future.skipped[0].keys.includes("hitCount"), "hitCount is reported as not checked yet");

const mixed = runRules(model, [
  { id: "mixed", title: "Mixed", severity: "high", enabled: true, match: { either: "any", hitCount: "zero" } },
]);
ok(mixed.findings.length === 0, "a rule with an unknown key is not partially applied");

const permits = runRules(model, [
  {
    id: "permit-to-any",
    title: "Permit to ANY",
    severity: "high",
    enabled: true,
    match: { destination: "any", action: "ACTION_ALLOW" },
  },
]);
ok(finding(permits, "employee", 10) && !finding(permits, "deny-any", 5), "action match keeps the deny rule out");
ok(!finding(permits, "guest-acl", 1), "PERMIT is not the same string as ACTION_ALLOW");
const allows = runRules(model, [
  { id: "allow-label", title: "Allow", tag: "Open allow", color: "blue", source: "extra", enabled: true, match: { destination: "any", action: "ALLOW" } },
]);
ok(finding(allows, "employee", 10) && !finding(allows, "guest-acl", 1), "ALLOW matches a policy allow and not a role-ACL permit");
const employeeTags = tagsForRole(allows.findings, "employee");
ok(employeeTags.length === 1 && employeeTags[0].tag === "Open allow" && employeeTags[0].color === "blue", "an extra rule tags the matching role");
ok(tagsForRole(allows.findings, "guest").length === 0, "a role that did not match gets no tag");

const parsed = parseExtraRules(
  JSON.stringify([
    { id: "permit-to-any", title: "Permit to ANY", match: { destination: "any" }, check: "process.exit(1)" },
  ]),
  ["any-any"]
);
ok(!parsed.error && parsed.rules.length === 1 && !("check" in parsed.rules[0]), "extra rules keep match data and drop caller code");
ok(parsed.rules[0].tag === "Permit to ANY" && parsed.rules[0].color === "red", "a title becomes the tag and the default color is red");
ok(ruleColor("nope") === "red" && describeMatch({ destination: "any", action: "ACTION_ALLOW" }) === "Destination is ANY · Action is ALLOW", "color and match text stay in the builder vocabulary");
const hostLine = model.rules.find((rule) => rule.destination.text === "10.2.2.5");
ok(hostLine && ruleMatches(hostLine, { destination: { op: "is", value: "10.2.2.5" }, action: "ALLOW" }).matched, "an exact destination and an allow can be required together");
ok(hostLine && !ruleMatches(hostLine, { destination: { op: "is", value: "10.2.2" } }).matched, "is does not match a prefix of the address");
ok(hostLine && ruleMatches(hostLine, { destination: "10.2.2" }).matched, "a bare destination string is a keyword");
const secure = {
  source: { any: false, label: "employee", text: "employee", roles: ["employee"] },
  destination: { any: false, label: "172.16.8.4", text: "172.16.8.4", roles: [] },
  action: "ACTION_ALLOW",
  protocol: "",
  service: null,
  serviceText: "",
  description: "",
  owner: "employee",
  roles: ["employee"],
};
ok(ruleMatches(secure, { destination: { op: "contains", value: "172.16" }, action: "ALLOW" }).matched, "172.16 matches a host inside that subnet when the action allows");
ok(!ruleMatches(secure, { destination: { op: "is", value: "172.16" } }).matched, "is 172.16 is not the whole address");
ok(ruleMatches({ ...secure, destination: { any: false, label: "192.168.1.37/32", text: "192.168.1.37/32", roles: [] } }, { destination: { op: "is", value: "192.168.1.37" } }).matched, "is matches a host written with a /32");
const dnsRule = model.rules.find((rule) => rule.owner === "employee" && rule.service && rule.service.name === "svc-dns");
ok(dnsRule && ruleMatches(dnsRule, { keyword: "53" }).matched && ruleMatches(dnsRule, { service: { op: "contains", value: "dns" } }).matched, "a keyword can see the service name and its port");
ok(parseExtraRules("{", []).error.includes("JSON"), "broken JSON is an error");
ok(parseExtraRules(JSON.stringify([{ id: "any-any", match: { either: "any" } }]), ["any-any"]).error.includes("already"), "builtin ids stay reserved");
ok(ruleMatches(model.rules[0], {}).unsupported.includes("(empty match)"), "an empty match matches nothing");

console.log("credentials stay out of the token record");
saveCreds({
  baseUrl: "https://us1.api.central.arubanetworks.com",
  clientId: "cid",
  clientSecret: "super-secret",
  accessToken: "should-not-stick",
});
const stored = JSON.parse(store.get(CREDS_KEY));
ok(stored.clientSecret === "super-secret" && !("accessToken" in stored), "localStorage keeps the secret and not the access token");
ok(Object.keys(stored).sort().join() === "baseUrl,clientId,clientSecret", "only the three credential fields are stored");
ok(loadCreds().clientId === "cid", "loadCreds reads them back");
clearCreds();
ok(loadCreds() === null, "clearCreds removes them");
ok(scrub("nope super-secret here", "super-secret") === "nope [secret] here", "errors that echo the secret are scrubbed");

console.log("read-only client");
ok(assertCentralBase("https://us1.api.central.arubanetworks.com/") === "https://us1.api.central.arubanetworks.com", "cluster origin is accepted");
ok(assertCentralBase("https://cn1.api.central.arubanetworks.com.cn") === "https://cn1.api.central.arubanetworks.com.cn", "China cluster origin is accepted");
throws(() => assertCentralBase("http://us1.api.central.arubanetworks.com"), "http cluster URL is refused");
throws(() => assertCentralBase("https://evil.example/steal"), "non-Central host is refused");
throws(() => assertCentralBase("https://user:pw@us1.api.central.arubanetworks.com"), "userinfo in the cluster URL is refused");
throws(() => assertCentralBase("https://us1.api.central.arubanetworks.com/network-config"), "a path on the cluster URL is refused");
ok(assertReadOnlyPath("/network-config/v1alpha1/roles?view-type=LIBRARY").includes("roles"), "roles collection is readable");
ok(assertReadOnlyPath("/network-config/v1alpha1/net-services?view-type=LIBRARY").includes("net-services"), "net-service definitions are readable");
throws(() => assertReadOnlyPath("/network-config/v1alpha1/policies/employee"), "a single policy write path is refused");
throws(() => assertReadOnlyPath("/network-config/v1alpha1/roles/../../etc"), "dot-dot paths are refused");
throws(() => assertReadOnlyPath("https://evil.example/"), "absolute URLs are refused");

{
  let called = false;
  let threw = false;
  try {
    await centralGet("https://evil.example", "tok", "/network-config/v1alpha1/roles", () => {
      called = true;
    });
  } catch {
    threw = true;
  }
  ok(threw && !called, "centralGet does not call fetch for a bad host");
}

{
  let seen = null;
  const body = await centralGet(
    "https://us1.api.central.arubanetworks.com",
    "tok-12345678",
    "/network-config/v1alpha1/policies?view-type=LIBRARY",
    async (url, init) => {
      seen = { url, init };
      return proxyResult(200, { policy: [] });
    }
  );
  const posted = JSON.parse(seen.init.body);
  ok(body && Array.isArray(body.policy), "centralGet returns the JSON body");
  ok(seen.url === PROXY_PATH && seen.init.method === "POST", "the browser posts to same-origin /proxy");
  ok(seen.init.headers.Authorization == null, "the bearer is not a header on the call to this origin");
  ok(posted.method === "GET", "the proxied config read is a GET");
  ok(posted.url === "https://us1.api.central.arubanetworks.com/network-config/v1alpha1/policies?view-type=LIBRARY", "GET URL is the cluster plus the allowlisted path");
  ok(posted.headers.Authorization === "Bearer tok-12345678", "bearer token is inside the proxy body for that GET");
  ok(seen.init.redirect === "error" && seen.init.cache === "no-store" && seen.init.credentials === "same-origin", "the proxy call does not follow redirects");
}

{
  let seen = null;
  const token = await fetchToken("client-1", "s3cret&x", async (url, init) => {
    seen = { url, init };
    return proxyResult(200, { access_token: "aaa", expires_in: 30 });
  });
  const posted = JSON.parse(seen.init.body);
  ok(token.accessToken === "aaa" && token.expiresIn === 30, "token response is the access token and expiry");
  ok(seen.url === PROXY_PATH && posted.url === TOKEN_URL && posted.method === "POST", "token POST is proxied only to GreenLake SSO");
  ok(posted.body.includes("grant_type=client_credentials"), "grant type is client_credentials");
  ok(posted.body.includes("client_secret=" + encodeURIComponent("s3cret&x")), "secret is form-encoded, not a raw extra field");
  ok(seen.init.headers.Authorization == null, "the token call to this origin has no bearer header");
  ok(!store.has(CREDS_KEY), "fetchToken does not write localStorage");
}

{
  let message = "";
  try {
    await fetchToken("client-1", "s3cret", async () => proxyResult(401, { error_description: "bad s3cret value" }));
  } catch (err) {
    message = err.message;
  }
  ok(message.includes("[secret]") && !message.includes("s3cret"), "token errors do not repeat the client secret");
}

{
  let message = "";
  try {
    await centralGet(
      "https://us1.api.central.arubanetworks.com",
      "sekret-token-value",
      "/network-config/v1alpha1/roles",
      async () => {
        throw new TypeError("Failed to fetch");
      }
    );
  } catch (err) {
    message = err.message;
  }
  ok(
    message.includes("could not reach /proxy") && !message.includes("sekret-token-value"),
    "a failure reaching /proxy does not repeat the token"
  );
}

{
  let message = "";
  try {
    await centralGet(
      "https://us1.api.central.arubanetworks.com",
      "sekret-token-value",
      "/network-config/v1alpha1/roles",
      async () => ({
        ok: false,
        status: 501,
        statusText: "Unsupported",
        headers: { get: () => "text/html" },
        async text() {
          return "<html>no proxy</html>";
        },
      })
    );
  } catch (err) {
    message = err.message;
  }
  ok(message === MISSING_PROXY && !message.includes("sekret-token-value"), "a static server is named as a missing proxy");
}

{
  const pages = [];
  const all = await getAllPages(async (path) => {
    pages.push(path);
    return { role: [{ name: "employee" }, { name: "guest" }] };
  }, "/network-config/v1alpha1/roles?view-type=LIBRARY", ["role"]);
  ok(pages.length === 1 && pages[0] === "/network-config/v1alpha1/roles?view-type=LIBRARY", "a library read sends view-type and no limit or offset");
  ok(all.items.length === 2 && all.truncated === false, "a library read is the one response");
}

{
  const pages = [];
  const first = Array.from({ length: 100 }, (_, index) => ({ name: "r" + index }));
  const all = await getAllPages(async (path) => {
    pages.push(path);
    if (path.includes("offset=0")) return { role: first };
    if (path.includes("offset=100")) return { role: [{ name: "tail" }] };
    return { role: [{ name: "tail" }] };
  }, "/network-config/v1alpha1/roles", ["role"]);
  ok(all.items.length === 101 && all.items[100].name === "tail", "non-library pages are concatenated");
  ok(pages.length === 2 && !pages[0].includes("view-type") && all.truncated === false, "paging stops on a short page");
}

console.log("proxy");
ok(allowedTarget("https://internal.api.central.arubanetworks.com/network-config/v1alpha1/roles?view-type=LIBRARY", "GET").method === "GET", "internal cluster GET is allowed from any site origin");
ok(allowedTarget("https://cn1.api.central.arubanetworks.com.cn/network-monitoring/v1/clients", "GET").href.includes("cn1"), "China cluster is allowed");
ok(allowedTarget("https://evil.example/steal", "GET").error === "Domain not allowed", "other hosts are refused");
ok(allowedTarget("https://us1.api.central.arubanetworks.com/network-config/v1alpha1/roles", "DELETE").error === "Read-only", "writes are refused");
ok(allowedTarget(TOKEN_URL, "POST").method === "POST", "the token URL can be a POST");

{
  let seen = null;
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ role: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const res = await onRequestPost({
    request: new Request("http://192.168.4.20:8080/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://internal.api.central.arubanetworks.com/network-config/v1alpha1/roles?view-type=LIBRARY",
        method: "GET",
        headers: { Accept: "application/json", Authorization: "Bearer test-token-value", Cookie: "session=s3cret" },
      }),
    }),
  });
  globalThis.fetch = previous;
  ok(res.status === 200 && seen.url.startsWith("https://internal.api.central.arubanetworks.com/"), "a LAN origin can forward the internal cluster GET");
  ok(seen.init.redirect === "manual" && !("Cookie" in seen.init.headers) && seen.init.headers.Authorization === "Bearer test-token-value", "the proxy does not follow redirects or forward cookies");
  ok(res.headers.get("access-control-allow-origin") === "*", "the proxy answers whatever origin opened the page");
}

{
  const assets = { called: false, async fetch() { this.called = true; return new Response("asset-ok", { status: 200 }); } };
  const page = await worker.fetch(new Request("http://192.168.4.20:8080/index.html"), { ASSETS: assets });
  ok((await page.text()) === "asset-ok" && assets.called, "paths other than /proxy stay static files");
}

console.log("");
if (failed) {
  console.error(failed + " failed, " + passed + " passed");
  process.exit(1);
}
console.log(passed + " passed");
