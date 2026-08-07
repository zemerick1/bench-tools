/**
 * Tool registry for the landing page.
 * Add an entry here when you introduce a new tool under /tools/<id>/.
 *
 * status: "available" | "soon"
 */
export const tools = [
  {
    id: "csr-generator",
    title: "CSR Generator",
    description:
      "Whip up a CSR and the private key that goes with it—in your browser. CAs get the CSR; you keep the key.",
    href: "./tools/csr-generator/",
    icon: "CSR",
    status: "available",
    cta: "Let’s go",
  },
  {
    id: "central-alerts",
    title: "Central Alerts & Insights",
    description:
      "Searchable catalog of Aruba Central alerts and AI insights—filters, thresholds, and all.",
    href: "./tools/central-alerts/",
    icon: "CA",
    status: "available",
    cta: "Browse catalog",
  },
  {
    id: "cert-assembler",
    title: "Cert Assembler",
    description:
      "Stitch key + cert + CA chain into ordered PEM files or PKCS#12 (PFX/P12). Add or strip a passphrase.",
    href: "./tools/cert-assembler/",
    icon: "PFX",
    status: "available",
    cta: "Assemble",
  },
  {
    id: "mac-lookup",
    title: "MAC / OUI Lookup",
    description:
      "Any MAC format in → vendor, bits, and likely-randomized detection (2/6/A/E rule). Offline.",
    href: "./tools/mac-lookup/",
    icon: "MAC",
    status: "available",
    cta: "Look up",
  },
  {
    id: "hardware-platform-support",
    title: "Hardware Platform Support",
    description:
      "Aruba AOS-10 / Instant tracks plus HPE Juniper EX, QFX, and Mist APs with Pathfinder links.",
    href: "./tools/hardware-platform-support/",
    icon: "HW",
    status: "available",
    cta: "Browse platforms",
  },
  {
    id: "access-tracker",
    title: "Access Tracker Translator",
    description:
      "Access Tracker is a novel. This is the sticky note: accept/reject, who, where, what they got.",
    href: "./tools/access-tracker/",
    icon: "AT",
    status: "available",
    cta: "Translate",
  },
  {
    id: "cli-explorer",
    title: "CLI Explorer",
    description:
      "Aruba/HPE CLI in a tree, not a multi-thousand-page PDF. AOS-CX, AOS 10, more banks offline.",
    href: "./tools/cli-explorer/",
    icon: "CLI",
    status: "available",
    cta: "Browse CLI",
  },
  {
    id: "show-tech",
    title: "Show-Tech Sticky Note",
    description:
      "Paste a show-tech novel. Get facts + lines that already look wrong — not a fake RCA.",
    href: "./tools/show-tech/",
    icon: "ST",
    status: "available",
    cta: "Make sticky note",
  },
  {
    id: "subnet-planner",
    title: "Subnet Planner",
    description:
      "Buildings × roles × device counts → a meshed greenfield IPv4 scheme. Not a calculator in a trench coat.",
    href: "./tools/subnet-planner/",
    icon: "SP",
    status: "available",
    cta: "Plan subnets",
  },
];

/**
 * @param {HTMLElement | null} root
 */
export function renderTools(root) {
  if (!root) return;

  if (!tools.length) {
    root.innerHTML =
      '<div class="tools-empty">No tools registered yet. Edit <code>assets/js/tools.js</code>.</div>';
    return;
  }

  const list = document.createElement("ul");
  list.className = "tools-grid";
  list.setAttribute("role", "list");

  for (const tool of tools) {
    const li = document.createElement("li");
    const available = tool.status === "available";
    const tag = available ? "a" : "div";
    const card = document.createElement(tag);

    card.className = available
      ? "tool-card"
      : "tool-card tool-card--disabled";

    if (available) {
      card.href = tool.href;
    } else {
      card.setAttribute("aria-disabled", "true");
    }

    const badgeClass = available ? "badge badge--available" : "badge badge--soon";
    const badgeLabel = available ? "Available" : "Soon";
    const cta = tool.cta || (available ? "Open tool" : "Coming soon");

    card.innerHTML = `
      <div class="tool-card__top">
        <div class="tool-card__icon" aria-hidden="true">${escapeHtml(tool.icon || "·")}</div>
        <span class="${badgeClass}">${badgeLabel}</span>
      </div>
      <h3>${escapeHtml(tool.title)}</h3>
      <p>${escapeHtml(tool.description)}</p>
      <span class="tool-card__cta">${escapeHtml(cta)}${available ? " →" : ""}</span>
    `;

    li.appendChild(card);
    list.appendChild(li);
  }

  root.replaceChildren(list);
}

/** @param {string} value */
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
