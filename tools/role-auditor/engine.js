/**
 * Small declarative ruleset.
 *
 * A rule is data, not code: `{ id, title, summary, severity, enabled, match }`.
 * The engine understands these match keys today:
 *
 *   source:        "any" | "not-any" | "172.16" | { op: "is"|"contains", value }
 *   destination:   same as source. A bare string other than any/not-any is "contains".
 *   either:        "any", or a text match on source OR destination
 *   both:          "any", or a text match on source AND destination
 *   action:        string, or { op, value }. ALLOW matches ACTION_ALLOW. PERMIT does not.
 *   service:       "any" | "not-any", or a string / { op, value } against the name, protocol, and ports
 *                  "any" means no named net-service, application, or app category, and the
 *                  protocol is ANY or unset. A role ACL with no protocol counts as any service.
 *   keyword:       string or { op, value } against the whole rule
 *
 * Every key has to match. "is" is the whole address or name. "contains" is a keyword.
 *
 * Any other key is skipped and reported. A half-written future check
 * (hit counts, for example) cannot silently match every rule.
 * The role-ACL `count` boolean is not a hit total and is not a match key.
 */

import { displayAction, displayRuleType, serviceIsUnrestricted } from "./model.js";

const SUPPORTED = new Set(["source", "destination", "either", "both", "action", "service", "keyword"]);
const SEVERITIES = new Set(["high", "medium", "low", "info"]);
export const RULE_COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "gray"];
const COLORS = new Set(RULE_COLORS);

/** @param {unknown} color */
export function ruleColor(color) {
  const value = String(color || "").toLowerCase();
  return COLORS.has(value) ? value : "red";
}

/**
 * @param {object} rule normalized rule from model.js
 * @param {object} match
 * @returns {{ matched: boolean, unsupported: string[] }}
 */
function sideText(side) {
  if (!side) return "";
  return String(side.text || side.label || "");
}

function needleOf(expected) {
  if (typeof expected === "string") return { op: "contains", value: expected.trim() };
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) return null;
  const op = expected.op === "is" ? "is" : expected.op === "contains" ? "contains" : "";
  const value = expected.value == null ? "" : String(expected.value).trim();
  if (!op || !value) return null;
  return { op, value };
}

function textHits(haystack, spec) {
  const hay = String(haystack || "").toLowerCase();
  const needle = spec.value.toLowerCase();
  if (spec.op === "contains") return hay.includes(needle);
  if (hay === needle) return true;
  return hay.split(/[\s,]+/).some((part) => part === needle || part.split("/")[0] === needle);
}

function sideHits(side, expected) {
  if (expected === "any") return !!(side && side.any);
  if (expected === "not-any") return !(side && side.any);
  const spec = needleOf(expected);
  if (!spec) return null;
  return textHits(sideText(side), spec);
}

function ruleHaystack(rule) {
  const service = rule.service ? rule.service.kind + " " + rule.service.name : "";
  return [
    rule.owner,
    (rule.roles || []).join(" "),
    rule.description,
    displayAction(rule.action),
    displayRuleType(rule.protocol),
    rule.serviceText,
    service,
    sideText(rule.source),
    sideText(rule.destination),
  ]
    .filter(Boolean)
    .join(" ");
}

export function ruleMatches(rule, match) {
  if (!match || typeof match !== "object" || Array.isArray(match)) {
    return { matched: false, unsupported: ["(match)"] };
  }
  const unsupported = [];
  const checks = [];
  for (const [key, expected] of Object.entries(match)) {
    if (!SUPPORTED.has(key)) {
      unsupported.push(key);
      continue;
    }
    if (key === "either" || key === "both") {
      if (expected === "any") {
        checks.push(key === "both" ? rule.source.any && rule.destination.any : rule.source.any || rule.destination.any);
      } else {
        const left = sideHits(rule.source, expected);
        const right = sideHits(rule.destination, expected);
        if (left === null || right === null) unsupported.push(key);
        else checks.push(key === "both" ? left && right : left || right);
      }
    } else if (key === "source" || key === "destination") {
      const hit = sideHits(rule[key], expected);
      if (hit === null) unsupported.push(key);
      else checks.push(hit);
    } else if (key === "action") {
      const spec = typeof expected === "string" ? { op: "is", value: expected.trim() } : needleOf(expected);
      if (!spec) unsupported.push(key);
      else if (spec.op === "is") checks.push(displayAction(rule.action).toUpperCase() === displayAction(spec.value).toUpperCase());
      else checks.push(displayAction(rule.action).toLowerCase().includes(spec.value.toLowerCase()));
    } else if (key === "service") {
      if (expected === "any" || expected === "not-any") {
        checks.push(expected === "any" ? serviceIsAny(rule) : !serviceIsAny(rule));
      } else {
        const spec = needleOf(expected);
        if (!spec) unsupported.push(key);
        else checks.push(textHits([rule.serviceText, rule.service && rule.service.name].filter(Boolean).join(" "), spec));
      }
    } else if (key === "keyword") {
      const spec = needleOf(expected);
      if (!spec) unsupported.push(key);
      else checks.push(textHits(ruleHaystack(rule), spec));
    }
  }
  if (unsupported.length || checks.length === 0) {
    return { matched: false, unsupported: unsupported.length ? unsupported : ["(empty match)"] };
  }
  return { matched: checks.every(Boolean), unsupported: [] };
}

/** No named service, no port, and the protocol is ANY or unset. */
function serviceIsAny(rule) {
  return serviceIsUnrestricted(rule);
}

function showsTag(finding) {
  if (!finding || !finding.tag) return false;
  return finding.source === "extra" || finding.source === "builtin";
}

function sideOf(rule) {
  if (rule.source.any && rule.destination.any) return "both";
  if (rule.source.any) return "source";
  if (rule.destination.any) return "destination";
  return "";
}

function kindLabel(kind) {
  return kind === "role-acl" ? "Role ACL" : "Policy";
}

function findingFor(spec, rule) {
  const side = sideOf(rule);
  const where = kindLabel(rule.kind) + " " + rule.owner + " rule " + rule.position;
  const arrow = rule.source.label + " → " + rule.destination.label;
  let why = spec.title;
  if (side === "both") why = "source and destination are ANY";
  else if (side === "source") why = "source is ANY";
  else if (side === "destination") why = "destination is ANY";
  return {
    ruleId: spec.id,
    title: spec.title,
    severity: spec.severity || "high",
    kind: rule.kind,
    name: rule.owner,
    position: rule.position,
    action: rule.action,
    side,
    destination: rule.destination.label,
    protocol: rule.protocol,
    roles: rule.roles.slice(),
    summary: where + " " + (rule.action === "—" ? "matches" : rule.action) + " " + arrow + " (" + why + ").",
    tag: spec.tag || "",
    color: ruleColor(spec.color),
    source: spec.source || "",
  };
}

/** Tags an extra rule puts on a role row. One tag per rule. */
export function tagsForRole(findings, roleName) {
  const seen = new Set();
  const tags = [];
  for (const finding of findings || []) {
    if (!showsTag(finding) || seen.has(finding.ruleId)) continue;
    const hit = (finding.roles || []).includes(roleName) || finding.name === roleName;
    if (!hit) continue;
    seen.add(finding.ruleId);
    tags.push({ id: finding.ruleId, tag: finding.tag || finding.title || finding.ruleId, color: ruleColor(finding.color) });
  }
  return tags;
}

/** Tags for one policy or ACL line inside an expanded role. */
export function tagsForPolicyRule(findings, rule) {
  const seen = new Set();
  const tags = [];
  for (const finding of findings || []) {
    if (!showsTag(finding) || seen.has(finding.ruleId)) continue;
    if (finding.kind !== rule.kind || finding.name !== rule.owner || finding.position !== rule.position) continue;
    seen.add(finding.ruleId);
    tags.push({ id: finding.ruleId, tag: finding.tag || finding.title || finding.ruleId, color: ruleColor(finding.color) });
  }
  return tags;
}

const FIELD_LABEL = {
  source: "Source",
  destination: "Destination",
  either: "Source or destination",
  both: "Both sides",
  action: "Action",
  service: "Service",
  keyword: "Keyword",
};

function describeOne(field, value) {
  const name = FIELD_LABEL[field] || field;
  if (value === "any") return name + " is ANY";
  if (value === "not-any") return name + " is not ANY";
  if (typeof value === "string" && value.trim()) {
    if (field === "action") return name + " is " + displayAction(value);
    return name + " contains " + value.trim();
  }
  if (value && typeof value === "object" && value.value) {
    const how = value.op === "is" ? "is" : "contains";
    const shown = field === "action" ? displayAction(value.value) : String(value.value);
    return name + " " + how + " " + shown;
  }
  return "";
}

/** Plain-language summary of a match object. */
export function describeMatch(match) {
  if (!match || typeof match !== "object") return "No match";
  const parts = [];
  for (const field of ["source", "destination", "either", "both", "action", "service", "keyword"]) {
    if (match[field] == null || match[field] === "") continue;
    const line = describeOne(field, match[field]);
    if (line) parts.push(line);
  }
  return parts.join(" · ") || "No match";
}

/**
 * @param {object} model normalize() output
 * @param {object[]} rules
 * @returns {{ findings: object[], skipped: { ruleId: string, keys: string[] }[] }}
 */
export function runRules(model, rules) {
  const findings = [];
  const skipped = [];
  const list = model && Array.isArray(model.rules) ? model.rules : [];
  for (const spec of rules || []) {
    if (!spec || spec.enabled === false) continue;
    const unsupported = new Set();
    let applied = false;
    for (const rule of list) {
      const result = ruleMatches(rule, spec.match);
      for (const key of result.unsupported) unsupported.add(key);
      if (result.unsupported.length) continue;
      applied = true;
      if (result.matched) findings.push(findingFor(spec, rule));
    }
    if (unsupported.size) {
      skipped.push({ ruleId: spec.id, title: spec.title || spec.id, keys: [...unsupported] });
    } else if (!applied && list.length === 0) {
      /* nothing to check */
    }
  }
  return { findings, skipped };
}

/**
 * Parse user-supplied rules. Only the declarative fields are kept.
 * A `check` function, even if someone pastes one, is dropped because
 * this engine does not run caller code.
 * @param {string} text
 * @param {string[]} reservedIds
 * @returns {{ rules: object[], error: string }}
 */
export function parseExtraRules(text, reservedIds = []) {
  const raw = String(text || "").trim();
  if (!raw) return { rules: [], error: "" };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { rules: [], error: "Extra rules are not valid JSON." };
  }
  if (!Array.isArray(data)) return { rules: [], error: "Extra rules must be a JSON array." };
  const reserved = new Set(reservedIds);
  const seen = new Set();
  const rules = [];
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { rules: [], error: "Each extra rule must be a JSON object." };
    }
    if (typeof item.id !== "string" || !item.id.trim()) {
      return { rules: [], error: "Each extra rule needs a string id." };
    }
    const id = item.id.trim().slice(0, 80);
    if (reserved.has(id) || seen.has(id)) {
      return { rules: [], error: "Rule id “" + id + "” is already used." };
    }
    if (!item.match || typeof item.match !== "object" || Array.isArray(item.match)) {
      return { rules: [], error: "Rule “" + id + "” needs a match object." };
    }
    seen.add(id);
    const tag = String(item.tag || item.title || id).trim().slice(0, 32) || id;
    rules.push({
      id,
      title: String(item.title || tag).slice(0, 140),
      tag,
      color: ruleColor(item.color),
      summary: String(item.summary || "").slice(0, 400),
      severity: SEVERITIES.has(item.severity) ? item.severity : "high",
      enabled: item.enabled !== false,
      match: item.match,
      source: "extra",
    });
  }
  return { rules, error: "" };
}
