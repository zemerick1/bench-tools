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
  {
    line: "Mon Aug 10 13:02:54 2026  Central   Failed       Connection error with Aruba Central server device-uswest5.central.arubanetworks.com reason dns error",
    kind: "signal_fault",
    ruleId: "central-conn-fail",
  },
  {
    line: "Last fail reason       :dns error",
    kind: "signal_fault",
    ruleId: "central-conn-fail",
  },
  {
    line: "Mon Aug 10 13:04:01 2026  Activate  Failed       Provisioning failed: did not receive a response from Activate server after 91 seconds",
    kind: "signal_fault",
    ruleId: "activate-provision-fail",
  },
  {
    line: "Aug 10 13:04:01   cli[1001]: <341004> <WARN> |AP Lab-AP-01@10.10.10.50 cli|  awc Activate provision timed out",
    kind: "signal_fault",
    ruleId: "activate-provision-fail",
  },
  {
    line: "Aug 10 13:03:37   cli[1001]: <341004> <WARN> |AP Lab-AP-01@10.10.10.50 cli|  Enable the health IE broadcast due to Central/CoP connectivity issues",
    kind: "signal_fault",
    ruleId: "central-health-ie",
  },
  {
    line: "Aug 10 11:22:32   cli[1001]: <341004> <WARN> |AP Lab-AP-01@10.10.10.50 cli|  AP 10.10.10.50: Client aa:bb:cc:00:11:22 authenticate fail because RADIUS server connection failure",
    kind: "signal_fault",
    ruleId: "radius-conn-fail",
  },
  // zero datapath counters must stay noise (failed-line used to vacuum these up)
  {
    line: "Frames that failed FP spoofing check                                 0",
    kind: "noise_zero_counter",
  },
  {
    line: "Packet dpi session copy to dpimgr failed                             0",
    kind: "noise_zero_counter",
  },
  {
    line: "number of msg prepare failure                    :0",
    kind: "noise_zero_counter",
  },
  {
    line: "Interface  Queue  Alloc  Free  In-use  Max  Failed",
    kind: "noise_table_header",
  },
  {
    line: "Connect establish failed   0(20)",
    kind: "noise_zero_counter",
  },
  {
    line: "Connect establish failed   19(43)",
    kind: "signal_fault",
    ruleId: "central-conn-fail",
  },
  {
    line: 'Aug 10 14:10:00   awc[8454]: [cloud] wsc: LWS_CALLBACK_CLIENT_CONNECTION_ERROR "ipv6 lws_getaddrinfo46 failed"',
    kind: "signal_fault",
    ruleId: "central-conn-fail",
  },
  {
    line: 'Core file has generated, you can use the command "copy core-file tftp/sftp" to get it',
    kind: "signal_fault",
    ruleId: "ap-core-file",
  },
  {
    line: "Aug 10 10:48:48   cli[8457]: <341004> <WARN> |AP|  AP health IE version:0, ip_version:0(IP Version 4), uplink_status:0(Uplink Existed), uplink_type:0(Ethernet), network_status:0(Successful), proxy_status:0(Successful), activate_status:0(Successful), central_status:1(Unable To Resolve A/AAAA), ap_health_ie:0x40000",
    kind: "signal_fault",
    ruleId: "health-ie-status",
  },
  {
    line: "Aug 10 13:03:37   cli[8457]: <341004> <WARN> |AP|  AP health IE version:0, network_status:6(NTP Date & Time Sync Failure), central_status:7(Previous Layer Failure)",
    kind: "signal_fault",
    ruleId: "health-ie-status",
  },
];
