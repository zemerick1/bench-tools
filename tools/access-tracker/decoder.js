/**
 * Access Tracker Translator — parse ClearPass Access Tracker exports
 * (Dashboard_Details.txt, optional Request_Logs.html, Service_Config.xml)
 * entirely in the browser. No network, no zip dependency.
 */
(function () {
  "use strict";

  // ─── DOM helpers ───────────────────────────────────────────────────────────

  /** @param {string} id */
  function $(id) {
    return document.getElementById(id);
  }

  /** @param {string} value */
  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  /**
   * @param {string} tag
   * @param {Record<string, string>} [attrs]
   * @param {(string | Node)[]} [kids]
   */
  function el(tag, attrs, kids) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "className") node.className = v;
        else if (k === "text") node.textContent = v;
        else node.setAttribute(k, v);
      }
    }
    if (kids) {
      for (const kid of kids) {
        if (kid == null) continue;
        node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
      }
    }
    return node;
  }

  // ─── RADIUS dictionaries (IETF / Aruba / HPE / Juniper) ────────────────────

  /**
   * Loaded from radius-dict.json (ClearPass TipsContents exports).
   * @type {null | {
   *   meta: { vendors: string[], attributeCount: number },
   *   vendors: Record<string, { id: number|string, name: string, prefix: string }>,
   *   attrs: Record<string, { id: number|string, type: string, vendor: string, name: string, enums?: Record<string,string> }>,
   *   shortIndex: Record<string, string>
   * }}
   */
  let radiusDict = null;

  /** @type {Promise<typeof radiusDict> | null} */
  let radiusDictPromise = null;

  function loadRadiusDict() {
    if (radiusDict) return Promise.resolve(radiusDict);
    if (radiusDictPromise) return radiusDictPromise;
    radiusDictPromise = fetch("./radius-dict.json", { cache: "force-cache" })
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then((data) => {
        radiusDict = data;
        return data;
      })
      .catch((err) => {
        console.warn("RADIUS dictionary not loaded:", err);
        radiusDictPromise = null;
        return null;
      });
    return radiusDictPromise;
  }

  /**
   * @param {string} key full ClearPass key e.g. Radius:IETF:NAS-Port-Type
   */
  function lookupRadiusAttr(key) {
    if (!radiusDict || !key) return null;
    if (radiusDict.attrs[key]) return radiusDict.attrs[key];
    // Already short or vendor:name
    if (radiusDict.shortIndex[key] && radiusDict.attrs[radiusDict.shortIndex[key]]) {
      return radiusDict.attrs[radiusDict.shortIndex[key]];
    }
    const parts = key.split(":");
    const short = parts[parts.length - 1];
    // Prefer vendor-qualified: Radius:Aruba:Aruba-User-Role
    if (parts.length >= 3) {
      const vendor = parts[parts.length - 2];
      const guess = `Radius:${vendor}:${short}`;
      if (radiusDict.attrs[guess]) return radiusDict.attrs[guess];
    }
    if (radiusDict.shortIndex[short] && radiusDict.attrs[radiusDict.shortIndex[short]]) {
      return radiusDict.attrs[radiusDict.shortIndex[short]];
    }
    return null;
  }

  /**
   * Decode a RADIUS attribute value using dictionary enums.
   * @param {string} key
   * @param {string} value
   * @returns {{ display: string, enumLabel: string, type: string, attrId: string|number|'', vendor: string }}
   */
  function enrichRadiusValue(key, value) {
    const def = lookupRadiusAttr(key);
    const raw = value == null ? "" : String(value);
    if (!def) {
      return { display: raw, enumLabel: "", type: "", attrId: "", vendor: "" };
    }
    let enumLabel = "";
    if (def.enums) {
      const trimmed = raw.trim();
      if (def.enums[trimmed]) {
        enumLabel = def.enums[trimmed];
      } else {
        // "15" or "15 (legacy note)" or multi-value "1 | 2"
        const firstToken = trimmed.split(/\s+/)[0];
        if (def.enums[firstToken]) enumLabel = def.enums[firstToken];
        else if (trimmed.includes(" | ")) {
          const parts = trimmed.split(" | ").map((p) => {
            const t = p.trim();
            return def.enums[t] ? `${t} (${def.enums[t]})` : t;
          });
          return {
            display: parts.join(" | "),
            enumLabel: "",
            type: def.type || "",
            attrId: def.id,
            vendor: def.vendor || "",
          };
        }
      }
    }
    let display = raw;
    if (enumLabel) {
      // Avoid "Ethernet (Ethernet)" if value already named
      if (raw === enumLabel || raw.includes(enumLabel)) display = raw;
      else display = `${raw} (${enumLabel})`;
    }
    return {
      display,
      enumLabel,
      type: def.type || "",
      attrId: def.id,
      vendor: def.vendor || "",
    };
  }

  // ─── Known ClearPass error codes (common ones) ─────────────────────────────

  /** @type {Record<string, string>} */
  const ERROR_PLAIN = {
    "201": "Authentication source failed or returned no match.",
    "202": "User authentication failed (bad credentials or unknown user).",
    "203": "Authorization source failure.",
    "204": "Service categorization failed — no matching service, or policy server timed out before a service was chosen.",
    "205": "Internal error during request processing.",
    "206": "Access denied by policy — auth often succeeded, but enforcement returned Deny.",
    "207": "Web authentication failure.",
    "208": "User account disabled or expired.",
    "209": "User account locked.",
    "215": "Insufficient privileges for this request.",
    "216": "Posture check failed.",
    "217": "MAC authentication failed (unknown or unauthorized client).",
    "221": "Session timeout / request timed out waiting on policy or auth.",
    "225": "Guest/device account disabled.",
    "226": "Guest/device account expired.",
  };

  // ─── Dashboard_Details.txt parser ──────────────────────────────────────────

  /**
   * Split Access Tracker text into named sections.
   * Section headers look like "Request Details Summary -" or "  Network Details -"
   * @param {string} text
   * @returns {{ order: string[], sections: Record<string, string[]> }}
   */
  function splitSections(text) {
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    /** @type {Record<string, string[]>} */
    const sections = {};
    /** @type {string[]} */
    const order = [];
    let current = "_preamble";
    sections[current] = [];
    order.push(current);

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      // Header: optional indent, title, space, trailing dash (optionally more)
      const m = line.match(/^(\s*)(.+?)\s+-\s*$/);
      if (m && m[2].length > 1 && !m[2].includes("=")) {
        current = m[2].trim();
        if (!sections[current]) {
          sections[current] = [];
          order.push(current);
        }
        continue;
      }
      if (!sections[current]) sections[current] = [];
      sections[current].push(line);
    }
    return { order, sections };
  }

  /**
   * Parse " Key: Value" lines (summary / policies / alerts style).
   * @param {string[]} lines
   * @returns {Record<string, string>}
   */
  function parseColonPairs(lines) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // "Alerts for this Request -" style handled by section split; skip bullets for now
      const m = trimmed.match(/^([^:=]+?)\s*:\s*(.*)$/);
      if (!m) continue;
      const key = m[1].trim();
      const val = m[2].trim();
      // Prefer first non-empty; for duplicate keys (rare), keep last non-empty
      if (val || out[key] === undefined) out[key] = val;
    }
    return out;
  }

  /**
   * Parse " Key = Value" attribute lines.
   * @param {string[]} lines
   * @returns {{ key: string, value: string }[]}
   */
  function parseEqAttributes(lines) {
    /** @type {{ key: string, value: string }[]} */
    const out = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf(" = ");
      if (eq === -1) {
        // also accept "Key=Value" without spaces
        const eq2 = trimmed.indexOf("=");
        if (eq2 <= 0) continue;
        out.push({
          key: trimmed.slice(0, eq2).trim(),
          value: trimmed.slice(eq2 + 1).trim(),
        });
        continue;
      }
      out.push({
        key: trimmed.slice(0, eq).trim(),
        value: trimmed.slice(eq + 3).trim(),
      });
    }
    return out;
  }

  /**
   * @param {{ key: string, value: string }[]} attrs
   * @returns {Record<string, string>}
   */
  function attrsToMap(attrs) {
    /** @type {Record<string, string>} */
    const map = {};
    for (const { key, value } of attrs) {
      // Multi-valued keys (e.g. Session-Notify:Login Action): keep first, store all under __all
      if (map[key] === undefined) map[key] = value;
      else map[key] = map[key] + " | " + value;
    }
    return map;
  }

  /**
   * Alerts section: colon pairs + freeform alert lines under "Alerts for this Request"
   * @param {string[]} lines
   */
  function parseAlerts(lines) {
    const pairs = parseColonPairs(lines);
    /** @type {string[]} */
    const messages = [];
    let inList = false;
    for (const line of lines) {
      const t = line.trim();
      if (/^Alerts for this Request/i.test(t)) {
        inList = true;
        continue;
      }
      if (inList && t) {
        // skip pure "Key: Value" if it's another error field
        if (/^Error (Code|Category|Message)\s*:/i.test(t)) continue;
        messages.push(t.replace(/^RADIUS:\s*/i, "").trim());
      }
    }
    return {
      errorCode: pairs["Error Code"] || "",
      errorCategory: pairs["Error Category"] || "",
      errorMessage: pairs["Error Message"] || "",
      messages,
    };
  }

  /**
   * @param {string} text
   */
  function parseDashboard(text) {
    const { order, sections } = splitSections(text);

    const summary = parseColonPairs(sections["Request Details Summary"] || []);
    const policies = parseColonPairs(sections["Policies Used"] || []);

    const radiusIn = parseEqAttributes(sections["Input RADIUS Attributes"] || []);
    const computed = parseEqAttributes(sections["Input Computed Attributes"] || []);
    const authz = parseEqAttributes(sections["Input Authorization Attributes"] || []);
    const radiusOut = parseEqAttributes(sections["Output RADIUS Attributes"] || []);

    const computedMap = attrsToMap(computed);
    const radiusInMap = attrsToMap(radiusIn);
    const radiusOutMap = attrsToMap(radiusOut);

    const alerts = sections["Alerts"]
      ? parseAlerts(sections["Alerts"])
      : { errorCode: "", errorCategory: "", errorMessage: "", messages: [] };

    // TACACS variants use different labels
    const sessionId =
      summary["Session Identifier"] ||
      summary["Session ID"] ||
      computedMap["Tips:Session-Id"] ||
      "";
    const when = summary["Date and Time"] || computedMap["Date:Date-Time"] || "";
    const username =
      summary["Username"] ||
      computedMap["Authentication:Full-Username"] ||
      computedMap["Authentication:Username"] ||
      "";
    const endHost =
      summary["End-Host Identifier"] ||
      computedMap["Connection:Client-Mac-Address"] ||
      "";
    const nadIpPort = summary["Access Device IP/Port"] || "";
    const nadName = summary["Access Device Name"] || "";
    const loginStatus =
      summary["Login Status"] ||
      summary["Status"] ||
      "";
    const requestType = summary["Request Type"] || "";

    const protocol =
      computedMap["Connection:Protocol"] ||
      (requestType.toUpperCase().includes("TACACS") ? "TACACS" : "") ||
      (radiusIn.length ? "RADIUS" : "");

    return {
      rawSections: sections,
      sectionOrder: order,
      summary,
      policies,
      radiusIn,
      radiusInMap,
      computed,
      computedMap,
      authz,
      radiusOut,
      radiusOutMap,
      alerts,
      sessionId,
      when,
      username,
      endHost,
      nadIpPort,
      nadName,
      loginStatus,
      requestType,
      protocol,
    };
  }

  // ─── Request_Logs.html parser ──────────────────────────────────────────────

  /**
   * @param {string} html
   * @returns {{ time: string, message: string, level: 'info'|'warn'|'alert'|'empty', rawClass: string }[]}
   */
  function parseRequestLogs(html) {
    /** @type {{ time: string, message: string, level: 'info'|'warn'|'alert'|'empty', rawClass: string }[]} */
    const rows = [];
    const doc = new DOMParser().parseFromString(html, "text/html");
    const trs = doc.querySelectorAll("table tr");
    for (const tr of trs) {
      const tds = tr.querySelectorAll("td");
      if (tds.length < 1) continue;
      const cls = tr.getAttribute("class") || "";
      const time = (tds[0] && tds[0].textContent ? tds[0].textContent : "").trim();
      const message = (
        tds.length > 1 && tds[1].textContent
          ? tds[1].textContent
          : tds[0].textContent || ""
      ).trim();
      if (!message) continue;
      if (/^No Logs for this Session$/i.test(message)) {
        rows.push({ time: "", message, level: "empty", rawClass: cls });
        continue;
      }
      let level = /** @type {'info'|'warn'|'alert'} */ ("info");
      if (/Alert/i.test(cls)) level = "alert";
      else if (/Warn/i.test(cls)) level = "warn";
      rows.push({ time, message, level, rawClass: cls });
    }
    return rows;
  }

  /**
   * Internal CPPM log lines that rarely help end users.
   * @param {string} msg
   */
  function isNoisyLogLine(msg) {
    return (
      /TLS_accept:error in SSLv3/i.test(msg) ||
      /Fetching Radius attributes from battery failed/i.test(msg) ||
      /getAppType:\s*Failed/i.test(msg) ||
      /getSohr:\s*Failed/i.test(msg) ||
      /getFinalSessionTimeout:\s*sessionTimeout\s*=\s*0/i.test(msg) ||
      /getSessionTimeoutInSecs:\s*SessionTimeout attribute missing/i.test(msg) ||
      /Failed to get MacAuth session info/i.test(msg) ||
      /handleMacAuthSessionResponseEv:\s*Error reading MacAuth/i.test(msg) ||
      /Prerequisites set is empty/i.test(msg) ||
      /No TagDefCacheMap could be found/i.test(msg) ||
      /Tags cannot be built for instanceId=0/i.test(msg) ||
      /No tags built for instanceId/i.test(msg)
    );
  }

  /**
   * Pull high-signal lines from request logs.
   * @param {{ time: string, message: string, level: string }[]} rows
   */
  function summarizeLogs(rows) {
    /** @type {string[]} */
    const highlights = [];
    /** @type {string[]} */
    const warnings = [];
    let serviceCatMs = "";
    let policyEvalMs = "";
    let categorizedService = "";
    let enfOutcome = "";

    for (const row of rows) {
      if (row.level === "empty") continue;
      const m = row.message;
      if (isNoisyLogLine(m)) continue;

      const catTime = m.match(/Service Categorization time\s*=\s*(\d+\s*ms)/i);
      if (catTime) serviceCatMs = catTime[1];

      const polTime = m.match(/Policy Evaluation time\s*=\s*(\d+\s*ms)/i);
      if (polTime) policyEvalMs = polTime[1];

      const cat = m.match(
        /categorized into service\s+"([^"]+)"/i
      );
      if (cat) categorizedService = cat[1];

      if (/Received Deny Enforcement Profile/i.test(m)) {
        enfOutcome = "Deny";
        highlights.push("Policy returned Deny Enforcement Profile.");
      } else if (/Received Accept Enforcement Profile/i.test(m)) {
        enfOutcome = "Accept";
        highlights.push("Policy returned Accept Enforcement Profile.");
      }

      if (/Service classification result\s*=\s*(.+)/i.test(m)) {
        const sm = m.match(/Service classification result\s*=\s*(.+)/i);
        if (sm) categorizedService = sm[1].trim();
      }

      // Roles / EnfProfiles lines from policy engine
      const rolesLine = m.match(/PETaskRoleMapping\s*-\s*Roles:\s*(.+)/i);
      if (rolesLine) {
        const h = `Roles mapped: ${rolesLine[1].trim()}`;
        if (!highlights.includes(h)) highlights.push(h);
      }
      const enfLine = m.match(/PETaskEnforcement\s*-\s*EnfProfiles:\s*(.+)/i);
      if (enfLine) {
        const h = `Enforcement profiles: ${enfLine[1].trim()}`;
        if (!highlights.includes(h)) highlights.push(h);
      }

      if (
        /timeout|timed out|failed|denied|error\s+\d|no matching service|unknown client/i.test(
          m
        )
      ) {
        if (row.level === "warn" || row.level === "alert" || /error|fail|denied|timeout/i.test(m)) {
          const short = cleanLogMessage(m);
          if (short && !warnings.includes(short) && !isNoisyLogLine(short)) {
            warnings.push(short);
          }
        }
      }

      if (row.level === "warn" || row.level === "alert") {
        const short = cleanLogMessage(m);
        if (short && !warnings.includes(short) && !isNoisyLogLine(m)) {
          warnings.push(short);
        }
      }
    }

    return {
      highlights,
      warnings,
      serviceCatMs,
      policyEvalMs,
      categorizedService,
      enfOutcome,
      hasLogs: rows.length > 0 && !(rows.length === 1 && rows[0].level === "empty"),
    };
  }

  /** @param {string} msg */
  function cleanLogMessage(msg) {
    // Strip thread/session prefixes like [Th 174 Req ...]
    return msg
      .replace(/^\[[^\]]+\]\s*/g, "")
      .replace(/^(INFO|WARN|ERROR|DEBUG)\s+\S+\s+-\s*/i, "")
      .trim();
  }

  /**
   * Expand ClearPass multi-line RADIUS attribute values (literal \n).
   * @param {string} value
   */
  function expandAttrValue(value) {
    if (!value) return "";
    return value
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t");
  }

  /**
   * Parse downloadable user-role blobs (Aruba-CPPM-Role / HPE-CPPM-Role).
   * @param {string} raw
   * @returns {{ kind: string, profileName: string, switchRole: string, vlanAccess: string, vlanTagged: string, policies: string[], summary: string, body: string }}
   */
  function parseDownloadableRole(raw) {
    const body = expandAttrValue(raw).trim();
    const lines = body.split(/\n/).map((l) => l.trim()).filter(Boolean);
    const profileName = lines[0] || "";

    let switchRole = "";
    const portRole = body.match(/port-access\s+role\s+(\S+)/i);
    if (portRole) switchRole = portRole[1];
    const aaaRole = body.match(
      /aaa\s+authorization\s+user-role\s+name\s+"([^"]+)"/i
    );
    if (aaaRole) switchRole = switchRole || aaaRole[1];
    // AOS-S sometimes uses: aaa authorization user-role name "..."
    if (!switchRole) {
      const bare = body.match(/user-role\s+name\s+"([^"]+)"/i);
      if (bare) switchRole = bare[1];
    }

    let vlanAccess = "";
    const va = body.match(/vlan\s+access\s+(\d+)/i);
    if (va) vlanAccess = va[1];
    const vid = body.match(/vlan-id\s+(\d+)/i);
    if (vid) vlanAccess = vlanAccess || vid[1];

    let vlanTagged = "";
    const vt = body.match(/vlan-id-tagged\s+([0-9,\s-]+)/i);
    if (vt) vlanTagged = vt[1].replace(/\s+/g, "");

    /** @type {string[]} */
    const policies = [];
    const polRe = /(?:port-access\s+)?policy\s+(?:user\s+)?"?([A-Za-z0-9._-]+)"?/gi;
    let pm;
    while ((pm = polRe.exec(body))) {
      if (!policies.includes(pm[1])) policies.push(pm[1]);
    }

    const bits = [];
    if (switchRole) bits.push(`role ${switchRole}`);
    if (vlanAccess) bits.push(`VLAN ${vlanAccess}`);
    if (vlanTagged) bits.push(`tagged VLANs ${vlanTagged}`);
    if (profileName && !switchRole) bits.push(profileName);

    return {
      kind: "downloadable-role",
      profileName,
      switchRole,
      vlanAccess,
      vlanTagged,
      policies,
      summary: bits.join(" · ") || profileName || "downloadable role",
      body,
    };
  }

  /**
   * Pull enforcement-related RADIUS *output* attributes with correct labels.
   *
   * IMPORTANT (Aruba / ClearPass):
   * - "Role" means Tips role mapping and/or Aruba-User-Role / DUR role name.
   * - Filter-Id is an ACL/filter id — NEVER a role.
   * - Tunnel-Private-Group-Id is typically VLAN (when Tunnel-Type is VLAN).
   *
   * @param {Record<string, string>} outMap
   * @param {{ key: string, value: string }[]} outList
   */
  function extractEnforcementPayload(outMap, outList) {
    /** @param {string[]} names */
    function firstOf(names) {
      for (const n of names) {
        if (outMap[n] != null && outMap[n] !== "") return { key: n, value: outMap[n] };
      }
      // fall back to scanning outList (suffix match)
      for (const { key, value } of outList) {
        for (const n of names) {
          if (key === n || key.endsWith(":" + n) || key.endsWith(n)) {
            if (value != null && value !== "") return { key, value };
          }
        }
      }
      return null;
    }

    const arubaUserRole = firstOf([
      "Radius:Aruba:Aruba-User-Role",
      "Aruba-User-Role",
    ]);
    const hpeUserRole = firstOf([
      "Radius:Hewlett-Packard-Enterprise:HPE-User-Role",
      "HPE-User-Role",
    ]);
    const arubaCppm = firstOf([
      "Radius:Aruba:Aruba-CPPM-Role",
      "Aruba-CPPM-Role",
    ]);
    const hpeCppm = firstOf([
      "Radius:Hewlett-Packard-Enterprise:HPE-CPPM-Role",
      "HPE-CPPM-Role",
    ]);
    const filterId = firstOf([
      "Radius:IETF:Filter-Id",
      "Filter-Id",
    ]);
    const tunnelGroup = firstOf([
      "Radius:IETF:Tunnel-Private-Group-Id",
      "Tunnel-Private-Group-Id",
    ]);
    const tunnelType = firstOf([
      "Radius:IETF:Tunnel-Type",
      "Tunnel-Type",
    ]);
    const tunnelMedium = firstOf([
      "Radius:IETF:Tunnel-Medium-Type",
      "Tunnel-Medium-Type",
    ]);

    // Downloadable user role blob (AOS-CX / AOS-S style) — role name lives inside CLI text
    let dur = null;
    if (arubaCppm) {
      dur = { key: arubaCppm.key, ...parseDownloadableRole(arubaCppm.value) };
    } else if (hpeCppm) {
      dur = { key: hpeCppm.key, ...parseDownloadableRole(hpeCppm.value) };
    }

    // True NAD "user role" attributes only
    const nadRole =
      (arubaUserRole && arubaUserRole.value) ||
      (hpeUserRole && hpeUserRole.value) ||
      (dur && dur.switchRole) ||
      "";

    // VLAN from tunnel attrs and/or DUR
    let vlanAccess = "";
    let vlanSource = "";
    if (tunnelGroup) {
      // strip RADIUS tunnel tag prefix if present (e.g. "1:14" or "VLAN=14")
      vlanAccess = String(tunnelGroup.value).replace(/^.*?;/, "").trim() ||
        String(tunnelGroup.value).trim();
      vlanAccess = vlanAccess.replace(/^\d+:/, ""); // "1:14" → "14" sometimes
      vlanSource = "Tunnel-Private-Group-Id";
    }
    if (dur && dur.vlanAccess) {
      if (!vlanAccess) {
        vlanAccess = dur.vlanAccess;
        vlanSource = "downloadable role";
      }
    }

    const tunnelTypeLabel = tunnelType
      ? enrichRadiusValue(tunnelType.key, tunnelType.value).display
      : "";
    const isVlanTunnel =
      !tunnelType ||
      String(tunnelType.value) === "13" ||
      /vlan/i.test(tunnelTypeLabel);

    /** @type {string[]} */
    const summaryBits = [];
    if (nadRole) summaryBits.push(`role ${nadRole}`);
    if (vlanAccess && isVlanTunnel) summaryBits.push(`VLAN ${vlanAccess}`);
    else if (vlanAccess) summaryBits.push(`tunnel group ${vlanAccess}`);
    if (filterId) summaryBits.push(`Filter-Id ${filterId.value}`);
    if (dur && dur.vlanTagged) summaryBits.push(`tagged ${dur.vlanTagged}`);

    // kind for UI: what dominated the output
    let kind = "none";
    if (dur) kind = "downloadable-role";
    else if (nadRole) kind = "user-role";
    else if (vlanAccess || filterId) kind = "ietf-enforcement";
    else if (summaryBits.length) kind = "mixed";

    if (!summaryBits.length && !dur && !filterId && !vlanAccess && !nadRole) {
      return null;
    }

    return {
      key: (dur && dur.key) || (arubaUserRole && arubaUserRole.key) || (filterId && filterId.key) || "",
      kind,
      // ONLY true roles go here — never Filter-Id
      switchRole: nadRole || "",
      arubaUserRole: (arubaUserRole && arubaUserRole.value) || "",
      hpeUserRole: (hpeUserRole && hpeUserRole.value) || "",
      filterId: (filterId && filterId.value) || "",
      vlanAccess: isVlanTunnel ? vlanAccess : vlanAccess,
      vlanSource,
      vlanTagged: (dur && dur.vlanTagged) || "",
      tunnelType: (tunnelType && tunnelType.value) || "",
      tunnelTypeLabel,
      tunnelMedium: (tunnelMedium && tunnelMedium.value) || "",
      profileName: (dur && dur.profileName) || "",
      policies: (dur && dur.policies) || [],
      summary: summaryBits.join(" · ") || "enforcement attributes",
      body: (dur && dur.body) || "",
      // keep DUR parse extras for UI
      dur,
    };
  }

  /** @param {string} value */
  function looksLikeMac(value) {
    if (!value) return false;
    const hex = value.replace(/[^0-9a-fA-F]/g, "");
    return hex.length === 12 && /^[0-9a-fA-F]+$/.test(hex);
  }

  /**
   * Resolve NAS-Port-Type (and similar) labels from the loaded dictionary.
   * @param {string} raw
   * @param {string} [attrKey]
   */
  function enumLabelFor(raw, attrKey) {
    if (!raw && raw !== 0) return "";
    const enriched = enrichRadiusValue(
      attrKey || "Radius:IETF:NAS-Port-Type",
      String(raw)
    );
    return enriched.enumLabel || "";
  }

  // ─── Service_Config.xml parser ─────────────────────────────────────────────

  /**
   * @param {string} xmlText
   */
  function parseServiceConfig(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    const parseError = doc.querySelector("parsererror");
    if (parseError) {
      return { error: "Could not parse Service_Config.xml", services: [] };
    }

    // Namespace-agnostic helpers
    /** @param {Element | Document} root @param {string} local */
    function all(root, local) {
      return Array.from(root.getElementsByTagName("*")).filter(
        (n) => n.localName === local
      );
    }
    /** @param {Element} el @param {string} name */
    function attr(el, name) {
      return el.getAttribute(name) || "";
    }

    const serviceEls = all(doc, "RadiusEnforcementService").concat(
      all(doc, "TacacsEnforcementService")
    );

    const services = serviceEls.map((svc) => {
      const name = attr(svc, "name");
      const description = attr(svc, "description");
      const enabled = attr(svc, "enabled");
      const monitor = attr(svc, "monitor");
      const template =
        (all(svc, "ServiceTemplate")[0]?.textContent || "").trim();

      // Match rules
      /** @type {{ type: string, name: string, operator: string, value: string, displayValue: string }[]} */
      const rules = [];
      let ruleCombine = "";
      for (const expr of all(svc, "RuleExpression")) {
        ruleCombine =
          attr(expr, "displayOperator") || attr(expr, "operator") || ruleCombine;
        for (const ra of all(expr, "RuleAttribute")) {
          rules.push({
            type: attr(ra, "type"),
            name: attr(ra, "name"),
            operator: attr(ra, "operator"),
            value: attr(ra, "value"),
            displayValue: attr(ra, "displayValue") || attr(ra, "value"),
          });
        }
      }

      /** @param {string} listLocal */
      function stringList(listLocal) {
        const lists = all(svc, listLocal);
        /** @type {string[]} */
        const items = [];
        for (const list of lists) {
          for (const s of all(list, "string")) {
            const t = (s.textContent || "").trim();
            if (t) items.push(t);
          }
        }
        return items;
      }

      return {
        name,
        description,
        enabled,
        monitor,
        template,
        ruleCombine,
        rules,
        authMethods: stringList("AuthMethodNameList"),
        authSources: stringList("AuthSourceNameList"),
        autzSources: stringList("AutzSourceNameList"),
        roleMappings: stringList("RoleMappingNameList"),
        enfPolicies: stringList("EnfPolicyNameList"),
      };
    });

    /**
     * Parse Condition/Result rules under a RoleMapping or EnforcementPolicy.
     * @param {Element} parent
     */
    function parsePolicyRules(parent) {
      /** @type {{ combine: string, conditions: { type: string, name: string, operator: string, value: string, displayValue: string }[], results: { type: string, name: string, value: string, displayValue: string }[] }[]} */
      const out = [];
      for (const rl of all(parent, "RuleList")) {
        const kids = Array.from(rl.children || []);
        for (const ruleEl of kids) {
          if (ruleEl.localName !== "Rule") continue;
          let combine = "AND";
          /** @type {{ type: string, name: string, operator: string, value: string, displayValue: string }[]} */
          const conditions = [];
          /** @type {{ type: string, name: string, value: string, displayValue: string }[]} */
          const results = [];

          // Role maps use <Expression>; some exports use <RuleExpression>
          const exprs = all(ruleEl, "Expression").concat(
            all(ruleEl, "RuleExpression")
          );
          const firstExpr = exprs[0];
          if (firstExpr) {
            combine =
              attr(firstExpr, "displayOperator") ||
              attr(firstExpr, "operator") ||
              combine;
          }

          // Conditions: RuleAttributes that are not under ResultList
          for (const ra of all(ruleEl, "RuleAttribute")) {
            // Skip if inside ResultList
            let p = ra.parentElement;
            let inResult = false;
            while (p && p !== ruleEl) {
              if (p.localName === "ResultList") {
                inResult = true;
                break;
              }
              p = p.parentElement;
            }
            if (inResult) continue;
            conditions.push({
              type: attr(ra, "type"),
              name: attr(ra, "name"),
              operator: attr(ra, "operator"),
              value: attr(ra, "value"),
              displayValue: attr(ra, "displayValue") || attr(ra, "value"),
            });
          }

          for (const rr of all(ruleEl, "RuleResult")) {
            results.push({
              type: attr(rr, "type"),
              name: attr(rr, "name"),
              value: attr(rr, "value"),
              displayValue: attr(rr, "displayValue") || attr(rr, "value"),
            });
          }

          if (conditions.length || results.length) {
            out.push({ combine, conditions, results });
          }
        }
      }
      return out;
    }

    // Role mapping policies with full rules
    const roleMaps = all(doc, "RoleMapping").map((rm) => {
      const name = attr(rm, "name");
      const dft = attr(rm, "dftRoleName");
      const algo =
        attr(rm, "ruleCombineAlgo") ||
        (all(rm, "Policy")[0]
          ? attr(all(rm, "Policy")[0], "ruleCombiningAlgorithm")
          : "");
      const rules = parsePolicyRules(rm);
      return {
        name,
        defaultRole: dft,
        algorithm: algo,
        ruleCount: rules.length,
        rules,
      };
    });

    // Enforcement policies with full rules
    const enfPolicies = all(doc, "EnforcementPolicy").map((ep) => {
      const name = attr(ep, "name");
      const defaultProfile =
        attr(ep, "defaultProfileName") || attr(ep, "defaultEnfProfile");
      const algo = all(ep, "Policy")[0]
        ? attr(all(ep, "Policy")[0], "ruleCombiningAlgorithm")
        : "";
      const rules = parsePolicyRules(ep);
      return {
        name,
        defaultProfile,
        algorithm: algo,
        ruleCount: rules.length,
        rules,
      };
    });

    // NAD clients (hygiene)
    const nads = all(doc, "NadClient").map((n) => ({
      name: attr(n, "name"),
      ipAddress: attr(n, "ipAddress") || attr(n, "ipaddress"),
      description: attr(n, "description"),
      vendor: attr(n, "vendorName") || attr(n, "vendor"),
    }));

    // NAD groups (for BELONGS_TO_GROUP)
    const nadGroups = all(doc, "NadGroup").map((g) => ({
      name: attr(g, "name"),
      members: attr(g, "members"),
      membersFormat: attr(g, "membersFormat"),
    }));

    return {
      error: "",
      exportTime: (() => {
        const h = all(doc, "TipsHeader")[0];
        return h ? attr(h, "exportTime") : "";
      })(),
      version: (() => {
        const h = all(doc, "TipsHeader")[0];
        return h ? attr(h, "version") : "";
      })(),
      services,
      roleMaps,
      enfPolicies,
      nads,
      nadGroups,
    };
  }

  // ─── Policy rule evaluation (WHY) ──────────────────────────────────────────

  /**
   * Build attribute bag from the session for rule evaluation.
   * Keys look like Connection:Client-Mac-Vendor, Tips:Role, …
   * @param {ReturnType<typeof parseDashboard>} dash
   * @param {string[]} assignedRoles
   * @returns {Record<string, string[]>}
   */
  function buildAttrBag(dash, assignedRoles) {
    /** @type {Record<string, string[]>} */
    const bag = {};
    /** @param {string} k @param {string} v */
    function add(k, v) {
      if (k == null || v == null || v === "") return;
      const key = String(k);
      const val = String(v).trim();
      if (!val) return;
      if (!bag[key]) bag[key] = [];
      if (!bag[key].includes(val)) bag[key].push(val);
    }

    for (const { key, value } of [
      ...dash.radiusIn,
      ...dash.computed,
      ...dash.authz,
    ]) {
      add(key, value);
      // Expand multi-value joined with " | "
      if (value && value.includes(" | ")) {
        for (const part of value.split(" | ")) add(key, part.trim());
      }
    }

    // Policy fields
    if (dash.policies["Service"]) add("Tips:Service", dash.policies["Service"]);
    for (const role of assignedRoles) {
      add("Tips:Role", role);
      // bare name too
      add("Role", role);
    }

    // Helpful aliases
    if (dash.computedMap["Connection:Client-Mac-Vendor"]) {
      add(
        "Connection:Client-Mac-Vendor",
        dash.computedMap["Connection:Client-Mac-Vendor"]
      );
    }
    if (dash.computedMap["Connection:NAD-IP-Address"]) {
      add(
        "Connection:NAD-IP-Address",
        dash.computedMap["Connection:NAD-IP-Address"]
      );
    }
    if (dash.computedMap["Connection:SSID"]) {
      add("Connection:SSID", dash.computedMap["Connection:SSID"]);
    }
    if (dash.computedMap["Device:Location"]) {
      add("Device:Location", dash.computedMap["Device:Location"]);
    }

    return bag;
  }

  /**
   * @param {string} ip
   * @param {string} cidrOrIp e.g. 10.1.1.1/24 or 10.5.1.3
   */
  function ipv4InMember(ip, cidrOrIp) {
    const target = (ip || "").trim();
    const spec = (cidrOrIp || "").trim();
    if (!target || !spec) return false;
    if (!spec.includes("/")) return target === spec;
    const [base, bitsStr] = spec.split("/");
    const bits = parseInt(bitsStr, 10);
    if (!base || Number.isNaN(bits) || bits < 0 || bits > 32) return false;
    /** @param {string} a */
    function toInt(a) {
      const p = a.split(".").map((x) => parseInt(x, 10));
      if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255))
        return null;
      return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
    }
    const ipInt = toInt(target);
    const baseInt = toInt(base);
    if (ipInt == null || baseInt == null) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipInt & mask) === (baseInt & mask);
  }

  /**
   * @param {string} ip
   * @param {string} membersCsv
   */
  function ipInGroupMembers(ip, membersCsv) {
    if (!ip || !membersCsv) return false;
    for (const part of membersCsv.split(/[,;]/)) {
      if (ipv4InMember(ip, part.trim())) return true;
    }
    return false;
  }

  /**
   * Resolve ClearPass %{Type:Name} placeholders against the attribute bag.
   * @param {string} raw
   * @param {Record<string, string[]>} bag
   */
  function resolveTemplate(raw, bag) {
    if (!raw || typeof raw !== "string") return raw;
    return raw.replace(/%\{([^}]+)\}/g, (_, ref) => {
      const vals = bag[ref] || [];
      return vals[0] != null ? vals[0] : "";
    });
  }

  /**
   * @param {{ type: string, name: string, operator: string, value: string, displayValue: string }} cond
   * @param {Record<string, string[]>} bag
   * @param {{ name: string, members: string }[]} nadGroups
   */
  function evalCondition(cond, bag, nadGroups) {
    const key = `${cond.type}:${cond.name}`;
    const values = bag[key] || bag[cond.name] || [];
    let expected = cond.value || cond.displayValue || "";
    // Prefer displayValue for BELONGS_TO_GROUP (value is often NadGroup:id)
    if (/BELONGS_TO_GROUP/i.test(cond.operator || "") && cond.displayValue) {
      expected = cond.displayValue;
    }
    expected = resolveTemplate(expected, bag);
    const op = (cond.operator || "EQUALS").toUpperCase().replace(/-/g, "_");

    /** @param {string} a @param {string} b */
    const eq = (a, b) =>
      String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
    /** @param {string} a @param {string} b */
    const contains = (a, b) =>
      String(a).toLowerCase().includes(String(b).toLowerCase());

    if (op === "EQUALS" || op === "EQ" || op === "EQUAL") {
      if (!values.length) return false;
      /** @param {string} s */
      const loose = (s) => {
        const hex = String(s).replace(/[^0-9a-fA-F]/g, "").toLowerCase();
        return hex.length === 12 ? hex : String(s).trim().toLowerCase();
      };
      return values.some(
        (v) => eq(v, expected) || loose(v) === loose(expected)
      );
    }
    if (op === "NOT_EQUALS" || op === "NOT_EQUAL" || op === "NE") {
      return values.length > 0 && values.every((v) => !eq(v, expected));
    }
    if (op === "CONTAINS") {
      return values.some((v) => contains(v, expected));
    }
    if (op === "NOT_CONTAINS") {
      return values.length > 0 && values.every((v) => !contains(v, expected));
    }
    if (op === "EXISTS" || op === "PRESENT") {
      return values.length > 0 && values.some((v) => v !== "");
    }
    if (op === "NOT_EXISTS" || op === "NOT_PRESENT") {
      return values.length === 0;
    }
    if (op === "BELONGS_TO" || op === "MEMBER_OF") {
      // expected may be "Login-User (1), Call-Check (10)" or "15, 19"
      const tokens = String(expected)
        .split(/[,;]/)
        .map((t) => t.trim())
        .filter(Boolean);
      return values.some((v) =>
        tokens.some((tok) => {
          if (eq(v, tok)) return true;
          // "Ethernet (15)" vs value 15
          const m = tok.match(/\((\d+)\)\s*$/);
          if (m && eq(v, m[1])) return true;
          if (m && eq(v, tok.replace(/\s*\(\d+\)\s*$/, ""))) return true;
          // value side "15" vs token "Ethernet (15)"
          const m2 = String(v).match(/\((\d+)\)\s*$/);
          if (m2 && (eq(m2[1], tok) || tok.includes(m2[1]))) return true;
          return contains(tok, v) || contains(v, tok);
        })
      );
    }
    if (op === "BELONGS_TO_GROUP") {
      // e.g. Connection:NAD-IP-Address BELONGS_TO_GROUP CX_Switches
      const groupName = expected;
      const group = (nadGroups || []).find(
        (g) => g.name && eq(g.name, groupName)
      );
      if (!group) return false;
      const ips = bag["Connection:NAD-IP-Address"] || bag[key] || values;
      return ips.some((ip) => ipInGroupMembers(ip, group.members));
    }
    if (op === "MATCHES" || op === "REGEX") {
      try {
        const re = new RegExp(expected, "i");
        return values.some((v) => re.test(v));
      } catch (_) {
        return false;
      }
    }
    // Unknown operator — soft-match equals
    return values.some((v) => eq(v, expected));
  }

  /**
   * @param {string} combine
   * @param {{ type: string, name: string, operator: string, value: string, displayValue: string }[]} conditions
   * @param {Record<string, string[]>} bag
   * @param {{ name: string, members: string }[]} nadGroups
   * @returns {{ matched: boolean, hits: { cond: typeof conditions[0], ok: boolean }[] }}
   */
  function evalRuleConditions(combine, conditions, bag, nadGroups) {
    const hits = conditions.map((cond) => ({
      cond,
      ok: evalCondition(cond, bag, nadGroups),
    }));
    if (!hits.length) return { matched: false, hits };
    // MATCHES_ANY / or → any condition; MATCHES_ALL / and → all
    const c = combine || "AND";
    const isOr =
      /MATCHES_ANY/i.test(c) ||
      /^\s*or\s*$/i.test(c) ||
      /\bOR\b/.test(c);
    const matched = isOr ? hits.some((h) => h.ok) : hits.every((h) => h.ok);
    return { matched, hits };
  }

  /**
   * Resolve a condition's display value (group names, templates).
   * @param {{ type: string, name: string, operator: string, value: string, displayValue: string }} cond
   */
  function conditionRightHand(cond) {
    let right = cond.displayValue || cond.value || "—";
    if (/^NadGroup:\d+$/i.test(right) && cond.displayValue) {
      right = cond.displayValue;
    }
    if (/^NadGroup:\d+$/i.test(cond.value || "") && cond.displayValue) {
      right = cond.displayValue;
    }
    if (/%\{/.test(right) || /%\{/.test(cond.value || "")) {
      const ref = (cond.value || "").match(/%\{([^}]+)\}/);
      right = ref
        ? `same as ${ref[1]} (typical MAC-auth)`
        : "a dynamic session value";
    }
    return right;
  }

  /**
   * Human phrase for a condition (plain text).
   * @param {{ type: string, name: string, operator: string, value: string, displayValue: string }} cond
   * @param {boolean} [ok]
   */
  function formatCondition(cond, ok) {
    const left = `${cond.type}:${cond.name}`;
    const op = (cond.operator || "EQUALS").toUpperCase();
    const right = conditionRightHand(cond);
    const base = `${left} ${op} ${right}`;
    if (ok === true) return base;
    if (ok === false) return `${base} (didn’t match)`;
    return base;
  }

  /**
   * ClearPass-style colored condition HTML:
   * (Type:Name OPERATOR value) joined with AND/OR
   * @param {{ type: string, name: string, operator: string, value: string, displayValue: string }[]} conditions
   * @param {string} combine
   * @param {{ cond: object, ok: boolean }[]} [hits]
   */
  function formatConditionsHtml(conditions, combine, hits) {
    if (!conditions || !conditions.length) {
      return `<span class="at-ep-empty">(no conditions — default / catch-all)</span>`;
    }
    const isOr =
      /MATCHES_ANY/i.test(combine || "") ||
      /^\s*or\s*$/i.test(combine || "") ||
      /\bOR\b/.test(combine || "");
    const joinWord = isOr ? "OR" : "AND";
    const parts = conditions.map((cond, i) => {
      const op = (cond.operator || "EQUALS").toUpperCase();
      const right = conditionRightHand(cond);
      const hit = hits && hits[i];
      const missClass = hit && hit.ok === false ? " at-ep-cond--miss" : "";
      return `<span class="at-ep-cond${missClass}">(<span class="at-ep-type">${escapeHtml(
        cond.type
      )}:</span><span class="at-ep-name">${escapeHtml(
        cond.name
      )}</span> <span class="at-ep-op">${escapeHtml(
        op
      )}</span> <span class="at-ep-val">${escapeHtml(right)}</span>)</span>`;
    });
    return parts.join(
      `<span class="at-ep-join"> ${escapeHtml(joinWord)} </span>`
    );
  }

  /**
   * Explain service / role / enforcement matches using Service_Config + session.
   * @param {ReturnType<typeof parseDashboard>} dash
   * @param {{ service: string, primaryRoles: string[], roles: string, enfProfiles: string }} storyBits
   * @param {ReturnType<typeof parseServiceConfig> | null} svc
   */
  function explainWhy(dash, storyBits, svc) {
    /** @type {{ kind: string, title: string, detail: string, matchedConditions: string[] }[]} */
    const items = [];

    if (!svc || svc.error) {
      return {
        items: [
          {
            kind: "missing",
            title: "No service config in this export",
            detail:
              "Without Service_Config.xml we can show what happened, but not which rule condition fired. Re-export with service config if you need the why.",
            matchedConditions: [],
          },
        ],
        bag: {},
      };
    }

    const assignedRoles = (
      storyBits.primaryRoles && storyBits.primaryRoles.length
        ? storyBits.primaryRoles
        : (storyBits.roles || "")
            .split(",")
            .map((r) => r.trim())
            .filter(Boolean)
    ).filter((r) => !/^\[User Authenticated\]$/i.test(r));

    const bag = buildAttrBag(dash, [
      ...assignedRoles,
      ...(storyBits.roles || "")
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean),
    ]);
    const nadGroups = svc.nadGroups || [];

    // 1) Service categorization
    const svcMatch =
      (svc.services || []).find((s) => s.name === storyBits.service) ||
      (svc.services || [])[0];
    if (svcMatch && svcMatch.rules && svcMatch.rules.length) {
      const hits = svcMatch.rules.map((cond) => ({
        cond,
        ok: evalCondition(cond, bag, nadGroups),
      }));
      const isOr = /ANY|\bOR\b/i.test(svcMatch.ruleCombine || "");
      const matched = isOr ? hits.some((h) => h.ok) : hits.every((h) => h.ok);
      const hitText = hits
        .filter((h) => h.ok)
        .map((h) => formatCondition(h.cond));
      items.push({
        kind: "service",
        title: `Service “${svcMatch.name}”`,
        detail: matched
          ? `Matched the service rules (${svcMatch.ruleCombine || "ALL"}).`
          : `Listed as the service, but our offline check didn’t re-validate every rule (some use live lookups).`,
        matchedConditions: hitText.length
          ? hitText
          : svcMatch.rules.map((c) => formatCondition(c)),
      });
    } else if (storyBits.service) {
      items.push({
        kind: "service",
        title: `Service “${storyBits.service}”`,
        detail: "Service name is in the session; no rule list in the export.",
        matchedConditions: [],
      });
    }

    // 2) Role mapping — which rule granted each assigned role
    const roleMapNames = svcMatch && svcMatch.roleMappings ? svcMatch.roleMappings : [];
    const roleMaps = (svc.roleMaps || []).filter(
      (rm) => !roleMapNames.length || roleMapNames.includes(rm.name)
    );
    const mapsToScan = roleMaps.length ? roleMaps : svc.roleMaps || [];

    for (const role of assignedRoles) {
      if (/^\[/.test(role)) continue; // system roles
      let found = false;
      for (const rm of mapsToScan) {
        for (const rule of rm.rules || []) {
          const roleResults = (rule.results || []).filter(
            (r) =>
              /role/i.test(r.name) &&
              (r.displayValue === role ||
                r.value === role ||
                String(r.displayValue).toLowerCase() === role.toLowerCase())
          );
          if (!roleResults.length) continue;
          const { matched, hits } = evalRuleConditions(
            rule.combine,
            rule.conditions,
            bag,
            nadGroups
          );
          if (!matched) continue;
          const okHits = hits.filter((h) => h.ok).map((h) => formatCondition(h.cond));
          items.push({
            kind: "role",
            title: `Role “${role}”`,
            detail: `From role mapping “${rm.name}” (${/ANY|\bOR\b/i.test(rule.combine) ? "any of" : "all of"} these conditions).`,
            matchedConditions: okHits,
          });
          found = true;
          break;
        }
        if (found) break;
      }
      if (!found) {
        // default role?
        const dft = mapsToScan.find(
          (rm) =>
            rm.defaultRole &&
            rm.defaultRole.toLowerCase() === role.toLowerCase()
        );
        items.push({
          kind: "role",
          title: `Role “${role}”`,
          detail: dft
            ? `Looks like the default role on “${dft.name}” (no earlier rule claimed it).`
            : "Assigned in the session, but no matching condition stood out in Service_Config (rule may use data we don’t have offline).",
          matchedConditions: [],
        });
      }
    }

    // 3) Enforcement policy — full ClearPass-style table + winner
    const enfNames =
      svcMatch && svcMatch.enfPolicies ? svcMatch.enfPolicies : [];
    const enfPolicies = (svc.enfPolicies || []).filter(
      (ep) => !enfNames.length || enfNames.includes(ep.name)
    );
    const profilesApplied = (storyBits.enfProfiles || "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);

    const epsToScan = enfPolicies.length ? enfPolicies : svc.enfPolicies || [];

    /** @type {null | {
     *   policyName: string,
     *   defaultProfile: string,
     *   algorithm: string,
     *   winnerIndex: number,
     *   usedDefault: boolean,
     *   profilesApplied: string[],
     *   rows: {
     *     index: number,
     *     combine: string,
     *     conditions: object[],
     *     profiles: string,
     *     matched: boolean,
     *     winner: boolean,
     *     hits: { cond: object, ok: boolean }[]
     *   }[]
     * }} */
    let enforcementView = null;

    for (const ep of epsToScan) {
      if (!ep.rules || !ep.rules.length) continue;
      const algo = ep.algorithm || "first-applicable";
      const firstApplicable = /first/i.test(algo);

      /** @type {{ index: number, combine: string, conditions: object[], profiles: string, matched: boolean, winner: boolean, hits: { cond: object, ok: boolean }[] }[]} */
      const rows = [];

      ep.rules.forEach((rule, idx) => {
        const { matched, hits } = evalRuleConditions(
          rule.combine,
          rule.conditions,
          bag,
          nadGroups
        );
        const resultProfiles = (rule.results || [])
          .filter((r) => /enforcement/i.test(r.name) || /profile/i.test(r.name))
          .map((r) => r.displayValue || r.value)
          .filter(Boolean);
        const profiles = resultProfiles.join(", ");

        rows.push({
          index: idx + 1,
          combine: rule.combine,
          conditions: rule.conditions,
          profiles:
            profiles ||
            (rule.results || []).map((r) => r.displayValue || r.value).join(", ") ||
            "—",
          matched,
          winner: false,
          hits,
        });
      });

      // Assign winner: first-applicable = first matched; evaluate-all = all matched
      let winnerIndex = -1;
      if (firstApplicable) {
        const firstMatch = rows.findIndex((r) => r.matched);
        if (firstMatch >= 0) {
          rows[firstMatch].winner = true;
          winnerIndex = firstMatch;
        }
      } else {
        rows.forEach((r, i) => {
          if (!r.matched) return;
          r.winner = true;
          if (winnerIndex < 0) winnerIndex = i;
        });
      }

      // If nothing matched offline, session may have used default profile
      const usedDefault =
        winnerIndex < 0 &&
        !!(ep.defaultProfile || profilesApplied.length);

      enforcementView = {
        policyName: ep.name,
        defaultProfile: ep.defaultProfile || "",
        algorithm: algo,
        winnerIndex: winnerIndex >= 0 ? winnerIndex + 1 : -1,
        usedDefault,
        profilesApplied,
        rows,
      };

      if (winnerIndex >= 0) {
        const win = rows[winnerIndex];
        const okHits = win.hits
          .filter((h) => h.ok)
          .map((h) => formatCondition(h.cond));
        items.push({
          kind: "enforcement",
          title: `Enforcement rule #${win.index} won`,
          detail: firstApplicable
            ? `First-applicable on “${ep.name}” — rule #${win.index} is the one that fired.`
            : `Evaluate-all on “${ep.name}” — matched rules all apply; #${win.index} shown as primary.`,
          matchedConditions: okHits,
        });
      } else if (usedDefault) {
        items.push({
          kind: "enforcement",
          title: ep.defaultProfile
            ? `Default profile → ${ep.defaultProfile}`
            : `Enforcement → ${profilesApplied.join(", ")}`,
          detail: `No numbered rule matched offline on “${ep.name}” — ClearPass likely used the default profile (or conditions we can’t see).`,
          matchedConditions: [],
        });
      }

      // One policy is enough for the main service
      break;
    }

    if (!enforcementView && profilesApplied.length) {
      items.push({
        kind: "enforcement",
        title: `Enforcement → ${profilesApplied.join(", ")}`,
        detail:
          "Profiles are in the session, but no enforcement policy table was in Service_Config.",
        matchedConditions: [],
      });
    }

    return { items, bag, enforcementView };
  }

  // ─── High-level story ──────────────────────────────────────────────────────

  /**
   * @param {ReturnType<typeof parseDashboard>} dash
   * @param {ReturnType<typeof summarizeLogs> | null} logSum
   * @param {ReturnType<typeof parseServiceConfig> | null} svc
   */
  function buildStory(dash, logSum, svc) {
    const c = dash.computedMap;
    const o = dash.radiusOutMap;
    const p = dash.policies;

    const statusRaw = (dash.loginStatus || "").toUpperCase();
    let result = "UNKNOWN";
    if (/ACCEPT|PASS|SUCCESS|AUTHEN_STATUS_PASS/.test(statusRaw)) result = "ACCEPT";
    else if (/REJECT|FAIL|DENY|AUTHEN_STATUS_FAIL|AUTHOR_STATUS_FAIL/.test(statusRaw))
      result = "REJECT";

    const macColon =
      c["Connection:Client-Mac-Address-Colon"] ||
      formatMacColon(c["Connection:Client-Mac-Address"] || dash.endHost);
    const macVendor = c["Connection:Client-Mac-Vendor"] || "";
    const ssid =
      c["Connection:SSID"] ||
      dash.radiusInMap["Radius:Aruba:Aruba-Essid-Name"] ||
      "";
    const apName =
      c["Connection:AP-Name"] ||
      dash.radiusInMap["Radius:Aruba:Aruba-Location-Id"] ||
      "";
    const apGroup = dash.radiusInMap["Radius:Aruba:Aruba-AP-Group"] || "";
    const nadIp =
      c["Connection:NAD-IP-Address"] ||
      (dash.nadIpPort ? dash.nadIpPort.split(":")[0] : "") ||
      "";
    const authMethod =
      p["Authentication Method"] ||
      c["Authentication:OuterMethod"] ||
      "";
    const innerMethod = c["Authentication:InnerMethod"] || "";
    const authSource =
      p["Authentication Source"] || c["Authentication:Source"] || "";
    const authzSource =
      p["Authorization Source"] || c["Authorization:Sources"] || "";
    const service = p["Service"] || c["Tips:Service"] || logSum?.categorizedService || "";
    const roles = p["Roles"] || "";
    const enfProfiles = p["Enforcement Profiles"] || "";
    const arubaRole =
      o["Radius:Aruba:Aruba-User-Role"] ||
      o["Aruba-User-Role"] ||
      "";
    const enfPayload = extractEnforcementPayload(o, dash.radiusOut);
    const outUsername = o["Radius:IETF:User-Name"] || o["User-Name"] || "";
    const deviceType =
      dash.radiusInMap["Radius:Aruba:Aruba-Device-Type"] ||
      c["Device:Device Type"] ||
      "";
    const deviceVendor = c["Device:Device Vendor"] || "";
    const location = c["Device:Location"] || "";
    const endpointDeviceName = pickAuthz(dash.authz, "Device Name") || "";
    const endpointCategory = pickAuthz(dash.authz, "Category") || "";
    const endpointStatus = pickAuthz(dash.authz, "Status") || "";
    const endpointOsFamily = pickAuthz(dash.authz, "OS Family") || "";
    const endpointIsProfiled = pickAuthz(dash.authz, "IsProfiled") || "";
    const hostname =
      pickAuthz(dash.authz, "Hostname") ||
      c["Endpoint:Hostname"] ||
      "";
    // Prefer human name; for MAB, fall back to profiled device name / hostname
    let displayName =
      pickAuthz(dash.authz, "Name") ||
      c["GuestUser:Visitor Name"] ||
      "";
    if (!displayName && looksLikeMac(dash.username)) {
      displayName =
        [hostname, endpointDeviceName].filter(Boolean).join(" · ") ||
        endpointCategory ||
        "";
    }
    const email = pickAuthz(dash.authz, "Email") || "";
    const memberOf = pickAuthz(dash.authz, "memberOf") || "";

    const nasPortId =
      dash.radiusInMap["Radius:IETF:NAS-Port-Id"] ||
      (dash.nadIpPort && dash.nadIpPort.includes(":")
        ? dash.nadIpPort.split(":").slice(1).join(":")
        : "") ||
      "";
    const nasPortTypeRaw =
      dash.radiusInMap["Radius:IETF:NAS-Port-Type"] || "";
    const nasPortTypeEnum = enumLabelFor(
      nasPortTypeRaw,
      "Radius:IETF:NAS-Port-Type"
    );
    const nasPortType = nasPortTypeEnum
      ? nasPortTypeEnum
      : nasPortTypeRaw
        ? `type ${nasPortTypeRaw}`
        : "";
    const serviceTypeRaw =
      dash.radiusInMap["Radius:IETF:Service-Type"] || "";
    const serviceTypeEnum = enumLabelFor(
      serviceTypeRaw,
      "Radius:IETF:Service-Type"
    );
    const serviceType = serviceTypeEnum
      ? serviceTypeEnum
      : serviceTypeRaw || "";
    const macAuthStatus = c["Authentication:MacAuth"] || "";
    const authStatus = c["Authentication:Status"] || "";

    // Primary Tip roles (drop bracketed system roles for summary)
    // These are ClearPass Tips roles — distinct from Aruba-User-Role / Filter-Id
    const primaryRoles = (roles || "")
      .split(",")
      .map((r) => r.trim())
      .filter((r) => r && !/^\[.*\]$/.test(r));

    // NAD role attribute only (Aruba-User-Role / HPE-User-Role / DUR role name)
    // NEVER Filter-Id or Tunnel-Private-Group-Id
    const returnedRole =
      arubaRole ||
      (enfPayload && enfPayload.switchRole) ||
      "";
    const returnedVlan =
      (enfPayload && enfPayload.vlanAccess) ||
      "";
    const returnedFilterId =
      (enfPayload && enfPayload.filterId) ||
      o["Radius:IETF:Filter-Id"] ||
      o["Filter-Id"] ||
      "";

    /** @type {string[]} */
    const warnings = [];
    if (!macColon && dash.protocol === "RADIUS") {
      warnings.push("No client MAC address in this session.");
    }
    if (!service || /^\[?Unknown/i.test(service)) {
      warnings.push("No ClearPass service matched (or service field is empty).");
    }
    if (/\[Deny Access Profile\]/i.test(enfProfiles)) {
      warnings.push("Enforcement profile is Deny Access.");
    }
    /** Technical notes (collapsed UI) — not shown as scary warnings */
    const techNotes = [];
    if (
      /^none$/i.test((authSource || "").trim()) &&
      /MAC-AUTH/i.test(authMethod || "")
    ) {
      techNotes.push(
        "Authentication Source is None (common for Allow-All MAC-AUTH). Roles usually come from profiling / authorization, not a user password store."
      );
    }
    if (/UnknownClient/i.test(macAuthStatus) && result === "REJECT") {
      warnings.push("MAC-AUTH treated this client as UnknownClient.");
    }
    if (logSum) {
      for (const w of logSum.warnings) {
        if (!warnings.includes(w) && !isNoisyLogLine(w)) warnings.push(w);
      }
    }
    if (svc && svc.error) warnings.push(svc.error);

    // Plain-English reject reason
    let failPlain = "";
    if (result === "REJECT") {
      const code = dash.alerts.errorCode;
      const cat = dash.alerts.errorCategory;
      const msg = dash.alerts.errorMessage;
      const known = code ? ERROR_PLAIN[code] : "";
      const parts = [];
      if (msg) parts.push(msg);
      if (cat) parts.push(`(${cat})`);
      if (code) parts.push(`— error ${code}`);
      failPlain = parts.join(" ");
      if (known) failPlain = (failPlain ? failPlain + ". " : "") + known;
      if (!failPlain && logSum?.enfOutcome === "Deny") {
        failPlain =
          "Policy evaluation returned a Deny enforcement profile (auth may still have succeeded).";
      }
      if (!failPlain) {
        failPlain =
          "Rejected, but no Alerts section was present in Dashboard_Details.txt. Check Request Logs.";
      }
    }

    const oneLiner = buildOneLiner({
      result,
      username: dash.username,
      displayName,
      macColon,
      macVendor,
      ssid,
      apName,
      nadName: dash.nadName,
      nadIp,
      nasPortId,
      service,
      // Actual Aruba-User-Role RADIUS AVP only (not Tips, not Filter-Id)
      arubaRole: arubaRole,
      // DUR-embedded role name or other NAD role AVP (not Tips)
      nadRole: returnedRole && returnedRole !== arubaRole ? returnedRole : "",
      // ClearPass Tips roles — internal only (for fallback wording)
      tipRoles: primaryRoles.join(", "),
      roles: primaryRoles.join(", ") || roles,
      vlan: returnedVlan,
      filterId: returnedFilterId,
      authMethod,
      failPlain,
      protocol: dash.protocol,
      deviceType: endpointDeviceName || deviceType,
      endpointCategory,
    });

    // Service match explanation (legacy block + full WHY)
    let serviceWhy = null;
    if (svc && svc.services && svc.services.length) {
      const match =
        svc.services.find((s) => s.name === service) || svc.services[0];
      serviceWhy = match;
    }

    const why = explainWhy(
      dash,
      {
        service,
        primaryRoles,
        roles,
        enfProfiles,
      },
      svc
    );

    return {
      result,
      oneLiner,
      failPlain,
      sessionId: dash.sessionId,
      when: dash.when,
      username: dash.username,
      displayName,
      email,
      memberOf,
      hostname,
      endpointDeviceName,
      endpointCategory,
      endpointStatus,
      endpointOsFamily,
      endpointIsProfiled,
      macColon,
      macVendor,
      ssid,
      apName,
      apGroup,
      nadIp,
      nadName: dash.nadName,
      nadIpPort: dash.nadIpPort,
      nasPortId,
      nasPortType,
      nasPortTypeRaw,
      serviceType,
      serviceTypeRaw,
      protocol: dash.protocol,
      requestType: dash.requestType,
      authMethod,
      innerMethod,
      authSource,
      authzSource,
      macAuthStatus,
      authStatus,
      service,
      roles,
      primaryRoles,
      enfProfiles,
      arubaRole,
      returnedRole,
      returnedVlan,
      returnedFilterId,
      enfPayload,
      outUsername,
      deviceType,
      deviceVendor,
      location,
      alerts: dash.alerts,
      warnings,
      timing: {
        serviceCatMs: logSum?.serviceCatMs || "",
        policyEvalMs: logSum?.policyEvalMs || "",
      },
      logHighlights: logSum?.highlights || [],
      techNotes,
      serviceWhy,
      why,
      outputAttrs: dash.radiusOut,
      radiusIn: dash.radiusIn,
      computed: dash.computed,
      authz: dash.authz,
    };
  }

  /**
   * @param {{ key: string, value: string }[]} authz
   * @param {string} leafName last segment after ':'
   */
  function pickAuthz(authz, leafName) {
    for (const { key, value } of authz) {
      if (key === leafName || key.endsWith(":" + leafName)) return value;
    }
    return "";
  }

  /** @param {string} raw */
  function formatMacColon(raw) {
    if (!raw) return "";
    const hex = raw.replace(/[^0-9a-fA-F]/g, "");
    if (hex.length !== 12) return raw;
    return hex
      .toLowerCase()
      .match(/.{2}/g)
      .join(":");
  }

  /**
   * Short plain-English headline (not a dump of every field).
   * Role = Aruba-User-Role / DUR role only. Filter-Id and VLAN are separate.
   * @param {Record<string, string>} s
   */
  function buildOneLiner(s) {
    let who;
    if (s.displayName && looksLikeMac(s.username)) who = s.displayName;
    else if (s.displayName) who = `${s.username} (${s.displayName})`;
    else who = s.username || "this client";

    if (s.result === "ACCEPT") {
      /** @type {string[]} */
      const got = [];
      // On-the-wire only — never Tips roles
      if (s.arubaRole) got.push(`Aruba-User-Role ${s.arubaRole}`);
      else if (s.nadRole) got.push(`DUR role ${s.nadRole}`);
      if (s.vlan) got.push(`VLAN ${s.vlan}`);
      if (s.filterId) got.push(`Filter-Id ${s.filterId}`);

      if (got.length) return `${who} got on — ${got.join(", ")}.`;
      // Accepted with no enforcement AVPs (bare allow / TACACS / etc.)
      return `${who} got on.`;
    }

    if (s.result === "REJECT") {
      const reason = s.failPlain
        ? s.failPlain.replace(/\s+/g, " ").slice(0, 120)
        : "details below if we have any";
      return `${who} got the cold shoulder. ${reason}`;
    }

    return `${who} — result ${s.result || "¯\\_(ツ)_/¯"}.`;
  }

  // ─── File intake ───────────────────────────────────────────────────────────

  const FILE_NAMES = {
    dashboard: /^dashboard_details\.txt$/i,
    logs: /^request_logs\.html?$/i,
    service: /^service_config\.xml$/i,
  };

  /**
   * @param {FileList | File[]} fileList
   * @returns {Promise<{ dashboard: string|null, logs: string|null, service: string|null, names: Record<string,string>, folderHint: string }>}
   */
  async function readExportFiles(fileList) {
    const files = Array.from(fileList);
    /** @type {Record<string, string>} */
    const names = {};
    let dashboard = null;
    let logs = null;
    let service = null;
    let folderHint = "";

    for (const f of files) {
      const base = f.name.split(/[/\\]/).pop() || f.name;
      const rel = /** @type {string} */ (f.webkitRelativePath || f.name);
      if (rel.includes("/")) {
        const parts = rel.split("/");
        // prefer session-looking folder
        const sess = parts.find((p) => /^[RT][0-9a-f]{6,}/i.test(p));
        if (sess) folderHint = sess;
        else if (!folderHint && parts.length > 1) folderHint = parts[parts.length - 2];
      }

      if (FILE_NAMES.dashboard.test(base)) {
        dashboard = await f.text();
        names.dashboard = rel;
      } else if (FILE_NAMES.logs.test(base)) {
        logs = await f.text();
        names.logs = rel;
      } else if (FILE_NAMES.service.test(base)) {
        service = await f.text();
        names.service = rel;
      }
    }

    return { dashboard, logs, service, names, folderHint };
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  /**
   * @param {ReturnType<typeof buildStory>} story
   * @param {{ dashboard: boolean, logs: boolean, service: boolean, names: Record<string,string>, folderHint: string, logRows: ReturnType<typeof parseRequestLogs>, svcParsed: ReturnType<typeof parseServiceConfig>|null }} meta
   */
  function renderStory(story, meta) {
    const root = $("results");
    const summaryHost = $("summary-host");
    const detailsHost = $("details-host");
    if (!root || !summaryHost || !detailsHost) return;

    root.classList.remove("hidden");
    summaryHost.replaceChildren();
    detailsHost.replaceChildren();

    const tone =
      story.result === "ACCEPT"
        ? "accept"
        : story.result === "REJECT"
          ? "reject"
          : "unknown";

    const resultLabel =
      story.result === "ACCEPT"
        ? "Accept"
        : story.result === "REJECT"
          ? "Reject"
          : story.result || "Unknown";

    // ── 1. End result ──────────────────────────────────────────────────────
    const banner = el("div", { className: `at-banner at-banner--${tone}` });
    banner.innerHTML = `
      <p class="at-banner__end">End result</p>
      <div class="at-banner__status">${escapeHtml(resultLabel)}</div>
      <p class="at-banner__line">${escapeHtml(story.oneLiner)}</p>
      <p class="at-banner__meta">
        ${story.when ? escapeHtml(story.when) : ""}
        ${story.protocol ? ` · ${escapeHtml(story.protocol)}` : ""}
        ${story.sessionId ? ` · <span class="inline-code">${escapeHtml(story.sessionId)}</span>` : ""}
      </p>
    `;
    summaryHost.appendChild(banner);

    // ── 2. The essentials (quiet list, not a chip wall) ─────────────────────
    const essentials = el("div", { className: "at-essentials" });
    essentials.appendChild(
      el("h3", { className: "at-block-title", text: "The quick facts" })
    );
    const rows = [
      ["Who", formatWhoSimple(story)],
      ["Client MAC", formatMacSimple(story)],
      ["Connected from", formatConnectedFrom(story)],
      ["Authentication", formatAuthSimple(story)],
      ["ClearPass service", story.service || "—"],
      ["Tips roles (internal)", formatRolesSimple(story)],
    ];
    const list = el("dl", { className: "at-kv" });
    for (const [label, value] of rows) {
      if (!value || value === "—") continue;
      list.appendChild(el("dt", { text: label }));
      list.appendChild(el("dd", { text: value }));
    }
    essentials.appendChild(list);
    summaryHost.appendChild(essentials);

    // ── 2b. WHY — which policy conditions fired ─────────────────────────────
    if (story.why && story.why.items && story.why.items.length) {
      summaryHost.appendChild(renderWhySection(story.why));
    }

    // ── 3. What ClearPass handed back (full Output RADIUS Attributes + extras)
    const handed = collectHandedBack(story);
    const assignBox = el("div", {
      className:
        story.result === "REJECT"
          ? "at-assigned at-assigned--none"
          : "at-assigned",
    });
    assignBox.appendChild(
      el("h3", {
        className: "at-block-title",
        text:
          story.result === "REJECT"
            ? "What they were supposed to get"
            : "What ClearPass handed back",
      })
    );
    assignBox.appendChild(
      el("p", {
        className: "at-block-intro",
        text:
          story.result === "REJECT"
            ? "Deny path — little or nothing useful was returned for network access."
            : "Everything from the export’s Output section: RADIUS attributes for the access device, plus any other actions ClearPass recorded (session notify, firewall updates, etc.).",
      })
    );

    if (handed.radius.length) {
      assignBox.appendChild(
        el("p", { className: "at-subhead", text: "RADIUS attributes" })
      );
      const ul = el("ul", { className: "at-assigned-list" });
      for (const item of handed.radius) {
        const li = el("li");
        const note = item.note
          ? `<span class="at-assigned-note">${escapeHtml(item.note)}</span>`
          : "";
        const multi = item.value && item.value.includes("\n");
        const valHtml = multi
          ? `<pre class="at-pre at-pre--inline">${escapeHtml(item.value)}</pre>`
          : `<strong>${escapeHtml(item.value)}</strong>`;
        li.innerHTML = `<span class="at-assigned-label">${escapeHtml(item.label)}</span>
          <span class="at-assigned-val">${valHtml}${note}</span>`;
        ul.appendChild(li);
      }
      assignBox.appendChild(ul);
    }

    if (handed.other.length) {
      const details = el("details", { className: "at-handed-other" });
      details.setAttribute("open", "");
      details.appendChild(
        el("summary", {
          text: `Other ClearPass output (${handed.other.length})`,
        })
      );
      const ul = el("ul", { className: "at-assigned-list" });
      for (const item of handed.other) {
        const li = el("li");
        li.innerHTML = `<span class="at-assigned-label">${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value)}</strong>`;
        ul.appendChild(li);
      }
      details.appendChild(ul);
      assignBox.appendChild(details);
    }

    if (!handed.radius.length && !handed.other.length) {
      assignBox.appendChild(
        el("p", {
          className: "hint",
          text:
            story.result === "ACCEPT"
              ? "No Output RADIUS Attributes in this export."
              : "Nothing listed in Output RADIUS Attributes.",
        })
      );
    }
    summaryHost.appendChild(assignBox);

    // ── 4. Failure reason only ─────────────────────────────────────────────
    if (story.result === "REJECT") {
      const fail = el("div", { className: "callout callout--danger at-fail" });
      fail.innerHTML = `
        <strong>Why the door stayed shut</strong>
        <p>${escapeHtml(story.failPlain || "Export didn’t spell it out — check the technical drawers below.")}</p>
        ${
          story.alerts.errorCode
            ? `<p class="at-fail__codes">Error code <span class="inline-code">${escapeHtml(story.alerts.errorCode)}</span>${
                story.alerts.errorMessage
                  ? ` — ${escapeHtml(story.alerts.errorMessage)}`
                  : ""
              }</p>`
            : ""
        }
      `;
      summaryHost.appendChild(fail);
    }

    // Real warnings only (already filtered); keep short + friendly
    if (story.warnings.length) {
      const warn = el("div", { className: "callout callout--warn at-heads-up" });
      warn.innerHTML = `
        <div class="at-heads-up__row">
          <span class="at-heads-up__icon" aria-hidden="true">⚠</span>
          <div>
            <strong>Heads-up — not a full panic</strong>
            <ul class="at-warn-list">${story.warnings
              .slice(0, 6)
              .map((w) => `<li>${escapeHtml(w)}</li>`)
              .join("")}</ul>
          </div>
        </div>
      `;
      summaryHost.appendChild(warn);
    }

    // ── Collapsed: technical / engineer detail ─────────────────────────────
    detailsHost.appendChild(
      detailsBlock(
        "Nerd drawer — more technical detail",
        renderTechSummary(story, meta),
        false
      )
    );
    detailsHost.appendChild(
      detailsBlock(
        "Service config — why this service matched",
        renderServiceWhy(story, meta.svcParsed),
        false
      )
    );
    detailsHost.appendChild(
      detailsBlock(
        "Output attributes (raw)",
        attrTable(story.outputAttrs),
        false
      )
    );
    detailsHost.appendChild(
      detailsBlock(
        "Input RADIUS attributes",
        attrTable(story.radiusIn),
        false
      )
    );
    detailsHost.appendChild(
      detailsBlock(
        "Computed attributes",
        attrTable(story.computed),
        false
      )
    );
    detailsHost.appendChild(
      detailsBlock(
        "Authorization attributes",
        attrTable(story.authz),
        false
      )
    );
    detailsHost.appendChild(
      detailsBlock(
        "Request log timeline (director’s cut)",
        renderLogTimeline(meta.logRows),
        false
      )
    );

    root.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /**
   * Who, in plain language — not a laundry list.
   * @param {ReturnType<typeof buildStory>} story
   */
  function formatWhoSimple(story) {
    const nameBits = [];
    if (story.hostname) nameBits.push(story.hostname);
    if (story.endpointDeviceName) nameBits.push(story.endpointDeviceName);
    else if (story.displayName && !looksLikeMac(story.username)) {
      nameBits.push(story.displayName);
    } else if (story.displayName && looksLikeMac(story.username)) {
      if (!nameBits.length) nameBits.push(story.displayName);
    }
    if (!nameBits.length && story.username && !looksLikeMac(story.username)) {
      nameBits.push(story.username);
    }
    let line = nameBits.join(" · ") || story.username || "—";
    if (story.endpointCategory) line += ` (${story.endpointCategory})`;
    else if (story.email && !line.includes(story.email)) line += ` · ${story.email}`;
    return line;
  }

  /** @param {ReturnType<typeof buildStory>} story */
  function formatMacSimple(story) {
    if (!story.macColon) return "";
    return story.macVendor
      ? `${story.macColon} (${story.macVendor})`
      : story.macColon;
  }

  /**
   * Where the request came from — wireless / wired / TACACS-aware, not "switch".
   * @param {ReturnType<typeof buildStory>} story
   */
  function formatConnectedFrom(story) {
    const bits = [];
    const isWireless =
      /wireless/i.test(story.nasPortType || "") ||
      !!story.ssid ||
      /802\.11/i.test(story.nasPortType || "");
    const isTacacs = /TACACS/i.test(story.protocol || "") ||
      /TACACS/i.test(story.requestType || "");

    if (story.ssid) bits.push(`SSID ${story.ssid}`);
    if (story.apName) bits.push(`AP ${story.apName}`);
    if (story.apGroup && isWireless) bits.push(`AP group ${story.apGroup}`);

    // Access device (controller, switch, firewall, …)
    if (story.nadName && story.nadIp && story.nadName !== story.nadIp) {
      bits.push(`${story.nadName} (${story.nadIp})`);
    } else if (story.nadName) {
      bits.push(story.nadName);
    } else if (story.nadIp) {
      bits.push(story.nadIp);
    }

    if (story.nasPortId && !isTacacs) {
      bits.push(
        isWireless ? `radio/port ${story.nasPortId}` : `port ${story.nasPortId}`
      );
    }
    if (story.nasPortType) bits.push(story.nasPortType);
    if (story.location) bits.push(story.location);

    if (isTacacs && story.deviceType) bits.push(story.deviceType);
    if (isTacacs && story.deviceVendor) bits.push(story.deviceVendor);

    return bits.join(" · ") || "—";
  }

  /** @param {ReturnType<typeof buildStory>} story */
  function formatAuthSimple(story) {
    const bits = [];
    if (story.authMethod) bits.push(story.authMethod);
    if (
      story.innerMethod &&
      story.authMethod &&
      !String(story.authMethod).includes(story.innerMethod)
    ) {
      bits.push(story.innerMethod);
    }
    // User-facing auth source only when it's meaningful
    if (story.authSource && !/^none$/i.test(story.authSource.trim())) {
      bits.push(`via ${story.authSource}`);
    }
    return bits.join(" · ") || "—";
  }

  /** @param {ReturnType<typeof buildStory>} story */
  function formatRolesSimple(story) {
    if (story.primaryRoles && story.primaryRoles.length) {
      return story.primaryRoles.join(", ");
    }
    // Strip system roles if that's all we have
    const cleaned = (story.roles || "")
      .split(",")
      .map((r) => r.trim())
      .filter((r) => r && !/^\[User Authenticated\]$/i.test(r));
    return cleaned.join(", ") || story.roles || "—";
  }

  /**
   * WHY panel — service / roles + ClearPass-style enforcement table.
   * @param {{
   *   items: { kind: string, title: string, detail: string, matchedConditions: string[] }[],
   *   enforcementView?: null | {
   *     policyName: string,
   *     defaultProfile: string,
   *     algorithm: string,
   *     winnerIndex: number,
   *     usedDefault: boolean,
   *     profilesApplied: string[],
   *     rows: { index: number, combine: string, conditions: object[], profiles: string, matched: boolean, winner: boolean, hits: { cond: object, ok: boolean }[] }[]
   *   }
   * }} why
   */
  function renderWhySection(why) {
    const box = el("div", { className: "at-why" });
    box.appendChild(el("h3", { className: "at-block-title", text: "Why" }));
    box.appendChild(
      el("p", {
        className: "at-block-intro",
        text: "Service + roles first, then the enforcement policy the way ClearPass draws it — conditions on the left, profiles on the right. Highlighted row is the one that won for this session.",
      })
    );

    // Service + role cards (skip bare enforcement cards — table replaces them)
    const list = el("ul", { className: "at-why-list" });
    let hasCards = false;
    for (const item of why.items) {
      if (item.kind === "enforcement" && why.enforcementView) continue;
      hasCards = true;
      if (item.kind === "missing") {
        const li = el("li", { className: "at-why-item at-why-item--muted" });
        li.innerHTML = `<strong>${escapeHtml(item.title)}</strong>
          <p>${escapeHtml(item.detail)}</p>`;
        list.appendChild(li);
        continue;
      }
      const li = el("li", {
        className: `at-why-item at-why-item--${escapeHtml(item.kind)}`,
      });
      const condHtml = item.matchedConditions.length
        ? `<ul class="at-why-conds">${item.matchedConditions
            .map((c) => `<li><code>${escapeHtml(c)}</code></li>`)
            .join("")}</ul>`
        : "";
      li.innerHTML = `
        <strong>${escapeHtml(item.title)}</strong>
        <p>${escapeHtml(item.detail)}</p>
        ${condHtml}
      `;
      list.appendChild(li);
    }
    if (hasCards) box.appendChild(list);

    if (why.enforcementView) {
      box.appendChild(renderEnforcementPolicyTable(why.enforcementView));
    }

    return box;
  }

  /**
   * ClearPass-like Enforcement Policy Details table.
   * @param {NonNullable<Parameters<typeof renderWhySection>[0]['enforcementView']>} view
   */
  function renderEnforcementPolicyTable(view) {
    const wrap = el("div", { className: "at-ep" });

    wrap.innerHTML = `
      <div class="at-ep__head">
        <h4 class="at-ep__title">Enforcement Policy Details</h4>
        <dl class="at-ep__meta">
          <div><dt>Enforcement Policy</dt><dd>${escapeHtml(view.policyName)}</dd></div>
          ${
            view.defaultProfile
              ? `<div><dt>Default Profile</dt><dd>${escapeHtml(view.defaultProfile)}</dd></div>`
              : ""
          }
          <div><dt>Rules Evaluation Algorithm</dt><dd><span class="inline-code">${escapeHtml(
            view.algorithm || "first-applicable"
          )}</span></dd></div>
        </dl>
        ${
          view.winnerIndex > 0
            ? `<p class="at-ep__banner at-ep__banner--win">This session hit <strong>rule #${view.winnerIndex}</strong>${
                /first/i.test(view.algorithm)
                  ? " (first-applicable — later rules were not tried)."
                  : "."
              }</p>`
            : view.usedDefault
              ? `<p class="at-ep__banner at-ep__banner--default">No numbered rule matched offline — default profile likely applied${
                  view.defaultProfile
                    ? `: <strong>${escapeHtml(view.defaultProfile)}</strong>`
                    : ""
                }.</p>`
              : ""
        }
      </div>
    `;

    const scroll = el("div", { className: "at-ep__scroll" });
    const table = el("table", { className: "at-ep-table" });
    table.innerHTML = `
      <thead>
        <tr>
          <th class="at-ep-table__num">#</th>
          <th>Conditions</th>
          <th>Enforcement Profiles</th>
        </tr>
      </thead>
    `;
    const tbody = el("tbody");

    for (const row of view.rows) {
      const tr = el("tr", {
        className: [
          row.winner ? "at-ep-row--winner" : "",
          row.matched && !row.winner ? "at-ep-row--matched" : "",
          !row.matched ? "at-ep-row--miss" : "",
        ]
          .filter(Boolean)
          .join(" "),
      });

      const tdNum = el("td", { className: "at-ep-table__num" });
      tdNum.innerHTML = `<span class="at-ep-num">${row.index}</span>${
        row.winner
          ? `<span class="at-ep-badge at-ep-badge--win">hit</span>`
          : row.matched
            ? `<span class="at-ep-badge at-ep-badge--also">match</span>`
            : ""
      }`;

      const tdCond = el("td", { className: "at-ep-table__cond" });
      tdCond.innerHTML = formatConditionsHtml(
        row.conditions,
        row.combine,
        row.hits
      );

      const tdProf = el("td", { className: "at-ep-table__prof" });
      // Split profile list on commas for readability
      const profiles = String(row.profiles || "—")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      tdProf.innerHTML = profiles
        .map((p) => `<span class="at-ep-prof">${escapeHtml(p)}</span>`)
        .join("");

      tr.appendChild(tdNum);
      tr.appendChild(tdCond);
      tr.appendChild(tdProf);
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    scroll.appendChild(table);
    wrap.appendChild(scroll);

    const foot = el("p", { className: "at-ep__legend" });
    foot.innerHTML = `
      <span class="at-ep-badge at-ep-badge--win">hit</span> rule that applied ·
      <span class="at-ep-badge at-ep-badge--also">match</span> also true but not chosen (first-applicable) ·
      gray rows did not match this session
    `;
    wrap.appendChild(foot);

    return wrap;
  }

  /**
   * Everything from Dashboard “Output RADIUS Attributes” (and related output lines).
   * - radius: Radius:* AVPs (all of them)
   * - other: Session-Notify, Session-Check, Status-Update, etc.
   *
   * Tips roles are NOT included — those live under quick facts only.
   *
   * @param {ReturnType<typeof buildStory>} story
   * @returns {{ radius: { label: string, value: string, note?: string }[], other: { label: string, value: string }[] }}
   */
  function collectHandedBack(story) {
    /** @type {{ label: string, value: string, note?: string }[]} */
    const radius = [];
    /** @type {{ label: string, value: string }[]} */
    const other = [];

    const attrs = story.outputAttrs || [];
    if (!attrs.length) {
      return { radius, other };
    }

    // Group multi-value keys (e.g. Session-Notify:Login Action appears many times)
    /** @type {Map<string, string[]>} */
    const grouped = new Map();
    for (const { key, value } of attrs) {
      if (!grouped.has(key)) grouped.set(key, []);
      const list = grouped.get(key);
      // expandAttrValue for multi-line DUR; keep secrets redacted
      let v = expandAttrValue(value);
      if (/password|passphrase|secret|credential/i.test(key) && v && v !== "**********") {
        v = "**********";
      }
      if (v !== "" && v != null) list.push(v);
    }

    for (const [key, values] of grouped) {
      const isRadius = /^Radius:/i.test(key) || /^Aruba-|^HPE-|^Filter-Id|^Tunnel-/i.test(key);
      const leaf = key.includes(":")
        ? key.replace(/^Radius:[^:]+:/, "").replace(/^Radius:/, "")
        : key;
      // Prefer dictionary-friendly display for enums; keep multi-values joined
      const displayParts = values.map((v) => {
        if (v.includes("\n")) {
          // DUR / multi-line: show first line + note
          return v.split("\n")[0] + "…";
        }
        return enrichRadiusValue(key, v).display;
      });
      // Unique while preserving order
      const unique = [];
      for (const p of displayParts) {
        if (!unique.includes(p)) unique.push(p);
      }
      const value = unique.join(", ");

      /** @type {string | undefined} */
      let note;
      // Helpful annotations — not replacements
      if (/Tunnel-Private-Group-Id/i.test(key)) {
        note = " (VLAN id when Tunnel-Type is VLAN)";
      } else if (/Aruba-User-Role/i.test(key)) {
        note = " (Aruba role for the NAD)";
      } else if (/Filter-Id/i.test(key)) {
        note = " (filter / ACL id — not a role)";
      } else if (/CPPM-Role/i.test(key) && values.some((v) => v.includes("\n"))) {
        note = " (downloadable role blob)";
      }

      const item = {
        label: leaf,
        value,
        fullKey: key,
      };
      if (note) item.note = note;

      // Full multi-line DUR body: prefer full value in a dedicated way
      if (/CPPM-Role/i.test(key) && values[0] && values[0].includes("\n")) {
        item.value = values[0];
        item.note = item.note || " (downloadable role)";
      }

      if (isRadius || /^Radius:/i.test(key)) {
        radius.push(item);
      } else {
        other.push({ label: leaf, value });
      }
    }

    // If DUR was parsed with vlan/role extras not as separate AVPs, still show full list above.
    // Ensure we didn't drop any Radius: line: count should match input radius keys
    return { radius, other };
  }

  /** @deprecated use collectHandedBack */
  function collectAssignedAttributes(story) {
    const h = collectHandedBack(story);
    return h.radius.concat(h.other);
  }

  /**
   * Collapsed engineer-oriented summary.
   * @param {ReturnType<typeof buildStory>} story
   * @param {{ dashboard: boolean, logs: boolean, service: boolean, names: Record<string,string>, folderHint: string, logRows: unknown, svcParsed: unknown }} meta
   */
  function renderTechSummary(story, meta) {
    const wrap = el("div", { className: "at-tech" });
    const kv = el("dl", { className: "at-kv at-kv--compact" });
    const rows = [
      ["Auth method (full)", formatAuthFull(story)],
      ["Auth source", story.authSource || "—"],
      ["Authorization sources", story.authzSource || "—"],
      ["MacAuth status", story.macAuthStatus || "—"],
      ["Service-Type", story.serviceType || story.serviceTypeRaw || "—"],
      ["Enforcement profiles", story.enfProfiles || "—"],
      ["All Tip roles", story.roles || "—"],
      ["Access device", formatAccessDevice(story)],
      ["Connection type", story.nasPortType || "—"],
      ["Protocol", story.protocol || "—"],
    ];
    for (const [label, value] of rows) {
      if (!value || value === "—") continue;
      kv.appendChild(el("dt", { text: label }));
      kv.appendChild(el("dd", { text: value }));
    }
    wrap.appendChild(kv);

    if (story.enfPayload && story.enfPayload.kind === "downloadable-role") {
      const ep = story.enfPayload;
      wrap.appendChild(
        el("p", {
          className: "at-subhead",
          text: "Downloadable role config (full text)",
        })
      );
      const pre = el("pre", { className: "at-pre" });
      pre.textContent = ep.body;
      wrap.appendChild(pre);
    }

    if (story.techNotes && story.techNotes.length) {
      wrap.appendChild(el("p", { className: "at-subhead", text: "Notes" }));
      const ul = el("ul", { className: "at-warn-list" });
      for (const n of story.techNotes) ul.appendChild(el("li", { text: n }));
      wrap.appendChild(ul);
    }

    if (story.logHighlights.length || story.timing.serviceCatMs || story.timing.policyEvalMs) {
      const bits = [];
      if (story.timing.serviceCatMs)
        bits.push(`Service categorization ${story.timing.serviceCatMs}`);
      if (story.timing.policyEvalMs)
        bits.push(`Policy evaluation ${story.timing.policyEvalMs}`);
      wrap.appendChild(
        el("p", {
          className: "at-subhead",
          text: "From request logs",
        })
      );
      if (bits.length) {
        wrap.appendChild(el("p", { className: "hint", text: bits.join(" · ") }));
      }
      if (story.logHighlights.length) {
        const ul = el("ul", { className: "at-warn-list" });
        for (const h of story.logHighlights) ul.appendChild(el("li", { text: h }));
        wrap.appendChild(ul);
      }
    }

    const present = [];
    if (meta.dashboard) present.push("Dashboard_Details.txt");
    if (meta.logs) present.push("Request_Logs.html");
    if (meta.service) present.push("Service_Config.xml");
    const dictNote = radiusDict
      ? `RADIUS dictionary: ${radiusDict.meta.attributeCount} attributes (${(radiusDict.meta.vendors || []).join(", ")}).`
      : "RADIUS dictionary not loaded.";
    wrap.appendChild(
      el("p", {
        className: "at-files-note",
        text: `Files used: ${present.join(", ") || "—"}.${
          meta.folderHint ? ` Session: ${meta.folderHint}.` : ""
        } ${dictNote} Nothing left this browser.`,
      })
    );

    return wrap;
  }

  /** @param {ReturnType<typeof buildStory>} story */
  function formatAuthFull(story) {
    const bits = [];
    if (story.authMethod) bits.push(story.authMethod);
    if (story.innerMethod) bits.push(`inner ${story.innerMethod}`);
    if (story.authStatus) bits.push(story.authStatus);
    if (story.macAuthStatus && story.macAuthStatus !== "NotApplicable") {
      bits.push(`MacAuth ${story.macAuthStatus}`);
    }
    return bits.join(" · ") || "—";
  }

  /** @param {ReturnType<typeof buildStory>} story */
  function formatAccessDevice(story) {
    if (story.nadName && story.nadIp && story.nadName !== story.nadIp) {
      return `${story.nadName} (${story.nadIp})`;
    }
    return story.nadName || story.nadIp || story.nadIpPort || "—";
  }

  /**
   * @param {string} title
   * @param {Node} body
   * @param {boolean} open
   */
  function detailsBlock(title, body, open) {
    const d = el("details", { className: "at-details" });
    if (open) d.setAttribute("open", "");
    d.appendChild(el("summary", { text: title }));
    const wrap = el("div", { className: "at-details__body" });
    wrap.appendChild(body);
    d.appendChild(wrap);
    return d;
  }

  /**
   * @param {{ key: string, value: string }[]} attrs
   */
  function attrTable(attrs) {
    if (!attrs || !attrs.length) {
      return el("p", { className: "hint", text: "None in this export." });
    }
    const table = el("table", { className: "at-table" });
    const tb = el("tbody");
    for (const { key, value } of attrs) {
      // redact secrets lightly if any slipped through
      let raw =
        /password|passphrase|secret|credential/i.test(key) && value && value !== "**********"
          ? "**********"
          : expandAttrValue(value);
      // Collapse noisy multi-value capability ads in the table view
      if (/Capability-Advertisement/i.test(key) && raw.length > 80) {
        raw = raw.slice(0, 60) + "…";
      }
      const enriched = enrichRadiusValue(key, raw.includes("\n") ? raw.split("\n")[0] : raw);
      // For multi-line DUR blobs, keep full body; only enrich single-line enums
      let display = raw.includes("\n") ? raw : enriched.display;

      const tr = el("tr");
      const th = el("th");
      th.appendChild(document.createTextNode(key));
      if (enriched.type || enriched.attrId !== "") {
        const meta = el("div", { className: "at-attr-meta" });
        const bits = [];
        if (enriched.type) bits.push(enriched.type);
        if (enriched.attrId !== "" && enriched.attrId != null) {
          bits.push(`id ${enriched.attrId}`);
        }
        if (enriched.vendor) bits.push(enriched.vendor);
        meta.textContent = bits.join(" · ");
        th.appendChild(meta);
      }
      tr.appendChild(th);
      const td = el("td");
      if (display.includes("\n")) {
        const pre = el("pre", { className: "at-pre at-pre--inline" });
        pre.textContent = display;
        td.appendChild(pre);
      } else {
        td.textContent = display;
        if (enriched.enumLabel && !raw.includes(enriched.enumLabel)) {
          // already in display; no extra
        }
      }
      tr.appendChild(td);
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    return table;
  }

  /**
   * @param {ReturnType<typeof buildStory>} story
   * @param {ReturnType<typeof parseServiceConfig> | null} svc
   */
  function renderServiceWhy(story, svc) {
    const wrap = el("div");
    if (!svc) {
      wrap.appendChild(
        el("p", {
          className: "hint",
          text: "No Service_Config.xml in this export. Summary above still works from Dashboard_Details.",
        })
      );
      return wrap;
    }
    if (svc.error) {
      wrap.appendChild(el("p", { className: "hint", text: svc.error }));
      return wrap;
    }

    if (svc.exportTime || svc.version) {
      wrap.appendChild(
        el("p", {
          className: "hint",
          text: `Config export${svc.version ? ` (CPPM ${svc.version})` : ""}${svc.exportTime ? ` · ${svc.exportTime}` : ""}`,
        })
      );
    }

    const match = story.serviceWhy;
    if (!match) {
      wrap.appendChild(
        el("p", {
          className: "hint",
          text: "Service_Config.xml present but no Radius/TACACS enforcement service block found.",
        })
      );
      return wrap;
    }

    const head = el("div", { className: "at-svc-head" });
    head.innerHTML = `
      <h3 class="at-svc-name">${escapeHtml(match.name)}</h3>
      ${match.description ? `<p class="hint">${escapeHtml(match.description)}</p>` : ""}
      <p class="hint">
        ${match.template ? `Template: <span class="inline-code">${escapeHtml(match.template)}</span> · ` : ""}
        Match: <span class="inline-code">${escapeHtml(match.ruleCombine || "—")}</span>
        ${match.enabled ? ` · enabled=${escapeHtml(match.enabled)}` : ""}
      </p>
    `;
    wrap.appendChild(head);

    if (match.rules.length) {
      wrap.appendChild(el("p", { className: "at-subhead", text: "Service rules (must match for this service)" }));
      const ul = el("ul", { className: "at-rule-list" });
      for (const r of match.rules) {
        const li = el("li");
        li.innerHTML = `<span class="inline-code">${escapeHtml(r.type)}:${escapeHtml(r.name)}</span>
          ${escapeHtml(r.operator)}
          <strong>${escapeHtml(r.displayValue || r.value)}</strong>`;
        ul.appendChild(li);
      }
      wrap.appendChild(ul);
    }

    const wiring = [
      ["Auth methods", match.authMethods],
      ["Auth sources", match.authSources],
      ["Authz sources", match.autzSources],
      ["Role mapping", match.roleMappings],
      ["Enforcement policy", match.enfPolicies],
    ];
    const dl = el("dl", { className: "at-dl" });
    for (const [label, items] of wiring) {
      if (!items || !items.length) continue;
      dl.appendChild(el("dt", { text: label }));
      dl.appendChild(el("dd", { text: items.join(", ") }));
    }
    wrap.appendChild(dl);

    if (svc.roleMaps.length) {
      wrap.appendChild(el("p", { className: "at-subhead", text: "Role mapping policies in export" }));
      const ul = el("ul", { className: "at-rule-list" });
      for (const rm of svc.roleMaps) {
        ul.appendChild(
          el("li", {
            text: `${rm.name} — default ${rm.defaultRole || "—"} (${rm.ruleCount} rule${rm.ruleCount === 1 ? "" : "s"})`,
          })
        );
      }
      wrap.appendChild(ul);
    }

    if (svc.nads.length) {
      wrap.appendChild(el("p", { className: "at-subhead", text: "Access devices (NADs) in export" }));
      const ul = el("ul", { className: "at-rule-list" });
      for (const n of svc.nads.slice(0, 20)) {
        ul.appendChild(
          el("li", {
            text: `${n.name}${n.ipAddress ? ` (${n.ipAddress})` : ""}${n.vendor ? ` · ${n.vendor}` : ""}`,
          })
        );
      }
      if (svc.nads.length > 20) {
        ul.appendChild(el("li", { text: `…and ${svc.nads.length - 20} more` }));
      }
      wrap.appendChild(ul);
    }

    return wrap;
  }

  /**
   * @param {ReturnType<typeof parseRequestLogs>} rows
   */
  function renderLogTimeline(rows) {
    if (!rows || !rows.length) {
      return el("p", { className: "hint", text: "No Request_Logs.html in this export." });
    }
    if (rows.length === 1 && rows[0].level === "empty") {
      return el("p", { className: "hint", text: "No logs for this session (common on some exports)." });
    }

    // Prefer signal: alerts, warns, and key INFO; offer full list in scroll
    const table = el("table", { className: "at-table at-table--logs" });
    const tb = el("tbody");
    let shown = 0;
    for (const row of rows) {
      if (row.level === "empty") continue;
      const tr = el("tr", {
        className:
          row.level === "alert"
            ? "at-log--alert"
            : row.level === "warn"
              ? "at-log--warn"
              : "",
      });
      tr.appendChild(el("td", { className: "at-log-time", text: row.time || "—" }));
      tr.appendChild(el("td", { text: cleanLogMessage(row.message) }));
      tb.appendChild(tr);
      shown++;
    }
    table.appendChild(tb);
    const wrap = el("div", { className: "at-log-scroll" });
    wrap.appendChild(table);
    if (!shown) {
      return el("p", { className: "hint", text: "Log file had no parseable rows." });
    }
    return wrap;
  }

  // ─── UI wiring ─────────────────────────────────────────────────────────────

  /**
   * Styled flash banner (not a naked status-line or window.alert).
   * @param {string} msg
   * @param {"ok"|"error"|"warn"|"info"|""} [tone]
   * @param {string} [title]
   */
  function setStatus(msg, tone, title) {
    const s = $("status");
    if (!s) return;
    if (!msg) {
      s.className = "at-flash hidden";
      s.removeAttribute("data-tone");
      s.replaceChildren();
      return;
    }
    const t = tone || "info";
    s.className = `at-flash at-flash--${t}`;
    s.setAttribute("data-tone", t);
    s.removeAttribute("hidden");

    const titles = {
      ok: title || "Nice",
      error: title || "Hmm, that didn’t work",
      warn: title || "Heads-up",
      info: title || "Working on it",
    };
    const heading = titles[t] || titles.info;

    s.innerHTML = `
      <div class="at-flash__icon" aria-hidden="true">${
        t === "ok" ? "✓" : t === "error" ? "!" : t === "warn" ? "⚠" : "…"
      }</div>
      <div class="at-flash__body">
        <strong class="at-flash__title">${escapeHtml(heading)}</strong>
        <p class="at-flash__msg">${escapeHtml(msg)}</p>
      </div>
    `;
  }

  /**
   * @param {FileList | File[]} fileList
   */
  async function processFiles(fileList) {
    try {
      const n = Array.from(fileList || []).length;
      setStatus(
        n
          ? `Poking through ${n} file${n === 1 ? "" : "s"}… looking for the Access Tracker trio.`
          : "Reading files…",
        "info",
        "Sniffing the export"
      );
      await loadRadiusDict();
      const { dashboard, logs, service, names, folderHint } = await readExportFiles(fileList);

      if (!dashboard) {
        setStatus(
          "We need Dashboard_Details.txt to do anything useful. Grab the session folder from the unzipped export (tmp/R… or tmp/T…), or hand-pick that file. The browser’s “upload whole folder?” prompt is normal — hit allow if you meant to.",
          "error",
          "Missing the main course"
        );
        $("results")?.classList.add("hidden");
        return;
      }

      const dash = parseDashboard(dashboard);
      const logRows = logs ? parseRequestLogs(logs) : [];
      const logSum = logs ? summarizeLogs(logRows) : null;
      const svcParsed = service ? parseServiceConfig(service) : null;
      const story = buildStory(dash, logSum, svcParsed);

      renderStory(story, {
        dashboard: true,
        logs: !!logs,
        service: !!service,
        names,
        folderHint: folderHint || dash.sessionId || "",
        logRows,
        svcParsed,
      });

      const extras = [];
      if (logs) extras.push("logs");
      if (service) extras.push("service config");
      const extraBit = extras.length
        ? ` Packed with ${extras.join(" + ")}.`
        : " Dashboard only — still plenty.";

      if (story.result === "ACCEPT") {
        setStatus(
          `Allowed on. Session ${dash.sessionId || "unknown"}.${extraBit}`,
          "ok",
          "Accept — they’re in"
        );
      } else if (story.result === "REJECT") {
        setStatus(
          `Denied. Session ${dash.sessionId || "unknown"}.${extraBit} Sticky note below has the why.`,
          "warn",
          "Reject — door stayed shut"
        );
      } else {
        setStatus(
          `Parsed session ${dash.sessionId || "unknown"}.${extraBit}`,
          "info",
          "Decoded"
        );
      }
    } catch (err) {
      console.error(err);
      setStatus(
        err && err.message
          ? `${err.message} — if that looks like gibberish, try a different export or the session folder itself.`
          : "Couldn’t parse that export. Is it a real Access Tracker dump, or did a cat walk on the keyboard?",
        "error",
        "Parser took a nap"
      );
    }
  }

  function clearAll() {
    $("results")?.classList.add("hidden");
    $("summary-host")?.replaceChildren();
    $("details-host")?.replaceChildren();
    const folder = /** @type {HTMLInputElement|null} */ ($("folder-input"));
    const files = /** @type {HTMLInputElement|null} */ ($("files-input"));
    if (folder) folder.value = "";
    if (files) files.value = "";
    setStatus("");
    const drop = $("drop-zone");
    drop?.classList.remove("is-dragover");
  }

  function init() {
    const folderInput = /** @type {HTMLInputElement|null} */ ($("folder-input"));
    const filesInput = /** @type {HTMLInputElement|null} */ ($("files-input"));
    const drop = $("drop-zone");
    const clearBtn = $("clear-btn");

    folderInput?.addEventListener("change", () => {
      if (folderInput.files && folderInput.files.length) {
        processFiles(folderInput.files);
      }
    });

    filesInput?.addEventListener("change", () => {
      if (filesInput.files && filesInput.files.length) {
        processFiles(filesInput.files);
      }
    });

    clearBtn?.addEventListener("click", clearAll);

    if (drop) {
      const stop = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };
      ["dragenter", "dragover"].forEach((ev) => {
        drop.addEventListener(ev, (e) => {
          stop(e);
          drop.classList.add("is-dragover");
        });
      });
      ["dragleave", "drop"].forEach((ev) => {
        drop.addEventListener(ev, (e) => {
          stop(e);
          if (ev === "dragleave") drop.classList.remove("is-dragover");
        });
      });
      drop.addEventListener("drop", async (e) => {
        drop.classList.remove("is-dragover");
        const dt = e.dataTransfer;
        if (!dt) return;

        // Prefer folder entries when browser supports it
        const items = dt.items ? Array.from(dt.items) : [];
        /** @type {File[]} */
        const collected = [];

        async function walkEntry(entry, path) {
          if (entry.isFile) {
            const file = await new Promise((res, rej) => entry.file(res, rej));
            // annotate relative path for session folder detection
            try {
              Object.defineProperty(file, "webkitRelativePath", {
                value: path + file.name,
              });
            } catch (_) {
              /* ignore */
            }
            collected.push(file);
          } else if (entry.isDirectory) {
            const reader = entry.createReader();
            const readBatch = () =>
              new Promise((res, rej) => reader.readEntries(res, rej));
            /** @type {any[]} */
            let batch = await readBatch();
            while (batch.length) {
              for (const child of batch) {
                await walkEntry(child, path + entry.name + "/");
              }
              batch = await readBatch();
            }
          }
        }

        let usedEntries = false;
        for (const item of items) {
          const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
          if (entry) {
            usedEntries = true;
            await walkEntry(entry, "");
          }
        }

        if (usedEntries && collected.length) {
          await processFiles(collected);
          return;
        }

        if (dt.files && dt.files.length) {
          await processFiles(dt.files);
        }
      });
    }
  }

  // Expose for debugging / future tests
  window.AccessTrackerDecoder = {
    parseDashboard,
    parseRequestLogs,
    parseServiceConfig,
    summarizeLogs,
    buildStory,
    processFiles,
    loadRadiusDict,
    lookupRadiusAttr,
    enrichRadiusValue,
    explainWhy,
    collectHandedBack,
    get radiusDict() {
      return radiusDict;
    },
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      loadRadiusDict();
      init();
    });
  } else {
    loadRadiusDict();
    init();
  }
})();
