"""Grouping helpers harvested from the CentralMind indexer.

The LLM tool-description output is gone. This module counts operations and
derives tag / theme labels the splitter (or a future grouping overlay) can use.
"""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Any

from oasutil import count_operations, iter_operations

# Order matters: more specific patterns first.
THEME_PATTERNS: dict[str, list[str]] = {
    "Wireless": ["WLAN", "WLANs", "wlan", "radio", "ssid", "mesh", "passpoint", "Wireless"],
    "Monitoring": [
        "alarm",
        "event",
        "insight",
        "telemetry",
        "sysmon",
        "logging",
        "fault-monitor",
        "countermon",
        "traffic-insight",
    ],
    "Security": [
        "firewall",
        "ids",
        "macsec",
        "mka",
        "port-security",
        "mac-lockout",
        "dot1x",
        "auth",
        "captive-portal",
    ],
    "Routing": [
        "bgp",
        "ospf",
        "rip",
        "static-route",
        "route-map",
        "prefix-list",
        "vrf",
        "pim",
        "multicast",
        "bfd",
        "ip-routing",
    ],
    "Switching": [
        "vlan",
        "stp",
        "lacp",
        "lldp",
        "cdp",
        "erps",
        "evpn",
        "vxlan",
        "portchannel",
        "loop-protect",
        "mvrp",
    ],
    "Network Services": [
        "dhcp",
        "dns",
        "ntp",
        "snmp",
        "nae",
        "qos",
        "acl",
        "ddns",
        "udp-broadcast",
    ],
    "Config": ["config", "device-profile", "certificate", "container", "firmware"],
}


# Paths that *obtain* an API session or token — not 802.1X / SSO config / audit.
_API_AUTH_PATH_RE = re.compile(
    r"(?i)(?:^|/)(?:as/token(?:\.|$|/)|oauth(?:$|/)|login(?:$|/)|certificate[_-]?login(?:$|/))"
)


def looks_like_api_auth(path: str) -> bool:
    """True for login / OAuth / token endpoints used to call the API."""
    return bool(_API_AUTH_PATH_RE.search(path or ""))


def operation_tags(operation: dict[str, Any]) -> list[str]:
    tags = operation.get("tags") or []
    return [tag for tag in tags if isinstance(tag, str) and tag.strip()]


def tag_counts(spec: dict[str, Any]) -> dict[str, int]:
    counts: dict[str, int] = defaultdict(int)
    for _path, _method, operation, _item in iter_operations(spec):
        tags = operation_tags(operation)
        if not tags:
            counts[""] += 1
            continue
        counts[tags[0]] += 1
    return dict(counts)


def tag_prefix(tag: str) -> str:
    """``Orgs Devices`` → ``Orgs``."""
    tag = (tag or "").strip()
    if " " in tag:
        return tag.split()[0]
    return tag


def group_into_themes(categories: dict[str, int]) -> dict[str, dict[str, int]]:
    """Bucket category names into coarse themes. Unused by Phase 1 split."""
    themes: dict[str, dict[str, int]] = defaultdict(dict)

    def matches(category: str, patterns: list[str]) -> bool:
        lowered = category.lower()
        for pattern in patterns:
            if re.search(rf"\b{re.escape(pattern.lower())}\b", lowered):
                return True
            if pattern == "Stats -" and lowered.startswith("stats -"):
                return True
        return False

    for name, count in categories.items():
        assigned = False
        for theme, patterns in THEME_PATTERNS.items():
            if matches(name, patterns):
                themes[theme][name] = count
                assigned = True
                break
        if not assigned:
            themes["Other"][name] = count
    return {key: value for key, value in themes.items() if value}


__all__ = [
    "THEME_PATTERNS",
    "count_operations",
    "group_into_themes",
    "operation_tags",
    "tag_counts",
    "tag_prefix",
]
