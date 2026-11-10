# Role & Policy Auditor

Read-only look at an Aruba Central role library. It lists each role, how many connected clients are on it, and the policy or role-ACL rules tied to that name. One built-in rule flags a rule when the **source or the destination is ANY**. A second flags **destination ANY and any service or application** (no named net-service, application, or app category, and the protocol is ANY or unset).

Not a hit-count report, not a per-site effective-config walk, and not a change tool. A quiet report is not a sign-off.

## Credentials

Client ID and client secret from an HPE GreenLake personal API client are saved in **this browser’s `localStorage`** (`bt-role-auditor-creds`). There is no database.

A live check posts them to **`/proxy` on the host that served the page**. `functions/proxy.js` forwards that call to HPE and does not store the secret or the bearer. The allowlist is HPE hosts, so a LAN origin and the public site use the same function.

- The access token is kept in memory for the check and is **not** written to `localStorage`.
- The only POST the proxy allows is `https://sso.common.cloud.hpe.com/as/token.oauth2` with no query string.
- Central reads are GET only, and only to an allowed cluster host (`*.api.central.arubanetworks.com`, including `internal`, plus the China host). Redirects are not followed. Responses are not cached.
- `localStorage` is not encrypted. Forget the credentials on a shared machine.

The page says this again, on purpose.

## What it reads

Shared library (`view-type=LIBRARY`):

| GET | What |
|-----|------|
| `/network-config/v1alpha1/roles` | Role name, description, access VLAN |
| `/network-config/v1alpha1/policies` | `security-policy.policy-rule` source, destination, action |
| `/network-config/v1alpha1/role-acls` | `src-role`, destination `address-type`, `PERMIT` / `DENY` |
| `/network-monitoring/v1/clients` | Connected clients, counted by the `role` string |

A rule is that role’s permissions when the source role matches, or when the policy / role ACL has the same name.

`ADDRESS_ANY`, or a role literally named `any`, is an address of ANY. A protocol of ANY is any IP protocol. The address check does not look at protocol. The service check does: protocol ANY, or a role ACL with no protocol, counts as any service. A named net-service or a specific protocol such as TCP does not.

Role ACL `count: true` means the switch was told to count. It is not a hit total. Hit counts are intentionally not a match key yet.

## Ruleset

`engine.js` runs declarative match objects. No caller code.

| Key | Value | Meaning |
|-----|--------|---------|
| `either` / `both` | `"any"` or `{ op, value }` | source **or** / **and** destination |
| `source` / `destination` | `"any"`, `"not-any"`, a keyword, or `{ op: "is"\|"contains", value }` | that side. `"is"` is the whole address or name. `"contains"` is a keyword such as `172.16`. |
| `action` | string or `{ op, value }` | displayed action. `ALLOW` matches `ACTION_ALLOW`. `PERMIT` does not. |
| `service` | `"any"`, `"not-any"`, a keyword, or `{ op, value }` | `"any"` is no named service and protocol ANY or unset. Otherwise the net-service name, protocol, and ports |
| `keyword` | string | anywhere on the rule: addresses, service, description, role |

Every key has to match. Any other key (`hitCount`, for example) is skipped and named. The built-in rules in `rules.js` are `either: any`, and `destination: any` with `service: any`. The second one tags matching rows **Any service**. Extra rules are built on the page (conditions, tag, color) and stored in `localStorage` separately from the secret. A matching role gets that tag on its row.

## When `/proxy` is not running

The cluster API does not send CORS headers, so the page does not call it directly. `python3 -m http.server` returns 501 for `POST /proxy`. Run `python3 server.py` from the repo root instead. A snapshot still works:

```json
{
  "roles": { "role": [] },
  "policies": { "policy": [] },
  "roleAcls": { "acl": [] },
  "clients": { "items": [] }
}
```

`{ "items": [] }` wrappers from a paged read work too.

## Tests

```bash
node tools/role-auditor/test_engine.js
```
