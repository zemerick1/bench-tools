/**
 * Decision-table fixture for classifyLine + finding gate.
 * Each row: { line, kind, ruleId? }
 *   - kind must match classifyLine(line).kind
 *   - noise_* → no HIGH finding from parseTechDump of that single line
 *   - signal_* → parse produces a finding; if ruleId set, that group id must exist
 */

"use strict";

module.exports = [
  // --- noise: table headers ---
  {
    line: "Type IPv4 Address  REQ-SENT REQ-FAIL ACK-SENT ACK-FAIL REQ-RCVD ACK-RCVD VLAN_FAIL",
    kind: "noise_table_header",
  },
  {
    line: "IP Address  MAC  Name  Nodepath  Type  Model  Version  Status  Uptime  CrashInfo  License",
    kind: "noise_table_header",
  },
  {
    line: "| Fan             | Fault Count |            Last Fault Update |          Last Fault Recovery |",
    kind: "noise_table_header",
  },

  // --- noise: config thresholds ---
  {
    line: "Temperature high alarm threshold: 90.0000C",
    kind: "noise_config_threshold",
  },
  {
    line: "Temperature high warning threshold: 85.0000C",
    kind: "noise_config_threshold",
  },
  {
    line: "    Temperature high alarm threshold   = 90.0000",
    kind: "noise_config_threshold",
  },

  // --- noise: negated / off sensors ---
  {
    line: "Temperature high warning: false",
    kind: "noise_negated_sensor",
  },
  {
    line: "Temperature high alarm: false",
    kind: "noise_negated_sensor",
  },
  {
    line: "High temperature flag: Off",
    kind: "noise_negated_sensor",
  },
  {
    line: "High temperature flag: OFF",
    kind: "noise_negated_sensor",
  },

  // --- noise: zero counters / legends ---
  {
    line: "Drop Due To IPSEC CTRLR Failed: 0",
    kind: "noise_zero_counter",
  },
  {
    line: "LAST 10 ANTENNA CHECKS: (0-PASS 1-FAIL)",
    kind: "noise_zero_counter",
  },
  {
    line: "ERROR events sorted by time (Max 1000), Total:0",
    kind: "noise_zero_counter",
  },
  {
    line: "Total number of core dumps : 0",
    kind: "noise_zero_counter",
  },

  // --- noise: section titles / paths ---
  {
    line: "/fs/coredump:",
    kind: "noise_section_title",
  },
  {
    line: "/fs/coredump/lost+found:",
    kind: "noise_section_title",
  },
  {
    line: "show crashinfo",
    kind: "noise_section_title",
  },
  {
    line: "kernel coredump",
    kind: "noise_section_title",
  },
  {
    line: "Command : show core-dump all",
    kind: "noise_section_title",
  },

  // --- noise: CRITICAL columns / role config ---
  {
    line: "CPPM_Health_Monitor                  application_health_monitor         1.1       user      false     CRITICAL  16                  1",
    kind: "noise_critical_column",
  },
  {
    line: "aaa authentication port-access critical-role",
    kind: "noise_critical_column",
  },

  // --- signals ---
  {
    line: "Total number of core dumps : 16",
    kind: "signal_fault",
    ruleId: "core-count",
  },
  {
    line: "2026-08-02 22:11:03IKE FAILED err: RC_ERROR_IKE_SA_ERROR",
    kind: "signal_fault",
    ruleId: "ike-fail",
  },
  {
    line: "2026-04-01 lab hpe-envd: CRITICAL temperature sensor 2 high threshold exceeded",
    kind: "signal_active_alarm",
    ruleId: "critical-log",
  },
  {
    line: "High temperature threshold exceeded on sensor 3",
    kind: "signal_active_alarm",
    ruleId: "temp",
  },
  {
    line: "interface 1/1/5 moved to err-disabled state",
    kind: "signal_fault",
    ruleId: "err-disabled",
  },
  {
    line: "PSU CONTROLLER:            Absent",
    kind: "signal_fault",
    ruleId: "fan-psu",
  },
  {
    line: "lab-6300-a: fan tray 1 fault detected during self-test",
    kind: "signal_fault",
    ruleId: "fan-psu",
  },
  {
    line: "Tunnel status IPSEC: UP IKE: DOWN",
    kind: "signal_fault",
    ruleId: "ipsec-sa-not-up",
  },
  {
    line: "Tunnel status IPSEC: DOWN IKE: UP",
    kind: "signal_fault",
    ruleId: "ipsec-sa-not-up",
  },
];
