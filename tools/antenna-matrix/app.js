/**
 * Antenna Matrix — external-antenna Aruba APs × compatible antennas.
 * Loads data/matrix.json (filtered QuickSpecs snapshot).
 */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const els = {
    search: $("ant-search"),
    viewFilters: $("view-filters"),
    bandFilters: $("band-filters"),
    patternFilters: $("pattern-filters"),
    connFilters: $("conn-filters"),
    envFilters: $("env-filters"),
    list: $("ant-list"),
    empty: $("ant-empty"),
    status: $("ant-status"),
  };

  /** @type {null | object} */
  let data = null;
  let view = "ap";
  let bandFilt = "all";
  let patternFilt = "all";
  let connFilt = "all";
  let envFilt = "all";
  let query = "";

  function escapeHtml(v) {
    return String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function setStatus(msg) {
    els.status.textContent = msg || "";
  }

  function has6(bands) {
    return (bands || []).includes("6");
  }

  function bandLabel(bands) {
    return (bands || []).join(" + ") || "—";
  }

  function patternOf(item) {
    return item.pattern || "omni";
  }

  function bindFilterGroup(root, attr, apply) {
    if (!root) return;
    root.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".filter-btn");
      if (!btn || !root.contains(btn)) return;
      const val = btn.getAttribute(attr);
      if (val == null) return;
      apply(val);
      root.querySelectorAll(".filter-btn").forEach((b) => {
        b.classList.toggle("active", b.getAttribute(attr) === val);
      });
      render();
    });
  }

  function matchesQuery(hay, q) {
    if (!q) return true;
    return hay.toLowerCase().includes(q);
  }

  function envOf(item) {
    const e = item.env || "";
    if (e === "indoor-outdoor") return "outdoor";
    return e;
  }

  function filterAnt(a, applyBand) {
    if (patternFilt !== "all" && patternOf(a) !== patternFilt) return false;
    if (connFilt !== "all" && a.connector !== connFilt) return false;
    if (applyBand) {
      if (bandFilt === "dual" && has6(a.antennaBands || a.bands)) return false;
      if (bandFilt === "six" && !has6(a.antennaBands || a.bands)) return false;
    }
    return true;
  }

  function visibleModels() {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.models.filter((m) => {
      if (bandFilt === "dual" && has6(m.bands)) return false;
      if (bandFilt === "six" && !has6(m.bands)) return false;
      if (connFilt !== "all" && m.connector !== connFilt) return false;
      if (envFilt !== "all" && envOf(m) !== envFilt) return false;
      const ants = (m.antennas || []).filter((a) => filterAnt(a, false));
      if (patternFilt !== "all" && !ants.length) return false;
      const hay = [
        m.model,
        m.family,
        m.wifi,
        m.connector,
        m.env,
        m.portsSummary,
        bandLabel(m.bands),
        ...(m.antennas || []).map((a) => [a.id, a.sku, a.name, a.shortName].join(" ")),
      ].join(" ");
      return matchesQuery(hay, q);
    });
  }

  function visibleAntennas() {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return (data.antennas || []).filter((a) => {
      if (!filterAnt(a, true)) return false;
      if (envFilt !== "all") {
        const e = envOf(a);
        if (envFilt === "indoor" && e !== "indoor") return false;
        if (envFilt === "outdoor" && e === "indoor") return false;
        if (envFilt === "hardened") return false;
      }
      const hay = [
        a.id,
        a.sku,
        a.name,
        a.shortName,
        a.mimo,
        a.connector,
        a.env,
        a.mount,
        a.pattern,
        bandLabel(a.bands),
        ...(a.usedBy || []).map((u) => [u.model, u.family].join(" ")),
      ].join(" ");
      return matchesQuery(hay, q);
    });
  }

  function linkBtn(href, label) {
    if (!href) return "";
    return `<a class="btn btn--secondary" href="${escapeHtml(
      href
    )}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  }

  function rowLinks(a) {
    if (a.findUrl) {
      return `<a href="${escapeHtml(
        a.findUrl
      )}" target="_blank" rel="noopener noreferrer">Find SKU</a>`;
    }
    return escapeHtml(a.sku);
  }

  function antTable(ants) {
    if (!ants.length) return "<p class='hps-notes'>None match the current filters.</p>";
    const groups = [
      ["omni", "Omni"],
      ["directional", "Directional"],
    ];
    let html = "";
    for (const [key, label] of groups) {
      const rows = ants.filter((a) => patternOf(a) === key);
      if (!rows.length) continue;
      html += `<h4 class="ant-subhead">${label}</h4>
        <div class="ant-table-wrap">
        <table class="ant-table">
          <thead>
            <tr>
              <th>Antenna</th>
              <th>SKU</th>
              <th>How many</th>
              <th>Bands</th>
              <th>HPE</th>
            </tr>
          </thead>
          <tbody>`;
      for (const a of rows) {
        html += `<tr>
            <td>
              <strong class="mono">${escapeHtml(a.id)}</strong><br />
              <span class="ant-table__sku">${escapeHtml(
                a.shortName || a.name
              )}</span>
            </td>
            <td class="mono">${escapeHtml(a.sku)}</td>
            <td>${escapeHtml(a.fit || "Need " + a.qtyTotal)}</td>
            <td>${escapeHtml(bandLabel(a.antennaBands))}</td>
            <td>${rowLinks(a)}</td>
          </tr>`;
      }
      html += "</tbody></table></div>";
    }
    return html;
  }

  function renderApCard(m) {
    const ants = (m.antennas || []).filter((a) => filterAnt(a, false));
    const ports = m.portsSummary || "";
    const conf =
      m.confidence && m.confidence !== "high"
        ? `<span class="mac-pill mac-pill--warn">${escapeHtml(
            m.confidence
          )} confidence</span>`
        : "";

    return `
      <details class="mac-card hps-card">
        <summary class="mac-card__summary">
          <span class="mac-card__summary-main">
            <span class="mac-card__addr mono">${escapeHtml(m.model)}</span>
            <span class="mac-card__vendor">
              ${escapeHtml(m.family)} · ${escapeHtml(ports)}
            </span>
          </span>
          <span class="mac-card__summary-meta">
            <span class="hps-fw">${escapeHtml(m.wifi)}</span>
            <span class="hps-fw">${escapeHtml(bandLabel(m.bands))}</span>
            <span class="mac-pill mac-pill--ok">${ants.length} option${
              ants.length === 1 ? "" : "s"
            }</span>
            ${conf}
            <span class="mac-chevron" aria-hidden="true"></span>
          </span>
        </summary>
        <div class="mac-card__body">
          <div class="results-meta">
            <div class="meta-chip"><span>Use</span><strong>${escapeHtml(
              m.env
            )}</strong></div>
            <div class="meta-chip"><span>Connectors</span><strong>${escapeHtml(
              ports
            )}</strong></div>
          </div>
          <div class="hps-actions">
            ${linkBtn(m.quickSpecsUrl, "QuickSpecs")}
          </div>
          <h3 class="hps-tracks-heading">Compatible antennas</h3>
          ${antTable(ants)}
        </div>
      </details>
    `;
  }

  function renderAntennaCard(a) {
    const used = a.usedBy || [];
    const apRows = used
      .map(
        (u) => `
        <tr>
          <td class="mono">${escapeHtml(u.model)}</td>
          <td>${escapeHtml(u.family)}</td>
          <td>${escapeHtml(
            u.fit || (u.qty != null ? "Need " + u.qty : "—")
          )}</td>
        </tr>`
      )
      .join("");

    return `
      <details class="mac-card hps-card">
        <summary class="mac-card__summary">
          <span class="mac-card__summary-main">
            <span class="mac-card__addr mono">${escapeHtml(a.id)}</span>
            <span class="mac-card__vendor">${escapeHtml(
              a.shortName || a.name
            )}</span>
          </span>
          <span class="mac-card__summary-meta">
            <span class="hps-fw">${escapeHtml(a.sku)}</span>
            <span class="hps-fw">${escapeHtml(patternOf(a))}</span>
            <span class="hps-fw">${escapeHtml(bandLabel(a.bands))}</span>
            <span class="mac-pill mac-pill--ok">${used.length} AP${
              used.length === 1 ? "" : "s"
            }</span>
            <span class="mac-chevron" aria-hidden="true"></span>
          </span>
        </summary>
        <div class="mac-card__body">
          <div class="results-meta">
            <div class="meta-chip"><span>SKU</span><strong class="mono">${escapeHtml(
              a.sku
            )}</strong></div>
            <div class="meta-chip"><span>Connector</span><strong>${escapeHtml(
              a.connector
            )}</strong></div>
            <div class="meta-chip"><span>Mount</span><strong>${escapeHtml(
              a.mount
            )}</strong></div>
            <div class="meta-chip"><span>Pattern</span><strong>${escapeHtml(
              patternOf(a)
            )}</strong></div>
          </div>
          <div class="hps-actions">
            ${linkBtn(a.findUrl, "Find " + a.sku)}
          </div>
          <h3 class="hps-tracks-heading">Fits these APs</h3>
          ${
            used.length
              ? `<div class="ant-table-wrap"><table class="ant-table">
                  <thead><tr><th>AP</th><th>Series</th><th>How many</th></tr></thead>
                  <tbody>${apRows}</tbody>
                </table></div>`
              : "<p class='hps-notes'>In the catalog, but not paired to an AP in this snapshot.</p>"
          }
        </div>
      </details>
    `;
  }

  function groupBy(items, keyFn) {
    const map = new Map();
    for (const item of items) {
      const k = keyFn(item);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(item);
    }
    return map;
  }

  function render() {
    if (!data) return;
    let html = "";
    if (view === "ap") {
      const models = visibleModels();
      setStatus(
        `${models.length} AP${models.length === 1 ? "" : "s"} · ${
          data.updated || "—"
        }`
      );
      const groups = groupBy(models, (m) => m.family || "Other");
      for (const [family, rows] of groups) {
        html += `
          <details class="hps-group" open>
            <summary class="hps-group__summary">
              <span class="hps-group__title">${escapeHtml(family)}</span>
              <span class="mac-chevron" aria-hidden="true"></span>
            </summary>
            <div class="hps-group__body">${rows.map(renderApCard).join("")}</div>
          </details>
        `;
      }
      els.empty.classList.toggle("hidden", models.length > 0);
    } else {
      const ants = visibleAntennas();
      setStatus(
        `${ants.length} antenna${ants.length === 1 ? "" : "s"} · ${
          data.updated || "—"
        }`
      );
      const groups = groupBy(ants, (a) =>
        patternOf(a) === "directional" ? "Directional" : "Omni"
      );
      for (const [label, rows] of groups) {
        html += `
          <details class="hps-group" open>
            <summary class="hps-group__summary">
              <span class="hps-group__title">${escapeHtml(label)}</span>
              <span class="hps-group__meta"><span class="hps-group__count">${
                rows.length
              }</span></span>
              <span class="mac-chevron" aria-hidden="true"></span>
            </summary>
            <div class="hps-group__body">${rows
              .map(renderAntennaCard)
              .join("")}</div>
          </details>
        `;
      }
      els.empty.classList.toggle("hidden", ants.length > 0);
    }
    els.list.innerHTML = html;
  }

  bindFilterGroup(els.viewFilters, "data-view", (v) => {
    view = v;
  });
  bindFilterGroup(els.bandFilters, "data-bands", (v) => {
    bandFilt = v;
  });
  bindFilterGroup(els.patternFilters, "data-pattern", (v) => {
    patternFilt = v;
  });
  bindFilterGroup(els.connFilters, "data-conn", (v) => {
    connFilt = v;
  });
  bindFilterGroup(els.envFilters, "data-env", (v) => {
    envFilt = v;
  });

  els.search.addEventListener("input", () => {
    query = els.search.value;
    render();
  });

  fetch("./data/matrix.json")
    .then((r) => {
      if (!r.ok) throw new Error("Could not load matrix.json");
      return r.json();
    })
    .then((json) => {
      data = json;
      render();
    })
    .catch((err) => {
      setStatus(err.message || "Failed to load matrix");
      els.empty.classList.remove("hidden");
      els.empty.textContent = "Could not load data/matrix.json.";
    });
})();
