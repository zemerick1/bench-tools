/**
 * Turn Central roles, policies, and role ACLs into one flat rule list.
 *
 * ADDRESS_ANY (or a role literally named "any") is an address match.
 * RULE_ANY is a protocol match — any IP protocol — and is not the same thing.
 *
 * Role ACL `count` is the switch flag that turns counters on. It is not a
 * hit total. Hit totals are a later check; the flag is kept on the rule so
 * a future match can see it.
 */

/**
 * @param {unknown} body
 * @param {string[]} keys
 */
function asList(body, keys) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  if (typeof body === "object") {
    for (const key of keys) {
      if (Array.isArray(body[key])) return body[key];
    }
    if (Array.isArray(body.items)) return body.items;
  }
  return [];
}

/** @param {unknown} value */
function roleNameList(value) {
  if (!value || typeof value !== "object") return [];
  const names = [];
  if (typeof value.role === "string" && value.role.trim()) names.push(value.role.trim());
  if (typeof value["src-role"] === "string" && value["src-role"].trim()) names.push(value["src-role"].trim());
  if (Array.isArray(value["role-list"])) {
    for (const entry of value["role-list"]) {
      if (typeof entry === "string" && entry.trim()) names.push(entry.trim());
    }
  }
  return names;
}

/**
 * @param {unknown} endpoint
 * @returns {boolean}
 */
export function endpointIsAny(endpoint) {
  if (endpoint == null) return false;
  if (typeof endpoint === "string") return endpoint.trim().toLowerCase() === "any";
  if (typeof endpoint !== "object") return false;
  const type = String(endpoint.type || endpoint["address-type"] || "")
    .trim()
    .toUpperCase();
  if (type === "ADDRESS_ANY" || type === "ANY") return true;
  return roleNameList(endpoint).some((name) => name.toLowerCase() === "any");
}

function leafStrings(value, depth) {
  if (value == null || depth > 5) return [];
  if (typeof value === "string") {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (typeof value === "number") return [String(value)];
  if (typeof value === "boolean") return [];
  if (Array.isArray(value)) return value.flatMap((entry) => leafStrings(entry, depth + 1));
  if (typeof value === "object") {
    const skip = new Set(["type", "address-type", "role-options"]);
    const out = [];
    for (const [key, entry] of Object.entries(value)) {
      if (skip.has(key)) continue;
      out.push(...leafStrings(entry, depth + 1));
    }
    return out;
  }
  return [];
}

/**
 * @param {unknown} endpoint
 * @param {number} [limit] 0 keeps the full text for matching. The table trims to 96.
 * @returns {string}
 */
export function endpointLabel(endpoint, limit = 96) {
  if (endpointIsAny(endpoint)) return "ANY";
  if (!endpoint || typeof endpoint !== "object") {
    if (endpoint == null || endpoint === "") return "—";
    return String(endpoint);
  }
  const roles = roleNameList(endpoint).filter((name) => name.toLowerCase() !== "any");
  if (roles.length) return trimEnd(roles.join(", "), limit);
  const bits = [];
  const seen = new Set();
  for (const bit of leafStrings(endpoint, 0)) {
    const key = bit.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    bits.push(bit);
  }
  if (!bits.length) {
    const type = endpoint.type || endpoint["address-type"];
    return type ? String(type).replace(/^ADDRESS_/, "") : "—";
  }
  return trimEnd(bits.join(" "), limit);
}

function trimEnd(text, limit) {
  if (!limit || text.length <= limit) return text;
  return text.slice(0, limit - 3) + "…";
}

/** @param {unknown} action */
export function actionLabel(action) {
  if (action == null || action === "") return "—";
  if (typeof action === "string") return action;
  if (typeof action === "object" && action.type) return String(action.type);
  return "—";
}

/** Action as the policy table shows it: ALLOW, DENY, PERMIT. */
export function displayAction(action) {
  const label = typeof action === "string" ? action : actionLabel(action);
  if (!label || label === "—") return "—";
  return label.replace(/^ACTION_/, "");
}

/** Rule type as the policy table shows it: ANY, TCP, NET_SERVICE. */
export function displayRuleType(protocol) {
  if (protocol == null || protocol === "") return "";
  return String(protocol).replace(/^RULE_/, "");
}

/**
 * Port match as Central shows it: 67, 1024–65535, &lt; 1024, or a port-group name.
 * @param {unknown} spec
 */
export function formatPortSpec(spec) {
  if (spec == null || spec === "") return "";
  if (typeof spec === "string" || typeof spec === "number") return String(spec);
  if (typeof spec !== "object") return "";
  if (spec.group) return String(spec.group);
  const min = spec.min;
  const max = spec.max;
  const op = String(spec.operator || "");
  if (min != null && max != null && op.includes("RANGE")) return min + "–" + max;
  if (min != null && op.includes("NE")) return "not " + min;
  if (min != null && op.endsWith("LT")) return "< " + min;
  if (min != null && op.endsWith("GT")) return "> " + min;
  if (min != null && max != null && String(min) !== String(max)) return min + "–" + max;
  if (min != null) return String(min);
  if (max != null) return String(max);
  return "";
}

/** Destination port, or source and destination when both are set. */
export function transportPorts(condition) {
  const fields = condition && condition["transport-fields"];
  if (!fields || typeof fields !== "object") return "";
  const dest = formatPortSpec(fields["destination-port"]) || (fields["destination-port-net-group"] ? String(fields["destination-port-net-group"]) : "");
  const src = formatPortSpec(fields["source-port"]) || (fields["source-port-net-group"] ? String(fields["source-port-net-group"]) : "");
  if (src && dest) return "src " + src + " dst " + dest;
  if (dest) return dest;
  if (src) return "src " + src;
  return "";
}

/** No named service, no port, and the protocol is ANY or unset. */
export function serviceIsUnrestricted(rule) {
  if (!rule || rule.service || rule.ports) return false;
  const kind = displayRuleType(rule.protocol).toUpperCase();
  return kind === "" || kind === "ANY";
}

/**
 * Service/Application cell. A protocol and port read as Central does: "UDP 67".
 * @param {object} rule
 * @param {object} netServices
 */
export function serviceLabel(rule, netServices) {
  if (rule.service && rule.service.kind === "net-service") {
    const known = netServices && netServices[rule.service.name];
    if (!known) return "net-service " + rule.service.name;
    const bits = [known.protocol, known.ports].filter(Boolean).join(" ");
    return "net-service " + known.name + (bits ? " · " + bits : "") + (known.description ? " — " + known.description : "");
  }
  if (rule.service) return rule.service.kind + " " + rule.service.name;
  const kind = displayRuleType(rule.protocol);
  const ports = rule.ports || "";
  if (kind && ports) return kind + " " + ports;
  if (kind) return kind;
  if (ports) return ports;
  return "";
}

/**
 * Named match on a policy rule: a net-service, an application, or an app category.
 * @param {object} condition
 * @returns {{ kind: string, name: string } | null}
 */
export function serviceOf(condition) {
  const services = condition && condition.services;
  if (!services || typeof services !== "object") return null;
  if (services["net-service"]) return { kind: "net-service", name: String(services["net-service"]) };
  if (services.application) return { kind: "application", name: String(services.application) };
  if (services["app-category"]) return { kind: "app-category", name: String(services["app-category"]) };
  return null;
}

/**
 * Short text for a net-service object from the library.
 * @param {object} raw
 */
export function summarizeNetService(raw) {
  const protocol = raw && raw.protocol != null ? String(raw.protocol).replace(/^IP_/, "").replace(/^PROTOCOL_/, "") : "";
  let ports = "";
  if (raw && Array.isArray(raw.ports) && raw.ports.length) ports = raw.ports.join(", ");
  else if (raw && raw["port-range"]) ports = formatPortSpec(raw["port-range"]);
  return {
    name: raw && raw.name ? String(raw.name) : "",
    description: raw && raw.description ? String(raw.description) : "",
    protocol,
    ports,
  };
}

function policyRuleList(policy) {
  const security = policy && policy["security-policy"];
  if (security && Array.isArray(security["policy-rule"])) return security["policy-rule"];
  if (policy && Array.isArray(policy["policy-rule"])) return policy["policy-rule"];
  return [];
}

function vlanOf(role) {
  const vlan = role && role["vlan-parameters"];
  if (!vlan || typeof vlan !== "object") return "";
  if (vlan["access-vlan"] != null && vlan["access-vlan"] !== "") return String(vlan["access-vlan"]);
  if (vlan["access-vlan-name"]) return String(vlan["access-vlan-name"]);
  if (vlan["named-vlan"]) return String(vlan["named-vlan"]);
  if (vlan["wired-access-vlan-id"] != null && vlan["wired-access-vlan-id"] !== "") {
    return String(vlan["wired-access-vlan-id"]);
  }
  return "";
}

/**
 * Roles a rule is "the permissions of".
 * Source role names, plus the policy or ACL name when it matches a library role.
 * @param {object} rule
 * @param {Set<string>} libraryNames
 */
function attachedRoles(rule, libraryNames) {
  const names = new Set();
  for (const name of rule.source.roles) {
    if (name.toLowerCase() !== "any") names.add(name);
  }
  if (libraryNames.has(rule.owner)) names.add(rule.owner);
  return [...names];
}

function pushRule(rules, draft, libraryNames) {
  const rule = {
    ...draft,
    source: {
      any: endpointIsAny(draft.sourceEndpoint),
      label: endpointLabel(draft.sourceEndpoint),
      text: endpointLabel(draft.sourceEndpoint, 0),
      roles: roleNameList(draft.sourceEndpoint).filter((name) => name.toLowerCase() !== "any"),
    },
    destination: {
      any: endpointIsAny(draft.destinationEndpoint),
      label: endpointLabel(draft.destinationEndpoint),
      text: endpointLabel(draft.destinationEndpoint, 0),
      roles: roleNameList(draft.destinationEndpoint).filter((name) => name.toLowerCase() !== "any"),
    },
  };
  delete rule.sourceEndpoint;
  delete rule.destinationEndpoint;
  rule.roles = attachedRoles(rule, libraryNames);
  rules.push(rule);
}

/**
 * @param {object} raw
 * Library payloads may be `{ role: [] }` or a bare array. Clients are
 * `{ items, total, truncated, error }` or `{ items: [] }`.
 */
export function normalize(raw) {
  const input = raw || {};
  const roleObjects = asList(input.roles && input.roles.items ? input.roles.items : input.roles, ["role", "roles"]);
  const policyObjects = asList(
    input.policies && input.policies.items ? input.policies.items : input.policies,
    ["policy", "policies"]
  );
  const aclObjects = asList(
    input.roleAcls && input.roleAcls.items ? input.roleAcls.items : input.roleAcls,
    ["acl", "role-acls", "roleAcls"]
  );

  const libraryNames = new Set();
  const roles = [];
  for (const role of roleObjects) {
    if (!role || typeof role !== "object" || !role.name) continue;
    const name = String(role.name);
    libraryNames.add(name);
    roles.push({
      name,
      description: role.description ? String(role.description) : "",
      vlan: vlanOf(role),
      inLibrary: true,
      clientCount: 0,
    });
  }

  const rules = [];
  const policies = [];
  for (const policy of policyObjects) {
    if (!policy || typeof policy !== "object" || !policy.name) continue;
    const name = String(policy.name);
    const ruleList = policyRuleList(policy);
    policies.push({
      name,
      description: policy.description ? String(policy.description) : "",
      type: policy.type ? String(policy.type) : "",
      association: policy.association ? String(policy.association) : "",
      ruleCount: ruleList.length,
    });
    ruleList.forEach((rule, index) => {
      const condition = (rule && rule.condition) || {};
      pushRule(
        rules,
        {
          id: "policy:" + name + ":" + (rule && rule.position != null ? rule.position : index + 1),
          kind: "policy",
          owner: name,
          position: rule && rule.position != null ? rule.position : index + 1,
          description: rule && rule.description ? String(rule.description) : "",
          action: actionLabel(rule && rule.action),
          protocol: condition["rule-type"] ? String(condition["rule-type"]) : "",
          ports: transportPorts(condition),
          service: serviceOf(condition),
          countEnabled: !!(rule && rule.count === true),
          sourceEndpoint: condition.source || null,
          destinationEndpoint: condition.destination || null,
        },
        libraryNames
      );
    });
  }

  const roleAcls = [];
  for (const acl of aclObjects) {
    if (!acl || typeof acl !== "object" || !acl.name) continue;
    const name = String(acl.name);
    const ruleList = Array.isArray(acl.rules) ? acl.rules : [];
    roleAcls.push({
      name,
      description: acl.description ? String(acl.description) : "",
      aclType: acl["acl-type"] ? String(acl["acl-type"]) : "",
      ruleCount: ruleList.length,
    });
    ruleList.forEach((rule, index) => {
      const srcRole = rule && rule["src-role"] ? String(rule["src-role"]) : "";
      const sourceEndpoint = srcRole
        ? {
            type: srcRole.toLowerCase() === "any" ? "ADDRESS_ANY" : "ADDRESS_ROLE",
            role: srcRole,
          }
        : null;
      pushRule(
        rules,
        {
          id: "role-acl:" + name + ":" + (rule && rule.position != null ? rule.position : index + 1),
          kind: "role-acl",
          owner: name,
          position: rule && rule.position != null ? rule.position : index + 1,
          description: rule && rule.description ? String(rule.description) : "",
          action: actionLabel(rule && rule.action),
          protocol: "",
          ports: "",
          service: null,
          countEnabled: !!(rule && rule.count === true),
          sourceEndpoint,
          destinationEndpoint: (rule && rule.destination) || null,
        },
        libraryNames
      );
    });
  }

  const clientBody = input.clients || {};
  const clientItems = asList(clientBody.items ? clientBody : input.clients, ["items", "clients"]);
  const byRole = {};
  let unassigned = 0;
  for (const client of clientItems) {
    const name = client && client.role ? String(client.role).trim() : "";
    if (!name) {
      unassigned += 1;
      continue;
    }
    byRole[name] = (byRole[name] || 0) + 1;
  }
  for (const role of roles) role.clientCount = byRole[role.name] || 0;
  for (const [name, count] of Object.entries(byRole)) {
    if (libraryNames.has(name)) continue;
    roles.push({
      name,
      description: "",
      vlan: "",
      inLibrary: false,
      clientCount: count,
    });
  }

  const netServices = {};
  const netObjects = asList(
    input.netServices && input.netServices.items ? input.netServices.items : input.netServices,
    ["net-service", "net-services"]
  );
  for (const raw of netObjects) {
    if (!raw || typeof raw !== "object" || !raw.name) continue;
    const summary = summarizeNetService(raw);
    if (summary.name) netServices[summary.name] = summary;
  }
  for (const rule of rules) {
    const named = rule.service && rule.service.kind === "net-service" ? netServices[rule.service.name] : null;
    if (named) rule.serviceText = [named.name, named.protocol, named.ports, named.description].filter(Boolean).join(" ");
    else if (rule.service) rule.serviceText = rule.service.kind + " " + rule.service.name;
    else rule.serviceText = [displayRuleType(rule.protocol), rule.ports].filter(Boolean).join(" ");
  }

  return {
    roles,
    policies,
    roleAcls,
    rules,
    netServices,
    clients: {
      byRole,
      unassigned,
      sampled: clientItems.length,
      total: clientBody && typeof clientBody.total === "number" ? clientBody.total : null,
      truncated: !!(clientBody && clientBody.truncated),
      error: clientBody && clientBody.error ? String(clientBody.error) : "",
    },
    libraryTruncated: {
      roles: !!(input.roles && input.roles.truncated),
      policies: !!(input.policies && input.policies.truncated),
      roleAcls: !!(input.roleAcls && input.roleAcls.truncated),
      netServices: !!(input.netServices && input.netServices.truncated),
    },
    netServicesError: input.netServices && input.netServices.error ? String(input.netServices.error) : "",
  };
}

function ownersTouching(model, kind, roleName) {
  const names = new Set();
  for (const rule of model.rules) {
    if (rule.kind !== kind) continue;
    if (rule.owner === roleName || rule.roles.includes(roleName)) names.add(rule.owner);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function rulesForOwner(model, kind, owner) {
  return model.rules
    .filter((rule) => rule.kind === kind && rule.owner === owner)
    .slice()
    .sort((a, b) => a.position - b.position);
}

/** Policies tied to this role, each with every rule in that policy. */
export function policyDetail(model, roleName) {
  if (!model) return [];
  return ownersTouching(model, "policy", roleName).map((name) => ({
    name,
    rules: rulesForOwner(model, "policy", name),
  }));
}

/** Role ACLs tied to this role, each with every rule in that ACL. */
export function aclDetail(model, roleName) {
  if (!model) return [];
  return ownersTouching(model, "role-acl", roleName).map((name) => ({
    name,
    rules: rulesForOwner(model, "role-acl", name),
  }));
}

/**
 * Roles that have an ANY address on a policy or ACL tied to the name.
 * Canned policies that no role uses are not roles.
 * @param {object} model
 */
export function rolesUsingAny(model) {
  if (!model) return [];
  return model.roles.filter((role) =>
    model.rules.some(
      (rule) =>
        (rule.source.any || rule.destination.any) &&
        (rule.owner === role.name || rule.roles.includes(role.name))
    )
  );
}

/** Rules that read as this role's permissions. */
export function permissionsFor(model, roleName) {
  if (!model) return [];
  return model.rules.filter((rule) => rule.roles.includes(roleName));
}
