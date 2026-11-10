/** Synthetic library used by tests and the "Show an example" button. Not a customer network. */

export function exampleSnapshot() {
  return {
    roles: {
      items: [
        {
          name: "employee",
          description: "Staff",
          "vlan-parameters": { "access-vlan": 30 },
        },
        { name: "guest", description: "Guests", "vlan-parameters": { "access-vlan-name": "guest" } },
        { name: "iot", description: "Sensors" },
      ],
    },
    policies: {
      items: [
        {
          name: "employee",
          type: "POLICY_TYPE_SECURITY",
          association: "ASSOCIATION_ROLE",
          description: "Staff access",
          "security-policy": {
            type: "SECURITY_POLICY_TYPE_DEFAULT",
            "policy-rule": [
              {
                position: 10,
                description: "staff to anywhere",
                condition: {
                  type: "CONDITION_DEFAULT",
                  "rule-type": "RULE_ANY",
                  source: { type: "ADDRESS_ROLE", role: "employee" },
                  destination: { type: "ADDRESS_ANY" },
                },
                action: { type: "ACTION_ALLOW" },
              },
              {
                position: 20,
                description: "one host to one host",
                condition: {
                  "rule-type": "RULE_TCP",
                  source: { type: "ADDRESS_HOST", "host-address": { "host-ipv4-address": "10.1.1.5" } },
                  destination: { type: "ADDRESS_HOST", "host-address": { "host-ipv4-address": "10.2.2.5" } },
                },
                action: { type: "ACTION_ALLOW" },
              },
              {
                position: 30,
                description: "dns",
                condition: {
                  "rule-type": "RULE_NET_SERVICE",
                  source: { type: "ADDRESS_ROLE", role: "employee" },
                  destination: { type: "ADDRESS_ANY" },
                  services: { "net-service": "svc-dns" },
                },
                action: { type: "ACTION_ALLOW" },
              },
            ],
          },
        },
        {
          name: "wide-open",
          type: "POLICY_TYPE_SECURITY",
          association: "ASSOCIATION_INTERFACE",
          "security-policy": {
            "policy-rule": [
              {
                position: 1,
                condition: {
                  "rule-type": "RULE_ANY",
                  source: { type: "ADDRESS_ANY" },
                  destination: { type: "ADDRESS_ANY" },
                },
                action: { type: "ACTION_ALLOW" },
              },
            ],
          },
        },
        {
          name: "canned-dns",
          type: "POLICY_TYPE_SECURITY",
          description: "Building block. Identifies DNS. Not a role.",
          "security-policy": {
            "policy-rule": [
              {
                position: 1,
                description: "identify dns",
                condition: {
                  "rule-type": "RULE_NET_SERVICE",
                  source: { type: "ADDRESS_ANY" },
                  destination: { type: "ADDRESS_ANY" },
                  services: { "net-service": "svc-dns" },
                },
                action: { type: "ACTION_ALLOW" },
              },
            ],
          },
        },
        {
          name: "deny-any",
          type: "POLICY_TYPE_SECURITY",
          association: "ASSOCIATION_ROLE",
          "security-policy": {
            "policy-rule": [
              {
                position: 5,
                condition: {
                  source: { type: "ADDRESS_ROLE", role: "iot" },
                  destination: { type: "ADDRESS_ANY" },
                },
                action: { type: "ACTION_DENY" },
              },
            ],
          },
        },
      ],
    },
    roleAcls: {
      items: [
        {
          name: "guest-acl",
          "acl-type": "ACL_IPV4",
          description: "Guest ACL",
          rules: [
            {
              position: 1,
              action: "PERMIT",
              "src-role": "guest",
              destination: { "address-type": "ADDRESS_ANY" },
              count: true,
            },
            {
              position: 2,
              action: "DENY",
              "src-role": "iot",
              destination: { "address-type": "ADDRESS_HOST", "ipv4-address": "10.9.9.9" },
            },
          ],
        },
      ],
    },
    netServices: {
      items: [
        {
          name: "svc-dns",
          description: "DNS",
          protocol: "IP_UDP",
          ports: [53],
        },
      ],
    },
    clients: {
      items: [
        { role: "employee", macAddress: "aa" },
        { role: "employee", macAddress: "bb" },
        { role: "guest", macAddress: "cc" },
        { role: "", macAddress: "dd" },
        { role: "contractor", macAddress: "ee" },
      ],
      total: 5,
      truncated: false,
    },
  };
}
