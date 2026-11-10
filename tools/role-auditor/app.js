/**
 * Role & Policy Auditor UI.
 * Credentials are read from the form and localStorage. The access token
 * lives only inside runLive(). A live check posts the secret to /proxy
 * on this origin; the proxy forwards it and does not store it.
 */

import { CLUSTERS, assertCentralBase, fetchToken, loadAuditSnapshot, scrub } from "./api.js";
import {
  clearCreds,
  loadCreds,
  loadExtraRulesText,
  loadRuleToggles,
  saveCreds,
  saveExtraRulesText,
  saveRuleToggles,
} from "./creds.js";
import { exampleSnapshot } from "./example.js";
import { describeMatch, parseExtraRules, ruleColor, runRules, tagsForPolicyRule, tagsForRole } from "./engine.js";
import { aclDetail, displayAction, normalize, policyDetail, rolesUsingAny, serviceIsUnrestricted, serviceLabel } from "./model.js";
import { builtinRules } from "./rules.js";

const statusEl = document.getElementById("ra-status");
const reportEl = document.getElementById("ra-report");
const clusterEl = document.getElementById("ra-cluster");
const customWrap = document.getElementById("ra-custom-wrap");
const baseEl = document.getElementById("ra-base");
const clientIdEl = document.getElementById("ra-client-id");
const secretEl = document.getElementById("ra-client-secret");
const extraHint = document.getElementById("ra-extra-hint");
const extraList = document.getElementById("ra-extra-list");
const ruleForm = document.getElementById("ra-rule-form");
const ruleFormTitle = document.getElementById("ra-rule-form-title");
const ruleFormHint = document.getElementById("ra-rule-form-hint");
const tagEl = document.getElementById("ra-tag");
const conditionList = document.getElementById("ra-conditions");
const builtinEl = document.getElementById("ra-builtin");
const filterEl = document.getElementById("ra-filter");

/** @type {object[]} */
let extraRules = [];
/** @type {string | null} */
let editingId = null;

const CONDITION_FIELDS = [
  ["source", "Source"],
  ["destination", "Destination"],
  ["either", "Source or destination"],
  ["both", "Both sides"],
  ["action", "Action"],
  ["service", "Service"],
  ["keyword", "Keyword"],
];

/** @type {{ model: object, findings: object[], skipped: object[], banner: string } | null} */
let report = null;

/** Role table sort. Clients, highest first, until a header is clicked. */
const roleSort = { key: "clients", dir: "desc" };

const ROLE_COLUMNS = [
  { key: "role", label: "Role" },
  { key: "clients", label: "Clients" },
  { key: "vlan", label: "VLAN" },
  { key: "any", label: "ANY rules" },
];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function toggleRole(row) {
  const name = row.getAttribute("data-role");
  const detail = [...document.querySelectorAll("[data-detail]")].find((el) => el.getAttribute("data-detail") === name);
  if (!detail) return;
  const open = detail.hidden;
  detail.hidden = !open;
  row.setAttribute("aria-expanded", open ? "true" : "false");
  const mark = row.querySelector(".ra-chevron");
  if (mark) mark.textContent = open ? "▾" : "▸";
}

function setStatus(message) {
  statusEl.textContent = message || "";
}

function currentBaseUrl() {
  if (clusterEl.value === "custom") return baseEl.value.trim();
  const found = CLUSTERS.find((cluster) => cluster.id === clusterEl.value);
  return found ? found.baseUrl : "";
}

function syncCustomField() {
  const custom = clusterEl.value === "custom";
  customWrap.hidden = !custom;
  if (!custom) {
    const found = CLUSTERS.find((cluster) => cluster.id === clusterEl.value);
    if (found) baseEl.value = found.baseUrl;
  }
}

function fillClusters(savedUrl) {
  const options = CLUSTERS.map(
    (cluster) => `<option value="${escapeHtml(cluster.id)}">${escapeHtml(cluster.label)}</option>`
  );
  options.push('<option value="custom">Other cluster URL</option>');
  clusterEl.innerHTML = options.join("");
  const match = CLUSTERS.find((cluster) => cluster.baseUrl === savedUrl);
  if (match) clusterEl.value = match.id;
  else if (savedUrl) {
    clusterEl.value = "custom";
    baseEl.value = savedUrl;
  } else {
    clusterEl.value = "us1";
  }
  syncCustomField();
}

function readToggles() {
  const toggles = {};
  for (const input of builtinEl.querySelectorAll("input[data-rule-id]")) {
    toggles[input.getAttribute("data-rule-id")] = input.checked;
  }
  return toggles;
}

function renderBuiltin() {
  const toggles = loadRuleToggles();
  builtinEl.innerHTML = builtinRules
    .map((rule) => {
      const on = toggles[rule.id] !== false;
      return `<li>
        <label class="check-row">
          <input type="checkbox" data-rule-id="${escapeHtml(rule.id)}" ${on ? "checked" : ""} />
          <span>
            <strong>${escapeHtml(rule.title)}</strong>
            <span class="ra-rule-id">${escapeHtml(rule.id)}</span>
            <span class="hint">${escapeHtml(rule.summary)}</span>
          </span>
        </label>
      </li>`;
    })
    .join("");
}

function activeRules() {
  const toggles = readToggles();
  const builtin = builtinRules.map((rule) => ({
    ...rule,
    enabled: toggles[rule.id] !== false,
  }));
  return { rules: builtin.concat(extraRules), error: "" };
}

function formCreds() {
  return {
    baseUrl: currentBaseUrl(),
    clientId: clientIdEl.value.trim(),
    clientSecret: secretEl.value,
  };
}

function rememberForm() {
  saveCreds(formCreds());
  saveRuleToggles(readToggles());
}

function loadStoredExtra() {
  const text = loadExtraRulesText().trim();
  if (!text) {
    extraHint.textContent = "";
    extraHint.classList.remove("ra-hint--bad");
    return [];
  }
  const parsed = parseExtraRules(text, builtinRules.map((rule) => rule.id));
  extraHint.textContent = parsed.error ? parsed.error + " Add a rule to replace what was saved." : "";
  extraHint.classList.toggle("ra-hint--bad", Boolean(parsed.error));
  return parsed.error ? [] : parsed.rules;
}

function loadForm() {
  const creds = loadCreds();
  fillClusters(creds && creds.baseUrl);
  if (creds) {
    clientIdEl.value = creds.clientId;
    secretEl.value = creds.clientSecret;
  }
  extraRules = loadStoredExtra();
  renderBuiltin();
  renderExtra();
}

function clientLabel(model, role) {
  if (model.clients.error) return "—";
  const n = role.clientCount;
  if (model.clients.truncated) return n + " in sample";
  return String(n);
}

function matchesFilter(text) {
  const q = filterEl.value.trim().toLowerCase();
  if (!q) return true;
  return text.toLowerCase().includes(q);
}

function renderReport() {
  if (!report) {
    reportEl.hidden = true;
    return;
  }
  reportEl.hidden = false;
  const { model, findings, skipped, banner } = report;
  document.getElementById("ra-banner").textContent = banner;

  const usingAny = rolesUsingAny(model);
  const listed = rolesInReport(model, findings);
  const looseKeys = new Set();
  for (const item of findings) {
    if (item.source === "extra" || (item.roles && item.roles.length)) continue;
    looseKeys.add(item.kind + "\0" + item.name + "\0" + item.position);
  }
  const loose = looseKeys.size;
  const bits = [
    ["Roles", listed.length],
    ["Clients on those roles", listed.reduce((sum, role) => sum + role.clientCount, 0)],
    ["Policies", model.policies.length],
    ["Role ACLs", model.roleAcls.length],
    ["Net services", Object.keys(model.netServices).length],
  ];
  if (model.clients.unassigned) bits.push(["No role", model.clients.unassigned]);
  document.getElementById("ra-stats").innerHTML = bits
    .map(
      ([label, value]) =>
        `<div class="ra-stat"><span class="ra-stat__value">${escapeHtml(value)}</span><span class="ra-stat__label">${escapeHtml(label)}</span></div>`
    )
    .join("");

  const notes = [];
  if (model.clients.error) notes.push("Client counts failed: " + model.clients.error);
  else if (model.clients.truncated) notes.push("Client count is a sample. The tenant has more connected clients than this page pulled.");
  else if (!model.clients.error) notes.push("Client counts are connected clients whose role string matches the name.");
  if (model.netServicesError) notes.push("Net-service definitions failed: " + model.netServicesError);
  if (
    model.libraryTruncated.roles ||
    model.libraryTruncated.policies ||
    model.libraryTruncated.roleAcls ||
    model.libraryTruncated.netServices
  ) {
    notes.push("The library page cap was hit. The report may be missing later objects.");
  }
  if (loose) {
    notes.push(
      loose +
        (loose === 1 ? " ANY rule sits" : " ANY rules sit") +
        " on a policy no role uses. Those are left off this list. Open a role to see the policy it actually uses."
    );
  }
  const untagged = findings.filter(
    (item) => item.source === "extra" && item.roles.length === 0 && !model.roles.some((role) => role.name === item.name)
  ).length;
  if (untagged) {
    notes.push(
      untagged +
        (untagged === 1 ? " extra match is" : " extra matches are") +
        " not tied to a role, so there is no row for " +
        (untagged === 1 ? "it." : "them.")
    );
  }
  if (skipped.length) {
    notes.push(
      skipped
        .map((item) => "“" + item.title + "” was not applied. This engine does not check: " + item.keys.join(", ") + ".")
        .join(" ")
    );
  }
  document.getElementById("ra-roles-note").textContent = notes.join(" ");

  const expanded = new Set(
    [...document.querySelectorAll("#ra-roles tr.ra-detail")]
      .filter((row) => !row.hidden)
      .map((row) => row.getAttribute("data-detail"))
  );
  const roles = listed
    .filter((role) => matchesFilter(roleSearchText(model, role, findings)))
    .slice()
    .sort((a, b) => compareRoles(model, a, b));

  const rolesHtml = roles.length
    ? `<table class="ra-table">
        <thead>
          <tr>
            ${ROLE_COLUMNS.map((column) => sortHeader(column)).join("")}
          </tr>
        </thead>
        <tbody>
          ${roles.map((role) => roleRows(model, role, expanded.has(role.name), findings)).join("")}
        </tbody>
      </table>`
    : `<p class="ra-muted">No role matched${filterEl.value.trim() ? " this filter" : " the ruleset"}. Quiet is not a sign-off.</p>`;
  document.getElementById("ra-roles").innerHTML = rolesHtml;
}

function sortHeader(column) {
  const active = roleSort.key === column.key;
  const aria = active ? (roleSort.dir === "asc" ? "ascending" : "descending") : "none";
  const mark = active ? (roleSort.dir === "asc" ? "↑" : "↓") : "";
  return `<th aria-sort="${aria}"><button type="button" class="ra-sort" data-sort="${column.key}">${escapeHtml(column.label)}${mark ? `<span class="ra-sort__mark" aria-hidden="true">${mark}</span>` : ""}</button></th>`;
}

function compareRoles(model, a, b) {
  if (roleSort.key === "vlan") {
    const av = String(a.vlan || "").trim();
    const bv = String(b.vlan || "").trim();
    if (!av || !bv) {
      if (av === bv) return a.name.localeCompare(b.name);
      return av ? -1 : 1;
    }
  }
  const dir = roleSort.dir === "asc" ? 1 : -1;
  return roleDiff(model, a, b) * dir || a.name.localeCompare(b.name);
}

function roleDiff(model, a, b) {
  if (roleSort.key === "role") return a.name.localeCompare(b.name);
  if (roleSort.key === "clients") return (a.clientCount || 0) - (b.clientCount || 0);
  if (roleSort.key === "vlan") return compareVlan(a.vlan, b.vlan);
  const ac = anyCounts(model, a.name);
  const bc = anyCounts(model, b.name);
  return ac.open - bc.open || ac.service - bc.service;
}

function compareVlan(a, b) {
  const av = String(a || "").trim();
  const bv = String(b || "").trim();
  const aNum = /^\d+$/.test(av);
  const bNum = /^\d+$/.test(bv);
  if (aNum && bNum) return Number(av) - Number(bv);
  if (aNum) return -1;
  if (bNum) return 1;
  return av.localeCompare(bv);
}

function setRoleSort(key) {
  if (roleSort.key === key) roleSort.dir = roleSort.dir === "asc" ? "desc" : "asc";
  else {
    roleSort.key = key;
    roleSort.dir = key === "role" ? "asc" : "desc";
  }
}

function rolesInReport(model, findings) {
  const wanted = new Set(rolesUsingAny(model).map((role) => role.name));
  for (const finding of findings) {
    if (finding.source !== "extra") continue;
    for (const name of finding.roles || []) wanted.add(name);
    wanted.add(finding.name);
  }
  return model.roles.filter((role) => wanted.has(role.name));
}

function roleSearchText(model, role, findings) {
  const names = [
    role.name,
    role.description,
    role.vlan,
    ...policyDetail(model, role.name).map((policy) => policy.name),
    ...aclDetail(model, role.name).map((acl) => acl.name),
    ...tagsForRole(findings, role.name).map((item) => item.tag),
  ];
  return names.join(" ");
}

function tagHtml(tags) {
  if (!tags.length) return "";
  return tags
    .map((item) => `<span class="ra-tag ra-tag--${ruleColor(item.color)}">${escapeHtml(item.tag)}</span>`)
    .join("");
}

function anyCounts(model, roleName) {
  const anyRules = rulesOnRole(model, roleName).filter((rule) => rule.source.any || rule.destination.any);
  const open = anyRules.filter((rule) => serviceIsUnrestricted(rule)).length;
  return { open, service: anyRules.length - open };
}

function rulesOnRole(model, roleName) {
  return model.rules.filter((rule) => rule.owner === roleName || rule.roles.includes(roleName));
}

function definitionText(model, rule) {
  return serviceLabel(rule, model.netServices) || "—";
}

function ruleTable(model, rules, findings) {
  if (!rules.length) return `<p class="ra-muted">No rules.</p>`;
  return `<table class="ra-table ra-table--nested">
    <thead>
      <tr>
        <th>#</th>
        <th>Action</th>
        <th>Source</th>
        <th>Destination</th>
        <th>Service/Application</th>
      </tr>
    </thead>
    <tbody>
      ${rules
        .map((rule) => {
          const hit = findingsForLine(findings, rule).length > 0;
          const note = rule.description ? `<div class="ra-muted">${escapeHtml(rule.description)}</div>` : "";
          return `<tr class="${hit ? "ra-hit" : ""}">
            <td>${escapeHtml(rule.position)}</td>
            <td>${escapeHtml(displayAction(rule.action))} ${tagHtml(tagsForPolicyRule(findings, rule))}</td>
            <td>${escapeHtml(rule.source.label)}</td>
            <td>${escapeHtml(rule.destination.label)}</td>
            <td>${escapeHtml(definitionText(model, rule))}${note}</td>
          </tr>`;
        })
        .join("")}
    </tbody>
  </table>`;
}

function findingsForLine(findings, rule) {
  return (findings || []).filter(
    (finding) => finding.kind === rule.kind && finding.name === rule.owner && finding.position === rule.position
  );
}

function findingsForRole(findings, roleName) {
  return (findings || []).filter(
    (finding) => (finding.roles || []).includes(roleName) || finding.name === roleName
  );
}

function policyNamesOnRow(policies, acls) {
  const names = [...policies.map((item) => item.name), ...acls.map((item) => item.name)];
  if (!names.length) return "";
  return `<div class="ra-muted">${escapeHtml(names.join(", "))}</div>`;
}

function roleRows(model, role, expanded, findings) {
  const policies = policyDetail(model, role.name);
  const acls = aclDetail(model, role.name);
  const counts = anyCounts(model, role.name);
  const open = counts.open;
  const service = counts.service;
  const anyLabel = [
    open ? open + " any" : "",
    service ? service + (service === 1 ? " service" : " services") : "",
  ]
    .filter(Boolean)
    .join(" · ") || "—";
  const policyHtml = policies.length
    ? policies
        .map((policy) => {
          const meta = model.policies.find((item) => item.name === policy.name);
          return `<section class="ra-block">
            <h4>Policy ${escapeHtml(policy.name)}</h4>
            ${meta && meta.description ? `<p class="ra-muted">${escapeHtml(meta.description)}</p>` : ""}
            ${ruleTable(model, policy.rules, findings)}
          </section>`;
        })
        .join("")
    : `<p class="ra-muted">No policy is tied to this role.</p>`;
  const aclHtml = acls.length
    ? acls
        .map((acl) => {
          const meta = model.roleAcls.find((item) => item.name === acl.name);
          return `<section class="ra-block">
            <h4>Role ACL ${escapeHtml(acl.name)}</h4>
            ${meta && meta.description ? `<p class="ra-muted">${escapeHtml(meta.description)}</p>` : ""}
            ${ruleTable(model, acl.rules, findings)}
          </section>`;
        })
        .join("")
    : `<p class="ra-muted">No role ACL is tied to this name.</p>`;
  return `<tr class="ra-role" data-role="${escapeHtml(role.name)}" tabindex="0" aria-expanded="${expanded ? "true" : "false"}">
      <td>
        <span class="ra-chevron" aria-hidden="true">${expanded ? "▾" : "▸"}</span>
        <strong>${escapeHtml(role.name)}</strong>
        ${tagHtml(tagsForRole(findings, role.name))}
        ${role.inLibrary ? "" : ' <span class="ra-pill ra-pill--low">clients only</span>'}
        ${role.description ? `<div class="ra-muted">${escapeHtml(role.description)}</div>` : ""}
        ${policyNamesOnRow(policies, acls)}
      </td>
      <td>${escapeHtml(clientLabel(model, role))}</td>
      <td>${escapeHtml(role.vlan || "—")}</td>
      <td>${findingsForRole(findings, role.name).length && anyLabel !== "—" ? `<span class="ra-pill ra-pill--high">${escapeHtml(anyLabel)}</span>` : escapeHtml(anyLabel)}</td>
    </tr>
    <tr class="ra-detail" ${expanded ? "" : "hidden"} data-detail="${escapeHtml(role.name)}">
      <td colspan="4">${policyHtml}${aclHtml}</td>
    </tr>`;
}

function showAudit(snapshot, banner, { scroll = true, keepSort = false } = {}) {
  if (!keepSort) {
    roleSort.key = "clients";
    roleSort.dir = "desc";
  }
  const active = activeRules();
  if (active.error) {
    setStatus(active.error);
    return false;
  }
  const model = normalize(snapshot);
  const result = runRules(model, active.rules);
  report = { model, findings: result.findings, skipped: result.skipped, banner, source: snapshot };
  renderReport();
  if (scroll) reportEl.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}

async function runLive() {
  const creds = formCreds();
  rememberForm();
  const active = activeRules();
  if (active.error) {
    setStatus(active.error);
    return;
  }
  const buttons = document.querySelectorAll("#ra-cred-form button");
  for (const button of buttons) button.disabled = true;
  try {
    assertCentralBase(creds.baseUrl);
    setStatus("Asking GreenLake for a token through /proxy on this origin…");
    const token = await fetchToken(creds.clientId, creds.clientSecret);
    setStatus("Reading the library…");
    const snapshot = await loadAuditSnapshot(creds.baseUrl, token.accessToken, {
      onProgress(message) {
        setStatus(message + "…");
      },
    });
    const when = new Date().toLocaleString();
    showAudit(snapshot, "Live read of the shared library at " + when + ". " + creds.baseUrl);
    setStatus("Check finished. The access token was not saved.");
  } catch (err) {
    const message = scrub(err && err.message ? err.message : String(err), creds.clientSecret);
    setStatus(message);
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

function rowsFromMatch(match) {
  const rows = [];
  for (const [field] of CONDITION_FIELDS) {
    const value = match ? match[field] : undefined;
    if (value == null || value === "") continue;
    if (value === "any" || value === "not-any") rows.push({ field, op: value === "any" ? "any" : "not-any", value: "" });
    else if (typeof value === "string") {
      rows.push({
        field,
        op: field === "action" ? "is" : "contains",
        value: field === "action" ? displayAction(value) : value,
      });
    } else if (typeof value === "object" && value.value) {
      rows.push({
        field,
        op: value.op === "is" ? "is" : "contains",
        value: field === "action" ? displayAction(value.value) : String(value.value),
      });
    }
  }
  return rows.length ? rows : [{ field: "destination", op: "contains", value: "" }];
}

function syncCondition(row) {
  const field = row.querySelector("[data-field]").value;
  const op = row.querySelector("[data-op]");
  const value = row.querySelector("[data-value]");
  const address = field === "source" || field === "destination" || field === "service";
  const side = address || field === "either" || field === "both";
  for (const option of op.options) {
    if (option.value === "any") option.disabled = !side;
    else if (option.value === "not-any") option.disabled = field !== "source" && field !== "destination" && field !== "service";
    else if (option.value === "is") option.disabled = field === "keyword";
    else option.disabled = false;
  }
  if (op.selectedOptions[0] && op.selectedOptions[0].disabled) op.value = "contains";
  const bare = op.value === "any" || op.value === "not-any";
  value.hidden = bare;
  value.disabled = bare;
  if (field === "action") value.placeholder = "ALLOW, DENY, or PERMIT";
  else if (field === "service") value.placeholder = "svc-dns or UDP";
  else if (field === "keyword") value.placeholder = "text anywhere on the rule";
  else value.placeholder = "192.168.1.37 or 172.16";
}

function conditionRow(row) {
  const el = document.createElement("div");
  el.className = "ra-cond";
  const fields = CONDITION_FIELDS.map(([value, label]) => `<option value="${value}">${label}</option>`).join("");
  el.innerHTML = `<select data-field aria-label="Field">${fields}</select>
    <select data-op aria-label="How">
      <option value="contains">contains</option>
      <option value="is">is</option>
      <option value="any">is ANY</option>
      <option value="not-any">is not ANY</option>
    </select>
    <input data-value type="text" maxlength="80" autocomplete="off" aria-label="Value" />
    <button type="button" class="btn btn--ghost" data-remove-cond>Remove</button>`;
  el.querySelector("[data-field]").value = row.field;
  el.querySelector("[data-op]").value = row.op;
  el.querySelector("[data-value]").value = row.value || "";
  syncCondition(el);
  return el;
}

function setConditions(rows) {
  conditionList.replaceChildren();
  for (const row of rows) conditionList.appendChild(conditionRow(row));
}

function matchFromConditions() {
  const rows = [...conditionList.querySelectorAll(".ra-cond")];
  if (!rows.length) return { error: "Add a condition." };
  const match = {};
  for (const row of rows) {
    const field = row.querySelector("[data-field]").value;
    const op = row.querySelector("[data-op]").value;
    const value = row.querySelector("[data-value]").value.trim();
    const label = CONDITION_FIELDS.find((item) => item[0] === field)[1];
    if (Object.prototype.hasOwnProperty.call(match, field)) return { error: label + " is already in this rule. Add a second rule for another " + label.toLowerCase() + "." };
    if (op === "any" || op === "not-any") {
      const anyField = field === "source" || field === "destination" || field === "service";
      if (!anyField && !(op === "any" && (field === "either" || field === "both"))) {
        return { error: "ANY only applies to a source, a destination, or a service." };
      }
      match[field] = op === "any" ? "any" : "not-any";
      continue;
    }
    if (!value) return { error: "Enter what " + label.toLowerCase() + " should match, or remove that condition." };
    if (field === "action" && op === "is") match.action = value;
    else if (field === "keyword") match.keyword = value;
    else match[field] = { op: op === "is" ? "is" : "contains", value };
  }
  return { match };
}

function ruleIdFor(tag) {
  const base = tag.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "rule";
  const used = new Set([...extraRules.map((rule) => rule.id), ...builtinRules.map((rule) => rule.id)]);
  if (editingId) used.delete(editingId);
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = (base + "-" + n).slice(0, 80);
    n += 1;
  }
  return id;
}

function persistExtra() {
  saveExtraRulesText(extraRules.length ? JSON.stringify(extraRules) : "");
  extraHint.textContent = "";
  extraHint.classList.remove("ra-hint--bad");
  renderExtra();
  if (report) showAuditFromMemory();
}

function renderExtra() {
  if (!extraRules.length) {
    extraList.innerHTML = '<p class="ra-muted">No extra rules yet. Add one to put a tag on a matching role.</p>';
    return;
  }
  extraList.innerHTML = extraRules
    .map((rule) => {
      return `<div class="ra-saved">
        <span class="ra-tag ra-tag--${ruleColor(rule.color)}">${escapeHtml(rule.tag || rule.title)}</span>
        <span class="ra-saved__match">${escapeHtml(describeMatch(rule.match))}</span>
        <label class="ra-saved__on"><input type="checkbox" data-extra-id="${escapeHtml(rule.id)}" ${rule.enabled !== false ? "checked" : ""} /> On</label>
        <button type="button" class="btn btn--ghost" data-edit="${escapeHtml(rule.id)}">Edit</button>
        <button type="button" class="btn btn--ghost" data-delete="${escapeHtml(rule.id)}">Delete</button>
      </div>`;
    })
    .join("");
}

function closeBuilder() {
  editingId = null;
  ruleForm.hidden = true;
  ruleFormHint.textContent = "";
  tagEl.value = "";
  setConditions([{ field: "destination", op: "contains", value: "" }]);
  const red = ruleForm.querySelector('input[name="ra-color"][value="red"]');
  if (red) red.checked = true;
}

function openBuilder(rule) {
  ruleForm.hidden = false;
  ruleFormHint.textContent = "";
  if (!rule) {
    editingId = null;
    ruleFormTitle.textContent = "Add rule";
    tagEl.value = "";
    setConditions([{ field: "destination", op: "contains", value: "" }]);
    const red = ruleForm.querySelector('input[name="ra-color"][value="red"]');
    if (red) red.checked = true;
  } else {
    editingId = rule.id;
    ruleFormTitle.textContent = "Edit rule";
    tagEl.value = rule.tag || rule.title || "";
    setConditions(rowsFromMatch(rule.match));
    const color = ruleForm.querySelector('input[name="ra-color"][value="' + ruleColor(rule.color) + '"]');
    if (color) color.checked = true;
  }
  ruleForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
  tagEl.focus();
}

function saveBuilder(event) {
  event.preventDefault();
  const tag = tagEl.value.trim().slice(0, 32);
  if (!tag) {
    ruleFormHint.textContent = "Give the rule a tag. That is the label on the row.";
    tagEl.focus();
    return;
  }
  const chosen = ruleForm.querySelector('input[name="ra-color"]:checked');
  const color = ruleColor(chosen && chosen.value);
  const built = matchFromConditions();
  if (built.error) {
    ruleFormHint.textContent = built.error;
    return;
  }
  const match = built.match;
  const next = {
    id: editingId || ruleIdFor(tag),
    title: tag,
    tag,
    color,
    summary: "",
    severity: "high",
    enabled: true,
    match,
    source: "extra",
  };
  if (editingId) {
    const previous = extraRules.find((rule) => rule.id === editingId);
    if (previous) next.enabled = previous.enabled !== false;
    extraRules = extraRules.map((rule) => (rule.id === editingId ? next : rule));
  } else {
    extraRules = extraRules.concat(next);
  }
  closeBuilder();
  persistExtra();
}

function bind() {
  clusterEl.addEventListener("change", () => {
    syncCustomField();
  });

  document.getElementById("ra-cred-form").addEventListener("submit", (event) => {
    event.preventDefault();
    runLive();
  });

  document.getElementById("ra-save").addEventListener("click", () => {
    rememberForm();
    setStatus("Saved in this browser. Still not on a server.");
  });

  document.getElementById("ra-forget").addEventListener("click", () => {
    const ok = window.confirm("Remove the GreenLake client ID and secret from this browser?");
    if (!ok) return;
    clearCreds();
    clientIdEl.value = "";
    secretEl.value = "";
    setStatus("Credentials removed from this browser.");
  });

  document.getElementById("ra-example").addEventListener("click", () => {
    const shown = showAudit(exampleSnapshot(), "Example data. Not your Central. The shapes match the library APIs.");
    if (shown) setStatus("Example loaded. No credentials were sent.");
  });

  builtinEl.addEventListener("change", () => {
    saveRuleToggles(readToggles());
    if (report) showAuditFromMemory();
  });

  document.getElementById("ra-add-rule").addEventListener("click", () => openBuilder(null));
  document.getElementById("ra-add-cond").addEventListener("click", () => {
    conditionList.appendChild(conditionRow({ field: "action", op: "is", value: "" }));
  });
  conditionList.addEventListener("change", (event) => {
    const row = event.target.closest(".ra-cond");
    if (row) syncCondition(row);
  });
  conditionList.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove-cond]");
    if (!remove) return;
    const row = remove.closest(".ra-cond");
    if (row) row.remove();
  });
  ruleForm.addEventListener("submit", saveBuilder);
  document.getElementById("ra-cancel-rule").addEventListener("click", () => closeBuilder());
  extraList.addEventListener("click", (event) => {
    const edit = event.target.closest("[data-edit]");
    if (edit) {
      const rule = extraRules.find((item) => item.id === edit.getAttribute("data-edit"));
      if (rule) openBuilder(rule);
      return;
    }
    const del = event.target.closest("[data-delete]");
    if (!del) return;
    const id = del.getAttribute("data-delete");
    extraRules = extraRules.filter((rule) => rule.id !== id);
    if (editingId === id) closeBuilder();
    persistExtra();
  });
  extraList.addEventListener("change", (event) => {
    const input = event.target.closest("input[data-extra-id]");
    if (!input) return;
    const rule = extraRules.find((item) => item.id === input.getAttribute("data-extra-id"));
    if (!rule) return;
    rule.enabled = input.checked;
    persistExtra();
  });

  filterEl.addEventListener("input", () => {
    if (report) renderReport();
  });

  document.getElementById("ra-roles").addEventListener("click", (event) => {
    const sortButton = event.target.closest("button.ra-sort");
    if (sortButton && event.currentTarget.contains(sortButton)) {
      setRoleSort(sortButton.getAttribute("data-sort"));
      renderReport();
      return;
    }
    const row = event.target.closest("tr.ra-role");
    if (!row || !event.currentTarget.contains(row)) return;
    toggleRole(row);
  });
  document.getElementById("ra-roles").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("tr.ra-role");
    if (!row) return;
    event.preventDefault();
    toggleRole(row);
  });

  document.getElementById("ra-snapshot").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        setStatus("Snapshot must be a JSON object with roles, policies, roleAcls, and clients.");
        return;
      }
      const shown = showAudit(data, "Snapshot from " + file.name + ". Read in this tab, not uploaded.");
      if (shown) setStatus("Snapshot checked. No credentials were sent.");
    } catch {
      setStatus("That file is not JSON.");
    }
  });
}

/** Re-run the current rules against the snapshot already on screen. */
function showAuditFromMemory() {
  if (!report || !report.source) return;
  showAudit(report.source, report.banner, { scroll: false, keepSort: true });
}

loadForm();
bind();
