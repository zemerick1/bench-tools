/**
 * Built-in ruleset. Add a match object here to grow the checker.
 * User-supplied rules use the same shape and are parsed by engine.js.
 *
 * Not implemented yet, on purpose: hit counts. The monitoring and ACL
 * payloads do not carry a hit total we can trust from these reads
 * (`count` on a role ACL only enables the counter). A match key such as
 * `hitCount` is reported as skipped until the engine grows a real check.
 */

export const builtinRules = [
  {
    id: "any-any",
    title: "Source or destination is ANY",
    summary:
      "Flag a policy rule or role-ACL rule when the source or the destination is ANY (ADDRESS_ANY, or a role named any).",
    severity: "high",
    enabled: true,
    match: { either: "any" },
    source: "builtin",
  },
  {
    id: "dest-service-any",
    title: "Destination and service are ANY",
    summary:
      "Flag a rule when the destination is ANY and the service or application is ANY. A named net-service, application, or a specific protocol such as TCP does not match. A role ACL with no protocol counts as any service.",
    severity: "high",
    enabled: true,
    match: { destination: "any", service: "any" },
    tag: "Any service",
    color: "red",
    source: "builtin",
  },
];
