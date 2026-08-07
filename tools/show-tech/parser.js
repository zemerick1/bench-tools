/**
 * Show-tech / support-dump → facts + grouped findings with evidence context.
 *
 * Philosophy: extract what the dump already says. Group lines that already
 * smell like trouble. Do not invent root cause. You are not TAC.
 */

(function (global) {
  "use strict";

  const CONTEXT_LINES = 2;

  // Line classifier: single noise/signal gate (loaded via script tag or require)
  const LineClass =
    (typeof module !== "undefined" && module.exports
      ? require("./line_class.js")
      : null) ||
    global.ShowTechLineClass ||
    null;
  if (!LineClass || typeof LineClass.classifyLine !== "function") {
    throw new Error(
      "Show-tech parser requires line_class.js (ShowTechLineClass) to load first"
    );
  }
  const { classifyLine, isNoiseKind, isSignalKind } = LineClass;

  const FAMILIES = {
    "aos-cx": {
      id: "aos-cx",
      label: "AOS-CX switch",
      short: "CX",
    },
    "aos-10-ap": {
      id: "aos-10-ap",
      label: "AOS-10 access point",
      short: "AP",
    },
    microbranch: {
      id: "microbranch",
      label: "AOS-10 Microbranch AP",
      short: "MB-AP",
    },
    gateway: {
      id: "gateway",
      label: "AOS-10 gateway / MD",
      short: "GW",
    },
    vpnc: {
      id: "vpnc",
      label: "AOS-10 VPNC (SD-Branch)",
      short: "VPNC",
    },
    "aos-10": {
      id: "aos-10",
      label: "AOS-10 (controller-ish)",
      short: "AOS-10",
    },
    instant: {
      id: "instant",
      label: "Instant / AOS-8 IAP",
      short: "IAP",
    },
    unknown: {
      id: "unknown",
      label: "Mystery meat",
      short: "?",
    },
  };

  function stripNoise(text) {
    let t = String(text || "");
    t = t.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
    t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return t;
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function firstLineMatch(text, re) {
    const m = text.match(re);
    if (!m) return null;
    return (m[1] || m[0]).trim();
  }

  function firstLabelValue(text, labels) {
    for (const label of labels) {
      const re = new RegExp(
        "^[ \\t]*" + escapeRe(label) + "[ \\t]*:[ \\t]*(.+?)[ \\t]*$",
        "im"
      );
      const m = text.match(re);
      if (m && m[1] && m[1].trim() && m[1].trim().toUpperCase() !== "N/A") {
        return m[1].trim();
      }
    }
    return null;
  }

  function sectionSlice(text, commandRe, maxChars) {
    const m = text.match(commandRe);
    if (!m) return "";
    return text.slice(m.index, m.index + (maxChars || 4000));
  }

  function detectFamily(text) {
    const t = text;
    const scores = {
      "aos-cx": 0,
      "aos-10-ap": 0,
      microbranch: 0,
      gateway: 0,
      vpnc: 0,
      "aos-10": 0,
      instant: 0,
    };

    if (/^\s*AOS-CX\s*$/m.test(t) || /\bAOS-CX Version\b/i.test(t))
      scores["aos-cx"] += 6;
    if (/\bVersion\s*:\s*FL\.\d+/i.test(t)) scores["aos-cx"] += 5;
    if (/\bChassis Serial Nbr\b/i.test(t)) scores["aos-cx"] += 4;
    if (/\bProduct Name\s*:\s*JL\d+/i.test(t)) scores["aos-cx"] += 3;
    if (/\bCommand\s*:\s*show system\b/i.test(t)) scores["aos-cx"] += 2;
    if (/\bShow Tech executed on\b/i.test(t)) scores["aos-cx"] += 2;
    if (/\bMy VSF Role\b/i.test(t)) scores["aos-cx"] += 1;

    // Shared AP/IAP shape (prompt may use :10# or :fc# MAC nibble)
    const apPrompt = /^[A-Za-z0-9_.-]*AP[A-Za-z0-9_.-]*:[A-Za-z0-9]+#/m.test(t);
    if (apPrompt) {
      scores["aos-10-ap"] += 2;
      scores.instant += 2;
      scores.microbranch += 1;
    }
    if (/\bAP uptime is\b/i.test(t)) {
      scores["aos-10-ap"] += 1;
      scores.instant += 1;
      scores.microbranch += 1;
    }
    if (/\bIAP Serial Number\b/i.test(t)) {
      scores["aos-10-ap"] += 1;
      scores.instant += 1;
      scores.microbranch += 1;
    }
    if (/\bAP Model\s+AP-\d+/i.test(t)) {
      scores["aos-10-ap"] += 3;
      scores.microbranch += 2;
    }

    // AOS-10 AP banner (not Instant 8.x)
    if (/\bAOS-10\s*\(MODEL:\s*(?:AP-?)?\d/i.test(t)) scores["aos-10-ap"] += 8;
    if (/\bAOS-10\s*\(MODEL:/i.test(t) && !/\bAruba\d{3,}/i.test(t))
      scores["aos-10-ap"] += 2;
    // ArubaOS (MODEL: 505H), Version 10.x — campus AP or microbranch (not Instant 8)
    if (/\bArubaOS\s*\(MODEL:\s*(?:AP-?)?\d/i.test(t) && /\bVersion\s+10\./i.test(t))
      scores["aos-10-ap"] += 5;
    if (/\bX-Ap-Info\b/i.test(t)) scores["aos-10-ap"] += 2;

    // Microbranch AP (SD-Branch thin AP persona on AOS-10)
    if (/\bMicrobranch AP is Enabled\b/i.test(t)) scores.microbranch += 12;
    if (/\bmicrobranch-tunnel-enable\b/i.test(t)) scores.microbranch += 8;
    if (/\bS\s*-\s*Microbranch\b/i.test(t)) scores.microbranch += 4;
    if (/\bmicrobranch-tunnel-inner-ip\b/i.test(t)) scores.microbranch += 4;
    if (/\bVPNC-control-plane\b/i.test(t)) scores.microbranch += 3;
    if (/\bName\s*:\s*MB-/i.test(t)) scores.microbranch += 2;

    // Instant / AOS-8 IAP — ArubaOS (MODEL: 207), Version 8.x
    if (/\bArubaOS\s*\(MODEL:\s*[^)]+\)\s*,\s*Version\s+8\./i.test(t))
      scores.instant += 10;
    if (/\bAruba Instant\b/i.test(t) && !/\bAOS-10\s*\(MODEL:/i.test(t))
      scores.instant += 4;
    if (/\bVersion\s+8\.\d+\.\d+/i.test(t) && /\bMODEL:\s*\d+/i.test(t))
      scores.instant += 3;
    if (/\bName\s*:\s*IAP-/i.test(t) || /\bname IAP-/i.test(t))
      scores.instant += 2;
    if (/\bLSR\b/.test(t) && /\bVersion\s+8\./i.test(t)) scores.instant += 1;

    // Campus / branch gateways (controller-style)
    if (/\bAOS-10\s*\(MODEL:\s*Aruba\d+/i.test(t)) scores.gateway += 6;
    if (/\bArubaOS\s*\(MODEL:\s*Aruba\d+/i.test(t)) scores.gateway += 5;
    if (/\bHostname is\s+\S+/i.test(t)) scores.gateway += 3;
    if (/\bSwitch uptime is\b/i.test(t)) scores.gateway += 3;
    if (/\bSystem Serial#\b/i.test(t)) scores.gateway += 3;
    if (/\bSupervisor Card\b/i.test(t)) scores.gateway += 2;
    if (
      /\bMODEL:\s*Aruba(?:7005|7008|7010|7024|7030|7205|7210|7220|7240|9004|9012|9106|9114|9240)/i.test(
        t
      )
    )
      scores.gateway += 4;

    // VPNC — SD-Branch VPN concentrator (gateway persona that terminates microbranch)
    if (/\bHostname is\s+\S*VPNC\S*/i.test(t)) scores.vpnc += 10;
    if (/\bhostname\s+"[^"]*VPNC[^"]*"/i.test(t)) scores.vpnc += 6;
    if (/\bMB-VPNC\b/i.test(t) || /\bVPNC-\d/i.test(t)) scores.vpnc += 4;
    if (/\bMODEL:\s*Aruba9004/i.test(t) && /\bHostname is\b/i.test(t))
      scores.vpnc += 3;
    if (/\bVPN\s*Concentrator\b/i.test(t)) scores.vpnc += 5;
    // Share base gateway score into vpnc when clearly VPNC-named
    if (scores.vpnc >= 6) scores.vpnc += Math.min(scores.gateway, 6);

    if (/\bAOS-10\s*\(MODEL:/i.test(t)) scores["aos-10"] += 2;
    if (/\bMobility (?:Master|Conductor|Controller)\b/i.test(t))
      scores["aos-10"] += 3;

    let best = "unknown";
    let bestScore = 0;
    for (const [k, v] of Object.entries(scores)) {
      if (v > bestScore) {
        bestScore = v;
        best = k;
      }
    }
    // Prefer Instant over aos-10-ap when 8.x banner wins
    if (
      best === "aos-10-ap" &&
      scores.instant > scores["aos-10-ap"] &&
      scores.instant >= 5
    ) {
      best = "instant";
    }
    // Prefer microbranch over plain AP when MB signals present
    if (
      (best === "aos-10-ap" || best === "instant") &&
      scores.microbranch >= 8 &&
      scores.microbranch >= scores[best]
    ) {
      best = "microbranch";
    }
    // Prefer VPNC over generic gateway when named/scored as concentrator
    if (best === "gateway" && scores.vpnc > scores.gateway) {
      best = "vpnc";
    }
    if (best === "aos-10") {
      if (scores.vpnc >= 8) best = "vpnc";
      else if (scores["aos-10-ap"] >= 4 && scores["aos-10-ap"] >= scores.gateway)
        best = "aos-10-ap";
      else if (scores.gateway >= 4) best = "gateway";
      else if (scores.instant >= 5) best = "instant";
      else if (scores.microbranch >= 8) best = "microbranch";
    }
    if (bestScore < 3) return FAMILIES.unknown;
    return FAMILIES[best] || FAMILIES.unknown;
  }

  /**
   * Shared OS banner: AOS-10|ArubaOS (MODEL: X), Version Y.Z SSR|LSR
   * @returns {{ model: string, version: string } | null}
   */
  function parseOsModelVersion(text) {
    const m = text.match(
      /(?:AOS-10|ArubaOS|Aruba Operating System Software\.\s*ArubaOS)\s*\(MODEL:\s*([^)]+?)\)\s*,\s*Version\s+(\d+\.\d+\.\d+\.\d+\w*)(?:\s+(\w+))?/i
    );
    if (!m) {
      const m2 = text.match(
        /(?:AOS-10|ArubaOS)\s*\(MODEL:\s*([^)]+?)\)\s*,\s*Version\s+(\d+\.\d+\.\d+\.\d+\w*)(?:\s+(\w+))?/i
      );
      if (!m2) return null;
      return {
        model: m2[1].trim(),
        version: m2[2] + (m2[3] ? " " + m2[3] : ""),
      };
    }
    return {
      model: m[1].trim(),
      version: m[2] + (m[3] ? " " + m[3] : ""),
    };
  }

  function formatApModel(model) {
    if (!model) return model;
    if (/^AP-/i.test(model)) return model;
    if (/^\d/.test(model)) return "AP-" + model;
    return model;
  }

  /** AP/IAP CLI prompt: AP-name:10# or AP-name:fc# */
  function apPromptHostname(text) {
    return firstLineMatch(
      text,
      /^([A-Za-z0-9_.-]+):[A-Za-z0-9]+#/m
    );
  }

  function dedupeFacts(facts) {
    const seen = new Set();
    const out = [];
    for (const f of facts) {
      if (seen.has(f.label)) continue;
      seen.add(f.label);
      out.push(f);
    }
    return out;
  }

  function addFact(facts, label, value, note) {
    if (value == null || String(value).trim() === "") return;
    facts.push({
      label,
      value: String(value).trim(),
      note: note || "",
    });
  }

  function extractCx(text) {
    const facts = [];
    const sys = sectionSlice(text, /Command\s*:\s*show system\b/i, 3000) || text;
    const ver = sectionSlice(text, /Command\s*:\s*show version\b/i, 2000) || text;

    addFact(
      facts,
      "Hostname",
      firstLabelValue(sys, ["Hostname", "System Name"]) ||
        firstLabelValue(text, ["Hostname", "System Name"]) ||
        firstLineMatch(text, /^hostname\s+(\S+)/im)
    );
    addFact(
      facts,
      "Model / product",
      firstLineMatch(
        sys,
        /^[ \t]*Product Name[ \t]*:[ \t]*(JL\d+\S*(?:[ \t]+[^\n]+)?)$/im
      ) ||
        firstLineMatch(
          text,
          /^[ \t]*Product Name[ \t]*:[ \t]*(JL\d+\S*(?:[ \t]+[^\n]+)?)$/im
        )
    );
    addFact(
      facts,
      "Serial",
      firstLabelValue(sys, ["Chassis Serial Nbr", "Chassis Serial Number"]) ||
        firstLabelValue(text, ["Chassis Serial Nbr", "Chassis Serial Number"])
    );
    addFact(
      facts,
      "Software version",
      firstLabelValue(sys, ["AOS-CX Version"]) ||
        firstLineMatch(ver, /^[ \t]*Version[ \t]*:[ \t]*(FL\.\d[\w.]+)/im) ||
        firstLineMatch(text, /^[ \t]*Version[ \t]*:[ \t]*(FL\.\d[\w.]+)/im) ||
        firstLineMatch(text, /\b(FL\.\d+\.\d+\.\d+\w*)\b/)
    );
    addFact(
      facts,
      "Uptime",
      firstLabelValue(sys, ["Up Time", "Uptime"]) ||
        firstLabelValue(text, ["Up Time"])
    );
    addFact(
      facts,
      "Base MAC",
      firstLabelValue(sys, ["Base MAC Address"]) ||
        firstLabelValue(text, ["Base MAC Address"])
    );
    addFact(
      facts,
      "Vendor",
      firstLabelValue(sys, ["Vendor"]) || firstLabelValue(text, ["Vendor"])
    );
    addFact(
      facts,
      "System description",
      firstLabelValue(sys, ["System Description"])
    );
    addFact(facts, "Time zone", firstLabelValue(sys, ["Time Zone"]));
    addFact(
      facts,
      "Active image",
      firstLabelValue(ver, ["Active Image"]) ||
        firstLabelValue(text, ["Active Image"])
    );
    addFact(
      facts,
      "Build ID",
      firstLabelValue(ver, ["Build ID"]) || firstLabelValue(text, ["Build ID"])
    );
    addFact(
      facts,
      "BIOS version",
      firstLabelValue(ver, ["BIOS Version"]) ||
        firstLabelValue(text, ["BIOS Version"])
    );
    addFact(
      facts,
      "Service OS",
      firstLabelValue(ver, ["Service OS Version"]) ||
        firstLabelValue(text, ["Service OS Version"])
    );

    const vsf =
      firstLineMatch(text, /My VSF Role\s*:\s*(\S+)/i) ||
      firstLabelValue(text, ["VSF Role"]);
    addFact(facts, "VSF role", vsf);

    const vsx = firstLabelValue(text, ["VSX Oper Status", "VSX Status"]);
    addFact(facts, "VSX", vsx);

    const cpu = firstLabelValue(sys, ["CPU Util (%)"]);
    if (cpu) addFact(facts, "CPU", /%/.test(cpu) ? cpu : cpu + "%");

    // Prefer explicit mgmt interface IP from config if present
    const mgmt =
      firstLineMatch(
        text,
        /interface mgmt[\s\S]{0,400}?ip\s+(?:static|address)\s+(\d{1,3}(?:\.\d{1,3}){3})/i
      ) ||
      firstLineMatch(
        text,
        /^[ \t]*(?:IP Address|Management\s+IP(?:\s+Address)?)\s*:\s*(\d{1,3}(?:\.\d{1,3}){3})/im
      );
    addFact(facts, "Management IP", mgmt);

    const cores = firstLineMatch(
      text,
      /Total number of core dumps\s*:\s*(\d+)/i
    );
    if (cores != null) addFact(facts, "Core dump count", cores);

    return dedupeFacts(facts);
  }

  function extractApCommon(text, facts) {
    addFact(
      facts,
      "Hostname",
      apPromptHostname(text) ||
        // Prompt-style ap-env: name:AP-OfficeDesk_b1:10
        firstLineMatch(text, /^name:([A-Za-z0-9_.-]+):[A-Za-z0-9]+/im) ||
        // Bare ap-env name (no :suffix): name:AP-Garage
        firstLineMatch(text, /^name:([A-Za-z0-9_.-]+)\s*$/im) ||
        firstLineMatch(text, /^[ \t]*Name[ \t]*:[ \t]*((?:AP|MB|IAP)-[A-Za-z0-9_.-]+)\s*$/im)
    );
    addFact(
      facts,
      "Serial",
      firstLineMatch(text, /^[ \t]*IAP Serial Number[ \t]*:[ \t]*([A-Z0-9]{6,})\b/im) ||
        firstLineMatch(
          text,
          /^[ \t]*Serial Number[ \t]*:[ \t]*([A-Z0-9]{8,14})\b/im
        )
    );
    addFact(facts, "Uptime", firstLineMatch(text, /AP uptime is\s+([^\n]+)/i));
    addFact(
      facts,
      "IP address",
      firstLineMatch(
        text,
        /^[ \t]*IP Address[ \t]*:[ \t]*(\d{1,3}(?:\.\d{1,3}){3})/im
      )
    );
    addFact(
      facts,
      "Conductor IP",
      firstLineMatch(
        text,
        /Conductor IP Address\s*\*?\s*:[ \t]*(\d{1,3}(?:\.\d{1,3}){3})/i
      )
    );
    addFact(
      facts,
      "Gateway",
      firstLineMatch(
        text,
        /^[ \t]*Gateway[ \t]*:[ \t]*(\d{1,3}(?:\.\d{1,3}){3})/im
      )
    );
    addFact(
      facts,
      "Central uptime",
      firstLineMatch(text, /Aruba Central uptimes\s*:\s*(\S+)/i)
    );
  }

  function extractAos10Ap(text) {
    const facts = [];
    extractApCommon(text, facts);

    addFact(
      facts,
      "Model / product",
      firstLineMatch(text, /^[ \t]*AP Model[ \t]+(AP-\S+)/im)
    );

    // AOS-10 (MODEL: …) or ArubaOS (MODEL: 505H), Version 10.x
    const os = parseOsModelVersion(text);
    if (os && /^10\./.test(os.version)) {
      addFact(facts, "Model / product", formatApModel(os.model));
      addFact(facts, "Software version", os.version);
    } else {
      const banner = text.match(
        /AOS-10\s*\(MODEL:\s*([^)]+)\)\s*,\s*Version\s+(\d+\.\d+\.\d+\.\d+\w*)(?:\s+(\w+))?/i
      );
      if (banner) {
        addFact(facts, "Model / product", formatApModel(banner[1].trim()));
        addFact(
          facts,
          "Software version",
          banner[2] + (banner[3] ? " " + banner[3] : "")
        );
      } else {
        addFact(
          facts,
          "Software version",
          firstLineMatch(
            text,
            /X-Current-Version:\s*([\d.]+(?:-[\d.]+)?(?:_\d+)?)/i
          )
        );
      }
    }

    const apInfo = firstLineMatch(text, /X-Ap-Info:\s*([^\n]+)/i);
    if (apInfo) addFact(facts, "AP info header", apInfo);

    // Traffic persona: GRE-to-gateway vs local bridge
    extractApTrafficMode(text, facts, "campus");

    return dedupeFacts(facts);
  }

  /**
   * How user traffic leaves the AP (campus GRE vs bridge; Instant IAP-VPN vs bridge).
   */
  function extractApTrafficMode(text, facts, kind) {
    const greMaps = (
      text.match(/gw-ipsecmap-[0-9a-f:.-]+/gi) || []
    ).length;
    const greCreate = (text.match(/\bGRE\//g) || []).length;
    const ipsecUp = (text.match(/IPSEC_TUNNEL_UP/g) || []).length;
    const ipsecDown = (text.match(/IPSEC_TUNNEL_DOWN/g) || []).length;
    const iapVpn =
      /\biap-vpn\b|\bIAP-VPN\b|\bvpn status\s*:\s*(?!Not Set Up)/i.test(text) &&
      !/VPN Status\s*:\s*Not Set Up/i.test(text);
    const vpnNotSet = /VPN Status\s*:\s*Not Set Up/i.test(text);

    if (kind === "instant") {
      if (iapVpn) {
        addFact(
          facts,
          "User traffic mode",
          "IAP-VPN (tunneled) — Instant normally bridges unless IAP-VPN is configured"
        );
      } else {
        addFact(
          facts,
          "User traffic mode",
          vpnNotSet
            ? "Local bridge (default Instant) — VPN Status: Not Set Up"
            : "Local bridge (typical Instant) unless IAP-VPN is configured"
        );
      }
      return;
    }

    // Campus AOS-10 AP: GRE tunnels to gateway(s) vs bridge
    if (greMaps > 0 || greCreate > 0) {
      addFact(
        facts,
        "User traffic mode",
        "GRE / IPSec to gateway (user traffic tunneled) — maps/tunnels seen in dump"
      );
      addFact(
        facts,
        "Gateway tunnel activity",
        `IPSEC_TUNNEL_UP×${ipsecUp}, IPSEC_TUNNEL_DOWN×${ipsecDown} (lifetime of dump)`
      );
    } else {
      addFact(
        facts,
        "User traffic mode",
        "Likely local bridge (no gw-ipsecmap / GRE tunnel create lines spotted)"
      );
    }
  }

  /** AOS-10 Microbranch AP (SD-Branch) — tunnels to VPNC */
  function extractMicrobranch(text) {
    const facts = [];
    extractApCommon(text, facts);
    // Swarm/AP name often Name: MB-AP-01 when prompt missing
    addFact(
      facts,
      "Hostname",
      firstLineMatch(text, /^[ \t]*Name[ \t]*:[ \t]*(MB-\S+)/im) ||
        firstLineMatch(text, /^[ \t]*Name[ \t]*:[ \t]*(\S+)/im)
    );

    const os = parseOsModelVersion(text);
    if (os) {
      addFact(facts, "Model / product", formatApModel(os.model));
      addFact(facts, "Software version", os.version);
    }
    addFact(
      facts,
      "Model / product",
      firstLineMatch(text, /^[ \t]*AP Model[ \t]+(AP-\S+)/im)
    );

    addFact(facts, "Persona", "Microbranch AP (SD-Branch)");
    if (/\bMicrobranch AP is Enabled\b/i.test(text)) {
      addFact(facts, "Microbranch", "Enabled");
    }
    const inner = firstLineMatch(
      text,
      /microbranch-tunnel-inner-ip\s+(\d{1,3}(?:\.\d{1,3}){3})/i
    );
    addFact(facts, "Microbranch tunnel inner IP", inner);
    addFact(
      facts,
      "User traffic mode",
      "SD-Branch overlay / IPSec toward VPNC (not campus GRE to MD)"
    );

    // Peer VPNC hints
    const peer = firstLineMatch(
      text,
      /outer ip\s+(\d{1,3}(?:\.\d{1,3}){3})\s+for uuid/i
    );
    addFact(facts, "Overlay peer (outer IP sample)", peer);
    const vpncCtrl = firstLineMatch(
      text,
      /VPNC-control-plane-(\d{1,3}(?:\.\d{1,3}){3})/i
    );
    addFact(facts, "VPNC control-plane peer", vpncCtrl);

    extractIpsecHealthFacts(text, facts);
    return dedupeFacts(facts);
  }

  /** Instant / classic AOS-8 IAP tech-support */
  function extractInstant(text) {
    const facts = [];
    extractApCommon(text, facts);

    const os = parseOsModelVersion(text);
    if (os && /^8\./.test(os.version)) {
      addFact(facts, "Model / product", formatApModel(os.model));
      addFact(facts, "Software version", os.version);
    } else {
      const banner = text.match(
        /ArubaOS\s*\(MODEL:\s*([^)]+)\)\s*,\s*Version\s+(\d+\.\d+\.\d+\.\d+\w*)(?:\s+(\w+))?/i
      );
      if (banner) {
        addFact(facts, "Model / product", formatApModel(banner[1].trim()));
        addFact(
          facts,
          "Software version",
          banner[2] + (banner[3] ? " " + banner[3] : "")
        );
      }
    }

    addFact(
      facts,
      "Swarm / VC name",
      firstLineMatch(text, /^[ \t]*Name[ \t]*:[ \t]*(IAP-\S+)/im) ||
        firstLineMatch(text, /^name\s+(IAP-\S+)/im)
    );
    addFact(facts, "Persona", "Instant AP (AOS-8 swarm)");
    extractApTrafficMode(text, facts, "instant");

    return dedupeFacts(facts);
  }

  function extractGatewayBase(text, facts) {
    addFact(facts, "Hostname", firstLineMatch(text, /Hostname is\s+(\S+)/i));

    const os = parseOsModelVersion(text);
    if (os) {
      addFact(facts, "Model / product", os.model.replace(/\)+$/, ""));
      addFact(facts, "Software version", os.version);
    } else {
      const banner = text.match(
        /AOS-10\s*\(MODEL:\s*([^)]+)\)\s*,\s*Version\s+(\d+\.\d+\.\d+\.\d+\w*)(?:\s+(\w+))?/i
      );
      if (banner) {
        addFact(facts, "Model / product", banner[1].trim());
        addFact(
          facts,
          "Software version",
          banner[2] + (banner[3] ? " " + banner[3] : "")
        );
      } else {
        addFact(
          facts,
          "Model / product",
          firstLineMatch(text, /Model\s*:\s*(\S+)/i)
        );
        addFact(
          facts,
          "Software version",
          firstLineMatch(
            text,
            /Software Version:\s*AOS-10\s+(\d+\.\d+\.\d+\.\d+\w*(?:\s+\w+)?)/i
          )
        );
      }
    }

    addFact(
      facts,
      "Serial",
      firstLineMatch(text, /System Serial#\s*:\s*(\S+)/i)
    );
    addFact(
      facts,
      "CPU card serial",
      firstLineMatch(text, /CPU Card Serial#\s*:\s*(\S+)/i)
    );
    addFact(
      facts,
      "Uptime",
      firstLineMatch(text, /Switch uptime is\s+([^\n]+)/i)
    );
    addFact(
      facts,
      "Reboot cause",
      firstLineMatch(text, /Reboot Cause:\s*([^\n]+)/i)
    );
    addFact(
      facts,
      "Memory",
      firstLineMatch(text, /(\d+M)\s+bytes of memory/i) ||
        firstLineMatch(text, /with\s+(\d+M\s+bytes of memory)/i)
    );
    addFact(
      facts,
      "Bootstrap",
      firstLineMatch(text, /ROM:\s*System Bootstrap,\s*Version\s+([^\n]+)/i) ||
        firstLineMatch(text, /BIOS Version:\s*([^\n]+)/i)
    );
    addFact(facts, "Build", firstLineMatch(text, /Compiled on\s+([^\n]+)/i));
    addFact(
      facts,
      "Switch role",
      firstLineMatch(text, /switchrole\s*:\s*(\S+)/i)
    );
  }

  function extractGateway(text) {
    const facts = [];
    extractGatewayBase(text, facts);
    addFact(
      facts,
      "Persona",
      "Gateway / MD (AOS-10 — formerly “controller” vernacular in AOS-8 campus)"
    );
    return dedupeFacts(facts);
  }

  /** SD-Branch VPN Concentrator — terminates Microbranch IPSec */
  function extractVpnc(text) {
    const facts = [];
    extractGatewayBase(text, facts);
    addFact(
      facts,
      "Persona",
      "VPNC (SD-Branch VPN concentrator — terminates Microbranch overlays)"
    );
    extractIpsecHealthFacts(text, facts);
    const maps = firstLineMatch(
      text,
      /Total Datapath Ipsec Map Table Entries:\s*(\d+)/i
    );
    addFact(facts, "Datapath IPSec map entries", maps);
    return dedupeFacts(facts);
  }

  /**
   * IPSec / IKE health summary for SD-Branch (Microbranch + VPNC).
   * Counts status lines from crypto / IKE event tables in the dump.
   */
  function extractIpsecHealthFacts(text, facts) {
    const statusLines = text.match(/Tunnel status IPSEC:\s*(\w+)\s+IKE:\s*(\w+)/gi) || [];
    let up = 0;
    let down = 0;
    for (const L of statusLines) {
      const m = L.match(/IPSEC:\s*(\w+)\s+IKE:\s*(\w+)/i);
      if (!m) continue;
      if (/^UP$/i.test(m[1]) && /^UP$/i.test(m[2])) up++;
      else down++;
    }
    if (statusLines.length) {
      addFact(
        facts,
        "IPSec tunnel status (crypto SA)",
        `${up} UP/UP, ${down} not-UP of ${statusLines.length} map(s) shown`
      );
    }

    const ikeUp = (text.match(/IPSEC_TUNNEL_UP/g) || []).length;
    const ikeDown = (text.match(/IPSEC_TUNNEL_DOWN/g) || []).length;
    if (ikeUp || ikeDown) {
      addFact(
        facts,
        "IKE tunnel events in dump",
        `UP×${ikeUp}, DOWN×${ikeDown}`
      );
    }

    const ikeFailed = (text.match(/IKE\s+FAILED/gi) || []).length;
    if (ikeFailed) {
      addFact(facts, "IKE FAILED lines", String(ikeFailed));
    }

    // Sample one peer gateway from crypto map if present
    const peerGw = firstLineMatch(
      text,
      /Peer gateway:\s*(\d{1,3}(?:\.\d{1,3}){3})/i
    );
    addFact(facts, "IPSec peer gateway (sample)", peerGw);
  }

  function extractGeneric(text) {
    const facts = [];
    addFact(
      facts,
      "Hostname",
      firstLabelValue(text, ["Hostname", "System Name"])
    );
    const banner = text.match(
      /AOS-10\s*\(MODEL:\s*([^)]+)\)\s*,\s*Version\s+(\d+\.\d+\.\d+\.\d+\w*)/i
    );
    if (banner) {
      addFact(facts, "Model / product", banner[1]);
      addFact(facts, "Software version", banner[2]);
    }
    addFact(
      facts,
      "Software version",
      firstLineMatch(text, /\b(FL\.\d+\.\d+\.\d+\w*)\b/)
    );
    return dedupeFacts(facts);
  }

  function extractFacts(text, familyId) {
    if (familyId === "aos-cx") return extractCx(text);
    if (familyId === "aos-10-ap") return extractAos10Ap(text);
    if (familyId === "microbranch") return extractMicrobranch(text);
    if (familyId === "instant") return extractInstant(text);
    if (familyId === "gateway") return extractGateway(text);
    if (familyId === "vpnc") return extractVpnc(text);
    if (familyId === "aos-10") return extractGeneric(text);
    const cx = extractCx(text);
    if (cx.some((f) => f.label === "Software version" && /^FL\./i.test(f.value)))
      return cx;
    if (/\bMicrobranch AP is Enabled\b/i.test(text))
      return extractMicrobranch(text);
    if (/\bArubaOS\s*\(MODEL:.*Version\s+8\./i.test(text))
      return extractInstant(text);
    if (/\bHostname is\s+\S*VPNC/i.test(text)) return extractVpnc(text);
    if (/\bAOS-10\s*\(MODEL:/i.test(text)) return extractAos10Ap(text);
    const ap = extractAos10Ap(text);
    if (ap.length >= 3) return ap;
    const gw = extractGateway(text);
    if (gw.length >= 3) return gw;
    return extractGeneric(text);
  }

  /**
   * Aruba Central status — platform-shaped but same three questions:
   * connected now? which server? last disconnect reason?
   * Mist is not parsed yet (called out as coming soon).
   */
  function extractCentral(text) {
    const central = {
      connected: null, // true | false | null unknown
      statusRaw: null,
      server: null,
      lastDisconnectReason: null,
      lastDisconnectTime: null,
      source: null, // cx | ap-cloud | gateway | null
      mist: {
        status: "coming_soon",
        note: "Mist status parsing is coming soon — not in this sticky note yet.",
      },
    };

    // Label: value that keeps N/A (firstLabelValue drops N/A for product fields)
    function labelAllowNA(labels) {
      for (const label of labels) {
        const re = new RegExp(
          "^[ \\t]*" +
            label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
            "[ \\t]*:[ \\t]*(.+?)[ \\t]*$",
          "im"
        );
        const m = text.match(re);
        if (m && m[1] != null && String(m[1]).trim() !== "") {
          return String(m[1]).trim();
        }
      }
      return null;
    }

    // --- AOS-CX: show hpe-anw-central ---
    const cxStatus = labelAllowNA([
      "Central connection status",
      "Central Connection Status",
    ]);
    const cxServer = labelAllowNA([
      "Central location",
      "Main location",
      "HPE ANW Central Location",
    ]);
    const cxReason = labelAllowNA([
      "Central disconnection reason",
      "Central Disconnection Reason",
    ]);
    if (cxStatus || (cxServer && /central\.arubanetworks\.com/i.test(cxServer))) {
      central.source = "cx";
      central.statusRaw = cxStatus || null;
      if (cxStatus) {
        const s = cxStatus.toLowerCase();
        central.connected =
          /\bconnected\b/.test(s) && !/\bnot\s+connected\b/.test(s);
      }
      central.server =
        cxServer && /^(N\/A|NA)$/i.test(cxServer) ? null : cxServer || null;
      // Keep explicit N/A — means "no disconnect on record", not "missing from dump"
      central.lastDisconnectReason = cxReason || null;
      return central;
    }

    // --- Gateway / MD: show aruba-central details ---
    const gwServer = firstLineMatch(
      text,
      /Aruba Central IP\/URL\s+(\S+)/i
    );
    const gwConn = firstLineMatch(
      text,
      /^[ \t]*Connection Status[ \t]+(\S+)/im
    );
    const gwReason = firstLineMatch(
      text,
      /Reason of last disconnect\s+([^\n]+)/i
    );
    const gwTime = firstLineMatch(
      text,
      /Time of last disconnect\s+([^\n]+)/i
    );
    // Prefer dedicated Central block over OpenFlow "Last Disconnected"
    if (gwServer || (gwConn && gwReason)) {
      central.source = "gateway";
      central.server = gwServer || null;
      central.statusRaw = gwConn || null;
      if (gwConn) {
        const s = gwConn.toLowerCase();
        central.connected =
          s === "up" || (/\bconnected\b/.test(s) && !/\bnot\b/.test(s));
      }
      central.lastDisconnectReason = (gwReason || "").trim() || null;
      const gt = (gwTime || "").trim();
      central.lastDisconnectTime =
        gt && !/^(N\/A|NA)$/i.test(gt) ? gt : null;
      // Optional richer line: Last Disconnected: ... reason:Connection timed out
      const openflow = text.match(
        /Last Disconnected:\s*([^(]+)\([^)]*reason:([^)]+)\)/i
      );
      if (
        openflow &&
        (!central.lastDisconnectReason ||
          /^unknown$/i.test(central.lastDisconnectReason))
      ) {
        // Keep gateway "Unknown" as primary if that's what Central agent says;
        // stash openflow detail only when reason empty
        if (!central.lastDisconnectReason) {
          central.lastDisconnectReason = openflow[2].trim();
          central.lastDisconnectTime = openflow[1].trim();
        }
      }
      return central;
    }

    // --- AP / Instant: cloud-server + activate + cloud last down ---
    const apConnected = firstLineMatch(
      text,
      /^[ \t]*Aruba Central[ \t]*:[ \t]*(Connected|Not Connected|Disconnected)\b/im
    );
    const apStatus = firstLineMatch(
      text,
      /^[ \t]*Aruba Central status[ \t]*:[ \t]*(\S+)/im
    );
    const apServer =
      firstLineMatch(
        text,
        /^[ \t]*Aruba Central [Ss]erver(?:\s+path)?[ \t]*:[ \t]*(\S*central\.arubanetworks\.com\S*)/im
      ) ||
      firstLineMatch(
        text,
        /^[ \t]*Aruba Central [Ss]erver[ \t]*:[ \t]*(\S+)/im
      ) ||
      firstLineMatch(
        text,
        /^[ \t]*Central server of rule in flash[ \t]*:[ \t]*(\S+)/im
      );
    const apDownReason = firstLineMatch(
      text,
      /^[ \t]*Last down reason[ \t]*:[ \t]*([^\n]+)/im
    );
    const apDownTime = firstLineMatch(
      text,
      /^[ \t]*Last down time[ \t]*:[ \t]*([^\n]+)/im
    );
    const apFailReason = firstLineMatch(
      text,
      /^[ \t]*Last fail reason[ \t]*:[ \t]*([^\n]+)/im
    );
    const apFailTime = firstLineMatch(
      text,
      /^[ \t]*Last fail time[ \t]*:[ \t]*([^\n]+)/im
    );

    if (apConnected || apStatus || (apServer && /central/i.test(apServer))) {
      central.source = "ap-cloud";
      central.server =
        apServer && !/^(None|N\/A|--)$/i.test(apServer) ? apServer : null;
      // Prefer human Connected line; fall back to Login_done style
      if (apConnected) {
        central.statusRaw = apConnected;
        central.connected = /^connected$/i.test(apConnected.trim());
      } else if (apStatus) {
        central.statusRaw = apStatus;
        // Login_done / login_done ⇒ connected; others unknown/false
        const s = apStatus.toLowerCase();
        if (/login_done|connected/.test(s)) central.connected = true;
        else if (/disconnect|fail|down|error/.test(s))
          central.connected = false;
        else central.connected = null;
      }
      // Prefer last *down* (actual disconnect) over last *fail* (connect attempt)
      if (apDownReason) {
        central.lastDisconnectReason = apDownReason.trim();
        central.lastDisconnectTime = apDownTime ? apDownTime.trim() : null;
      } else if (apFailReason) {
        central.lastDisconnectReason = "connect fail: " + apFailReason.trim();
        central.lastDisconnectTime = apFailTime ? apFailTime.trim() : null;
      }
      return central;
    }

    return central;
  }

  function centralToFacts(central) {
    const facts = [];
    if (!central) return facts;
    const connLabel =
      central.connected === true
        ? "Connected"
        : central.connected === false
          ? "Not connected"
          : central.statusRaw
            ? String(central.statusRaw)
            : "Unknown (not in dump)";
    addFact(facts, "Central connection", connLabel);
    if (central.statusRaw && central.statusRaw !== connLabel) {
      addFact(facts, "Central status detail", central.statusRaw);
    }
    addFact(
      facts,
      "Central server",
      central.server || "Unknown (not in dump)"
    );
    let disc =
      central.lastDisconnectReason != null &&
      String(central.lastDisconnectReason).trim() !== ""
        ? String(central.lastDisconnectReason).trim()
        : "Unknown (not in dump)";
    if (
      central.lastDisconnectTime &&
      disc !== "Unknown (not in dump)"
    ) {
      disc = disc + " @ " + central.lastDisconnectTime;
    } else if (
      central.lastDisconnectTime &&
      disc === "Unknown (not in dump)"
    ) {
      disc = "Unknown @ " + central.lastDisconnectTime;
    }
    addFact(facts, "Central last disconnect", disc);
    addFact(
      facts,
      "Mist status",
      "Coming soon — not parsed yet"
    );
    return facts;
  }

  /**
   * Finding rules: keyword match only AFTER classifyLine gate.
   * HIGH rules require signal_* classification (except force core-count on signal_fault).
   * No per-rule skip soup — noise is decided once in line_class.js.
   */
  const FINDING_RULES = [
    {
      id: "core-count",
      severity: "high",
      title: "Non-zero core dump count",
      hint: "The box already counted corpses. Export them before anyone reboots for luck.",
      re: /Total number of core dumps\s*:\s*([1-9]\d*)\b/i,
      force: true,
      maxHits: 3,
    },
    {
      id: "core-dump",
      severity: "high",
      title: "Core dump / crashinfo payload",
      hint: "Real dump talk, not a directory label cosplaying as an incident.",
      re: /\bcore[-\s]?dumps?\b|\bcoredump\b|\bcrashinfo\b/i,
      // core-count owns the Total number line
      excludeIf: (line) => /Total number of core dumps/i.test(line),
      maxHits: 8,
    },
    {
      id: "crash",
      severity: "high",
      title: "Crash / panic language",
      hint: "Crash vocabulary showed up with actual content attached.",
      re: /\bkernel\s+panic\b|\bsoftware\s+exception\b|\bfatal\s+exception\b|\bprocess\s+crash\b/i,
      maxHits: 6,
    },
    {
      id: "critical-log",
      severity: "high",
      title: "CRITICAL severity token",
      hint: "Looks like a log severity, not a severity column in a health-agent table.",
      re: /(?:^|[\s\[|:.,])CRITICAL(?:[\s\]|:.,]|$)/,
      maxHits: 8,
    },
    {
      id: "fan-psu",
      severity: "high",
      title: "Fan / power fault language",
      hint: "Hardware is not vibing. Hot boxes make bad life choices.",
      re: /\bfan\b.*\b(fail|fault|absent|error)\b|\b(fail|fault|absent|error)\b.*\bfan\b|\bpower\s*supply\b.*\b(fail|fault|absent)\b|\bpsu\b.*\b(fail|fault|absent)\b|\bpsu\s*controller\s*:\s*absent\b/i,
      maxHits: 6,
    },
    {
      id: "temp",
      severity: "high",
      title: "Temperature alarm language",
      hint: "Thermal drama — not a threshold definition and not “flag: Off”.",
      re: /(?:\bhigh\b.{0,40}\btemperature\b|\btemperature\b.{0,60}\b(?:high|critical|over|alarm|exceed)|\bover\s*temp)/i,
      maxHits: 6,
    },
    {
      id: "ike-fail",
      severity: "med",
      title: "IKE / VPN failure",
      hint: "Tunnels are having a moment. Bring the peer and the PSK story.",
      re: /IKE\s+FAILED\b|RC_ERROR_IKE/i,
      maxHits: 12,
    },
    {
      id: "ipsec-tunnel-down",
      severity: "med",
      title: "IPSec tunnel down event",
      hint: "IKE table says IPSEC_TUNNEL_DOWN — for Microbranch/VPNC check overlay health and DPD; for campus APs check GRE/IPSec to the gateway.",
      re: /\bIPSEC_TUNNEL_DOWN\b/i,
      maxHits: 12,
    },
    {
      id: "ipsec-sa-not-up",
      severity: "high",
      title: "IPSec/IKE SA not UP",
      hint: "Crypto map shows Tunnel status IPSEC/IKE not both UP. SD-Branch OTO/IPSec is unhappy — start with peer reachability and map config (VSG SD-Branch).",
      // Match any Tunnel status line; excludeIf drops true UP/UP
      re: /Tunnel status IPSEC:\s*(\w+)\s+IKE:\s*(\w+)/i,
      excludeIf: (line) => {
        const m = line.match(/Tunnel status IPSEC:\s*(\w+)\s+IKE:\s*(\w+)/i);
        return !!(m && /^UP$/i.test(m[1]) && /^UP$/i.test(m[2]));
      },
      maxHits: 8,
    },
    {
      id: "cx-event-error",
      severity: "med",
      title: "AOS-CX Event log (WARN/ERR)",
      hint: "Switch event channel noise. Look up Event|#### in the AOS-CX Event Log Message Reference (tools/show-tech/docs/) — not a root cause by itself.",
      re: /Event\|\d+\|LOG_(?:WARN|ERR|CRIT)/i,
      maxHits: 10,
    },
    {
      id: "license",
      severity: "med",
      title: "License looking sad",
      hint: "Feature may be on a timer or already in compliance purgatory.",
      re: /\blicen[cs]e\b.*\b(expir|invalid|missing|not\s+found|unlicensed|grace)\b|\b(expir|invalid|missing)\b.*\blicen[cs]e\b/i,
      maxHits: 6,
    },
    {
      id: "sync",
      severity: "med",
      title: "Sync / redundancy unhappy",
      hint: "Something claims to be out of sync. Decide if it is HA or just chatty INFO.",
      re: /\bnot\s+synchronized\b|\bout\s+of\s+sync\b|\bsplit[-\s]?brain\b|\bvsx\b.*\b(down|fail|not\s+established)\b/i,
      maxHits: 8,
    },
    {
      id: "err-disabled",
      severity: "med",
      title: "err-disabled",
      hint: "A port took itself out of the game. Usually not for enrichment.",
      re: /\berr[-\s]?disabled\b|\berror[-\s]?disabled\b/i,
      maxHits: 8,
    },
    {
      id: "oom",
      severity: "high",
      title: "Memory pressure language",
      hint: "RAM said no. Processes take that personally.",
      re: /\bout\s+of\s+memory\b|\boóm\b|(?:^|[^\w])oom(?:[^\w]|$)/i,
      maxHits: 4,
    },
    {
      id: "failed-line",
      severity: "med",
      title: "Explicit FAIL / FAILED",
      hint: "A real failure token, not a table column or legend auditioning for drama.",
      re: /\bFAIL(?:ED|URE)?\b/,
      excludeIf: (line) =>
        /IKE\s+FAILED\b/i.test(line) ||
        /\bFailures?\s+\d+\s*\|?\s*$/i.test(line.trim()) ||
        /\bFail(?:ures)?\s{2,}\d+/i.test(line) ||
        /failed to\s+(?:parse|load optional)/i.test(line),
      maxHits: 12,
    },
    {
      id: "error-line",
      severity: "low",
      title: "ERROR token in a line",
      hint: "Noise factory — sample only so you can skim, not drown.",
      re: /(?:^|[\s\[|:.,])ERROR(?:[\s\]|:.,]|$)/,
      excludeIf: (line) =>
        /error-disabled/i.test(line) ||
        (/\bERROR\b/.test(line) &&
          (line.match(/\s{2,}/g) || []).length >= 2 &&
          !/\d{4}-\d{2}-\d{2}|ERROR:/.test(line) &&
          !/:\s*ERROR\b/.test(line)),
      maxHits: 8,
    },
  ];

  function contextAround(lines, index, n) {
    const before = [];
    const after = [];
    for (let i = Math.max(0, index - n); i < index; i++) {
      before.push(lines[i]);
    }
    for (let i = index + 1; i < lines.length && i <= index + n; i++) {
      after.push(lines[i]);
    }
    return { before, after };
  }

  /**
   * Single gate: classifyLine → skip noise; HIGH only on signal_*.
   */
  function lineAllowedForRule(line, rule, cls) {
    if (!line || !String(line).trim()) return false;
    if (rule.excludeIf && rule.excludeIf(line)) return false;

    // force core-count only on non-zero core lines (already signal_fault)
    if (rule.force && rule.id === "core-count") {
      return (
        isSignalKind(cls.kind) &&
        /Total number of core dumps\s*:\s*[1-9]/i.test(line)
      );
    }

    if (isNoiseKind(cls.kind)) return false;

    // HIGH findings require signal_* classification
    if (rule.severity === "high" && !isSignalKind(cls.kind)) return false;

    return true;
  }

  function collectFindings(text) {
    const lines = text.split("\n");
    /** @type {Map<string, object>} */
    const groups = new Map();

    function ensureGroup(rule) {
      if (!groups.has(rule.id)) {
        groups.set(rule.id, {
          id: rule.id,
          severity: rule.severity,
          title: rule.title,
          hint: rule.hint,
          count: 0,
          evidence: [],
        });
      }
      return groups.get(rule.id);
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const cls = classifyLine(line);
      for (const rule of FINDING_RULES) {
        if (!rule.re.test(line)) continue;
        if (!lineAllowedForRule(line, rule, cls)) continue;

        const g = ensureGroup(rule);
        const max = rule.maxHits != null ? rule.maxHits : 8;
        if (g.evidence.length >= max) continue;

        const ctx = contextAround(lines, i, CONTEXT_LINES);
        g.evidence.push({
          line: i + 1,
          text: line.trim().slice(0, 400),
          lineClass: cls.kind,
          lineClassReason: cls.reason,
          contextBefore: ctx.before.map((l) => l.slice(0, 200)),
          contextAfter: ctx.after.map((l) => l.slice(0, 200)),
        });
        g.count = g.evidence.length;
      }
    }

    const order = { high: 0, med: 1, low: 2 };
    return Array.from(groups.values())
      .filter((g) => g.count > 0)
      .sort(
        (a, b) =>
          (order[a.severity] ?? 9) - (order[b.severity] ?? 9) ||
          b.count - a.count ||
          a.title.localeCompare(b.title)
      );
  }

  function sectionHints(text) {
    const found = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i].trim();
      if (/^Command\s*:\s*show\s+/i.test(L) && L.length < 100) {
        // Strip "Command :" only — the line already starts with "show …"
        // (replacing with "show " produced "show show clock").
        found.push({
          title: L.replace(/^Command\s*:\s*/i, "").trim(),
          line: i + 1,
        });
      } else if (
        /^show\s+[a-z]/i.test(L) &&
        L.length < 80 &&
        !/^show\s*$/i.test(L) &&
        !/^Command\s*:/i.test(L)
      ) {
        found.push({ title: L, line: i + 1 });
      } else if (/^\[Begin\]\s+/i.test(L)) {
        found.push({ title: L, line: i + 1 });
      }
      if (found.length >= 40) break;
    }
    return found;
  }

  function factGet(facts, label) {
    const f = facts.find((x) => x.label === label);
    return f ? f.value : null;
  }

  function oneLiner(family, facts, findings, central) {
    // Keep this short — identity + vibe only. Uptime, Central, family detail live under Clear facts.
    const host = factGet(facts, "Hostname");
    const model = factGet(facts, "Model / product");
    const ver = factGet(facts, "Software version");
    const high = findings
      .filter((f) => f.severity === "high")
      .reduce((n, f) => n + f.count, 0);
    const med = findings
      .filter((f) => f.severity === "med")
      .reduce((n, f) => n + f.count, 0);
    const groups = findings.length;

    const who = [host, model].filter(Boolean).join(" · ") || family.label;
    const soft = ver ? ` · ${ver}` : "";
    let mood;
    if (high) {
      mood = `${groups} finding group${groups === 1 ? "" : "s"} (${high} high) — see Looks wrong.`;
    } else if (med) {
      mood = `${groups} finding group${groups === 1 ? "" : "s"} worth a glance — see Looks wrong.`;
    } else {
      mood = "No loud hits in the filter (quiet ≠ healthy). Details under Clear facts.";
    }

    return `${who}${soft}. ${mood}`;
  }

  /**
   * @param {string} text
   * @param {{ filename?: string }} [meta]
   */
  function parseTechDump(text, meta) {
    const raw = stripNoise(text);
    const family = detectFamily(raw);
    let facts = extractFacts(raw, family.id);
    const central = extractCentral(raw);
    // Append Central / Mist facts after platform identity
    facts = dedupeFacts(facts.concat(centralToFacts(central)));
    const findings = collectFindings(raw);
    const sections = sectionHints(raw);
    const lines = raw ? raw.split("\n").length : 0;

    const highHits = findings
      .filter((f) => f.severity === "high")
      .reduce((n, f) => n + f.count, 0);
    const medHits = findings
      .filter((f) => f.severity === "med")
      .reduce((n, f) => n + f.count, 0);
    const lowHits = findings
      .filter((f) => f.severity === "low")
      .reduce((n, f) => n + f.count, 0);

    return {
      family,
      facts,
      central,
      findings,
      /** @deprecated use findings — kept for older callers */
      flags: findings.flatMap((g) =>
        g.evidence.map((e) => ({
          id: g.id,
          severity: g.severity,
          title: g.title,
          hint: g.hint,
          evidence: e.text,
          line: e.line,
        }))
      ),
      sections,
      oneLiner: oneLiner(family, facts, findings, central),
      meta: {
        filename: (meta && meta.filename) || "",
        bytes: raw.length,
        lines,
        findingGroups: findings.length,
        highFlags: highHits,
        medFlags: medHits,
        lowFlags: lowHits,
      },
    };
  }

  const api = {
    parseTechDump,
    detectFamily,
    stripNoise,
    collectFindings,
    extractCentral,
    classifyLine,
    isNoiseKind,
    isSignalKind,
    FAMILIES,
    FINDING_RULES,
    CONTEXT_LINES,
    LineClass,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.ShowTechParser = api;
})(typeof window !== "undefined" ? window : globalThis);
