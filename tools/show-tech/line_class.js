/**
 * Single line classifier for show-tech findings.
 * Noise vs signal is decided HERE — finding rules only match after this gate.
 *
 * Kinds:
 *   noise_*  — never become findings (except force core-count on real non-zero counts)
 *   signal_* — allowed as HIGH evidence
 *   other    — may match MED/LOW keyword rules only
 */

(function (global) {
  "use strict";

  function isPipeTableHeader(line) {
    const t = line.trim();
    if ((t.match(/\|/g) || []).length < 2) return false;
    if (/\bFault Count\b/i.test(t) || /\bLast Fault\b/i.test(t)) return true;
    if (/^\|/.test(t) && /\bFan\b/i.test(t) && /\bFault\b/i.test(t)) return true;
    const cells = t
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);
    if (cells.length >= 3 && cells.every((c) => c.length < 40 && !/\d{2}:\d{2}/.test(c))) {
      const headerish = cells.filter((c) =>
        /^[A-Za-z][A-Za-z0-9 ./%_-]*$/.test(c)
      ).length;
      if (headerish === cells.length) return true;
    }
    return false;
  }

  function isTableHeaderLine(line) {
    const t = line.trim();
    if (!t) return false;
    if (isPipeTableHeader(t)) return true;
    if (
      /\bREQ-FAIL\b|\bACK-FAIL\b|\bVLAN_FAIL\b|\bREQ-SENT\b|\bACK-SENT\b|\bREQ-RCVD\b|\bACK-RCVD\b/.test(
        t
      ) &&
      (t.match(/\b[A-Z][A-Z0-9_-]{2,}\b/g) || []).length >= 3
    ) {
      return true;
    }
    if (
      /\bCrashInfo\b/.test(t) &&
      /\b(?:Uptime|Status|Version|Model|License|Nodepath)\b/i.test(t)
    ) {
      return true;
    }
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length >= 5) {
      const upperish = words.filter((w) =>
        /^[A-Z][A-Z0-9_./()-]*$/.test(w.replace(/%/g, ""))
      ).length;
      if (upperish / words.length >= 0.7 && /\bFAIL\b|\bCrashInfo\b/i.test(t))
        return true;
    }
    return false;
  }

  function isSectionTitle(line) {
    const t = line.trim();
    if (!t) return true;
    if (/^Command\s*:/i.test(t)) return true;
    if (/^show\s+\S+/i.test(t) && t.length < 80) return true;
    if (/^\[Begin\]/i.test(t)) return true;
    if (/^={3,}/.test(t) || /^\*{3,}/.test(t)) return true;
    if (/^\/[\w./+-]+:?\s*$/.test(t)) return true;
    if (/^Coredump\s*:\s*\d+\s*KB\b/i.test(t)) return true;
    if (/^(kernel\s+)?coredump\s*$/i.test(t)) return true;
    if (/^crashinfo\s*$/i.test(t)) return true;
    return false;
  }

  /** Config threshold definitions (not "threshold exceeded" alarms). */
  function isConfigThreshold(line) {
    const t = line.trim();
    if (/\bthreshold\s+exceeded\b/i.test(t)) return false;
    if (/\bexceeded\b/i.test(t) && /\bthreshold\b/i.test(t)) return false;
    if (/\bCRITICAL\b/.test(t) && /\btemperature\b/i.test(t)) return false;
    if (/\b(?:high|low)\s+(?:alarm|warning)\s+threshold\s*[:=]\s*[-+]?\d/i.test(t))
      return true;
    if (
      /\btemperature\b/i.test(t) &&
      /\bthreshold\s*[:=]\s*[-+]?\d/i.test(t) &&
      !/\bexceed/i.test(t)
    ) {
      return true;
    }
    if (/\b(?:high|low)\s+(?:alarm|warning)\s+threshold\s*=\s*[-+]?\d/i.test(t))
      return true;
    return false;
  }

  /**
   * Happy-path / inactive sensor wording.
   * Includes: alarm: false, high warning: false, flag: Off, status Off.
   */
  function isNegatedSensor(line) {
    const t = line.trim();
    if (/:\s*false\s*$/i.test(t)) return true;
    if (/\b(?:high|low)\s+(?:warning|alarm)\s*:\s*false\b/i.test(t)) return true;
    if (/\balarm\s*:\s*false\b/i.test(t)) return true;
    // Explicit off flags (case-insensitive Off/OFF/off)
    if (/\bflag\s*:\s*Off\b/i.test(t)) return true;
    if (/\b(?:high|low)\s+temperature\s+flag\s*:\s*Off\b/i.test(t)) return true;
    if (/\btemperature\s+flag\s*:\s*Off\b/i.test(t)) return true;
    // "… alarm: Off" / "status: normal" without exceed/critical
    if (/\b(?:alarm|warning|flag)\s*:\s*Off\b/i.test(t)) return true;
    if (/\bnormal\b/i.test(t) && /\btemperature\b/i.test(t) && !/\b(exceed|critical|fault)\b/i.test(t))
      return true;
    return false;
  }

  function isZeroCounter(line) {
    const t = line.trim();
    if (/Failed\s*:\s*0\b/i.test(t)) return true;
    if (/\bFail(?:ed|ures)?\s*[=:]\s*0\b/i.test(t)) return true;
    if (/\bFail(?:ures)?\s+0\s*$/i.test(t)) return true;
    if (/\bTotal\s*:\s*0\b/i.test(t)) return true;
    if (/\b0-PASS\s+1-FAIL\b/i.test(t)) return true;
    if (/ANTENNA CHECKS\s*:\s*\(/i.test(t)) return true;
    if (/ERROR events\b/i.test(t) && /\bTotal\s*:\s*0\b/i.test(t)) return true;
    return false;
  }

  function isCriticalColumn(line) {
    const t = line.trim();
    // Config keywords that embed "critical" without being a CRITICAL log event
    if (/critical-(?:role|voice)/i.test(t)) return true;
    if (/cached-critical/i.test(t)) return true;
    if (/port-access\s+critical/i.test(t)) return true;
    if (!/\bCRITICAL\b/.test(t)) return false;
    if (
      /\b(?:application_health|health_monitor|client_services|interface_tx_rx|nae-agent)\b/i.test(
        t
      )
    ) {
      return true;
    }
    if (/\bfalse\s+CRITICAL\s+\d+/i.test(t)) return true;
    if (/\btrue\s+CRITICAL\s+\d+/i.test(t) && /\buser\b/i.test(t)) return true;
    if (
      (t.match(/\s{2,}/g) || []).length >= 3 &&
      /\b(?:user|system|false|true)\b/i.test(t) &&
      /\d+\s+\d+/.test(t)
    ) {
      return true;
    }
    return false;
  }

  function isNonZeroCoreCount(line) {
    return /Total number of core dumps\s*:\s*([1-9]\d*)\b/i.test(line);
  }

  /**
   * @param {string} line
   * @returns {{ kind: string, reason: string }}
   */
  function classifyLine(line) {
    const t = String(line || "").trim();
    if (!t) return { kind: "noise_section_title", reason: "empty" };

    // --- noise (order: structural → config → negated) ---
    if (isSectionTitle(t))
      return { kind: "noise_section_title", reason: "command/section/path label" };
    if (isTableHeaderLine(t))
      return { kind: "noise_table_header", reason: "table/column header" };
    if (isZeroCounter(t))
      return { kind: "noise_zero_counter", reason: "zero counter or legend" };
    if (isConfigThreshold(t))
      return { kind: "noise_config_threshold", reason: "threshold definition" };
    if (isNegatedSensor(t))
      return { kind: "noise_negated_sensor", reason: "inactive/off/false sensor" };
    if (isCriticalColumn(t))
      return { kind: "noise_critical_column", reason: "CRITICAL severity column/config" };

    // Happy-path phrases
    if (/No crash information available/i.test(t))
      return { kind: "noise_section_title", reason: "no crash available" };
    if (/No kernel crash information available/i.test(t))
      return { kind: "noise_section_title", reason: "no kernel crash" };
    if (/Total number of core dumps\s*:\s*0\b/i.test(t))
      return { kind: "noise_zero_counter", reason: "zero core dumps" };
    if (/UPDATE SUCCESSFUL/i.test(t))
      return { kind: "noise_zero_counter", reason: "update successful" };

    // --- signals (active faults / alarms) ---
    if (isNonZeroCoreCount(t))
      return { kind: "signal_fault", reason: "non-zero core dump count" };
    if (/IKE\s+FAILED\b|RC_ERROR_IKE/i.test(t))
      return { kind: "signal_fault", reason: "IKE FAILED" };
    if (/\bIPSEC_TUNNEL_DOWN\b/i.test(t))
      return { kind: "signal_fault", reason: "IPSEC_TUNNEL_DOWN" };
    // Either IPSEC or IKE not UP counts as unhealthy SA (UP/DOWN, DOWN/UP, DOWN/DOWN)
    {
      const sa = t.match(
        /Tunnel status IPSEC:\s*(\w+)\s+IKE:\s*(\w+)/i
      );
      if (sa && (!/^UP$/i.test(sa[1]) || !/^UP$/i.test(sa[2]))) {
        return { kind: "signal_fault", reason: "IPSec/IKE SA not both UP" };
      }
    }
    if (/Event\|\d+\|LOG_(?:ERR|CRIT)/i.test(t))
      return { kind: "signal_fault", reason: "CX Event ERR/CRIT" };
    if (/Event\|\d+\|LOG_WARN/i.test(t))
      return { kind: "signal_fault", reason: "CX Event WARN" };
    if (/\berr[-\s]?disabled\b|\berror[-\s]?disabled\b/i.test(t))
      return { kind: "signal_fault", reason: "err-disabled" };
    if (/\bkernel\s+panic\b|\bsoftware\s+exception\b|\bfatal\s+exception\b/i.test(t))
      return { kind: "signal_fault", reason: "crash/panic" };
    if (
      /\bpsu\b.*\b(fail|fault|absent)\b|\bpower\s*supply\b.*\b(fail|fault|absent)\b/i.test(
        t
      ) ||
      /\bfan\b.*\b(fail|fault|error)\b/i.test(t)
    )
      return { kind: "signal_fault", reason: "fan/PSU fault" };
    if (/\bthreshold\s+exceeded\b/i.test(t))
      return { kind: "signal_active_alarm", reason: "threshold exceeded" };
    if (/\bCRITICAL\b/.test(t) && /\btemperature\b/i.test(t))
      return { kind: "signal_active_alarm", reason: "CRITICAL temperature" };
    // Real CRITICAL log line (timestamp-ish + CRITICAL + message), not column
    if (
      /\bCRITICAL\b/.test(t) &&
      (/\d{4}-\d{2}-\d{2}|daemon\.|LOG_|:\s*CRITICAL\b/.test(t) ||
        /CRITICAL\s+\w+/i.test(t)) &&
      !isCriticalColumn(t)
    )
      return { kind: "signal_active_alarm", reason: "CRITICAL log event" };
    if (
      /core\s*dump\s+written|coredump written|exception log/i.test(t) &&
      !isSectionTitle(t)
    )
      return { kind: "signal_fault", reason: "core dump written" };
    // Active high temperature (not flag Off — already noise above)
    if (
      /(?:\bhigh\b.{0,40}\btemperature\b|\btemperature\b.{0,60}\b(?:high|critical|over|alarm|exceed))/i.test(
        t
      ) &&
      !isNegatedSensor(t) &&
      !isConfigThreshold(t)
    ) {
      // Require alarm-ish verb, not just "High temperature flag: On" without more?
      // flag: On could be real; flag: Off already noise
      if (/\bflag\s*:\s*On\b/i.test(t))
        return { kind: "signal_active_alarm", reason: "temperature flag On" };
      if (/\b(exceed|critical|alarm|fault|sensor)\b/i.test(t))
        return { kind: "signal_active_alarm", reason: "temperature alarm language" };
    }

    return { kind: "other", reason: "unclassified" };
  }

  function isNoiseKind(kind) {
    return String(kind || "").startsWith("noise_");
  }

  function isSignalKind(kind) {
    return String(kind || "").startsWith("signal_");
  }

  const api = {
    classifyLine,
    isNoiseKind,
    isSignalKind,
    isTableHeaderLine,
    isPipeTableHeader,
    isConfigThreshold,
    isNegatedSensor,
    isZeroCounter,
    isCriticalColumn,
    isSectionTitle,
    isNonZeroCoreCount,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.ShowTechLineClass = api;
})(typeof window !== "undefined" ? window : globalThis);
