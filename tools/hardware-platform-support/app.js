/**
 * Hardware Platform Support — interactive matrix over static platforms.json
 */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const els = {
    search: $("hps-search"),
    typeFilters: $("type-filters"),
    firmwareFilters: $("firmware-filters"),
    statusFilters: $("status-filters"),
    list: $("hps-list"),
    empty: $("hps-empty"),
    status: $("hps-status"),
    expandAll: $("expand-all"),
    collapseAll: $("collapse-all"),
  };

  /** @type {null | object} */
  let data = null;
  let typeFilt = "all";
  let firmwareFilt = "all";
  let statusFilt = "all";
  let query = "";

  const KIND_LABELS = {
    "aos-10": "AOS-10",
    "aos-8-iap": "AOS-8 Instant",
    "aos-8-controller": "AOS-8 Controller",
    "aos-cx": "AOS-CX",
    "aos-s": "AOS-S",
  };

  function escapeHtml(v) {
    return String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function setStatus(msg, tone) {
    els.status.textContent = msg || "";
    if (tone) els.status.dataset.tone = tone;
    else delete els.status.dataset.tone;
  }

  function releaseLabel(rel) {
    if (!rel) return "—";
    return rel.raw || rel.version || "N/A";
  }

  function tagsHtml(rel) {
    const tags = (rel && rel.tags) || [];
    return tags
      .map((t) => `<span class="hps-tag">${escapeHtml(t)}</span>`)
      .join("");
  }

  function firmwareKind(d) {
    return d.firmwareKind || "aos-10";
  }

  function firmwareLabel(d) {
    return d.firmwareLabel || KIND_LABELS[firmwareKind(d)] || firmwareKind(d);
  }

  function firmwarePillClass(kind) {
    if (kind === "aos-8-iap") return "hps-fw hps-fw--iap";
    if (kind === "aos-8-controller") return "hps-fw hps-fw--ctrl";
    if (kind === "aos-10") return "hps-fw hps-fw--aos10";
    if (kind === "aos-cx" || kind === "aos-s") return "hps-fw hps-fw--switch";
    return "hps-fw";
  }

  function latestAos10() {
    return (data && data.latestRelease) || null;
  }

  function primaryRn(device) {
    const kind = firmwareKind(device);
    if (kind !== "aos-10") {
      return null;
    }
    if (device.status === "parked" && device.lastRnUrl) {
      return {
        url: device.lastRnUrl,
        label: "Release notes (last supported train)",
      };
    }
    const latest = latestAos10();
    if (device.lastRnUrl && latest && device.lastRnUrl === latest.url) {
      return {
        url: device.lastRnUrl,
        label: latest.version
          ? `Latest AOS-10 release notes (${latest.version})`
          : "Latest AOS-10 release notes",
      };
    }
    if (device.lastRnUrl) {
      return {
        url: device.lastRnUrl,
        label: "AOS-10 release notes",
      };
    }
    if (latest && latest.url) {
      return {
        url: latest.url,
        label: latest.version
          ? `Latest AOS-10 release notes (${latest.version})`
          : "Latest AOS-10 release notes",
      };
    }
    const fallback = data && data.allReleasesUrl;
    return fallback
      ? { url: fallback, label: "AOS-10 release notes (all releases)" }
      : null;
  }

  function renderRow(d) {
    const parked = d.status === "parked";
    const statusPill = parked
      ? '<span class="mac-pill mac-pill--warn">parked</span>'
      : '<span class="mac-pill mac-pill--ok">current</span>';
    const kind = firmwareKind(d);
    const fwPill = `<span class="${firmwarePillClass(kind)}">${escapeHtml(
      firmwareLabel(d)
    )}</span>`;

    const primary = primaryRn(d);
    const minLbl = releaseLabel(d.minRelease);
    const lastLbl = releaseLabel(d.lastRelease);

    let actions = "";
    if (primary) {
      actions += `<a class="btn btn--primary" href="${escapeHtml(
        primary.url
      )}" target="_blank" rel="noopener noreferrer">${escapeHtml(
        primary.label
      )}</a>`;
    }
    if (
      d.minRnUrl &&
      kind === "aos-10" &&
      d.minRelease &&
      d.minRelease.version
    ) {
      actions += `<a class="btn btn--secondary" href="${escapeHtml(
        d.minRnUrl
      )}" target="_blank" rel="noopener noreferrer">Notes for first support (${escapeHtml(
        d.minRelease.version
      )})</a>`;
    }
    if (!actions) {
      if (kind === "aos-8-iap" || kind === "aos-8-controller") {
        actions = `<span class="hint">AOS-8 / Instant RN deep-links not wired yet — confirm on HPE support for ${escapeHtml(
          minLbl
        )}.</span>`;
      } else {
        actions = `<span class="hint">No release-notes link for this firmware kind.</span>`;
      }
    }

    const notes = d.notes
      ? `<p class="hps-notes">${escapeHtml(d.notes)}</p>`
      : "";

    return `
      <details class="mac-card hps-card" data-type="${escapeHtml(
        d.type
      )}" data-firmware="${escapeHtml(kind)}" data-status="${escapeHtml(
      d.status
    )}" data-model="${escapeHtml(d.model)}" data-family="${escapeHtml(
      d.family || ""
    )}">
        <summary class="mac-card__summary">
          <span class="mac-card__summary-main">
            <span class="mac-card__addr mono">${escapeHtml(d.model)}</span>
            <span class="mac-card__vendor">
              ${escapeHtml(d.typeLabel)}
              ${d.family ? " · " + escapeHtml(d.family) : ""}
              · first <span class="mono">${escapeHtml(minLbl)}</span>
              · last <span class="mono">${escapeHtml(lastLbl)}</span>
            </span>
          </span>
          <span class="mac-card__summary-meta">
            ${fwPill}
            ${statusPill}
            <span class="mac-chevron" aria-hidden="true"></span>
          </span>
        </summary>
        <div class="mac-card__body">
          <div class="results-meta">
            <div class="meta-chip"><span>Firmware track</span><strong>${escapeHtml(
              firmwareLabel(d)
            )}</strong></div>
            <div class="meta-chip"><span>Type</span><strong>${escapeHtml(
              d.typeLabel
            )}</strong></div>
            <div class="meta-chip"><span>Family</span><strong>${escapeHtml(
              d.family || "—"
            )}</strong></div>
            <div class="meta-chip"><span>First supported</span><strong class="mono">${escapeHtml(
              minLbl
            )}</strong> ${tagsHtml(d.minRelease)}</div>
            <div class="meta-chip"><span>Parked / last supported</span><strong class="mono">${escapeHtml(
              lastLbl
            )}</strong> ${tagsHtml(d.lastRelease)}</div>
          </div>
          ${notes}
          <div class="hps-actions">${actions}</div>
        </div>
      </details>
    `;
  }

  function visibleDevices() {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.devices.filter((d) => {
      if (typeFilt !== "all" && d.type !== typeFilt) return false;
      if (firmwareFilt !== "all" && firmwareKind(d) !== firmwareFilt) return false;
      if (statusFilt !== "all" && d.status !== statusFilt) return false;
      if (!q) return true;
      const hay = [
        d.model,
        d.family,
        d.typeLabel,
        d.notes,
        firmwareLabel(d),
        firmwareKind(d),
        releaseLabel(d.minRelease),
        releaseLabel(d.lastRelease),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }

  function render() {
    const list = visibleDevices();
    els.list.innerHTML = list.map(renderRow).join("");
    els.empty.classList.toggle("hidden", list.length > 0);

    const c = data ? data.counts : {};
    const latest = latestAos10();
    setStatus(
      `Showing ${list.length} of ${c.total || 0} rows` +
        (data && data.updated ? ` · snapshot ${data.updated}` : "") +
        ` · ${c.parked || 0} parked, ${c.current || 0} current` +
        (c["aos-8-iap"]
          ? ` · ${c["aos-8-iap"]} Instant / ${c["aos-8-controller"] || 0} controller AOS-8`
          : "") +
        (latest && latest.version ? ` · latest AOS-10 ${latest.version}` : ""),
      "ok"
    );
  }

  function wireFilters(root, attr, setter) {
    if (!root) return;
    root.querySelectorAll(".filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        root.querySelectorAll(".filter-btn").forEach((b) =>
          b.classList.remove("active")
        );
        btn.classList.add("active");
        setter(btn.getAttribute(attr) || "all");
        render();
      });
    });
  }

  async function init() {
    setStatus("Loading platform data…", "");
    try {
      const res = await fetch("./data/platforms.json");
      if (!res.ok) throw new Error("HTTP " + res.status);
      data = await res.json();
      render();
    } catch (err) {
      console.error(err);
      setStatus(
        "Could not load data/platforms.json. Run update_data.py or check the path.",
        "error"
      );
    }
  }

  els.search.addEventListener("input", () => {
    query = els.search.value;
    render();
  });

  wireFilters(els.typeFilters, "data-type", (v) => {
    typeFilt = v;
  });
  wireFilters(els.firmwareFilters, "data-firmware", (v) => {
    firmwareFilt = v;
  });
  wireFilters(els.statusFilters, "data-status", (v) => {
    statusFilt = v;
  });

  els.expandAll.addEventListener("click", () => {
    els.list.querySelectorAll("details.hps-card").forEach((d) => {
      d.open = true;
    });
  });
  els.collapseAll.addEventListener("click", () => {
    els.list.querySelectorAll("details.hps-card").forEach((d) => {
      d.open = false;
    });
  });

  init();
})();
