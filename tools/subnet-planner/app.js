/**
 * Subnet Planner UI — greenfield scheme designer.
 */

import { buildPlan, suggestPrefix, sizedFor, usableHosts, rowsToCsv } from "./planner.js";

/** @typedef {{ id: string, name: string, index: string }} BuildingRow */
/** @typedef {{ id: string, name: string, devices: string, vlanId: string, prefixOverride: string }} RoleRow */

const $ = (sel, root = document) => root.querySelector(sel);

function uid() {
  return `r${Math.random().toString(36).slice(2, 9)}`;
}

/** @type {BuildingRow[]} */
let buildings = [
  { id: uid(), name: "HQ", index: "1" },
  { id: uid(), name: "Building 2", index: "2" },
];

/** @type {RoleRow[]} */
let roles = [
  { id: uid(), name: "Infrastructure (switches & APs)", devices: "", vlanId: "", prefixOverride: "" },
  { id: uid(), name: "Students", devices: "", vlanId: "", prefixOverride: "" },
  { id: uid(), name: "Staff", devices: "", vlanId: "", prefixOverride: "" },
  { id: uid(), name: "IoT", devices: "", vlanId: "", prefixOverride: "" },
  { id: uid(), name: "Admin", devices: "", vlanId: "", prefixOverride: "" },
];

/** @type {import('./planner.js').PlanResult | null} */
let lastPlan = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function readGlobals() {
  const connectionModel =
    /** @type {HTMLInputElement|null} */ ($('input[name="sp-connect"]:checked'))?.value === "isolated"
      ? "isolated"
      : "connected";
  const privateSpace =
    /** @type {HTMLSelectElement|null} */ ($("#sp-space"))?.value || "10.0.0.0/8";
  const rawPos = /** @type {HTMLInputElement|null} */ ($('input[name="sp-site-pos"]:checked'))
    ?.value;
  const sitePosition =
    rawPos === "third" || rawPos === "after-vlan"
      ? "third"
      : "second"; // default + before-vlan / second
  return {
    connectionModel: /** @type {'connected'|'isolated'} */ (connectionModel),
    privateSpace: /** @type {'10.0.0.0/8'|'172.16.0.0/12'|'192.168.0.0/16'} */ (privateSpace),
    sitePosition: /** @type {'second'|'third'} */ (sitePosition),
  };
}

/**
 * Fill blank site numbers in list order: 1, 2, 3… skipping any numbers
 * the user already set. Mutates `buildings`.
 */
function assignMissingSiteNumbers() {
  const used = new Set();
  for (const b of buildings) {
    const n = Number(b.index);
    if (b.index !== "" && Number.isInteger(n) && n >= 1 && n <= 254) used.add(n);
  }
  let next = 1;
  for (const b of buildings) {
    const n = Number(b.index);
    if (b.index !== "" && Number.isInteger(n) && n >= 1 && n <= 254) continue;
    while (used.has(next)) next++;
    b.index = String(next);
    used.add(next);
    next++;
  }
}

/** @param {string} raw */
function devicesHintHtml(raw) {
  const dev = Number(raw);
  if (!Number.isInteger(dev) || dev < 1) return "";
  const sug = suggestPrefix(dev);
  const need = sizedFor(dev);
  if (sug == null) return "";
  return `~${need} with 50% headroom → suggest <strong>/${sug}</strong> (${usableHosts(sug)} usable)`;
}

function renderBuildings() {
  assignMissingSiteNumbers();
  const host = $("#sp-buildings-body");
  if (!host) return;
  host.innerHTML = buildings
    .map(
      (b, i) => `
    <tr data-id="${escapeHtml(b.id)}">
      <td>
        <input class="sp-input" data-field="name" type="text" value="${escapeHtml(b.name)}"
          placeholder="Building name" aria-label="Building ${i + 1} name" required />
      </td>
      <td>
        <input class="sp-input sp-input--narrow" data-field="index" type="number" min="1" max="254"
          value="${escapeHtml(b.index)}" placeholder="1" aria-label="Building ${i + 1} site number" />
      </td>
      <td class="sp-row-actions">
        <button type="button" class="btn btn--ghost sp-remove" data-kind="building" ${buildings.length <= 1 ? "disabled" : ""}>Remove</button>
      </td>
    </tr>`
    )
    .join("");
}

function renderRoles() {
  const host = $("#sp-roles-body");
  if (!host) return;
  host.innerHTML = roles
    .map((r, i) => {
      const hint = devicesHintHtml(r.devices);
      return `
    <tr data-id="${escapeHtml(r.id)}">
      <td>
        <input class="sp-input" data-field="name" type="text" value="${escapeHtml(r.name)}"
          placeholder="e.g. Students" aria-label="Role ${i + 1} name" required />
      </td>
      <td>
        <input class="sp-input sp-input--narrow" data-field="devices" type="text" inputmode="numeric"
          pattern="[0-9]*" autocomplete="off" value="${escapeHtml(r.devices)}"
          placeholder="e.g. 2000" aria-label="Role ${i + 1} devices per building" required />
        <div class="sp-hint" data-hint="devices">${hint}</div>
      </td>
      <td>
        <input class="sp-input sp-input--narrow" data-field="vlanId" type="text" inputmode="numeric"
          pattern="[0-9]*" autocomplete="off" value="${escapeHtml(r.vlanId)}"
          placeholder="auto" aria-label="Role ${i + 1} VLAN" />
      </td>
      <td>
        <input class="sp-input sp-input--narrow" data-field="prefixOverride" type="text" inputmode="numeric"
          pattern="[0-9]*" autocomplete="off" value="${escapeHtml(r.prefixOverride)}"
          placeholder="auto" aria-label="Role ${i + 1} prefix override" />
        <div class="sp-hint">Optional. Larger only (/8–/25), e.g. 24 or 20</div>
      </td>
      <td class="sp-row-actions">
        <button type="button" class="btn btn--ghost sp-remove" data-kind="role" ${roles.length <= 1 ? "disabled" : ""}>Remove</button>
      </td>
    </tr>`;
    })
    .join("");
}

function syncFromDom() {
  const bBody = $("#sp-buildings-body");
  if (bBody) {
    buildings = [...bBody.querySelectorAll("tr")].map((tr) => {
      const id = tr.getAttribute("data-id") || uid();
      return {
        id,
        name: /** @type {HTMLInputElement} */ (tr.querySelector('[data-field="name"]'))?.value ?? "",
        index: /** @type {HTMLInputElement} */ (tr.querySelector('[data-field="index"]'))?.value ?? "",
      };
    });
  }
  const rBody = $("#sp-roles-body");
  if (rBody) {
    roles = [...rBody.querySelectorAll("tr")].map((tr) => {
      const id = tr.getAttribute("data-id") || uid();
      return {
        id,
        name: /** @type {HTMLInputElement} */ (tr.querySelector('[data-field="name"]'))?.value ?? "",
        devices: /** @type {HTMLInputElement} */ (tr.querySelector('[data-field="devices"]'))?.value ?? "",
        vlanId: /** @type {HTMLInputElement} */ (tr.querySelector('[data-field="vlanId"]'))?.value ?? "",
        prefixOverride:
          /** @type {HTMLInputElement} */ (tr.querySelector('[data-field="prefixOverride"]'))?.value ?? "",
      };
    });
  }
}

function collectInput() {
  syncFromDom();
  assignMissingSiteNumbers();
  // Reflect assigned site #s back into the form so the user sees 1, 2, 3…
  const bBody = $("#sp-buildings-body");
  if (bBody) {
    for (const b of buildings) {
      const input = bBody.querySelector(`tr[data-id="${b.id}"] [data-field="index"]`);
      if (input instanceof HTMLInputElement && input.value !== b.index) {
        input.value = b.index;
      }
    }
  }
  const g = readGlobals();
  return {
    ...g,
    buildings: buildings.map((b) => ({
      name: b.name.trim(),
      index: b.index === "" ? null : Number(b.index),
    })),
    roles: roles.map((r) => ({
      name: r.name.trim(),
      devicesPerBuilding: r.devices === "" ? NaN : Number(String(r.devices).replace(/[^\d]/g, "")),
      vlanId: r.vlanId === "" ? null : Number(String(r.vlanId).replace(/[^\d]/g, "")),
      prefixOverride:
        r.prefixOverride === "" ? null : Number(String(r.prefixOverride).replace(/[^\d]/g, "")),
    })),
  };
}

function showErrors(errors) {
  const el = $("#sp-errors");
  if (!el) return;
  if (!errors.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = `<strong>Hold up.</strong><ul>${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>`;
}

function showWarnings(warnings) {
  const el = $("#sp-warnings");
  if (!el) return;
  if (!warnings.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = `<strong>Callouts (worth reading before you lock this in).</strong><ul>${warnings
    .map((w) => `<li>${escapeHtml(w)}</li>`)
    .join("")}</ul>`;
}

/**
 * After a successful plan, write resolved VLAN IDs into the form so the fields
 * match what was actually used (auto-assign is no longer invisible).
 */
function writeResolvedVlansToForm(plan) {
  if (!plan?.ok || !plan.rows?.length) return;
  /** @type {Map<string, number>} */
  const vlanByRole = new Map();
  for (const row of plan.rows) {
    if (!vlanByRole.has(row.role)) vlanByRole.set(row.role, row.vlanId);
  }
  syncFromDom();
  for (const role of roles) {
    const v = vlanByRole.get(role.name.trim());
    if (v == null) continue;
    role.vlanId = String(v);
    const input = document.querySelector(
      `#sp-roles-body tr[data-id="${role.id}"] [data-field="vlanId"]`
    );
    if (input instanceof HTMLInputElement) input.value = role.vlanId;
  }
}

function renderPlan(plan) {
  const empty = $("#sp-empty");
  const out = $("#sp-output");

  if (!plan || !plan.ok) {
    // Keep prior plan visible if we already had one; only show empty on first failure.
    if (!lastPlan?.ok) {
      if (empty) empty.hidden = false;
      if (out) out.hidden = true;
    }
    return;
  }

  if (empty) empty.hidden = true;
  if (!out) return;
  out.hidden = false;

  const cap = plan.meta?.capacity;
  const capHtml = cap
    ? `<div class="callout callout--soft sp-capacity" role="note">
          <strong>Room to grow</strong>
          <ul>
            <li>${escapeHtml(cap.noteRoles)}</li>
            <li>${escapeHtml(cap.noteSites)}</li>
            <li>${escapeHtml(cap.noteWithinRole)}</li>
          </ul>
          <p class="sp-muted" style="margin:0.5rem 0 0">
            VLANs in use: ${(cap.usedVlans || []).join(", ") || "—"}.
            Next auto VLAN: ${cap.nextAutoVlan ?? "none"}.
            Free second-octet IDs (2–254): ${cap.freeSecondOctets}.
            Site numbers fitting in parents: 1–${cap.maxSiteThatFits}
            (plan uses up to ${cap.maxSiteInPlan}).
          </p>
        </div>`
    : "";

  // Rebuild table + sticky together so the sticky cannot stay stale across rebuilds.
  out.innerHTML = `
      <div id="sp-table-wrap">
      ${capHtml}
      <div class="sp-table-scroll">
        <table class="sp-table">
          <thead>
            <tr>
              <th>Building</th>
              <th>Role</th>
              <th>VLAN</th>
              <th>Said</th>
              <th>Sized (+50%)</th>
              <th>Subnet</th>
              <th>Gateway</th>
              <th>Usable</th>
              <th>Reserved lane</th>
              <th>Reservation ends</th>
            </tr>
          </thead>
          <tbody>
            ${[...plan.rows]
              .sort((a, b) => a.buildingIndex - b.buildingIndex || a.vlanId - b.vlanId)
              .map(
                (r) => `
              <tr>
                <td>${escapeHtml(r.building)} <span class="sp-muted">site ${r.buildingIndex}</span></td>
                <td>${escapeHtml(r.role)}</td>
                <td><code>${r.vlanId}</code></td>
                <td>${r.devicesSaid}</td>
                <td>${r.sizedFor}</td>
                <td><code>${escapeHtml(r.subnet)}</code></td>
                <td><code>${escapeHtml(r.gateway)}</code></td>
                <td>${r.usable}</td>
                <td><code>${escapeHtml(r.reservedLane)}</code></td>
                <td><code>${escapeHtml(r.reservedEnd)}</code>
                  <div class="sp-muted">${escapeHtml(r.reservedRange)}</div>
                </td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </div>
      <details class="sp-details">
        <summary>Why these sizes?</summary>
        <ul class="sp-why">
          ${plan.rows
            .map(
              (r) =>
                `<li><strong>${escapeHtml(r.building)} / ${escapeHtml(r.role)}</strong> — ${escapeHtml(r.sizeNote)}. ${r.notices.map(escapeHtml).join(" ")}</li>`
            )
            .join("")}
        </ul>
      </details>
      </div>
      <div class="form-actions" id="sp-export-actions">
        <button type="button" class="btn btn--primary" id="sp-copy-sticky">Copy sticky note</button>
        <button type="button" class="btn btn--secondary" id="sp-download-csv">Download CSV</button>
      </div>
      <h3 class="sp-sticky-title">Sticky note</h3>
      <pre class="sp-sticky" id="sp-sticky"></pre>
    `;

  const sticky = $("#sp-sticky");
  if (sticky) sticky.textContent = plan.sticky;

  $("#sp-copy-sticky")?.addEventListener("click", (e) => {
    e.preventDefault();
    copySticky();
  });
  $("#sp-download-csv")?.addEventListener("click", (e) => {
    e.preventDefault();
    downloadCsv();
  });
}

function generate() {
  const input = collectInput();
  const plan = buildPlan(input);
  showErrors(plan.errors);
  showWarnings(plan.warnings || []);

  if (plan.ok) {
    lastPlan = plan;
    writeResolvedVlansToForm(plan);
    renderPlan(plan);
  } else {
    // Leave the last good table/sticky on screen; errors are above.
    if (!lastPlan?.ok) renderPlan(null);
  }
}

function copySticky() {
  if (!lastPlan?.ok || !lastPlan.sticky) return;
  navigator.clipboard?.writeText(lastPlan.sticky).then(
    () => flashBtn("#sp-copy-sticky", "Copied"),
    () => flashBtn("#sp-copy-sticky", "Clipboard blocked")
  );
}

function downloadCsv() {
  if (!lastPlan?.ok) return;
  const csv = rowsToCsv(lastPlan.rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "subnet-plan.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

/** @param {string} sel @param {string} label */
function flashBtn(sel, label) {
  const btn = $(sel);
  if (!btn) return;
  const prev = btn.textContent;
  btn.textContent = label;
  setTimeout(() => {
    btn.textContent = prev;
  }, 1600);
}

function onBuildingsClick(e) {
  const t = /** @type {HTMLElement} */ (e.target);
  if (t.classList.contains("sp-remove") && t.getAttribute("data-kind") === "building") {
    syncFromDom();
    const tr = t.closest("tr");
    const id = tr?.getAttribute("data-id");
    if (id && buildings.length > 1) {
      buildings = buildings.filter((b) => b.id !== id);
      renderBuildings();
    }
  }
}

function onRolesClick(e) {
  const t = /** @type {HTMLElement} */ (e.target);
  if (t.classList.contains("sp-remove") && t.getAttribute("data-kind") === "role") {
    syncFromDom();
    const tr = t.closest("tr");
    const id = tr?.getAttribute("data-id");
    if (id && roles.length > 1) {
      roles = roles.filter((r) => r.id !== id);
      renderRoles();
    }
  }
}

/**
 * Update the size hint under Devices without re-rendering the row.
 * Full re-render was resetting the caret to the start (2000 → 0002).
 */
function onRolesInput(e) {
  const t = /** @type {HTMLElement} */ (e.target);
  if (!(t instanceof HTMLInputElement)) return;
  if (t.getAttribute("data-field") !== "devices") return;
  // Keep digits only while typing (no cursor jump from DOM rebuild)
  const digits = t.value.replace(/[^\d]/g, "");
  if (t.value !== digits) {
    const pos = t.selectionStart ?? digits.length;
    const removed = t.value.length - digits.length;
    t.value = digits;
    const next = Math.max(0, pos - removed);
    t.setSelectionRange(next, next);
  }
  const hint = t.closest("td")?.querySelector('[data-hint="devices"]');
  if (hint) hint.innerHTML = devicesHintHtml(t.value);
}

function starterVlan1() {
  syncFromDom();
  // Keep infra; seed classic “I only had VLAN 1” cast
  roles = [
    {
      id: uid(),
      name: "Infrastructure (switches & APs)",
      devices: roles.find((r) => /infra/i.test(r.name))?.devices || "",
      vlanId: "",
      prefixOverride: "",
    },
    { id: uid(), name: "Users", devices: "", vlanId: "", prefixOverride: "" },
    { id: uid(), name: "IoT", devices: "", vlanId: "", prefixOverride: "" },
    { id: uid(), name: "Guest", devices: "", vlanId: "", prefixOverride: "" },
  ];
  renderRoles();
  showErrors([]);
  const note = $("#sp-starter-note");
  if (note) {
    note.hidden = false;
    note.innerHTML =
      "<strong>VLAN 1 retirement plan loaded.</strong> Infrastructure is already on the list (fill in how many switches/APs per building). Add device counts. We will not put the cafeteria printer on the same VLAN as your core.";
  }
}

function init() {
  renderBuildings();
  renderRoles();

  $("#sp-add-building")?.addEventListener("click", () => {
    syncFromDom();
    buildings.push({ id: uid(), name: "", index: "" });
    assignMissingSiteNumbers();
    renderBuildings();
  });

  $("#sp-add-role")?.addEventListener("click", () => {
    syncFromDom();
    roles.push({ id: uid(), name: "", devices: "", vlanId: "", prefixOverride: "" });
    renderRoles();
  });

  $("#sp-buildings-body")?.addEventListener("click", onBuildingsClick);
  $("#sp-roles-body")?.addEventListener("click", onRolesClick);
  $("#sp-roles-body")?.addEventListener("input", onRolesInput);

  $("#sp-generate")?.addEventListener("click", (e) => {
    e.preventDefault();
    generate();
  });

  $("#sp-starter-vlan1")?.addEventListener("click", (e) => {
    e.preventDefault();
    starterVlan1();
  });

  // Copy / CSV buttons are bound when the plan output is rendered (see renderPlan).
}

init();
